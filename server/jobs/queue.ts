/**
 * Jobs outbox (DB-8 / OPS-15). Business code enqueues inside its own tenant
 * transaction; the worker claims with a lease token that fences every later
 * write, so a handler whose lease expired can never complete or fail a job
 * another claimer now owns.
 */
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { Tx } from "../db.js";
import { permit, managers } from "../auth.js";
import { DomainError, type Session } from "../../shared/domain.js";

export type JobState =
  | "queued"
  | "available"
  | "running"
  | "completed"
  | "blocked"
  | "dead";

export interface ClaimedJob {
  tenantId: string;
  id: string;
  kind: string;
  dedupeKey: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  leaseToken: string;
  createdAt: Date;
}

const KIND = /^[a-z][a-z0-9_]{1,63}$/;
const CODE = /^[a-z][a-z0-9_]{1,63}$/;

/** Machine-readable error code safe to store; anything else becomes handler_error. */
export function jobErrorCode(value: unknown): string {
  return typeof value === "string" && CODE.test(value) ? value : "handler_error";
}

/**
 * Inserts a job in the caller's transaction. A repeated (kind, dedupeKey) for
 * the tenant returns the existing job instead of a duplicate.
 */
export async function enqueueJob(
  tx: Tx,
  tenantId: string,
  job: {
    kind: string;
    dedupeKey: string;
    payload: postgres.JSONValue;
    runAt?: Date;
    maxAttempts?: number;
    state?: "available" | "blocked";
  },
): Promise<{ id: string; created: boolean }> {
  if (!KIND.test(job.kind)) throw new DomainError("invalid_job_kind", 400);
  if (!job.dedupeKey || job.dedupeKey.length > 200)
    throw new DomainError("invalid_job_dedupe_key", 400);
  const maxAttempts = job.maxAttempts ?? 8;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 50)
    throw new DomainError("invalid_job_attempts", 400);
  const id = randomUUID();
  const [inserted] = await tx`
    insert into jobs(tenant_id,id,kind,dedupe_key,payload,state,next_at,max_attempts)
    values(${tenantId},${id},${job.kind},${job.dedupeKey},${tx.json(job.payload)},
           ${job.state ?? "available"},${job.runAt ?? new Date()},${maxAttempts})
    on conflict (tenant_id,kind,dedupe_key) do nothing
    returning id`;
  if (inserted) return { id: inserted.id, created: true };
  const [existing] = await tx`
    select id from jobs where tenant_id=${tenantId} and kind=${job.kind} and dedupe_key=${job.dedupeKey}`;
  return { id: existing.id, created: false };
}

/**
 * Staff "retry" for a dead or blocked job (owners and managers). The database
 * trigger jobs_guard allows the runtime role exactly these transitions.
 */
export async function requeueJob(tx: Tx, s: Session, jobId: string) {
  permit(s, managers);
  const [job] = await tx`select state from jobs where id=${jobId} for update`;
  if (!job) throw new DomainError("not_found", 404);
  if (job.state !== "dead" && job.state !== "blocked")
    throw new DomainError("job_not_requeueable", 409);
  await tx`update jobs set state='available', attempts=0, next_at=now(), error_code=null where id=${jobId}`;
}

/** Leases up to n runnable jobs of the given kinds (worker role only). */
export async function claimJobs(
  sql: postgres.Sql,
  kinds: string[],
  n: number,
  leaseSeconds: number,
): Promise<ClaimedJob[]> {
  if (!kinds.length || n <= 0) return [];
  const rows = await sql`
    with c as (
      select tenant_id, id from jobs
      where kind = any(${kinds}::text[]) and (
            (state in ('available','queued') and next_at <= now())
         or (state = 'running' and lease_until < now()))
      order by next_at, id
      for update skip locked
      limit ${n})
    update jobs j set state='running', lease_token=gen_random_uuid(),
      lease_until=now() + make_interval(secs => ${leaseSeconds}),
      attempts=j.attempts+1, last_attempt_at=now()
    from c where j.tenant_id=c.tenant_id and j.id=c.id
    returning j.tenant_id, j.id, j.kind, j.dedupe_key, j.payload, j.attempts,
      j.max_attempts, j.lease_token, j.created_at`;
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    id: r.id,
    kind: r.kind,
    dedupeKey: r.dedupe_key,
    payload: r.payload,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    leaseToken: r.lease_token,
    createdAt: r.created_at,
  }));
}

/** Marks a job completed; false when the lease was lost. */
export async function completeJob(
  sql: postgres.Sql,
  job: ClaimedJob,
): Promise<boolean> {
  const result = await sql`
    update jobs set state='completed', completed_at=now(), lease_token=null, lease_until=null, error_code=null
    where tenant_id=${job.tenantId} and id=${job.id} and lease_token=${job.leaseToken} and state='running'`;
  return result.count === 1;
}

/** min(30 s · 2^(attempts-1), 1 h) with ±20% jitter. */
export function backoffMs(attempts: number, rand: () => number = Math.random) {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
  return Math.round(base * (0.8 + 0.4 * rand()));
}

/** Outcome of a failure for a job after `attempts` tries out of `maxAttempts`. */
export function failureState(
  job: Pick<ClaimedJob, "attempts" | "maxAttempts">,
  outcome: { dead?: boolean; blocked?: boolean },
): "retry" | "dead" | "blocked" {
  if (outcome.blocked) return "blocked";
  if (outcome.dead || job.attempts >= job.maxAttempts) return "dead";
  return "retry";
}

/** Records a failure, fenced by the lease token. "lost" when the lease moved on. */
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
  const state = failureState(job, outcome);
  const code = jobErrorCode(outcome.code);
  const result =
    state === "retry"
      ? await sql`
          update jobs set state='available',
            next_at=now() + make_interval(secs => ${(outcome.retryAfterMs ?? backoffMs(job.attempts)) / 1000}),
            lease_token=null, lease_until=null, error_code=${code}
          where tenant_id=${job.tenantId} and id=${job.id} and lease_token=${job.leaseToken} and state='running'`
      : await sql`
          update jobs set state=${state}, lease_token=null, lease_until=null, error_code=${code}
          where tenant_id=${job.tenantId} and id=${job.id} and lease_token=${job.leaseToken} and state='running'`;
  return result.count === 1 ? state : "lost";
}

/** Extends a held lease; false when it was already lost. */
export async function extendLease(
  sql: postgres.Sql,
  job: ClaimedJob,
  seconds: number,
): Promise<boolean> {
  const result = await sql`
    update jobs set lease_until=now() + make_interval(secs => ${seconds})
    where tenant_id=${job.tenantId} and id=${job.id} and lease_token=${job.leaseToken} and state='running'`;
  return result.count === 1;
}
