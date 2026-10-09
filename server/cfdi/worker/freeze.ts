/**
 * cfdi_stamp step 2 (spec §4.8.3): the request of a document is built once, from fiscal's
 * figures, and frozen on the row with its expected amounts. Pure builders do the work
 * (server/cfdi/build.ts); this module loads their inputs inside the stamping transaction.
 * A builder DomainError is a permanent build-time failure (cfdi-rebase S5).
 */
import type { Tx } from "../../db.js";
import { DomainError } from "../../../shared/domain.js";
import { formatFolio, type TaxCategory } from "../../../shared/fiscal.js";
import { paymentFormFor } from "../../../shared/cfdi.js";
import {
  buildEgresoRequest,
  buildGlobalRequests,
  buildInvoiceRequest,
  netGroups,
  type EgresoBuildInput,
  type GlobalInfo,
} from "../build.js";
import type { FInvoiceInput } from "../facturapi-schema.js";
import { ticketForCfdi } from "../../fiscal-read.js";
import {
  loadDocument,
  releaseClaims,
  type DocumentRow,
  type FiscalFacts,
  type SettingsRow,
} from "../store.js";
import { loadTickets, type ExcludedTicket } from "./tickets.js";

export type Frozen = {
  body: FInvoiceInput;
  expectedTotal: number;
  expectedTax: number;
  expectedWithholding: number;
  conceptCount: number;
  ticketCount: number;
  nettedRefundIds: string[];
  /** Extra detail for the `frozen` event (never personal data). */
  detail: Record<string, unknown>;
  excluded: ExcludedTicket[];
};

const nothing = () => new DomainError("cfdi_nothing_to_invoice", 409);

async function claimedTickets(tx: Tx, documentId: string): Promise<string[]> {
  const rows = await tx`
    select ticket_id from cfdi_document_tickets
    where document_id = ${documentId} and state <> 'released' order by ticket_id`;
  return rows.map((r) => r.ticket_id as string);
}

async function freezeInvoice(
  tx: Tx,
  doc: DocumentRow,
  settings: SettingsRow,
  facts: FiscalFacts,
): Promise<Frozen> {
  const [ticketId] = await claimedTickets(tx, doc.id);
  if (!ticketId || !doc.receptor) throw nothing();
  const payload = await ticketForCfdi(tx, ticketId);
  if (!facts.postalCode)
    throw new DomainError("cfdi_fiscal_profile_incomplete", 409);
  let replacesUuid: string | null = null;
  if (doc.replacesDocumentId) {
    const replaced = await loadDocument(tx, doc.replacesDocumentId);
    replacesUuid = replaced?.uuid ?? null;
    if (!replacesUuid) throw new DomainError("cfdi_substitute_invalid", 409);
  }
  const built = buildInvoiceRequest({
    docId: doc.id,
    payload,
    receptor: doc.receptor,
    settings: {
      conceptMode: settings.conceptMode,
      conceptDescription: settings.conceptDescription,
    },
    issuerPostalCode: facts.postalCode,
    cardForm: doc.cardPaymentForm ?? settings.cardPaymentForm,
    platformForm: settings.platformPaymentForm,
    timezone: facts.timezone,
    nettedRefunds: payload.refunds,
    replacesUuid,
    issuer: { regime: facts.regime, rfc: facts.rfc },
  });
  return {
    body: built.body,
    expectedTotal: built.expectedTotal,
    expectedTax: built.expectedTax,
    expectedWithholding: built.expectedWithholding,
    conceptCount: built.conceptCount,
    ticketCount: 1,
    nettedRefundIds: built.nettedRefundIds,
    detail: {
      conceptMode: built.conceptMode,
      itemizedFallback: built.itemizedFallback,
      withholding: built.expectedWithholding > 0,
    },
    excluded: [],
  };
}

async function freezeGlobal(
  tx: Tx,
  doc: DocumentRow,
  settings: SettingsRow,
  facts: FiscalFacts,
): Promise<Frozen> {
  if (!doc.globalInfo || !facts.postalCode) throw nothing();
  const ids = await claimedTickets(tx, doc.id);
  const { tickets, excluded } = await loadTickets(tx, ids);
  // Tickets that net to zero since the build (refunded meanwhile) or that fiscal's figures refuse
  // leave the part; their claims are released so a later part or invoice can take them.
  const kept = tickets.filter((t) => t.groups.length > 0);
  const dropped = ids.filter((id) => !kept.some((t) => t.id === id));
  if (dropped.length) await releaseClaims(tx, doc.id, "not_included", dropped);
  if (!kept.length) throw nothing();
  const info: GlobalInfo = {
    periodicity: doc.globalInfo.periodicity,
    months: doc.globalInfo.months,
    year: doc.globalInfo.year,
  };
  const parts = buildGlobalRequests({
    docIds: () => doc.id,
    tickets: kept,
    period: info,
    issuerPostalCode: facts.postalCode,
    cardForm: settings.cardPaymentForm,
    platformForm: settings.platformPaymentForm,
    maxConcepts: Infinity,
  });
  const part = parts[0];
  if (!part || parts.length !== 1) throw nothing();
  return {
    body: part.body,
    expectedTotal: part.expectedTotal,
    expectedTax: part.expectedTax,
    expectedWithholding: 0,
    conceptCount: part.body.items.length,
    ticketCount: part.ticketIds.length,
    nettedRefundIds: [...new Set(kept.flatMap((t) => t.refundIds))],
    detail: { dropped: dropped.length },
    excluded,
  };
}

async function freezeEgreso(
  tx: Tx,
  doc: DocumentRow,
  settings: SettingsRow,
  facts: FiscalFacts,
): Promise<Frozen> {
  if (
    !doc.parentDocumentId ||
    (!doc.refundId && !doc.creditTicketId) ||
    !facts.postalCode
  )
    throw nothing();
  const parent = await loadDocument(tx, doc.parentDocumentId);
  if (!parent?.uuid || !["valid", "canceling"].includes(parent.status))
    throw new DomainError("cfdi_not_valid", 409);
  let groups: { category: TaxCategory; gross: number; tax: number }[];
  let folio: string;
  let method: string = "cash";
  let credit: EgresoBuildInput["credit"] = null;
  let nettedRefundIds: string[] = [];
  if (doc.creditTicketId) {
    // Route III (CFDI-SAT-3): the note credits exactly what the global still declares for the
    // ticket (CFDI-INT-2), per category: the ticket's groups less the refunds the global netted
    // when it was frozen and less the refunds a live credit note to the global credits. Any other
    // refund is still inside the global's figure, so this note credits it too; the waiting
    // invoice, frozen once this note is valid, nets every refund, and cfdi_refund, which waits for
    // this note (cfdi_parent_credit_open), then finds the refund netted by that invoice. The
    // request refuses while a credit note to the global for one of the ticket's refunds has not
    // settled (createInvoiceRequest), so "live" here is final: valid, or its live substitute.
    const payload = await ticketForCfdi(tx, doc.creditTicketId);
    const ids = payload.refunds.map((r) => r.refundId);
    const credited = ids.length
      ? (
          await tx`
            select distinct refund_id from cfdi_documents
            where parent_document_id = ${parent.id} and kind = 'egreso'
              and refund_id = any(${ids}::uuid[]) and status not in ('failed','canceled')`
        ).map((r) => r.refund_id as string)
      : [];
    const accounted = new Set([...parent.nettedRefundIds, ...credited]);
    const subtracted = payload.refunds.filter((r) => accounted.has(r.refundId));
    // netGroups is the global builder's own netting (loadTickets), so the figures match its part.
    groups = netGroups(payload.ticket.groups, subtracted);
    nettedRefundIds = subtracted.map((r) => r.refundId);
    folio = payload.ticket.folio;
    credit = {
      purpose: "invoiced",
      paymentForm: paymentFormFor(payload.payments, {
        card: settings.cardPaymentForm,
        platform: settings.platformPaymentForm,
      }),
    };
  } else {
    groups = (await tx`
      select category, gross, tax from fiscal_adjustments where refund_id = ${doc.refundId}
      order by category`) as unknown as typeof groups;
    const [ticket] = await tx`
      select t.series, t.number from fiscal_adjustments a
      join fiscal_tickets t on t.tenant_id = a.tenant_id and t.order_id = a.order_id
      where a.refund_id = ${doc.refundId} limit 1`;
    if (!ticket) throw nothing();
    folio = formatFolio(ticket.series, Number(ticket.number));
    // 028's refunds.method ('cash' | 'external' | 'platform' since payments 037, NOT NULL DEFAULT
    // 'cash'): the egreso payment form (wave2-cross-track C26).
    const [refund] = await tx<{ method: string }[]>`
      select method from refunds where id = ${doc.refundId}`;
    method = refund?.method ?? "cash";
  }
  if (!groups.length) throw nothing();
  // A substitute credit note relates 04 to the one it replaces, which must still be valid.
  let replaces: { uuid: string; paymentForm: "01" | "04" | "28" } | null = null;
  if (doc.replacesDocumentId) {
    const replaced = await loadDocument(tx, doc.replacesDocumentId);
    if (!replaced?.uuid || replaced.status !== "valid")
      throw new DomainError("cfdi_substitute_invalid", 409);
    replaces = {
      uuid: replaced.uuid,
      paymentForm: doc.paymentFormOverride ?? "01",
    };
  }
  const built = buildEgresoRequest({
    docId: doc.id,
    folio,
    parent: {
      kind: parent.kind === "global" ? "global" : "invoice",
      uuid: parent.uuid,
      receptor: parent.receptor,
      paymentForm: parent.paymentForm,
      withholding: parent.expectedWithholding > 0,
    },
    refund: {
      method,
      groups: groups.map((g) => ({
        category: g.category,
        gross: g.gross,
        tax: g.tax,
      })),
    },
    issuerPostalCode: facts.postalCode,
    cardForm: settings.cardPaymentForm,
    platformForm: settings.platformPaymentForm,
    replaces,
    credit,
  });
  return {
    body: built.body,
    expectedTotal: built.expectedTotal,
    expectedTax: built.expectedTax,
    expectedWithholding: built.expectedWithholding,
    conceptCount: built.conceptCount,
    ticketCount: 0,
    // A route-III note: the ticket's refunds it left out because the global already accounts
    // for them (netted, or credited by their own notes). Empty for a refund's credit note.
    nettedRefundIds,
    // The ≤ 1 centavo difference from fiscal's adjustment IVA is expected (spec §4.8.3).
    detail: { fiscalTax: built.fiscalTax },
    excluded: [],
  };
}

/** Builds the request of a document (invoice, global part or credit note). */
export function freezeRequest(
  tx: Tx,
  doc: DocumentRow,
  settings: SettingsRow,
  facts: FiscalFacts,
): Promise<Frozen> {
  if (doc.kind === "invoice") return freezeInvoice(tx, doc, settings, facts);
  if (doc.kind === "global") return freezeGlobal(tx, doc, settings, facts);
  return freezeEgreso(tx, doc, settings, facts);
}
