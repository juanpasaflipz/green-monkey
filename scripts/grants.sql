DO $$ BEGIN
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO gm_app',current_database());
END $$;
GRANT USAGE ON SCHEMA public TO gm_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO gm_app;
GRANT INSERT,UPDATE ON employees,devices,sessions,catalog,dining_tables,order_numbers,orders,rounds,cash_sessions,stock_items,jobs TO gm_app;
GRANT INSERT ON order_lines,tenders,refunds,cash_movements,stock_movements,audit,operations,import_batches,source_mappings,expenses TO gm_app;

GRANT INSERT ON recipe_versions,receipts TO gm_app;
GRANT INSERT,UPDATE ON suppliers,shifts TO gm_app;

GRANT SELECT,INSERT ON tender_allocations TO gm_app;
REVOKE UPDATE ON restaurants FROM gm_app;
GRANT UPDATE(name,currency,timezone,cutoff,opening_days,config_version) ON restaurants TO gm_app;
GRANT SELECT,INSERT ON oauth_login_attempts TO gm_app;
GRANT UPDATE(consumed_at) ON oauth_login_attempts TO gm_app;
-- 023 access
GRANT SELECT,INSERT,UPDATE ON pin_throttles TO gm_app;
GRANT SELECT,INSERT ON device_pairing_codes TO gm_app;
GRANT UPDATE(consumed_at,device_id,cancelled_at,cancelled_by) ON device_pairing_codes TO gm_app;
GRANT SELECT,INSERT ON offline_lease_renewals TO gm_app;
GRANT SELECT,INSERT ON owner_accounts,owner_sessions,owner_memberships,organizations,restaurants TO gm_app;
GRANT UPDATE(revoked) ON owner_sessions TO gm_app;
GRANT INSERT ON signup_billing_intents TO gm_app;
-- 024 service: kitchen feed version counter (no DELETE; the upsert needs UPDATE on the set columns)
GRANT SELECT,INSERT ON kitchen_feed_versions TO gm_app;
GRANT UPDATE(version,updated_at) ON kitchen_feed_versions TO gm_app;
GRANT SELECT,INSERT ON owner_location_commands,restaurant_invitations,owner_browser_devices TO gm_app;
GRANT UPDATE(revoked,accepted_by,accepted_at,employee_id) ON restaurant_invitations TO gm_app;
GRANT UPDATE(free_location) ON restaurants TO gm_app;
-- 025 menu
GRANT SELECT,INSERT ON menu_state TO gm_app;
GRANT UPDATE(revision,updated_at) ON menu_state TO gm_app;
GRANT SELECT,INSERT,UPDATE ON menu_categories,modifier_groups,dining_areas TO gm_app;
GRANT UPDATE(negative_stock_policy) ON restaurants TO gm_app;
-- on_hand / negative_since are written only by the SECURITY DEFINER ledger trigger,
-- so the runtime role can neither update them nor set them on insert (they default).
REVOKE UPDATE ON stock_items FROM gm_app;
GRANT UPDATE(name,unit,kind,threshold,version,par_level,settings_version,archived_at) ON stock_items TO gm_app;
REVOKE INSERT ON stock_items FROM gm_app;
GRANT INSERT(tenant_id,id,name,unit,kind,threshold,version,par_level,settings_version,archived_at) ON stock_items TO gm_app;
GRANT SELECT,INSERT ON offline_leases,offline_recoveries,offline_recovery_tasks TO gm_app;
GRANT UPDATE(state,resolved_by,resolution,resolved_at) ON offline_recovery_tasks TO gm_app;
GRANT SELECT,INSERT ON line_voids TO gm_app;
GRANT UPDATE(kitchen_acknowledged_at,kitchen_acknowledged_by) ON line_voids TO gm_app;
-- 026 offline
GRANT SELECT,INSERT ON offline_sync_records,offline_archives,offline_kitchen_reviews TO gm_app;
GRANT UPDATE(state,decided_by,decided_at) ON offline_kitchen_reviews TO gm_app;
GRANT UPDATE(offline_prefix) ON devices TO gm_app;
GRANT UPDATE(offline_table_service) ON restaurants TO gm_app;
-- 2.0 jobs worker: capability roles come from scripts/ops/sql/globals.sql (never from a
-- migration); logins gm_<env>_worker / local gm_worker are members of gm_jobs_worker.
-- gm_support is checked here too, so a cluster that missed globals.sql fails at this
-- deploy rather than at 031's.
DO $$ BEGIN
 IF to_regrole('gm_jobs_worker') IS NULL OR to_regrole('gm_support') IS NULL THEN
  RAISE EXCEPTION 'role gm_jobs_worker or gm_support is missing: run scripts/ops/sql/globals.sql as the database owner first (docs/PROVISIONING.md)';
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO gm_jobs_worker;
GRANT SELECT,INSERT ON jobs TO gm_jobs_worker;
GRANT UPDATE(state,attempts,next_at,lease_until,error_code) ON jobs TO gm_jobs_worker;
-- 027 fiscal: tickets, ticket taxes and refund adjustments are INSERT-only (CFF art. 30,
-- immutable by trigger); the profile and the folio counter take column UPDATEs only. No DELETE.
GRANT SELECT,INSERT ON restaurant_fiscal_profiles,fiscal_folio_counters,fiscal_tickets,fiscal_ticket_taxes,fiscal_adjustments TO gm_app;
GRANT UPDATE(rfc,legal_name,regime,postal_code,address,ticket_series,tax_region,default_tax_category,border_confirmed_at,border_confirmed_by,multiple_branches,version,updated_by,updated_at) ON restaurant_fiscal_profiles TO gm_app;
GRANT UPDATE(last_value) ON fiscal_folio_counters TO gm_app;
-- 028 discounts: money records are INSERT-only (no DELETE anywhere); discounts allow
-- only the reversal columns, refund lines only the kitchen acknowledgement, and the
-- reversal's SELECT ... FOR UPDATE needs that column-level UPDATE privilege.
GRANT SELECT,INSERT ON money_controls,discounts,discount_allocations,refund_batches,refund_lines,refund_units,cash_count_reviews TO gm_app;
GRANT UPDATE(cashier_max_percent_bps,cashier_max_amount,server_max_percent_bps,server_max_amount,blind_close,expected_roles,close_roles,version,updated_by,updated_at) ON money_controls TO gm_app;
GRANT UPDATE(reversed_at,reversed_by,reversal_approver_id,reversal_note,reversed_amount) ON discounts TO gm_app;
GRANT UPDATE(kitchen_acknowledged_at,kitchen_acknowledged_by) ON refund_lines TO gm_app;
GRANT SELECT ON kitchen_removals TO gm_app;
-- 029 reports: business-day settings history (written by the restaurants trigger as
-- the runtime role) and corte print records; INSERT-only, no UPDATE or DELETE.
GRANT SELECT,INSERT ON business_day_settings,report_prints TO gm_app;
-- 031 account: evidence and history tables are INSERT-only (no UPDATE, no DELETE);
-- lifecycle tables get column-scoped UPDATE. gm_support grants live in 031.
GRANT SELECT,INSERT ON legal_acceptances,account_events TO gm_app;
GRANT SELECT,INSERT ON organization_co_owners TO gm_app;
GRANT UPDATE(removed_at,removed_by,removal) ON organization_co_owners TO gm_app;
GRANT SELECT,INSERT ON ownership_transfers TO gm_app;
GRANT UPDATE(to_account_id,state,completed_at,canceled_at,canceled_by) ON ownership_transfers TO gm_app;
GRANT UPDATE(created_by_account) ON organizations TO gm_app;
GRANT UPDATE(revoked_at,revoked_by) ON owner_memberships TO gm_app;
GRANT SELECT,INSERT ON restaurant_account_settings TO gm_app;
GRANT UPDATE(privacy_notice_url,free_selection_mode,version,updated_at,updated_by) ON restaurant_account_settings TO gm_app;
GRANT SELECT,INSERT ON account_recovery_codes TO gm_app;
GRANT UPDATE(used_at,used_by_account,used_for_transfer,revoked_at) ON account_recovery_codes TO gm_app;
GRANT SELECT ON support_actions TO gm_app;
GRANT SELECT,INSERT ON organization_tax_profiles TO gm_app;
GRANT UPDATE(rfc,legal_name,tax_regime,postal_code,cfdi_use,invoice_email,version,updated_at,updated_by_account) ON organization_tax_profiles TO gm_app;
