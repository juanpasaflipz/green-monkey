-- 026: offline sync ledger, kitchen review of offline-sold rounds, manager archive
-- of unverifiable local records, and per-device provisional-number prefixes.
-- Expand-only: three new tables, one nullable column and one index on the small
-- devices table, and one defaulted setting column on restaurants. Old app
-- revisions neither read nor write any of these objects, and rounds.state keeps
-- no CHECK (the new value 'offline_review' is a contract for any later DB-9
-- constraint).
SET LOCAL lock_timeout = '5s';

-- Offline table service (lead decision LD-7): open checks, rounds and partial
-- payments offline are a per-restaurant beta, OFF by default. A constant
-- default adds the column without rewriting restaurants.
ALTER TABLE restaurants ADD COLUMN offline_table_service boolean NOT NULL DEFAULT false;

-- Device prefix for provisional offline numbers (A..Y, A1..Y9). 'Z' is reserved
-- for client-side fallback prefixes and is never stored.
ALTER TABLE devices ADD COLUMN offline_prefix text
  CHECK (offline_prefix ~ '^[A-Y][1-9]?$');
CREATE UNIQUE INDEX devices_offline_prefix ON devices(tenant_id, offline_prefix)
  WHERE offline_prefix IS NOT NULL;
CREATE FUNCTION devices_offline_prefix_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.offline_prefix IS NOT NULL
     AND NEW.offline_prefix IS DISTINCT FROM OLD.offline_prefix THEN
    RAISE EXCEPTION 'offline_prefix_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER devices_offline_prefix_fixed BEFORE UPDATE OF offline_prefix ON devices
  FOR EACH ROW EXECUTE FUNCTION devices_offline_prefix_fixed();

-- Immutable ledger: one row per offline record applied to the server, written in
-- the same transaction as the order, round or tender it produced.
CREATE TABLE offline_sync_records (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  operation_id uuid NOT NULL,                  -- local record id = idempotency key
  kind text NOT NULL CHECK (kind IN ('sale','order','round','payment')),
  format_version integer NOT NULL CHECK (format_version BETWEEN 1 AND 3),
  path text NOT NULL CHECK (path IN ('automatic','manager')),
  device_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  session_id uuid NOT NULL,                    -- evidence only; no FK so session retention is not blocked
  order_id uuid NOT NULL,
  round_number integer CHECK (round_number > 0),
  tender_id uuid,
  provisional_number text CHECK (provisional_number ~ '^[A-Z][A-Z0-9]{0,2}-[0-9]{2,4}$'),
  reused_online_order boolean NOT NULL DEFAULT false,
  recorded_at timestamptz NOT NULL,            -- corrected device estimate, as submitted
  recorded_at_device timestamptz,              -- raw device clock (NULL for v1/v2)
  clock_offset_ms bigint,                      -- device's last known offset (NULL if unknown)
  sold_at timestamptz NOT NULL,                -- validated, clamped instant
  business_date date NOT NULL,                 -- from sold_at and the lease restaurant snapshot
  kitchen_delivery text NOT NULL
    CHECK (kitchen_delivery IN ('print_requested','device_list','not_applicable')),
  amount integer NOT NULL DEFAULT 0 CHECK (amount >= 0),
  tip integer NOT NULL DEFAULT 0 CHECK (tip >= 0),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 10 AND 500),
  actor_id uuid NOT NULL,                      -- employee whose session applied it
  synced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, operation_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, tender_id) REFERENCES tenders(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES employees(tenant_id, id),
  CHECK ((path = 'manager') = (reason IS NOT NULL)),
  CHECK (path = 'automatic' OR kind = 'payment'),
  CHECK ((kind IN ('sale','payment')) = (tender_id IS NOT NULL)),
  CHECK (kind = 'payment' OR round_number IS NOT NULL)
);
CREATE INDEX offline_sync_records_order ON offline_sync_records(tenant_id, order_id);
CREATE INDEX offline_sync_records_business_date ON offline_sync_records(tenant_id, business_date);

-- Kitchen decision for each round created by offline sync. Only the single
-- pending -> decided transition is allowed.
CREATE TABLE offline_kitchen_reviews (
  tenant_id uuid NOT NULL,
  round_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','prepare','already_served')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, round_id),
  FOREIGN KEY (tenant_id, round_id) REFERENCES rounds(tenant_id, id),
  FOREIGN KEY (tenant_id, operation_id) REFERENCES offline_sync_records(tenant_id, operation_id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES employees(tenant_id, id),
  CHECK ((state = 'pending') = (decided_by IS NULL AND decided_at IS NULL))
);
CREATE INDEX offline_kitchen_reviews_pending ON offline_kitchen_reviews(tenant_id, created_at)
  WHERE state = 'pending';
CREATE FUNCTION offline_kitchen_review_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'pending'
     OR (NEW.tenant_id, NEW.round_id, NEW.operation_id, NEW.created_at)
        IS DISTINCT FROM (OLD.tenant_id, OLD.round_id, OLD.operation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'offline_kitchen_review_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER offline_kitchen_review_once BEFORE UPDATE ON offline_kitchen_reviews
  FOR EACH ROW EXECUTE FUNCTION offline_kitchen_review_once();

-- Manager archive of a local record that will never be recorded as a sale.
-- The evidence is kept verbatim (CFF art. 30 retention; runtime cannot delete).
CREATE TABLE offline_archives (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  operation_id uuid NOT NULL,                  -- the local record's operationId
  command_id uuid NOT NULL,                    -- the archive command's operationId
  evidence jsonb NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  evidence_valid boolean NOT NULL,             -- parsed by the shared offline record schema
  kind text CHECK (kind IN ('sale','order','round','payment')),
  amount integer NOT NULL CHECK (amount >= 0),
  tip integer NOT NULL CHECK (tip >= 0),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  claimed_device_id uuid,                      -- as claimed, may be unverifiable: no FK
  claimed_employee_id uuid,
  claimed_drawer_id uuid,
  recorded_at timestamptz,
  local_error text CHECK (local_error IS NULL OR length(local_error) <= 100),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, operation_id),
  UNIQUE (tenant_id, command_id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX offline_archives_drawer ON offline_archives(tenant_id, claimed_drawer_id)
  WHERE claimed_drawer_id IS NOT NULL;
-- No created_at index (contract §3.15 index list): archives are rare manager
-- actions, so the paginated list sorts this small table directly.

-- Paginated recoveries list (offline_recoveries is small).
CREATE INDEX offline_recoveries_recognized
  ON offline_recoveries(tenant_id, recognized_at DESC, id DESC);

-- Financial evidence is runtime-immutable; like 019/020, privileged retention and
-- isolated-fixture cleanup may still delete (runtime has no DELETE grant).
CREATE TRIGGER offline_sync_records_immutable BEFORE UPDATE ON offline_sync_records
  FOR EACH ROW EXECUTE FUNCTION immutable_offline_evidence();   -- defined in 018
CREATE TRIGGER offline_archives_immutable BEFORE UPDATE ON offline_archives
  FOR EACH ROW EXECUTE FUNCTION immutable_offline_evidence();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['offline_sync_records','offline_kitchen_reviews','offline_archives'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t);
 END LOOP;
END $$;
