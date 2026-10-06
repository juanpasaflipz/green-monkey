-- Recovery records are immutable to the runtime. Privileged retention and
-- isolated-fixture cleanup may delete evidence deliberately; runtime has no
-- DELETE grant on these tables.
DROP TRIGGER offline_recoveries_immutable ON offline_recoveries;
CREATE TRIGGER offline_recoveries_immutable BEFORE UPDATE ON offline_recoveries
 FOR EACH ROW EXECUTE FUNCTION immutable_offline_evidence();
