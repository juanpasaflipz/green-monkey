-- Guest marketing on the loyalty club: campaigns and daily automations for members
-- who opted in AND confirmed their phone (LOYALTY-PRIVACY-7), durable delivery
-- records and a per-day automation run. No row stores a phone or a message body.
SET LOCAL lock_timeout = '5s';
CREATE TABLE marketing_settings (
 tenant_id uuid PRIMARY KEY REFERENCES restaurants(id),
 settings jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(settings)='object'),
 version integer NOT NULL DEFAULT 1 CHECK(version>0)
);
-- Double opt-in: a confirmation is bound to the phone it was sent to (phone_hash).
CREATE TABLE marketing_confirmations (
 tenant_id uuid NOT NULL REFERENCES restaurants(id), member_id uuid NOT NULL,
 phone_hash text NOT NULL CHECK(phone_hash ~ '^[a-f0-9]{64}$'),
 token_hash text CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 confirmed_at timestamptz,
 PRIMARY KEY(tenant_id,member_id),
 FOREIGN KEY(tenant_id,member_id) REFERENCES loyalty_members(tenant_id,id)
);
CREATE TABLE marketing_campaigns (
 tenant_id uuid NOT NULL REFERENCES restaurants(id), id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 kind text NOT NULL CHECK(kind IN ('one_off','automation')),
 automation_key text CHECK(automation_key IN ('miss_you','repeat_guest','big_spender','follow_up','drive_qr','drive_dine_in')),
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 80),
 channels text[] NOT NULL CHECK(cardinality(channels) BETWEEN 1 AND 2 AND channels <@ ARRAY['sms','whatsapp']),
 body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 600),
 segment jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(segment)='object'),
 params jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(params)='object'),
 state text NOT NULL CHECK(state IN ('draft','scheduled','sending','sent','cancelled','active','paused')),
 scheduled_at timestamptz, launched_at timestamptz, audience integer CHECK(audience>=0),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES employees(tenant_id,id),
 CHECK((kind='automation')=(automation_key IS NOT NULL)),
 CHECK(kind<>'automation' OR state IN ('active','paused')),
 CHECK(kind<>'one_off' OR state NOT IN ('active','paused')),
 CHECK((state='scheduled')=(scheduled_at IS NOT NULL AND launched_at IS NULL))
);
CREATE UNIQUE INDEX marketing_automation ON marketing_campaigns(tenant_id,automation_key) WHERE automation_key IS NOT NULL;
CREATE TABLE marketing_messages (
 tenant_id uuid NOT NULL REFERENCES restaurants(id), id uuid NOT NULL,
 member_id uuid NOT NULL, campaign_id uuid,
 kind text NOT NULL CHECK(kind IN ('campaign','automation','confirmation')),
 channel text NOT NULL CHECK(channel IN ('sms','whatsapp')),
 dedupe_key text NOT NULL CHECK(char_length(dedupe_key) BETWEEN 1 AND 200),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','sent','delivered','failed','unknown','skipped')),
 provider_id text, error_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 sent_at timestamptz,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,dedupe_key),
 FOREIGN KEY(tenant_id,member_id) REFERENCES loyalty_members(tenant_id,id),
 FOREIGN KEY(tenant_id,campaign_id) REFERENCES marketing_campaigns(tenant_id,id),
 CHECK((kind='confirmation')=(campaign_id IS NULL))
);
CREATE INDEX marketing_messages_member ON marketing_messages(tenant_id,member_id,created_at);
CREATE INDEX marketing_messages_campaign ON marketing_messages(tenant_id,campaign_id) WHERE campaign_id IS NOT NULL;
-- One automation evaluation per restaurant per local calendar day.
CREATE TABLE marketing_runs (
 tenant_id uuid NOT NULL REFERENCES restaurants(id), local_date date NOT NULL,
 window_start timestamptz NOT NULL, window_end timestamptz NOT NULL,
 queued integer NOT NULL DEFAULT 0 CHECK(queued>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,local_date), CHECK(window_start<window_end)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['marketing_settings','marketing_confirmations','marketing_campaigns','marketing_messages','marketing_runs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE POLICY jobs_worker_discover_marketing ON jobs FOR SELECT TO gm_jobs_worker
 USING(kind = 'marketing_message');
-- A confirmation dies with what it confirmed: a changed phone, a withdrawn opt-in
-- or a deleted member. Only this trigger may delete the row.
CREATE FUNCTION marketing_confirmation_void() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
DECLARE prior_scope text := current_setting('app.tenant_id',true);
BEGIN
 IF NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164
    OR (OLD.marketing_opt_in AND NOT NEW.marketing_opt_in)
    OR (NEW.redacted_at IS NOT NULL AND OLD.redacted_at IS NULL) THEN
  PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
  DELETE FROM public.marketing_confirmations WHERE tenant_id=NEW.tenant_id AND member_id=NEW.id;
  PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION marketing_confirmation_void() FROM PUBLIC;
CREATE TRIGGER marketing_confirmation_void AFTER UPDATE OF phone_e164,marketing_opt_in,redacted_at ON loyalty_members
 FOR EACH ROW EXECUTE FUNCTION marketing_confirmation_void();
