ALTER TABLE restaurants ADD COLUMN config_version integer NOT NULL DEFAULT 1;
-- Existing receipts do not have an original configuration snapshot: leave NULL.
ALTER TABLE orders ADD COLUMN restaurant_snapshot jsonb;
