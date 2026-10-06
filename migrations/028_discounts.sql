-- 028_discounts.sql
-- Discounts and comps as immutable unit allocations; item and terminal refunds with
-- kitchen cancellation and restock; cash/card drawer separation; blind counts.
-- Expand-only: seven new tables and one view, defaulted or nullable columns on refunds
-- and cash_sessions, NOT VALID constraints on those two small tables, and triggers. No
-- backfill. The previous app revision keeps working: its cash refunds get method 'cash'
-- by default and pass every check, and on orders that carry a discount (which only this
-- revision can create) its voids and item-split payments are refused at commit (7c, 7d)
-- instead of silently corrupting totals. Every function is SECURITY INVOKER, so the
-- caller's row-level security applies (app.tenant_id is transaction-local and still set
-- when the deferred triggers run at commit).
SET LOCAL lock_timeout = '5s';

-- 1. Per-location controls. No row = defaults (blind close, owner+manager see expected).
CREATE TABLE money_controls(
  tenant_id uuid PRIMARY KEY REFERENCES restaurants(id),
  cashier_max_percent_bps integer NOT NULL DEFAULT 0 CHECK (cashier_max_percent_bps BETWEEN 0 AND 10000),
  cashier_max_amount integer NOT NULL DEFAULT 0 CHECK (cashier_max_amount BETWEEN 0 AND 100000000),
  server_max_percent_bps integer NOT NULL DEFAULT 0 CHECK (server_max_percent_bps BETWEEN 0 AND 10000),
  server_max_amount integer NOT NULL DEFAULT 0 CHECK (server_max_amount BETWEEN 0 AND 100000000),
  blind_close boolean NOT NULL DEFAULT true,
  expected_roles text[] NOT NULL DEFAULT '{manager}'
    CHECK (expected_roles <@ ARRAY['manager','cashier','server']::text[]),
  close_roles text[] NOT NULL DEFAULT '{}'
    CHECK (close_roles <@ ARRAY['cashier','server']::text[]),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id)
);

-- 2. Discounts. One row per applied discount; immutable except one reversal.
CREATE TABLE discounts(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('order','line')),
  line_id uuid,
  kind text NOT NULL CHECK (kind IN ('percent','amount','comp')),
  percent_bps integer CHECK (percent_bps BETWEEN 1 AND 10000),
  requested_amount integer CHECK (requested_amount BETWEEN 1 AND 100000000),
  base integer NOT NULL CHECK (base BETWEEN 1 AND 100000000),     -- Σ due of the targeted units
  amount integer NOT NULL CHECK (amount BETWEEN 1 AND 100000000),
  units integer NOT NULL CHECK (units BETWEEN 1 AND 9900),         -- targeted units
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{2,40}$'),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 300),
  actor_id uuid NOT NULL,
  approver_id uuid,                                                 -- null = within the actor's limit
  device_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reversed_at timestamptz,
  reversed_by uuid,
  reversal_approver_id uuid,
  reversal_note text,
  reversed_amount integer,
  CHECK ((scope = 'line') = (line_id IS NOT NULL)),
  CHECK ((kind = 'percent') = (percent_bps IS NOT NULL)),
  CHECK ((kind = 'amount') = (requested_amount IS NOT NULL)),
  CHECK (amount <= base),
  CHECK (kind <> 'comp' OR amount = base),
  CHECK (kind <> 'amount' OR amount = requested_amount),
  CHECK (kind <> 'percent' OR amount = (base::bigint * percent_bps + 5000) / 10000),  -- = domain discount()
  CHECK (reason_code <> 'other' OR char_length(btrim(note)) >= 3),
  CHECK ((reversed_at IS NULL) = (reversed_by IS NULL)
     AND (reversed_at IS NULL) = (reversal_note IS NULL)
     AND (reversed_at IS NULL) = (reversed_amount IS NULL)),
  CHECK (reversal_note IS NULL OR char_length(btrim(reversal_note)) BETWEEN 3 AND 300),
  CHECK (reversed_amount IS NULL OR reversed_amount BETWEEN 0 AND amount),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, order_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id, line_id) REFERENCES order_lines(tenant_id, order_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, approver_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id),
  FOREIGN KEY (tenant_id, reversed_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, reversal_approver_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX discounts_order ON discounts(tenant_id, order_id);
CREATE INDEX discounts_created ON discounts(tenant_id, created_at);
CREATE UNIQUE INDEX discounts_one_active_order_scope ON discounts(tenant_id, order_id)
  WHERE scope = 'order' AND reversed_at IS NULL;

CREATE TABLE discount_allocations(
  tenant_id uuid NOT NULL,
  discount_id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_id uuid NOT NULL,
  unit_index integer NOT NULL CHECK (unit_index BETWEEN 0 AND 98),
  amount integer NOT NULL CHECK (amount > 0),
  PRIMARY KEY (tenant_id, discount_id, line_id, unit_index),
  FOREIGN KEY (tenant_id, order_id, discount_id) REFERENCES discounts(tenant_id, order_id, id),
  FOREIGN KEY (tenant_id, order_id, line_id) REFERENCES order_lines(tenant_id, order_id, id)
);
CREATE INDEX discount_allocations_order ON discount_allocations(tenant_id, order_id);
CREATE INDEX discount_allocations_unit ON discount_allocations(tenant_id, line_id, unit_index);

-- 3. Refunds: one batch per refund command; money rows stay in `refunds` (one per tender).
CREATE TABLE refund_batches(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('amount','items')),
  amount integer NOT NULL CHECK (amount BETWEEN 1 AND 100000000),
  cash_amount integer NOT NULL CHECK (cash_amount >= 0),
  external_amount integer NOT NULL CHECK (external_amount >= 0),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{2,40}$'),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 300),
  restock boolean NOT NULL DEFAULT false,
  actor_id uuid NOT NULL,
  approver_id uuid NOT NULL,
  device_id uuid NOT NULL,
  business_date date NOT NULL,           -- computed once per refund command; fiscal and reports use it
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (cash_amount + external_amount = amount),
  CHECK (mode = 'items' OR NOT restock),
  CHECK (reason_code <> 'other' OR char_length(btrim(note)) >= 3),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, order_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, approver_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id)
);
CREATE INDEX refund_batches_order ON refund_batches(tenant_id, order_id);
CREATE INDEX refund_batches_business_day ON refund_batches(tenant_id, business_date);

-- New columns default so the previous revision's cash-refund inserts stay valid. The
-- egreso payment form (cfdi 030) and the collected/refunded split by method (reports
-- 029) read refunds.method.
ALTER TABLE refunds
  ADD COLUMN method text NOT NULL DEFAULT 'cash',
  ADD COLUMN external_reference text,
  ADD COLUMN batch_id uuid,
  ADD COLUMN order_id uuid;
ALTER TABLE refunds
  ADD CONSTRAINT refunds_method_valid CHECK (method IN ('cash','external')) NOT VALID,
  ADD CONSTRAINT refunds_external_reference CHECK (
    (method = 'external') = (external_reference IS NOT NULL)
    AND (external_reference IS NULL OR char_length(btrim(external_reference)) BETWEEN 1 AND 120)) NOT VALID,
  ADD CONSTRAINT refunds_cash_has_drawer CHECK (method <> 'cash' OR session_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT refunds_batch_with_order CHECK ((batch_id IS NULL) = (order_id IS NULL)) NOT VALID,
  ADD CONSTRAINT refunds_order_tender FOREIGN KEY (tenant_id, order_id, tender_id)
    REFERENCES tenders(tenant_id, order_id, id) NOT VALID,
  ADD CONSTRAINT refunds_batch FOREIGN KEY (tenant_id, order_id, batch_id)
    REFERENCES refund_batches(tenant_id, order_id, id) NOT VALID;
-- Target of refund_units' composite foreign key. refunds_tender (024) stays as it is.
ALTER TABLE refunds ADD CONSTRAINT refund_tender_identity UNIQUE (tenant_id, tender_id, id);
CREATE INDEX refunds_batch_rows ON refunds(tenant_id, batch_id) WHERE batch_id IS NOT NULL;

-- One row per (batch, line): the units returned and their kitchen/stock outcome.
CREATE TABLE refund_lines(
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,                       -- also the stock movement cause_id
  batch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_id uuid NOT NULL,
  units integer[] NOT NULL CHECK (cardinality(units) BETWEEN 1 AND 99),
  amount integer NOT NULL CHECK (amount > 0),
  preparation_state text NOT NULL
    CHECK (preparation_state IN ('not_started','active','ready','completed','offline_review')),
  restocked boolean NOT NULL,
  kitchen_ack_required boolean NOT NULL,
  kitchen_acknowledged_at timestamptz,
  kitchen_acknowledged_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kitchen_acknowledged_at IS NULL) = (kitchen_acknowledged_by IS NULL)),
  CHECK (kitchen_ack_required OR kitchen_acknowledged_at IS NULL),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, batch_id, line_id),
  FOREIGN KEY (tenant_id, order_id, batch_id) REFERENCES refund_batches(tenant_id, order_id, id),
  FOREIGN KEY (tenant_id, order_id, line_id) REFERENCES order_lines(tenant_id, order_id, id),
  FOREIGN KEY (tenant_id, kitchen_acknowledged_by) REFERENCES employees(tenant_id, id)
);
CREATE INDEX refund_lines_order ON refund_lines(tenant_id, order_id);
CREATE INDEX refund_lines_line ON refund_lines(tenant_id, line_id);

-- Money per (refund row = tender, unit). Proves which tender paid what is returned.
CREATE TABLE refund_units(
  tenant_id uuid NOT NULL,
  refund_id uuid NOT NULL,
  tender_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_id uuid NOT NULL,
  unit_index integer NOT NULL CHECK (unit_index BETWEEN 0 AND 98),
  amount integer NOT NULL CHECK (amount > 0),
  PRIMARY KEY (tenant_id, refund_id, line_id, unit_index),
  FOREIGN KEY (tenant_id, tender_id, refund_id) REFERENCES refunds(tenant_id, tender_id, id),
  FOREIGN KEY (tenant_id, order_id, batch_id) REFERENCES refund_batches(tenant_id, order_id, id),
  FOREIGN KEY (tenant_id, tender_id, line_id, unit_index)
    REFERENCES tender_allocations(tenant_id, tender_id, line_id, unit_index),
  FOREIGN KEY (tenant_id, order_id, line_id) REFERENCES order_lines(tenant_id, order_id, id)
);
CREATE INDEX refund_units_order ON refund_units(tenant_id, order_id);
CREATE INDEX refund_units_allocation ON refund_units(tenant_id, tender_id, line_id, unit_index);

-- 4. Drawer close attribution, count mode and card snapshot; one review per drawer.
ALTER TABLE cash_sessions
  ADD COLUMN closed_by uuid,
  ADD COLUMN count_mode text,
  ADD COLUMN external_expected integer,
  ADD COLUMN external_reported integer;
ALTER TABLE cash_sessions
  ADD CONSTRAINT cash_sessions_count_mode CHECK (count_mode IS NULL OR count_mode IN ('blind','visible')) NOT VALID,
  ADD CONSTRAINT cash_sessions_external_reported
    CHECK (external_reported IS NULL OR external_reported BETWEEN 0 AND 100000000) NOT VALID,
  ADD CONSTRAINT cash_sessions_closed_by FOREIGN KEY (tenant_id, closed_by)
    REFERENCES employees(tenant_id, id) NOT VALID;

CREATE TABLE cash_count_reviews(
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  drawer_id uuid NOT NULL,
  reviewer_id uuid NOT NULL,
  note text NOT NULL CHECK (char_length(btrim(note)) BETWEEN 3 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, drawer_id),
  FOREIGN KEY (tenant_id, drawer_id) REFERENCES cash_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, reviewer_id) REFERENCES employees(tenant_id, id)
);

-- 5. Row-level security on every new table.
DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['money_controls','discounts','discount_allocations','refund_batches',
                         'refund_lines','refund_units','cash_count_reviews'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t);
END LOOP;
END $$;

-- 6. Immutability (financial history; triggers stop every role, the owner and
--    superusers included; the runtime role has no DELETE anywhere either).
--    Disposable test databases clean up by disabling these named triggers inside
--    one transaction (LD-12, LD-16 L5).
CREATE FUNCTION money_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable financial records', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['discount_allocations','refund_batches','refund_units','refunds','cash_count_reviews'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION money_immutable()', t || '_immutable', t);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION money_immutable()', t || '_no_truncate', t);
END LOOP;
END $$;
CREATE TRIGGER discounts_no_delete BEFORE DELETE ON discounts FOR EACH ROW EXECUTE FUNCTION money_immutable();
CREATE TRIGGER discounts_no_truncate BEFORE TRUNCATE ON discounts FOR EACH STATEMENT EXECUTE FUNCTION money_immutable();
CREATE TRIGGER refund_lines_no_delete BEFORE DELETE ON refund_lines FOR EACH ROW EXECUTE FUNCTION money_immutable();
CREATE TRIGGER refund_lines_no_truncate BEFORE TRUNCATE ON refund_lines FOR EACH STATEMENT EXECUTE FUNCTION money_immutable();

CREATE FUNCTION discounts_reversal_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.reversed_at IS NOT NULL OR NEW.reversed_at IS NULL
     OR (NEW.tenant_id, NEW.id, NEW.order_id, NEW.scope, NEW.line_id, NEW.kind, NEW.percent_bps,
         NEW.requested_amount, NEW.base, NEW.amount, NEW.units, NEW.reason_code, NEW.note,
         NEW.actor_id, NEW.approver_id, NEW.device_id, NEW.created_at)
        IS DISTINCT FROM
        (OLD.tenant_id, OLD.id, OLD.order_id, OLD.scope, OLD.line_id, OLD.kind, OLD.percent_bps,
         OLD.requested_amount, OLD.base, OLD.amount, OLD.units, OLD.reason_code, OLD.note,
         OLD.actor_id, OLD.approver_id, OLD.device_id, OLD.created_at) THEN
    RAISE EXCEPTION 'discounts are immutable except for a single reversal' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER discounts_reversal_only BEFORE UPDATE ON discounts
  FOR EACH ROW EXECUTE FUNCTION discounts_reversal_only();

CREATE FUNCTION refund_lines_ack_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kitchen_acknowledged_at IS NOT NULL
     OR (NEW.tenant_id, NEW.id, NEW.batch_id, NEW.order_id, NEW.line_id, NEW.units, NEW.amount,
         NEW.preparation_state, NEW.restocked, NEW.kitchen_ack_required, NEW.created_at)
        IS DISTINCT FROM
        (OLD.tenant_id, OLD.id, OLD.batch_id, OLD.order_id, OLD.line_id, OLD.units, OLD.amount,
         OLD.preparation_state, OLD.restocked, OLD.kitchen_ack_required, OLD.created_at) THEN
    RAISE EXCEPTION 'refund lines are immutable except for a single kitchen acknowledgement'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_lines_ack_only BEFORE UPDATE ON refund_lines
  FOR EACH ROW EXECUTE FUNCTION refund_lines_ack_only();

-- Closed drawers keep their original count, expected amount and reason (DB-9); drawers
-- are never deleted. Late tenders into a closed drawer only lock it (SELECT FOR UPDATE).
CREATE FUNCTION cash_sessions_closed_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'closed cash sessions are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_sessions_closed_immutable BEFORE UPDATE OR DELETE ON cash_sessions
  FOR EACH ROW EXECUTE FUNCTION cash_sessions_closed_immutable();

-- 7. Consistency.
-- 7a. A discount allocation targets a real, non-voided unit and never exceeds its due.
CREATE FUNCTION discount_allocations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q integer; t integer; d record; unit_gross bigint; paid bigint; discounted bigint;
BEGIN
  SELECT scope, line_id, reversed_at INTO d FROM discounts WHERE tenant_id = NEW.tenant_id AND id = NEW.discount_id;
  IF d.reversed_at IS NOT NULL OR (d.scope = 'line' AND d.line_id <> NEW.line_id) THEN
    RAISE EXCEPTION 'allocation does not match its discount' USING ERRCODE = 'check_violation';
  END IF;
  SELECT (data->>'quantity')::int, (data->>'total')::int INTO q, t
    FROM order_lines WHERE tenant_id = NEW.tenant_id AND id = NEW.line_id;
  IF NEW.unit_index >= q OR EXISTS (SELECT 1 FROM line_voids v WHERE v.tenant_id = NEW.tenant_id
       AND v.line_id = NEW.line_id AND NEW.unit_index = ANY (v.units)) THEN
    RAISE EXCEPTION 'discounted unit does not exist or is voided' USING ERRCODE = 'check_violation';
  END IF;
  unit_gross := t / q + CASE WHEN NEW.unit_index < t % q THEN 1 ELSE 0 END;
  SELECT coalesce(sum(amount),0) INTO paid FROM tender_allocations
   WHERE tenant_id = NEW.tenant_id AND order_id = NEW.order_id AND line_id = NEW.line_id AND unit_index = NEW.unit_index;
  SELECT coalesce(sum(a.amount),0) INTO discounted FROM discount_allocations a
    JOIN discounts x ON x.tenant_id = a.tenant_id AND x.id = a.discount_id
   WHERE a.tenant_id = NEW.tenant_id AND a.line_id = NEW.line_id AND a.unit_index = NEW.unit_index
     AND x.reversed_at IS NULL;
  IF paid + discounted + NEW.amount > unit_gross THEN
    RAISE EXCEPTION 'discount exceeds the unit due' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER discount_allocations_guard BEFORE INSERT ON discount_allocations
  FOR EACH ROW EXECUTE FUNCTION discount_allocations_guard();

-- 7b. At commit, a discount's allocations add up to its amount.
CREATE FUNCTION discounts_allocated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT coalesce(sum(amount),0) FROM discount_allocations
       WHERE tenant_id = NEW.tenant_id AND discount_id = NEW.id) <> NEW.amount THEN
    RAISE EXCEPTION 'discount % allocations do not add up', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER discounts_allocated AFTER INSERT ON discounts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION discounts_allocated();

-- 7c. At commit, a discounted order reconciles (fires only when a discount is or was
--     present): total + discount = gross − voids, discount = active allocations on
--     non-voided units, Σ tenders ≤ total. The deferred event re-reads the final row.
CREATE FUNCTION orders_discount_reconcile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o record; gross bigint; voided bigint; effective bigint; paid bigint;
BEGIN
  SELECT total, discount INTO o FROM orders WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
  IF NOT EXISTS (SELECT 1 FROM order_lines WHERE tenant_id = NEW.tenant_id AND order_id = NEW.id) THEN
    RETURN NULL;                                                   -- recovery orders have no lines
  END IF;
  SELECT coalesce(sum((data->>'total')::bigint),0) INTO gross FROM order_lines
   WHERE tenant_id = NEW.tenant_id AND order_id = NEW.id;
  SELECT coalesce(sum(amount),0) INTO voided FROM line_voids WHERE tenant_id = NEW.tenant_id AND order_id = NEW.id;
  SELECT coalesce(sum(a.amount),0) INTO effective FROM discount_allocations a
    JOIN discounts d ON d.tenant_id = a.tenant_id AND d.id = a.discount_id
   WHERE a.tenant_id = NEW.tenant_id AND a.order_id = NEW.id AND d.reversed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM line_voids v WHERE v.tenant_id = a.tenant_id
                     AND v.line_id = a.line_id AND a.unit_index = ANY (v.units));
  SELECT coalesce(sum(amount),0) INTO paid FROM tenders WHERE tenant_id = NEW.tenant_id AND order_id = NEW.id;
  IF o.discount <> effective OR o.total + o.discount <> gross - voided OR paid > o.total THEN
    RAISE EXCEPTION 'order % discount does not reconcile', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER orders_discount_reconcile AFTER UPDATE OF total, discount ON orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.discount <> 0 OR OLD.discount <> 0)
  EXECUTE FUNCTION orders_discount_reconcile();

-- 7d. A payment allocation never exceeds a discounted unit's due (stops an old revision
--     that ignores discounts during the deploy overlap). No-op for undiscounted orders.
CREATE FUNCTION tender_allocations_discount_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE disc integer; q integer; t integer; unit_gross bigint; paid bigint; discounted bigint;
BEGIN
  SELECT discount INTO disc FROM orders WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
  IF coalesce(disc,0) = 0 THEN RETURN NEW; END IF;
  SELECT (data->>'quantity')::int, (data->>'total')::int INTO q, t
    FROM order_lines WHERE tenant_id = NEW.tenant_id AND id = NEW.line_id;
  unit_gross := t / q + CASE WHEN NEW.unit_index < t % q THEN 1 ELSE 0 END;
  SELECT coalesce(sum(amount),0) INTO paid FROM tender_allocations
   WHERE tenant_id = NEW.tenant_id AND order_id = NEW.order_id AND line_id = NEW.line_id AND unit_index = NEW.unit_index;
  SELECT coalesce(sum(a.amount),0) INTO discounted FROM discount_allocations a
    JOIN discounts d ON d.tenant_id = a.tenant_id AND d.id = a.discount_id
   WHERE a.tenant_id = NEW.tenant_id AND a.line_id = NEW.line_id AND a.unit_index = NEW.unit_index
     AND d.reversed_at IS NULL;
  IF paid + discounted + NEW.amount > unit_gross THEN
    RAISE EXCEPTION 'payment allocation exceeds the discounted unit due' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tender_allocations_discount_guard BEFORE INSERT ON tender_allocations
  FOR EACH ROW EXECUTE FUNCTION tender_allocations_discount_guard();

-- 7e. Refund money rows: method matches the tender; cumulative cap per tender. Takes the
--     same advisory key the application (and the previous revision) uses for the tender;
--     a session already holding it re-acquires it at once.
CREATE FUNCTION refunds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record; refunded bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || NEW.tender_id::text, 0));
  SELECT method, amount INTO t FROM tenders WHERE tenant_id = NEW.tenant_id AND id = NEW.tender_id;
  IF t.method IS DISTINCT FROM NEW.method THEN
    RAISE EXCEPTION 'refund method must match its tender' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(amount),0) INTO refunded FROM refunds
   WHERE tenant_id = NEW.tenant_id AND tender_id = NEW.tender_id;
  IF refunded + NEW.amount > t.amount THEN
    RAISE EXCEPTION 'refund exceeds its tender' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refunds_guard BEFORE INSERT ON refunds FOR EACH ROW EXECUTE FUNCTION refunds_guard();

-- 7f. Unit refunds never exceed what that tender paid for that unit.
CREATE FUNCTION refund_units_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid integer; done bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || NEW.tender_id::text, 0));
  SELECT amount INTO paid FROM tender_allocations WHERE tenant_id = NEW.tenant_id
     AND tender_id = NEW.tender_id AND line_id = NEW.line_id AND unit_index = NEW.unit_index;
  SELECT coalesce(sum(amount),0) INTO done FROM refund_units WHERE tenant_id = NEW.tenant_id
     AND tender_id = NEW.tender_id AND line_id = NEW.line_id AND unit_index = NEW.unit_index;
  IF done + NEW.amount > paid THEN
    RAISE EXCEPTION 'unit refund exceeds its payment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_units_guard BEFORE INSERT ON refund_units FOR EACH ROW EXECUTE FUNCTION refund_units_guard();

-- 7g. At commit, a refund batch reconciles with its money rows, units and lines.
CREATE FUNCTION refund_batches_reconcile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; u bigint; l bigint;
BEGIN
  SELECT coalesce(sum(amount),0) AS total,
         coalesce(sum(amount) FILTER (WHERE method = 'cash'),0) AS cash,
         coalesce(sum(amount) FILTER (WHERE method = 'external'),0) AS external
    INTO r FROM refunds WHERE tenant_id = NEW.tenant_id AND batch_id = NEW.id;
  SELECT coalesce(sum(amount),0) INTO u FROM refund_units WHERE tenant_id = NEW.tenant_id AND batch_id = NEW.id;
  SELECT coalesce(sum(amount),0) INTO l FROM refund_lines WHERE tenant_id = NEW.tenant_id AND batch_id = NEW.id;
  IF r.total <> NEW.amount OR r.cash <> NEW.cash_amount OR r.external <> NEW.external_amount
     OR (NEW.mode = 'items' AND (u <> NEW.amount OR l <> NEW.amount))
     OR (NEW.mode = 'amount' AND (u <> 0 OR l <> 0))
     OR EXISTS (SELECT 1 FROM refund_lines rl WHERE rl.tenant_id = NEW.tenant_id AND rl.batch_id = NEW.id
                AND rl.amount <> (SELECT coalesce(sum(ru.amount),0) FROM refund_units ru
                                  WHERE ru.tenant_id = rl.tenant_id AND ru.batch_id = rl.batch_id
                                    AND ru.line_id = rl.line_id AND ru.unit_index = ANY (rl.units)))
     OR EXISTS (SELECT 1 FROM refund_units ru WHERE ru.tenant_id = NEW.tenant_id AND ru.batch_id = NEW.id
                AND NOT EXISTS (SELECT 1 FROM refund_lines rl WHERE rl.tenant_id = ru.tenant_id
                                AND rl.batch_id = ru.batch_id AND rl.line_id = ru.line_id
                                AND ru.unit_index = ANY (rl.units))) THEN
    RAISE EXCEPTION 'refund batch % does not reconcile', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER refund_batches_reconcile AFTER INSERT ON refund_batches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refund_batches_reconcile();

-- 8. What the kitchen must not prepare: voided units, plus refunded units of rounds
--    that were not served. security_invoker so the caller's RLS applies. Order totals
--    (refreshOrderState, listOrders, getOrders) keep reading line_voids: refunded units
--    are still sold.
CREATE VIEW kitchen_removals WITH (security_invoker = true) AS
  SELECT v.tenant_id, v.id, v.order_id, v.line_id, v.units, v.reason, v.kitchen_ack_required,
         v.kitchen_acknowledged_at, v.created_at, 'void'::text AS kind
    FROM line_voids v
  UNION ALL
  SELECT r.tenant_id, r.id, r.order_id, r.line_id, r.units, b.note AS reason, r.kitchen_ack_required,
         r.kitchen_acknowledged_at, r.created_at, 'refund'::text AS kind
    FROM refund_lines r
    JOIN refund_batches b ON b.tenant_id = r.tenant_id AND b.id = r.batch_id
   WHERE r.kitchen_ack_required;
