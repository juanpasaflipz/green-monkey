-- One promotion/discount engine for POS, QR and kiosk. Definitions are versioned;
-- every reduction on an order is an immutable redemption row that snapshots the
-- definition version, so history never depends on a later edit.
CREATE TABLE promotions(
 tenant_id uuid NOT NULL REFERENCES restaurants(id),
 id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 kind text NOT NULL CHECK(kind IN ('percent','amount')),
 value integer NOT NULL CHECK(value>0),
 scope text NOT NULL CHECK(scope IN ('order','product','category')),
 targets jsonb NOT NULL DEFAULT '[]',
 min_subtotal integer NOT NULL DEFAULT 0 CHECK(min_subtotal>=0),
 max_reduction integer CHECK(max_reduction>0),
 days integer[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
 from_minute integer NOT NULL DEFAULT 0 CHECK(from_minute BETWEEN 0 AND 1439),
 to_minute integer NOT NULL DEFAULT 1440 CHECK(to_minute BETWEEN 1 AND 1440),
 starts_on date,
 ends_on date,
 channels text[] NOT NULL DEFAULT '{pos,qr,kiosk}',
 code text CHECK(code ~ '^[A-Z0-9]{3,24}$'),
 usage_limit integer CHECK(usage_limit>0),
 stackable boolean NOT NULL DEFAULT true,
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 CHECK(kind<>'percent' OR value<=10000),
 CHECK(kind<>'amount' OR value<=100000000),
 CHECK(starts_on IS NULL OR ends_on IS NULL OR starts_on<=ends_on)
);
CREATE UNIQUE INDEX promotion_code ON promotions(tenant_id,code) WHERE code IS NOT NULL;

-- Short-lived, single-use manager approval bound to one exact action.
CREATE TABLE approvals(
 tenant_id uuid NOT NULL REFERENCES restaurants(id),
 id uuid NOT NULL,
 approver_id uuid NOT NULL,
 requester_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('manual_discount')),
 binding text NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,approver_id) REFERENCES employees(tenant_id,id),
 FOREIGN KEY(tenant_id,requester_id) REFERENCES employees(tenant_id,id)
);

CREATE TABLE promotion_redemptions(
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 order_id uuid NOT NULL,
 round integer NOT NULL CHECK(round>0),
 kind text NOT NULL CHECK(kind IN ('promotion','manual')),
 promotion_id uuid,
 promotion_version integer,
 name text NOT NULL,
 code text,
 amount integer NOT NULL CHECK(amount>0),
 reason text,
 actor_id uuid NOT NULL,
 approval_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,promotion_id) REFERENCES promotions(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES employees(tenant_id,id),
 FOREIGN KEY(tenant_id,approval_id) REFERENCES approvals(tenant_id,id),
 CHECK((kind='promotion')=(promotion_id IS NOT NULL AND promotion_version IS NOT NULL)),
 CHECK(kind<>'manual' OR length(reason)>=3)
);
CREATE UNIQUE INDEX redemption_once ON promotion_redemptions(tenant_id,order_id,round,promotion_id) WHERE promotion_id IS NOT NULL;
CREATE UNIQUE INDEX manual_once ON promotion_redemptions(tenant_id,order_id,round) WHERE kind='manual';
CREATE UNIQUE INDEX approval_once ON promotion_redemptions(tenant_id,approval_id) WHERE approval_id IS NOT NULL;
CREATE INDEX redemption_promotion ON promotion_redemptions(tenant_id,promotion_id);
ALTER TABLE orders ADD CONSTRAINT orders_discount_nonnegative CHECK(discount>=0);

DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['promotions','approvals','promotion_redemptions'] LOOP
EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
END LOOP;
END $$;
