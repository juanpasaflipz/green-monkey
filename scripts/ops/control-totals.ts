import type postgres from "postgres";

// Domain records whose loss or mutation is not detectable from sales totals.
// Only hashes and counts enter the manifest, never member details or document bodies.
export const recoveryTables = [
  "fiscal_folio_counters",
  "fiscal_tickets",
  "fiscal_ticket_taxes",
  "fiscal_adjustments",
  "cfdi_documents",
  "cfdi_document_tickets",
  "cfdi_cancellations",
  "cfdi_files",
  "cfdi_events",
  "cfdi_global_periods",
  "loyalty_members",
  "loyalty_ledger",
  "loyalty_order_links",
  "loyalty_member_cards",
  "loyalty_referrals",
  "sales_history_batches",
  "sales_history_days",
  "sales_history_payments",
  "sales_history_products",
  "sales_history_coverage",
  "delivery_history_batches",
  "delivery_history_days",
  "delivery_history_coverage",
  "kiosk_checkouts",
] as const;

/**
 * Financial, stock and evidence control totals. Computed by the backup inside
 * the exported snapshot and recomputed after a restore; any difference fails
 * the rehearsal (DB-2/OPS-5). Amounts are integer centavos as text.
 */
export async function controlTotals(sql: postgres.Sql | postgres.ReservedSql) {
  // JSON timestamp serialization must agree across source and restored sessions.
  await sql`select set_config('TimeZone', 'UTC', true)`;
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
  const domains: Record<string, string> = {};
  for (const table of recoveryTables) {
    // Scheduled backups use main's tooling before production necessarily has
    // its newest migration. Record absence explicitly rather than breaking
    // backups or silently treating a missing table as an empty one.
    const [present] =
      await sql`select to_regclass(${`public.${table}`}) is not null as present`;
    if (!present.present) {
      domains[`${table}_count`] = "absent";
      domains[`${table}_digest`] = "absent";
      continue;
    }
    // The identifiers are a fixed source-controlled allowlist. Sorting row hashes
    // makes this independent of physical row order after pg_restore.
    const [fingerprint] = await sql.unsafe(`
      select count(*)::text as count,
        md5(coalesce(string_agg(row_hash, '' order by row_hash), '')) as digest
      from (select md5(to_jsonb(t)::text) as row_hash from public.${table} t) rows`);
    domains[`${table}_count`] = fingerprint.count;
    domains[`${table}_digest`] = fingerprint.digest;
  }
  return {
    ...row,
    migrations: (row.migrations ?? []) as string[],
    ...domains,
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
