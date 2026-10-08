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
-- 030 cfdi: the runtime role inserts requests and settings; the worker (gm_jobs_worker, Wave 2.0)
-- performs every transition. Worker privileges live here, never in the migration. It already has
-- USAGE on the schema and SELECT, INSERT, UPDATE(state,attempts,next_at,lease_until,error_code) ON
-- jobs from "-- 2.0 jobs worker"; tenant RLS still applies to every statement through ctx.tenant().
-- No employees grant: foreign-key checks run as the referenced table's owner and no handler reads
-- employee rows.
GRANT SELECT ON restaurants, orders, tenders, refunds TO gm_jobs_worker;
-- restaurants' owner_restaurant_read policy looks up owner_memberships, so reading restaurants
-- needs SELECT there too; its FORCE RLS membership_read policy shows no row without app.account_id.
GRANT SELECT ON owner_memberships TO gm_jobs_worker;
-- Fiscal 027 and discounts 028 tables (wave2-cross-track C26): ticketForCfdi
-- (server/fiscal-read.ts) reads the ticket, its taxes and the order's adjustments, fiscalFacts the
-- profile, and the egreso payment form comes from 028's refunds.method (granted above). No worker
-- statement reads refund_batches today; it is granted with refunds so a refund read that joins
-- its batch never fails on a privilege.
GRANT SELECT ON restaurant_fiscal_profiles, fiscal_tickets, fiscal_ticket_taxes, fiscal_adjustments,
  refund_batches TO gm_jobs_worker;
GRANT SELECT, INSERT, UPDATE ON cfdi_platform TO gm_jobs_worker;
GRANT SELECT, UPDATE (mode, live_from, live_enabled_at, live_enabled_by, live_requested_at, live_requested_from,
  live_requested_by, global_periodicity, next_periodicity, next_periodicity_from, version, updated_at)
  ON cfdi_settings TO gm_jobs_worker;
GRANT SELECT, INSERT, UPDATE ON cfdi_organizations, cfdi_csd_uploads, cfdi_documents, cfdi_document_tickets,
  cfdi_cancellations, cfdi_global_periods TO gm_jobs_worker;
GRANT SELECT, INSERT ON cfdi_files, cfdi_events TO gm_jobs_worker;
GRANT SELECT, INSERT, UPDATE (kid, payload_secret, wiped_at) ON cfdi_secrets TO gm_jobs_worker;
-- Runtime role: settings (no live switch columns), fresh requests, events; never a transition.
GRANT SELECT, INSERT ON cfdi_settings TO gm_app;
GRANT UPDATE (enabled, global_periodicity, next_periodicity, next_periodicity_from, global_auto, concept_mode,
  concept_description, card_payment_form, default_use, self_invoice_enabled, self_invoice_policy, self_invoice_days,
  portal_reissue_global, support_email, live_requested_at, live_requested_from, live_requested_by,
  version, updated_by, updated_at) ON cfdi_settings TO gm_app;
GRANT SELECT, INSERT ON cfdi_organizations, cfdi_csd_uploads, cfdi_documents, cfdi_document_tickets,
  cfdi_cancellations, cfdi_events TO gm_app;
GRANT INSERT (tenant_id, id, purpose, kid, payload_secret) ON cfdi_secrets TO gm_app;
-- Must stay after the blanket "GRANT SELECT ON ALL TABLES" at the top of this file: the runtime
-- role never reads sealed secrets (nor does account's export auto-discovery).
REVOKE SELECT ON cfdi_secrets FROM gm_app;
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
-- 032 public-ordering
-- No DELETE on any of the four tables. A hold's diner request and a link's
-- identity stay immutable (column grants plus the 032 transition triggers).
-- Nothing for the worker, support or backup roles.
GRANT SELECT,INSERT ON public_ordering_settings,public_links,public_hold_numbers,public_order_holds TO gm_app;
GRANT UPDATE(paused,table_policy,counter_policy,hold_minutes,max_order_total,version,updated_at,updated_by) ON public_ordering_settings TO gm_app;
GRANT UPDATE(label,revoked_at,revoked_by,revoke_reason) ON public_links TO gm_app;
GRANT UPDATE(value) ON public_hold_numbers TO gm_app;
GRANT UPDATE(state,decided_at,decided_by,reject_reason,order_id,order_round,excluded_line_ids,paid_at_accept,policy_override,accepted_total,accepted_lines) ON public_order_holds TO gm_app;

-- 034 public-ordering redaction
-- The hold transition trigger lets a redaction-only update through (name and
-- note blanked, nothing else changed); the grants decide who may send it.
-- gm_app never updates name or note: support's ARCO block and the retention
-- pass run as the schema owner. Stated here so the manifest says so.
REVOKE UPDATE(name,note) ON public_order_holds FROM gm_app;

-- 036 cfdifix (LD-51 F2): an immediate periodicity change rebuilds the current month's period
-- rows. The worker may DELETE a cfdi_global_periods row only when no document ever used it: 036's
-- guard refuses every other DELETE (status built, a part, any global document of its key) and every
-- runtime-role DELETE, and TRUNCATE stays refused. Listed in tests/ops-db.ts PLATFORM-ROLES-5.
GRANT DELETE ON cfdi_global_periods TO gm_jobs_worker;
-- 036 cfdifix (LD-55, CFDIFIX-FISCAL-5 / UX-4): the owner's save (the runtime role) stores a
-- self-invoicing change that waits; reads resolve it by date, so the worker never writes these
-- columns. Granted here, where gm_app is replaced by the deploy's runtime login (gm_<env>_app in
-- staging and production; a migration naming gm_app would grant a role those clusters do not have,
-- CFDIFIX-R2-1), and only once 036 added them: this manifest also applies to schemas before 036
-- (tests/public-ordering-db.ts applies it at 033). The deploy applies it in the newest migration's
-- transaction, so a schema with 036 always gets it. Idempotent.
DO $$ BEGIN
 IF (SELECT count(*) FROM pg_attribute WHERE attrelid = to_regclass('public.cfdi_settings')
       AND NOT attisdropped AND attname IN ('next_self_invoice_policy','next_self_invoice_days',
         'next_portal_reissue_global','next_self_invoice_from')) = 4 THEN
  GRANT UPDATE (next_self_invoice_policy, next_self_invoice_days, next_portal_reissue_global,
    next_self_invoice_from) ON cfdi_settings TO gm_app;
 END IF;
END $$;
