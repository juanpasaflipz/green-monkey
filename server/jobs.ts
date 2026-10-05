/**
 * Jobs outbox: public API (wave 1 contract §1.2; cfdi builds on it).
 *
 * Business code enqueues inside its own tenant transaction. The runner
 * (server/jobs/runner.ts) claims and runs jobs per tenant with the runtime
 * role, so no BYPASSRLS or table-owner credential is ever used in the web
 * process (DB-1). Only kinds with a registered handler are processed; blocked
 * jobs (receipt / printer_not_paired) are never touched.
 *
 * Lifecycle: queued|available → running → done, or back to available with
 * backoff, or dead after MAX_ATTEMPTS. Retention deletes done/dead jobs older
 * than 30 days and nothing else.
 */
import { randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import type { Logger } from "./logging.js";
import type { Session } from "../shared/domain.js";

export const MAX_ATTEMPTS = 8;

export interface ClaimedJob {
  tenantId: string;
  id: string;
  kind: string;
  dedupeKey: string;
  payload: unknown;
  attempts: number;
  /** lease_until as exact text: the fencing token for every later write. */
  lease: string;
  createdAt: Date;
}

export interface JobContext {
  job: ClaimedJob;
  /** Runs fn in a transaction scoped to the job's tenant (RLS). Must be replay-safe (contract 0.7). */
  tenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Extends the lease; throws job_lease_lost when another claimer owns the job. */
  extendLease(seconds: number): Promise<void>;
  /** Aborted on shutdown or lease expiry. */
  signal: AbortSignal;
  log: Logger;
}

export type JobOutcome =
  | void
  | { status: "done" }
  | { status: "retry"; code: string; afterMs?: number }
  | { status: "blocked"; code: string }
  | { status: "dead"; code: string };

/**
 * Handlers are idempotent (job.id is the provider idempotency key), never
 * hold a transaction across a network call, and write through ctx.tenant().
 * A thrown error retries with code = error.code ?? "handler_error".
 */
export type JobHandler = (ctx: JobContext) => Promise<JobOutcome>;

export interface RegisteredHandler {
  handler: JobHandler;
  concurrency: number;
  leaseSeconds: number;
}

const KIND = /^[a-z][a-z0-9_]{1,63}$/;
const registry = new Map<string, RegisteredHandler>();

export function registerJobHandler(
  kind: string,
  handler: JobHandler,
  o: { concurrency?: number; leaseSeconds?: number } = {},
) {
  if (!KIND.test(kind)) throw Error(`invalid job kind: ${kind}`);
  if (registry.has(kind))
    throw Error(`job handler already registered: ${kind}`);
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

/**
 * Inserts a job in the caller's tenant transaction. A repeated
 * (kind, dedupeKey) for the tenant is ignored.
 */
export async function enqueueJob(
  tx: Tx,
  s: Session,
  job: {
    kind: string;
    dedupeKey: string;
    payload: unknown;
    state?: "queued" | "available" | "blocked";
  },
): Promise<void> {
  if (!KIND.test(job.kind)) throw Error(`invalid job kind: ${job.kind}`);
  if (!job.dedupeKey || job.dedupeKey.length > 200)
    throw Error("job dedupeKey must be 1-200 characters");
  await tx`
    insert into jobs(tenant_id,id,kind,dedupe_key,payload,state)
    values(${s.tenantId},${randomUUID()},${job.kind},${job.dedupeKey},
           ${tx.json(job.payload as never)},${job.state ?? "available"})
    on conflict (tenant_id,kind,dedupe_key) do nothing`;
}
