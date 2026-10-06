SET LOCAL lock_timeout = '5s';
-- 029 reports: versioned business-day settings (stable day bucketing after a cutoff
-- or timezone change), corte print records, and two small-table indexes for the
-- exceptions report and the drawer list. Expand-only: two new tables, two STABLE
-- functions, one AFTER UPDATE trigger on restaurants, immutability triggers on the
-- new tables and two plain indexes on small tables. No backfill, no CONCURRENTLY,
-- no CHECK on existing tables. It references only objects from migrations <= 021
-- plus its own, so it applies on top of any order of 022-028. The previous app
-- revision never reads these objects; its settings updates are captured by the
-- trigger.

-- 1. Business-day settings history. A row (valid_until, timezone, cutoff) means:
--    instants before valid_until (and at or after the previous row's valid_until)
--    used these settings. Instants after the last row use the current restaurants
--    row. Changes made before 029 are not reconstructed (spec decision D4).
CREATE TABLE business_day_settings(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  valid_until timestamptz NOT NULL,
  timezone text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 64),
  cutoff integer NOT NULL CHECK (cutoff BETWEEN 0 AND 1439),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, valid_until)
);

-- The trigger runs as the invoking role and inserts under FORCE RLS, so every path
-- that updates restaurants.timezone or .cutoff must run in the restaurant's tenant
-- scope (tenant(), app.tenant_id = the restaurant id); saveSettings does (contract,
-- spec §6.1).
CREATE FUNCTION business_day_settings_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- now() = start of the settings transaction, the same clock as created_at
  -- defaults. Two changes in one transaction keep the first (older) settings.
  INSERT INTO business_day_settings(tenant_id, valid_until, timezone, cutoff)
  VALUES (NEW.id, now(), OLD.timezone, OLD.cutoff)
  ON CONFLICT (tenant_id, valid_until) DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER restaurants_business_day_settings
  AFTER UPDATE OF timezone, cutoff ON restaurants
  FOR EACH ROW
  WHEN (OLD.timezone IS DISTINCT FROM NEW.timezone OR OLD.cutoff IS DISTINCT FROM NEW.cutoff)
  EXECUTE FUNCTION business_day_settings_record();

-- Canonical business date of an instant: the local wall clock (DST-aware) minus the
-- cutoff, with the settings in force at that instant. Matches shared/domain.ts
-- businessDate() and shared/reports.ts wallClockBusinessDate(). SECURITY INVOKER:
-- without app.tenant_id a non-superuser sees no rows and gets NULL.
CREATE FUNCTION business_date_at(p_tenant uuid, p_at timestamptz) RETURNS date
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ((p_at AT TIME ZONE s.timezone) - make_interval(mins => s.cutoff))::date
  FROM (
    SELECT h.valid_until, h.timezone, h.cutoff FROM business_day_settings h
     WHERE h.tenant_id = p_tenant AND h.valid_until > p_at
    UNION ALL
    SELECT 'infinity'::timestamptz, r.timezone, r.cutoff FROM restaurants r WHERE r.id = p_tenant
  ) s
  ORDER BY s.valid_until
  LIMIT 1
$$;

-- Local wall-clock time of an instant in the zone in force at that instant (hour reports).
CREATE FUNCTION business_local_at(p_tenant uuid, p_at timestamptz) RETURNS timestamp
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT (p_at AT TIME ZONE s.timezone)
  FROM (
    SELECT h.valid_until, h.timezone FROM business_day_settings h
     WHERE h.tenant_id = p_tenant AND h.valid_until > p_at
    UNION ALL
    SELECT 'infinity'::timestamptz, r.timezone FROM restaurants r WHERE r.id = p_tenant
  ) s
  ORDER BY s.valid_until
  LIMIT 1
$$;

-- 2. Print records for cortes (X, Z and the blind count slip per drawer, corte del
--    día per business date). print_number is consecutive per (kind, subject);
--    print_number > 1 is a reprint. The count slip a blind-count role prints is a
--    different document from the corte Z, so it has its own sequence: a cashier's
--    slip never turns the manager's first corte Z into "REIMPRESIÓN 2".
CREATE TABLE report_prints(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('corte_x','corte_z','count_slip','day_corte')),
  subject text NOT NULL,
  print_number integer NOT NULL CHECK (print_number BETWEEN 1 AND 100000),
  actor_id uuid NOT NULL,
  device_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'day_corte' AND subject ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
      OR (kind <> 'day_corte'
          AND subject ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, kind, subject, print_number),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id)
);
CREATE INDEX report_prints_created ON report_prints(tenant_id, created_at);

-- Guard only: the print commands serialize on the advisory key
-- hashtextextended(tenant||':report-print:'||kind||':'||subject,926) (lock level LO-3,
-- area key class 926) before they compute max+1, so concurrent prints never reach this
-- exception.
CREATE FUNCTION report_prints_consecutive() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.print_number <> coalesce((SELECT max(p.print_number) FROM report_prints p
       WHERE p.tenant_id = NEW.tenant_id AND p.kind = NEW.kind AND p.subject = NEW.subject), 0) + 1 THEN
    RAISE EXCEPTION 'report print numbers are consecutive' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_prints_consecutive BEFORE INSERT ON report_prints
  FOR EACH ROW EXECUTE FUNCTION report_prints_consecutive();

-- 3. Row-level security on both new tables (forced, so the owner role is scoped too).
DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['business_day_settings','report_prints'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t);
END LOOP;
END $$;

-- 4. Immutable records (history that reports rely on; no UPDATE, DELETE or TRUNCATE,
--    for the owner role too). Test cleanups disable these named triggers inside their
--    delete transaction (LD-12 pattern, LD-16 L5 order).
CREATE FUNCTION reports_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['business_day_settings','report_prints'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reports_immutable()', t || '_immutable', t);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reports_immutable()', t || '_no_truncate', t);
END LOOP;
END $$;

-- 5. Indexes on small tables for time-range reads (exceptions: voids by time;
--    drawer list: drawers by opening time). Both tables are small (one row per void
--    or per drawer session); a plain CREATE INDEX holds the write lock for
--    milliseconds.
CREATE INDEX line_voids_created ON line_voids(tenant_id, created_at);
CREATE INDEX cash_sessions_opened ON cash_sessions(tenant_id, opened_at);
