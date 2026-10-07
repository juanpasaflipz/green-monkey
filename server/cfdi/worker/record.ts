/**
 * Recording stamping outcomes (spec §4.8.3 step 6, §4.9): shared by cfdi_stamp and cfdi_reconcile.
 * A stamp is recorded only through stampFacts() (cfdi-rebase S7); an outcome that may have created
 * an invoice never fails a document or releases its claims.
 */
import type { JobContext } from "../../jobs.js";
import type { Tx } from "../../db.js";
import { assertLivemode, stampFacts, type FInvoice } from "../facturapi.js";
import { cfdiEnqueue, dedupe, releaseDependents } from "../jobs.js";
import {
  activatePendingClaims,
  loadDocument,
  releaseClaims,
  type DocumentRow,
} from "../store.js";
import { event, MINUTE } from "./common.js";
import { raise, tenantTag, traceFailure, type CfdiRuntime } from "./runtime.js";

/** valid: provider ids, UUID and totals; deliver; release dependents; a substitute's cancellation. */
export async function recordStamped(
  ctx: JobContext,
  documentId: string,
  invoice: FInvoice,
): Promise<"recorded" | "already"> {
  const facts = stampFacts(invoice);
  return ctx.tenant(async (tx) => {
    const doc = await loadDocument(tx, documentId, { forUpdate: true });
    if (!doc || !["stamping", "pending"].includes(doc.status)) return "already";
    assertLivemode(invoice, doc.mode);
    await tx`
      update cfdi_documents set provider_invoice_id = ${invoice.id}, uuid = ${facts.uuid},
        livemode = ${invoice.livemode}, folio_number = ${facts.folioNumber}, total = ${facts.total},
        stamped_at = ${new Date(facts.stampedAt)}, verification_url = ${facts.verificationUrl?.slice(0, 500) ?? null},
        status = 'valid', error_code = null, error_message = null, error_path = null
      where id = ${documentId}`;
    await event(tx, ctx, documentId, "stamped", { total: facts.total });
    await cfdiEnqueue(tx, ctx.job.tenantId, {
      kind: "cfdi_deliver",
      dedupeKey: dedupe.deliver(documentId),
      payload: { documentId },
    });
    // Route III (CFDI-SAT-3): the credit note to the global is valid, so the global no longer
    // covers this ticket; the nominative invoice waiting on the note takes it, then stamps.
    if (doc.creditTicketId && doc.parentDocumentId) {
      await tx`
        update cfdi_document_tickets set state = 'released', released_reason = 'superseded',
          released_at = now()
        where document_id = ${doc.parentDocumentId} and ticket_id = ${doc.creditTicketId}
          and state = 'active'`;
      const waiters = await tx`
        select id from cfdi_documents where depends_on = ${documentId} and status = 'waiting'`;
      for (const w of waiters) await activatePendingClaims(tx, w.id as string);
    }
    await releaseDependents(tx, ctx.job.tenantId, documentId);
    if (doc.replacesDocumentId) {
      const [c] = await tx`
        select id from cfdi_cancellations
        where substitute_document_id = ${documentId} and status = 'queued'`;
      if (c)
        await cfdiEnqueue(tx, ctx.job.tenantId, {
          kind: "cfdi_cancel",
          dedupeKey: dedupe.cancelAfterSubstitute(c.id),
          payload: { cancellationId: c.id },
        });
    }
    return "recorded";
  });
}

/** 202 / pending: Facturapi keeps recovering for about 50 minutes; reconcile from +10 min. */
export async function recordPending(
  ctx: JobContext,
  documentId: string,
  invoice: FInvoice,
): Promise<void> {
  await ctx.tenant(async (tx) => {
    const doc = await loadDocument(tx, documentId, { forUpdate: true });
    if (!doc || doc.status !== "stamping") return;
    assertLivemode(invoice, doc.mode);
    await tx`
      update cfdi_documents set provider_invoice_id = ${invoice.id}, status = 'pending'
      where id = ${documentId}`;
    await event(tx, ctx, documentId, "pending", {});
    await cfdiEnqueue(tx, ctx.job.tenantId, {
      kind: "cfdi_reconcile",
      dedupeKey: dedupe.reconcile(documentId, "stamp", 1),
      payload: { documentId, purpose: "stamp", n: 1 },
      runAt: new Date(Date.now() + 10 * MINUTE),
    });
  });
}

export type Failure = {
  code: string;
  message?: string | null;
  path?: string | null;
  /** The refused answer's X-Facturapi-Log-Id (CFDIFIX-OPS-1). */
  logId?: string | null;
};

/**
 * Permanent failure inside a transaction: the document fails with the code and the provider's
 * message and field, its claims are released (a substitute's queued cancellation fails too) and
 * documents waiting on it are queued. Returns the document when it changed.
 */
export async function failDocumentTx(
  tx: Tx,
  ctx: JobContext,
  documentId: string,
  f: Failure,
): Promise<DocumentRow | null> {
  const doc = await loadDocument(tx, documentId, { forUpdate: true });
  if (
    !doc ||
    !["waiting", "queued", "stamping", "pending"].includes(doc.status)
  )
    return null;
  await tx`
    update cfdi_documents set status = 'failed', error_code = ${f.code},
      error_message = ${f.message?.slice(0, 1000) ?? null}, error_path = ${f.path?.slice(0, 200) ?? null}
    where id = ${documentId}`;
  await releaseClaims(tx, documentId, "failed");
  if (doc.replacesDocumentId)
    await tx`
      update cfdi_cancellations set status = 'failed', error_code = 'cfdi_substitute_failed',
        processed_at = now()
      where substitute_document_id = ${documentId} and status = 'queued'`;
  // A route-III credit note that failed: the global still covers the ticket, so the invoice
  // waiting on it fails too (it would otherwise invoice the ticket twice).
  if (doc.creditTicketId) {
    const waiters = await tx`
      update cfdi_documents set status = 'failed', error_code = 'cfdi_global_credit_failed'
      where depends_on = ${documentId} and status = 'waiting' returning id`;
    for (const w of waiters) {
      await releaseClaims(tx, w.id as string, "failed");
      await event(tx, ctx, w.id as string, "failed", {
        code: "cfdi_global_credit_failed",
      });
    }
  }
  await releaseDependents(tx, ctx.job.tenantId, documentId);
  await event(tx, ctx, documentId, "failed", {
    code: f.code,
    path: f.path ?? null,
    logId: f.logId ?? null,
  });
  // The job's log line says the document failed, not that the job succeeded (CFDIFIX-OPS-1).
  traceFailure(f.code, f.logId ?? null);
  return doc;
}

/** failDocumentTx in its own transaction, plus the global failure alert. */
export async function failDocument(
  rt: CfdiRuntime,
  ctx: JobContext,
  documentId: string,
  f: Failure,
): Promise<void> {
  const doc = await ctx.tenant((tx) => failDocumentTx(tx, ctx, documentId, f));
  if (doc?.kind === "global") globalFailedAlert(rt, ctx, documentId, f.code);
}

export function globalFailedAlert(
  rt: CfdiRuntime,
  ctx: JobContext,
  documentId: string,
  code: string,
) {
  raise(rt, {
    key: `cfdi_global_failed:${tenantTag(ctx.job.tenantId)}:${documentId}`,
    severity: "warning",
    title: "CFDI global failed",
    body: `tenant ${tenantTag(ctx.job.tenantId)} document ${documentId} code ${code}`,
  });
}
