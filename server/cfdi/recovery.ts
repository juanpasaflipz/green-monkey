/**
 * Recovery of documents whose job is gone (review CFDI-R2). A job can end without finishing the
 * document's state: a poll chain stopped or died (a pending stamp, a cancellation waiting for the
 * receptor), a cancellation was never sent, the reissue of a global stopped, or the files were
 * never stored. Two paths re-enqueue the job the state is waiting for:
 *   - Reintentar (managers, server/cfdi/service.ts retryDocument), tag "r<operation>";
 *   - the global tick's recovery sweep (worker, server/cfdi/worker/global.ts), tag "s<YYYYMMDD>",
 *     only when no live job already serves the document.
 * Loaded by both processes: imports the store, the jobs adapter and the db type only.
 */
import type { Tx } from "../db.js";
import {
  cfdiEnqueue,
  dedupe,
  liveJob,
  releaseDependents,
  type CfdiJobKind,
} from "./jobs.js";
import { loadDocument, type DocumentRow } from "./store.js";

/** A state counts as stranded after this long without a change (spec stuck rule: 30 minutes). */
export const RECOVERY_MINUTES = 30;

export type RecoveryAction =
  /** pending at the provider, or canceling while the receptor decides: poll again. */
  | { kind: "reconcile"; purpose: "stamp" | "cancel" }
  /** A global's motive-04 cancellation (invoice after a global) stopped. */
  | { kind: "reissue"; globalId: string }
  /** A staff cancellation, or a substitution whose substitute is valid, was never sent. */
  | { kind: "cancel"; cancellationId: string }
  /** The stamped files (or the cancellation acuse) were never stored. */
  | { kind: "deliver"; acuse: boolean }
  /** Worker only: invoices still waiting on a replacement global (G') that already finished. */
  | { kind: "release"; dependencyId: string };

type OpenCancellation = {
  id: string;
  source: "staff" | "substitution" | "reissue";
  status: "queued" | "requested";
  substituteDocumentId: string | null;
  createdAt: string;
};

async function openCancellation(
  tx: Tx,
  documentId: string,
): Promise<OpenCancellation | null> {
  const [c] = await tx`
    select id, source, status, substitute_document_id, created_at from cfdi_cancellations
    where document_id = ${documentId} and status in ('queued','requested')
    order by created_at desc limit 1`;
  return c
    ? {
        id: c.id,
        source: c.source,
        status: c.status,
        substituteDocumentId: c.substitute_document_id,
        createdAt: new Date(c.created_at).toISOString(),
      }
    : null;
}

/** What a document whose job may be gone is waiting for; null when nothing is stranded. */
export async function recoveryAction(
  tx: Tx,
  doc: DocumentRow,
  now = Date.now(),
): Promise<RecoveryAction | null> {
  const before = now - RECOVERY_MINUTES * 60_000;
  const stale = Date.parse(doc.updatedAt) < before;
  if (doc.status === "pending")
    return stale && doc.providerInvoiceId
      ? { kind: "reconcile", purpose: "stamp" }
      : null;
  if (doc.status === "canceling") {
    if (!stale) return null;
    const c = await openCancellation(tx, doc.id);
    return c?.source === "reissue"
      ? { kind: "reissue", globalId: doc.id }
      : { kind: "reconcile", purpose: "cancel" };
  }
  if (doc.status === "waiting") {
    if (!stale || !doc.dependsOn) return null;
    const dep = await loadDocument(tx, doc.dependsOn);
    if (!dep) return null;
    const c = await openCancellation(tx, dep.id);
    if (c?.source === "reissue") return { kind: "reissue", globalId: dep.id };
    // Only behind a finished REPLACEMENT global (G'): the reissue already activated the waiter's
    // claim, exactly as releaseDependents expects. A waiter behind an original global is never
    // released here (its ticket may still be in that global).
    return !c &&
      dep.kind === "global" &&
      dep.replacesDocumentId &&
      (dep.status === "valid" || dep.status === "failed")
      ? { kind: "release", dependencyId: dep.id }
      : null;
  }
  if (!["valid", "canceling", "canceled"].includes(doc.status)) return null;
  if (doc.status === "valid") {
    const c = await openCancellation(tx, doc.id);
    if (c && c.status === "queued" && Date.parse(c.createdAt) < before) {
      if (c.source === "reissue") return { kind: "reissue", globalId: doc.id };
      if (c.source === "staff") return { kind: "cancel", cancellationId: c.id };
      const sub = c.substituteDocumentId
        ? await loadDocument(tx, c.substituteDocumentId)
        : null;
      // Sent once the substitute is valid; failed by cfdi_cancel when the substitute ended
      // (CFDI-R4-1). Only a substitute still on its way leaves it waiting.
      if (
        !sub ||
        ["valid", "failed", "canceling", "canceled"].includes(sub.status)
      )
        return { kind: "cancel", cancellationId: c.id };
    }
  }
  const stampedBefore = doc.stampedAt
    ? Date.parse(doc.stampedAt) < before
    : false;
  if (!doc.providerInvoiceId || !stampedBefore) return null;
  const files = new Set(
    (await tx`select format from cfdi_files where document_id = ${doc.id}`).map(
      (r) => r.format as string,
    ),
  );
  if (!files.has("xml") || !files.has("pdf"))
    return { kind: "deliver", acuse: false };
  if (
    doc.status === "canceled" &&
    stale &&
    (!files.has("cancel_xml") || !files.has("cancel_pdf"))
  ) {
    // An acuse that named another CFDI (Facturapi's test-mode sample) is never fetched again
    // (LD-51 F7): the register offers none and the status comes from the document.
    const [mismatch] = await tx`
      select 1 as one from cfdi_events where document_id = ${doc.id} and kind = 'acuse_mismatch'
      limit 1`;
    return mismatch ? null : { kind: "deliver", acuse: true };
  }
  return null;
}

/** The job kind and payload match that serve an action (for the live-job check). */
function served(
  doc: DocumentRow,
  a: Exclude<RecoveryAction, { kind: "release" }>,
): { kind: CfdiJobKind; match: Record<string, string> } {
  switch (a.kind) {
    case "reconcile":
      return {
        kind: "cfdi_reconcile",
        match: { documentId: doc.id, purpose: a.purpose },
      };
    case "reissue":
      return { kind: "cfdi_reissue", match: { globalDocumentId: a.globalId } };
    case "cancel":
      return {
        kind: "cfdi_cancel",
        match: { cancellationId: a.cancellationId },
      };
    case "deliver":
      return { kind: "cfdi_deliver", match: { documentId: doc.id } };
  }
}

/**
 * Enqueues the job an action needs. `unlessLive` (the sweep) skips it while a live job already
 * serves the document; Reintentar always polls or sends now (handlers are idempotent and reconcile
 * chains merge). A release (waiting → queued) is a worker transition: `worker` must be true.
 * Returns whether anything was enqueued or released.
 */
export async function enqueueRecovery(
  tx: Tx,
  tenantId: string,
  doc: DocumentRow,
  a: RecoveryAction,
  o: { tag: string; unlessLive: boolean; worker: boolean },
): Promise<boolean> {
  if (a.kind === "release") {
    if (!o.worker) return false;
    return (await releaseDependents(tx, tenantId, a.dependencyId)).length > 0;
  }
  const s = served(doc, a);
  if (o.unlessLive && (await liveJob(tx, s.kind, s.match))) return false;
  switch (a.kind) {
    case "reconcile":
      await cfdiEnqueue(tx, tenantId, {
        kind: "cfdi_reconcile",
        dedupeKey: dedupe.reconcile(doc.id, a.purpose, 1, o.tag),
        payload: { documentId: doc.id, purpose: a.purpose, n: 1, chain: o.tag },
      });
      return true;
    case "reissue":
      await cfdiEnqueue(tx, tenantId, {
        kind: "cfdi_reissue",
        dedupeKey: dedupe.recovery(a.globalId, o.tag),
        payload: { globalDocumentId: a.globalId },
      });
      return true;
    case "cancel":
      await cfdiEnqueue(tx, tenantId, {
        kind: "cfdi_cancel",
        dedupeKey: dedupe.recovery(a.cancellationId, o.tag),
        payload: { cancellationId: a.cancellationId },
      });
      return true;
    case "deliver":
      await cfdiEnqueue(tx, tenantId, {
        kind: "cfdi_deliver",
        dedupeKey: dedupe.recovery(doc.id, o.tag + (a.acuse ? "a" : "")),
        payload: a.acuse
          ? { documentId: doc.id, acuse: true }
          : { documentId: doc.id },
      });
      return true;
  }
}

/** Ids of documents that may be stranded (the sweep's candidates), oldest change first. */
export async function recoveryCandidates(
  tx: Tx,
  limit = 100,
): Promise<string[]> {
  const rows = await tx`
    select d.id from cfdi_documents d
    where (d.status in ('pending','canceling','waiting')
        and d.updated_at < now() - make_interval(mins => ${RECOVERY_MINUTES}))
      or (d.status = 'valid' and d.id in (select c.document_id from cfdi_cancellations c
        where c.status = 'queued' and c.created_at < now() - make_interval(mins => ${RECOVERY_MINUTES})))
      or (d.status in ('valid','canceling','canceled')
        and d.created_at > now() - interval '35 days'
        and d.stamped_at < now() - make_interval(mins => ${RECOVERY_MINUTES})
        and ((select count(*) from cfdi_files f where f.tenant_id = d.tenant_id and f.document_id = d.id
               and f.format in ('xml','pdf')) < 2
          or (d.status = 'canceled' and (select count(*) from cfdi_files f where f.tenant_id = d.tenant_id
               and f.document_id = d.id and f.format in ('cancel_xml','cancel_pdf')) < 2)))
    order by d.updated_at
    limit ${limit}`;
  return rows.map((r) => r.id as string);
}
