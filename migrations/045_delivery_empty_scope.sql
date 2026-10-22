SET LOCAL lock_timeout = '5s';
-- A header-only file is zero only after this same saved context has proved the
-- stable store UUID, and the portal download was scoped to one store and day.
ALTER TABLE delivery_browser_contexts
 ADD COLUMN identity_verified boolean NOT NULL DEFAULT false,
 ADD COLUMN download_scope_verified boolean NOT NULL DEFAULT false;
