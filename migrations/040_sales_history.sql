-- 040_sales_history.sql — Histórico POS Lite (docs/SALES_HISTORY.md): Juanberto's past pos-lite
-- kiosk and POS-terminal sales as report history only. Five new tables, all their own: no order,
-- tender, cash, fiscal ticket, CFDI, discount, refund, stock, loyalty or job row is ever written
-- for them, and no existing report reads them (Ventas, IVA, Cobros, cortes, checks and the factura
-- global never see this history).
--
-- An import batch (one uploaded export file, unique per restaurant and file hash) owns aggregate
-- rows per business date: per channel (sales_history_days), per channel and payment method
-- (sales_history_payments) and per channel and product name (sales_history_products). Aggregate
-- rows are INSERT-only and never deleted; sales_history_coverage says which batch currently owns
-- each business date. A newer export of the same restaurant moves the dates it covers to its own
-- batch (an UPDATE of that pointer, audited) and leaves every other date where it was, so the
-- superseded rows stay as evidence and nothing is counted twice.
--
-- Expand-only: the previous revision never reads the new tables. No DML (no backfill, LD-6 not
-- triggered), no role and no grant: grants live in scripts/grants.sql ("-- 040 sales-history"),
-- never here (migrations-lint runtime_role_named). No SECURITY DEFINER, no advisory class of its
-- own (the import serializes on a class-0 key, as the loyalty import). Every table forces
-- row-level security; nothing grants DELETE on any of them. Money is integer centavos.
SET LOCAL lock_timeout = '5s';

-- 1. Import batches ------------------------------------------------------------------------
CREATE TABLE sales_history_batches (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  source text NOT NULL CHECK (source = 'pos-lite-sales'),
  source_tenant_id text NOT NULL CHECK (char_length(source_tenant_id) BETWEEN 1 AND 100),
  source_name text CHECK (char_length(source_name) <= 200),
  file_hash text NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  exported_at timestamptz NOT NULL,
  coverage_from date NOT NULL,
  coverage_to date NOT NULL,
  orders integer NOT NULL CHECK (orders > 0),
  rejected integer NOT NULL CHECK (rejected >= 0),
  -- The preview's reconciliation (source pesos vs converted centavos) and rejection counts.
  report jsonb NOT NULL,
  imported_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source, file_hash),
  FOREIGN KEY (tenant_id, imported_by) REFERENCES employees(tenant_id, id),
  CHECK (coverage_from <= coverage_to)
);

-- 2. Aggregates per business date (INSERT-only) ----------------------------------------------
CREATE TABLE sales_history_days (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  batch_id uuid NOT NULL,
  business_date date NOT NULL,
  channel text NOT NULL CHECK (channel IN ('kiosk', 'pos')),
  orders integer NOT NULL CHECK (orders > 0),
  gross bigint NOT NULL CHECK (gross >= 0),          -- Σ quantity × unit price (IVA included)
  discount bigint NOT NULL CHECK (discount >= 0),
  subtotal bigint NOT NULL CHECK (subtotal >= 0),    -- before IVA
  tax bigint NOT NULL CHECK (tax >= 0),
  total bigint NOT NULL CHECK (total >= 0),          -- subtotal + tax; tips are not in it
  tip bigint NOT NULL CHECK (tip >= 0),
  refunds bigint NOT NULL CHECK (refunds >= 0),
  PRIMARY KEY (tenant_id, batch_id, business_date, channel),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES sales_history_batches(tenant_id, id),
  CHECK (subtotal + tax = total)
);
CREATE TABLE sales_history_payments (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  batch_id uuid NOT NULL,
  business_date date NOT NULL,
  channel text NOT NULL CHECK (channel IN ('kiosk', 'pos')),
  method text NOT NULL CHECK (method IN ('cash', 'card', 'transfer', 'other')),
  payments integer NOT NULL CHECK (payments > 0),    -- a split order counts once per part
  amount bigint NOT NULL CHECK (amount >= 0),
  tip bigint NOT NULL CHECK (tip >= 0),
  PRIMARY KEY (tenant_id, batch_id, business_date, channel, method),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES sales_history_batches(tenant_id, id)
);
CREATE TABLE sales_history_products (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  batch_id uuid NOT NULL,
  business_date date NOT NULL,
  channel text NOT NULL CHECK (channel IN ('kiosk', 'pos')),
  product_name text NOT NULL CHECK (char_length(product_name) BETWEEN 1 AND 120),
  quantity integer NOT NULL CHECK (quantity >= 0),
  amount bigint NOT NULL CHECK (amount >= 0),        -- after line discounts, IVA included
  PRIMARY KEY (tenant_id, batch_id, business_date, channel, product_name),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES sales_history_batches(tenant_id, id)
);

-- 3. Which batch owns each business date ----------------------------------------------------
CREATE TABLE sales_history_coverage (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  business_date date NOT NULL,
  batch_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, business_date),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES sales_history_batches(tenant_id, id)
);
CREATE INDEX sales_history_coverage_batch ON sales_history_coverage (tenant_id, batch_id);

-- 4. Row-level security ---------------------------------------------------------------------
ALTER TABLE sales_history_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_history_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON sales_history_batches
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE sales_history_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_history_days FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON sales_history_days
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE sales_history_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_history_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON sales_history_payments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE sales_history_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_history_products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON sales_history_products
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE sales_history_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_history_coverage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON sales_history_coverage
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
