-- 041_delivery_history.sql — Histórico de plataformas (docs/DELIVERY_HISTORY.md): the restaurant's
-- Uber Eats, Rappi and DiDi Food sales as report history only. Three new tables, all their own: no
-- order, tender, cash, fiscal ticket, CFDI, discount, refund, stock, loyalty or job row is ever
-- written for them, and no existing report reads them (Ventas, IVA, Cobros, cortes, checks and the
-- factura global never see this history). 040's sales_history_* tables are not touched: their
-- coverage is one batch per business date for every channel, so a delivery import there would
-- hide kiosk and POS days.
--
-- An import batch (one uploaded gm-delivery-sales file, unique per restaurant and file hash) owns
-- aggregate rows per platform calendar date, platform and store (delivery_history_days). Rows are
-- INSERT-only and never deleted; delivery_history_coverage says which batch currently owns each
-- (platform, date). A newer file moves, for each platform it contains, every date from that
-- platform's first to last day to its own batch (an UPDATE of that pointer, audited) and leaves
-- every other platform and date where it was, so superseded rows stay as evidence and nothing is
-- counted twice.
--
-- Expand-only: the previous revision never reads the new tables. No DML (no backfill, LD-6 not
-- triggered), no role and no grant: grants live in scripts/grants.sql ("-- 041 delivery-history"),
-- never here (migrations-lint runtime_role_named). No SECURITY DEFINER, no advisory class of its
-- own (the import serializes on a class-0 key, as 040's import). Every table forces row-level
-- security; nothing grants DELETE on any of them. Money is integer centavos.
SET LOCAL lock_timeout = '5s';

-- 1. Import batches ------------------------------------------------------------------------
CREATE TABLE delivery_history_batches (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  source text NOT NULL CHECK (source = 'delivery-platforms'),
  source_name text CHECK (char_length(source_name) <= 200),
  file_hash text NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  exported_at timestamptz NOT NULL,
  days integer NOT NULL CHECK (days > 0),            -- accepted rows (date, platform, store)
  orders integer NOT NULL CHECK (orders > 0),
  rejected integer NOT NULL CHECK (rejected >= 0),
  -- Coverage per platform ({platform: {from, to}}), the file's sources, the reconciliation
  -- (file pesos vs converted centavos) and the rejection counts.
  report jsonb NOT NULL,
  imported_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source, file_hash),
  FOREIGN KEY (tenant_id, imported_by) REFERENCES employees(tenant_id, id)
);

-- 2. Aggregates per platform calendar date and store (INSERT-only) ---------------------------
CREATE TABLE delivery_history_days (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  batch_id uuid NOT NULL,
  business_date date NOT NULL,                       -- the platform's local calendar date
  platform text NOT NULL CHECK (platform IN ('uber_eats', 'rappi', 'didi_food')),
  store text NOT NULL CHECK (char_length(store) BETWEEN 1 AND 80),
  orders integer NOT NULL CHECK (orders > 0),
  gross bigint NOT NULL CHECK (gross >= 0),          -- what customers paid for food, IVA included
  commission bigint CHECK (commission >= 0),         -- null when the source does not say
  net bigint,                                        -- the platform's payout; any sign
  unsettled_orders integer NOT NULL CHECK (unsettled_orders >= 0),
  cancelled integer NOT NULL CHECK (cancelled >= 0), -- informational, not in orders
  chargebacks bigint NOT NULL CHECK (chargebacks >= 0),
  PRIMARY KEY (tenant_id, batch_id, business_date, platform, store),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES delivery_history_batches(tenant_id, id),
  CHECK (net <= gross)
);

-- 3. Which batch owns each (platform, date) -------------------------------------------------
CREATE TABLE delivery_history_coverage (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  platform text NOT NULL CHECK (platform IN ('uber_eats', 'rappi', 'didi_food')),
  business_date date NOT NULL,
  batch_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, platform, business_date),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES delivery_history_batches(tenant_id, id)
);
CREATE INDEX delivery_history_coverage_batch ON delivery_history_coverage (tenant_id, batch_id);

-- 4. Row-level security ---------------------------------------------------------------------
ALTER TABLE delivery_history_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_history_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON delivery_history_batches
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE delivery_history_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_history_days FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON delivery_history_days
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE delivery_history_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_history_coverage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON delivery_history_coverage
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
