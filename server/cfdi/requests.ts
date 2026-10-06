/**
 * Creating a nominative invoice request (spec §4.7.1 requestInvoice steps 5-8, §4.7.2 portal):
 * shared by staff (POST /cfdi/invoices) and the self-invoicing portal, so both go through the
 * same once() key space, per-ticket advisory key and unique active claim (DB test 3). Web only.
 *
 * Lock order (docs/ARCHITECTURE.md row 29): once() (LO-1) → restaurants FOR SHARE (LO-2) → the
 * per-ticket key, then the covering global's per-document key (LO-3, ticket keys before document
 * keys: the reissue-race fix of cfdi-rebase §2 item 18) → cfdi_* inserts (LO-R8). Never orders,
 * the drawer or the folio counter.
 */
import { randomUUID } from "node:crypto";
import { DomainError } from "../../shared/domain.js";
import {
  needsCardForm,
  type CardForm,
  type Receptor,
} from "../../shared/cfdi.js";
import type { Tx } from "../db.js";
import {
  enqueueStamp,
  cfdiEnqueue,
  dedupe,
  INVOICE_MAX_ATTEMPTS,
} from "./jobs.js";
import { lockDocument, lockTicket } from "./locks.js";
import {
  cfdiState,
  fiscalFacts,
  hasCreditNotes,
  insertEvent,
  modeFrom,
  requireCfdi,
  ticketDeadline,
  ticketFacts,
} from "./store.js";

export type InvoiceRequest = {
  tenantId: string;
  /** The staff member; null from the portal (no audit row, events without actor). */
  actorId: string | null;
  source: "staff" | "portal";
  ticketId: string;
  receptor: Receptor;
  cardForm: CardForm | null;
  confirmPreStart: boolean;
  /** Manager (staff) or the owner's portal setting: cancel the covering global with motive 04. */
  reissueGlobal: boolean;
};

export { lockDocument, lockTicket };

/**
 * Validates eligibility and inserts the document, its claim and its jobs. Returns only ids (spec
 * cfdi-rebase §2 item 12: once() stores the result in operations, which retention never deletes,
 * so no receptor data goes there).
 */
export async function createInvoiceRequest(
  tx: Tx,
  r: InvoiceRequest,
): Promise<{ documentId: string; waiting: boolean; ticketId: string }> {
  const state = await cfdiState(tx);
  requireCfdi(state, { needEnabled: true, needReady: true });
  const settings = state.settings;
  const portal = r.source === "portal";
  if (portal && !settings.selfInvoiceEnabled)
    throw new DomainError("cfdi_portal_unavailable", 409);
  await lockTicket(tx, r.tenantId, r.ticketId);
  const t = await ticketFacts(tx, r.ticketId, settings.mode);
  const invoice = t.coverage.find((c) => c.kind === "invoice");
  if (invoice)
    throw new DomainError(
      t.coverage.some((c) => c.kind === "invoice" && c.status === "valid")
        ? "cfdi_ticket_already_invoiced"
        : "cfdi_ticket_invoicing",
      409,
    );
  const global = t.coverage.find(
    (c) => c.kind === "global" && c.state === "active",
  );
  if (global && !["valid", "canceling"].includes(global.status))
    throw new DomainError("cfdi_global_in_progress", 409);
  if (global && !r.reissueGlobal)
    throw new DomainError("cfdi_ticket_in_global", 409);
  if (t.net <= 0) throw new DomainError("cfdi_ticket_fully_refunded", 409);
  if (t.payload.ticket.businessDate < modeFrom(settings)) {
    if (portal) throw new DomainError("cfdi_portal_unavailable", 409);
    if (!r.confirmPreStart)
      throw new DomainError("cfdi_ticket_before_start", 409);
  }
  if (portal) {
    const facts = await fiscalFacts(tx);
    const deadline = ticketDeadline(t, settings, facts.timezone);
    if (deadline && Date.parse(deadline) < Date.now())
      throw new DomainError("cfdi_portal_expired", 409);
    const [{ recent }] = await tx`
      select count(*)::int as recent from cfdi_document_tickets c
      join cfdi_documents d on d.tenant_id = c.tenant_id and d.id = c.document_id
      where c.ticket_id = ${r.ticketId} and d.source = 'portal'
        and d.created_at > now() - interval '24 hours'`;
    if (recent >= 5)
      throw new DomainError("cfdi_portal_too_many_attempts", 429);
  }
  if (needsCardForm(t.payload.payments) && !r.cardForm)
    throw new DomainError("cfdi_card_form_required", 400);

  const documentId = randomUUID();
  const base = {
    receptor: tx.json(r.receptor as never),
    receptorRfc: r.receptor.rfc,
    card: r.cardForm,
    createdBy: portal ? null : r.actorId,
  };
  if (!global) {
    await tx`
      insert into cfdi_documents(tenant_id, id, kind, source, mode, status, receptor, receptor_rfc,
        card_payment_form, confirm_pre_start, created_by)
      values (${r.tenantId}, ${documentId}, 'invoice', ${r.source}, ${settings.mode}, 'queued',
        ${base.receptor}, ${base.receptorRfc}, ${base.card}, ${r.confirmPreStart}, ${base.createdBy})`;
    const won = await tx`
      insert into cfdi_document_tickets(tenant_id, document_id, ticket_id, mode, state)
      values (${r.tenantId}, ${documentId}, ${r.ticketId}, ${settings.mode}, 'active')
      on conflict (tenant_id, ticket_id, mode) where state = 'active' do nothing
      returning ticket_id`;
    // A concurrent global won the ticket: the throw rolls the document back.
    if (!won.length) throw new DomainError("cfdi_ticket_in_global", 409);
    await insertEvent(
      tx,
      r.tenantId,
      documentId,
      "requested",
      { source: r.source },
      r.actorId,
    );
    await enqueueStamp(tx, r.tenantId, documentId, {
      maxAttempts: INVOICE_MAX_ATTEMPTS,
    });
    return { documentId, waiting: false, ticketId: r.ticketId };
  }

  // Invoice after a global (SAT FAQ Q10): cancel G with 04, reissue it without the ticket, then
  // stamp this invoice. Later requests against the same global join the same cancellation.
  // cfdi_reissue completes the cancellation (G canceled, claims released, waiters collected, G'
  // created) under this same document key, so everything read before the key is read again here:
  // a request that loses the race answers cfdi_global_in_progress and the retry lands on G'
  // (review CFDI-R1). A motive-04 cancellation is only ever inserted for a valid global.
  await lockDocument(tx, r.tenantId, global.documentId);
  const [current] = await tx`
    select d.status,
      exists (select 1 from cfdi_document_tickets c where c.document_id = d.id
        and c.ticket_id = ${r.ticketId} and c.state = 'active') as holds_ticket
    from cfdi_documents d where d.id = ${global.documentId}`;
  if (
    !current?.holds_ticket ||
    !["valid", "canceling"].includes(current.status as string)
  )
    throw new DomainError("cfdi_global_in_progress", 409);
  const [open] = await tx`
    select id, motive from cfdi_cancellations
    where document_id = ${global.documentId} and status in ('queued','requested')`;
  if (open && open.motive !== "04")
    throw new DomainError("cfdi_global_in_progress", 409);
  if (!open && current.status !== "valid")
    throw new DomainError("cfdi_global_in_progress", 409);
  // SAT refuses to cancel a global that a valid credit note relates to; cfdi_refund creates one
  // only under this same key with no cancellation open (CFDI-R3-2). The portal tells the
  // customer to ask the restaurant, as it does for a global it may not replace.
  if (!open && (await hasCreditNotes(tx, global.documentId)))
    throw new DomainError(
      portal ? "cfdi_ticket_in_global" : "cfdi_global_has_credit_notes",
      409,
    );
  const cancellationId: string = open?.id ?? randomUUID();
  if (!open)
    await tx`
      insert into cfdi_cancellations(tenant_id, id, document_id, motive, source, reason, requested_by)
      values (${r.tenantId}, ${cancellationId}, ${global.documentId}, '04', 'reissue',
        ${"Factura nominativa de ticket " + t.payload.ticket.folio}, ${r.actorId})`;
  await tx`
    insert into cfdi_documents(tenant_id, id, kind, source, mode, status, depends_on, receptor, receptor_rfc,
      card_payment_form, confirm_pre_start, created_by)
    values (${r.tenantId}, ${documentId}, 'invoice', ${r.source}, ${settings.mode}, 'waiting', ${global.documentId},
      ${base.receptor}, ${base.receptorRfc}, ${base.card}, ${r.confirmPreStart}, ${base.createdBy})`;
  await tx`
    insert into cfdi_document_tickets(tenant_id, document_id, ticket_id, mode, state)
    values (${r.tenantId}, ${documentId}, ${r.ticketId}, ${settings.mode}, 'pending')`;
  await insertEvent(
    tx,
    r.tenantId,
    documentId,
    "requested",
    { source: r.source, reissue: global.documentId },
    r.actorId,
  );
  await cfdiEnqueue(tx, r.tenantId, {
    kind: "cfdi_reissue",
    dedupeKey: dedupe.reissue(global.documentId, cancellationId),
    payload: { globalDocumentId: global.documentId },
  });
  return { documentId, waiting: true, ticketId: r.ticketId };
}
