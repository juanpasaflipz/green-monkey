/**
 * Lease-fenced queue operations, run by the runtime role (web) or the jobs
 * login (worker) inside a tenant transaction: RLS scopes every statement to
 * that tenant, and every claim and fenced write also names the tenant. The exact text of
 * lease_until returned by the claim is the fencing token: once a lease expires
 * and another runner reclaims the job, the old holder's writes match no row.
 * The token is bound as text and parsed by the server, because postgres.js
 * would round a timestamptz parameter to milliseconds.
 */
import type postgres from "postgres";
import { tenant, type Tx } from "../db.js";
import { permit, managers } from "../auth.js";
import {
  assertLeaseSeconds,
  hasDeadHook,
  MAX_ATTEMPTS,
  type ClaimedJob,
} from "../jobs.js";
import { DomainError, type Session } from "../../shared/domain.js";

const CODE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * error_code of a job whose kind has an onDead hook while a staff cancel waits for its runner
 * (cancelJob): the job is `running` with an expired lease, never claimed again, and the runner's
 * lease-expiry pass writes it dead (cancelled) together with the hook (P2-CONCURRENCY-6).
 * Reserved: a handler's own code never takes it (jobErrorCode).
 */
export const CANCEL_REQUESTED = "job_cancel_requested";

/** Machine-readable error code safe to store; anything else becomes handler_error. */
export function jobErrorCode(value: unknown): string {
  return typeof value === "string" &&
    CODE.test(value) &&
    value !== CANCEL_REQUESTED
    ? value
    : "handler_error";
}

/**
 * Runs in the transaction of a dead write, after it (the kind's onDead hook as the runner wraps
 * it, server/jobs.ts JobDeadHook). A throw rolls the dead write back with it.
 */
export type DeadWriteHook = (
  tx: Tx,
  job: ClaimedJob,
  code: string,
) => Promise<void>;

/** A job written dead by expireLostJobs, with the code it got (lease_expired or cancelled). */
export type ExpiredJob = ClaimedJob & { code: string };

/** min(30 s · 2^(attempts-1), 1 h) with ±20% jitter. */
export function backoffMs(attempts: number, rand: () => number = Math.random) {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
  return Math.round(base * (0.8 + 0.4 * rand()));
}

/** Outcome of a failure after `attempts` tries of a kind allowed `maxAttempts`. */
export function failureState(
  attempts: number,
  outcome: { dead?: boolean; blocked?: boolean },
  maxAttempts: number = MAX_ATTEMPTS,
): "retry" | "dead" | "blocked" {
  if (outcome.blocked) return "blocked";
  if (outcome.dead || attempts >= maxAttempts) return "dead";
  return "retry";
}

const toJob = (r: postgres.Row): ClaimedJob => ({
  tenantId: r.tenant_id,
  id: r.id,
  kind: r.kind,
  dedupeKey: r.dedupe_key,
  payload: r.payload,
  attempts: r.attempts,
  lease: r.lease ?? "",
  createdAt: r.created_at,
});

/**
 * Leases up to n runnable jobs of the given kinds for the transaction's tenant.
 * The explicit tenant predicate is defense in depth: RLS already limits a
 * FOR UPDATE claim to tenant_scope, but the claim must never depend on which
 * other (SELECT) policies exist on jobs, such as an area's worker discovery
 * policy.
 *
 * attempts counts claims. A running job whose lease expired is reclaimed only
 * while attempts < maxAttempts: a job that keeps killing its process (out of
 * memory, a synchronous loop) never gets past its kind's limit, because
 * expireLostJobs marks it dead first (PLATFORM-OPS-3).
 */
export async function claimJobs(
  tx: Tx,
  kinds: string[],
  n: number,
  leaseSeconds: number,
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<ClaimedJob[]> {
  if (!kinds.length || n <= 0) return [];
  const rows = await tx`
    with c as (
      select tenant_id, id from jobs
      where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and kind = any(${kinds}::text[])
        -- Claim predicate: discoverTenants (worker-registry.ts) uses this
        -- without the attempts bound (it must still find lost jobs to expire);
        -- change both together.
        and ((state in ('queued','available') and next_at <= now())
          or (state = 'running' and lease_until < now() and attempts < ${maxAttempts}
              and error_code is distinct from 'job_cancel_requested'))
      order by next_at, id
      for update skip locked
      limit ${n})
    update jobs j set state='running',
      lease_until=clock_timestamp() + make_interval(secs => ${leaseSeconds}::double precision),
      attempts=j.attempts+1
    from c where j.tenant_id=c.tenant_id and j.id=c.id
    returning j.tenant_id, j.id, j.kind, j.dedupe_key, j.payload, j.attempts,
      j.lease_until::text as lease, j.created_at`;
  return rows.map(toJob);
}

/**
 * Marks dead, with error_code lease_expired, the transaction tenant's running jobs of
 * one kind whose lease expired after their last allowed claim (attempts >=
 * maxAttempts): the holder died mid-job (crash, out of memory, SIGKILL after the drain
 * budget) on its final attempt. Returns them so the runner logs job_dead and alerts
 * jobs_dead_<kind>; a manager can requeue them after fixing the cause (PLATFORM-OPS-3).
 *
 * With `hook` (a kind with an onDead hook, P2-CONCURRENCY-6) it also takes the jobs a staff
 * cancel handed over (CANCEL_REQUESTED → cancelled), and writes each job dead in its own
 * savepoint together with the hook: a hook that throws rolls back that job's dead write only
 * (`failed` reports it), and the job stays running, lost, for the next pass. Rows another
 * transaction holds are skipped, never waited for.
 */
export async function expireLostJobs(
  tx: Tx,
  kind: string,
  maxAttempts: number,
  hook?: {
    run: DeadWriteHook;
    failed(jobId: string, error: unknown): void;
  },
): Promise<ExpiredJob[]> {
  if (!hook) {
    const rows = await tx`
    update jobs set state='dead', lease_until=null, error_code='lease_expired'
    where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and kind = ${kind} and state = 'running' and lease_until < now()
      and attempts >= ${maxAttempts}
    returning tenant_id, id, kind, dedupe_key, payload, attempts, null::text as lease, created_at`;
    return rows.map((r) => ({ ...toJob(r), code: "lease_expired" }));
  }
  const lost = await tx`
    select id from jobs
    where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and kind = ${kind} and state = 'running' and lease_until < now()
      and (attempts >= ${maxAttempts} or error_code = 'job_cancel_requested')
    order by lease_until, id
    for update skip locked`;
  const expired: ExpiredJob[] = [];
  for (const { id } of lost) {
    try {
      expired.push(
        await tx.savepoint(async (raw) => {
          const sp = raw as Tx;
          const [row] = await sp`
            update jobs set state='dead', lease_until=null,
              error_code = case when error_code = 'job_cancel_requested'
                then 'cancelled' else 'lease_expired' end
            where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
              and id = ${id}
            returning tenant_id, id, kind, dedupe_key, payload, attempts,
              null::text as lease, created_at, error_code`;
          const job: ExpiredJob = { ...toJob(row), code: row.error_code };
          await hook.run(sp, job, job.code);
          return job;
        }),
      );
    } catch (error) {
      hook.failed(id as string, error);
    }
  }
  return expired;
}

/** Marks a job done; false when the lease was lost. */
export async function completeJob(
  sql: postgres.Sql,
  job: ClaimedJob,
): Promise<boolean> {
  const result = await tenant(
    sql,
    job.tenantId,
    (tx) => tx`
    update jobs set state='done', lease_until=null, error_code=null
    where tenant_id=${job.tenantId} and id=${job.id} and state='running'
      and lease_until=${job.lease}::text::timestamptz`,
  );
  return result.count === 1;
}

/**
 * Records a failure, fenced by the lease. "lost" when the lease moved on. A dead write runs
 * `onDead` (the kind's hook) in its own transaction; when the hook throws, nothing is written
 * and the error propagates: the job keeps its lease, and the lease path takes it from there.
 */
export async function failJob(
  sql: postgres.Sql,
  job: ClaimedJob,
  outcome: {
    code: string;
    retryAfterMs?: number;
    dead?: boolean;
    blocked?: boolean;
    /** The kind's limit (RegisteredHandler.maxAttempts); default MAX_ATTEMPTS. */
    maxAttempts?: number;
    onDead?: DeadWriteHook;
  },
): Promise<"retry" | "dead" | "blocked" | "lost"> {
  const state = failureState(job.attempts, outcome, outcome.maxAttempts);
  const code = jobErrorCode(outcome.code);
  const waitSeconds = (outcome.retryAfterMs ?? backoffMs(job.attempts)) / 1000;
  const result = await tenant(sql, job.tenantId, async (tx) => {
    const written =
      state === "retry"
        ? await tx`
          update jobs set state='available', lease_until=null, error_code=${code},
            next_at=now() + make_interval(secs => ${waitSeconds}::double precision)
          where tenant_id=${job.tenantId} and id=${job.id} and state='running'
            and lease_until=${job.lease}::text::timestamptz`
        : await tx`
          update jobs set state=${state}, lease_until=null, error_code=${code}
          where tenant_id=${job.tenantId} and id=${job.id} and state='running'
            and lease_until=${job.lease}::text::timestamptz`;
    if (state === "dead" && written.count === 1 && outcome.onDead)
      await outcome.onDead(tx, job, code);
    return written;
  });
  return result.count === 1 ? state : "lost";
}

/** Extends a held lease and returns the new fencing token, or null when lost. */
export async function extendLease(
  sql: postgres.Sql,
  job: ClaimedJob,
  seconds: number,
): Promise<string | null> {
  assertLeaseSeconds(seconds);
  const [row] = await tenant(
    sql,
    job.tenantId,
    (tx) => tx`
    update jobs set lease_until=clock_timestamp() + make_interval(secs => ${seconds}::double precision)
    where tenant_id=${job.tenantId} and id=${job.id} and state='running'
      and lease_until=${job.lease}::text::timestamptz
    returning lease_until::text as lease`,
  );
  return row?.lease ?? null;
}

/** What a staff control changed, for its audit row (server/routes/ops.ts). */
export type JobControlResult = {
  kind: string;
  state: string;
  errorCode: string | null;
};

/**
 * Staff "retry" for a dead job (owners and managers). Blocked jobs are left
 * alone: they wait for a device, not for a retry. Returns the job's kind, state
 * and error code before the change.
 */
export async function requeueJob(
  tx: Tx,
  s: Session,
  jobId: string,
): Promise<JobControlResult> {
  permit(s, managers);
  const [job] =
    await tx`select kind, state, error_code from jobs where id=${jobId} for update`;
  if (!job) throw new DomainError("not_found", 404);
  if (job.state !== "dead") throw new DomainError("job_not_requeueable", 409);
  await tx`update jobs set state='available', attempts=0, next_at=now(), error_code=null where id=${jobId}`;
  return { kind: job.kind, state: job.state, errorCode: job.error_code };
}

/**
 * Staff "cancel" (owners and managers, PLATFORM-OPS-3): a queued, available or running job
 * goes dead with error_code cancelled, so it is never claimed again. A running holder loses
 * its lease (lease_until is cleared, so its fenced writes match no row) and stops at its
 * next lease check. Done and dead jobs are refused; requeueJob undoes a cancel. Blocked
 * jobs can be cancelled too (a receipt that will never print). Returns the job's kind,
 * state and error code before the change.
 *
 * A kind with an onDead hook (hasDeadHook) is never written dead here without its hook
 * (P2-CONCURRENCY-6), and the web may not run the worker's hooks (037 makes their writes
 * worker transitions). The cancel hands the job to its runner instead: `running`, lease
 * expired now (the holder is fenced out the same way), error_code CANCEL_REQUESTED. No claim
 * takes it again; the runner's next lease-expiry pass (seconds) writes it dead, cancelled,
 * with the hook in that transaction. A second cancel meanwhile is refused.
 */
export async function cancelJob(
  tx: Tx,
  s: Session,
  jobId: string,
): Promise<JobControlResult> {
  permit(s, managers);
  const [job] =
    await tx`select kind, state, error_code from jobs where id=${jobId} for update`;
  if (!job) throw new DomainError("not_found", 404);
  if (
    job.state === "done" ||
    job.state === "dead" ||
    job.error_code === CANCEL_REQUESTED
  )
    throw new DomainError("job_not_cancellable", 409);
  if (hasDeadHook(job.kind))
    await tx`update jobs set state='running', lease_until=now() - interval '1 second',
      error_code=${CANCEL_REQUESTED} where id=${jobId}`;
  else
    await tx`update jobs set state='dead', lease_until=null, error_code='cancelled' where id=${jobId}`;
  return { kind: job.kind, state: job.state, errorCode: job.error_code };
}
