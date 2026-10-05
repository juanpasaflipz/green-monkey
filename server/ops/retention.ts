/**
 * Retention (DB-8, wave 1 contract §1.2). It may delete only:
 *   - oauth_login_attempts that are consumed or expired (after a 1-day grace);
 *   - jobs in a terminal state (done or dead) older than 30 days.
 * It never deletes sessions, leases, operations, audit, money, stock, cash,
 * void or offline evidence rows (tests assert the allow-list).
 *
 * Both tables force row-level security and the runtime role has no DELETE,
 * so the pass runs as the schema owner from the deploy step
 * (`migrate.js --retention`). Each batch uses the owner pattern migrations
 * use for backfills: in one short transaction, NO FORCE ROW LEVEL SECURITY,
 * a bounded DELETE, FORCE ROW LEVEL SECURITY. The ACCESS EXCLUSIVE lock is
 * held for milliseconds, lock_timeout keeps it from queueing behind traffic,
 * and nobody ever observes the table without FORCE.
 */
import type postgres from "postgres";
import type { Tx } from "../db.js";
import { log } from "../logging.js";

export const retentionRules: readonly { table: string; predicate: string }[] = [
  {
    table: "oauth_login_attempts",
    predicate: `(consumed_at IS NOT NULL OR expires_at < now()) AND created_at < now() - interval '1 day'`,
  },
  {
    table: "jobs",
    predicate: `state IN ('done', 'dead') AND created_at < now() - interval '30 days'`,
  },
];

const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Deletes expired rows in bounded batches within a time budget. Lock
 * timeouts skip the table for this run; other errors are logged and
 * reported in `failed`. Never throws for a single table's failure.
 */
export async function runRetention(
  sql: postgres.Sql,
  o: {
    batch?: number;
    maxBatches?: number;
    budgetMs?: number;
    now?: () => number;
  } = {},
): Promise<{
  deleted: Record<string, number>;
  skipped: string[];
  failed: string[];
}> {
  const batch = o.batch ?? 5000;
  const maxBatches = o.maxBatches ?? 20;
  const budgetMs = o.budgetMs ?? 60_000;
  const now = o.now ?? Date.now;
  const started = now();
  const deleted: Record<string, number> = {};
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const rule of retentionRules) {
    if (!IDENT.test(rule.table)) throw Error("retention_table_invalid");
    deleted[rule.table] = 0;
    try {
      for (let n = 0; n < maxBatches && now() - started < budgetMs; n++) {
        const count = await sql.begin(async (raw) => {
          const tx = raw as Tx;
          await tx`select set_config('lock_timeout','2s',true), set_config('statement_timeout','30s',true)`;
          await tx.unsafe(
            `alter table ${rule.table} no force row level security`,
          );
          const result = await tx.unsafe(
            `delete from ${rule.table} where ctid in (select ctid from ${rule.table} where ${rule.predicate} limit $1)`,
            [batch],
          );
          await tx.unsafe(`alter table ${rule.table} force row level security`);
          const [state] = await tx`
            select relforcerowsecurity as forced from pg_class
            where oid = to_regclass(${"public." + rule.table})`;
          if (!state?.forced) throw Error("retention_rls_not_restored");
          return result.count;
        });
        deleted[rule.table] += count;
        if (count < batch) break;
      }
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === "55P03") {
        skipped.push(rule.table);
        log.warn("retention_table_skipped", {
          table: rule.table,
          reason: "lock_timeout",
        });
      } else {
        failed.push(rule.table);
        log.error("retention_table_failed", { table: rule.table }, error);
      }
    }
  }
  log.info("retention_run", { deleted, skipped, failed, ms: now() - started });
  return { deleted, skipped, failed };
}
