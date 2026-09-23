-- Durable issuance and append-only evidence for offline cash recovery.
CREATE TABLE offline_leases (
 tenant_id uuid NOT NULL REFERENCES restaurants(id),
 session_id uuid NOT NULL,
 employee_id uuid NOT NULL,
 device_id uuid NOT NULL,
 contract_version integer NOT NULL CHECK(contract_version BETWEEN 0 AND 2),
 issued_at timestamptz NOT NULL,
 valid_until timestamptz NOT NULL,
 selling_authorized boolean NOT NULL,
 plan text NOT NULL CHECK(plan IN ('free','pro')),
 configuration_version integer,
 restaurant_snapshot jsonb NOT NULL,
 PRIMARY KEY(tenant_id,session_id),
 FOREIGN KEY(tenant_id,session_id) REFERENCES sessions(tenant_id,id),
 FOREIGN KEY(tenant_id,employee_id) REFERENCES employees(tenant_id,id),
 FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id),
 CHECK(valid_until >= issued_at)
);

INSERT INTO offline_leases(
 tenant_id,session_id,employee_id,device_id,contract_version,issued_at,
 valid_until,selling_authorized,plan,configuration_version,restaurant_snapshot
)
SELECT s.tenant_id,s.id,s.employee_id,s.device_id,0,
       s.expires_at-interval '12 hours',s.offline_until,s.selling_authorized,
       CASE WHEN e.status IN ('trialing','active') AND e.access_until>now()
            THEN 'pro' ELSE 'free' END,
       r.config_version,
       jsonb_build_object('name',r.name,'currency',r.currency,'timezone',r.timezone,'cutoff',r.cutoff)
FROM sessions s
JOIN restaurants r ON r.id=s.tenant_id
LEFT JOIN restaurant_entitlements e ON e.tenant_id=s.tenant_id;

ALTER TABLE tenders ADD COLUMN source text NOT NULL DEFAULT 'normal'
  CHECK(source IN ('normal','offline_recovery'));
ALTER TABLE tenders ADD COLUMN source_id uuid;
CREATE UNIQUE INDEX tender_recovery_source
  ON tenders(tenant_id,source,source_id) WHERE source_id IS NOT NULL;

CREATE TABLE offline_recoveries (
 tenant_id uuid NOT NULL REFERENCES restaurants(id),
 id uuid NOT NULL,
 operation_id uuid NOT NULL,
 order_operation_id uuid NOT NULL,
 original_session_id uuid NOT NULL,
 original_employee_id uuid NOT NULL,
 original_device_id uuid NOT NULL,
 original_drawer_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 reason text NOT NULL,
 evidence_version integer NOT NULL,
 evidence jsonb NOT NULL,
 order_id uuid NOT NULL,
 tender_id uuid NOT NULL,
 original_sold_at timestamptz NOT NULL,
 recognized_at timestamptz NOT NULL DEFAULT now(),
 item_allocation_complete boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,operation_id),
 UNIQUE(tenant_id,order_operation_id),
 FOREIGN KEY(tenant_id,original_session_id) REFERENCES sessions(tenant_id,id),
 FOREIGN KEY(tenant_id,original_employee_id) REFERENCES employees(tenant_id,id),
 FOREIGN KEY(tenant_id,original_device_id) REFERENCES devices(tenant_id,id),
 FOREIGN KEY(tenant_id,original_drawer_id) REFERENCES cash_sessions(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES employees(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,tender_id) REFERENCES tenders(tenant_id,id)
);

CREATE TABLE offline_recovery_tasks (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 recovery_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('kitchen','stock')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','resolved')),
 resolved_by uuid,
 resolution text,
 resolved_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,recovery_id,kind),
 FOREIGN KEY(tenant_id,recovery_id) REFERENCES offline_recoveries(tenant_id,id),
 FOREIGN KEY(tenant_id,resolved_by) REFERENCES employees(tenant_id,id),
 CHECK((state='pending' AND resolved_by IS NULL AND resolved_at IS NULL) OR
       (state='resolved' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND length(resolution)>=3))
);

CREATE FUNCTION immutable_offline_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'offline_evidence_immutable';
END $$;
CREATE TRIGGER offline_leases_immutable BEFORE UPDATE OR DELETE ON offline_leases
 FOR EACH ROW EXECUTE FUNCTION immutable_offline_evidence();
CREATE TRIGGER offline_recoveries_immutable BEFORE UPDATE OR DELETE ON offline_recoveries
 FOR EACH ROW EXECUTE FUNCTION immutable_offline_evidence();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['offline_leases','offline_recoveries','offline_recovery_tasks'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
