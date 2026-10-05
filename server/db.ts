import postgres from "postgres";
import { DomainError } from "../shared/domain.js";
// postgres 3.4.8 omits the tagged-template signature from TransactionSql.
export interface Tx extends postgres.TransactionSql {
  <T extends readonly object[] = postgres.Row[]>(
    template: TemplateStringsArray,
    ...parameters: any[]
  ): postgres.PendingQuery<T>;
}
export function connect(url: string) {
  const parsed = new URL(url);
  if (process.env.PG_APP_USER && parsed.username !== process.env.PG_APP_USER)
    throw Error("PG_APP_USER must match DATABASE_URL; no fallback");
  return postgres(url, {
    max: 8,
    connect_timeout: 5,
    idle_timeout: 20,
    connection: { statement_timeout: 10000 },
  });
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
        await tx`select set_config('app.tenant_id',${tenantId},true)`;
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
