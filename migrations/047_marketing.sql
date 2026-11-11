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

-- Confirmation integrity (review of PR #31). A row is born unconfirmed and without a
-- challenge; its member and phone never change; once confirmed nothing changes. No login
-- holds UPDATE(confirmed_at): the only writer is marketing_confirm(), which requires the
-- digest of the token that was sent. The runtime role cannot read token_hash (grants).
CREATE FUNCTION marketing_confirmation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.confirmed_at IS NOT NULL OR NEW.token_hash IS NOT NULL THEN
   RAISE EXCEPTION 'marketing confirmation must start unconfirmed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.member_id IS DISTINCT FROM OLD.member_id
    OR NEW.phone_hash IS DISTINCT FROM OLD.phone_hash THEN
  RAISE EXCEPTION 'marketing confirmation identity is immutable' USING ERRCODE = '23514';
 END IF;
 IF OLD.confirmed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'a confirmed phone is immutable' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER marketing_confirmation_guard BEFORE INSERT OR UPDATE ON marketing_confirmations
 FOR EACH ROW EXECUTE FUNCTION marketing_confirmation_guard();
CREATE FUNCTION marketing_confirm(p_member uuid, p_token_hash text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
 scope uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
 found_member uuid;
BEGIN
 IF scope IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
 SELECT c.member_id INTO found_member
  FROM public.marketing_confirmations c
  JOIN public.loyalty_members m ON m.tenant_id = c.tenant_id AND m.id = c.member_id
  WHERE c.tenant_id = scope AND c.member_id = p_member AND c.token_hash = p_token_hash
   AND m.redacted_at IS NULL AND m.marketing_opt_in
   AND c.phone_hash = encode(sha256(convert_to(m.phone_e164, 'UTF8')), 'hex')
   AND c.requested_at > clock_timestamp() - interval '30 days'
  FOR UPDATE OF c;
 IF found_member IS NULL THEN RETURN false; END IF;
 UPDATE public.marketing_confirmations SET confirmed_at = clock_timestamp()
  WHERE tenant_id = scope AND member_id = p_member AND confirmed_at IS NULL;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION marketing_confirm(uuid, text) FROM PUBLIC;

-- Delivery integrity: a message only moves forward. delivered, failed, unknown and skipped
-- are final, so an uncertain send can never be put back in the queue; the provider id and
-- the send time are written once; identity never changes.
CREATE FUNCTION marketing_message_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.member_id IS DISTINCT FROM OLD.member_id OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.channel IS DISTINCT FROM OLD.channel
    OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'marketing message identity is immutable' USING ERRCODE = '23514';
 END IF;
 IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state = 'queued' AND NEW.state IN ('sending','skipped'))
   OR (OLD.state = 'sending' AND NEW.state IN ('sent','failed','unknown'))
   OR (OLD.state = 'sent' AND NEW.state IN ('delivered','failed'))) THEN
  RAISE EXCEPTION 'marketing message cannot go from % to %', OLD.state, NEW.state USING ERRCODE = '23514';
 END IF;
 IF OLD.state IN ('delivered','failed','unknown','skipped') AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'a finished marketing message is immutable' USING ERRCODE = '23514';
 END IF;
 IF (OLD.provider_id IS NOT NULL AND NEW.provider_id IS DISTINCT FROM OLD.provider_id)
    OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at) THEN
  RAISE EXCEPTION 'provider id and send time are written once' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER marketing_message_guard BEFORE UPDATE ON marketing_messages
 FOR EACH ROW EXECUTE FUNCTION marketing_message_guard();
