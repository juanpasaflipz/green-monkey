-- Moves every public object not owned by gm_migrator to gm_migrator, so
-- migrations can run as the non-superuser owner (DB-1). Policies, triggers
-- and indexes move with their tables. Run once per database as the current
-- owner (Neon: neondb_owner) inside one transaction; the caller must be able
-- to SET ROLE gm_migrator (PG16+: GRANT gm_migrator TO current_user first).
DO $$
DECLARE o record;
BEGIN
  FOR o IN
    SELECT c.relname AS name,
           CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
                          WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND pg_get_userbyid(c.relowner) <> 'gm_migrator'
      -- Sequences owned by a table column move with the table.
      AND NOT (c.relkind = 'S' AND EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')))
  LOOP
    EXECUTE format('ALTER %s public.%I OWNER TO gm_migrator', o.kind, o.name);
  END LOOP;
  FOR o IN
    SELECT p.oid::regprocedure::text AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'gm_migrator'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO gm_migrator', o.signature);
  END LOOP;
  FOR o IN
    SELECT t.typname AS name
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'c')
      AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')
      AND pg_get_userbyid(t.typowner) <> 'gm_migrator'
  LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO gm_migrator', o.name);
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND pg_get_userbyid(c.relowner) <> 'gm_migrator'
  ) THEN
    RAISE EXCEPTION 'ownership_transfer_incomplete';
  END IF;
END $$;
