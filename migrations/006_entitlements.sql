-- No implicit Pro grants: historical restaurants retain Free until explicitly entitled.
CREATE TABLE restaurant_entitlements (
 tenant_id uuid PRIMARY KEY REFERENCES restaurants(id),
 status text NOT NULL CHECK(status IN ('free','trialing','active','past_due','canceled','paused')),
 access_until timestamptz,
 trial_used boolean NOT NULL DEFAULT false,
 source text NOT NULL CHECK(source IN ('stripe','fixture')),
 stripe_customer_id text UNIQUE,
 stripe_subscription_id text UNIQUE,
 version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status NOT IN ('trialing','active','past_due') OR access_until IS NOT NULL)
);
ALTER TABLE restaurant_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON restaurant_entitlements USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
-- Runtime receives SELECT only. A browser or ordinary order mutation cannot grant Pro.
