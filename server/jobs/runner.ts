/**
 * In-process jobs runner for the web service (wave 1 contract §1.2).
 *
 * The runtime role can only see one tenant's jobs at a time (RLS), so the
 * runner works per tenant: every successful authenticated write marks its
 * tenant active (server/logging.ts requestLog), which schedules a drain for
 * that tenant, and a periodic sweep (30 s) revisits tenants active in the
 * last 24 h for retries whose backoff has elapsed.
 *
 * What a handler author (cfdi) can rely on, and what not:
 * - The tenant list lives in memory. After a restart or deploy, a tenant's
 *   pending jobs and retries resume on its first authenticated request of
 *   any kind (a read from a terminal, KDS or manager screen is enough), then
 *   the sweep keeps them going. A tenant with no signed-in activity at all
 *   is not drained until it has some.
 * - Jobs enqueued by an unauthenticated request (public ordering) are
 *   claimed by the sweep if the tenant is already known, otherwise on its
 *   next authenticated request.
 * - Delivery is at least once and latency is not bounded; handlers must be
 *   idempotent and must not assume a job runs within a deadline.
 */
import type postgres from "postgres";
import { tenant } from "../db.js";
import { log as rootLog, type Logger } from "../logging.js";
import {
  handlers as registeredHandlers,
  type JobOutcome,
  type RegisteredHandler,
  type ClaimedJob,
} from "../jobs.js";
import {
  claimJobs,
  completeJob,
  extendLease,
  failJob,
  jobErrorCode,
} from "./queue.js";
import "./handlers/index.js";

export type JobAction =
  | { action: "complete" }
  | {
      action: "fail";
      code: string;
      retryAfterMs?: number;
      dead?: boolean;
      blocked?: boolean;
    };

/** Maps a handler result (or thrown error) to the queue write. */
export function resolveOutcome(
  result: { ok: true; outcome: JobOutcome } | { ok: false; error: unknown },
): JobAction {
  if (!result.ok)
    return {
      action: "fail",
      code: jobErrorCode((result.error as { code?: unknown })?.code),
    };
  const outcome = result.outcome;
  if (!outcome || outcome.status === "done") return { action: "complete" };
  if (outcome.status === "retry")
    return {
      action: "fail",
      code: jobErrorCode(outcome.code),
      retryAfterMs: outcome.afterMs,
    };
  if (outcome.status === "blocked")
    return { action: "fail", code: jobErrorCode(outcome.code), blocked: true };
  return { action: "fail", code: jobErrorCode(outcome.code), dead: true };
}

export interface JobRunner {
  /** Starts the periodic sweep. */
  start(): void;
  /**
   * A successful authenticated write marks the tenant active and schedules a
   * drain. A read only introduces a tenant this runner does not know yet
   * (after a restart), so reads never add load for known tenants.
   */
  noteTenant(tenantId: string, activity?: "write" | "read"): void;
  /** Claims and runs the tenant's runnable jobs; resolves with the number claimed. */
  drainTenant(tenantId: string): Promise<number>;
  /**
   * Stops claiming and waits for in-flight drains and running handlers, all
   * within `timeoutMs`; then aborts whatever is still running.
   */
  stop(timeoutMs: number): Promise<void>;
  running(): number;
}

export function createJobRunner(
  sql: postgres.Sql,
  o: {
    concurrency?: number;
    sweepMs?: number;
    debounceMs?: number;
    activeForMs?: number;
    maxTenants?: number;
    handlers?: () => ReadonlyMap<string, RegisteredHandler>;
    onDead?: (job: ClaimedJob, code: string) => void;
    log?: Logger;
  } = {},
): JobRunner {
  const limit = o.concurrency ?? 2;
  const sweepMs = o.sweepMs ?? 30_000;
  const debounceMs = o.debounceMs ?? 250;
  const activeForMs = o.activeForMs ?? 24 * 3600_000;
  const maxTenants = o.maxTenants ?? 5000;
  const getHandlers = o.handlers ?? registeredHandlers;
  const log = o.log ?? rootLog.child({ loop: "jobs" });
  const active = new Map<
    string,
    { kind: string; promise: Promise<void>; abort: AbortController }
  >();
  const seen = new Map<string, number>();
  const scheduled = new Map<string, NodeJS.Timeout>();
  const draining = new Map<string, Promise<number>>();
  let stopping = false;
  let sweepTimer: NodeJS.Timeout | null = null;

  const perKind = (kind: string) =>
    [...active.values()].filter((a) => a.kind === kind).length;

  function execute(job: ClaimedJob, entry: RegisteredHandler) {
    const abort = new AbortController();
    const jobLog = log.child({
      jobId: job.id,
      kind: job.kind,
      tenantId: job.tenantId,
    });
    let leaseTimer: NodeJS.Timeout | null = null;
    const armLease = (seconds: number) => {
      if (leaseTimer) clearTimeout(leaseTimer);
      // Abort a little before the lease expires; fenced writes would be
      // rejected anyway once another runner reclaims the job.
      leaseTimer = setTimeout(
        () => abort.abort(new Error("job_lease_expired")),
        Math.max(1000, seconds * 1000 - 2000),
      );
      leaseTimer.unref();
    };
    armLease(entry.leaseSeconds);
    const promise = (async () => {
      let result:
        { ok: true; outcome: JobOutcome } | { ok: false; error: unknown };
      try {
        result = {
          ok: true,
          outcome: await entry.handler({
            job,
            signal: abort.signal,
            log: jobLog,
            tenant: (fn) => tenant(sql, job.tenantId, fn),
            extendLease: async (seconds) => {
              const lease = await extendLease(sql, job, seconds);
              if (!lease) {
                abort.abort(new Error("job_lease_lost"));
                throw Object.assign(new Error("job_lease_lost"), {
                  code: "job_lease_lost",
                });
              }
              job.lease = lease;
              armLease(seconds);
            },
          }),
        };
      } catch (error) {
        result = { ok: false, error };
      } finally {
        if (leaseTimer) clearTimeout(leaseTimer);
      }
      const action = resolveOutcome(result);
      try {
        if (action.action === "complete") {
          if (!(await completeJob(sql, job)))
            jobLog.warn("job_lease_lost", { stage: "complete" });
          else jobLog.debug("job_done", { attempts: job.attempts });
          return;
        }
        const state = await failJob(sql, job, action);
        const attrs = { code: action.code, attempts: job.attempts, state };
        if (state === "lost") jobLog.warn("job_lease_lost", { stage: "fail" });
        else if (state === "dead") {
          jobLog.error("job_dead", attrs);
          o.onDead?.(job, action.code);
        } else jobLog.info("job_failed", attrs);
        if (!result.ok && state !== "lost")
          jobLog.warn("job_handler_error", { code: action.code }, result.error);
      } catch (error) {
        // The lease expires and the job is reclaimed on a later drain.
        jobLog.error("job_state_write_failed", {}, error);
      }
    })();
    active.set(job.id, { kind: job.kind, promise, abort });
    void promise.finally(() => active.delete(job.id));
  }

  async function drainOnce(
    tenantId: string,
  ): Promise<{ claimed: number; saturated: boolean }> {
    let claimed = 0,
      saturated = false;
    for (const [kind, entry] of getHandlers()) {
      if (stopping) break;
      const free = Math.min(
        limit - active.size,
        entry.concurrency - perKind(kind),
      );
      if (free <= 0) {
        saturated = true;
        continue;
      }
      const jobs = await tenant(sql, tenantId, (tx) =>
        claimJobs(tx, [kind], free, entry.leaseSeconds),
      );
      claimed += jobs.length;
      if (jobs.length === free) saturated = true;
      for (const job of jobs) execute(job, entry);
    }
    return { claimed, saturated };
  }

  function drainTenant(tenantId: string): Promise<number> {
    const current = draining.get(tenantId);
    if (current) return current;
    const run = (async () => {
      let total = 0;
      // Keep going while slots were the limit (a backlog after a restart);
      // stop as soon as a pass finds nothing more to claim.
      for (let i = 0; i < 100 && !stopping; i++) {
        const { claimed, saturated } = await drainOnce(tenantId);
        total += claimed;
        if (!saturated) break;
        if (active.size > 0)
          await Promise.race([...active.values()].map((a) => a.promise));
      }
      return total;
    })().finally(() => draining.delete(tenantId));
    draining.set(tenantId, run);
    return run;
  }

  function schedule(tenantId: string, ms: number) {
    if (stopping || scheduled.has(tenantId)) return;
    const timer = setTimeout(() => {
      scheduled.delete(tenantId);
      drainTenant(tenantId).catch((error) =>
        log.warn("jobs_drain_failed", { tenantId }, error),
      );
    }, ms);
    timer.unref();
    scheduled.set(tenantId, timer);
  }

  function sweep() {
    const cutoff = Date.now() - activeForMs;
    for (const [tenantId, at] of seen) {
      if (at < cutoff) seen.delete(tenantId);
      else schedule(tenantId, 0);
    }
  }

  return {
    start() {
      stopping = false;
      sweepTimer = setInterval(sweep, sweepMs);
      sweepTimer.unref();
    },
    noteTenant(tenantId, activity = "write") {
      if (stopping || getHandlers().size === 0) return;
      if (activity === "read" && seen.has(tenantId)) return;
      seen.delete(tenantId);
      seen.set(tenantId, Date.now());
      // Bound memory: forget the least recently active tenant.
      if (seen.size > maxTenants) seen.delete(seen.keys().next().value!);
      schedule(tenantId, debounceMs);
    },
    drainTenant,
    async stop(timeoutMs) {
      stopping = true;
      if (sweepTimer) clearInterval(sweepTimer);
      for (const timer of scheduled.values()) clearTimeout(timer);
      scheduled.clear();
      // One deadline for both waits: a drain blocked on a hung handler
      // (drainTenant awaits a running job) must not hold stop() past it.
      const deadline = Date.now() + Math.max(0, timeoutMs);
      const expired = () =>
        new Promise<true>((r) =>
          setTimeout(() => r(true), Math.max(0, deadline - Date.now())).unref(),
        );
      let timedOut = await Promise.race([
        Promise.allSettled([...draining.values()]).then(() => false as const),
        expired(),
      ]);
      if (!timedOut)
        timedOut = await Promise.race([
          Promise.allSettled([...active.values()].map((a) => a.promise)).then(
            () => false as const,
          ),
          expired(),
        ]);
      if (timedOut) {
        log.warn("jobs_stop_aborting", { running: active.size });
        for (const a of active.values()) a.abort.abort(new Error("shutdown"));
        await Promise.race([
          Promise.allSettled([
            ...[...active.values()].map((a) => a.promise),
            ...draining.values(),
          ]),
          new Promise((r) => setTimeout(r, 1000).unref()),
        ]);
      }
    },
    running: () => active.size,
  };
}
