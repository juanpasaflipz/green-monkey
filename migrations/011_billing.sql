-- Billing writes belong to a separate, non-login capability role. The POS role
-- is deliberately not a member. Deployment must provision a separate login.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gm_billing_worker') THEN
  CREATE ROLE gm_billing_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
 END IF;
END $$;
CREATE TABLE organization_billing (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id),
 customer_id text UNIQUE CHECK(customer_id ~ '^cus_[A-Za-z0-9]+$'),
 subscription_id text UNIQUE CHECK(subscription_id ~ '^sub_[A-Za-z0-9]+$'),
 interval text NOT NULL DEFAULT 'month' CHECK(interval IN ('month','year')),
 trial_used boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE billing_locations (
 organization_id uuid NOT NULL REFERENCES organization_billing(organization_id),
 tenant_id uuid PRIMARY KEY REFERENCES restaurants(id),
 UNIQUE(organization_id,tenant_id)
);
CREATE TABLE billing_operations (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organization_billing(organization_id),
 kind text NOT NULL CHECK(kind IN ('customer','trial','checkout','portal','reconcile','checkout_watch')),
 payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','succeeded','review')),
 result jsonb,
 attempts integer NOT NULL DEFAULT 0,
 lease_token uuid,
 lease_until timestamptz,
 first_attempt_at timestamptz,
 fetch_started_at timestamptz,
 available_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz
);
CREATE UNIQUE INDEX billing_one_mutation ON billing_operations(organization_id)
 WHERE kind IN ('customer','trial','checkout','checkout_watch') AND state IN ('pending','running','review');
CREATE TABLE billing_events (
 id text PRIMARY KEY CHECK(id ~ '^evt_[A-Za-z0-9]+$'),
 subscription_id text NOT NULL CHECK(subscription_id ~ '^sub_[A-Za-z0-9]+$'),
 received_at timestamptz NOT NULL DEFAULT now(),
 processed_at timestamptz
);
-- Allow a revoked past-due projection with no access; this does not grant grace.
ALTER TABLE restaurant_entitlements DROP CONSTRAINT restaurant_entitlements_check;
ALTER TABLE restaurant_entitlements ADD CHECK(status NOT IN ('trialing','active') OR access_until IS NOT NULL);
-- Provider identity is now organization-scoped. Existing fixture/history values
-- are retained; new projections use the organization binding, not these columns.
ALTER TABLE restaurant_entitlements DROP CONSTRAINT restaurant_entitlements_stripe_customer_id_key;
ALTER TABLE restaurant_entitlements DROP CONSTRAINT restaurant_entitlements_stripe_subscription_id_key;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['organization_billing','billing_locations','billing_operations','billing_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY billing_worker ON %I TO gm_billing_worker USING (true) WITH CHECK (true)',t);
 END LOOP;
END $$;
CREATE POLICY billing_owner_read ON organization_billing FOR SELECT USING (
 EXISTS(SELECT 1 FROM organizations o WHERE o.id=organization_id AND o.created_by_account=nullif(current_setting('app.account_id',true),'')::uuid)
);
CREATE POLICY billing_location_owner_read ON billing_locations FOR SELECT USING (
 EXISTS(SELECT 1 FROM organizations o WHERE o.id=organization_id AND o.created_by_account=nullif(current_setting('app.account_id',true),'')::uuid)
);
CREATE POLICY billing_operation_owner_read ON billing_operations FOR SELECT USING (
 EXISTS(SELECT 1 FROM organizations o WHERE o.id=organization_id AND o.created_by_account=nullif(current_setting('app.account_id',true),'')::uuid)
);
CREATE POLICY billing_worker_restaurants ON restaurants FOR SELECT TO gm_billing_worker USING(true);
CREATE POLICY billing_worker_organizations ON organizations FOR SELECT TO gm_billing_worker USING(true);
CREATE POLICY billing_worker_entitlements ON restaurant_entitlements TO gm_billing_worker USING(true) WITH CHECK(true);
GRANT USAGE ON SCHEMA public TO gm_billing_worker;
GRANT SELECT ON restaurants,organizations TO gm_billing_worker;
GRANT SELECT,INSERT,UPDATE ON organization_billing,billing_locations,billing_operations,billing_events,restaurant_entitlements TO gm_billing_worker;

CREATE FUNCTION billing_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.kind<>OLD.kind OR NEW.payload<>OLD.payload OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'billing_operation_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER billing_operation_immutable BEFORE UPDATE ON billing_operations FOR EACH ROW EXECUTE FUNCTION billing_operation_immutable();
