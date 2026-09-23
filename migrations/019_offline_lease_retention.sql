-- Runtime lease evidence remains append-only. Privileged retention/test cleanup
-- may deliberately remove a whole session and its lease through the parent FK.
DROP TRIGGER offline_leases_immutable ON offline_leases;
CREATE TRIGGER offline_leases_immutable BEFORE UPDATE ON offline_leases
 FOR EACH ROW EXECUTE FUNCTION immutable_offline_evidence();
ALTER TABLE offline_leases DROP CONSTRAINT offline_leases_tenant_id_session_id_fkey;
ALTER TABLE offline_leases ADD FOREIGN KEY(tenant_id,session_id)
 REFERENCES sessions(tenant_id,id) ON DELETE CASCADE;
