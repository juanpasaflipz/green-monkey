-- Browser sessions are private to one tenant/provider. Remote browser identifiers are
-- worker-only. Public status never contains cookies, CDP URLs or provider credentials.
SET LOCAL lock_timeout = '5s';
CREATE TABLE delivery_connections (
 tenant_id uuid NOT NULL REFERENCES restaurants(id),
 provider text NOT NULL CHECK(provider IN ('uber_eats','rappi','didi_food')),
 state text NOT NULL DEFAULT 'disconnected' CHECK(state IN
 ('disconnected','preparing','awaiting_login','verifying','choose_store','syncing','connected','attention','disconnecting')),
 generation integer NOT NULL DEFAULT 0,
 consent_version text, consent_at timestamptz, consent_by uuid,
 stores jsonb NOT NULL DEFAULT '[]', store_id text, store_name text,
 login_url text, login_expires_at timestamptz,
 last_synced_at timestamptz, error_code text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,provider)
);
CREATE TABLE delivery_browser_contexts (
 tenant_id uuid NOT NULL, provider text NOT NULL,
 context_id text, session_id text, report_day date,
 operation_token uuid, operation_until timestamptz,
 PRIMARY KEY(tenant_id,provider),
 FOREIGN KEY(tenant_id,provider) REFERENCES delivery_connections(tenant_id,provider)
);
CREATE TABLE delivery_daily_reports (
 tenant_id uuid NOT NULL, provider text NOT NULL, store_id text NOT NULL, day date NOT NULL,
 order_count integer NOT NULL CHECK(order_count>=0), currency text NOT NULL CHECK(currency='MXN'),
 gross bigint NOT NULL, adjusted bigint NOT NULL, payout bigint,
 source_hash text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,provider,store_id,day),
 FOREIGN KEY(tenant_id,provider) REFERENCES delivery_connections(tenant_id,provider)
);
CREATE TABLE delivery_platform (
 id integer PRIMARY KEY CHECK(id=1), available text[] NOT NULL DEFAULT '{}',
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE delivery_platform ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_platform NO FORCE ROW LEVEL SECURITY;
INSERT INTO delivery_platform(id) VALUES(1);
ALTER TABLE delivery_platform FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_read ON delivery_platform FOR SELECT USING(true);
CREATE POLICY platform_worker ON delivery_platform TO gm_jobs_worker USING(true) WITH CHECK(true);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['delivery_connections','delivery_browser_contexts','delivery_daily_reports'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE POLICY jobs_worker_discover_delivery ON jobs FOR SELECT TO gm_jobs_worker
 USING(kind='delivery_browser');
