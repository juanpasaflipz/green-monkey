/**
 * Worker-only job kinds (Wave 2.0 (c)). Handlers registered here run only in the worker
 * process, on the jobs login (WORKER_DATABASE_URL, a member of gm_jobs_worker), where the
 * provider keys live. Only modules imported between server/worker.ts's "worker areas:
 * imports" markers register here. The web never imports this module
 * (tests/import-graph.test.ts), so the web runner can never claim these kinds.
 */
import type postgres from "postgres";
import {
  handlers as webHandlers,
  jobRegistration,
  type JobHandler,
  type JobRegistrationOptions,
  type RegisteredHandler,
  WORKER_DEAD_HOOK_KINDS,
} from "../jobs.js";

const registry = new Map<string, RegisteredHandler>();

export function registerWorkerJobHandler(
  kind: string,
  handler: JobHandler,
  o: JobRegistrationOptions = {},
): void {
  const entry = jobRegistration(kind, handler, o);
  if (registry.has(kind))
    throw Error(`worker job handler already registered: ${kind}`);
  if (webHandlers().has(kind))
    throw Error(`job kind registered in both web and worker: ${kind}`);
  // The web's staff cancel decides by this list whether the dead write needs the hook.
  if (WORKER_DEAD_HOOK_KINDS.has(kind) !== Boolean(entry.onDead))
    throw Error(
      `worker job kind ${kind}: an onDead hook and WORKER_DEAD_HOOK_KINDS (server/jobs.ts) must agree`,
    );
  registry.set(kind, entry);
}

export function workerHandlers(): ReadonlyMap<string, RegisteredHandler> {
  return registry;
}

/** Test hook. */
export function clearWorkerJobHandlers(): void {
  registry.clear();
}

/**
 * Tenants with claimable jobs of the given kinds, oldest due first, at most `limit`.
 * Runs outside tenant(): rows are visible only through the owning area's SELECT policy
 * TO gm_jobs_worker (cfdi 030: jobs_worker_discover). The predicate is claimJobs' claim
 * predicate (server/jobs/queue.ts); change both together.
 */
export async function discoverTenants(
  sql: postgres.Sql,
  kinds: readonly string[],
  limit = 500,
): Promise<string[]> {
  if (!kinds.length) return [];
  const rows = await sql<{ tenant_id: string }[]>`
    select tenant_id from jobs
    where kind = any(${kinds as string[]}::text[])
      and ((state in ('queued','available') and next_at <= now())
        or (state = 'running' and lease_until < now()))
    group by tenant_id
    order by min(case when state = 'running' then lease_until else next_at end), tenant_id
    limit ${limit}`;
  return rows.map((r) => r.tenant_id);
}

/**
 * Milliseconds until the next job of these kinds becomes claimable (a queued job's next_at,
 * a running job's lease expiry), or null when none is waiting. Negative when one is already
 * due. Same rows and login as discoverTenants.
 */
export async function nextJobDueMs(
  sql: postgres.Sql,
  kinds: readonly string[],
): Promise<number | null> {
  if (!kinds.length) return null;
  const [row] = await sql<{ ms: string | null }[]>`
    select extract(epoch from min(case when state = 'running' then lease_until else next_at end) - now()) * 1000 as ms
    from jobs
    where kind = any(${kinds as string[]}::text[])
      and (state in ('queued','available') or (state = 'running' and lease_until is not null))`;
  return row?.ms == null ? null : Number(row.ms);
}
