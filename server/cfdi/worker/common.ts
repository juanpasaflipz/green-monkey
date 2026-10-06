/**
 * Helpers shared by the cfdi job handlers (worker only).
 */
import type { JobContext, JobOutcome } from "../../jobs.js";
import type { Tx } from "../../db.js";
import { classifyFacturapiError, type FacturapiFailure } from "../errors.js";
import { retryOrExhaust } from "../jobs.js";
import { insertEvent } from "../store.js";
import { cfdiRuntime, raise, tenantTag, type CfdiRuntime } from "./runtime.js";
import { VaultError } from "../vault.js";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** cfdi is not booted (no provider, or the boot check got a 401): fail fast, retry in 15 min. */
export function unavailable(ctx: JobContext): JobOutcome {
  return retryOrExhaust(ctx.job, {
    code: "cfdi_unavailable",
    afterMs: 15 * MINUTE,
  });
}

/** The runtime, or a retry outcome when cfdi is unavailable in this worker. */
export function runtimeOr(
  ctx: JobContext,
):
  | { rt: CfdiRuntime; outcome?: undefined }
  | { rt?: undefined; outcome: JobOutcome } {
  const rt = cfdiRuntime();
  return rt ? { rt } : { outcome: unavailable(ctx) };
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
