-- Selection is separate from active/security status: downgrade never deletes or
-- revokes records needed to finish tickets, reconcile cash, or recover sync.
ALTER TABLE employees ADD COLUMN free_slot smallint CHECK(free_slot BETWEEN 1 AND 2);
ALTER TABLE devices ADD COLUMN free_slot smallint CHECK(free_slot = 1);
CREATE UNIQUE INDEX employee_free_slot ON employees(tenant_id,free_slot);
CREATE UNIQUE INDEX device_free_slot ON devices(tenant_id,free_slot);
WITH ranked AS (
 SELECT tenant_id,id,row_number() OVER(PARTITION BY tenant_id ORDER BY id) AS slot
 FROM employees WHERE active AND role <> 'owner'
) UPDATE employees e SET free_slot=r.slot FROM ranked r
 WHERE e.tenant_id=r.tenant_id AND e.id=r.id AND r.slot<=2;
WITH ranked AS (
 SELECT tenant_id,id,row_number() OVER(PARTITION BY tenant_id ORDER BY id) AS slot
 FROM devices WHERE active
) UPDATE devices d SET free_slot=1 FROM ranked r
 WHERE d.tenant_id=r.tenant_id AND d.id=r.id AND r.slot=1;
ALTER TABLE sessions ADD COLUMN selling_authorized boolean NOT NULL DEFAULT true;
ALTER TABLE restaurants ADD COLUMN free_location boolean NOT NULL DEFAULT false;
WITH ranked AS (
 SELECT r.id,row_number() OVER(PARTITION BY r.organization_id ORDER BY (i.tenant_id IS NOT NULL) DESC,r.id) AS slot
 FROM restaurants r LEFT JOIN signup_billing_intents i ON i.tenant_id=r.id
 WHERE NOT r.activation_pending
) UPDATE restaurants r SET free_location=true FROM ranked x WHERE r.id=x.id AND x.slot=1;
CREATE UNIQUE INDEX organization_free_location ON restaurants(organization_id) WHERE free_location;
CREATE POLICY owner_free_location_update ON restaurants FOR UPDATE USING (
 EXISTS(SELECT 1 FROM organizations o WHERE o.id=organization_id AND o.created_by_account=nullif(current_setting('app.account_id',true),'')::uuid)
) WITH CHECK (
 EXISTS(SELECT 1 FROM organizations o WHERE o.id=organization_id AND o.created_by_account=nullif(current_setting('app.account_id',true),'')::uuid)
);
