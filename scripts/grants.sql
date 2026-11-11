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
GRANT SELECT,INSERT ON owner_accounts,owner_sessions,owner_memberships,organizations,restaurants TO gm_app;
GRANT UPDATE(revoked) ON owner_sessions TO gm_app;
GRANT INSERT ON signup_billing_intents TO gm_app;
GRANT SELECT,INSERT ON owner_location_commands,restaurant_invitations,owner_browser_devices TO gm_app;
GRANT UPDATE(revoked,accepted_by,accepted_at,employee_id) ON restaurant_invitations TO gm_app;
GRANT UPDATE(free_location) ON restaurants TO gm_app;
GRANT SELECT,INSERT ON offline_leases,offline_recoveries,offline_recovery_tasks TO gm_app;
GRANT UPDATE(state,resolved_by,resolution,resolved_at) ON offline_recovery_tasks TO gm_app;
GRANT SELECT,INSERT,UPDATE ON promotions TO gm_app;
GRANT SELECT,INSERT ON approvals,promotion_redemptions TO gm_app;
GRANT UPDATE(consumed_at) ON approvals TO gm_app;
GRANT SELECT,INSERT ON guests,guest_consents,order_feedback,marketing_settings,campaigns,messages,social_posts TO gm_app;
GRANT UPDATE(name,email,phone,locale,email_opt_in,sms_opt_in,whatsapp_opt_in,first_consent_at) ON guests TO gm_app;
GRANT UPDATE ON marketing_settings,social_posts TO gm_app;
GRANT UPDATE(version,name,channels,subject,body,segment,params,promotion_id,state,scheduled_at,launched_at,audience) ON campaigns TO gm_app;
GRANT UPDATE(state,error_code) ON messages TO gm_app;
