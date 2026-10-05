-- 023_access.sql — device pairing codes, scoped PIN throttling, session and
-- device lifecycle, renewable offline windows. Expand-only: revision 022 keeps
-- working (it ignores the new columns/tables; NULLs keep legacy semantics).
SET LOCAL lock_timeout = '5s';

-- Devices -----------------------------------------------------------------
-- kind is nullable on purpose: rows written by the previous revision during a
-- rolling deploy stay NULL and are inferred from the name by the application
-- (coalesce(kind, case when name='Owner browser' then 'personal' else 'terminal' end)).
ALTER TABLE devices
  ADD COLUMN kind text CHECK (kind IN ('terminal','personal')),
  ADD COLUMN paired_at timestamptz,
  ADD COLUMN paired_by uuid,
  ADD COLUMN last_seen_at timestamptz,
  ADD COLUMN token_expires_at timestamptz,
  ADD COLUMN idle_lock_seconds integer CHECK (idle_lock_seconds IN (0,60,120,180,300,600,900)),
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by uuid,
  ADD COLUMN revoked_reason text CHECK (revoked_reason IN ('revoked','replaced'));
ALTER TABLE devices ADD CONSTRAINT device_paired_by
  FOREIGN KEY (tenant_id, paired_by) REFERENCES employees(tenant_id, id) NOT VALID;
ALTER TABLE devices ADD CONSTRAINT device_revoked_by
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES employees(tenant_id, id) NOT VALID;
ALTER TABLE devices ADD CONSTRAINT device_revocation_complete
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)) NOT VALID;
ALTER TABLE devices VALIDATE CONSTRAINT device_paired_by;
ALTER TABLE devices VALIDATE CONSTRAINT device_revoked_by;
ALTER TABLE devices VALIDATE CONSTRAINT device_revocation_complete;
-- devices is small (one row per paired browser). The backfill runs as the
-- table owner, which may lack BYPASSRLS (a Neon owner role does): lift FORCE
-- for this transaction only so the owner is exempt from tenant_scope, then
-- restore it (OPS-R2; same pattern as 025_menu.sql).
ALTER TABLE devices NO FORCE ROW LEVEL SECURITY;
UPDATE devices SET kind = CASE WHEN name = 'Owner browser' THEN 'personal' ELSE 'terminal' END;
UPDATE devices SET token_expires_at = now() + interval '30 days' WHERE active;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;

-- Employees ---------------------------------------------------------------
ALTER TABLE employees
  ADD COLUMN pin_set_at timestamptz,
  ADD COLUMN deactivated_at timestamptz;
-- No backfill: "has a usable PIN" = pin_set_at IS NOT NULL OR login NOT LIKE 'account-%'.

-- Sessions ----------------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN created_at timestamptz,
  ADD COLUMN last_seen_at timestamptz,
  ADD COLUMN absolute_expires_at timestamptz,
  ADD COLUMN authenticated_at timestamptz,
  ADD COLUMN ended_at timestamptz,
  ADD COLUMN end_reason text CHECK (end_reason IN (
    'logout','switched','replaced','pin_reset','role_changed',
    'employee_deactivated','device_revoked','ended_by_manager'));
-- Legacy rows keep created_at NULL; new rows default to now().
ALTER TABLE sessions ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE sessions ADD CONSTRAINT session_end_complete
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)) NOT VALID;
ALTER TABLE sessions ADD CONSTRAINT session_absolute_cap
  CHECK (absolute_expires_at IS NULL OR expires_at <= absolute_expires_at) NOT VALID;
ALTER TABLE sessions VALIDATE CONSTRAINT session_end_complete;
ALTER TABLE sessions VALIDATE CONSTRAINT session_absolute_cap;
-- sessions is small before production launch (production DB is new; staging has
-- a few thousand rows), so plain CREATE INDEX inside the migration transaction is
-- acceptable. On a large table, build these indexes beforehand (docs/ACCESS.md).
CREATE INDEX sessions_live_by_device ON sessions(tenant_id, device_id)
  WHERE ended_at IS NULL AND NOT revoked;
CREATE INDEX sessions_live_by_employee ON sessions(tenant_id, employee_id)
  WHERE ended_at IS NULL AND NOT revoked;

-- PIN throttling (operational state, mutable; never financial evidence) ----
CREATE TABLE pin_throttles (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  employee_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope ~ '^(device:[0-9a-f-]{36}|unpaired)$'),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  lock_level integer NOT NULL DEFAULT 0 CHECK (lock_level >= 0),
  locked_until timestamptz,
  last_failure_at timestamptz,
  PRIMARY KEY (tenant_id, employee_id, scope),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id) ON DELETE CASCADE
);

-- Pairing codes ----------------------------------------------------------
CREATE TABLE device_pairing_codes (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  code_hash text NOT NULL UNIQUE,          -- HMAC-SHA256(JWT_SECRET, 'gm-pairing-v1:'||code)
  device_name text NOT NULL CHECK (length(device_name) BETWEEN 1 AND 60),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  device_id uuid,
  cancelled_at timestamptz,
  cancelled_by uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES employees(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, cancelled_by) REFERENCES employees(tenant_id, id) ON DELETE CASCADE,
  CHECK ((consumed_at IS NULL) = (device_id IS NULL)),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
  CHECK (consumed_at IS NULL OR cancelled_at IS NULL),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes')
);
CREATE INDEX device_pairing_codes_open ON device_pairing_codes(tenant_id, expires_at)
  WHERE consumed_at IS NULL AND cancelled_at IS NULL;
-- Exactly one transition (consume or cancel), nothing else may change.
CREATE FUNCTION device_pairing_code_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL OR OLD.cancelled_at IS NOT NULL
     OR (NEW.tenant_id, NEW.id, NEW.code_hash, NEW.device_name, NEW.created_by,
         NEW.created_at, NEW.expires_at)
        IS DISTINCT FROM
        (OLD.tenant_id, OLD.id, OLD.code_hash, OLD.device_name, OLD.created_by,
         OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'device_pairing_code_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER device_pairing_codes_transition BEFORE UPDATE ON device_pairing_codes
  FOR EACH ROW EXECUTE FUNCTION device_pairing_code_transition();

-- Offline window renewals (append-only evidence) --------------------------
CREATE TABLE offline_lease_renewals (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  session_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  issued_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, session_id, sequence),
  FOREIGN KEY (tenant_id, session_id) REFERENCES offline_leases(tenant_id, session_id) ON DELETE CASCADE,
  CHECK (valid_until >= issued_at)
);
-- Reuses migration 018's function: runtime UPDATE always raises. Privileged
-- retention may still remove a whole session (and its renewals) through the FK.
CREATE TRIGGER offline_lease_renewals_immutable BEFORE UPDATE ON offline_lease_renewals
  FOR EACH ROW EXECUTE FUNCTION immutable_offline_evidence();

-- RLS ---------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['pin_throttles','device_pairing_codes','offline_lease_renewals'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
-- A terminal redeeming a code has no tenant yet: it may read exactly the row
-- whose hash it supplies (same pattern as restaurant_invitations, migration 014).
CREATE POLICY pairing_code_redeem_read ON device_pairing_codes FOR SELECT
  USING (code_hash = nullif(current_setting('app.pairing_code_hash', true), ''));
