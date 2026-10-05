SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
-- 022 ops: hot-path indexes (DB-3) for drawer summaries, reports, audit and
-- jobs listings, the jobs outbox claim and the billing worker's claim/inbox
-- scans. Indexes only and expand-only: revision 021 keeps working unchanged.
-- Wave 1 contract §3.15 assigns the order, round, allocation, refund-by-tender
-- and recovery indexes to service (024); they are deliberately not here.
CREATE INDEX tenders_tenant_id_created_at ON tenders (tenant_id, created_at);
CREATE INDEX tenders_tenant_id_session_id ON tenders (tenant_id, session_id);
CREATE INDEX refunds_tenant_id_session_id ON refunds (tenant_id, session_id);
CREATE INDEX refunds_tenant_id_created_at ON refunds (tenant_id, created_at);
CREATE INDEX cash_movements_tenant_id_session_id ON cash_movements (tenant_id, session_id);
CREATE INDEX cash_sessions_tenant_id_closed_at ON cash_sessions (tenant_id, closed_at);
CREATE INDEX audit_tenant_id_created_at ON audit (tenant_id, created_at);
CREATE INDEX jobs_tenant_id_created_at ON jobs (tenant_id, created_at);
CREATE INDEX jobs_state_next_at ON jobs (state, next_at) WHERE state IN ('queued', 'available');
CREATE INDEX billing_operations_available_at ON billing_operations (available_at) WHERE state IN ('pending', 'running');
CREATE INDEX billing_events_subscription_id ON billing_events (subscription_id) WHERE processed_at IS NULL;
