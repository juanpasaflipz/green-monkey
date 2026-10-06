/**
 * cfdi_reconcile (spec §4.9): polls a pending stamp (202: Facturapi retries for about 50 minutes)
 * or a cancellation waiting for the receptor's acceptance (3 business days; silence on a first
 * request is acceptance). Each poll is its own job (dedupe reconcile:<doc>:<purpose>:<n>).
 *   stamp   n < 8: every 10 min; n = 8: alert cfdi_stamp_unresolved, then every 6 h up to 12.
 *   cancel  every 30 min while n < 240 (5 days), then every 6 h up to 10 days, then alert and stop;
 *           PUT /invoices/{id}/status once a day (n % 48 = 0) asks SAT for the current status.
 * A chain restarted by Reintentar or by the global tick's recovery sweep (server/cfdi/recovery.ts)
 * carries a `chain` tag in its dedupe keys. Chains merge: a poll does not schedule the next one
 * while another chain of the same document and purpose already has one waiting.
 */
import type { JobContext, JobOutcome } from "../../jobs.js";
import {
  cfdiEnqueue,
  dedupe,
  lastAttempt,
  liveJob,
  retryOrExhaust,
} from "../jobs.js";
import { lockDocument } from "../locks.js";
import { loadDocument } from "../store.js";
import { classify, event, HOUR, MINUTE, runtimeOr } from "./common.js";
import { cancellationOutcome, loadCancellation, onCanceled } from "./cancel.js";
import { failDocument, recordStamped } from "./record.js";
import { documentKey, raise, tenantTag } from "./runtime.js";

type Payload = {
  documentId?: string;
  purpose?: "stamp" | "cancel";
  n?: number;
  chain?: string;
};
const CANCEL_FAST = 240;
const CANCEL_LAST = 260;

export async function reconcileJob(ctx: JobContext): Promise<JobOutcome> {
  const p = (ctx.job.payload ?? {}) as Payload;
  const documentId = p.documentId;
  const n = Number(p.n) || 1;
  if (!documentId || (p.purpose !== "stamp" && p.purpose !== "cancel"))
    return { status: "dead", code: "cfdi_invalid_payload" };
  const { rt, outcome } = await runtimeOr(ctx);
  if (!rt) return outcome;
  const tenantId = ctx.job.tenantId;
  const chain =
    typeof p.chain === "string" && /^[a-z0-9]{1,24}$/.test(p.chain)
      ? p.chain
      : undefined;
  const next = (purpose: "stamp" | "cancel", after: number) =>
    ctx.tenant(async (tx) => {
      // Another chain already has its next poll waiting: this one ends (chains merge).
      if (
        await liveJob(
          tx,
          "cfdi_reconcile",
          { documentId, purpose },
          { exceptId: ctx.job.id, notRunning: true },
        )
      )
        return;
      await cfdiEnqueue(tx, tenantId, {
        kind: "cfdi_reconcile",
        dedupeKey: dedupe.reconcile(documentId, purpose, n + 1, chain),
        payload: { documentId, purpose, n: n + 1, ...(chain ? { chain } : {}) },
        runAt: new Date(Date.now() + after),
      });
    });

  const loaded = await ctx.tenant(async (tx) => {
    const doc = await loadDocument(tx, documentId);
    if (!doc?.providerInvoiceId) return null;
    return { doc, key: await documentKey(rt, tx, tenantId, doc.mode) };
  });
  if (!loaded) return { status: "done" };
  const { doc, key } = loaded;
  try {
    if (p.purpose === "stamp") {
      if (doc.status !== "pending") return { status: "done" };
      const inv = await rt.client.getInvoice(
        key,
        doc.providerInvoiceId!,
        ctx.signal,
      );
      if (inv.status === "valid") {
        await recordStamped(ctx, documentId, inv);
        return { status: "done" };
      }
      if (inv.status === "failed") {
        await failDocument(rt, ctx, documentId, {
          code: "cfdi_stamping_failed",
        });
        return { status: "done" };
      }
      if (n < 8) await next("stamp", 10 * MINUTE);
      else if (n < 12) {
        if (n === 8)
          raise(rt, {
            key: `cfdi_stamp_unresolved:${tenantTag(tenantId)}:${documentId}`,
            severity: "warning",
            title: "CFDI stamp unresolved",
            body: `tenant ${tenantTag(tenantId)} document ${documentId}`,
          });
        await next("stamp", 6 * HOUR);
      } else
        await ctx.tenant((tx) =>
          event(tx, ctx, documentId, "reconcile_stopped", { purpose: "stamp" }),
        );
      return { status: "done" };
    }

    if (doc.status !== "canceling") return { status: "done" };
    const inv =
      n % 48 === 0
        ? await rt.client.refreshInvoiceStatus(
            key,
            doc.providerInvoiceId!,
            ctx.signal,
          )
        : await rt.client.getInvoice(key, doc.providerInvoiceId!, ctx.signal);
    const result = cancellationOutcome(inv);
    if (result === "canceled" || result === "rejected") {
      let rejectedSubstitution = false;
      // Under the document's key, like cfdi_cancel's completion and cfdi_refund's decision.
      await ctx.tenant(async (tx) => {
        await lockDocument(tx, tenantId, documentId);
        const current = await loadDocument(tx, documentId, { forUpdate: true });
        const c = await loadCancellation(tx, { documentId, open: true });
        if (!current || current.status !== "canceling" || !c) return;
        if (result === "canceled") return onCanceled(tx, ctx, current, c);
        const final =
          inv.cancellation_status === "expired" ? "expired" : "rejected";
        await tx`update cfdi_documents set status = 'valid' where id = ${documentId} and status = 'canceling'`;
        await tx`update cfdi_cancellations set status = ${final}, processed_at = now() where id = ${c.id}`;
        await event(tx, ctx, documentId, "cancel_rejected", { status: final });
        rejectedSubstitution = c.source === "substitution";
      });
      if (rejectedSubstitution)
        raise(rt, {
          key: `cfdi_substitution_rejected:${tenantTag(tenantId)}:${documentId}`,
          severity: "warning",
          title: "CFDI substitution rejected",
          body: `tenant ${tenantTag(tenantId)} document ${documentId}`,
        });
      return { status: "done" };
    }
    if (n < CANCEL_FAST) await next("cancel", 30 * MINUTE);
    else if (n < CANCEL_LAST) await next("cancel", 6 * HOUR);
    else {
      await ctx.tenant((tx) =>
        event(tx, ctx, documentId, "reconcile_stopped", { purpose: "cancel" }),
      );
      raise(rt, {
        key: `cfdi_cancel_unresolved:${tenantTag(tenantId)}:${documentId}`,
        severity: "warning",
        title: "CFDI cancellation unresolved",
        body: `tenant ${tenantTag(tenantId)} document ${documentId}`,
      });
    }
    return { status: "done" };
  } catch (e) {
    const failure = classify(e);
    if (failure.retry || failure.unknownOutcome) {
      // A provider outage must not end the polling chain: the last attempt hands over to the
      // next poll of the chain instead of dying.
      if (lastAttempt(ctx.job)) {
        await next(p.purpose, p.purpose === "stamp" ? 30 * MINUTE : HOUR);
        return { status: "done" };
      }
      return retryOrExhaust(ctx.job, {
        code: failure.code,
        afterMs: failure.afterMs,
      });
    }
    await ctx.tenant((tx) =>
      event(tx, ctx, documentId, "reconcile_failed", {
        purpose: p.purpose,
        code: failure.code,
      }),
    );
    return { status: "done" };
  }
}
