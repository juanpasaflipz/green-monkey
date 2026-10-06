ALTER TABLE orders ADD COLUMN assigned_employee_id uuid;
ALTER TABLE orders ADD COLUMN service_version integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD CONSTRAINT assigned_employee_tenant FOREIGN KEY(tenant_id,assigned_employee_id) REFERENCES employees(tenant_id,id);
