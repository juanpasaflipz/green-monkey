CREATE TABLE recipe_versions(tenant_id uuid NOT NULL,id uuid NOT NULL,product_id uuid NOT NULL,version integer NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,product_id,version),FOREIGN KEY(tenant_id,product_id) REFERENCES catalog(tenant_id,id));
CREATE TABLE suppliers(tenant_id uuid NOT NULL REFERENCES restaurants(id),id uuid NOT NULL,name text NOT NULL,PRIMARY KEY(tenant_id,id));
CREATE TABLE receipts(tenant_id uuid NOT NULL,id uuid NOT NULL,supplier_id uuid NOT NULL,stock_id uuid NOT NULL,quantity numeric(18,6) NOT NULL,cost integer NOT NULL CHECK(cost>=0),expires_on date,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,supplier_id) REFERENCES suppliers(tenant_id,id),FOREIGN KEY(tenant_id,stock_id) REFERENCES stock_items(tenant_id,id));
CREATE TABLE shifts(tenant_id uuid NOT NULL,id uuid NOT NULL,employee_id uuid NOT NULL,hourly_rate integer NOT NULL CHECK(hourly_rate>=0),started_at timestamptz NOT NULL DEFAULT now(),ended_at timestamptz,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,employee_id) REFERENCES employees(tenant_id,id));
CREATE UNIQUE INDEX one_active_shift ON shifts(tenant_id,employee_id) WHERE ended_at IS NULL;
DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['recipe_versions','suppliers','receipts','shifts'] LOOP
EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
END LOOP;
END $$;
