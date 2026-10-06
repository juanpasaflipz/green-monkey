-- Cluster-global roles the migrations, grants and the backup reconciler expect.
-- Idempotent. Run it as a role with CREATEROLE (Neon: neondb_owner; provision-roles.ts does it):
--   - before the first migrate on a new cluster;
--   - before pg_restore into a fresh cluster (pg_dump never emits roles, so a restore
--     otherwise fails at the first "CREATE POLICY ... TO gm_billing_worker", DB-2);
--   - and once on every existing cluster before its first deploy that contains Wave 2.0
--     (gm_jobs_worker, gm_support). The "-- 2.0 jobs worker" block of scripts/grants.sql
--     refuses to apply until this has run.
-- Migrations never create these roles. 011, 030 and 031 contain only an
-- IF NOT EXISTS ... CREATE ROLE fallback for local and CI clusters whose migrator may
-- create roles; it is a no-op wherever this file already ran.
DO $$
DECLARE r text;
BEGIN
  -- Capability roles (NOLOGIN). Logins become members of them.
  FOREACH r IN ARRAY ARRAY['gm_billing_worker', 'gm_backup_reader', 'gm_jobs_worker', 'gm_support'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', r);
    END IF;
  END LOOP;
  -- Schema owner for migrations: not a superuser, no BYPASSRLS, no CREATEROLE
  -- (DB-1). Provisioning gives it LOGIN and a password.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gm_migrator') THEN
    CREATE ROLE gm_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
