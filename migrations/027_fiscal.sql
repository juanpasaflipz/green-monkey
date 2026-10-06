-- 027_fiscal.sql
-- Fiscal profile, tax snapshots per ticket, consecutive gapless ticket folios and
-- refund tax adjustments (docs/FISCAL.md). Expand-only: new tables and triggers,
-- no backfill and no change to existing columns, so the previous app revision keeps
-- working (its payments simply produce no ticket until repair).
SET LOCAL lock_timeout = '5s';

-- The instant this migration ran. Repair only issues tickets for orders created after it,
-- so pre-fiscal history is never given invented tax (PRODUCT_COMPLETION_PLAN.md:253).
DO $$ BEGIN
  EXECUTE format(
    'CREATE FUNCTION fiscal_epoch() RETURNS timestamptz LANGUAGE sql IMMUTABLE PARALLEL SAFE AS %L',
    format('SELECT %L::timestamptz', now()));
END $$;

CREATE TABLE restaurant_fiscal_profiles(
  tenant_id uuid PRIMARY KEY REFERENCES restaurants(id),
  rfc text CHECK (rfc ~ '^[A-ZÑ&]{3,4}[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[A-Z0-9]{2}[0-9A]$'
                  AND rfc NOT IN ('XAXX010101000','XEXX010101000')),
  legal_name text CHECK (length(legal_name) BETWEEN 1 AND 254),
  regime text CHECK (regime ~ '^6[0-9]{2}$'),
  postal_code text CHECK (postal_code ~ '^[0-9]{5}$'),
  address jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(address) = 'object'),
  ticket_series text NOT NULL DEFAULT '' CHECK (ticket_series ~ '^[A-Z0-9]{0,10}$'),
  tax_region text NOT NULL DEFAULT 'general' CHECK (tax_region IN ('general','border_north','border_south')),
  default_tax_category text NOT NULL DEFAULT 'iva16' CHECK (default_tax_category IN ('iva16','iva8','iva0','exempt')),
  border_confirmed_at timestamptz,
  border_confirmed_by uuid,
  -- The RFC has more than one premises: the issuing branch's address is required (CFF art. 29-A fr. I).
  multiple_branches boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((rfc IS NULL) = (legal_name IS NULL) AND (rfc IS NULL) = (regime IS NULL)
         AND (rfc IS NULL) = (postal_code IS NULL)),
  CHECK (default_tax_category <> 'iva8' OR tax_region <> 'general'),
  CHECK (tax_region = 'general' OR border_confirmed_at IS NOT NULL),
  -- The IVA 8% incentive needs an identified issuer and place of issue (the app also checks the
  -- postal code's state, shared/fiscal.ts BORDER_POSTAL_PREFIXES).
  CHECK (tax_region = 'general' OR rfc IS NOT NULL),
  CHECK (NOT multiple_branches OR (rfc IS NOT NULL
         AND coalesce(btrim(address->>'street'),'') <> ''
         AND coalesce(btrim(address->>'municipality'),'') <> ''
         AND coalesce(btrim(address->>'state'),'') <> '')),
  CHECK ((border_confirmed_at IS NULL) = (border_confirmed_by IS NULL)),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, border_confirmed_by) REFERENCES employees(tenant_id, id)
);

-- One row per (location, series). last_value is the last folio issued in that series.
CREATE TABLE fiscal_folio_counters(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  series text NOT NULL CHECK (series ~ '^[A-Z0-9]{0,10}$'),
  last_value bigint NOT NULL CHECK (last_value >= 1),
  PRIMARY KEY (tenant_id, series)
);

CREATE TABLE fiscal_tickets(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  series text NOT NULL,
  number bigint NOT NULL CHECK (number >= 1),
  self_invoice_code text NOT NULL CHECK (self_invoice_code ~ '^[0-9A-HJKMNP-TV-Z]{12}$'),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  business_date date NOT NULL,
  issued_by uuid NOT NULL,
  device_id uuid,
  source text NOT NULL CHECK (source IN ('sale','recovery','repair')),
  currency text NOT NULL CHECK (currency = 'MXN'),
  gross_before_discount integer NOT NULL CHECK (gross_before_discount >= 0),
  discount integer NOT NULL CHECK (discount >= 0),
  unallocated_discount integer NOT NULL DEFAULT 0 CHECK (unallocated_discount >= 0),
  gross integer NOT NULL CHECK (gross > 0),
  base integer NOT NULL CHECK (base >= 0),
  tax integer NOT NULL CHECK (tax >= 0),
  tip integer NOT NULL DEFAULT 0 CHECK (tip >= 0),
  tax_basis text NOT NULL CHECK (tax_basis IN ('line_snapshot','issuance_default','recovery_default')),
  issuer jsonb CHECK (issuer IS NULL OR jsonb_typeof(issuer) = 'object'),
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  payments jsonb NOT NULL CHECK (jsonb_typeof(payments) = 'array'),
  CHECK (base + tax = gross),
  CHECK (gross_before_discount - discount = gross),
  CHECK (unallocated_discount <= discount),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, order_id),
  UNIQUE (tenant_id, series, number),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, issued_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id),
  FOREIGN KEY (tenant_id, series) REFERENCES fiscal_folio_counters(tenant_id, series)
);
-- Global uniqueness so cfdi can resolve a printed code; collisions are retried by the app.
CREATE UNIQUE INDEX fiscal_tickets_self_invoice_code ON fiscal_tickets(self_invoice_code);
CREATE INDEX fiscal_tickets_business_day ON fiscal_tickets(tenant_id, business_date, issued_at, id);

CREATE TABLE fiscal_ticket_taxes(
  tenant_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('iva16','iva8','iva0','exempt')),
  rate_bps integer,
  gross_before_discount integer NOT NULL CHECK (gross_before_discount >= 0),
  discount integer NOT NULL CHECK (discount >= 0),
  gross integer NOT NULL CHECK (gross >= 0),
  base_before_discount integer NOT NULL CHECK (base_before_discount >= 0),
  discount_base integer NOT NULL CHECK (discount_base >= 0),
  base integer NOT NULL CHECK (base >= 0),
  tax integer NOT NULL CHECK (tax >= 0),
  CHECK (gross_before_discount - discount = gross),
  CHECK (base_before_discount - discount_base = base),
  CHECK (base + tax = gross),
  CHECK ((category = 'iva16' AND rate_bps = 1600) OR (category = 'iva8' AND rate_bps = 800)
      OR (category = 'iva0' AND rate_bps = 0) OR (category = 'exempt' AND rate_bps IS NULL)),
  CHECK (category IN ('iva16','iva8') OR tax = 0),
  PRIMARY KEY (tenant_id, ticket_id, category),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES fiscal_tickets(tenant_id, id)
);

CREATE TABLE fiscal_adjustments(
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'refund' CHECK (kind IN ('refund')),
  refund_id uuid NOT NULL,
  order_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('iva16','iva8','iva0','exempt')),
  rate_bps integer,
  gross integer NOT NULL CHECK (gross > 0),
  base integer NOT NULL CHECK (base >= 0),
  tax integer NOT NULL CHECK (tax >= 0),
  business_date date NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (base + tax = gross),
  CHECK ((category = 'iva16' AND rate_bps = 1600) OR (category = 'iva8' AND rate_bps = 800)
      OR (category = 'iva0' AND rate_bps = 0) OR (category = 'exempt' AND rate_bps IS NULL)),
  CHECK (category IN ('iva16','iva8') OR tax = 0),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, refund_id, category),
  FOREIGN KEY (tenant_id, refund_id) REFERENCES refunds(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES employees(tenant_id, id)
);
CREATE INDEX fiscal_adjustments_order ON fiscal_adjustments(tenant_id, order_id);
CREATE INDEX fiscal_adjustments_business_day ON fiscal_adjustments(tenant_id, business_date);

-- Row-level security: forced on every new tenant table.
DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['restaurant_fiscal_profiles','fiscal_folio_counters','fiscal_tickets',
                         'fiscal_ticket_taxes','fiscal_adjustments'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t);
END LOOP;
END $$;

-- The trigger functions below are SECURITY INVOKER: they run as the writing role (gm_app)
-- under RLS, with app.tenant_id still set at COMMIT for the deferred ones (tenant() sets it
-- transaction-locally).

-- Immutable fiscal records (CFF art. 30): no UPDATE, DELETE or TRUNCATE even for the owner.
CREATE FUNCTION fiscal_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable fiscal records', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER fiscal_tickets_immutable BEFORE UPDATE OR DELETE ON fiscal_tickets
  FOR EACH ROW EXECUTE FUNCTION fiscal_immutable();
CREATE TRIGGER fiscal_tickets_no_truncate BEFORE TRUNCATE ON fiscal_tickets
  FOR EACH STATEMENT EXECUTE FUNCTION fiscal_immutable();
CREATE TRIGGER fiscal_ticket_taxes_immutable BEFORE UPDATE OR DELETE ON fiscal_ticket_taxes
  FOR EACH ROW EXECUTE FUNCTION fiscal_immutable();
CREATE TRIGGER fiscal_ticket_taxes_no_truncate BEFORE TRUNCATE ON fiscal_ticket_taxes
  FOR EACH STATEMENT EXECUTE FUNCTION fiscal_immutable();
CREATE TRIGGER fiscal_adjustments_immutable BEFORE UPDATE OR DELETE ON fiscal_adjustments
  FOR EACH ROW EXECUTE FUNCTION fiscal_immutable();
CREATE TRIGGER fiscal_adjustments_no_truncate BEFORE TRUNCATE ON fiscal_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION fiscal_immutable();

-- Counters start at 1 and only ever advance by exactly one.
CREATE FUNCTION fiscal_folio_counter_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.last_value <> 1 THEN RAISE EXCEPTION 'folio counters start at 1'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'folio counters cannot be deleted'; END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.series <> OLD.series OR NEW.last_value <> OLD.last_value + 1 THEN
    RAISE EXCEPTION 'folio counters only advance by one';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_folio_counters_guard BEFORE INSERT OR UPDATE OR DELETE ON fiscal_folio_counters
  FOR EACH ROW EXECUTE FUNCTION fiscal_folio_counter_guard();
CREATE TRIGGER fiscal_folio_counters_no_truncate BEFORE TRUNCATE ON fiscal_folio_counters
  FOR EACH STATEMENT EXECUTE FUNCTION fiscal_immutable();

-- Gapless: at commit, every counter value written in the transaction has its ticket.
CREATE FUNCTION fiscal_counter_has_ticket() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fiscal_tickets t WHERE t.tenant_id = NEW.tenant_id
                 AND t.series = NEW.series AND t.number = NEW.last_value) THEN
    RAISE EXCEPTION 'folio % % has no ticket', NEW.series, NEW.last_value;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fiscal_folio_counters_gapless AFTER INSERT OR UPDATE ON fiscal_folio_counters
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fiscal_counter_has_ticket();

-- A ticket takes exactly the current counter value, and its gross equals the order total.
CREATE FUNCTION fiscal_ticket_insert_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE current_value bigint; order_total integer;
BEGIN
  SELECT last_value INTO current_value FROM fiscal_folio_counters
    WHERE tenant_id = NEW.tenant_id AND series = NEW.series;
  IF current_value IS NULL OR NEW.number <> current_value THEN
    RAISE EXCEPTION 'ticket number must equal the series counter';
  END IF;
  SELECT total INTO order_total FROM orders WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
  IF order_total IS DISTINCT FROM NEW.gross THEN
    RAISE EXCEPTION 'ticket gross must equal the order total';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_tickets_insert_guard BEFORE INSERT ON fiscal_tickets
  FOR EACH ROW EXECUTE FUNCTION fiscal_ticket_insert_guard();

-- At commit, a ticket's category rows add up to its totals.
CREATE FUNCTION fiscal_ticket_sums() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s record;
BEGIN
  SELECT coalesce(sum(gross_before_discount),0) AS gbd, coalesce(sum(discount),0) AS d,
         coalesce(sum(gross),0) AS g, coalesce(sum(base),0) AS b, coalesce(sum(tax),0) AS x
    INTO s FROM fiscal_ticket_taxes WHERE tenant_id = NEW.tenant_id AND ticket_id = NEW.id;
  IF s.gbd <> NEW.gross_before_discount OR s.d <> NEW.discount OR s.g <> NEW.gross
     OR s.b <> NEW.base OR s.x <> NEW.tax THEN
    RAISE EXCEPTION 'ticket % tax rows do not reconcile', NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fiscal_tickets_reconcile AFTER INSERT ON fiscal_tickets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fiscal_ticket_sums();

-- Defense in depth: no new order line once the order has a ticket (app throws
-- fiscal_ticket_issued first; this also stops an old app revision during a deploy overlap).
CREATE FUNCTION order_lines_block_after_ticket() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fiscal_tickets t WHERE t.tenant_id = NEW.tenant_id AND t.order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'fiscal_ticket_issued' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_lines_block_after_ticket BEFORE INSERT ON order_lines
  FOR EACH ROW EXECUTE FUNCTION order_lines_block_after_ticket();
