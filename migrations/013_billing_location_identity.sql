-- A billing location must belong to that organization even if a worker has a bug.
ALTER TABLE restaurants ADD CONSTRAINT restaurants_organization_identity UNIQUE(organization_id,id);
ALTER TABLE billing_locations ADD CONSTRAINT billing_location_organization FOREIGN KEY(organization_id,tenant_id) REFERENCES restaurants(organization_id,id);
