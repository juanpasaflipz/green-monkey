-- 022 ops: worker capability roles, jobs consumer columns and guard, billing
-- request inbox, webhook ingest by the runtime role, database-enforced retention
-- predicates, worker heartbeats, grants-manifest registry, hot-path indexes.
-- Expand-only: revision 021 keeps working unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- 1. Capability roles (NOLOGIN). Logins are created by scripts/ops/provision-roles.ts.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['gm_jobs_worker','gm_maintenance','gm_backup_reader'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolcreaterole OR rolsuper)) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', r);
      ELSE
        RAISE EXCEPTION 'missing capability role %: run scripts/ops/provision-roles.ts before migrating', r;
      END IF;
    END IF;
  END LOOP;
END $$;
-- Schema USAGE comes from PUBLIC (PG15+ default) and is also granted explicitly by
-- provisioning as the database owner; the migration role has no grant option.

-- 2. Jobs outbox: lease fencing, attempts cap, completion, guarded transitions.
ALTER TABLE jobs
  ADD COLUMN lease_token uuid,
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 8,
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE jobs ADD CONSTRAINT jobs_max_attempts_range CHECK (max_attempts BETWEEN 1 AND 50);
-- 'queued' is the historical column default and is treated like 'available'.
ALTER TABLE jobs ADD CONSTRAINT jobs_state_known
  CHECK (state IN ('queued','available','running','completed','blocked','dead')) NOT VALID;
ALTER TABLE jobs VALIDATE CONSTRAINT jobs_state_known;
ALTER TABLE jobs ADD CONSTRAINT jobs_running_leased
  CHECK ((state = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)) NOT VALID;
ALTER TABLE jobs VALIDATE CONSTRAINT jobs_running_leased;
ALTER TABLE jobs ADD CONSTRAINT jobs_completed_stamped
  CHECK ((state = 'completed') = (completed_at IS NOT NULL)) NOT VALID;
ALTER TABLE jobs VALIDATE CONSTRAINT jobs_completed_stamped;

CREATE FUNCTION jobs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.kind, NEW.dedupe_key, NEW.payload, NEW.created_at, NEW.max_attempts)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.kind, OLD.dedupe_key, OLD.payload, OLD.created_at, OLD.max_attempts) THEN
    RAISE EXCEPTION 'job_identity_immutable';
  END IF;
  -- Only the worker capability drives the lifecycle. Staff (runtime role) may only
  -- requeue a dead/blocked job or cancel a blocked one.
  IF NOT pg_has_role(current_user, 'gm_jobs_worker', 'MEMBER') THEN
    IF NOT ((OLD.state IN ('dead','blocked') AND NEW.state = 'available')
         OR (OLD.state = 'blocked' AND NEW.state = 'dead')) THEN
      RAISE EXCEPTION 'job_transition_forbidden';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_guard BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION jobs_guard();

CREATE POLICY jobs_worker ON jobs TO gm_jobs_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON jobs TO gm_jobs_worker;
GRANT UPDATE (state, attempts, next_at, lease_until, lease_token, error_code, last_attempt_at, completed_at)
  ON jobs TO gm_jobs_worker;

-- 3. Billing request inbox. Runtime (owner account scope) may only enqueue; the
-- billing worker validates and converts it into billing_operations.
CREATE TABLE billing_requests (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES owner_accounts(id),
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  kind text NOT NULL CHECK (kind IN ('trial','checkout','portal','location_quote','location_confirm')),
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','accepted','rejected')),
  operation_id uuid REFERENCES billing_operations(id),
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CHECK ((state = 'queued') = (processed_at IS NULL)),
  CHECK (state <> 'queued'   OR (operation_id IS NULL AND error_code IS NULL)),
  CHECK (state <> 'accepted' OR (operation_id IS NOT NULL AND error_code IS NULL)),
  CHECK (state <> 'rejected' OR (operation_id IS NULL AND error_code IS NOT NULL))
);
ALTER TABLE billing_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_request_owner_read ON billing_requests FOR SELECT
  USING (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY billing_request_owner_insert ON billing_requests FOR INSERT WITH CHECK (
  account_id = nullif(current_setting('app.account_id', true), '')::uuid
  AND tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  AND state = 'queued' AND operation_id IS NULL AND error_code IS NULL AND processed_at IS NULL
  AND EXISTS (SELECT 1 FROM restaurants r JOIN organizations o ON o.id = r.organization_id
              WHERE r.id = tenant_id AND o.created_by_account = account_id)
);
CREATE POLICY billing_worker ON billing_requests TO gm_billing_worker USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE (state, operation_id, error_code, processed_at) ON billing_requests TO gm_billing_worker;
CREATE FUNCTION billing_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'queued'
     OR (NEW.id, NEW.account_id, NEW.tenant_id, NEW.kind, NEW.payload, NEW.payload_hash, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.account_id, OLD.tenant_id, OLD.kind, OLD.payload, OLD.payload_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'billing_request_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_request_guard BEFORE UPDATE ON billing_requests
  FOR EACH ROW EXECUTE FUNCTION billing_request_guard();

-- 4. Stripe webhook ingest by the runtime role (pointer rows only; worker processes).
CREATE POLICY billing_event_ingest ON billing_events FOR INSERT WITH CHECK (processed_at IS NULL);

-- 5. Retention: permissive policies for gm_maintenance plus a RESTRICTIVE guard that
-- binds every role (including the billing/jobs worker policies) to the predicate.
-- The predicates are mirrored by server/ops/retention.ts (tests compare them).
DO $$
DECLARE
  t text; p text; i int;
  rules text[][] := ARRAY[
    ARRAY['oauth_login_attempts', $p$expires_at < now() - interval '1 day'$p$],
    ARRAY['billing_operations',   $p$kind = 'reconcile' AND state = 'succeeded' AND completed_at < now() - interval '30 days'$p$],
    ARRAY['billing_events',       $p$processed_at IS NOT NULL AND processed_at < now() - interval '90 days'$p$],
    ARRAY['billing_requests',     $p$state <> 'queued' AND processed_at < now() - interval '90 days'$p$],
    ARRAY['jobs',                 $p$(state = 'completed' AND completed_at < now() - interval '30 days') OR (kind = 'receipt' AND state = 'blocked' AND error_code = 'printer_not_paired' AND created_at < now() - interval '30 days')$p$]
  ];
BEGIN
  FOR i IN 1 .. array_length(rules, 1) LOOP
    t := rules[i][1]; p := rules[i][2];
    EXECUTE format('CREATE POLICY retention_read ON %I FOR SELECT TO gm_maintenance USING (%s)', t, p);
    EXECUTE format('CREATE POLICY retention_delete ON %I FOR DELETE TO gm_maintenance USING (%s)', t, p);
    EXECUTE format('CREATE POLICY retention_guard ON %I AS RESTRICTIVE FOR DELETE USING (%s)', t, p);
    EXECUTE format('GRANT SELECT, DELETE ON %I TO gm_maintenance', t);
  END LOOP;
END $$;

-- 6. Worker heartbeats (platform table, no tenant data).
CREATE TABLE ops_heartbeats (
  process text PRIMARY KEY CHECK (process ~ '^[a-z][a-z0-9_-]{1,40}$'),
  instance_id text NOT NULL,
  version text NOT NULL,
  beat_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'
);
ALTER TABLE ops_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_heartbeats FORCE ROW LEVEL SECURITY;
CREATE POLICY heartbeat_read ON ops_heartbeats FOR SELECT USING (true);
CREATE POLICY heartbeat_write ON ops_heartbeats TO gm_jobs_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON ops_heartbeats TO gm_jobs_worker;

-- 7. Grants-manifest registry (platform metadata like schema_migrations; no RLS).
CREATE TABLE schema_grants (
  role_name name NOT NULL,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_name, manifest_hash)
);

-- 8. Hot-path indexes (tables are small on staging; production is new).
CREATE INDEX ops_tender_allocations_order ON tender_allocations (tenant_id, order_id);
CREATE INDEX ops_rounds_open ON rounds (tenant_id, created_at) WHERE state <> 'completed';
CREATE INDEX ops_orders_created ON orders (tenant_id, created_at DESC);
CREATE INDEX ops_tenders_created ON tenders (tenant_id, created_at);
CREATE INDEX ops_tenders_session ON tenders (tenant_id, session_id) WHERE session_id IS NOT NULL;
CREATE INDEX ops_refunds_tender ON refunds (tenant_id, tender_id);
CREATE INDEX ops_refunds_session ON refunds (tenant_id, session_id) WHERE session_id IS NOT NULL;
CREATE INDEX ops_refunds_created ON refunds (tenant_id, created_at);
CREATE INDEX ops_cash_movements_session ON cash_movements (tenant_id, session_id);
CREATE INDEX ops_cash_sessions_device ON cash_sessions (tenant_id, device_id, opened_at DESC);
CREATE INDEX ops_cash_sessions_closed ON cash_sessions (tenant_id, closed_at DESC) WHERE closed_at IS NOT NULL;
CREATE INDEX ops_audit_created ON audit (tenant_id, created_at DESC);
CREATE INDEX ops_jobs_created ON jobs (tenant_id, created_at DESC);
CREATE INDEX ops_jobs_claim ON jobs (next_at, id) WHERE state IN ('available','queued');
CREATE INDEX ops_jobs_lease ON jobs (lease_until) WHERE state = 'running';
CREATE INDEX ops_jobs_done ON jobs (completed_at) WHERE state = 'completed';
CREATE INDEX ops_offline_recoveries_order ON offline_recoveries (tenant_id, order_id);
CREATE INDEX ops_billing_operations_claim ON billing_operations (created_at, id) WHERE state IN ('pending','running');
CREATE INDEX ops_billing_operations_org ON billing_operations (organization_id, created_at DESC);
CREATE INDEX ops_billing_operations_reconciled ON billing_operations (completed_at) WHERE kind = 'reconcile' AND state = 'succeeded';
CREATE INDEX ops_billing_events_pending ON billing_events (subscription_id) WHERE processed_at IS NULL;
CREATE INDEX ops_billing_events_processed ON billing_events (processed_at) WHERE processed_at IS NOT NULL;
CREATE INDEX ops_organization_billing_due ON organization_billing (updated_at) WHERE subscription_id IS NOT NULL;
CREATE INDEX ops_billing_requests_queue ON billing_requests (created_at, id) WHERE state = 'queued';
CREATE INDEX ops_billing_requests_owner ON billing_requests (account_id, tenant_id, created_at DESC);
