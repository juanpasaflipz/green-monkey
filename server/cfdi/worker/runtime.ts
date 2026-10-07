/**
 * The cfdi worker runtime: configuration, keyring, Facturapi client and alert sink, set once by
 * cfdiWorkerBoot (or by a DB suite with the in-process fake) and read by every handler. Worker only.
 *
 * Provider keys: the platform User key and the shared sandbox test key come from the environment
 * (config); organization keys are sealed in cfdi_secrets and opened here per document mode. A test
 * document is never sent with a live key and the reverse (spec §4.4).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Alert } from "../../ops/alerts.js";
import type { Tx } from "../../db.js";
import type { CfdiWorkerConfig, Keyring } from "../config.js";
import {
  keyKindOf,
  type FacturapiClient,
  type FacturapiKey,
} from "../facturapi.js";
import { openSecret } from "../vault.js";

export type CfdiRuntime = {
  config: CfdiWorkerConfig;
  ring: Keyring | null;
  client: FacturapiClient;
  alert: (a: Alert) => void | Promise<void>;
  /** False after the boot check got a 401: handlers fail fast and retry in 15 minutes. */
  providerOk: boolean;
};

let current: CfdiRuntime | null = null;

export function setCfdiRuntime(r: CfdiRuntime | null): void {
  current = r;
}

/** A coded failure: thrown errors retry the job with this code (server/jobs/runner.ts). */
export class CfdiJobError extends Error {
  constructor(
    public code: string,
    message = code,
  ) {
    super(message);
    this.name = "CfdiJobError";
  }
}

/** The runtime, or null when cfdi is not booted in this process (no provider configured). */
export function cfdiRuntime(): CfdiRuntime | null {
  return current && current.config.provider !== "disabled" && current.providerOk
    ? current
    : null;
}

/** Fires an alert without letting a failing webhook break the handler. */
export function raise(rt: CfdiRuntime, a: Alert): void {
  void Promise.resolve()
    .then(() => rt.alert(a))
    .catch(() => undefined);
}

/** "0b6a1a8e": enough for an operator to find the restaurant; never a name. */
export const tenantTag = (tenantId: string) => tenantId.slice(0, 8);

export function userKey(rt: CfdiRuntime): FacturapiKey {
  if (!rt.config.userKey) throw new CfdiJobError("cfdi_unavailable");
  return { kind: "user", secret: rt.config.userKey };
}

/**
 * The key that issues a document of `mode` (spec §4.4): the shared sandbox test key, or the
 * organization's sealed test/live key. A live document needs the platform live switch.
 */
export async function documentKey(
  rt: CfdiRuntime,
  tx: Tx,
  tenantId: string,
  mode: "test" | "live",
): Promise<FacturapiKey> {
  if (rt.config.provider === "sandbox_shared") {
    if (mode !== "test" || !rt.config.testKey)
      throw new CfdiJobError("cfdi_live_not_enabled");
    return { kind: "test", secret: rt.config.testKey };
  }
  if (mode === "live" && !rt.config.liveEnabled)
    throw new CfdiJobError("cfdi_live_not_enabled");
  if (!rt.ring) throw new CfdiJobError("cfdi_unavailable");
  const [org] =
    await tx`select test_secret_id, live_secret_id from cfdi_organizations`;
  const secretId = mode === "live" ? org?.live_secret_id : org?.test_secret_id;
  if (!secretId) throw new CfdiJobError("cfdi_org_not_ready");
  const [row] = await tx`
    select purpose, payload_secret from cfdi_secrets where id = ${secretId}`;
  if (!row?.payload_secret) throw new CfdiJobError("cfdi_org_key_invalid");
  const purpose = mode === "live" ? "org_live_key" : "org_test_key";
  if (row.purpose !== purpose) throw new CfdiJobError("cfdi_org_key_invalid");
  const secret = await openSecret(rt.ring, row.payload_secret, {
    tenantId,
    purpose,
    id: secretId,
  });
  if (keyKindOf(secret) !== mode)
    throw new CfdiJobError("cfdi_org_key_invalid");
  return { kind: mode, secret };
}

/**
 * What a cfdi job did, for its one info line when it succeeds (LD-51 F13): the document it acted
 * on and the X-Facturapi-Log-Id of each provider answer (the client's onResponse).
 */
export type JobTrace = {
  documentId: string | null;
  logIds: string[];
  /** The job only handed over (cfdi unavailable): its own info line already says so. */
  quiet: boolean;
};

const traces = new AsyncLocalStorage<JobTrace>();

/** Runs a job handler with its trace (register.ts wraps every cfdi handler with it). */
export function withTrace<T>(
  trace: JobTrace,
  fn: () => Promise<T>,
): Promise<T> {
  return traces.run(trace, fn);
}

/** The Facturapi client's onResponse: a provider answer's log id joins the current job's trace. */
export function recordProviderResponse(meta: { logId: string | null }): void {
  const trace = traces.getStore();
  if (trace && meta.logId && trace.logIds.length < 20)
    trace.logIds.push(meta.logId);
}

/** The document the current job acted on (a cancellation's document, a refund's credit note). */
export function traceDocument(documentId: string | null): void {
  const trace = traces.getStore();
  if (trace && documentId) trace.documentId = documentId;
}

/** The current job only handed over: no second info line. */
export function traceQuiet(): void {
  const trace = traces.getStore();
  if (trace) trace.quiet = true;
}
