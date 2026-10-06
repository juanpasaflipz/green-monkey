// Reports (029): read-only snapshot transactions and the heavy-read timeout convention.
import type postgres from "postgres";
import type { Tx } from "../db.js";
import { DomainError } from "../../shared/domain.js";

/** The lead's heavy-read allowance (a convention, not an ops API): 30 s per statement. */
export const HEAVY_STATEMENT_TIMEOUT = "30s";
/** Equal to the gm_<env>_app role defaults; set explicitly so a pooler never drops them. */
export const SNAPSHOT_LOCK_TIMEOUT = "8s";
export const SNAPSHOT_IDLE_TIMEOUT = "15s";

/**
 * A statement timeout (SQLSTATE 57014) is the report's own answer, not an outage:
 * reports_timeout is HTTP 422, a domain kind the client never retries and that still proves
 * the server reachable (LD-15 reports Q1). A datetime the cursor decoder let through but
 * PostgreSQL refuses (22007, 22008) is the client's invalid_input. Every other error passes
 * through unchanged.
 */
export function mapReportErrors(e: unknown): unknown {
  const code = (e as { code?: unknown })?.code;
  if (code === "57014") return new DomainError("reports_timeout", 422);
  if (code === "22007" || code === "22008")
    return new DomainError("invalid_input", 400);
  return e;
}

/**
 * Runs a whole report in one REPEATABLE READ, READ ONLY transaction: every statement reads the
 * snapshot taken at the first one (PostgreSQL §13.2.2), so a multi-statement summary never sees
 * a payment that commits half way, and its reconciliation checks cannot fail on concurrent
 * writes. Read-only transactions take ACCESS SHARE locks only and need no retry. The first
 * statement sets the tenant (the same pair tenant() sets) plus the heavy-read statement timeout,
 * lock timeout and idle timeout. tenant() itself is unchanged (spec §4.4).
 */
export async function snapshotTenant<T>(
  sql: postgres.Sql,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!tenantId) throw new DomainError("missing_tenant", 403);
  try {
    return (await sql.begin(
      "isolation level repeatable read read only",
      async (raw) => {
        const tx = raw as Tx;
        await tx`select set_config('app.tenant_id', ${tenantId}, true),
                        set_config('statement_timeout', ${HEAVY_STATEMENT_TIMEOUT}, true),
                        set_config('lock_timeout', ${SNAPSHOT_LOCK_TIMEOUT}, true),
                        set_config('idle_in_transaction_session_timeout', ${SNAPSHOT_IDLE_TIMEOUT}, true)`;
        return fn(tx);
      },
    )) as T;
  } catch (e) {
    throw mapReportErrors(e);
  }
}

/**
 * First statement of a heavy write command (corte print, corte del día print, remote close),
 * inside tenant(): raises the statement timeout for the rest of the transaction, overriding the
 * value tenant() set (transaction-local).
 */
export async function heavyStatementTimeout(tx: Tx): Promise<void> {
  await tx`select set_config('statement_timeout', ${HEAVY_STATEMENT_TIMEOUT}, true)`;
}
