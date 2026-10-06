-- gm:no-transaction
-- 033_state_checks_validate.sql — validates the five 032 DB-9 CHECKs. Each
-- VALIDATE takes only SHARE UPDATE EXCLUSIVE, so sales keep writing while it
-- scans. The validation scan is an internal heap scan that row-level security
-- does not filter (023 already validates devices/sessions CHECKs as
-- gm_migrator under FORCE RLS; tests/public-ordering-db.ts proves it here with
-- another tenant's row), so no NO FORCE/FORCE wrapper is needed (LD-6 and the
-- lint's backfill rule cover DML only). VALIDATE of an already valid
-- constraint is a no-op, so a partial run can be retried.
-- A failure means a pre-existing row holds a value outside the set: the
-- constraint still blocks new bad writes; repair the row (docs/PUBLIC_ORDERING.md,
-- "DB-9 validation") and re-run the deploy.
ALTER TABLE orders VALIDATE CONSTRAINT orders_state_valid;
-- gm:statement-break
ALTER TABLE orders VALIDATE CONSTRAINT orders_channel_valid;
-- gm:statement-break
ALTER TABLE orders VALIDATE CONSTRAINT orders_mode_valid;
-- gm:statement-break
ALTER TABLE rounds VALIDATE CONSTRAINT rounds_state_valid;
-- gm:statement-break
ALTER TABLE jobs VALIDATE CONSTRAINT jobs_state_valid;
