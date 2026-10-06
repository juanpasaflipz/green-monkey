-- 030: CFDI 4.0 through Facturapi (cfdi area spec §3): platform status, per-restaurant settings
-- and issuer organization, sealed provider secrets, CSD uploads, documents (invoice/global/egreso)
-- with ticket coverage claims, cancellations, stored XML/PDF, events and global-invoice periods.
--
-- Expand-only: new tables, triggers and indexes on new tables; one SELECT policy on fiscal's
-- fiscal_tickets (self-invoice code lookup), one SELECT policy on ops' jobs (worker discovery,
-- Wave 2.0 `discover`) and one partial index on jobs ((tenant_id, kind, lease_until) of running
-- jobs, LD-8 P-27 and LD-21), all three LAST, because CREATE POLICY / CREATE INDEX hold a strong
-- lock on a busy table until commit (the 030 production deploy runs before 07:00 Mexico City,
-- docs/RUNBOOK.md). No backfill and no DML, so the LD-6 NO FORCE / FORCE wrapper is not needed. No
-- change to existing columns: the previous app revision never reads these tables.
--
-- Grants to gm_jobs_worker live in scripts/grants.sql ("-- 030 cfdi"), never here. The capability
-- role comes from scripts/ops/sql/globals.sql (owner, Wave 2.0); the create-if-missing block below
-- is a no-op there and only creates it where the migrator may (the 011_billing.sql pattern).
--
-- Fiscal 027 (fiscal_tickets) and discounts 028 (refunds.method) always exist when this runs: the
-- sorted runner applies 027 and 028 first. Immutable cfdi records use cfdi's own cfdi_immutable()
-- so 030 does not depend on fiscal's trigger function.
SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gm_jobs_worker') THEN
    CREATE ROLE gm_jobs_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- True for the jobs worker capability (a member of gm_jobs_worker). Guards and restrictive
-- policies name it instead of the runtime role, whose name differs per environment.
CREATE FUNCTION cfdi_is_worker() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT pg_has_role(current_user, 'gm_jobs_worker', 'MEMBER') $$;

-- Fiscal records (CFF art. 30, 5 years): no UPDATE, DELETE or TRUNCATE, even for the owner.
CREATE FUNCTION cfdi_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable fiscal records', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

-- 1. Platform status, written by the worker at boot (cfdi/worker/boot.ts). No tenant data.
CREATE TABLE cfdi_platform(
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider text NOT NULL CHECK (provider IN ('disabled','sandbox_shared','organizations')),
  live_enabled boolean NOT NULL DEFAULT false,
  upload_kid text CHECK (upload_kid ~ '^[a-z0-9-]{1,32}$'),
  upload_public_jwk jsonb CHECK (upload_public_jwk IS NULL OR jsonb_typeof(upload_public_jwk) = 'object'),
  shared_org_id text CHECK (shared_org_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  worker_version text NOT NULL CHECK (length(worker_version) BETWEEN 1 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (provider <> 'organizations' OR (upload_kid IS NOT NULL AND upload_public_jwk IS NOT NULL)),
  CHECK (provider <> 'sandbox_shared' OR shared_org_id IS NOT NULL),
  CHECK (NOT live_enabled OR provider = 'organizations')
);
ALTER TABLE cfdi_platform ENABLE ROW LEVEL SECURITY;
ALTER TABLE cfdi_platform FORCE ROW LEVEL SECURITY;
CREATE POLICY cfdi_platform_read ON cfdi_platform FOR SELECT USING (true);
CREATE POLICY cfdi_platform_worker ON cfdi_platform TO gm_jobs_worker USING (true) WITH CHECK (true);

-- 2. Per-restaurant settings (the owner edits; the worker performs the live switch).
CREATE TABLE cfdi_settings(
  tenant_id uuid PRIMARY KEY REFERENCES restaurants(id),
  enabled boolean NOT NULL DEFAULT true,
  mode text NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
  test_from date NOT NULL,
  live_from date,
  live_enabled_at timestamptz,
  live_enabled_by uuid,
  live_requested_at timestamptz,
  live_requested_from date,
  live_requested_by uuid,
  global_periodicity text NOT NULL DEFAULT 'month' CHECK (global_periodicity IN ('day','week','fortnight','month')),
  next_periodicity text CHECK (next_periodicity IN ('day','week','fortnight','month')),
  next_periodicity_from date CHECK (next_periodicity_from IS NULL OR extract(day FROM next_periodicity_from) = 1),
  global_auto boolean NOT NULL DEFAULT true,
  concept_mode text NOT NULL DEFAULT 'grouped' CHECK (concept_mode IN ('grouped','itemized')),
  concept_description text NOT NULL DEFAULT 'Consumo de alimentos y bebidas'
    CHECK (length(concept_description) BETWEEN 1 AND 200),
  card_payment_form text NOT NULL DEFAULT '04' CHECK (card_payment_form IN ('04','28')),
  default_use text NOT NULL DEFAULT 'G03' CHECK (default_use IN ('G01','G03','S01')),
  self_invoice_enabled boolean NOT NULL DEFAULT true,
  self_invoice_policy text NOT NULL DEFAULT 'month' CHECK (self_invoice_policy IN ('month','days')),
  self_invoice_days smallint NOT NULL DEFAULT 30 CHECK (self_invoice_days BETWEEN 1 AND 90),
  portal_reissue_global boolean NOT NULL DEFAULT false,
  support_email text CHECK (support_email IS NULL OR (length(support_email) <= 254
    AND support_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((mode = 'live') = (live_from IS NOT NULL AND live_enabled_at IS NOT NULL AND live_enabled_by IS NOT NULL)),
  CHECK ((next_periodicity IS NULL) = (next_periodicity_from IS NULL)),
  CHECK ((live_requested_at IS NULL) = (live_requested_from IS NULL)
     AND (live_requested_at IS NULL) = (live_requested_by IS NULL)),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, live_enabled_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, live_requested_by) REFERENCES employees(tenant_id, id)
);

-- The runtime role creates the row in test mode only; the live switch is the worker's (go_live).
CREATE POLICY cfdi_settings_insert ON cfdi_settings AS RESTRICTIVE FOR INSERT
  WITH CHECK (cfdi_is_worker() OR (mode = 'test' AND live_from IS NULL AND live_enabled_at IS NULL
    AND live_requested_at IS NULL));

CREATE FUNCTION cfdi_settings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'cfdi_settings rows are not deleted' USING ERRCODE = 'restrict_violation'; END IF;
  IF OLD.mode = 'live' AND NEW.mode <> 'live' THEN RAISE EXCEPTION 'cfdi_live_is_final'; END IF;
  IF NEW.test_from <> OLD.test_from THEN RAISE EXCEPTION 'cfdi_test_from_immutable'; END IF;
  IF OLD.live_from IS NOT NULL AND NEW.live_from IS DISTINCT FROM OLD.live_from THEN
    RAISE EXCEPTION 'cfdi_live_from_immutable';
  END IF;
  IF (NEW.mode, NEW.live_from, NEW.live_enabled_at, NEW.live_enabled_by)
       IS DISTINCT FROM (OLD.mode, OLD.live_from, OLD.live_enabled_at, OLD.live_enabled_by)
     AND NOT cfdi_is_worker() THEN
    RAISE EXCEPTION 'cfdi_live_switch_worker_only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cfdi_settings_guard BEFORE UPDATE OR DELETE ON cfdi_settings
  FOR EACH ROW EXECUTE FUNCTION cfdi_settings_guard();
CREATE TRIGGER cfdi_settings_no_truncate BEFORE TRUNCATE ON cfdi_settings
  FOR EACH STATEMENT EXECUTE FUNCTION cfdi_immutable();

-- 3. Sealed secrets. The runtime role may only INSERT CSD upload boxes; it cannot read the table
-- (grants.sql revokes SELECT). Organization keys are sealed by the worker (JWE dir+A256GCM, kid).
CREATE TABLE cfdi_secrets(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('csd_upload','org_test_key','org_live_key')),
  kid text NOT NULL CHECK (kid ~ '^[a-z0-9-]{1,32}$'),
  payload_secret text CHECK (payload_secret IS NULL OR length(payload_secret) BETWEEN 16 AND 32768),
  created_at timestamptz NOT NULL DEFAULT now(),
  wiped_at timestamptz,
  CHECK ((payload_secret IS NULL) = (wiped_at IS NOT NULL)),
  PRIMARY KEY (tenant_id, id)
);
CREATE FUNCTION cfdi_secrets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'cfdi_secrets rows are wiped, not deleted' USING ERRCODE = 'restrict_violation'; END IF;
  IF NOT cfdi_is_worker() THEN RAISE EXCEPTION 'cfdi_secret_update_worker_only' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.tenant_id, NEW.id, NEW.purpose, NEW.created_at) IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.purpose, OLD.created_at)
     OR OLD.wiped_at IS NOT NULL THEN
    RAISE EXCEPTION 'cfdi_secret_immutable';
  END IF;
  -- Allowed: wipe (payload -> NULL), or re-seal an organization key under a new kid (cfdi:rekey).
  IF NEW.payload_secret IS NOT NULL AND (OLD.purpose = 'csd_upload' OR NEW.kid = OLD.kid) THEN
    RAISE EXCEPTION 'cfdi_secret_reseal_invalid';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cfdi_secrets_guard BEFORE UPDATE OR DELETE ON cfdi_secrets
  FOR EACH ROW EXECUTE FUNCTION cfdi_secrets_guard();
CREATE TRIGGER cfdi_secrets_no_truncate BEFORE TRUNCATE ON cfdi_secrets
  FOR EACH STATEMENT EXECUTE FUNCTION cfdi_immutable();

-- 4. Issuer organization at Facturapi (one per restaurant; the shared sandbox org in sandbox_shared).
CREATE TABLE cfdi_organizations(
  tenant_id uuid PRIMARY KEY REFERENCES restaurants(id),
  source text NOT NULL CHECK (source IN ('own','shared_sandbox')),
  status text NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning','ready','error')),
  provider_org_id text CHECK (provider_org_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  legal_synced_version integer,
  legal_tax_id text CHECK (length(legal_tax_id) <= 13),
  csd_status text NOT NULL DEFAULT 'missing' CHECK (csd_status IN ('missing','processing','valid','expired','error')),
  csd_serial text CHECK (length(csd_serial) <= 64),
  csd_valid_until timestamptz,
  production_ready boolean NOT NULL DEFAULT false,
  pending_steps jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(pending_steps) = 'array'),
  test_secret_id uuid,
  live_secret_id uuid,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'ready' OR provider_org_id IS NOT NULL),
  CHECK (status <> 'error' OR error_code IS NOT NULL),
  CHECK (source = 'own' OR (test_secret_id IS NULL AND live_secret_id IS NULL)),
  FOREIGN KEY (tenant_id, test_secret_id) REFERENCES cfdi_secrets(tenant_id, id),
  FOREIGN KEY (tenant_id, live_secret_id) REFERENCES cfdi_secrets(tenant_id, id)
);
CREATE POLICY cfdi_organizations_insert ON cfdi_organizations AS RESTRICTIVE FOR INSERT
  WITH CHECK (cfdi_is_worker() OR (status = 'provisioning' AND provider_org_id IS NULL
    AND test_secret_id IS NULL AND live_secret_id IS NULL));
-- `npm run cfdi:rekey` (worker env) lists the restaurants with sealed organization keys across
-- tenants. Only in a transaction that sets app.cfdi_rekey_list = 'on' (the script's listing
-- statement), never in a tenant transaction, so loadOrganization() keeps seeing one row.
CREATE POLICY cfdi_organizations_rekey_list ON cfdi_organizations FOR SELECT TO gm_jobs_worker
  USING (current_setting('app.cfdi_rekey_list', true) = 'on');
CREATE FUNCTION cfdi_worker_update_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% rows are not deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation'; END IF;
  IF NOT cfdi_is_worker() THEN RAISE EXCEPTION '%_update_worker_only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER cfdi_organizations_guard BEFORE UPDATE OR DELETE ON cfdi_organizations
  FOR EACH ROW EXECUTE FUNCTION cfdi_worker_update_only();
CREATE TRIGGER cfdi_organizations_no_truncate BEFORE TRUNCATE ON cfdi_organizations
  FOR EACH STATEMENT EXECUTE FUNCTION cfdi_immutable();

-- 5. CSD uploads (metadata only; the sealed box lives in cfdi_secrets and is wiped after use).
CREATE TABLE cfdi_csd_uploads(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  secret_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','accepted','rejected')),
  cert_serial text CHECK (length(cert_serial) <= 64),
  cert_rfc text CHECK (cert_rfc ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$'),
  cert_valid_from timestamptz,
  cert_valid_until timestamptz,
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'rejected' OR error_code IS NOT NULL),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, secret_id),
  FOREIGN KEY (tenant_id, secret_id) REFERENCES cfdi_secrets(tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES employees(tenant_id, id)
);
CREATE INDEX cfdi_csd_uploads_created ON cfdi_csd_uploads(tenant_id, created_at DESC);
CREATE POLICY cfdi_csd_uploads_insert ON cfdi_csd_uploads AS RESTRICTIVE FOR INSERT
  WITH CHECK (cfdi_is_worker() OR status = 'queued');
CREATE TRIGGER cfdi_csd_uploads_guard BEFORE UPDATE OR DELETE ON cfdi_csd_uploads
  FOR EACH ROW EXECUTE FUNCTION cfdi_worker_update_only();
CREATE TRIGGER cfdi_csd_uploads_no_truncate BEFORE TRUNCATE ON cfdi_csd_uploads
  FOR EACH STATEMENT EXECUTE FUNCTION cfdi_immutable();

-- 6. Documents: one row per CFDI attempt. id = Facturapi idempotency_key and external_id.
CREATE TABLE cfdi_documents(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('invoice','global','egreso')),
  source text NOT NULL CHECK (source IN ('staff','portal','scheduler','reissue','refund','retry')),
  mode text NOT NULL CHECK (mode IN ('test','live')),
  status text NOT NULL CHECK (status IN ('waiting','queued','stamping','pending','valid','failed','canceling','canceled')),
  depends_on uuid,
  replaces_document_id uuid,
  parent_document_id uuid,
  refund_id uuid,
  receptor jsonb CHECK (receptor IS NULL OR jsonb_typeof(receptor) = 'object'),
  receptor_rfc text CHECK (receptor_rfc ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$'),
  card_payment_form text CHECK (card_payment_form IN ('04','28')),
  confirm_pre_start boolean NOT NULL DEFAULT false,
  period_key text CHECK (period_key ~ '^(D[0-9]{4}-[0-9]{2}-[0-9]{2}|W[0-9]{4}-[0-9]{2}-[0-9]{2}|F[0-9]{4}-[0-9]{2}-[12]|M[0-9]{4}-[0-9]{2})$'),
  global_info jsonb CHECK (global_info IS NULL OR jsonb_typeof(global_info) = 'object'),
  part integer CHECK (part >= 1),
  -- Frozen at the first stamping attempt by the worker.
  request jsonb CHECK (request IS NULL OR jsonb_typeof(request) = 'object'),
  payment_form text CHECK (payment_form ~ '^[0-9]{2}$'),
  cfdi_use text CHECK (cfdi_use ~ '^(G0[1-3]|S01|CP01)$'),
  series text CHECK (length(series) BETWEEN 1 AND 25),
  netted_refund_ids uuid[] NOT NULL DEFAULT '{}',
  expected_total integer CHECK (expected_total > 0),
  expected_tax integer CHECK (expected_tax >= 0),
  -- RESICO ISR retention (LD-16 L9): what the provider must withhold; 0 without retention.
  expected_withholding integer NOT NULL DEFAULT 0 CHECK (expected_withholding >= 0),
  concept_count integer CHECK (concept_count BETWEEN 1 AND 5000),
  ticket_count integer CHECK (ticket_count >= 0),
  provider_org_id text,
  -- Provider results.
  provider_invoice_id text CHECK (provider_invoice_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  uuid uuid,
  livemode boolean,
  folio_number integer,
  total integer,
  -- From the stamped XML (cfdi_deliver amount check), written once.
  subtotal integer,
  tax integer,
  withheld integer CHECK (withheld >= 0),
  amount_check text CHECK (amount_check IN ('exact','differs')),
  stamped_at timestamptz,
  verification_url text CHECK (length(verification_url) <= 500),
  emailed_at timestamptz,
  email_error text CHECK (email_error ~ '^[a-z][a-z0-9_]{1,63}$'),
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  error_message text CHECK (length(error_message) <= 1000),
  error_path text CHECK (length(error_path) <= 200),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, depends_on) REFERENCES cfdi_documents(tenant_id, id),
  FOREIGN KEY (tenant_id, replaces_document_id) REFERENCES cfdi_documents(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_document_id) REFERENCES cfdi_documents(tenant_id, id),
  FOREIGN KEY (tenant_id, refund_id) REFERENCES refunds(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES employees(tenant_id, id),
  CHECK (kind <> 'invoice' OR (receptor IS NOT NULL AND receptor_rfc IS NOT NULL AND period_key IS NULL AND refund_id IS NULL)),
  CHECK (kind <> 'global' OR (receptor IS NULL AND period_key IS NOT NULL AND global_info IS NOT NULL
                              AND part IS NOT NULL AND refund_id IS NULL)),
  CHECK (kind <> 'egreso' OR (refund_id IS NOT NULL AND parent_document_id IS NOT NULL AND period_key IS NULL)),
  CHECK (status NOT IN ('valid','canceling','canceled')
         OR (uuid IS NOT NULL AND provider_invoice_id IS NOT NULL AND stamped_at IS NOT NULL AND total IS NOT NULL)),
  CHECK (status <> 'pending' OR provider_invoice_id IS NOT NULL),
  CHECK (status <> 'failed' OR error_code IS NOT NULL),
  CHECK (status <> 'waiting' OR depends_on IS NOT NULL),
  CHECK (livemode IS NULL OR livemode = (mode = 'live')),
  CHECK (source <> 'portal' OR created_by IS NULL)
);
CREATE UNIQUE INDEX cfdi_documents_provider ON cfdi_documents(tenant_id, provider_invoice_id) WHERE provider_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX cfdi_documents_uuid ON cfdi_documents(tenant_id, uuid) WHERE uuid IS NOT NULL;
CREATE UNIQUE INDEX cfdi_documents_refund ON cfdi_documents(tenant_id, refund_id, mode)
  WHERE kind = 'egreso' AND status <> 'failed';
CREATE INDEX cfdi_documents_created ON cfdi_documents(tenant_id, created_at DESC, id);
CREATE INDEX cfdi_documents_open ON cfdi_documents(tenant_id, status, updated_at)
  WHERE status IN ('waiting','queued','stamping','pending','canceling');
-- One document per global part (CFDI-R2-5): the builder and cfdi_reissue number parts under the
-- period key; this backs it.
CREATE UNIQUE INDEX cfdi_documents_period ON cfdi_documents(tenant_id, mode, period_key, part) WHERE kind = 'global';
CREATE INDEX cfdi_documents_depends ON cfdi_documents(tenant_id, depends_on) WHERE depends_on IS NOT NULL;
CREATE INDEX cfdi_documents_parent ON cfdi_documents(tenant_id, parent_document_id) WHERE parent_document_id IS NOT NULL;
CREATE INDEX cfdi_documents_replaces ON cfdi_documents(tenant_id, replaces_document_id) WHERE replaces_document_id IS NOT NULL;
CREATE INDEX cfdi_documents_rfc ON cfdi_documents(tenant_id, receptor_rfc, created_at DESC) WHERE receptor_rfc IS NOT NULL;

-- The runtime role only inserts fresh nominative requests; every later transition is the worker's.
CREATE POLICY cfdi_documents_insert ON cfdi_documents AS RESTRICTIVE FOR INSERT
  WITH CHECK (cfdi_is_worker() OR (status IN ('queued','waiting') AND request IS NULL AND uuid IS NULL
    AND provider_invoice_id IS NULL AND attempts = 0 AND kind = 'invoice'));

CREATE FUNCTION cfdi_documents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'cfdi_documents rows are fiscal records' USING ERRCODE = 'restrict_violation'; END IF;
  IF NOT cfdi_is_worker() THEN RAISE EXCEPTION 'cfdi_document_update_worker_only' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.tenant_id, NEW.id, NEW.kind, NEW.source, NEW.mode, NEW.receptor, NEW.receptor_rfc, NEW.card_payment_form,
      NEW.confirm_pre_start, NEW.period_key, NEW.global_info, NEW.part, NEW.refund_id, NEW.parent_document_id,
      NEW.replaces_document_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.kind, OLD.source, OLD.mode, OLD.receptor, OLD.receptor_rfc, OLD.card_payment_form,
      OLD.confirm_pre_start, OLD.period_key, OLD.global_info, OLD.part, OLD.refund_id, OLD.parent_document_id,
      OLD.replaces_document_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'cfdi_document_identity_immutable';
  END IF;
  IF OLD.request IS NOT NULL AND (NEW.request, NEW.payment_form, NEW.cfdi_use, NEW.series, NEW.netted_refund_ids,
      NEW.expected_total, NEW.expected_tax, NEW.expected_withholding, NEW.concept_count, NEW.ticket_count,
      NEW.provider_org_id)
     IS DISTINCT FROM (OLD.request, OLD.payment_form, OLD.cfdi_use, OLD.series, OLD.netted_refund_ids,
      OLD.expected_total, OLD.expected_tax, OLD.expected_withholding, OLD.concept_count, OLD.ticket_count,
      OLD.provider_org_id) THEN
    RAISE EXCEPTION 'cfdi_document_request_frozen';
  END IF;
  IF OLD.provider_invoice_id IS NOT NULL AND NEW.provider_invoice_id IS DISTINCT FROM OLD.provider_invoice_id THEN
    RAISE EXCEPTION 'cfdi_document_provider_id_immutable';
  END IF;
  IF OLD.uuid IS NOT NULL AND (NEW.uuid, NEW.livemode, NEW.folio_number, NEW.total, NEW.stamped_at)
     IS DISTINCT FROM (OLD.uuid, OLD.livemode, OLD.folio_number, OLD.total, OLD.stamped_at) THEN
    RAISE EXCEPTION 'cfdi_document_stamp_immutable';
  END IF;
  -- Amounts read from the stamped XML are written once (cfdi_deliver's first run).
  IF (OLD.subtotal IS NOT NULL AND NEW.subtotal IS DISTINCT FROM OLD.subtotal)
     OR (OLD.tax IS NOT NULL AND NEW.tax IS DISTINCT FROM OLD.tax)
     OR (OLD.withheld IS NOT NULL AND NEW.withheld IS DISTINCT FROM OLD.withheld)
     OR (OLD.amount_check IS NOT NULL AND NEW.amount_check IS DISTINCT FROM OLD.amount_check) THEN
    RAISE EXCEPTION 'cfdi_document_amounts_immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status, NEW.status) IN (
       ('waiting','queued'), ('waiting','failed'), ('queued','waiting'), ('queued','stamping'), ('queued','failed'),
       ('stamping','pending'), ('stamping','valid'), ('stamping','failed'), ('pending','valid'), ('pending','failed'),
       ('valid','canceling'), ('valid','canceled'), ('canceling','canceled'), ('canceling','valid'))) THEN
    RAISE EXCEPTION 'cfdi_document_transition % -> %', OLD.status, NEW.status;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER cfdi_documents_guard BEFORE UPDATE OR DELETE ON cfdi_documents
  FOR EACH ROW EXECUTE FUNCTION cfdi_documents_guard();
CREATE TRIGGER cfdi_documents_no_truncate BEFORE TRUNCATE ON cfdi_documents
  FOR EACH STATEMENT EXECUTE FUNCTION cfdi_immutable();

-- 7. Coverage claims: which tickets a document covers. One ACTIVE claim per ticket and mode (the DB
-- guarantee that a ticket is in at most one valid CFDI per mode: FIT-6 "excludes tickets already
-- invoiced"). Pending claims (substitution, late-invoice reissue) never conflict with the active one.
CREATE TABLE cfdi_document_tickets(
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('test','live')),
  state text NOT NULL CHECK (state IN ('pending','active','released')),
  released_reason text CHECK (released_reason IN ('failed','canceled','superseded','not_included')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  PRIMARY KEY (tenant_id, document_id, ticket_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES cfdi_documents(tenant_id, id),
  CHECK ((state = 'released') = (released_at IS NOT NULL)),
  CHECK ((state = 'released') = (released_reason IS NOT NULL))
);
CREATE UNIQUE INDEX cfdi_ticket_active_claim ON cfdi_document_tickets(tenant_id, ticket_id, mode) WHERE state = 'active';
CREATE INDEX cfdi_ticket_open_claims ON cfdi_document_tickets(tenant_id, ticket_id) WHERE state <> 'released';
CREATE POLICY cfdi_document_tickets_insert ON cfdi_document_tickets AS RESTRICTIVE FOR INSERT
  WITH CHECK (cfdi_is_worker() OR state IN ('active','pending'));
CREATE FUNCTION cfdi_claims_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc_mode text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'cfdi_document_tickets rows are not deleted' USING ERRCODE = 'restrict_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT mode INTO doc_mode FROM cfdi_documents WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id;
    IF doc_mode IS DISTINCT FROM NEW.mode THEN RAISE EXCEPTION 'cfdi_claim_mode_mismatch'; END IF;
    RETURN NEW;
  END IF;
  IF NOT cfdi_is_worker() THEN RAISE EXCEPTION 'cfdi_claim_update_worker_only' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.tenant_id, NEW.document_id, NEW.ticket_id, NEW.mode, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.document_id, OLD.ticket_id, OLD.mode, OLD.created_at)
     OR OLD.state = 'released'
     OR NOT ((OLD.state, NEW.state) IN (('pending','active'), ('pending','released'), ('active','released'))) THEN
    RAISE EXCEPTION 'cfdi_claim_transition % -> %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cfdi_claims_guard BEFORE INSERT OR UPDATE OR DELETE ON cfdi_document_tickets
  FOR EACH ROW EXECUTE FUNCTION cfdi_claims_guard();
CREATE TRIGGER cfdi_claims_no_truncate BEFORE TRUNCATE ON cfdi_document_tickets
  FOR EACH STATEMENT EXECUTE FUNCTION cfdi_immutable();

-- 8. Cancellation requests.
CREATE TABLE cfdi_cancellations(
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  document_id uuid NOT NULL,
  motive text NOT NULL CHECK (motive IN ('01','02','03','04')),
  substitute_document_id uuid,
  source text NOT NULL CHECK (source IN ('staff','substitution','reissue')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','requested','accepted','rejected','expired','failed')),
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES cfdi_documents(tenant_id, id),
  FOREIGN KEY (tenant_id, substitute_document_id) REFERENCES cfdi_documents(tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES employees(tenant_id, id),
  CHECK ((motive = '01') = (substitute_document_id IS NOT NULL)),
  CHECK (motive <> '04' OR source = 'reissue'),
  CHECK (status <> 'failed' OR error_code IS NOT NULL)
);
CREATE UNIQUE INDEX cfdi_cancellations_open ON cfdi_cancellations(tenant_id, document_id)
  WHERE status IN ('queued','requested');
CREATE INDEX cfdi_cancellations_document ON cfdi_cancellations(tenant_id, document_id, created_at);
CREATE POLICY cfdi_cancellations_insert ON cfdi_cancellations AS RESTRICTIVE FOR INSERT
  WITH CHECK (cfdi_is_worker() OR status = 'queued');
CREATE FUNCTION cfdi_cancellations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'cfdi_cancellations rows are not deleted' USING ERRCODE = 'restrict_violation'; END IF;
  IF NOT cfdi_is_worker() THEN RAISE EXCEPTION 'cfdi_cancellation_update_worker_only' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.tenant_id, NEW.id, NEW.document_id, NEW.motive, NEW.substitute_document_id, NEW.source, NEW.reason,
      NEW.requested_by, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.document_id, OLD.motive, OLD.substitute_document_id, OLD.source,
      OLD.reason, OLD.requested_by, OLD.created_at)
     OR (NEW.status <> OLD.status AND NOT ((OLD.status, NEW.status) IN (
       ('queued','requested'), ('queued','accepted'), ('queued','failed'), ('queued','rejected'),
       ('requested','accepted'), ('requested','rejected'), ('requested','expired'), ('requested','failed')))) THEN
    RAISE EXCEPTION 'cfdi_cancellation_transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cfdi_cancellations_guard BEFORE UPDATE OR DELETE ON cfdi_cancellations
  FOR EACH ROW EXECUTE FUNCTION cfdi_cancellations_guard();
CREATE TRIGGER cfdi_cancellations_no_truncate BEFORE TRUNCATE ON cfdi_cancellations
  FOR EACH STATEMENT EXECUTE FUNCTION cfdi_immutable();

-- 9. Stored XML/PDF and cancellation acuses (CFF art. 30: 5 years). Written once by the worker.
CREATE TABLE cfdi_files(
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  format text NOT NULL CHECK (format IN ('xml','pdf','cancel_xml','cancel_pdf')),
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 20971520),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id, format),
  FOREIGN KEY (tenant_id, document_id) REFERENCES cfdi_documents(tenant_id, id)
);
CREATE TRIGGER cfdi_files_immutable BEFORE UPDATE OR DELETE ON cfdi_files
  FOR EACH ROW EXECUTE FUNCTION cfdi_immutable();
CREATE TRIGGER cfdi_files_no_truncate BEFORE TRUNCATE ON cfdi_files
  FOR EACH STATEMENT EXECUTE FUNCTION cfdi_immutable();

-- 10. Append-only history per document (no secrets, no full receptor data). Worker rows have no actor.
CREATE TABLE cfdi_events(
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  document_id uuid,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{1,63}$'),
  detail jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object'),
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES cfdi_documents(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX cfdi_events_document ON cfdi_events(tenant_id, document_id, created_at);
CREATE INDEX cfdi_events_tenant ON cfdi_events(tenant_id, created_at) WHERE document_id IS NULL;
CREATE TRIGGER cfdi_events_immutable BEFORE UPDATE OR DELETE ON cfdi_events
  FOR EACH ROW EXECUTE FUNCTION cfdi_immutable();
CREATE TRIGGER cfdi_events_no_truncate BEFORE TRUNCATE ON cfdi_events
  FOR EACH STATEMENT EXECUTE FUNCTION cfdi_immutable();

-- 11. Global-invoice periods (scheduler state and register). Written by the worker only.
CREATE TABLE cfdi_global_periods(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  mode text NOT NULL CHECK (mode IN ('test','live')),
  period_key text NOT NULL CHECK (period_key ~ '^(D[0-9]{4}-[0-9]{2}-[0-9]{2}|W[0-9]{4}-[0-9]{2}-[0-9]{2}|F[0-9]{4}-[0-9]{2}-[12]|M[0-9]{4}-[0-9]{2})$'),
  periodicity text NOT NULL CHECK (periodicity IN ('day','week','fortnight','month')),
  date_from date NOT NULL,
  date_to date NOT NULL,
  closes_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','built','empty')),
  built_at timestamptz,
  documents integer NOT NULL DEFAULT 0 CHECK (documents >= 0),
  late_tickets integer NOT NULL DEFAULT 0 CHECK (late_tickets >= 0),
  alerted_at timestamptz,
  CHECK (date_to >= date_from AND date_trunc('month', date_from) = date_trunc('month', date_to)),
  CHECK (due_at = closes_at + interval '24 hours'),
  PRIMARY KEY (tenant_id, mode, period_key)
);
CREATE INDEX cfdi_global_periods_due ON cfdi_global_periods(tenant_id, mode, closes_at) WHERE status = 'open';
CREATE INDEX cfdi_global_periods_dates ON cfdi_global_periods(tenant_id, mode, date_from);
CREATE FUNCTION cfdi_periods_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'cfdi_global_periods rows are not deleted' USING ERRCODE = 'restrict_violation'; END IF;
  IF NOT cfdi_is_worker() THEN RAISE EXCEPTION 'cfdi_global_periods_update_worker_only' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.tenant_id, NEW.mode, NEW.period_key, NEW.periodicity, NEW.date_from, NEW.date_to)
     IS DISTINCT FROM (OLD.tenant_id, OLD.mode, OLD.period_key, OLD.periodicity, OLD.date_from, OLD.date_to) THEN
    RAISE EXCEPTION 'cfdi_period_identity_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cfdi_global_periods_guard BEFORE UPDATE OR DELETE ON cfdi_global_periods
  FOR EACH ROW EXECUTE FUNCTION cfdi_periods_guard();
CREATE TRIGGER cfdi_global_periods_no_truncate BEFORE TRUNCATE ON cfdi_global_periods
  FOR EACH STATEMENT EXECUTE FUNCTION cfdi_immutable();

-- 12. Row-level security on every tenant table (tenant_scope USING + WITH CHECK, forced on the owner).
DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['cfdi_settings','cfdi_secrets','cfdi_organizations','cfdi_csd_uploads','cfdi_documents',
                         'cfdi_document_tickets','cfdi_cancellations','cfdi_files','cfdi_events','cfdi_global_periods'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t);
END LOOP;
END $$;

-- 13. Statements on existing tables, last (see the header).
-- 13a. Claims reference fiscal's tickets, and a caller that sets app.self_invoice_code to a
-- 12-character code sees exactly that one ticket of any tenant (a 60-bit bearer secret printed on
-- the ticket; the self-invoicing portal resolves its tenant this way, never with a definer function).
ALTER TABLE cfdi_document_tickets ADD CONSTRAINT cfdi_document_tickets_ticket
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES fiscal_tickets(tenant_id, id);
CREATE POLICY cfdi_self_invoice_lookup ON fiscal_tickets FOR SELECT
  USING (self_invoice_code = nullif(current_setting('app.self_invoice_code', true), ''));

-- 13b. Worker discovery (Wave 2.0 runner `discover`): the worker login may SEE cfdi jobs of every
-- tenant, to learn which tenants have due work. SELECT only: claimJobs (SELECT … FOR UPDATE, then
-- UPDATE) and every later fenced write still need the tenant_scope policy, so a claim inside tenant
-- A's transaction can never lock or change tenant B's job.
CREATE POLICY jobs_worker_discover ON jobs FOR SELECT TO gm_jobs_worker USING (kind LIKE 'cfdi\_%');

-- 13c. Running jobs whose lease expired are found by worker discovery, the claim's running branch
-- and expireLostJobs (state = 'running' and lease_until < now(), per tenant and kind) without
-- scanning the tenant's done rows of that kind (LD-8, platform P-27; LD-21, RUNBOOK
-- PLATFORM-OPS-10 / PLAT-HR-7; the cfdi DB suite EXPLAINs all three). Built normally (not
-- CONCURRENTLY): 030 deploys before 07:00 Mexico City on a small table.
CREATE INDEX jobs_running_lease_until ON jobs (tenant_id, kind, lease_until) WHERE state = 'running';
