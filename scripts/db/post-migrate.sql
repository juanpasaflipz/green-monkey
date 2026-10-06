-- Reviewed reconciler, run by scripts/migrate.ts after every migrate and grants
-- run. It makes every row-level-security table dumpable by the backup role
-- (pg_dump --enable-row-security) without each area having to remember it.
-- There is deliberately no "migrator sees everything" policy: backfills use the
-- NO FORCE / FORCE owner pattern inside their own migration.
DO $$
DECLARE t record;
BEGIN
  IF to_regrole('gm_backup_reader') IS NULL THEN RETURN; END IF;
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relrowsecurity LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                   AND tablename = t.relname AND policyname = 'ops_backup_read') THEN
      EXECUTE format('CREATE POLICY ops_backup_read ON %I FOR SELECT TO gm_backup_reader USING (true)', t.relname);
    END IF;
  END LOOP;
  EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO gm_backup_reader';
END $$;
