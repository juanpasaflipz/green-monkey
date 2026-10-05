-- 024 Service lifecycle: check (financial) state separate from kitchen state,
-- round notes and progress timestamps, kitchen feed versions, service indexes.
-- Expand-only. The previous app revision never reads the new columns, DEFAULTs
-- keep its inserts valid and the insert trigger closes the recovery orders it
-- creates. During a rolling deploy it can still settle a check without closing
-- it (staff release such zero-balance checks from Órdenes or Mesas), and adding
-- a round to an already settled check fails there with a server error, the
-- case the new revision rejects as check_closed.
SET LOCAL lock_timeout = '5s';

-- 1. Check lifecycle on orders --------------------------------------------
ALTER TABLE orders
  ADD COLUMN check_state text NOT NULL DEFAULT 'open',
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closed_by uuid,
  ADD COLUMN close_reason text;

-- Historical settled, fully voided and recovery orders are closed.
-- Unpaid orders (including delivered-but-unpaid ones) stay open. The migration
-- role owns the schema and bypasses RLS, as in migration 018.
WITH money AS (
  SELECT o.tenant_id, o.id,
         coalesce(sum(t.amount), 0) AS paid,
         max(t.created_at) AS last_paid
  FROM orders o
  LEFT JOIN tenders t ON t.tenant_id = o.tenant_id AND t.order_id = o.id
  GROUP BY o.tenant_id, o.id
)
UPDATE orders o SET
  check_state = 'closed',
  closed_at = coalesce(m.last_paid, o.created_at),
  closed_by = o.employee_id,
  close_reason = CASE
    WHEN o.state LIKE 'recovery%' THEN 'recovery'
    WHEN o.state = 'cancelled' AND m.paid = 0 THEN 'voided'
    ELSE 'settled' END
FROM money m
WHERE m.tenant_id = o.tenant_id AND m.id = o.id
  AND (o.state LIKE 'recovery%'
       OR (o.state = 'cancelled' AND m.paid = 0)
       OR m.paid >= o.total);

ALTER TABLE orders
  ADD CONSTRAINT orders_check_state_valid
    CHECK (check_state IN ('open', 'paid', 'closed')),
  ADD CONSTRAINT orders_close_reason_valid
    CHECK (close_reason IS NULL OR close_reason IN ('settled', 'released', 'voided', 'recovery')),
  ADD CONSTRAINT orders_close_consistent
    CHECK ((check_state = 'closed') =
           (closed_at IS NOT NULL AND closed_by IS NOT NULL AND close_reason IS NOT NULL)),
  ADD CONSTRAINT orders_closed_by_employee
    FOREIGN KEY (tenant_id, closed_by) REFERENCES employees(tenant_id, id);

-- Recovery orders (from either app revision) are inserted closed. Closed checks
-- keep their financial identity: only kitchen state and non-financial
-- descriptors may change after close. Corrections after close are refunds.
CREATE FUNCTION orders_check_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state LIKE 'recovery%' AND NEW.check_state <> 'closed' THEN
      NEW.check_state := 'closed';
      NEW.closed_at := coalesce(NEW.closed_at, now());
      NEW.closed_by := coalesce(NEW.closed_by, NEW.employee_id);
      NEW.close_reason := 'recovery';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.check_state = 'closed' AND
     (NEW.tenant_id, NEW.id, NEW.number, NEW.business_date, NEW.employee_id,
      NEW.table_id, NEW.mode, NEW.channel, NEW.total, NEW.discount, NEW.version,
      NEW.created_at, NEW.check_state, NEW.closed_at, NEW.closed_by, NEW.close_reason)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.number, OLD.business_date, OLD.employee_id,
      OLD.table_id, OLD.mode, OLD.channel, OLD.total, OLD.discount, OLD.version,
      OLD.created_at, OLD.check_state, OLD.closed_at, OLD.closed_by, OLD.close_reason)
  THEN
    RAISE EXCEPTION 'closed checks are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_check_lifecycle BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_check_lifecycle();

-- 2. Round notes and progress timestamps ------------------------------------
ALTER TABLE rounds
  ADD COLUMN note text NOT NULL DEFAULT ''
    CONSTRAINT rounds_note_length CHECK (char_length(note) <= 500),
  ADD COLUMN ready_at timestamptz,
  ADD COLUMN completed_at timestamptz;

-- Timestamps are maintained in the database so both app revisions record them.
CREATE FUNCTION rounds_progress_timestamps() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'ready' AND OLD.state IS DISTINCT FROM 'ready' THEN
    NEW.ready_at := clock_timestamp();
  END IF;
  IF NEW.state = 'completed' AND OLD.state IS DISTINCT FROM 'completed' THEN
    NEW.completed_at := clock_timestamp();
  END IF;
  IF NEW.state <> 'completed' THEN
    NEW.completed_at := NULL;   -- recall
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rounds_progress_timestamps BEFORE UPDATE OF state ON rounds
  FOR EACH ROW EXECUTE FUNCTION rounds_progress_timestamps();

-- 3. Kitchen feed version (one row per tenant; bumped by KDS-affecting commands)
CREATE TABLE kitchen_feed_versions (
  tenant_id uuid PRIMARY KEY REFERENCES restaurants(id),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE kitchen_feed_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchen_feed_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON kitchen_feed_versions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- 4. Indexes (names are a cross-area contract). Partial predicates are SQL
-- literals; queries must repeat them literally for the planner to use them.
CREATE INDEX IF NOT EXISTS orders_open_checks
  ON orders (tenant_id, created_at DESC, id DESC) WHERE check_state <> 'closed';
CREATE INDEX IF NOT EXISTS orders_business_day
  ON orders (tenant_id, business_date, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS orders_table_open
  ON orders (tenant_id, table_id) WHERE check_state <> 'closed';
CREATE INDEX IF NOT EXISTS rounds_open
  ON rounds (tenant_id, created_at) WHERE state <> 'completed';
CREATE INDEX IF NOT EXISTS rounds_recent_completed
  ON rounds (tenant_id, completed_at DESC) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS tender_allocations_order
  ON tender_allocations (tenant_id, order_id);
CREATE INDEX IF NOT EXISTS refunds_tender
  ON refunds (tenant_id, tender_id);
CREATE INDEX IF NOT EXISTS offline_recoveries_order
  ON offline_recoveries (tenant_id, order_id);
