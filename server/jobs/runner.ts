import type postgres from "postgres";
import { tenant } from "../db.js";
import { log as rootLog, type Logger } from "../log.js";
import {
  claimJobs,
  completeJob,
  extendLease,
  failJob,
  jobErrorCode,
  type ClaimedJob,
} from "./queue.js";
import {
  handlers as registeredHandlers,
  type JobOutcome,
  type RegisteredHandler,
} from "./registry.js";

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
  if (!outcome || outcome.status === "completed") return { action: "complete" };
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
  start(): void;
  /** Stops claiming, waits for running handlers, then aborts the rest. */
  drain(timeoutMs: number): Promise<void>;
  /** One claim/dispatch pass; resolves with the number of jobs claimed. */
  tick(): Promise<number>;
  lastTickAt(): number | null;
  running(): number;
}

export function createRunner(
  sql: postgres.Sql,
  o: {
    concurrency?: number;
    busyMs?: number;
    idleMs?: number;
    handlers?: () => ReadonlyMap<string, RegisteredHandler>;
    log?: Logger;
  } = {},
): JobRunner {
  const limit = o.concurrency ?? 4;
  const busyMs = o.busyMs ?? 1000;
  const idleMs = o.idleMs ?? 5000;
  const getHandlers = o.handlers ?? registeredHandlers;
  const log = o.log ?? rootLog.child({ loop: "jobs" });
  const active = new Map<
    string,
    { kind: string; promise: Promise<void>; abort: AbortController }
  >();
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let lastTick: number | null = null;
  let ticking: Promise<number> | null = null;

  const perKind = (kind: string) =>
    [...active.values()].filter((a) => a.kind === kind).length;

  async function execute(job: ClaimedJob, entry: RegisteredHandler) {
    const abort = new AbortController();
    const jobLog = log.child({ jobId: job.id, kind: job.kind, tenantId: job.tenantId });
    let leaseTimer: NodeJS.Timeout | null = null;
    const armLease = (seconds: number) => {
      if (leaseTimer) clearTimeout(leaseTimer);
      // Abort a little before the lease expires; the fenced writes below
      // would be rejected anyway once another claimer owns the job.
      leaseTimer = setTimeout(
        () => abort.abort(new Error("job_lease_expired")),
        Math.max(1000, seconds * 1000 - 2000),
      );
      leaseTimer.unref();
    };
    armLease(entry.leaseSeconds);
    const promise = (async () => {
      let result:
        | { ok: true; outcome: JobOutcome }
        | { ok: false; error: unknown };
      try {
        result = {
          ok: true,
          outcome: await entry.handler({
            job,
            signal: abort.signal,
            log: jobLog,
            tenant: (fn) => tenant(sql, job.tenantId, fn),
            extendLease: async (seconds) => {
              if (!(await extendLease(sql, job, seconds))) {
                abort.abort(new Error("job_lease_lost"));
                throw Object.assign(new Error("job_lease_lost"), {
                  code: "job_lease_lost",
                });
              }
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
          else jobLog.debug("job_completed", { attempts: job.attempts });
        } else {
          const state = await failJob(sql, job, action);
          const attrs = { code: action.code, attempts: job.attempts, state };
          if (state === "lost") jobLog.warn("job_lease_lost", { stage: "fail" });
          else if (state === "dead") jobLog.warn("job_dead", attrs);
          else jobLog.info("job_failed", attrs);
          if (!result.ok && state !== "lost")
            jobLog.warn("job_handler_error", { code: action.code }, result.error);
        }
      } catch (error) {
        // The lease expires and the job is reclaimed; nothing is lost.
        jobLog.error("job_state_write_failed", {}, error);
      }
    })();
    active.set(job.id, { kind: job.kind, promise, abort });
    promise.finally(() => active.delete(job.id));
  }

  async function pass(): Promise<number> {
    lastTick = Date.now();
    let claimed = 0;
    for (const [kind, entry] of getHandlers()) {
      if (stopping) break;
      const free = Math.min(limit - active.size, entry.concurrency - perKind(kind));
      if (free <= 0) continue;
      const jobs = await claimJobs(sql, [kind], free, entry.leaseSeconds);
      claimed += jobs.length;
      for (const job of jobs) await execute(job, entry);
    }
    return claimed;
  }

  async function tick(): Promise<number> {
    if (ticking) return ticking;
    ticking = pass().finally(() => {
      ticking = null;
    });
    return ticking;
  }

  function schedule(ms: number) {
    if (stopping) return;
    timer = setTimeout(async () => {
      let claimed = 0;
      try {
        claimed = await tick();
      } catch (error) {
        log.warn("jobs_claim_failed", {}, error);
      }
      // Keep draining a backlog quickly; poll every busyMs while handlers run
      // and every idleMs when there is nothing to do.
      schedule(claimed > 0 ? Math.min(100, busyMs) : active.size > 0 ? busyMs : idleMs);
    }, ms);
    timer.unref();
  }

  return {
    start() {
      stopping = false;
      schedule(0);
    },
    async drain(timeoutMs) {
      stopping = true;
      if (timer) clearTimeout(timer);
      await ticking?.catch(() => undefined);
      const settled = Promise.allSettled([...active.values()].map((a) => a.promise));
      const timedOut = await Promise.race([
        settled.then(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(true), Math.max(0, timeoutMs)).unref()),
      ]);
      if (timedOut) {
        log.warn("jobs_drain_aborting", { running: active.size });
        for (const a of active.values()) a.abort.abort(new Error("worker_shutdown"));
        // Leases expire and the jobs are reclaimed by the next worker.
        await Promise.race([settled, new Promise((r) => setTimeout(r, 1000).unref())]);
      }
    },
    tick,
    lastTickAt: () => lastTick,
    running: () => active.size,
  };
}
