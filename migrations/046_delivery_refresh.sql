SET LOCAL lock_timeout = '5s';
ALTER TABLE delivery_browser_contexts ADD COLUMN request_excluded_rows jsonb NOT NULL DEFAULT '[]';
COMMENT ON COLUMN delivery_daily_reports.store_id IS 'Stable store UUID from the verified provider report, never the display name.';
