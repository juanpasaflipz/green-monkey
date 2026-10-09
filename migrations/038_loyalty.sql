-- 038_loyalty.sql — loyalty club (LD-71, LD-72; specs/loyalty-w4.md §3.1 with the Wave 4 critic's
-- R20: no kiosk enrolment, so 'kiosk' is not a way to join): program settings, members by phone,
-- an append-only stamp ledger and order links. Expand-only: four new tables; the previous revision
-- never reads them. No DML (no backfill, LD-6 not triggered), no role: grants live in
-- scripts/grants.sql ("-- 038 loyalty"), never here (migrations-lint runtime_role_named). One
-- SECURITY DEFINER trigger function (the ledger, as 025's stock ledger) because the runtime role has
-- no UPDATE on a member's balance columns. Every table forces row-level security; the ledger is
-- append-only by trigger (history), and nothing grants DELETE on any loyalty table.
SET LOCAL lock_timeout = '5s';

-- 1. Settings (row absent = club off with the defaults below) ---------------------------------
CREATE TABLE loyalty_settings (
  tenant_id uuid PRIMARY KEY REFERENCES restaurants(id),
  enabled boolean NOT NULL DEFAULT false,
  program_name text NOT NULL DEFAULT '' CHECK (char_length(program_name) <= 40),
  stamps_required integer NOT NULL DEFAULT 10 CHECK (stamps_required BETWEEN 2 AND 50),
  -- minor units; 0 = always exactly one stamp; default MXN 400.00 (pos-lite stamp_bonus_threshold)
  stamp_threshold integer NOT NULL DEFAULT 40000
    CHECK (stamp_threshold = 0 OR stamp_threshold BETWEEN 1000 AND 10000000),
  max_stamps_per_order integer CHECK (max_stamps_per_order BETWEEN 1 AND 20),
  reward_kind text NOT NULL DEFAULT 'item' CHECK (reward_kind IN ('item', 'amount')),
  reward_description text NOT NULL DEFAULT 'Un producto gratis'
    CHECK (char_length(btrim(reward_description)) BETWEEN 1 AND 80),
  reward_amount integer CHECK (reward_amount BETWEEN 100 AND 1000000),
  reward_max_amount integer CHECK (reward_max_amount BETWEEN 100 AND 1000000),
  max_rewards_per_order integer NOT NULL DEFAULT 1 CHECK (max_rewards_per_order BETWEEN 1 AND 3),
  prompt_at_checkout boolean NOT NULL DEFAULT true,
  receipt_join_qr boolean NOT NULL DEFAULT true,
  link_window_days integer NOT NULL DEFAULT 7 CHECK (link_window_days BETWEEN 1 AND 30),
  privacy_attested_at timestamptz,
  privacy_attested_by uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CHECK ((reward_kind = 'amount') = (reward_amount IS NOT NULL)),
  CHECK (reward_kind = 'item' OR reward_max_amount IS NULL),
  CHECK ((privacy_attested_at IS NULL) = (privacy_attested_by IS NULL)),
  CHECK (NOT enabled OR privacy_attested_at IS NOT NULL),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, privacy_attested_by) REFERENCES employees(tenant_id, id)
);

-- 2. Members ----------------------------------------------------------------------------------
-- Balances (stamps … last_activity_at) are written only by loyalty_ledger_apply(). A member is
-- born with zero balances; every balance comes from the ledger.
CREATE TABLE loyalty_members (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  phone_e164 text CHECK (phone_e164 ~ '^\+(52[0-9]{10}|1[2-9][0-9]{9})$'),
  name text NOT NULL CHECK (char_length(name) <= 60),
  name_key text NOT NULL DEFAULT '' CHECK (char_length(name_key) <= 60), -- lower, accents folded (server)
  joined_at timestamptz NOT NULL DEFAULT now(),
  joined_via text NOT NULL CHECK (joined_via IN ('pos', 'join_qr', 'import')),
  joined_by uuid,
  consent_channel text NOT NULL
    CHECK (consent_channel IN ('staff_attested', 'self_service', 'pos_lite_import')),
  consent_at timestamptz NOT NULL,
  consent_notice_url text CHECK (consent_notice_url IS NULL OR consent_notice_url ~ '^https://'),
  marketing_opt_in boolean NOT NULL DEFAULT false,
  marketing_changed_at timestamptz,
  legacy_source text CHECK (legacy_source = 'pos-lite'),
  legacy_id text CHECK (char_length(legacy_id) BETWEEN 1 AND 64),
  legacy_sms_opt_in boolean,
  legacy_visits integer NOT NULL DEFAULT 0 CHECK (legacy_visits >= 0),
  legacy_spend bigint NOT NULL DEFAULT 0 CHECK (legacy_spend >= 0),        -- minor units
  legacy_last_visit_at timestamptz,
  stamps integer NOT NULL DEFAULT 0,                                       -- may be negative (§2.2.6)
  rewards integer NOT NULL DEFAULT 0 CHECK (rewards >= 0),
  lifetime_stamps integer NOT NULL DEFAULT 0,
  rewards_earned integer NOT NULL DEFAULT 0 CHECK (rewards_earned >= 0),
  rewards_redeemed integer NOT NULL DEFAULT 0 CHECK (rewards_redeemed >= 0),
  last_activity_at timestamptz,
  redacted_at timestamptz,
  redacted_by uuid,
  redaction_reason text CHECK (redaction_reason IN ('arco', 'retention')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, joined_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, redacted_by) REFERENCES employees(tenant_id, id),
  CONSTRAINT loyalty_members_identity CHECK (
    redacted_at IS NOT NULL OR (phone_e164 IS NOT NULL AND char_length(btrim(name)) >= 1)),
  CONSTRAINT loyalty_members_redacted_shape CHECK (
    redacted_at IS NULL OR (phone_e164 IS NULL AND name = '' AND name_key = ''
      AND NOT marketing_opt_in AND consent_notice_url IS NULL AND redaction_reason IS NOT NULL)),
  CHECK ((redacted_at IS NULL) = (redaction_reason IS NULL)),
  CHECK (redaction_reason IS DISTINCT FROM 'arco' OR redacted_by IS NOT NULL),
  CHECK ((joined_via = 'import') = (legacy_source IS NOT NULL AND legacy_id IS NOT NULL)),
  CHECK ((joined_via = 'pos') = (consent_channel = 'staff_attested')),
  CHECK (joined_via <> 'pos' OR joined_by IS NOT NULL),
  CHECK ((joined_via = 'import') = (consent_channel = 'pos_lite_import'))
);
CREATE UNIQUE INDEX loyalty_members_phone ON loyalty_members (tenant_id, phone_e164)
  WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX loyalty_members_legacy ON loyalty_members (tenant_id, legacy_source, legacy_id)
  WHERE legacy_id IS NOT NULL;
CREATE INDEX loyalty_members_name ON loyalty_members (tenant_id, name_key text_pattern_ops)
  WHERE redacted_at IS NULL;
-- Serves the retention predicate (server/ops/retention.ts) and "Última visita" ordering.
CREATE INDEX loyalty_members_inactive ON loyalty_members
  (tenant_id, (coalesce(last_activity_at, legacy_last_visit_at, joined_at))) WHERE redacted_at IS NULL;

CREATE FUNCTION loyalty_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.stamps, NEW.rewards, NEW.lifetime_stamps, NEW.rewards_earned, NEW.rewards_redeemed)
       IS DISTINCT FROM (0, 0, 0, 0, 0) OR NEW.last_activity_at IS NOT NULL OR NEW.redacted_at IS NOT NULL
    THEN RAISE EXCEPTION 'loyalty_member_balances_from_ledger'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.joined_at, NEW.joined_via, NEW.joined_by, NEW.consent_channel,
      NEW.consent_at, NEW.legacy_source, NEW.legacy_id, NEW.legacy_sms_opt_in, NEW.legacy_visits,
      NEW.legacy_spend, NEW.legacy_last_visit_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.joined_at, OLD.joined_via, OLD.joined_by, OLD.consent_channel,
      OLD.consent_at, OLD.legacy_source, OLD.legacy_id, OLD.legacy_sms_opt_in, OLD.legacy_visits,
      OLD.legacy_spend, OLD.legacy_last_visit_at)
  THEN RAISE EXCEPTION 'loyalty_member_immutable'; END IF;
  -- A deleted member's contact, consent and redaction columns never change again.
  IF OLD.redacted_at IS NOT NULL AND
     (NEW.name, NEW.name_key, NEW.phone_e164, NEW.consent_notice_url, NEW.marketing_opt_in,
      NEW.redacted_at, NEW.redacted_by, NEW.redaction_reason)
     IS DISTINCT FROM
     (OLD.name, OLD.name_key, OLD.phone_e164, OLD.consent_notice_url, OLD.marketing_opt_in,
      OLD.redacted_at, OLD.redacted_by, OLD.redaction_reason)
  THEN RAISE EXCEPTION 'loyalty_member_deleted'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER loyalty_members_guard BEFORE INSERT OR UPDATE ON loyalty_members
  FOR EACH ROW EXECUTE FUNCTION loyalty_member_guard();

-- 3. Ledger (append-only; the only writer of member balances) ----------------------------------
CREATE TABLE loyalty_ledger (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  member_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('earn', 'earn_reversal', 'reward_earned', 'reward_unearned',
    'reward_redeemed', 'reward_restored', 'adjustment', 'import')),
  stamps_delta integer NOT NULL CHECK (stamps_delta BETWEEN -1000 AND 1000),
  rewards_delta integer NOT NULL CHECK (rewards_delta BETWEEN -100 AND 100),
  order_id uuid,
  discount_id uuid,
  stamps_required integer CHECK (stamps_required BETWEEN 2 AND 50),
  base integer CHECK (base >= 0),             -- earn/earn_reversal: the order's stamp base used
  -- earn/earn_reversal: the rule the order earns under, from its first earn; later reconciles of
  -- the order (a refund, a relink, a requeue) keep it (§2.2.8: new rules apply to new orders)
  stamp_threshold integer CHECK (stamp_threshold = 0 OR stamp_threshold BETWEEN 1000 AND 10000000),
  max_stamps_per_order integer CHECK (max_stamps_per_order BETWEEN 1 AND 20),
  reason text CHECK (reason ~ '^[a-z_]{2,40}$'),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  actor_id uuid,                               -- null for the reconciler and the join page
  operation_id uuid,
  business_date date,                          -- set by loyalty_ledger_apply()
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES loyalty_members(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id, discount_id) REFERENCES discounts(tenant_id, order_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES employees(tenant_id, id),
  CONSTRAINT loyalty_ledger_shape CHECK (
    (kind = 'earn' AND stamps_delta > 0 AND rewards_delta = 0 AND order_id IS NOT NULL
       AND discount_id IS NULL AND base IS NOT NULL AND stamp_threshold IS NOT NULL) OR
    (kind = 'earn_reversal' AND stamps_delta < 0 AND rewards_delta = 0 AND order_id IS NOT NULL
       AND discount_id IS NULL AND base IS NOT NULL AND stamp_threshold IS NOT NULL) OR
    (kind = 'reward_earned' AND stamps_required IS NOT NULL AND stamps_delta = -stamps_required
       AND rewards_delta = 1) OR
    (kind = 'reward_unearned' AND stamps_required IS NOT NULL AND stamps_delta = stamps_required
       AND rewards_delta = -1) OR
    (kind = 'reward_redeemed' AND stamps_delta = 0 AND rewards_delta = -1 AND order_id IS NOT NULL
       AND discount_id IS NOT NULL) OR
    (kind = 'reward_restored' AND stamps_delta = 0 AND rewards_delta = 1 AND order_id IS NOT NULL
       AND discount_id IS NOT NULL) OR
    (kind = 'adjustment' AND (stamps_delta <> 0 OR rewards_delta <> 0) AND actor_id IS NOT NULL
       AND reason IN ('correction', 'goodwill', 'pos_lite_balance', 'other')
       AND char_length(btrim(note)) >= 3 AND order_id IS NULL AND discount_id IS NULL) OR
    (kind = 'import' AND stamps_delta >= 0 AND rewards_delta >= 0 AND actor_id IS NOT NULL
       AND order_id IS NULL AND discount_id IS NULL))
);
CREATE UNIQUE INDEX loyalty_ledger_redeemed ON loyalty_ledger (tenant_id, discount_id)
  WHERE kind = 'reward_redeemed';
CREATE UNIQUE INDEX loyalty_ledger_restored ON loyalty_ledger (tenant_id, discount_id)
  WHERE kind = 'reward_restored';
CREATE UNIQUE INDEX loyalty_ledger_import ON loyalty_ledger (tenant_id, member_id) WHERE kind = 'import';
CREATE INDEX loyalty_ledger_member ON loyalty_ledger (tenant_id, member_id, created_at DESC);
CREATE INDEX loyalty_ledger_order ON loyalty_ledger (tenant_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX loyalty_ledger_day ON loyalty_ledger (tenant_id, business_date);

-- Applies a ledger row to its member under that member's row lock (FOR NO KEY UPDATE: loyalty's
-- commands already hold it at LO-3, so this is a free re-lock; foreign-key FOR KEY SHARE checks are
-- never blocked, LO-R10). Never used with ON CONFLICT: a skipped insert after a BEFORE trigger
-- would drift the balances (025 §9). The tenant context must be set and match the row (RLS WITH
-- CHECK on the ledger is evaluated only after BEFORE triggers).
CREATE FUNCTION loyalty_ledger_apply() RETURNS trigger
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
      + CASE WHEN NEW.kind IN ('earn','earn_reversal','adjustment','import') THEN NEW.stamps_delta ELSE 0 END,
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
CREATE TRIGGER loyalty_ledger_apply BEFORE INSERT ON loyalty_ledger
  FOR EACH ROW EXECUTE FUNCTION loyalty_ledger_apply();
CREATE FUNCTION loyalty_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'loyalty ledger is append-only'; END $$;
CREATE TRIGGER loyalty_ledger_immutable BEFORE UPDATE OR DELETE ON loyalty_ledger
  FOR EACH ROW EXECUTE FUNCTION loyalty_ledger_immutable();

-- 4. Order links ------------------------------------------------------------------------------
-- At most one member per order, for life; "Quitar cliente" keeps the row with member_id NULL.
-- via 'kiosk' stays: kiosk (039) links a member the diner identified (linkFromKiosk).
CREATE TABLE loyalty_order_links (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  order_id uuid NOT NULL,
  member_id uuid,                                  -- null = removed ("Quitar cliente")
  via text NOT NULL CHECK (via IN ('pos', 'join_qr', 'kiosk')),
  linked_by uuid,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz,
  changed_by uuid,
  PRIMARY KEY (tenant_id, order_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES loyalty_members(tenant_id, id),
  FOREIGN KEY (tenant_id, linked_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, changed_by) REFERENCES employees(tenant_id, id),
  CHECK ((via = 'pos') = (linked_by IS NOT NULL)),
  CHECK ((changed_at IS NULL) = (changed_by IS NULL)),
  CHECK (member_id IS NOT NULL OR changed_at IS NOT NULL)
);
CREATE INDEX loyalty_order_links_member ON loyalty_order_links (tenant_id, member_id, linked_at DESC)
  WHERE member_id IS NOT NULL;
CREATE FUNCTION loyalty_order_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.order_id, NEW.via, NEW.linked_by, NEW.linked_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.order_id, OLD.via, OLD.linked_by, OLD.linked_at)
     OR NEW.changed_at IS NULL OR NEW.changed_at <= coalesce(OLD.changed_at, OLD.linked_at)
  THEN RAISE EXCEPTION 'loyalty_order_link_immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER loyalty_order_links_guard BEFORE UPDATE ON loyalty_order_links
  FOR EACH ROW EXECUTE FUNCTION loyalty_order_link_guard();

-- 5. Row-level security -----------------------------------------------------------------------
ALTER TABLE loyalty_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON loyalty_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE loyalty_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON loyalty_members
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE loyalty_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON loyalty_ledger
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE loyalty_order_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_order_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON loyalty_order_links
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- No lookup policy: the join page resolves its tenant from a sealed token, and the kiosk from its
-- device binding, before touching loyalty rows.
