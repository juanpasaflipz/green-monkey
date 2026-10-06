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
-- 030 cfdi: the runtime role inserts requests and settings; the worker (gm_jobs_worker, Wave 2.0)
-- performs every transition. Worker privileges live here, never in the migration. It already has
-- USAGE on the schema and SELECT, INSERT, UPDATE(state,attempts,next_at,lease_until,error_code) ON
-- jobs from "-- 2.0 jobs worker"; tenant RLS still applies to every statement through ctx.tenant().
-- No employees grant: foreign-key checks run as the referenced table's owner and no handler reads
-- employee rows.
GRANT SELECT ON restaurants, orders, tenders, refunds TO gm_jobs_worker;
-- Fiscal 027 and discounts 028 tables the worker reads (wave2-cross-track C26). Guarded only so the
-- block applies on a branch database migrated before 027/028; on integration every table exists.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['restaurant_fiscal_profiles','fiscal_tickets','fiscal_ticket_taxes','fiscal_adjustments','refund_batches'] LOOP
  IF to_regclass('public.' || t) IS NOT NULL THEN
   EXECUTE format('GRANT SELECT ON %I TO gm_jobs_worker', t);
  END IF;
 END LOOP;
END $$;
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
