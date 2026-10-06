/**
 * cfdi_cancel (spec §4.8.5): DELETE /invoices/{id}?motive=&substitution= for staff cancellations
 * (02, 03) and substitutions (01, sent only after the substitute is valid). A cancellation that
 * needs the receptor's acceptance moves the document to `canceling` and is reconciled every 30
 * minutes (cfdi_reconcile). Motive 04 (invoice after a global) is cfdi_reissue's.
 */
import type { JobContext, JobOutcome } from "../../jobs.js";
import type { Tx } from "../../db.js";
import { cfdiEnqueue, dedupe, retryOrExhaust } from "../jobs.js";
import type { FInvoice } from "../facturapi.js";
import {
  activatePendingClaims,
  loadDocument,
  releaseClaims,
  type DocumentRow,
} from "../store.js";
import { classify, event, MINUTE, runtimeOr } from "./common.js";
import { documentKey, raise, tenantTag } from "./runtime.js";

export type CancellationRow = {
  id: string;
  documentId: string;
  motive: "01" | "02" | "03" | "04";
  substituteDocumentId: string | null;
  source: "staff" | "substitution" | "reissue";
  status: string;
};

export async function loadCancellation(
  tx: Tx,
  where: { id: string } | { documentId: string; open: true },
): Promise<CancellationRow | null> {
  const [r] =
    "id" in where
      ? await tx`select * from cfdi_cancellations where id = ${where.id}`
      : await tx`
          select * from cfdi_cancellations where document_id = ${where.documentId}
            and status in ('queued','requested') order by created_at desc limit 1`;
  return r
    ? {
        id: r.id,
        documentId: r.document_id,
        motive: r.motive,
        substituteDocumentId: r.substitute_document_id,
        source: r.source,
        status: r.status,
      }
    : null;
}

/**
 * The valid substitute of a canceled document still waiting for its ticket (pending claims): the
 * newest one, since a second substitution after a rejected one leaves an older valid substitute
 * behind (the alert asks the manager to cancel it).
 */
async function waitingSubstitute(
  tx: Tx,
  documentId: string,
): Promise<string | null> {
  const [r] = await tx`
    select d.id from cfdi_documents d
    where d.replaces_document_id = ${documentId} and d.status = 'valid'
      and exists (select 1 from cfdi_document_tickets c where c.tenant_id = d.tenant_id
        and c.document_id = d.id and c.state = 'pending')
    order by d.created_at desc limit 1`;
  return (r?.id as string | undefined) ?? null;
}

/**
 * The CFDI is canceled (spec §4.8.5 onCanceled): its claims are released, the acuse is fetched,
 * and a valid substitute's pending claims activate, on EVERY cancellation path of the original:
 * the motive-01 cancellation of a substitution, or a staff cancellation (02/03) requested after a
 * rejected or expired substitution (CFDI-R2-4). Without a waiting substitute the freed tickets go
 * back to the next global tick (a supplementary part of their own period). Reissue cancellations
 * are completed by cfdi_reissue, which re-reads the state.
 */
export async function onCanceled(
  tx: Tx,
  ctx: JobContext,
  doc: DocumentRow,
  c: CancellationRow,
): Promise<void> {
  const tenantId = ctx.job.tenantId;
  await tx`
    update cfdi_documents set status = 'canceled'
    where id = ${doc.id} and status in ('valid','canceling')`;
  await tx`
    update cfdi_cancellations set status = 'accepted', processed_at = now()
    where id = ${c.id} and status in ('queued','requested')`;
  await event(tx, ctx, doc.id, "canceled", {
    motive: c.motive,
    source: c.source,
  });
  await cfdiEnqueue(tx, tenantId, {
    kind: "cfdi_deliver",
    dedupeKey: dedupe.acuse(doc.id),
    payload: { documentId: doc.id, acuse: true },
  });
  if (c.source === "reissue") return;
  await releaseClaims(tx, doc.id, "canceled");
  const substitute =
    c.source === "substitution" && c.substituteDocumentId
      ? c.substituteDocumentId
      : await waitingSubstitute(tx, doc.id);
  if (substitute) {
    await activatePendingClaims(tx, substitute);
    await event(tx, ctx, substitute, "substitution_completed", {
      replaced: doc.id,
      motive: c.motive,
    });
  } else
    await cfdiEnqueue(tx, tenantId, {
      kind: "cfdi_global",
      dedupeKey: dedupe.tickAfterCancel(doc.id),
      payload: {},
    });
}

/** Requested (pending receptor acceptance): canceling, reconciled from +30 minutes. */
export async function onRequested(
  tx: Tx,
  ctx: JobContext,
  doc: DocumentRow,
  c: CancellationRow,
): Promise<void> {
  await tx`update cfdi_documents set status = 'canceling' where id = ${doc.id} and status = 'valid'`;
  await tx`update cfdi_cancellations set status = 'requested' where id = ${c.id} and status = 'queued'`;
  await event(tx, ctx, doc.id, "cancel_requested", { motive: c.motive });
  await cfdiEnqueue(tx, ctx.job.tenantId, {
    kind: "cfdi_reconcile",
    dedupeKey: dedupe.reconcile(doc.id, "cancel", 1),
    payload: { documentId: doc.id, purpose: "cancel", n: 1 },
    runAt: new Date(Date.now() + 30 * MINUTE),
  });
}

export function cancellationOutcome(
  inv: FInvoice,
): "canceled" | "pending" | "rejected" | "valid" {
  if (inv.status === "canceled" || inv.cancellation_status === "accepted")
    return "canceled";
  if (
    inv.cancellation_status === "pending" ||
    inv.cancellation_status === "verifying"
  )
    return "pending";
  if (
    inv.cancellation_status === "rejected" ||
    inv.cancellation_status === "expired"
  )
    return "rejected";
  return "valid";
}

export async function cancelJob(ctx: JobContext): Promise<JobOutcome> {
  const cancellationId = (ctx.job.payload as { cancellationId?: string } | null)
    ?.cancellationId;
  if (!cancellationId) return { status: "dead", code: "cfdi_invalid_payload" };
  const { rt, outcome } = await runtimeOr(ctx);
  if (!rt) return outcome;
  const tenantId = ctx.job.tenantId;

  const loaded = await ctx.tenant(async (tx) => {
    const c = await loadCancellation(tx, { id: cancellationId });
    if (!c || c.status !== "queued" || c.source === "reissue") return null;
    const doc = await loadDocument(tx, c.documentId);
    if (!doc || doc.status !== "valid" || !doc.providerInvoiceId) return null;
    let substituteUuid: string | null = null;
    if (c.motive === "01") {
      const sub = c.substituteDocumentId
        ? await loadDocument(tx, c.substituteDocumentId)
        : null;
      if (!sub || sub.status === "failed") {
        await tx`
          update cfdi_cancellations set status = 'failed', error_code = 'cfdi_substitute_failed', processed_at = now()
          where id = ${c.id} and status = 'queued'`;
        return null;
      }
      if (sub.status !== "valid" || !sub.uuid) return { wait: true as const };
      substituteUuid = sub.uuid;
    }
    return {
      c,
      doc,
      substituteUuid,
      key: await documentKey(rt, tx, tenantId, doc.mode),
    };
  });
  if (!loaded) return { status: "done" };
  // The substitute is not stamped yet: recordStamped enqueues this cancellation again (its own
  // dedupe key) once it is valid, and failDocumentTx fails it if the substitute fails. Retrying
  // here would only use up attempts while the substitute is pending (CFDI-R2).
  if ("wait" in loaded) return { status: "done" };
  const { c, doc } = loaded;
  try {
    const inv = await rt.client.cancelInvoice(
      loaded.key,
      doc.providerInvoiceId!,
      c.motive === "01"
        ? { motive: "01", substitution: loaded.substituteUuid! }
        : { motive: c.motive },
      ctx.signal,
    );
    const result = cancellationOutcome(inv);
    await ctx.tenant(async (tx) => {
      const current = await loadDocument(tx, doc.id, { forUpdate: true });
      if (!current) return;
      if (result === "canceled") await onCanceled(tx, ctx, current, c);
      else await onRequested(tx, ctx, current, c);
    });
    return { status: "done" };
  } catch (e) {
    const failure = classify(e);
    if (failure.code === "cfdi_cancellation_in_progress") {
      await ctx.tenant(async (tx) => {
        const current = await loadDocument(tx, doc.id, { forUpdate: true });
        if (current) await onRequested(tx, ctx, current, c);
      });
      return { status: "done" };
    }
    if (failure.retry || failure.unknownOutcome)
      return retryOrExhaust(ctx.job, {
        code: failure.code,
        afterMs: failure.afterMs,
      });
    await ctx.tenant(async (tx) => {
      await tx`
        update cfdi_cancellations set status = 'failed', error_code = ${failure.code === "cfdi_provider_rejected" ? "cfdi_cancel_rejected_provider" : failure.code},
          processed_at = now()
        where id = ${c.id} and status = 'queued'`;
      await event(tx, ctx, doc.id, "cancel_failed", {
        code: failure.code,
        providerCode: failure.providerCode ?? null,
      });
    });
    raise(rt, {
      key: `cfdi_cancel_failed:${tenantTag(tenantId)}:${doc.id}`,
      severity: "warning",
      title: "CFDI cancellation refused",
      body: `tenant ${tenantTag(tenantId)} document ${doc.id} code ${failure.code}`,
    });
    return { status: "done" };
  }
}
