/**
 * cfdi job kinds, limits and the enqueue adapter (spec §4.8). Loaded by the web (requests enqueue
 * stamping, cancellation, refund and settings jobs) and by the worker (handlers chain follow-ups).
 * Imports only server/jobs.ts, never the worker registry: the web runner must never see a cfdi kind
 * (they are registered only in server/cfdi/worker/register.ts, imported only by server/worker.ts).
 *
 * Job payloads carry ids and flags only (spec R16): never a receptor, RFC or email, because
 * GET /api/jobs shows managers every tenant job and the worker discovery policy widens reads.
 */
import { enqueueJob, type ClaimedJob, type JobOutcome } from "../jobs.js";
import type { Tx } from "../db.js";

export const CFDI_JOB_KINDS = [
  "cfdi_org",
  "cfdi_csd",
  "cfdi_stamp",
  "cfdi_deliver",
  "cfdi_cancel",
  "cfdi_reconcile",
  "cfdi_global",
  "cfdi_refund",
  "cfdi_reissue",
] as const;
export type CfdiJobKind = (typeof CFDI_JOB_KINDS)[number];

/** Registration options: the single source for register.ts and the unit test. */
export const CFDI_JOB_LIMITS: Record<
  CfdiJobKind,
  { concurrency: number; leaseSeconds: number; maxAttempts: number }
> = {
  cfdi_org: { concurrency: 1, leaseSeconds: 120, maxAttempts: 8 },
  cfdi_csd: { concurrency: 1, leaseSeconds: 120, maxAttempts: 3 },
  cfdi_stamp: { concurrency: 2, leaseSeconds: 180, maxAttempts: 20 },
  cfdi_deliver: { concurrency: 2, leaseSeconds: 120, maxAttempts: 8 },
  cfdi_cancel: { concurrency: 1, leaseSeconds: 120, maxAttempts: 12 },
  cfdi_reconcile: { concurrency: 2, leaseSeconds: 60, maxAttempts: 3 },
  cfdi_global: { concurrency: 1, leaseSeconds: 300, maxAttempts: 20 },
  cfdi_refund: { concurrency: 1, leaseSeconds: 60, maxAttempts: 60 },
  cfdi_reissue: { concurrency: 1, leaseSeconds: 180, maxAttempts: 20 },
};

/** Per-document retry limits carried in a stamping payload. */
export const INVOICE_MAX_ATTEMPTS = 12;
export const GLOBAL_MAX_ATTEMPTS = 20;

/** Dedupe keys (enqueueJob accepts ≤ 200 characters; the longest here is about 90). */
export const dedupe = {
  provision: (operationId: string) => `provision:${operationId}`,
  refresh: (at: Date) => `refresh:${tenMinuteBucket(at)}`,
  goLive: (operationId: string) => `go_live:${operationId}`,
  csd: (uploadId: string) => `csd:${uploadId}`,
  stamp: (documentId: string, suffix = "") => `stamp:${documentId}${suffix}`,
  deliver: (documentId: string) => `deliver:${documentId}`,
  email: (operationId: string) => `email:${operationId}`,
  acuse: (documentId: string) => `acuse:${documentId}`,
  cancel: (cancellationId: string) => `cancel:${cancellationId}`,
  reconcile: (documentId: string, purpose: "stamp" | "cancel", n: number) =>
    `reconcile:${documentId}:${purpose}:${n}`,
  tick: (at: Date) => `tick:${at.toISOString()}`,
  tickEnsure: (at: Date) => `tick:ensure:${tenMinuteBucket(at)}`,
  tickActivate: () => "tick:activate",
  tickLive: () => "tick:live",
  tickAfterCancel: (documentId: string) => `tick:after-cancel:${documentId}`,
  run: (operationId: string) => `run:${operationId}`,
  refund: (refundId: string) => `refund:${refundId}`,
  refundForce: (refundId: string, operationId: string) =>
    `refund:${refundId}:force:${operationId}`,
  refundSweep: (refundId: string, day: string) =>
    `refund:${refundId}:sweep:${day}`,
  reissue: (globalId: string, cancellationId: string) =>
    `reissue:${globalId}:${cancellationId}`,
};

/** "2026-10-05T18:40" for 18:40:00–18:49:59 UTC. */
export function tenMinuteBucket(at: Date): string {
  const d = new Date(Math.floor(at.getTime() / 600_000) * 600_000);
  return d.toISOString().slice(0, 16);
}

/** The only place cfdi calls enqueueJob (Wave 2.0 signature, runAt defers the first claim). */
export async function cfdiEnqueue(
  tx: Tx,
  tenantId: string,
  job: {
    kind: CfdiJobKind;
    dedupeKey: string;
    payload: Record<string, unknown>;
    runAt?: Date;
  },
): Promise<void> {
  await enqueueJob(
    tx,
    { tenantId },
    {
      kind: job.kind,
      dedupeKey: job.dedupeKey,
      payload: job.payload,
      runAt: job.runAt,
    },
  );
}

/** Enqueues the stamping of a document with its per-document retry limit. */
export async function enqueueStamp(
  tx: Tx,
  tenantId: string,
  documentId: string,
  o: { maxAttempts: 12 | 20; suffix?: string; runAt?: Date },
): Promise<void> {
  await cfdiEnqueue(tx, tenantId, {
    kind: "cfdi_stamp",
    dedupeKey: dedupe.stamp(documentId, o.suffix),
    payload: { documentId, maxAttempts: o.maxAttempts },
    runAt: o.runAt,
  });
}

/**
 * Worker only (waiting → queued is a worker transition): documents waiting on `documentId` (late
 * invoices behind a reissued global) are queued and their stamping enqueued.
 */
export async function releaseDependents(
  tx: Tx,
  tenantId: string,
  documentId: string,
): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    update cfdi_documents set status = 'queued'
    where depends_on = ${documentId} and status = 'waiting'
    returning id`;
  for (const r of rows)
    await enqueueStamp(tx, tenantId, r.id, {
      maxAttempts: INVOICE_MAX_ATTEMPTS,
      suffix: ":dep",
    });
  return rows.map((r) => r.id);
}

const CODE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Per-document retry limit (payload.maxAttempts); also enforces the per-kind ceiling so the handler
 * records its event before the runner kills the job. Codes always match the jobs code regex.
 */
export function retryOrExhaust(
  job: Pick<ClaimedJob, "kind" | "attempts" | "payload">,
  r: { code: string; afterMs?: number },
): JobOutcome {
  const perDocument =
    Number((job.payload as { maxAttempts?: unknown } | null)?.maxAttempts) ||
    Infinity;
  const perKind =
    CFDI_JOB_LIMITS[job.kind as CfdiJobKind]?.maxAttempts ?? Infinity;
  const code = CODE.test(r.code) ? r.code : "cfdi_unexpected_error";
  if (job.attempts >= Math.min(perDocument, perKind))
    return { status: "dead", code: "cfdi_attempts_exhausted" };
  return r.afterMs === undefined
    ? { status: "retry", code }
    : { status: "retry", code, afterMs: Math.max(0, Math.round(r.afterMs)) };
}

/** True when the next failure of this job ends it (per-document or per-kind limit). */
export function lastAttempt(
  job: Pick<ClaimedJob, "kind" | "attempts" | "payload">,
): boolean {
  const outcome = retryOrExhaust(job, { code: "cfdi_probe" });
  return !!outcome && outcome.status === "dead";
}
