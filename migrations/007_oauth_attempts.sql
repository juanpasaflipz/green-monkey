-- Pre-authentication records have no restaurant yet. Scope each transaction to
-- a hash of its random OAuth state; never expose an unscoped account directory.
CREATE TABLE oauth_login_attempts (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[A-Za-z0-9_-]{43}$'),
  browser_hash text NOT NULL CHECK (browser_hash ~ '^[A-Za-z0-9_-]{43}$'),
  nonce text NOT NULL,
  verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '11 minutes')
);
ALTER TABLE oauth_login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_login_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY oauth_attempt_scope ON oauth_login_attempts
  USING (state_hash = nullif(current_setting('app.auth_state_hash', true), ''))
  WITH CHECK (state_hash = nullif(current_setting('app.auth_state_hash', true), ''));
CREATE INDEX oauth_attempt_expiry ON oauth_login_attempts(expires_at);
