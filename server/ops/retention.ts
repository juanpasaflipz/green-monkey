import type postgres from "postgres";
import { log } from "../log.js";

/**
 * Retention predicates. Migration 022 installs the same text as restrictive
 * DELETE policies, so the database refuses any row outside them even if this
 * code is wrong; tests/migrations-lint.test.ts keeps both copies identical.
 */
export const retentionRules: { table: string; predicate: string }[] = [
  {
    table: "oauth_login_attempts",
    predicate: `expires_at < now() - interval '1 day'`,
  },
  {
    table: "billing_operations",
    predicate: `kind = 'reconcile' AND state = 'succeeded' AND completed_at < now() - interval '30 days'`,
  },
  {
    table: "billing_events",
    predicate: `processed_at IS NOT NULL AND processed_at < now() - interval '90 days'`,
  },
  {
    table: "billing_requests",
    predicate: `state <> 'queued' AND processed_at < now() - interval '90 days'`,
  },
  {
    table: "jobs",
    predicate: `(state = 'completed' AND completed_at < now() - interval '30 days') OR (kind = 'receipt' AND state = 'blocked' AND error_code = 'printer_not_paired' AND created_at < now() - interval '30 days')`,
  },
];

const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Deletes expired rows in batches (one transaction per batch) within a time
 * budget. Runs as the worker login through gm_maintenance. Returns deleted
 * counts per table; throws after logging when any table fails.
 */
export async function runRetention(
  sql: postgres.Sql,
  o: { batch?: number; budgetMs?: number; now?: () => number } = {},
): Promise<Record<string, number>> {
  const batch = o.batch ?? 1000;
  const budgetMs = o.budgetMs ?? 60_000;
  const now = o.now ?? Date.now;
  const started = now();
  const counts: Record<string, number> = {};
  let failure: unknown = null;
  for (const rule of retentionRules) {
    if (!IDENT.test(rule.table)) throw Error("retention_table_invalid");
    counts[rule.table] = 0;
    try {
      while (now() - started < budgetMs) {
        const result = await sql.unsafe(
          `delete from ${rule.table} where ctid in (select ctid from ${rule.table} where ${rule.predicate} limit $1)`,
          [batch],
        );
        counts[rule.table] += result.count;
        if (result.count < batch) break;
      }
    } catch (error) {
      failure ??= error;
      log.error("retention_table_failed", { table: rule.table }, error);
    }
  }
  if (failure) {
    log.error("retention_failed", { counts });
    throw failure;
  }
  log.info("retention_run", { counts, ms: now() - started });
  return counts;
}
