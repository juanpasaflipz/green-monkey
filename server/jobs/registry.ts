import type { Tx } from "../db.js";
import type { Logger } from "../log.js";
import type { ClaimedJob } from "./queue.js";

export interface JobContext {
  job: ClaimedJob;
  /** Runs fn in a transaction scoped to the job's tenant (RLS). */
  tenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Extends the lease; throws job_lease_lost when another claimer owns it. */
  extendLease(seconds: number): Promise<void>;
  /** Aborted on shutdown or lease loss. */
  signal: AbortSignal;
  log: Logger;
}

export type JobOutcome =
  | void
  | { status: "completed" }
  | { status: "retry"; code: string; afterMs?: number }
  | { status: "blocked"; code: string }
  | { status: "dead"; code: string };

/**
 * Handlers are idempotent (use job.id as the provider idempotency key), never
 * hold a transaction across a network call, and write through ctx.tenant().
 * A thrown error retries with code = error.code ?? "handler_error".
 */
export type JobHandler = (ctx: JobContext) => Promise<JobOutcome>;

export interface RegisteredHandler {
  handler: JobHandler;
  concurrency: number;
  leaseSeconds: number;
}

const registry = new Map<string, RegisteredHandler>();
const KIND = /^[a-z][a-z0-9_]{1,63}$/;

export function registerJobHandler(
  kind: string,
  handler: JobHandler,
  o: { concurrency?: number; leaseSeconds?: number } = {},
) {
  if (!KIND.test(kind)) throw Error(`invalid job kind: ${kind}`);
  if (registry.has(kind)) throw Error(`job handler already registered: ${kind}`);
  const concurrency = o.concurrency ?? 2;
  const leaseSeconds = o.leaseSeconds ?? 120;
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw Error("job handler concurrency must be a positive integer");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10)
    throw Error("job handler lease must be at least 10 seconds");
  registry.set(kind, { handler, concurrency, leaseSeconds });
}

export function handlers(): ReadonlyMap<string, RegisteredHandler> {
  return registry;
}

/** Test hook. */
export function clearJobHandlers() {
  registry.clear();
}
