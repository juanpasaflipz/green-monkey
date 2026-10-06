// Reports DB suites: removal of fixture tenants whose rows include append-only and immutable
// financial history. LD-12 pattern: the named triggers are switched off by the owner inside the
// one transaction that deletes the rows, so no other session ever sees them disabled and a failed
// cleanup rolls the switch back. LD-16 L5 order: fiscal tables, then discounts, then reports, then
// the wave-1 tables.
import type postgres from "postgres";

/** Delete order: children first (LD-16 L5). */
export const CLEANUP_TABLES = [
  // fiscal (027)
  "fiscal_adjustments",
  "fiscal_ticket_taxes",
  "fiscal_tickets",
  "fiscal_folio_counters",
  "restaurant_fiscal_profiles",
  // discounts (028)
  "refund_units",
  "refund_lines",
  "refunds",
  "refund_batches",
  "discount_allocations",
  "discounts",
  "cash_count_reviews",
  "money_controls",
  // reports (029)
  "report_prints",
  "business_day_settings",
  // wave 1
  "offline_kitchen_reviews",
  "offline_sync_records",
  "offline_archives",
  "line_voids",
  "tender_allocations",
  "offline_recovery_tasks",
  "offline_recoveries",
  "tenders",
  "rounds",
  "order_lines",
  "jobs",
  "operations",
  "audit",
  "orders",
  "order_numbers",
  "cash_movements",
  "cash_sessions",
  "stock_movements",
  "stock_items",
  "kitchen_feed_versions",
  "catalog",
  "menu_state",
  "menu_categories",
  "offline_lease_renewals",
  "offline_leases",
  "sessions",
  "devices",
  "employees",
  "restaurant_entitlements",
] as const;

/** Triggers that refuse DELETE (or TRUNCATE) even for the owner. */
export const IMMUTABILITY_TRIGGERS = [
  "fiscal_adjustments_immutable",
  "fiscal_ticket_taxes_immutable",
  "fiscal_tickets_immutable",
  "fiscal_folio_counters_guard",
  "refund_units_immutable",
  "refund_lines_no_delete",
  "refunds_immutable",
  "refund_batches_immutable",
  "discount_allocations_immutable",
  "discounts_no_delete",
  "cash_count_reviews_immutable",
  "cash_sessions_closed_immutable",
  "report_prints_immutable",
  "business_day_settings_immutable",
  "stock_movements_immutable",
] as const;

/** Deletes every row of the fixture tenants, their restaurants and organizations. */
export async function removeTenants(
  admin: postgres.Sql,
  tenants: readonly string[],
  organizations: readonly string[],
) {
  await admin.begin(async (tx) => {
    const triggers = await tx<{ table: string; trigger: string }[]>`
      select c.relname as table, t.tgname as trigger
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal and t.tgname = any (${[...IMMUTABILITY_TRIGGERS]}::text[])`;
    // Identifiers come from pg_catalog and the fixed lists above, never from input.
    for (const t of triggers)
      await tx.unsafe(`alter table ${t.table} disable trigger ${t.trigger}`);
    for (const table of CLEANUP_TABLES)
      for (const tenantId of tenants)
        await tx.unsafe(`delete from ${table} where tenant_id = $1`, [
          tenantId,
        ]);
    await tx`delete from restaurants where id = any (${[...tenants]}::uuid[])`;
    await tx`delete from organizations where id = any (${[...organizations]}::uuid[])`;
    for (const t of triggers)
      await tx.unsafe(`alter table ${t.table} enable trigger ${t.trigger}`);
  });
}
