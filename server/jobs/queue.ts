/**
 * Lease-fenced queue operations, run by the runtime role inside a tenant
 * transaction (RLS scopes every statement to that tenant). The exact text of
 * lease_until returned by the claim is the fencing token: once a lease expires
 * and another runner reclaims the job, the old holder's writes match no row.
 * The token is bound as text and parsed by the server, because postgres.js
 * would round a timestamptz parameter to milliseconds.
 */
import type postgres from "postgres";
import { tenant, type Tx } from "../db.js";
import { permit, managers } from "../auth.js";
import { MAX_ATTEMPTS, type ClaimedJob } from "../jobs.js";
import { DomainError, type Session } from "../../shared/domain.js";

const CODE = /^[a-z][a-z0-9_]{1,63}$/;

/** Machine-readable error code safe to store; anything else becomes handler_error. */
export function jobErrorCode(value: unknown): string {
  return typeof value === "string" && CODE.test(value)
    ? value
    : "handler_error";
}

/** min(30 s · 2^(attempts-1), 1 h) with ±20% jitter. */
export function backoffMs(attempts: number, rand: () => number = Math.random) {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
  return Math.round(base * (0.8 + 0.4 * rand()));
}

/** Outcome of a failure after `attempts` tries. */
export function failureState(
  attempts: number,
  outcome: { dead?: boolean; blocked?: boolean },
): "retry" | "dead" | "blocked" {
  if (outcome.blocked) return "blocked";
  if (outcome.dead || attempts >= MAX_ATTEMPTS) return "dead";
  return "retry";
}

/** Leases up to n runnable jobs of the given kinds for the transaction's tenant. */
export async function claimJobs(
  tx: Tx,
  kinds: string[],
  n: number,
  leaseSeconds: number,
): Promise<ClaimedJob[]> {
  if (!kinds.length || n <= 0) return [];
  const rows = await tx`
    with c as (
      select tenant_id, id from jobs
      where kind = any(${kinds}::text[]) and (
            (state in ('queued','available') and next_at <= now())
         or (state = 'running' and lease_until < now()))
      order by next_at, id
      for update skip locked
      limit ${n})
    update jobs j set state='running',
      lease_until=clock_timestamp() + make_interval(secs => ${leaseSeconds}::double precision),
      attempts=j.attempts+1
    from c where j.tenant_id=c.tenant_id and j.id=c.id
    returning j.tenant_id, j.id, j.kind, j.dedupe_key, j.payload, j.attempts,
      j.lease_until::text as lease, j.created_at`;
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    id: r.id,
    kind: r.kind,
    dedupeKey: r.dedupe_key,
    payload: r.payload,
    attempts: r.attempts,
    lease: r.lease,
    createdAt: r.created_at,
  }));
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
    where id=${job.id} and state='running' and lease_until=${job.lease}::text::timestamptz`,
  );
  return result.count === 1;
}

/** Records a failure, fenced by the lease. "lost" when the lease moved on. */
export async function failJob(
  sql: postgres.Sql,
  job: ClaimedJob,
  outcome: {
    code: string;
    retryAfterMs?: number;
    dead?: boolean;
    blocked?: boolean;
  },
): Promise<"retry" | "dead" | "blocked" | "lost"> {
  const state = failureState(job.attempts, outcome);
  const code = jobErrorCode(outcome.code);
  const waitSeconds = (outcome.retryAfterMs ?? backoffMs(job.attempts)) / 1000;
  const result = await tenant(sql, job.tenantId, (tx) =>
    state === "retry"
      ? tx`
          update jobs set state='available', lease_until=null, error_code=${code},
            next_at=now() + make_interval(secs => ${waitSeconds}::double precision)
          where id=${job.id} and state='running' and lease_until=${job.lease}::text::timestamptz`
      : tx`
          update jobs set state=${state}, lease_until=null, error_code=${code}
          where id=${job.id} and state='running' and lease_until=${job.lease}::text::timestamptz`,
  );
  return result.count === 1 ? state : "lost";
}

/** Extends a held lease and returns the new fencing token, or null when lost. */
export async function extendLease(
  sql: postgres.Sql,
  job: ClaimedJob,
  seconds: number,
): Promise<string | null> {
  const [row] = await tenant(
    sql,
    job.tenantId,
    (tx) => tx`
    update jobs set lease_until=clock_timestamp() + make_interval(secs => ${seconds}::double precision)
    where id=${job.id} and state='running' and lease_until=${job.lease}::text::timestamptz
    returning lease_until::text as lease`,
  );
  return row?.lease ?? null;
}

/**
 * Staff "retry" for a dead job (owners and managers). Blocked jobs are left
 * alone: they wait for a device, not for a retry.
 */
export async function requeueJob(tx: Tx, s: Session, jobId: string) {
  permit(s, managers);
  const [job] = await tx`select state from jobs where id=${jobId} for update`;
  if (!job) throw new DomainError("not_found", 404);
  if (job.state !== "dead") throw new DomainError("job_not_requeueable", 409);
  await tx`update jobs set state='available', attempts=0, next_at=now(), error_code=null where id=${jobId}`;
}
