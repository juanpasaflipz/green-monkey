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
 *
 * Worker mode: with `discover`, the sweep asks the database which tenants have
 * claimable jobs of the registered kinds (an area SELECT policy TO
 * gm_jobs_worker), every sweepMs and once at start, instead of revisiting
 * recently active tenants. The worker uses this mode; the web does not.
 *
 * This module registers no handler: the web entry imports
 * server/jobs/handlers/index.ts, the worker registers its kinds in
 * server/jobs/worker-registry.ts (import-graph test).
 *
 * Limits (PLATFORM-OPS-1, OPS-5): `concurrency` (global) and each kind's
 * concurrency count running handlers plus the slots a drain has reserved for
 * a claim it is awaiting, so concurrent drains of different tenants never
 * claim the same free slots. A handler whose lease is about to expire is
 * aborted and stops counting (job_lease_expired), and a drain that waits for
 * a slot gives up after sweepMs, so one hung handler never stalls a tenant.
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
  expireLostJobs,
  extendLease,
  failJob,
  jobErrorCode,
} from "./queue.js";

/** Longest wait between a poke and its discovery (pokes inside the window coalesce). */
export const POKE_COALESCE_MS = 250;

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
   * Worker mode: run discovery (and claim what it finds) now instead of at the next sweep.
   * Coalesced: any number of pokes within POKE_COALESCE_MS cause one discovery, and a poke
   * that arrives while a discovery runs causes exactly one more after it. A no-op without
   * `discover` (the web runner drains on its own writes) and while stopping. The worker's
   * private POST /wake calls it (payments spec §4.7: tap-to-terminal latency).
   */
  poke(): void;
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
    /** Worker mode: polled once at start and then every sweepMs; each tenant it returns is
     *  noted (drained). When set, the sweep does not revisit recently active tenants. */
    discover?: () => Promise<string[]>;
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
  // Slots reserved by drains awaiting a claim, in total and per kind: counted
  // with `active` so concurrent drains never claim the same free slots.
  let reserved = 0;
  const reservedByKind = new Map<string, number>();
  // When each (tenant, kind) last ran expireLostJobs (PLAT-HR-7), bounded like `seen`.
  const lastExpiry = new Map<string, number>();
  const expiryDue = (tenantId: string, kind: string) => {
    const key = `${tenantId}\u0000${kind}`;
    const now = Date.now();
    const last = lastExpiry.get(key);
    if (last !== undefined && now - last < sweepMs) return false;
    lastExpiry.delete(key);
    lastExpiry.set(key, now);
    if (lastExpiry.size > maxTenants * Math.max(1, getHandlers().size))
      lastExpiry.delete(lastExpiry.keys().next().value!);
    return true;
  };
  let stopping = false;
  let sweepTimer: NodeJS.Timeout | null = null;

  const perKind = (kind: string) =>
    [...active.values()].filter((a) => a.kind === kind).length +
    (reservedByKind.get(kind) ?? 0);
  const reserve = (kind: string, n: number) => {
    reserved += n;
    reservedByKind.set(kind, (reservedByKind.get(kind) ?? 0) + n);
  };

  /** The kind's onDead hook, after the dead write (server/jobs.ts JobDeadHook). */
  async function deadHook(
    job: ClaimedJob,
    entry: RegisteredHandler,
    code: string,
    jobLog: Logger,
  ) {
    if (!entry.onDead) return;
    try {
      await entry.onDead({
        job,
        code,
        log: jobLog,
        tenant: (fn) => tenant(sql, job.tenantId, fn),
      });
    } catch (error) {
      jobLog.error("job_dead_hook_failed", { code }, error);
    }
  }

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
      // rejected anyway once another runner reclaims the job. The job stops
      // counting against the limits now: a handler that ignores the signal (a
      // provider call without it, a nested ctx.tenant() on an exhausted pool)
      // must not hold its slot, or its tenant's drain, forever (PLATFORM-OPS-5).
      leaseTimer = setTimeout(
        () => {
          abort.abort(new Error("job_lease_expired"));
          if (active.get(job.id)?.abort === abort) {
            active.delete(job.id);
            jobLog.warn("job_lease_expired", { attempts: job.attempts });
          }
        },
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
              const lost = () =>
                Object.assign(new Error("job_lease_lost"), {
                  code: "job_lease_lost",
                });
              // Once aborted (lease timer, lost lease, stop) the run no longer
              // counts against the limits; a late heartbeat must not renew a
              // lease the database still honours for ~2 s, or the runner could
              // claim another job of this kind beside it (PLAT-HR-4). No SQL.
              if (abort.signal.aborted) throw lost();
              // Throws before any SQL outside 10..MAX_LEASE_SECONDS (PLATFORM-OPS-6).
              const lease = await extendLease(sql, job, seconds);
              if (!lease) {
                abort.abort(new Error("job_lease_lost"));
                throw lost();
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
        const state = await failJob(sql, job, {
          ...action,
          maxAttempts: entry.maxAttempts,
        });
        const attrs = { code: action.code, attempts: job.attempts, state };
        if (state === "lost") jobLog.warn("job_lease_lost", { stage: "fail" });
        else if (state === "dead") {
          jobLog.error("job_dead", attrs);
          o.onDead?.(job, action.code);
          await deadHook(job, entry, action.code, jobLog);
        } else jobLog.info("job_failed", attrs);
        if (!result.ok && state !== "lost")
          jobLog.warn("job_handler_error", { code: action.code }, result.error);
      } catch (error) {
        // The lease expires and the job is reclaimed on a later drain.
        jobLog.error("job_state_write_failed", {}, error);
      }
    })();
    active.set(job.id, { kind: job.kind, promise, abort });
    void promise.finally(() => {
      // Only this run's entry: after a lease expiry the id may belong to a
      // later claim of the same job.
      if (active.get(job.id)?.abort === abort) active.delete(job.id);
    });
  }

  async function drainOnce(
    tenantId: string,
  ): Promise<{ claimed: number; saturated: boolean }> {
    let claimed = 0,
      saturated = false;
    for (const [kind, entry] of getHandlers()) {
      if (stopping) break;
      const free = Math.min(
        limit - active.size - reserved,
        entry.concurrency - perKind(kind),
      );
      if (free <= 0) {
        saturated = true;
        continue;
      }
      // Reserve before the await: another tenant's drain computing its free
      // slots meanwhile must see these (PLATFORM-OPS-1).
      reserve(kind, free);
      // Lost jobs come only from dead processes, and the expiry statement has no
      // supporting index yet (RUNBOOK "Open follow-ups", OPS-10): run it at most
      // once per sweepMs per tenant and kind, so a write-triggered drain costs one
      // statement, not two (PLAT-HR-7). The claim itself still reclaims a lost job
      // that has attempts left.
      const expire = expiryDue(tenantId, kind);
      let jobs: ClaimedJob[];
      let expired: ClaimedJob[];
      try {
        ({ jobs, expired } = await tenant(sql, tenantId, async (tx) => ({
          expired: expire
            ? await expireLostJobs(tx, kind, entry.maxAttempts)
            : [],
          jobs: await claimJobs(
            tx,
            [kind],
            free,
            entry.leaseSeconds,
            entry.maxAttempts,
          ),
        })));
      } finally {
        reserve(kind, -free);
      }
      // Synchronously after the release: the claimed jobs take the slots.
      for (const job of jobs) execute(job, entry);
      claimed += jobs.length;
      if (jobs.length === free) saturated = true;
      for (const job of expired) {
        const jobLog = log.child({
          jobId: job.id,
          kind: job.kind,
          tenantId: job.tenantId,
        });
        jobLog.error("job_dead", {
          code: "lease_expired",
          attempts: job.attempts,
          state: "dead",
        });
        o.onDead?.(job, "lease_expired");
        await deadHook(job, entry, "lease_expired", jobLog);
      }
    }
    return { claimed, saturated };
  }

  /** Resolves when a running job settles or after ms, whichever comes first. */
  function slotOrTimeout(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      ...[...active.values()].map((a) => a.promise),
      new Promise<void>((r) => {
        timer = setTimeout(r, ms);
        timer.unref();
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function drainTenant(tenantId: string): Promise<number> {
    const current = draining.get(tenantId);
    if (current) return current;
    const run = (async () => {
      let total = 0;
      // Keep going while slots were the limit (a backlog after a restart);
      // stop as soon as a pass finds nothing more to claim. Each wait for a
      // slot is bounded by sweepMs (PLATFORM-OPS-5): the next sweep or
      // discovery picks the tenant up again anyway.
      for (let i = 0; i < 100 && !stopping; i++) {
        const { claimed, saturated } = await drainOnce(tenantId);
        total += claimed;
        if (!saturated) break;
        // Nothing of ours running: the slots are other drains' reservations,
        // which turn into running jobs (or free up) within one claim.
        await slotOrTimeout(
          active.size ? sweepMs : Math.min(sweepMs, debounceMs),
        );
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

  function noteTenant(tenantId: string, activity: "write" | "read" = "write") {
    if (stopping || getHandlers().size === 0) return;
    if (activity === "read" && seen.has(tenantId)) return;
    seen.delete(tenantId);
    seen.set(tenantId, Date.now());
    // Bound memory: forget the least recently active tenant.
    if (seen.size > maxTenants) seen.delete(seen.keys().next().value!);
    schedule(tenantId, debounceMs);
  }

  let discovering = false;
  let pokeTimer: NodeJS.Timeout | null = null;
  let pokeAgain = false;
  function sweep() {
    if (o.discover) {
      if (discovering || stopping) return;
      discovering = true;
      o.discover()
        .then((ids) => {
          for (const id of ids) noteTenant(id);
        })
        .catch((error) => log.warn("jobs_discover_failed", {}, error))
        .finally(() => {
          discovering = false;
          if (pokeAgain) {
            pokeAgain = false;
            poke();
          }
        });
      return;
    }
    const cutoff = Date.now() - activeForMs;
    for (const [tenantId, at] of seen) {
      if (at < cutoff) seen.delete(tenantId);
      else schedule(tenantId, 0);
    }
  }

  function poke() {
    if (!o.discover || stopping || pokeTimer) return;
    pokeTimer = setTimeout(
      () => {
        pokeTimer = null;
        if (discovering) pokeAgain = true;
        else sweep();
      },
      Math.min(debounceMs, POKE_COALESCE_MS),
    );
    pokeTimer.unref();
  }

  return {
    poke,
    start() {
      stopping = false;
      sweepTimer = setInterval(sweep, sweepMs);
      sweepTimer.unref();
      // Discovery runs even with zero handlers, so the worker's jobs loop
      // keeps ticking.
      if (o.discover) sweep();
    },
    noteTenant,
    drainTenant,
    async stop(timeoutMs) {
      stopping = true;
      if (sweepTimer) clearInterval(sweepTimer);
      if (pokeTimer) clearTimeout(pokeTimer);
      pokeTimer = null;
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
