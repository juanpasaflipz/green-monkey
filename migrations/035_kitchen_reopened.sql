-- 035_kitchen_reopened.sql — when a kitchen round last became open again
-- (W3-2, FLK-R9). Past KITCHEN_FEED_LIMIT the KDS feed carries the newest
-- open rounds (LD-42); a round that comes back to the screen (a recall, or
-- a manager's "Preparar ahora" for an offline sale) is new to the kitchen,
-- so it ranks by when it reopened, not by its original created_at.
-- Expand-only: one nullable column, stamped by the existing
-- rounds_progress_timestamps trigger, so both app revisions record it; the
-- previous revision never reads it. Every transition the function handled
-- before is handled the same way.
-- No DML (no backfill: a round reopened before this deploys keeps NULL and
-- ranks by created_at, as before), no role, no index (the feed sorts one
-- restaurant's open rounds, which rounds_open finds), no SECURITY DEFINER.
-- Idempotent: ADD COLUMN IF NOT EXISTS and CREATE OR REPLACE FUNCTION.
SET LOCAL lock_timeout = '5s';

-- 1. NULL until the round leaves 'completed' or 'offline_review' for the
-- kitchen screen; a metadata-only change (no default, no rewrite).
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS reopened_at timestamptz;

-- 2. The 024 trigger (BEFORE UPDATE OF state), plus the reopen stamp.
CREATE OR REPLACE FUNCTION rounds_progress_timestamps() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'ready' AND OLD.state IS DISTINCT FROM 'ready' THEN
    NEW.ready_at := clock_timestamp();
  END IF;
  IF NEW.state = 'completed' AND OLD.state IS DISTINCT FROM 'completed' THEN
    NEW.completed_at := clock_timestamp();
  END IF;
  IF NEW.state <> 'completed' THEN
    NEW.completed_at := NULL;   -- recall
  END IF;
  -- 035: a recall (completed to ready) or a "Preparar ahora" decision
  -- (offline_review to active) puts the round back on the kitchen screen.
  IF OLD.state IN ('completed', 'offline_review')
     AND NEW.state NOT IN ('completed', 'offline_review') THEN
    NEW.reopened_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
