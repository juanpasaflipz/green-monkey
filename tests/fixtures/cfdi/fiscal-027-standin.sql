-- TEST-ONLY STAND-IN for fiscal 027 (and the one 028 column cfdi reads), applied by tests/cfdi-db.ts
-- to the DISPOSABLE test database only when fiscal_tickets does not exist yet (the cfdi track is
-- developed before fiscal merges; LD-16: cfdi rebases onto fiscal before shipping steps 7-17).
-- It reproduces the 027 objects cfdi reads exactly as specs/fiscal.md §3 defines them, plus the
-- two statements 030 guards with to_regclass. DELETE THIS FILE AND ITS LOADER at the fiscal rebase:
-- the real 027 then exists and the loader skips it anyway.

CREATE FUNCTION fiscal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable fiscal records', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
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
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((rfc IS NULL) = (legal_name IS NULL) AND (rfc IS NULL) = (regime IS NULL)
         AND (rfc IS NULL) = (postal_code IS NULL)),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id)
);

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
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, order_id),
  UNIQUE (tenant_id, series, number),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, issued_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, series) REFERENCES fiscal_folio_counters(tenant_id, series)
);
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
  CHECK (base + tax = gross),
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
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, refund_id, category),
  FOREIGN KEY (tenant_id, refund_id) REFERENCES refunds(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES employees(tenant_id, id)
);
CREATE INDEX fiscal_adjustments_order ON fiscal_adjustments(tenant_id, order_id);

DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['restaurant_fiscal_profiles','fiscal_folio_counters','fiscal_tickets',
                         'fiscal_ticket_taxes','fiscal_adjustments'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t);
END LOOP;
END $$;
CREATE TRIGGER fiscal_tickets_immutable BEFORE UPDATE OR DELETE ON fiscal_tickets
  FOR EACH ROW EXECUTE FUNCTION fiscal_immutable();
CREATE TRIGGER fiscal_ticket_taxes_immutable BEFORE UPDATE OR DELETE ON fiscal_ticket_taxes
  FOR EACH ROW EXECUTE FUNCTION fiscal_immutable();
CREATE TRIGGER fiscal_adjustments_immutable BEFORE UPDATE OR DELETE ON fiscal_adjustments
  FOR EACH ROW EXECUTE FUNCTION fiscal_immutable();

-- 027 grants (fiscal.md §3.1) and cfdi's worker SELECT grants (scripts/grants.sql "-- 030 cfdi").
GRANT SELECT, INSERT ON restaurant_fiscal_profiles, fiscal_folio_counters, fiscal_tickets,
  fiscal_ticket_taxes, fiscal_adjustments TO gm_app;
GRANT SELECT ON restaurant_fiscal_profiles, fiscal_tickets, fiscal_ticket_taxes, fiscal_adjustments
  TO gm_jobs_worker;

-- 028 stand-in: the refund's tender method cfdi reads for the credit note's payment form.
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'cash';

-- 030's guarded statements (the database was migrated before fiscal_tickets existed).
ALTER TABLE cfdi_document_tickets ADD CONSTRAINT cfdi_document_tickets_ticket
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES fiscal_tickets(tenant_id, id);
CREATE POLICY cfdi_self_invoice_lookup ON fiscal_tickets FOR SELECT
  USING (self_invoice_code = nullif(current_setting('app.self_invoice_code', true), ''));
