ALTER TABLE owner_sessions ADD COLUMN verified_email text;
ALTER TABLE restaurants ADD COLUMN activation_pending boolean NOT NULL DEFAULT false;
GRANT UPDATE(activation_pending) ON restaurants TO gm_billing_worker;
CREATE POLICY billing_worker_location_activation ON restaurants FOR UPDATE TO gm_billing_worker USING(true) WITH CHECK(true);
CREATE TABLE owner_location_commands (
 account_id uuid NOT NULL REFERENCES owner_accounts(id),
 id uuid NOT NULL,
 payload_hash text NOT NULL,
 tenant_id uuid NOT NULL REFERENCES restaurants(id),
 PRIMARY KEY(account_id,id)
);
ALTER TABLE owner_location_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_location_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_location_scope ON owner_location_commands USING(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
CREATE TABLE restaurant_invitations (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES restaurants(id),
 created_by uuid NOT NULL REFERENCES owner_accounts(id),
 email text NOT NULL,
 role text NOT NULL CHECK(role IN ('manager','cashier','server','kitchen')),
 token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
 revoked boolean NOT NULL DEFAULT false,
 accepted_by uuid REFERENCES owner_accounts(id),
 accepted_at timestamptz,
 employee_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((accepted_by IS NULL)=(accepted_at IS NULL)),
 CHECK((accepted_by IS NULL)=(employee_id IS NULL))
);
ALTER TABLE restaurant_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY invitation_owner ON restaurant_invitations USING(created_by=nullif(current_setting('app.account_id',true),'')::uuid);
CREATE POLICY invitation_token_read ON restaurant_invitations FOR SELECT USING(token_hash=nullif(current_setting('app.invitation_hash',true),''));
CREATE POLICY invitation_token_accept ON restaurant_invitations FOR UPDATE USING(token_hash=nullif(current_setting('app.invitation_hash',true),'')) WITH CHECK(token_hash=nullif(current_setting('app.invitation_hash',true),'') AND accepted_by=nullif(current_setting('app.account_id',true),'')::uuid);
CREATE POLICY invited_membership_insert ON owner_memberships FOR INSERT WITH CHECK (
 account_id=nullif(current_setting('app.account_id',true),'')::uuid AND
 EXISTS(SELECT 1 FROM restaurant_invitations i WHERE i.token_hash=nullif(current_setting('app.invitation_hash',true),'') AND i.tenant_id=owner_memberships.tenant_id AND i.accepted_by=owner_memberships.account_id AND i.employee_id=owner_memberships.employee_id AND NOT i.revoked AND i.expires_at>now())
);
CREATE TABLE owner_browser_devices (
 account_id uuid NOT NULL REFERENCES owner_accounts(id),
 browser_id uuid NOT NULL,
 tenant_id uuid NOT NULL REFERENCES restaurants(id),
 device_id uuid NOT NULL,
 browser_token_hash text NOT NULL,
 PRIMARY KEY(account_id,browser_id,tenant_id),
 FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id)
);
ALTER TABLE owner_browser_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_browser_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_browser_scope ON owner_browser_devices USING(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
-- Reuse initial signup intents to distinguish the original restaurant from
-- later locations. Migration 013 writers already populate these rows.
INSERT INTO signup_billing_intents(tenant_id,trial_requested,processed_at)
 SELECT r.id,false,now() FROM restaurants r JOIN organizations o ON o.id=r.organization_id
 WHERE o.created_by_account IS NOT NULL AND EXISTS(SELECT 1 FROM audit a WHERE a.tenant_id=r.id AND a.operation='restaurant.signup')
 ON CONFLICT(tenant_id) DO NOTHING;
CREATE POLICY signup_intent_owner_read ON signup_billing_intents FOR SELECT USING (
 EXISTS(SELECT 1 FROM restaurants r JOIN organizations o ON o.id=r.organization_id WHERE r.id=tenant_id AND o.created_by_account=nullif(current_setting('app.account_id',true),'')::uuid)
);
