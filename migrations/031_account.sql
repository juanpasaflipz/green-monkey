-- 031_account.sql — legal acceptance, co-owners, ownership transfer, recovery codes,
-- vendor support role grants, restaurant privacy URL / Free-selection mode and the
-- SaaS billing (tax) profile.
-- Expand-only: new tables, columns and policies, looser CHECKs and one same-name policy
-- replacement (owner_restaurant_read now ignores revoked memberships). No data rewrite,
-- no backfill (LD-6 does not apply) and no SECURITY DEFINER function.
--
-- RLS rule for the account and organization tables (docs/ACCOUNT_AND_LEGAL.md): their
-- policies are sub-link-free "leaf" predicates over transaction-local GUCs
-- (app.account_id, app.organization_id, app.transfer_id, app.transfer_hash,
-- app.invitation_hash, app.recovery_lookup, app.recovery_account_id), which avoids the
-- policy-rewrite recursion of migrations 009 and 017. The server sets app.organization_id
-- only after organizationScope() verified a primary or active co-owner, or after a
-- verified invitation or transfer token.
-- NEVER add a sub-link-bearing SELECT policy to owner_memberships,
-- organization_co_owners, ownership_transfers or account_recovery_codes, and NEVER
-- reference owner_accounts from another table's policy (owner_accounts_org_read below
-- has sub-links, so a reference back would form a cycle).
SET LOCAL lock_timeout = '5s';

-- gm_support is created by the owner-run scripts/ops/sql/globals.sql before migrations
-- (gm_migrator is NOCREATEROLE). This block is a no-op there; it only helps local or CI
-- clusters whose migrator may create roles (011_billing.sql pattern).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gm_support') THEN
    CREATE ROLE gm_support NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

CREATE FUNCTION account_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;

-- Session freshness for sensitive account commands; NULL (sessions issued before 031)
-- counts as stale. Two statements so existing rows stay NULL instead of taking now().
ALTER TABLE owner_sessions ADD COLUMN created_at timestamptz;
ALTER TABLE owner_sessions ALTER COLUMN created_at SET DEFAULT now();

-- Vendor support audit log (written only by gm_support logins) -----------------------
CREATE TABLE support_actions (
  id uuid PRIMARY KEY,
  operator_login text NOT NULL,
  operator_label text NOT NULL CHECK (length(operator_label) BETWEEN 2 AND 80),
  ticket text NOT NULL CHECK (length(ticket) BETWEEN 3 AND 100),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  action text NOT NULL CHECK (action IN ('lookup','unlock_employee','grant_entitlement',
    'end_entitlement','transfer_ownership','cancel_transfer','set_free_device')),
  organization_id uuid REFERENCES organizations(id),
  tenant_id uuid REFERENCES restaurants(id),
  target jsonb NOT NULL DEFAULT '{}'::jsonb,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_actions_organization ON support_actions(organization_id, created_at DESC);
CREATE FUNCTION support_action_operator() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.operator_login := session_user;
  NEW.created_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER support_action_operator BEFORE INSERT ON support_actions
  FOR EACH ROW EXECUTE FUNCTION support_action_operator();
CREATE TRIGGER support_actions_append_only BEFORE UPDATE OR DELETE ON support_actions
  FOR EACH ROW EXECUTE FUNCTION account_append_only();

-- Versioned legal acceptance (append-only evidence) -----------------------------------
CREATE TABLE legal_acceptances (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES owner_accounts(id),
  owner_session_id uuid NOT NULL,
  document text NOT NULL CHECK (document IN ('terms','privacy','dpa')),
  version text NOT NULL CHECK (version ~ '^\d{4}-\d{2}-\d{2}(\.\d+)?$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  entity_hash text NOT NULL CHECK (entity_hash ~ '^[a-f0-9]{64}$'),
  published boolean NOT NULL,
  locale text NOT NULL CHECK (locale IN ('es','en')),
  context text NOT NULL CHECK (context IN ('signup','invitation','reacceptance','transfer')),
  organization_id uuid REFERENCES organizations(id),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, owner_session_id) REFERENCES owner_sessions(account_id, id),
  CHECK ((document = 'dpa') = (organization_id IS NOT NULL))
);
CREATE INDEX legal_acceptances_account ON legal_acceptances(account_id, document, accepted_at DESC);
CREATE INDEX legal_acceptances_organization ON legal_acceptances(organization_id, accepted_at DESC)
  WHERE organization_id IS NOT NULL;
CREATE TRIGGER legal_acceptances_append_only BEFORE UPDATE OR DELETE ON legal_acceptances
  FOR EACH ROW EXECUTE FUNCTION account_append_only();

-- Ownership transfers (owner-, support- or recovery-initiated) ------------------------
CREATE TABLE ownership_transfers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  from_account_id uuid NOT NULL REFERENCES owner_accounts(id),
  to_email text NOT NULL CHECK (to_email = lower(btrim(to_email)) AND length(to_email) BETWEEN 3 AND 254),
  to_account_id uuid REFERENCES owner_accounts(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  initiated_by text NOT NULL CHECK (initiated_by IN ('owner','support','recovery_code')),
  support_action_id uuid REFERENCES support_actions(id),
  previous_owner_stays boolean NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed','canceled')),
  available_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  canceled_at timestamptz,
  canceled_by text CHECK (canceled_by IN ('owner','target','support','expired')),
  CHECK (expires_at > available_at),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((state = 'canceled') = (canceled_at IS NOT NULL AND canceled_by IS NOT NULL)),
  CHECK (state <> 'completed' OR to_account_id IS NOT NULL),
  CHECK ((initiated_by = 'support') = (support_action_id IS NOT NULL)),
  CHECK (initiated_by <> 'recovery_code' OR (to_account_id IS NOT NULL AND NOT previous_owner_stays)),
  CHECK (to_account_id IS DISTINCT FROM from_account_id)
);
CREATE UNIQUE INDEX one_pending_transfer ON ownership_transfers(organization_id) WHERE state = 'pending';
CREATE INDEX ownership_transfers_to ON ownership_transfers(to_account_id) WHERE state = 'pending';
-- One transition (pending -> completed or canceled), plus filling to_account_id once.
CREATE FUNCTION ownership_transfer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ownership_transfers is append-only'; END IF;
  IF OLD.state <> 'pending'
     OR (NEW.id, NEW.organization_id, NEW.from_account_id, NEW.to_email, NEW.token_hash,
         NEW.initiated_by, NEW.support_action_id, NEW.previous_owner_stays,
         NEW.available_at, NEW.expires_at, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.organization_id, OLD.from_account_id, OLD.to_email, OLD.token_hash,
         OLD.initiated_by, OLD.support_action_id, OLD.previous_owner_stays,
         OLD.available_at, OLD.expires_at, OLD.created_at)
     OR (OLD.to_account_id IS NOT NULL AND NEW.to_account_id IS DISTINCT FROM OLD.to_account_id) THEN
    RAISE EXCEPTION 'ownership_transfer_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ownership_transfer_guard BEFORE UPDATE OR DELETE ON ownership_transfers
  FOR EACH ROW EXECUTE FUNCTION ownership_transfer_guard();

-- Co-owners (organization level). The primary stays organizations.created_by_account.
CREATE TABLE organization_co_owners (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid NOT NULL REFERENCES owner_accounts(id),
  added_by uuid NOT NULL REFERENCES owner_accounts(id),
  source text NOT NULL CHECK (source IN ('invitation','transfer')),
  invitation_id uuid REFERENCES restaurant_invitations(id),
  transfer_id uuid REFERENCES ownership_transfers(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by uuid REFERENCES owner_accounts(id),
  removal text CHECK (removal IN ('removed','left','promoted')),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  CHECK ((removed_at IS NULL) = (removal IS NULL)),
  CHECK ((source = 'invitation') = (invitation_id IS NOT NULL)),
  CHECK ((source = 'transfer') = (transfer_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_co_owner ON organization_co_owners(organization_id, account_id)
  WHERE removed_at IS NULL;
CREATE INDEX co_owners_account ON organization_co_owners(account_id) WHERE removed_at IS NULL;
CREATE FUNCTION co_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'organization_co_owners is append-only'; END IF;
  IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
     OR (NEW.id, NEW.organization_id, NEW.account_id, NEW.added_by, NEW.source,
         NEW.invitation_id, NEW.transfer_id, NEW.added_at)
        IS DISTINCT FROM
        (OLD.id, OLD.organization_id, OLD.account_id, OLD.added_by, OLD.source,
         OLD.invitation_id, OLD.transfer_id, OLD.added_at) THEN
    RAISE EXCEPTION 'co_owner_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER co_owner_guard BEFORE UPDATE OR DELETE ON organization_co_owners
  FOR EACH ROW EXECUTE FUNCTION co_owner_guard();

-- Recovery codes: lookup in clear, 80-bit secret stored with scrypt (salt:key, the
-- format of server/access.ts hashSecret()).
CREATE TABLE account_recovery_codes (
  account_id uuid NOT NULL REFERENCES owner_accounts(id),
  lookup text NOT NULL UNIQUE CHECK (lookup ~ '^[0-9A-HJKMNP-TV-Z]{8}$'),
  secret_hash text NOT NULL,
  batch_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  used_by_account uuid REFERENCES owner_accounts(id),
  used_for_transfer uuid REFERENCES ownership_transfers(id) DEFERRABLE INITIALLY DEFERRED,
  revoked_at timestamptz,
  PRIMARY KEY (account_id, lookup),
  CHECK ((used_at IS NULL) = (used_by_account IS NULL)),
  CHECK ((used_at IS NULL) = (used_for_transfer IS NULL)),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);
CREATE FUNCTION recovery_code_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'account_recovery_codes is append-only'; END IF;
  IF (NEW.account_id, NEW.lookup, NEW.secret_hash, NEW.batch_id, NEW.created_at)
       IS DISTINCT FROM (OLD.account_id, OLD.lookup, OLD.secret_hash, OLD.batch_id, OLD.created_at)
     OR OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'recovery_code_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_code_guard BEFORE UPDATE OR DELETE ON account_recovery_codes
  FOR EACH ROW EXECUTE FUNCTION recovery_code_guard();

-- Organization/account-level audit trail (tenant audit.actor_id must be an employee).
CREATE TABLE account_events (
  id uuid PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id),
  actor_account_id uuid NOT NULL REFERENCES owner_accounts(id),
  subject_account_id uuid REFERENCES owner_accounts(id),
  kind text NOT NULL CHECK (kind IN ('co_owner_invited','co_owner_added','co_owner_removed',
    'co_owner_left','transfer_requested','transfer_canceled','transfer_completed',
    'recovery_codes_generated','recovery_code_redeemed','tax_profile_updated')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_events_organization ON account_events(organization_id, created_at DESC);
CREATE TRIGGER account_events_append_only BEFORE UPDATE OR DELETE ON account_events
  FOR EACH ROW EXECUTE FUNCTION account_append_only();

-- Tenant-level account settings (row absent = defaults) --------------------------------
CREATE TABLE restaurant_account_settings (
  tenant_id uuid PRIMARY KEY REFERENCES restaurants(id),
  privacy_notice_url text CHECK (privacy_notice_url IS NULL OR
    (privacy_notice_url ~ '^https://[^\s]+$' AND length(privacy_notice_url) <= 500)),
  free_selection_mode text NOT NULL DEFAULT 'auto' CHECK (free_selection_mode IN ('auto','manual')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id)
);

-- SaaS billing receptor data (feature-gated; future SaaS CFDI) -------------------------
CREATE TABLE organization_tax_profiles (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  rfc text NOT NULL CHECK (rfc ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$'),
  legal_name text NOT NULL CHECK (length(btrim(legal_name)) BETWEEN 1 AND 254),
  tax_regime text NOT NULL CHECK (tax_regime ~ '^[0-9]{3}$'),
  postal_code text NOT NULL CHECK (postal_code ~ '^[0-9]{5}$'),
  cfdi_use text NOT NULL DEFAULT 'G03' CHECK (cfdi_use ~ '^([A-Z][0-9]{2}|CP01|CN01|S01)$'),
  invoice_email text CHECK (invoice_email IS NULL OR length(invoice_email) <= 254),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_account uuid NOT NULL REFERENCES owner_accounts(id)
);

-- Membership revocation (co-owner removal, previous owner leaving) ---------------------
ALTER TABLE owner_memberships ADD COLUMN revoked_at timestamptz;
ALTER TABLE owner_memberships ADD COLUMN revoked_by uuid REFERENCES owner_accounts(id);
ALTER TABLE owner_memberships ADD CONSTRAINT membership_revocation_complete
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)) NOT VALID;
ALTER TABLE owner_memberships VALIDATE CONSTRAINT membership_revocation_complete;

-- Co-owner invitations reuse restaurant_invitations.
ALTER TABLE restaurant_invitations DROP CONSTRAINT restaurant_invitations_role_check;
ALTER TABLE restaurant_invitations ADD CONSTRAINT restaurant_invitations_role_check
  CHECK (role IN ('manager','cashier','server','kitchen','co_owner')) NOT VALID;
ALTER TABLE restaurant_invitations VALIDATE CONSTRAINT restaurant_invitations_role_check;

-- Support-granted entitlements are a third, explicit source.
ALTER TABLE restaurant_entitlements DROP CONSTRAINT restaurant_entitlements_source_check;
ALTER TABLE restaurant_entitlements ADD CONSTRAINT restaurant_entitlements_source_check
  CHECK (source IN ('stripe','fixture','support')) NOT VALID;
ALTER TABLE restaurant_entitlements VALIDATE CONSTRAINT restaurant_entitlements_source_check;

-- The primary owner pointer changes only through a valid pending transfer. Runs as the
-- invoker (gm_app), which reads the transfer through transfer_read: the caller sets
-- app.account_id, app.organization_id and app.transfer_id first.
CREATE FUNCTION organization_owner_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_by_account IS DISTINCT FROM OLD.created_by_account AND NOT EXISTS (
    SELECT 1 FROM ownership_transfers t
    WHERE t.id = nullif(current_setting('app.transfer_id', true), '')::uuid
      AND t.organization_id = NEW.id
      AND t.from_account_id = OLD.created_by_account
      AND t.to_account_id = NEW.created_by_account
      AND t.state = 'pending' AND t.available_at <= now() AND t.expires_at > now()
  ) THEN
    RAISE EXCEPTION 'organization_owner_change_requires_transfer';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organization_owner_change_guard BEFORE UPDATE OF created_by_account ON organizations
  FOR EACH ROW EXECUTE FUNCTION organization_owner_change_guard();

-- RLS ---------------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['support_actions','legal_acceptances','ownership_transfers',
    'organization_co_owners','account_recovery_codes','account_events',
    'restaurant_account_settings','organization_tax_profiles'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

CREATE POLICY tenant_scope ON restaurant_account_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY legal_acceptance_self ON legal_acceptances
  USING (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY legal_acceptance_org_read ON legal_acceptances FOR SELECT
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

CREATE POLICY co_owner_read ON organization_co_owners FOR SELECT USING (
  account_id = nullif(current_setting('app.account_id', true), '')::uuid
  OR organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY co_owner_update ON organization_co_owners FOR UPDATE
  USING (account_id = nullif(current_setting('app.account_id', true), '')::uuid
    OR organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (account_id = nullif(current_setting('app.account_id', true), '')::uuid
    OR organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY co_owner_invited_insert ON organization_co_owners FOR INSERT WITH CHECK (
  source = 'invitation'
  AND account_id = nullif(current_setting('app.account_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM restaurant_invitations i JOIN restaurants r ON r.id = i.tenant_id
    WHERE i.id = organization_co_owners.invitation_id
      AND i.token_hash = nullif(current_setting('app.invitation_hash', true), '')
      AND i.role = 'co_owner' AND i.accepted_by = organization_co_owners.account_id
      AND NOT i.revoked AND i.expires_at > now()
      AND r.organization_id = organization_co_owners.organization_id));
CREATE POLICY co_owner_transfer_insert ON organization_co_owners FOR INSERT WITH CHECK (
  source = 'transfer'
  AND organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM ownership_transfers t
    WHERE t.id = organization_co_owners.transfer_id
      AND t.id = nullif(current_setting('app.transfer_id', true), '')::uuid
      AND t.organization_id = organization_co_owners.organization_id
      AND t.from_account_id = organization_co_owners.account_id
      AND t.previous_owner_stays AND t.state = 'pending'));

CREATE POLICY transfer_read ON ownership_transfers FOR SELECT USING (
  from_account_id = nullif(current_setting('app.account_id', true), '')::uuid
  OR to_account_id = nullif(current_setting('app.account_id', true), '')::uuid
  OR token_hash = nullif(current_setting('app.transfer_hash', true), '')
  OR organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY transfer_update ON ownership_transfers FOR UPDATE
  USING (from_account_id = nullif(current_setting('app.account_id', true), '')::uuid
    OR to_account_id = nullif(current_setting('app.account_id', true), '')::uuid
    OR token_hash = nullif(current_setting('app.transfer_hash', true), '')
    OR organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (from_account_id = nullif(current_setting('app.account_id', true), '')::uuid
    OR to_account_id = nullif(current_setting('app.account_id', true), '')::uuid
    OR token_hash = nullif(current_setting('app.transfer_hash', true), '')
    OR organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY transfer_owner_insert ON ownership_transfers FOR INSERT WITH CHECK (
  initiated_by = 'owner'
  AND from_account_id = nullif(current_setting('app.account_id', true), '')::uuid
  AND organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY transfer_recovery_insert ON ownership_transfers FOR INSERT WITH CHECK (
  initiated_by = 'recovery_code'
  AND to_account_id = nullif(current_setting('app.account_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM account_recovery_codes c
    WHERE c.account_id = ownership_transfers.from_account_id
      AND c.lookup = nullif(current_setting('app.recovery_lookup', true), '')
      AND c.used_by_account = ownership_transfers.to_account_id
      AND c.used_for_transfer = ownership_transfers.id));

CREATE POLICY recovery_code_owner ON account_recovery_codes
  USING (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY recovery_code_lookup ON account_recovery_codes FOR SELECT
  USING (lookup = nullif(current_setting('app.recovery_lookup', true), ''));
CREATE POLICY recovery_code_redeem ON account_recovery_codes FOR UPDATE
  USING (lookup = nullif(current_setting('app.recovery_lookup', true), ''))
  WITH CHECK (lookup = nullif(current_setting('app.recovery_lookup', true), '')
    AND used_by_account = nullif(current_setting('app.account_id', true), '')::uuid);

CREATE POLICY account_event_read ON account_events FOR SELECT USING (
  actor_account_id = nullif(current_setting('app.account_id', true), '')::uuid
  OR subject_account_id = nullif(current_setting('app.account_id', true), '')::uuid
  OR organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY account_event_insert ON account_events FOR INSERT WITH CHECK (
  actor_account_id = nullif(current_setting('app.account_id', true), '')::uuid);

CREATE POLICY support_action_owner_read ON support_actions FOR SELECT
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

CREATE POLICY tax_profile_owner ON organization_tax_profiles
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    AND updated_by_account = nullif(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY billing_worker_tax_profiles ON organization_tax_profiles FOR SELECT
  TO gm_billing_worker USING (true);
GRANT SELECT ON organization_tax_profiles TO gm_billing_worker;

-- Verified organization scope (leaf predicates; set only after organizationScope()).
CREATE POLICY organization_verified_scope_read ON organizations FOR SELECT
  USING (id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY recovery_organization_read ON organizations FOR SELECT
  USING (created_by_account = nullif(current_setting('app.recovery_account_id', true), '')::uuid);
-- RESTRICTIVE (LD-15 account Q3): organization_scope is a permissive FOR ALL policy, and
-- permissive policies are OR'ed, so a permissive policy here would not constrain the new
-- UPDATE(created_by_account) grant. As a restrictive policy it applies to every UPDATE of
-- organizations; gm_app has no other UPDATE there (scripts/grants.sql) and the billing
-- worker has SELECT only. organization_owner_change_guard is the second guard.
CREATE POLICY organization_transfer_update ON organizations AS RESTRICTIVE FOR UPDATE
  USING (EXISTS (SELECT 1 FROM ownership_transfers t
    WHERE t.id = nullif(current_setting('app.transfer_id', true), '')::uuid
      AND t.organization_id = organizations.id AND t.state = 'pending'))
  WITH CHECK (created_by_account = nullif(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY restaurant_verified_scope_read ON restaurants FOR SELECT
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
-- A removed co-owner or departed previous owner keeps a revoked membership row; it must
-- no longer reveal the restaurant (or, through organization_scope, the organization).
DROP POLICY owner_restaurant_read ON restaurants;
CREATE POLICY owner_restaurant_read ON restaurants FOR SELECT USING (
  EXISTS (SELECT 1 FROM owner_memberships m
    WHERE m.tenant_id = restaurants.id AND m.revoked_at IS NULL));
-- Verified owners of an organization can read the account rows (name, email) of its
-- primary and active co-owners. owner_accounts is not referenced by any other policy,
-- so this sub-link cannot form a rewrite cycle.
CREATE POLICY owner_accounts_org_read ON owner_accounts FOR SELECT USING (
  EXISTS (SELECT 1 FROM organization_co_owners c
    WHERE c.account_id = owner_accounts.id AND c.removed_at IS NULL
      AND c.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  OR EXISTS (SELECT 1 FROM organizations o
    WHERE o.created_by_account = owner_accounts.id
      AND o.id = nullif(current_setting('app.organization_id', true), '')::uuid));

-- Memberships: tenant-scoped read/revoke (leaf), co-owner provisioning insert.
CREATE POLICY membership_tenant_read ON owner_memberships FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY membership_revoke ON owner_memberships FOR UPDATE
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR account_id = nullif(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY co_owner_membership_insert ON owner_memberships FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM organization_co_owners c JOIN restaurants r ON r.organization_id = c.organization_id
    WHERE r.id = owner_memberships.tenant_id AND c.account_id = owner_memberships.account_id
      AND c.removed_at IS NULL
      AND c.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid));

-- Invitations: visible/revocable by any verified owner of the organization.
CREATE POLICY invitation_org_scope ON restaurant_invitations
  USING (EXISTS (SELECT 1 FROM restaurants r WHERE r.id = restaurant_invitations.tenant_id
    AND r.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM restaurants r WHERE r.id = restaurant_invitations.tenant_id
    AND r.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid));

-- Vendor support capability role (least privilege, no DELETE, column-scoped) -----------
GRANT USAGE ON SCHEMA public TO gm_support;
GRANT SELECT (id, organization_id, name, timezone, activation_pending, free_location) ON restaurants TO gm_support;
GRANT SELECT (id, name, created_by_account) ON organizations TO gm_support;
GRANT SELECT (id, email, name, active, created_at) ON owner_accounts TO gm_support;
GRANT SELECT (account_id, tenant_id, employee_id, revoked_at) ON owner_memberships TO gm_support;
GRANT SELECT (tenant_id, id, name, login, role, active, failed_attempts, locked_until, free_slot,
  pin_set_at, deactivated_at) ON employees TO gm_support;
GRANT UPDATE (failed_attempts, locked_until) ON employees TO gm_support;
-- unlock-employee mirrors access clearLocks(): per-device throttles (access 023).
GRANT SELECT ON pin_throttles TO gm_support;
GRANT UPDATE (failures, lock_level, locked_until, last_failure_at) ON pin_throttles TO gm_support;
-- unlock-employee writes the access.employee_unlocked audit row {by:"support"}.
GRANT INSERT ON audit TO gm_support;
GRANT SELECT (tenant_id, id, name, active, free_slot) ON devices TO gm_support;
GRANT UPDATE (free_slot) ON devices TO gm_support;
GRANT SELECT (tenant_id, status, access_until, source, version, updated_at) ON restaurant_entitlements TO gm_support;
GRANT INSERT (tenant_id, status, access_until, source) ON restaurant_entitlements TO gm_support;
GRANT UPDATE (status, access_until, source, version, updated_at) ON restaurant_entitlements TO gm_support;
GRANT SELECT (organization_id, subscription_id, trial_used, interval) ON organization_billing TO gm_support;
GRANT SELECT ON billing_locations, organization_co_owners, legal_acceptances, account_events,
  restaurant_account_settings TO gm_support;
GRANT SELECT (id, organization_id, from_account_id, to_email, to_account_id, initiated_by,
  support_action_id, previous_owner_stays, state, available_at, expires_at, created_at,
  completed_at, canceled_at, canceled_by) ON ownership_transfers TO gm_support;
GRANT INSERT ON ownership_transfers TO gm_support;
GRANT UPDATE (state, canceled_at, canceled_by) ON ownership_transfers TO gm_support;
GRANT SELECT, INSERT ON support_actions TO gm_support;

CREATE POLICY support_read ON restaurants FOR SELECT TO gm_support USING (true);
CREATE POLICY support_read ON organizations FOR SELECT TO gm_support USING (true);
CREATE POLICY support_read ON owner_accounts FOR SELECT TO gm_support USING (true);
CREATE POLICY support_read ON owner_memberships FOR SELECT TO gm_support USING (true);
CREATE POLICY support_read ON organization_billing FOR SELECT TO gm_support USING (true);
CREATE POLICY support_read ON billing_locations FOR SELECT TO gm_support USING (true);
CREATE POLICY support_read ON organization_co_owners FOR SELECT TO gm_support USING (true);
CREATE POLICY support_read ON legal_acceptances FOR SELECT TO gm_support USING (true);
CREATE POLICY support_read ON account_events FOR SELECT TO gm_support USING (true);
CREATE POLICY support_read ON ownership_transfers FOR SELECT TO gm_support USING (true);
CREATE POLICY support_insert ON ownership_transfers FOR INSERT TO gm_support WITH CHECK (true);
CREATE POLICY support_cancel ON ownership_transfers FOR UPDATE TO gm_support USING (true) WITH CHECK (true);
CREATE POLICY support_limit_insert ON ownership_transfers AS RESTRICTIVE FOR INSERT TO gm_support
  WITH CHECK (initiated_by = 'support' AND support_action_id IS NOT NULL
    AND NOT previous_owner_stays AND available_at >= now() + interval '24 hours');
CREATE POLICY support_limit_update ON ownership_transfers AS RESTRICTIVE FOR UPDATE TO gm_support
  USING (state = 'pending') WITH CHECK (state = 'canceled' AND canceled_by = 'support');
CREATE POLICY support_read ON restaurant_entitlements FOR SELECT TO gm_support USING (true);
CREATE POLICY support_insert ON restaurant_entitlements FOR INSERT TO gm_support WITH CHECK (true);
CREATE POLICY support_update ON restaurant_entitlements FOR UPDATE TO gm_support USING (true) WITH CHECK (true);
CREATE POLICY support_limit_insert ON restaurant_entitlements AS RESTRICTIVE FOR INSERT TO gm_support
  WITH CHECK (source = 'support'
    AND (access_until IS NULL OR access_until <= now() + interval '92 days')
    AND NOT EXISTS (SELECT 1 FROM billing_locations l WHERE l.tenant_id = restaurant_entitlements.tenant_id));
CREATE POLICY support_limit_update ON restaurant_entitlements AS RESTRICTIVE FOR UPDATE TO gm_support
  USING (source IN ('support','fixture') OR status = 'free')
  WITH CHECK (source = 'support'
    AND (access_until IS NULL OR access_until <= now() + interval '92 days')
    AND NOT EXISTS (SELECT 1 FROM billing_locations l WHERE l.tenant_id = restaurant_entitlements.tenant_id));
CREATE POLICY support_actions_insert ON support_actions FOR INSERT TO gm_support WITH CHECK (true);
CREATE POLICY support_actions_read ON support_actions FOR SELECT TO gm_support USING (true);
-- employees/devices/pin_throttles/audit/restaurant_account_settings: gm_support uses the
-- existing tenant_scope policies (no TO clause, so they apply to every role) by setting
-- app.tenant_id; the column grants above bound what it can see or change.
