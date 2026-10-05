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
export async function checkRole(sql: postgres.Sql) {
  const [r] =
    await sql`select rolsuper,rolbypassrls,coalesce(pg_has_role(current_user,to_regrole('gm_billing_worker'),'member'),false) as billing from pg_roles where rolname=current_user`;
  if (r.rolsuper || r.rolbypassrls || r.billing)
    throw Error("Runtime role must not bypass RLS");
  const [owner] =
    await sql`select count(*)::int as count from pg_tables where schemaname='public' and tableowner=current_user`;
  if (owner.count) throw Error("Runtime role must not own application tables");
}
const RETRYABLE = new Set(["40P01", "40001"]);
/**
 * Runs fn in one tenant-scoped transaction. A deadlock or serialization
 * failure rolls the whole transaction back and is retried once; a second one
 * becomes concurrent_update (409). fn must therefore be safe to replay: no
 * side effects outside the database transaction.
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
      if (!RETRYABLE.has((e as { code?: string })?.code ?? "")) throw e;
      if (attempt >= 2) throw new DomainError("concurrent_update", 409);
      await new Promise((r) =>
        setTimeout(r, 25 + Math.floor(Math.random() * 75)),
      );
    }
  }
}
