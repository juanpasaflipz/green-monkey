-- Durable recovery state: no raw reports, cookies, or customer records.
SET LOCAL lock_timeout = '5s';
ALTER TABLE delivery_connections ADD COLUMN store_uuid text;
ALTER TABLE delivery_browser_contexts
 ADD COLUMN download_session_id text,
 ADD COLUMN download_started_at timestamptz,
 ADD COLUMN request_started_at timestamptz,
 ADD COLUMN verified_stores jsonb;
CREATE TABLE delivery_day_attempts (
 tenant_id uuid NOT NULL,
 provider text NOT NULL,
 store_id text NOT NULL,
 day date NOT NULL,
 error_code text,
 attempts integer NOT NULL DEFAULT 1,
 next_attempt_at timestamptz NOT NULL DEFAULT now()+interval '1 day',
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,provider,store_id,day),
 FOREIGN KEY (tenant_id,provider) REFERENCES delivery_connections(tenant_id,provider)
);
ALTER TABLE delivery_day_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_day_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON delivery_day_attempts
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
