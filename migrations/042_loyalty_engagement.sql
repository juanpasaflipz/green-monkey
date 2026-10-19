-- Loyalty engagement: referrals, revocable digital cards and durable delivery records.
SET LOCAL lock_timeout = '5s';
CREATE TABLE loyalty_engagement_settings (
 tenant_id uuid PRIMARY KEY REFERENCES restaurants(id),
 settings jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(settings)='object'),
 version integer NOT NULL DEFAULT 1 CHECK(version>0)
);
CREATE TABLE loyalty_member_cards (
 tenant_id uuid NOT NULL REFERENCES restaurants(id), member_id uuid NOT NULL,
 access_hash text NOT NULL, scan_token text NOT NULL CHECK(scan_token ~ '^[a-f0-9]{32}$'),
 referral_code text NOT NULL CHECK(referral_code ~ '^[A-F0-9]{16}$'),
 revoked_at timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,member_id), UNIQUE(tenant_id,scan_token), UNIQUE(tenant_id,referral_code),
 FOREIGN KEY(tenant_id,member_id) REFERENCES loyalty_members(tenant_id,id)
);
CREATE TABLE loyalty_referrals (
 tenant_id uuid NOT NULL REFERENCES restaurants(id), member_id uuid NOT NULL, referrer_id uuid NOT NULL,
 bonus integer NOT NULL CHECK(bonus BETWEEN 1 AND 20), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,member_id), CHECK(member_id<>referrer_id),
 FOREIGN KEY(tenant_id,member_id) REFERENCES loyalty_members(tenant_id,id),
 FOREIGN KEY(tenant_id,referrer_id) REFERENCES loyalty_members(tenant_id,id)
);
CREATE TABLE loyalty_messages (
 tenant_id uuid NOT NULL REFERENCES restaurants(id), id uuid NOT NULL, member_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('welcome','stamp','reward','referral','reminder')),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','sent','delivered','failed','unknown','skipped')),
 provider_id text, error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,member_id) REFERENCES loyalty_members(tenant_id,id)
);
CREATE TABLE loyalty_wallet_devices (
 tenant_id uuid NOT NULL REFERENCES restaurants(id), member_id uuid NOT NULL,
 device_hash text NOT NULL, push_token text NOT NULL, unregistered_at timestamptz,
 PRIMARY KEY(tenant_id,member_id,device_hash),
 FOREIGN KEY(tenant_id,member_id) REFERENCES loyalty_members(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['loyalty_engagement_settings','loyalty_member_cards','loyalty_referrals','loyalty_messages','loyalty_wallet_devices'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
-- Keep all existing ledger shapes, adding an explicit automated referral posting.
DO $$ DECLARE expression text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint
 WHERE conrelid='loyalty_ledger'::regclass AND conname='loyalty_ledger_kind_check';
 ALTER TABLE loyalty_ledger DROP CONSTRAINT loyalty_ledger_kind_check;
 EXECUTE 'ALTER TABLE loyalty_ledger ADD CONSTRAINT loyalty_ledger_kind_check CHECK (('||expression||') OR kind=''referral_bonus'')';
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint
 WHERE conrelid='loyalty_ledger'::regclass AND conname='loyalty_ledger_shape';
 ALTER TABLE loyalty_ledger DROP CONSTRAINT loyalty_ledger_shape;
 EXECUTE 'ALTER TABLE loyalty_ledger ADD CONSTRAINT loyalty_ledger_shape CHECK (('||expression||') OR (kind=''referral_bonus'' AND stamps_delta BETWEEN 1 AND 20 AND rewards_delta=0 AND order_id IS NULL AND discount_id IS NULL AND reason=''referral''))';
END $$;
CREATE POLICY jobs_worker_discover_loyalty ON jobs FOR SELECT TO gm_jobs_worker
 USING(kind IN ('loyalty_message','loyalty_wallet_sync'));

CREATE OR REPLACE FUNCTION loyalty_ledger_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  scope uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  m record;
BEGIN
  IF scope IS NULL OR scope IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'loyalty ledger outside the current tenant' USING ERRCODE = '42501';
  END IF;
  SELECT redacted_at INTO m FROM public.loyalty_members
   WHERE tenant_id = NEW.tenant_id AND id = NEW.member_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'loyalty member % not found', NEW.member_id USING ERRCODE = '23503'; END IF;
  IF m.redacted_at IS NOT NULL THEN RAISE EXCEPTION 'loyalty_member_deleted'; END IF;
  NEW.business_date := public.business_date_at(NEW.tenant_id, NEW.created_at);
  UPDATE public.loyalty_members SET
    stamps = stamps + NEW.stamps_delta,
    rewards = rewards + NEW.rewards_delta,           -- CHECK (rewards >= 0) refuses an overdraw
    lifetime_stamps = lifetime_stamps
      + CASE WHEN NEW.kind IN ('earn','earn_reversal','adjustment','import','referral_bonus') THEN NEW.stamps_delta ELSE 0 END,
    rewards_earned = rewards_earned
      + CASE WHEN NEW.kind IN ('reward_earned','reward_unearned') THEN NEW.rewards_delta
             WHEN NEW.kind IN ('import','adjustment') AND NEW.rewards_delta > 0 THEN NEW.rewards_delta
             ELSE 0 END,
    rewards_redeemed = rewards_redeemed
      + CASE WHEN NEW.kind IN ('reward_redeemed','reward_restored') THEN -NEW.rewards_delta ELSE 0 END,
    last_activity_at = CASE WHEN NEW.kind = 'import' THEN last_activity_at ELSE NEW.created_at END
  WHERE tenant_id = NEW.tenant_id AND id = NEW.member_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION loyalty_ledger_apply() FROM PUBLIC;
CREATE TABLE loyalty_wallet_passes (
 tenant_id uuid NOT NULL REFERENCES restaurants(id),member_id uuid NOT NULL,
 generation_hash text NOT NULL, apple_auth_hash text, apple_pass_secret text,google_url_secret text,
 sync_job_id uuid,sync_until timestamptz,
 pass_type text,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,member_id),FOREIGN KEY(tenant_id,member_id) REFERENCES loyalty_members(tenant_id,id)
);
ALTER TABLE loyalty_wallet_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_wallet_passes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON loyalty_wallet_passes
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
-- Redaction also removes device tokens and invalidates cards. Only the trigger may execute this.
CREATE FUNCTION loyalty_engagement_redact() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
DECLARE prior_scope text := current_setting('app.tenant_id',true);
BEGIN
 IF NEW.redacted_at IS NOT NULL AND OLD.redacted_at IS NULL THEN
  PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
  DELETE FROM public.loyalty_wallet_devices WHERE tenant_id=NEW.tenant_id AND member_id=NEW.id;
  UPDATE public.loyalty_member_cards SET revoked_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE tenant_id=NEW.tenant_id AND member_id=NEW.id;
  INSERT INTO public.jobs(tenant_id,id,kind,dedupe_key,payload,state,next_at)
   VALUES(NEW.tenant_id,gen_random_uuid(),'loyalty_wallet_sync','redact:'||NEW.id::text,
    jsonb_build_object('memberId',NEW.id),'available',now())
   ON CONFLICT(tenant_id,kind,dedupe_key) DO NOTHING;
  PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION loyalty_engagement_redact() FROM PUBLIC;
CREATE TRIGGER loyalty_engagement_redact AFTER UPDATE OF redacted_at ON loyalty_members
 FOR EACH ROW EXECUTE FUNCTION loyalty_engagement_redact();
