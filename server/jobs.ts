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
 * backoff, or dead after the kind's maxAttempts (default MAX_ATTEMPTS).
 * Retention deletes done/dead jobs older than 30 days and nothing else.
 *
 * Wave 2.0: runAt defers the first claim; maxAttempts is per kind; worker-only
 * kinds register in server/jobs/worker-registry.ts and run in the worker
 * process.
 */
import { randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import type { Logger } from "./logging.js";
import type { Session } from "../shared/domain.js";

/** Default retry limit per kind (claims before a failure goes dead). */
export const MAX_ATTEMPTS = 8;
/** Highest per-kind limit a registration may request. */
export const MAX_ATTEMPTS_LIMIT = 100;
/** Job kinds: lowercase letters, digits and underscores, 2-64 characters; "<area>_" prefix (contract C-3). */
export const JOB_KIND = /^[a-z][a-z0-9_]{1,63}$/;

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
  /** A failure at attempts >= maxAttempts goes dead (attempts counts claims). */
  maxAttempts: number;
}

export interface JobRegistrationOptions {
  concurrency?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
}

const registry = new Map<string, RegisteredHandler>();

/** Validates one registration. Shared by the web registry below and server/jobs/worker-registry.ts. */
export function jobRegistration(
  kind: string,
  handler: JobHandler,
  o: JobRegistrationOptions = {},
): RegisteredHandler {
  if (!JOB_KIND.test(kind)) throw Error(`invalid job kind: ${kind}`);
  const concurrency = o.concurrency ?? 2;
  const leaseSeconds = o.leaseSeconds ?? 120;
  const maxAttempts = o.maxAttempts ?? MAX_ATTEMPTS;
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw Error("job handler concurrency must be a positive integer");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10)
    throw Error("job handler lease must be at least 10 seconds");
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > MAX_ATTEMPTS_LIMIT
  )
    throw Error("job handler maxAttempts must be an integer from 1 to 100");
  return { handler, concurrency, leaseSeconds, maxAttempts };
}

/** Registers a web-process kind (server/jobs/handlers/<area>.ts). */
export function registerJobHandler(
  kind: string,
  handler: JobHandler,
  o: JobRegistrationOptions = {},
): void {
  const entry = jobRegistration(kind, handler, o);
  if (registry.has(kind))
    throw Error(`job handler already registered: ${kind}`);
  registry.set(kind, entry);
}

export function handlers(): ReadonlyMap<string, RegisteredHandler> {
  return registry;
}

/** Test hook. */
export function clearJobHandlers() {
  registry.clear();
}

export interface EnqueueJob {
  kind: string;
  /** 1-200 characters; unique per (tenant, kind). */
  dedupeKey: string;
  payload: unknown;
  state?: "queued" | "available" | "blocked";
  /** No claim before this instant; omitted means now. */
  runAt?: Date;
}

/**
 * Inserts a job in the caller's tenant transaction. A repeated (kind, dedupeKey)
 * for the tenant is ignored: the first insert, and its runAt, win.
 */
export async function enqueueJob(
  tx: Tx,
  s: Pick<Session, "tenantId">,
  job: EnqueueJob,
): Promise<void> {
  if (!JOB_KIND.test(job.kind)) throw Error(`invalid job kind: ${job.kind}`);
  if (!job.dedupeKey || job.dedupeKey.length > 200)
    throw Error("job dedupeKey must be 1-200 characters");
  if (
    job.runAt !== undefined &&
    !(job.runAt instanceof Date && Number.isFinite(job.runAt.getTime()))
  )
    throw Error("job runAt must be a valid Date");
  await tx`
    insert into jobs(tenant_id,id,kind,dedupe_key,payload,state,next_at)
    values(${s.tenantId},${randomUUID()},${job.kind},${job.dedupeKey},
           ${tx.json(job.payload as never)},${job.state ?? "available"},
           coalesce(${job.runAt ?? null}::timestamptz, now()))
    on conflict (tenant_id,kind,dedupe_key) do nothing`;
}
