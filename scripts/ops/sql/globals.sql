-- Cluster-global roles the migrations and the backup reconciler expect.
-- Idempotent; run as a role with CREATEROLE (Neon: neondb_owner) before the
-- first migrate on a new cluster and before pg_restore into a fresh one
-- (pg_dump never emits roles, so a fresh cluster otherwise fails at the first
-- "CREATE POLICY ... TO gm_billing_worker", DB-2).
DO $$
DECLARE r text;
BEGIN
  -- Capability roles (NOLOGIN). Logins become members of them.
  FOREACH r IN ARRAY ARRAY['gm_billing_worker', 'gm_backup_reader'] LOOP
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
