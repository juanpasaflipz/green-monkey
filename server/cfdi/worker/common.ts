/**
 * Helpers shared by the cfdi job handlers (worker only).
 */
import type { JobContext, JobOutcome } from "../../jobs.js";
import type { Tx } from "../../db.js";
import { classifyFacturapiError, type FacturapiFailure } from "../errors.js";
import { cfdiEnqueue, type CfdiJobKind } from "../jobs.js";
import { insertEvent } from "../store.js";
import {
  cfdiRuntime,
  raise,
  tenantTag,
  traceQuiet,
  type CfdiRuntime,
} from "./runtime.js";
import { VaultError } from "../vault.js";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

const WAIT = /:wait:(\d{1,4})$/;

/** The hand-over key and delay of the k-th wait: 15 min doubling to 6 h ("stamp:<id>:wait:3"). */
export function waitStep(dedupeKey: string): {
  dedupeKey: string;
  afterMs: number;
} {
  const m = WAIT.exec(dedupeKey);
  const k = m ? Number(m[1]) + 1 : 1;
  const base = m ? dedupeKey.slice(0, m.index) : dedupeKey;
  return {
    dedupeKey: `${base}:wait:${Math.min(k, 9999)}`,
    afterMs: Math.min(15 * MINUTE * 2 ** Math.min(k - 1, 5), 6 * HOUR),
  };
}

/**
 * cfdi is not booted in this worker (no provider keys on this deploy, or the boot check got a
 * 401). Waiting must not use up the job's attempts (review CFDI-R2: reconcile chains died in
 * about 45 minutes, cancellations stayed queued forever): the job hands over to a fresh copy of
 * itself (same kind and payload, attempts 0) due after 15 minutes, doubling to 6 hours, and
 * completes. Nothing was sent to the provider, so nothing else changes.
 */
export async function unavailable(ctx: JobContext): Promise<JobOutcome> {
  const next = waitStep(ctx.job.dedupeKey);
  await ctx.tenant((tx) =>
    cfdiEnqueue(tx, ctx.job.tenantId, {
      kind: ctx.job.kind as CfdiJobKind,
      dedupeKey: next.dedupeKey,
      payload: (ctx.job.payload ?? {}) as Record<string, unknown>,
      runAt: new Date(Date.now() + next.afterMs),
    }),
  );
  ctx.log.info("cfdi_job_waiting", {
    reason: "cfdi_unavailable",
    next: next.dedupeKey,
  });
  traceQuiet();
  return { status: "done" };
}

/** The runtime, or (cfdi unavailable in this worker) the hand-over outcome of unavailable(). */
export async function runtimeOr(
  ctx: JobContext,
): Promise<
  | { rt: CfdiRuntime; outcome?: undefined }
  | { rt?: undefined; outcome: JobOutcome }
> {
  const rt = cfdiRuntime();
  return rt ? { rt } : { outcome: await unavailable(ctx) };
}

/** Classifies any failure of a provider call, local vault errors included (permanent). */
export function classify(e: unknown): FacturapiFailure {
  if (e instanceof VaultError)
    return { retry: false, code: e.code, unknownOutcome: false };
  const coded = (e as { code?: unknown })?.code;
  if (
    e instanceof Error &&
    e.name === "CfdiJobError" &&
    typeof coded === "string"
  )
    return {
      retry: coded === "cfdi_unavailable" || coded === "cfdi_org_not_ready",
      code: coded,
      unknownOutcome: false,
    };
  return classifyFacturapiError(e);
}

/** A worker event (no actor). */
export function event(
  tx: Tx,
  ctx: JobContext,
  documentId: string | null,
  kind: string,
  detail: Record<string, unknown> = {},
) {
  return insertEvent(tx, ctx.job.tenantId, documentId, kind, detail, null);
}

/**
 * The organization key or the platform User key was refused: the organization goes to error
 * (cfdi_org_key_invalid) with a critical alert. Documents fail with that code.
 */
export async function markKeyInvalid(
  rt: CfdiRuntime,
  ctx: JobContext,
  code: string,
): Promise<void> {
  await ctx.tenant(
    (tx) => tx`
      update cfdi_organizations set status = 'error', error_code = ${code}
      where status <> 'error' or error_code is distinct from ${code}`,
  );
  raise(rt, {
    key: `cfdi_provider_auth_failed:${tenantTag(ctx.job.tenantId)}`,
    severity: "critical",
    title: "CFDI provider credentials refused",
    body: `tenant ${tenantTag(ctx.job.tenantId)} code ${code}`,
  });
}

export const AUTH_CODES = new Set([
  "cfdi_org_key_invalid",
  "cfdi_provider_auth_failed",
]);
