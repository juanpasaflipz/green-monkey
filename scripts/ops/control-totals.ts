import type postgres from "postgres";

/**
 * Financial, stock and evidence control totals. Computed by the backup inside
 * the exported snapshot and recomputed after a restore; any difference fails
 * the rehearsal (DB-2/OPS-5). Amounts are integer centavos as text.
 */
export async function controlTotals(sql: postgres.Sql | postgres.ReservedSql) {
  const [row] = await sql`
    select
      (select count(*) from orders)::text as orders,
      (select coalesce(sum(total),0) from orders)::text as order_total,
      (select count(*) from tenders)::text as tenders,
      (select coalesce(sum(amount),0) from tenders)::text as tender_amount,
      (select count(*) from refunds)::text as refunds,
      (select coalesce(sum(amount),0) from refunds)::text as refund_amount,
      (select count(*) from tender_allocations)::text as allocations,
      (select coalesce(sum(amount),0) from tender_allocations)::text as allocation_amount,
      (select count(*) from stock_movements)::text as stock_movements,
      (select coalesce(sum(quantity),0) from stock_movements)::text as stock_quantity,
      (select count(*) from cash_sessions)::text as cash_sessions,
      (select count(*) from line_voids)::text as line_voids,
      (select count(*) from offline_recoveries)::text as offline_recoveries,
      (select count(*) from audit)::text as audit,
      (select count(*) from restaurants)::text as restaurants,
      (select array_agg(name order by name) from schema_migrations) as migrations`;
  return {
    ...row,
    migrations: (row.migrations ?? []) as string[],
  } as Record<string, string> & { migrations: string[] };
}

/** Schema fingerprint: restored databases must match the source exactly. */
export async function schemaFingerprint(
  sql: postgres.Sql | postgres.ReservedSql,
) {
  const [row] = await sql`
    select
      (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p')) as tables,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p')
          and c.relrowsecurity and c.relforcerowsecurity) as forced_rls_tables,
      (select count(*)::int from pg_policies where schemaname='public') as policies,
      (select count(*)::int from pg_trigger t join pg_class c on c.oid=t.tgrelid
        join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and not t.tgisinternal) as triggers,
      (select count(*)::int from pg_indexes where schemaname='public') as indexes`;
  return { ...row } as {
    tables: number;
    forced_rls_tables: number;
    policies: number;
    triggers: number;
    indexes: number;
  };
}
