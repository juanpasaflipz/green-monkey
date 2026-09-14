ALTER TABLE owner_sessions ADD CONSTRAINT owner_session_account_key UNIQUE(account_id,id);
ALTER TABLE sessions ADD COLUMN owner_account_id uuid;
ALTER TABLE sessions ADD COLUMN owner_session_id uuid;
ALTER TABLE sessions ADD CONSTRAINT owner_session_lineage FOREIGN KEY(owner_account_id,owner_session_id)
  REFERENCES owner_sessions(account_id,id);
ALTER TABLE sessions ADD CONSTRAINT complete_owner_lineage CHECK ((owner_account_id IS NULL)=(owner_session_id IS NULL));
