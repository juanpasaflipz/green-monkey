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
 * backoff, or dead after the kind's maxAttempts (default MAX_ATTEMPTS). A
 * running job whose lease expired on its last allowed claim goes dead with
 * error_code lease_expired instead of being reclaimed (PLATFORM-OPS-3); staff
 * cancel a job with error_code cancelled and requeue dead ones
 * (server/jobs/queue.ts; a kind with an onDead hook is written dead by its
 * runner, with the hook, a few seconds after the cancel). Retention deletes
 * done/dead jobs older than 30 days and nothing else.
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
/** Longest lease a kind may register or extend to (PLATFORM-OPS-6). */
export const MAX_LEASE_SECONDS = 3600;

/**
 * Registration and ctx.extendLease accept whole seconds from 10 to MAX_LEASE_SECONDS: a
 * crashed job then waits at most an hour to be reclaimed (a longer lease would keep it
 * "running", unclaimable and unretryable), and the abort timer stays far below Node's
 * setTimeout limit (about 24.8 days, beyond which it fires at once).
 */
export function assertLeaseSeconds(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > MAX_LEASE_SECONDS)
    throw Error(
      `job lease must be an integer from 10 to ${MAX_LEASE_SECONDS} seconds`,
    );
}

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
  /**
   * Extends the lease to `seconds` from now: an integer from 10 to MAX_LEASE_SECONDS
   * (3600), else it throws a programming error before any SQL. Throws job_lease_lost when
   * another claimer owns the job.
   */
  extendLease(seconds: number): Promise<void>;
  /**
   * Aborted on shutdown or just before the lease expires. On lease expiry the runner
   * stops counting the job against its concurrency limits and logs job_lease_expired:
   * a handler that ignores the signal keeps running unaccounted, and its later writes
   * are fenced out once another claimer takes the job. Wire the signal into every
   * provider call.
   */
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

/**
 * Optional per kind: runs inside the transaction that writes a job of this kind dead (its last
 * allowed claim failed, its lease expired on that claim: `code` "lease_expired", or a staff
 * cancel: `code` "cancelled"), so the area leaves what the job had half done in a state people
 * can resolve (payments: an attempt left `sending` becomes `unknown`). The dead write and the
 * hook's writes commit together or not at all (P2-CONCURRENCY-6): a job is never dead without
 * its effect. A throw rolls the dead write back and is logged (job_dead_hook_failed); the job
 * stays running and the runner's lease-expiry pass writes it dead with its hook again (no
 * handler run in between). Write only through `tx` (the job's tenant, RLS), lock the job's
 * rows after the jobs row (payments: the attempt, LO-2c), and never call a provider. Whatever
 * must happen only once the transaction committed (an alert) goes to `afterCommit`; it never
 * runs for a rolled-back attempt.
 */
export type JobDeadHook = (ctx: {
  job: ClaimedJob;
  code: string;
  tx: Tx;
  afterCommit(fn: () => void): void;
  log: Logger;
}) => Promise<void>;

/**
 * Worker kinds that register an onDead hook; registerWorkerJobHandler refuses a mismatch either
 * way. The web never imports the worker registry, yet a staff cancel there must not write such a
 * job dead without its hook (the hook's writes are the worker's own transitions, 037): cancelJob
 * hands those jobs to the runner instead (server/jobs/queue.ts CANCEL_REQUESTED).
 */
export const WORKER_DEAD_HOOK_KINDS: ReadonlySet<string> = new Set([
  "payments_push",
  "payments_credentials",
]);

/** True when a kind's dead write must run with its onDead hook (web registry or worker list). */
export function hasDeadHook(kind: string): boolean {
  return (
    WORKER_DEAD_HOOK_KINDS.has(kind) || registry.get(kind)?.onDead !== undefined
  );
}

export interface RegisteredHandler {
  handler: JobHandler;
  concurrency: number;
  leaseSeconds: number;
  /** A failure at attempts >= maxAttempts goes dead (attempts counts claims). */
  maxAttempts: number;
  onDead?: JobDeadHook;
}

export interface JobRegistrationOptions {
  concurrency?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  onDead?: JobDeadHook;
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
  if (
    !Number.isInteger(leaseSeconds) ||
    leaseSeconds < 10 ||
    leaseSeconds > MAX_LEASE_SECONDS
  )
    throw Error("job handler lease must be an integer from 10 to 3600 seconds");
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > MAX_ATTEMPTS_LIMIT
  )
    throw Error("job handler maxAttempts must be an integer from 1 to 100");
  return {
    handler,
    concurrency,
    leaseSeconds,
    maxAttempts,
    ...(o.onDead ? { onDead: o.onDead } : {}),
  };
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
