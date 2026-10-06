-- Per-database privileges for the migration owner and capability roles.
-- Run as the database owner (Neon: neondb_owner) in each application database
-- after globals.sql. The grant options let gm_migrator apply the runtime
-- grants manifest (CONNECT, schema USAGE) without owning the database.
-- Idempotent. The grant options are granted only when missing: once the
-- owner inherits gm_migrator (provision-roles.ts), PostgreSQL would record
-- gm_migrator itself as the grantor of a repeated grant and refuse it as a
-- circular grant option (OPS-R9).
-- gm_support gets CONNECT per login from account's support:provision and schema
-- USAGE from 031, so it is deliberately absent here.
DO $$ BEGIN
  IF NOT has_database_privilege('gm_migrator', current_database(), 'CONNECT WITH GRANT OPTION') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO gm_migrator WITH GRANT OPTION', current_database());
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO gm_billing_worker, gm_backup_reader, gm_jobs_worker', current_database());
  IF NOT (has_schema_privilege('gm_migrator', 'public', 'USAGE WITH GRANT OPTION')
          AND has_schema_privilege('gm_migrator', 'public', 'CREATE WITH GRANT OPTION')) THEN
    GRANT USAGE, CREATE ON SCHEMA public TO gm_migrator WITH GRANT OPTION;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO gm_billing_worker, gm_backup_reader, gm_jobs_worker;
-- Only the migration owner creates objects in public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
