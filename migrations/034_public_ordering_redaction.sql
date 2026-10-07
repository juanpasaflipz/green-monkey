-- 034_public_ordering_redaction.sql — diner name and note redaction without a
-- table lock (LD-41: PUBLIC-SECURITY-3, PUBLIC-CONCURRENCY-3).
-- Expand-only: the hold transition trigger accepts one more kind of update, a
-- redaction (name and note blanked, every other column unchanged), which the
-- previous revision never sends; every update it allowed before is still
-- allowed and every one it refused is still refused. A partial index serves
-- the retention pass that blanks holds older than 30 days.
-- No DML (no backfill: the retention pass blanks old holds in bounded batches
-- after deploy, so LD-6 is not triggered), no role, no SECURITY DEFINER.
-- Idempotent: CREATE OR REPLACE FUNCTION and CREATE INDEX IF NOT EXISTS.
SET LOCAL lock_timeout = '5s';

-- 1. Redaction is a plain tenant-scoped UPDATE: support's ARCO block and the
-- retention pass no longer disable the trigger (DISABLE TRIGGER took SHARE ROW
-- EXCLUSIVE on the whole shared table, for every restaurant, until commit).
-- It applies in every state, accepted holds included: the order's call name is
-- the restaurant's sales record, the hold's copy is not. The columns are NOT
-- NULL DEFAULT '' (032), so a redaction blanks them to ''. Who may redact is
-- decided by the grants: gm_app has no UPDATE on name or note (scripts/
-- grants.sql, -- 034), so only the schema owner can.
CREATE OR REPLACE FUNCTION public_order_hold_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name = '' AND NEW.note = ''
     AND (to_jsonb(NEW) - 'name' - 'note') = (to_jsonb(OLD) - 'name' - 'note')
  THEN
    RETURN NEW;
  END IF;
  -- Exactly one decision; the diner's request is immutable evidence.
  IF OLD.state <> 'pending'
     OR NEW.state NOT IN ('accepted', 'rejected', 'cancelled')
     OR (NEW.tenant_id, NEW.id, NEW.link_id, NEW.operation_id, NEW.request_hash,
         NEW.status_key_hash, NEW.business_date, NEW.number, NEW.channel, NEW.mode,
         NEW.table_id, NEW.policy, NEW.name, NEW.note, NEW.lines, NEW.priced,
         NEW.quoted_total, NEW.menu_revision, NEW.order_operation_id,
         NEW.created_at, NEW.expires_at)
        IS DISTINCT FROM
        (OLD.tenant_id, OLD.id, OLD.link_id, OLD.operation_id, OLD.request_hash,
         OLD.status_key_hash, OLD.business_date, OLD.number, OLD.channel, OLD.mode,
         OLD.table_id, OLD.policy, OLD.name, OLD.note, OLD.lines, OLD.priced,
         OLD.quoted_total, OLD.menu_revision, OLD.order_operation_id,
         OLD.created_at, OLD.expires_at)
  THEN
    RAISE EXCEPTION 'public_order_hold_immutable';
  END IF;
  RETURN NEW;
END $$;

-- 2. The retention pass (server/ops/retention.ts) blanks the name and note of
-- holds older than 30 days. Only holds that still carry one are indexed, so
-- each daily batch finds its rows without scanning the history; the table is
-- small when this deploys (production has not launched, LD-8).
CREATE INDEX IF NOT EXISTS public_order_holds_unredacted
  ON public_order_holds (created_at) WHERE name <> '' OR note <> '';
