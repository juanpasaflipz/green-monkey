CREATE TABLE owner_accounts (
  id uuid PRIMARY KEY,
  identity_key text NOT NULL UNIQUE,
  issuer text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(issuer,subject)
);
CREATE TABLE owner_sessions (
  account_id uuid NOT NULL REFERENCES owner_accounts(id),
  id uuid PRIMARY KEY,
  token_hash text NOT NULL,
  csrf text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false
);
ALTER TABLE organizations ADD COLUMN created_by_account uuid REFERENCES owner_accounts(id);
-- Initial self-service signup creates one organization per owner. Additional
-- location billing and invited memberships are separate future commands.
CREATE UNIQUE INDEX one_signup_organization ON organizations(created_by_account);
CREATE TABLE owner_memberships (
  account_id uuid NOT NULL REFERENCES owner_accounts(id),
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  employee_id uuid NOT NULL,
  PRIMARY KEY(account_id,tenant_id),
  FOREIGN KEY(tenant_id,employee_id) REFERENCES employees(tenant_id,id)
);
ALTER TABLE owner_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_identity_scope ON owner_accounts USING (
  identity_key=nullif(current_setting('app.identity_key',true),'') OR
  id=nullif(current_setting('app.account_id',true),'')::uuid
) WITH CHECK (
  identity_key=nullif(current_setting('app.identity_key',true),'')
);
ALTER TABLE owner_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_session_scope ON owner_sessions USING (
  account_id=nullif(current_setting('app.account_id',true),'')::uuid
);
ALTER TABLE owner_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_read ON owner_memberships FOR SELECT USING (
  account_id=nullif(current_setting('app.account_id',true),'')::uuid
);
CREATE POLICY membership_insert ON owner_memberships FOR INSERT WITH CHECK (
  account_id=nullif(current_setting('app.account_id',true),'')::uuid AND
  EXISTS(SELECT 1 FROM restaurants r JOIN organizations o ON o.id=r.organization_id
    WHERE r.id=tenant_id AND o.created_by_account=account_id)
);
CREATE POLICY owner_organization_read ON organizations FOR SELECT USING (
  created_by_account=nullif(current_setting('app.account_id',true),'')::uuid
);
CREATE POLICY owner_organization_insert ON organizations FOR INSERT WITH CHECK (
  created_by_account=nullif(current_setting('app.account_id',true),'')::uuid
);
CREATE POLICY owner_restaurant_read ON restaurants FOR SELECT USING (
  EXISTS(SELECT 1 FROM owner_memberships m WHERE m.tenant_id=id)
);
CREATE POLICY owner_restaurant_insert ON restaurants FOR INSERT WITH CHECK (
  id=nullif(current_setting('app.tenant_id',true),'')::uuid AND
  EXISTS(SELECT 1 FROM organizations o WHERE o.id=organization_id
    AND o.created_by_account=nullif(current_setting('app.account_id',true),'')::uuid)
);
