-- Per-database privileges for the migration owner and capability roles.
-- Run as the database owner (Neon: neondb_owner) in each application database
-- after globals.sql. The grant options let gm_migrator apply the runtime
-- grants manifest (CONNECT, schema USAGE) without owning the database.
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO gm_migrator WITH GRANT OPTION', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO gm_billing_worker, gm_backup_reader', current_database());
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO gm_migrator WITH GRANT OPTION;
GRANT USAGE ON SCHEMA public TO gm_billing_worker, gm_backup_reader;
-- Only the migration owner creates objects in public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
