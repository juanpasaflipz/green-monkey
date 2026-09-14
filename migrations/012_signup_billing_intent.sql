-- Signup commits the choice even during a provider outage. Runtime may insert
-- a request but cannot acknowledge it or grant access.
CREATE TABLE signup_billing_intents (
 tenant_id uuid PRIMARY KEY REFERENCES restaurants(id),
 trial_requested boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 processed_at timestamptz
);
ALTER TABLE signup_billing_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE signup_billing_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY signup_billing_owner ON signup_billing_intents FOR INSERT WITH CHECK (
 tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND
 EXISTS(SELECT 1 FROM restaurants r JOIN organizations o ON o.id=r.organization_id WHERE r.id=tenant_id AND o.created_by_account=nullif(current_setting('app.account_id',true),'')::uuid)
);
CREATE POLICY signup_billing_worker ON signup_billing_intents TO gm_billing_worker USING(true) WITH CHECK(true);
GRANT SELECT ON signup_billing_intents TO gm_billing_worker;
GRANT UPDATE(processed_at) ON signup_billing_intents TO gm_billing_worker;
