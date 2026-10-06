import postgres from "postgres";
import { DomainError } from "../shared/domain.js";
import { log } from "./logging.js";
import {
  isTransientDbError,
  poolOptions,
  retryBackoffMs,
  statementTimeoutMs,
  withoutParams,
} from "./db-support.js";
import { PRIVILEGED_MEMBERSHIPS } from "./roles.js";
// postgres 3.4.8 omits the tagged-template signature from TransactionSql.
export interface Tx extends postgres.TransactionSql {
  <T extends readonly object[] = postgres.Row[]>(
    template: TemplateStringsArray,
    ...parameters: any[]
  ): postgres.PendingQuery<T>;
}
/**
 * Runtime pool. TLS is verified for every non-loopback host and URL query
 * parameters (sslmode, channel_binding, ...) are dropped (OPS-14). The pool
 * size comes from DB_POOL_MAX (default 20). statement_timeout is set per
 * tenant transaction below and as a role default by provisioning, because
 * Neon's pooler drops startup parameters (OPS-7).
 */
export function connect(url: string) {
  const parsed = new URL(url);
  if (process.env.PG_APP_USER && parsed.username !== process.env.PG_APP_USER)
    throw Error("PG_APP_USER must match DATABASE_URL; no fallback");
  return postgres(
    withoutParams(parsed).href,
    poolOptions(parsed, { applicationName: "gm-web" }),
  );
}
/** Milliseconds, as text, for set_config('statement_timeout') in tenant(). */
const STATEMENT_TIMEOUT = statementTimeoutMs(
  process.env.DB_STATEMENT_TIMEOUT_MS,
);
/**
 * Startup retry (OPS-11): runs the role check until the database answers,
 * waiting out connectivity errors with capped exponential backoff instead of
 * crash-looping into Railway's restart limit. Misconfiguration (a privileged
 * role, bad credentials) still fails immediately.
 */
export async function waitForDatabase(
  sql: postgres.Sql,
  opts: {
    check?: (sql: postgres.Sql) => Promise<void>;
    sleep?: (ms: number) => Promise<unknown>;
    rand?: () => number;
  } = {},
): Promise<void> {
  const started = Date.now();
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      await (opts.check ?? checkRole)(sql);
      log.info("database_ready", {
        attempts: attempt + 1,
        ms: Date.now() - started,
      });
      return;
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (!isTransientDbError(error)) {
        log.error("database_fatal", { code }, error);
        throw error;
      }
      log.warn("database_waiting", { attempt: attempt + 1, code });
      await sleep(retryBackoffMs(attempt, opts.rand));
    }
  }
}
type LoginFacts = {
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  memberships: string[];
  owned: number;
};
/**
 * Attributes, privileged memberships (direct or inherited) and owned tables of the
 * connected login. Attributes are not inherited, but a member can SET ROLE to any role it
 * belongs to and use that role's SUPERUSER or BYPASSRLS, so the attribute flags cover every
 * role the login is a member of, and owned tables count those of any such role
 * (PLATFORM-ROLES-2).
 */
export async function loginFacts(
  sql: postgres.Sql,
): Promise<LoginFacts | undefined> {
  const [r] = await sql<LoginFacts[]>`
    with reach as (
      select * from pg_roles where pg_has_role(current_user, oid, 'member'))
    select bool_or(rolsuper) as rolsuper, bool_or(rolbypassrls) as rolbypassrls,
      bool_or(rolcreaterole) as rolcreaterole, bool_or(rolcreatedb) as rolcreatedb,
      coalesce((select array_agg(c order by c) from unnest(${PRIVILEGED_MEMBERSHIPS as string[]}::text[]) c
        where to_regrole(c) is not null and pg_has_role(current_user, to_regrole(c), 'member')), '{}') as memberships,
      (select count(*)::int from pg_tables where schemaname='public'
        and pg_has_role(current_user, tableowner, 'member')) as owned
    from reach having count(*) > 0`;
  return r;
}

/** The runtime login: no superuser, BYPASSRLS, CREATEROLE or CREATEDB, no capability or owner membership, owns nothing. */
export async function checkRole(sql: postgres.Sql) {
  const r = await loginFacts(sql);
  if (
    !r ||
    r.rolsuper ||
    r.rolbypassrls ||
    r.rolcreaterole ||
    r.rolcreatedb ||
    r.memberships.length
  )
    throw Error("Runtime role must not bypass RLS");
  if (r.owned) throw Error("Runtime role must not own application tables");
}

/** Jobs worker pool (WORKER_DATABASE_URL): connect()'s TLS and pool policy, without the PG_APP_USER check. */
export function connectWorker(url: string) {
  const parsed = new URL(url);
  return postgres(
    withoutParams(parsed).href,
    poolOptions(parsed, { applicationName: "gm-worker-jobs" }),
  );
}

/** The worker login: a gm_jobs_worker member and nothing more privileged. */
export async function checkWorkerRole(sql: postgres.Sql) {
  const r = await loginFacts(sql);
  const others = r?.memberships.filter((m) => m !== "gm_jobs_worker") ?? [];
  if (
    !r ||
    r.rolsuper ||
    r.rolbypassrls ||
    r.rolcreaterole ||
    r.rolcreatedb ||
    !r.memberships.includes("gm_jobs_worker") ||
    others.length
  )
    throw Error(
      "Worker role must be a gm_jobs_worker member without other privileges",
    );
  if (r.owned) throw Error("Worker role must not own application tables");
}
const RETRYABLE = new Set(["40P01", "40001"]);
let retryableFailures = 0;
/**
 * Test hook (PLATFORM-LOCKS-3): how many deadlocks (40P01) or serialization failures
 * (40001) tenant() has caught in this process, retried or not. LO-R9 makes any of them in
 * a DB suite a bug, so concurrency suites compare it before and after their burst
 * (tests/db-retries.ts); pg_stat_database.deadlocks lags behind (stats flush on idle).
 */
export function dbRetryCount(): number {
  return retryableFailures;
}
/**
 * Runs fn in one tenant-scoped transaction. A deadlock or serialization
 * failure rolls the whole transaction back and is retried once; a second one
 * becomes concurrent_update (409). fn must therefore be safe to replay: no
 * side effects outside the database transaction. Every such failure logs
 * db_retry {code, attempt, retried} at warn (RUNBOOK "Signals"): a retried
 * deadlock is a lock-order bug that only looks like a 1 s stall.
 */
export async function tenant<T>(
  sql: postgres.Sql,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!tenantId) throw new DomainError("missing_tenant", 403);
  for (let attempt = 1; ; attempt++) {
    try {
      return (await sql.begin(async (raw) => {
        const tx = raw as Tx;
        await tx`select set_config('app.tenant_id',${tenantId},true), set_config('statement_timeout',${STATEMENT_TIMEOUT},true)`;
        return fn(tx);
      })) as T;
    } catch (e) {
      // A statement timeout (57014) is not retryable: only 40P01/40001 are.
      const code = (e as { code?: string })?.code ?? "";
      if (!RETRYABLE.has(code)) throw e;
      retryableFailures++;
      log.warn("db_retry", { code, attempt, retried: attempt < 2 });
      if (attempt >= 2) throw new DomainError("concurrent_update", 409);
      await new Promise((r) =>
        setTimeout(r, 25 + Math.floor(Math.random() * 75)),
      );
    }
  }
}
