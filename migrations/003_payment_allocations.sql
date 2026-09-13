-- Old tenders remain unallocated. Never invent historic item choices.
ALTER TABLE order_lines ADD CONSTRAINT order_line_order_identity UNIQUE(tenant_id,order_id,id);
ALTER TABLE tenders ADD CONSTRAINT tender_order_identity UNIQUE(tenant_id,order_id,id);
CREATE TABLE tender_allocations (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  tender_id uuid NOT NULL,
  line_id uuid NOT NULL,
  unit_index integer NOT NULL CHECK(unit_index BETWEEN 0 AND 98),
  amount integer NOT NULL CHECK(amount > 0),
  PRIMARY KEY(tenant_id,tender_id,line_id,unit_index),
  FOREIGN KEY(tenant_id,order_id,tender_id) REFERENCES tenders(tenant_id,order_id,id),
  FOREIGN KEY(tenant_id,order_id,line_id) REFERENCES order_lines(tenant_id,order_id,id)
);
ALTER TABLE tender_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tender_allocations USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
