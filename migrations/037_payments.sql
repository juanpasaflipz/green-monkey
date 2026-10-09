-- 037_payments.sql — payments (Wave 4, LD-71, LD-72): named card terminals, Mercado Pago Point and
-- Clip PinPad charges (attempts, target-agnostic for the kiosk, critic R8), the 'platform' tender
-- ("Pagado por plataforma") with per-platform product prices (LD-72), per-terminal drawer counts and
-- the CFDI FormaPago of platform tenders. This is the FINAL shape of the area's schema: phase P2
-- (providers, worker, integrated charging) and the kiosk (039) add no payments migration.
-- Expand-only: new tables and nullable (or constant-default) columns. Four checks are REPLACED in
-- this file, which RELEASE.md allows, each one only widened: tenders_method_check (same name,
-- critic R37, so migrations-lint sees the replacement), refunds_method_valid (same name),
-- cfdi_documents_payment_form_override_check (same name; 030 declared it on the column, so its
-- name is deterministic; it now also accepts the platform forms 03 and 31, PAYMENTS-FISCAL-1) and
-- the refund batch split check (looked up by definition: 028 declared it inline, so its name is
-- not deterministic; the DO body is invisible to migrations-lint, and that widening is recorded
-- here: the split now also counts platform_amount, and every old row has platform_amount = 0).
-- No backfill and no DML on existing rows (the LD-6 NO FORCE / FORCE wrapper is not needed).
-- Grants (runtime role and worker) live in scripts/grants.sql ("-- 037 payments"), never here.
-- Reuses money_immutable() (028) and cfdi_is_worker() (030) instead of duplicating them.
-- Deploy outside service hours WITH THE WORKER IDLE (PAYMENTS-CONCURRENCY-4): the file takes
-- ACCESS EXCLUSIVE on orders, tenders, refunds, refund_batches, cfdi_documents, cfdi_settings and
-- jobs (ADD/VALIDATE, CREATE POLICY). It takes them all up front, in the runtime's order (orders,
-- then tenders, then jobs), so no later statement upgrades a lock a payment or refund is waiting
-- behind (small tables; lock_timeout 5 s, runner retries). A worker tick holds a jobs claim and
-- then reads orders, the reverse order, which is why the worker must be idle.
SET LOCAL lock_timeout = '5s';
LOCK TABLE orders, tenders, refunds, refund_batches, cfdi_documents, cfdi_settings, jobs
  IN ACCESS EXCLUSIVE MODE;

-- 1. Worker-published platform state (no tenant data), like cfdi_platform.
CREATE TABLE payments_platform(
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  providers text[] NOT NULL DEFAULT '{}'
    CHECK (providers <@ ARRAY['mercadopago','clip']::text[]),
  upload_kid text CHECK (upload_kid ~ '^[a-z0-9-]{1,32}$'),
  upload_public_jwk jsonb CHECK (upload_public_jwk IS NULL OR jsonb_typeof(upload_public_jwk) = 'object'),
  worker_version text NOT NULL CHECK (length(worker_version) BETWEEN 1 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(providers) = 0 OR (upload_kid IS NOT NULL AND upload_public_jwk IS NOT NULL))
);
ALTER TABLE payments_platform ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments_platform FORCE ROW LEVEL SECURITY;
CREATE POLICY payments_platform_read ON payments_platform FOR SELECT USING (true);
CREATE POLICY payments_platform_worker ON payments_platform TO gm_jobs_worker USING (true) WITH CHECK (true);

-- 2. Named terminals. Archived, never deleted (tenders keep a label snapshot anyway).
CREATE TABLE payment_terminals(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  kind text NOT NULL CHECK (kind IN ('manual','mercadopago_point','clip_pinpad')),
  provider_device_id text CHECK (provider_device_id ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  fee_bp integer CHECK (fee_bp BETWEEN 0 AND 2000),
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  archived_by uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  CHECK ((kind = 'manual') = (provider_device_id IS NULL)),
  CHECK ((archived_at IS NULL) = (archived_by IS NULL)),
  CHECK (archived_at IS NULL OR NOT active),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, archived_by) REFERENCES employees(tenant_id, id)
);
CREATE UNIQUE INDEX payment_terminals_device ON payment_terminals(tenant_id, kind, provider_device_id)
  WHERE archived_at IS NULL AND provider_device_id IS NOT NULL;
CREATE UNIQUE INDEX payment_terminals_name ON payment_terminals(tenant_id, lower(btrim(name)))
  WHERE archived_at IS NULL;
-- An archived terminal stays archived (its history keeps the name).
CREATE FUNCTION payment_terminals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment terminals are archived, not deleted' USING ERRCODE = 'restrict_violation'; END IF;
  IF (NEW.tenant_id, NEW.id, NEW.kind, NEW.provider_device_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.kind, OLD.provider_device_id, OLD.created_at, OLD.created_by)
     OR (OLD.archived_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'payment_terminal_immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_terminals_guard BEFORE UPDATE OR DELETE ON payment_terminals
  FOR EACH ROW EXECUTE FUNCTION payment_terminals_guard();

-- 3. Platforms offered at payment, with an estimated commission (never guessed: NULL = not tracked).
--    No row means DISABLED (LD-75, PAYMENTS-SECURITY-1): the owner opts in per platform, and
--    «Otra» stays off until enabled the same way.
CREATE TABLE payment_platforms(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  platform text NOT NULL CHECK (platform IN ('uber_eats','rappi','didi_food','other')),
  enabled boolean NOT NULL DEFAULT false,
  commission_bp integer CHECK (commission_bp BETWEEN 0 AND 5000),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, platform),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id)
);

-- 3b. Per-platform product prices (LD-72). The platform chosen when ringing an order sets its
--     products' prices; NULL (or no row) falls back to the POS price. Modifier prices stay the
--     POS ones. Rows are never deleted: clearing a price sets it NULL.
CREATE TABLE payment_platform_prices(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  product_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('uber_eats','rappi','didi_food','other')),
  price integer CHECK (price BETWEEN 0 AND 100000000),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, product_id, platform),
  FOREIGN KEY (tenant_id, product_id) REFERENCES catalog(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id)
);

-- 4. Default terminal per POS device (server-side, so every browser on a paired device agrees).
--    terminal_id NULL = cleared (rows are never deleted).
CREATE TABLE payment_device_terminals(
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  terminal_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, device_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id),
  FOREIGN KEY (tenant_id, terminal_id) REFERENCES payment_terminals(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id)
);

-- 5. Sealed provider secrets (JWE, opened by the worker only). Same shape and rules as cfdi_secrets.
CREATE TABLE payment_secrets(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('credentials_upload','mp_credentials','clip_credentials')),
  kid text NOT NULL CHECK (kid ~ '^[a-z0-9-]{1,32}$'),
  payload_secret text CHECK (payload_secret IS NULL OR length(payload_secret) BETWEEN 16 AND 32768),
  created_at timestamptz NOT NULL DEFAULT now(),
  wiped_at timestamptz,
  CHECK ((payload_secret IS NULL) = (wiped_at IS NOT NULL)),
  PRIMARY KEY (tenant_id, id)
);
CREATE FUNCTION payment_secrets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment_secrets rows are wiped, not deleted' USING ERRCODE = 'restrict_violation'; END IF;
  IF NOT cfdi_is_worker() THEN RAISE EXCEPTION 'payment_secret_update_worker_only' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.tenant_id, NEW.id, NEW.purpose, NEW.created_at) IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.purpose, OLD.created_at)
     OR OLD.wiped_at IS NOT NULL THEN RAISE EXCEPTION 'payment_secret_immutable'; END IF;
  IF NEW.payload_secret IS NOT NULL AND (OLD.purpose = 'credentials_upload' OR NEW.kid = OLD.kid) THEN
    RAISE EXCEPTION 'payment_secret_reseal_invalid';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_secrets_guard BEFORE UPDATE OR DELETE ON payment_secrets
  FOR EACH ROW EXECUTE FUNCTION payment_secrets_guard();

-- 6. Provider accounts (one per restaurant and provider). hook_hash = sha256 hex of
--    "gm-payments-hook-v1:" || token; the token lives only in the notification URL and, sealed, in
--    the credentials secret (the worker needs it for Clip's per-payment webhook_url).
CREATE TABLE payment_provider_accounts(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  provider text NOT NULL CHECK (provider IN ('mercadopago','clip')),
  state text NOT NULL CHECK (state IN ('verifying','active','failed','disabled')),
  hook_hash text NOT NULL UNIQUE CHECK (hook_hash ~ '^[0-9a-f]{64}$'),
  account_label text CHECK (char_length(account_label) BETWEEN 1 AND 80),
  provider_account_id text CHECK (provider_account_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  upload_secret_id uuid,
  credential_secret_id uuid,
  error_code text CHECK (error_code ~ '^[a-z0-9_]{2,64}$'),
  verified_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CHECK (state <> 'active' OR (credential_secret_id IS NOT NULL AND verified_at IS NOT NULL)),
  PRIMARY KEY (tenant_id, provider),
  FOREIGN KEY (tenant_id, upload_secret_id) REFERENCES payment_secrets(tenant_id, id),
  FOREIGN KEY (tenant_id, credential_secret_id) REFERENCES payment_secrets(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id)
);
-- Only the worker activates an account; the runtime role may set verifying or disabled.
CREATE FUNCTION payment_provider_accounts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment provider accounts are disabled, not deleted' USING ERRCODE = 'restrict_violation'; END IF;
  IF NEW.state = 'active' AND OLD.state IS DISTINCT FROM 'active' AND NOT cfdi_is_worker() THEN
    RAISE EXCEPTION 'payment_account_activation_worker_only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.tenant_id, NEW.provider, NEW.created_at) IS DISTINCT FROM (OLD.tenant_id, OLD.provider, OLD.created_at) THEN
    RAISE EXCEPTION 'payment_account_identity_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_provider_accounts_guard BEFORE UPDATE OR DELETE ON payment_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION payment_provider_accounts_guard();
-- A new account is never born active (the worker activates it after a provider read).
CREATE FUNCTION payment_provider_accounts_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'active' AND NOT cfdi_is_worker() THEN
    RAISE EXCEPTION 'payment_account_activation_worker_only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_provider_accounts_insert_guard BEFORE INSERT ON payment_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION payment_provider_accounts_insert_guard();

-- 7. Devices seen at the provider (worker cache for the setup UI).
CREATE TABLE payment_provider_devices(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  provider text NOT NULL CHECK (provider IN ('mercadopago','clip')),
  device_id text NOT NULL CHECK (device_id ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  operating_mode text CHECK (operating_mode IN ('PDV','STANDALONE')),
  status text CHECK (status IN ('active','inactive','expired','unknown')),
  store_id text CHECK (char_length(store_id) <= 64),
  pos_id text CHECK (char_length(pos_id) <= 64),
  seen_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, provider, device_id)
);

-- 8. Attempts and their event log. Target-agnostic (critic R8): an attempt charges an order
--    (target 'order', the POS) or a kiosk hold (target 'kiosk_hold', 039), whose order_id is set
--    once, null -> value, by the hold settle in the same UPDATE that moves it to 'settled'.
--    origin 'kiosk' has no staff session (the kiosk actor's id is 'kiosk:<uuid>').
CREATE TABLE payment_attempts(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,                              -- provider idempotency key and external reference
  operation_id uuid NOT NULL,                    -- the start command's once() key
  settle_operation_id uuid NOT NULL,             -- server-generated; the tender's once() key (LO-R5)
  target text NOT NULL CHECK (target IN ('order','kiosk_hold')),
  origin text NOT NULL CHECK (origin IN ('pos','kiosk')),
  order_id uuid,
  hold_id uuid,
  terminal_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('mercadopago','clip')),
  provider_device_id text NOT NULL CHECK (provider_device_id ~ '^[A-Za-z0-9_.:-]{1,100}$'),  -- snapshot at start
  terminal_label text NOT NULL CHECK (char_length(terminal_label) BETWEEN 1 AND 40),
  amount integer NOT NULL CHECK (amount BETWEEN 1 AND 100000000),
  tip integer NOT NULL DEFAULT 0 CHECK (tip BETWEEN 0 AND 100000000),
  currency text NOT NULL CHECK (currency = 'MXN'),
  items text[] CHECK (items IS NULL OR cardinality(items) BETWEEN 1 AND 9900),
  employee_id uuid NOT NULL,
  device_id uuid NOT NULL,
  session_id uuid,
  cash_session_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'created' CHECK (state IN ('created','sending','pending','approved','settled',
    'declined','cancelled','expired','unknown','review','dismissed')),
  provider_reference text CHECK (provider_reference ~ '^[A-Za-z0-9_-]{1,100}$'),
  provider_payment_id text CHECK (char_length(provider_payment_id) BETWEEN 1 AND 100),
  provider_status text CHECK (char_length(provider_status) <= 64),
  paid_amount integer CHECK (paid_amount BETWEEN 1 AND 100000000),
  fee integer CHECK (fee >= 0),
  fee_source text CHECK (fee_source IN ('provider','estimated')),
  card_type text CHECK (card_type IN ('credit','debit','prepaid')),
  card_brand text CHECK (card_brand ~ '^[a-z0-9_]{1,20}$'),
  card_last4 text CHECK (card_last4 ~ '^[0-9]{4}$'),
  error_code text CHECK (error_code ~ '^[a-z0-9_]{2,64}$'),
  cancel_requested_at timestamptz,
  cancel_requested_by uuid,
  tender_id uuid,
  resolution text CHECK (resolution IN ('recorded','not_charged','refunded_at_provider')),
  resolution_note text CHECK (char_length(resolution_note) BETWEEN 10 AND 500),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  decided_at timestamptz,
  settled_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  CHECK (target <> 'order' OR (order_id IS NOT NULL AND hold_id IS NULL)),
  CHECK (target <> 'kiosk_hold' OR hold_id IS NOT NULL),
  CHECK ((origin = 'pos') = (session_id IS NOT NULL)),
  CHECK ((fee IS NULL) = (fee_source IS NULL)),
  CHECK ((state = 'settled') = (tender_id IS NOT NULL)),
  CHECK (state <> 'settled' OR order_id IS NOT NULL),
  CHECK (state NOT IN ('approved','settled','review') OR paid_amount IS NOT NULL OR resolution = 'recorded'),
  CHECK ((resolution IS NULL) = (resolved_by IS NULL) AND (resolved_by IS NULL) = (resolved_at IS NULL)),
  CHECK ((cancel_requested_at IS NULL) = (cancel_requested_by IS NULL)),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, settle_operation_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, hold_id) REFERENCES public_order_holds(tenant_id, id),
  FOREIGN KEY (tenant_id, terminal_id) REFERENCES payment_terminals(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id),
  FOREIGN KEY (tenant_id, cash_session_id) REFERENCES cash_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, cancel_requested_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, resolved_by) REFERENCES employees(tenant_id, id)
);
-- A terminal may be showing a charge in these states; an order (and its drawer) may have money in
-- flight in these plus approved and review. The partial unique indexes are the backstop of the
-- start command's checks; every inserter already holds the terminal key (933) plus the order
-- (LO-5) or the hold (LO-2b), so a unique-key wait only meets the same logical start (LO-R8).
CREATE UNIQUE INDEX payment_attempts_terminal_live ON payment_attempts(tenant_id, terminal_id)
  WHERE state IN ('created','sending','pending','unknown');
CREATE UNIQUE INDEX payment_attempts_order_live ON payment_attempts(tenant_id, order_id)
  WHERE order_id IS NOT NULL AND state IN ('created','sending','pending','unknown','approved','review');
CREATE UNIQUE INDEX payment_attempts_hold_live ON payment_attempts(tenant_id, hold_id)
  WHERE hold_id IS NOT NULL AND state IN ('created','sending','pending','unknown','approved','review');
CREATE UNIQUE INDEX payment_attempts_reference ON payment_attempts(tenant_id, provider, lower(provider_reference))
  WHERE provider_reference IS NOT NULL;
CREATE INDEX payment_attempts_open ON payment_attempts(tenant_id, state)
  WHERE state NOT IN ('settled','declined','cancelled','expired','dismissed');
CREATE INDEX payment_attempts_drawer ON payment_attempts(tenant_id, cash_session_id);
CREATE INDEX payment_attempts_created ON payment_attempts(tenant_id, created_at);

-- Monotonic transitions, by actor. Identity columns never change (order_id only null -> value on a
-- kiosk hold's settle); final rows never change. shared/payments.ts ATTEMPT_TRANSITIONS mirrors
-- this table (tests/payments-shared.test.ts parses it from here).
CREATE FUNCTION payment_attempts_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w boolean := cfdi_is_worker(); ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment attempts are never deleted' USING ERRCODE = 'restrict_violation'; END IF;
  IF (NEW.tenant_id, NEW.id, NEW.operation_id, NEW.settle_operation_id, NEW.target, NEW.origin, NEW.hold_id,
      NEW.terminal_id, NEW.provider, NEW.provider_device_id, NEW.terminal_label, NEW.amount, NEW.tip, NEW.currency,
      NEW.items, NEW.employee_id, NEW.device_id, NEW.session_id, NEW.cash_session_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.operation_id, OLD.settle_operation_id, OLD.target, OLD.origin, OLD.hold_id,
      OLD.terminal_id, OLD.provider, OLD.provider_device_id, OLD.terminal_label, OLD.amount, OLD.tip, OLD.currency,
      OLD.items, OLD.employee_id, OLD.device_id, OLD.session_id, OLD.cash_session_id, OLD.created_at) THEN
    RAISE EXCEPTION 'payment_attempt_identity_immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.order_id IS DISTINCT FROM OLD.order_id
     AND NOT (OLD.target = 'kiosk_hold' AND OLD.order_id IS NULL AND NEW.order_id IS NOT NULL
              AND NEW.state = 'settled' AND OLD.state <> 'settled') THEN
    RAISE EXCEPTION 'payment_attempt_identity_immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('settled','declined','cancelled','expired','dismissed') THEN
    RAISE EXCEPTION 'payment_attempt_final' USING ERRCODE = 'check_violation';
  END IF;
  -- The provider's reference is written once, null -> value (PAYMENTS-CONCURRENCY-2): the webhook
  -- lookup, payment_attempts_reference and the integrated tender rely on it staying the provider's.
  -- Outside the worker it is set only by a manager's 'record' resolution, in the same UPDATE that
  -- settles the attempt.
  IF NEW.provider_reference IS DISTINCT FROM OLD.provider_reference
     AND (OLD.provider_reference IS NOT NULL
          OR (NOT w AND NOT (NEW.state = 'settled' AND NEW.resolution = 'recorded'))) THEN
    RAISE EXCEPTION 'payment_attempt_identity_immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;      -- same-state updates (cancel request, poll data)
  ok := CASE
    WHEN w THEN (OLD.state, NEW.state) IN (
      ('created','sending'),('sending','pending'),('sending','declined'),('sending','unknown'),
      ('pending','approved'),('pending','declined'),('pending','cancelled'),('pending','expired'),('pending','unknown'),
      ('unknown','pending'),('unknown','approved'),('unknown','declined'),('unknown','cancelled'),('unknown','expired'))
    ELSE (OLD.state, NEW.state) IN (
      ('created','cancelled'),('approved','settled'),('approved','review'),('review','settled'),
      ('review','dismissed'),('unknown','settled'),('unknown','dismissed'))
  END;
  IF NOT ok THEN RAISE EXCEPTION 'payment_attempt_transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_attempts_transition BEFORE UPDATE OR DELETE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION payment_attempts_transition();
-- An attempt is born 'created' with nothing a provider, the worker or a settle attests
-- (PAYMENTS-CONCURRENCY-1 / SECURITY-6): only the worker's transitions reach approved, and only a
-- settle or a resolution writes the tender and resolution columns, like the accounts' insert guard.
CREATE FUNCTION payment_attempts_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF cfdi_is_worker() THEN RETURN NEW; END IF;
  IF NEW.state <> 'created' OR NEW.version <> 1
     OR NEW.provider_reference IS NOT NULL OR NEW.provider_payment_id IS NOT NULL OR NEW.provider_status IS NOT NULL
     OR NEW.paid_amount IS NOT NULL OR NEW.fee IS NOT NULL OR NEW.fee_source IS NOT NULL
     OR NEW.card_type IS NOT NULL OR NEW.card_brand IS NOT NULL OR NEW.card_last4 IS NOT NULL
     OR NEW.error_code IS NOT NULL OR NEW.cancel_requested_at IS NOT NULL OR NEW.cancel_requested_by IS NOT NULL
     OR NEW.tender_id IS NOT NULL OR NEW.resolution IS NOT NULL OR NEW.resolution_note IS NOT NULL
     OR NEW.resolved_by IS NOT NULL OR NEW.resolved_at IS NOT NULL
     OR NEW.sent_at IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'payment_attempt_insert_created_only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_attempts_insert_guard BEFORE INSERT ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION payment_attempts_insert_guard();

CREATE TABLE payment_attempt_events(
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{2,40}$'),        -- created, sent, provider_status, webhook,
                                                             -- webhook_rejected, cancel_requested, approved,
                                                             -- settled, review, resolved, ...
  actor text NOT NULL CHECK (actor IN ('employee','worker','job')),
  employee_id uuid,
  detail jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object' AND length(detail::text) <= 4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((actor = 'employee') = (employee_id IS NOT NULL)),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES payment_attempts(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX payment_attempt_events_attempt ON payment_attempt_events(tenant_id, attempt_id, created_at);
CREATE TRIGGER payment_attempt_events_immutable BEFORE UPDATE OR DELETE ON payment_attempt_events
  FOR EACH ROW EXECUTE FUNCTION money_immutable();                   -- 028's function
-- Only the worker writes the worker's events (PAYMENTS-CONCURRENCY-1 / SECURITY-6).
CREATE FUNCTION payment_attempt_events_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.actor = 'worker' AND NOT cfdi_is_worker() THEN
    RAISE EXCEPTION 'payment_attempt_event_worker_only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_attempt_events_insert_guard BEFORE INSERT ON payment_attempt_events
  FOR EACH ROW EXECUTE FUNCTION payment_attempt_events_insert_guard();

-- 9. Tenders: platform method, terminal/provider/card/platform/fee columns (all NULL on old rows).
ALTER TABLE tenders
  ADD COLUMN terminal_id uuid,
  ADD COLUMN terminal_label text,
  ADD COLUMN provider text,
  ADD COLUMN provider_reference text,
  ADD COLUMN attempt_id uuid,
  ADD COLUMN card_type text,
  ADD COLUMN card_brand text,
  ADD COLUMN card_last4 text,
  ADD COLUMN platform text,
  ADD COLUMN platform_label text,
  ADD COLUMN fee integer,
  ADD COLUMN fee_source text;
-- 001 declared the method check inline, so PostgreSQL named it tenders_method_check. Refuse to
-- run on a schema where that name is missing instead of silently keeping an unknown check.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenders'::regclass AND contype = 'c'
                   AND conname = 'tenders_method_check') THEN
    RAISE EXCEPTION '037: tenders_method_check not found';
  END IF;
END $$;
ALTER TABLE tenders
  DROP CONSTRAINT tenders_method_check,
  ADD CONSTRAINT tenders_method_check CHECK (method IN ('cash','external','platform')) NOT VALID,
  ADD CONSTRAINT tenders_platform_shape CHECK (
    (method = 'platform') = (platform IS NOT NULL)
    AND (platform IS NULL OR platform IN ('uber_eats','rappi','didi_food','other'))
    AND (platform IS DISTINCT FROM 'other' OR platform_label IS NOT NULL)
    AND (platform_label IS NULL OR (platform = 'other' AND char_length(btrim(platform_label)) BETWEEN 1 AND 40))
    AND (method <> 'platform' OR (tip = 0 AND received = amount))) NOT VALID,
  ADD CONSTRAINT tenders_terminal_shape CHECK (
    (terminal_id IS NULL OR method = 'external')
    AND ((terminal_id IS NULL) = (terminal_label IS NULL))
    AND (terminal_label IS NULL OR char_length(terminal_label) BETWEEN 1 AND 40)) NOT VALID,
  ADD CONSTRAINT tenders_integrated_shape CHECK (
    ((attempt_id IS NULL) = (provider IS NULL))
    AND (provider IS NULL OR (provider IN ('mercadopago','clip') AND terminal_id IS NOT NULL
         AND provider_reference ~ '^[A-Za-z0-9_-]{1,100}$'))
    AND (provider IS NOT NULL OR provider_reference IS NULL)) NOT VALID,
  ADD CONSTRAINT tenders_card_shape CHECK (
    (method = 'external' OR (card_type IS NULL AND card_brand IS NULL AND card_last4 IS NULL))
    AND (card_type IS NULL OR card_type IN ('credit','debit','prepaid'))
    AND (card_brand IS NULL OR card_brand ~ '^[a-z0-9_]{1,20}$')
    AND (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$')) NOT VALID,
  ADD CONSTRAINT tenders_fee_shape CHECK (
    (fee IS NULL) = (fee_source IS NULL) AND (fee IS NULL OR fee >= 0)
    AND (fee_source IS NULL OR fee_source IN ('provider','estimated'))) NOT VALID,
  ADD CONSTRAINT tenders_terminal_fk FOREIGN KEY (tenant_id, terminal_id)
    REFERENCES payment_terminals(tenant_id, id) NOT VALID,
  ADD CONSTRAINT tenders_attempt_fk FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES payment_attempts(tenant_id, id) NOT VALID;
ALTER TABLE tenders VALIDATE CONSTRAINT tenders_method_check;
ALTER TABLE tenders VALIDATE CONSTRAINT tenders_platform_shape;
ALTER TABLE tenders VALIDATE CONSTRAINT tenders_terminal_shape;
ALTER TABLE tenders VALIDATE CONSTRAINT tenders_integrated_shape;
ALTER TABLE tenders VALIDATE CONSTRAINT tenders_card_shape;
ALTER TABLE tenders VALIDATE CONSTRAINT tenders_fee_shape;
ALTER TABLE tenders VALIDATE CONSTRAINT tenders_terminal_fk;
ALTER TABLE tenders VALIDATE CONSTRAINT tenders_attempt_fk;
CREATE UNIQUE INDEX tenders_attempt ON tenders(tenant_id, attempt_id) WHERE attempt_id IS NOT NULL;
CREATE INDEX tenders_terminal ON tenders(tenant_id, terminal_id, created_at) WHERE terminal_id IS NOT NULL;
CREATE INDEX tenders_platform ON tenders(tenant_id, platform, created_at) WHERE platform IS NOT NULL;
-- Circular with tenders_attempt_fk: the settle inserts the tender first (the attempt exists), then
-- sets the attempt's tender_id.
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_tender_fk
  FOREIGN KEY (tenant_id, order_id, tender_id) REFERENCES tenders(tenant_id, order_id, id);

-- 10. Refunds of platform tenders: method value, batch split column and the reconcile trigger.
--     A platform refund has no drawer and no typed reference (refunds_external_reference keeps
--     external_reference for external rows only); refunds_guard (028) still makes the refund's
--     method match its tender's.
ALTER TABLE refunds
  DROP CONSTRAINT refunds_method_valid,
  ADD CONSTRAINT refunds_method_valid CHECK (method IN ('cash','external','platform')) NOT VALID;
ALTER TABLE refunds VALIDATE CONSTRAINT refunds_method_valid;
ALTER TABLE refund_batches ADD COLUMN platform_amount integer NOT NULL DEFAULT 0 CHECK (platform_amount >= 0);
-- Lint-invisible widening (critic R37): 028 declared the split check inline, so its generated name
-- is looked up by definition and replaced by refund_batches_split, which also counts platform_amount
-- (0 on every existing row, so the replacement accepts exactly the rows the old check accepted).
DO $$ DECLARE c text; BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'refund_batches'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%(cash_amount + external_amount) = amount%';
  IF c IS NULL THEN RAISE EXCEPTION '037: refund_batches split check not found'; END IF;
  EXECUTE format('ALTER TABLE refund_batches DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE refund_batches ADD CONSTRAINT refund_batches_split
  CHECK (cash_amount + external_amount + platform_amount = amount) NOT VALID;
ALTER TABLE refund_batches VALIDATE CONSTRAINT refund_batches_split;
-- 028 section 7g verbatim, plus the platform sum compared to NEW.platform_amount.
CREATE OR REPLACE FUNCTION refund_batches_reconcile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; u bigint; l bigint;
BEGIN
  SELECT coalesce(sum(amount),0) AS total,
         coalesce(sum(amount) FILTER (WHERE method = 'cash'),0) AS cash,
         coalesce(sum(amount) FILTER (WHERE method = 'external'),0) AS external,
         coalesce(sum(amount) FILTER (WHERE method = 'platform'),0) AS platform
    INTO r FROM refunds WHERE tenant_id = NEW.tenant_id AND batch_id = NEW.id;
  SELECT coalesce(sum(amount),0) INTO u FROM refund_units WHERE tenant_id = NEW.tenant_id AND batch_id = NEW.id;
  SELECT coalesce(sum(amount),0) INTO l FROM refund_lines WHERE tenant_id = NEW.tenant_id AND batch_id = NEW.id;
  IF r.total <> NEW.amount OR r.cash <> NEW.cash_amount OR r.external <> NEW.external_amount
     OR r.platform <> NEW.platform_amount
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

-- 11. The platform price list an order was rung with (LD-72). NULL = POS prices. Set once at
--     creation; later rounds of the order use the same list.
ALTER TABLE orders ADD COLUMN price_platform text
  CHECK (price_platform IN ('uber_eats','rappi','didi_food','other'));

-- 12. Per-terminal batch totals typed at the drawer close (INSERT-only). terminal_id NULL = tenders
--     recorded without a named terminal ("Otra terminal").
CREATE TABLE drawer_terminal_counts(
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  drawer_id uuid NOT NULL,
  terminal_id uuid,
  expected integer NOT NULL CHECK (expected BETWEEN -100000000 AND 100000000),
  reported integer CHECK (reported BETWEEN 0 AND 100000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, drawer_id) REFERENCES cash_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, terminal_id) REFERENCES payment_terminals(tenant_id, id)
);
CREATE UNIQUE INDEX drawer_terminal_counts_one ON drawer_terminal_counts(tenant_id, drawer_id, terminal_id) NULLS NOT DISTINCT;
CREATE TRIGGER drawer_terminal_counts_immutable BEFORE UPDATE OR DELETE ON drawer_terminal_counts
  FOR EACH ROW EXECUTE FUNCTION money_immutable();
-- No TRUNCATE either, as 028 does for the money tables (PAYMENTS-CONCURRENCY-1).
CREATE TRIGGER payment_attempts_no_truncate BEFORE TRUNCATE ON payment_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION money_immutable();
CREATE TRIGGER payment_attempt_events_no_truncate BEFORE TRUNCATE ON payment_attempt_events
  FOR EACH STATEMENT EXECUTE FUNCTION money_immutable();
CREATE TRIGGER drawer_terminal_counts_no_truncate BEFORE TRUNCATE ON drawer_terminal_counts
  FOR EACH STATEMENT EXECUTE FUNCTION money_immutable();

-- 13. CFDI FormaPago of platform tenders (cfdi 030 table; owner/manager setting; the accountant
--     confirms the default before CFDI goes live). 99 is never offered: green-monkey stamps PUE.
ALTER TABLE cfdi_settings ADD COLUMN platform_payment_form text NOT NULL DEFAULT '31'
  CHECK (platform_payment_form IN ('31','03','04','28'));
-- A credit note's substitute (relation 04, CFDI-SAT-2) may carry the platform forms too
-- (PAYMENTS-FISCAL-1): a platform refund's note is stamped 31 or 03 and must be correctable to
-- either. 030 declared the check on the column, so its name is deterministic; refuse to run on a
-- schema where it is missing.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'cfdi_documents'::regclass AND contype = 'c'
                   AND conname = 'cfdi_documents_payment_form_override_check') THEN
    RAISE EXCEPTION '037: cfdi_documents_payment_form_override_check not found';
  END IF;
END $$;
ALTER TABLE cfdi_documents
  DROP CONSTRAINT cfdi_documents_payment_form_override_check,
  ADD CONSTRAINT cfdi_documents_payment_form_override_check
    CHECK (payment_form_override IN ('01','03','04','28','31')) NOT VALID;
ALTER TABLE cfdi_documents VALIDATE CONSTRAINT cfdi_documents_payment_form_override_check;

-- 14. RLS on the tenant tables.
DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['payment_terminals','payment_platforms','payment_platform_prices','payment_device_terminals',
                         'payment_secrets','payment_provider_accounts','payment_provider_devices','payment_attempts',
                         'payment_attempt_events','drawer_terminal_counts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t);
END LOOP;
END $$;
-- Webhook resolution (pre-auth): a caller that sets app.payment_hook_hash sees exactly that account.
CREATE POLICY payment_hook_lookup ON payment_provider_accounts FOR SELECT
  USING (hook_hash = nullif(current_setting('app.payment_hook_hash', true), ''));
-- ...and, under that same setting, only the attempts of that account's tenant and provider (the
-- webhook matches data.id/id against provider_reference before queuing anything).
CREATE POLICY payment_hook_attempts ON payment_attempts FOR SELECT
  USING (nullif(current_setting('app.payment_hook_hash', true), '') IS NOT NULL
     AND EXISTS (SELECT 1 FROM payment_provider_accounts a
                 WHERE a.hook_hash = current_setting('app.payment_hook_hash', true)
                   AND a.tenant_id = payment_attempts.tenant_id AND a.provider = payment_attempts.provider));

-- 15. Worker discovery of payments worker kinds (SELECT only; claims stay tenant-scoped).
CREATE POLICY jobs_worker_discover_payments ON jobs FOR SELECT TO gm_jobs_worker
  USING (kind IN ('payments_push','payments_poll','payments_cancel','payments_webhook',
                  'payments_credentials','payments_devices','payments_device_mode','payments_wipe'));
