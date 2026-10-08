-- 036_cfdi_rehearsal_fixes.sql — fixes from the real-sandbox CFDI rehearsal (LD-51, track
-- cfdifix). Why a migration is unavoidable:
--   F1  the web prints the self-invoicing deadline, which ends when the ticket's global is built
--       (period close + CFDI_GLOBAL_GRACE_MINUTES); that grace is a worker-only setting, so the
--       worker publishes it in cfdi_platform for the web to read;
--   F3  in the shared sandbox the stamping issuer is the platform's test organization: the worker
--       publishes the legal data Facturapi reports for it (régimen, RFC, postal code, legal name)
--       so the stamping transaction (no network call inside it) and the settings panel use them;
--   F2  a periodicity change that applies at once rebuilds the current month's period rows. 030's
--       guard refuses every DELETE; this version lets the worker delete one row that no document
--       ever used (status open or empty, no part, no cfdi_documents row of its key);
--   LD-55 (CFDIFIX-FISCAL-5 / UX-4) a self-invoicing change (window or portal reissue) that would
--       bring forward the deadline of receipts already printed waits, as a periodicity change
--       does: the settings row keeps the wanted terms and the business date they apply from.
-- Expand-only: five nullable columns on the one-row platform table (the previous revision's
-- publish names its columns and leaves these NULL), four nullable columns on cfdi_settings (the
-- previous revision never reads or writes them: its saves leave them NULL), and the period guard
-- accepts one more kind of statement (the worker's DELETE of a document-less row), which the
-- previous revision never sends; every UPDATE it allowed is still allowed and every one it refused
-- is still refused, as are TRUNCATE and every other DELETE. No DML, so the LD-6 NO FORCE / FORCE
-- wrapper is not needed. Grants live in scripts/grants.sql ("-- 036 cfdifix"), the manifest every
-- deploy applies to the runtime login it names (PG_APP_USER: gm_<env>_app in staging and
-- production, gm_app only locally), never in a migration (migrations-lint runtime_role_named):
-- the worker's DELETE of a document-less period row and the runtime role's UPDATE of the new
-- settings columns; RLS tenant_scope still fences both to one tenant. Idempotent: ADD COLUMN IF
-- NOT EXISTS, CREATE OR REPLACE FUNCTION, a CHECK added only when missing.
SET LOCAL lock_timeout = '5s';

-- 1. Worker-published facts (no tenant data; cfdi_platform has one row).
ALTER TABLE cfdi_platform
  ADD COLUMN IF NOT EXISTS global_grace_minutes smallint
    CHECK (global_grace_minutes IS NULL OR global_grace_minutes BETWEEN 0 AND 600),
  ADD COLUMN IF NOT EXISTS shared_legal_name text
    CHECK (shared_legal_name IS NULL OR length(shared_legal_name) BETWEEN 1 AND 300),
  ADD COLUMN IF NOT EXISTS shared_tax_id text
    CHECK (shared_tax_id IS NULL OR shared_tax_id ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$'),
  ADD COLUMN IF NOT EXISTS shared_tax_system text
    CHECK (shared_tax_system IS NULL OR shared_tax_system ~ '^[0-9]{3}$'),
  ADD COLUMN IF NOT EXISTS shared_postal_code text
    CHECK (shared_postal_code IS NULL OR shared_postal_code ~ '^[0-9]{5}$');

-- 2. A self-invoicing change that waits (LD-55): its terms, all set or all NULL.
ALTER TABLE cfdi_settings
  ADD COLUMN IF NOT EXISTS next_self_invoice_policy text
    CHECK (next_self_invoice_policy IS NULL OR next_self_invoice_policy IN ('month','days')),
  ADD COLUMN IF NOT EXISTS next_self_invoice_days smallint
    CHECK (next_self_invoice_days IS NULL OR next_self_invoice_days BETWEEN 1 AND 90),
  ADD COLUMN IF NOT EXISTS next_portal_reissue_global boolean,
  ADD COLUMN IF NOT EXISTS next_self_invoice_from date;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'cfdi_settings'::regclass
                   AND conname = 'cfdi_settings_next_self_invoice_whole') THEN
    ALTER TABLE cfdi_settings ADD CONSTRAINT cfdi_settings_next_self_invoice_whole CHECK (
      (next_self_invoice_from IS NULL) = (next_self_invoice_policy IS NULL)
      AND (next_self_invoice_from IS NULL) = (next_self_invoice_days IS NULL)
      AND (next_self_invoice_from IS NULL) = (next_portal_reissue_global IS NULL));
  END IF;
END $$;

-- 3. Period rows: the worker may delete a row no document ever used, so an immediate periodicity
-- change can rebuild the current month (a row with a part, or any global document of its key,
-- whatever its status, is never deleted: the register and the late sweep read documents by key).
CREATE OR REPLACE FUNCTION cfdi_periods_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT cfdi_is_worker() THEN
      RAISE EXCEPTION 'cfdi_global_periods rows are not deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status NOT IN ('open','empty') OR OLD.documents <> 0
       OR EXISTS (SELECT 1 FROM cfdi_documents d WHERE d.tenant_id = OLD.tenant_id AND d.mode = OLD.mode
                    AND d.kind = 'global' AND d.period_key = OLD.period_key) THEN
      RAISE EXCEPTION 'cfdi_period_has_documents' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT cfdi_is_worker() THEN RAISE EXCEPTION 'cfdi_global_periods_update_worker_only' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.tenant_id, NEW.mode, NEW.period_key, NEW.periodicity, NEW.date_from, NEW.date_to)
     IS DISTINCT FROM (OLD.tenant_id, OLD.mode, OLD.period_key, OLD.periodicity, OLD.date_from, OLD.date_to) THEN
    RAISE EXCEPTION 'cfdi_period_identity_immutable';
  END IF;
  RETURN NEW;
END $$;
