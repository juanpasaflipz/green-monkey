/**
 * Retention (DB-8, wave 1 contract §1.2). It may delete only:
 *   - oauth_login_attempts that are consumed or expired (after a 1-day grace);
 *   - jobs in a terminal state (done or dead) older than 30 days.
 * It never deletes sessions, leases, operations, audit, money, stock, cash,
 * void or offline evidence rows (tests assert the allow-list).
 *
 * Both tables force row-level security and the runtime role has no DELETE,
 * so the pass runs as the schema owner: every 15 minutes from the worker
 * (MIGRATION_DATABASE_URL, which its preDeploy already holds) and once per
 * deploy (`migrate.js --retention`). Each batch uses the owner pattern
 * migrations use for backfills: in one short transaction, NO FORCE ROW LEVEL
 * SECURITY, a bounded DELETE, FORCE ROW LEVEL SECURITY. The ACCESS EXCLUSIVE
 * lock is held for milliseconds, lock_timeout keeps it from queueing behind
 * traffic, and nobody ever observes the table without FORCE.
 */
import postgres from "postgres";
import type { Tx } from "../db.js";
import { databaseTls, withoutParams } from "../db-support.js";
import { log } from "../logging.js";
import type { Alert } from "./alerts.js";

/** How often the worker runs retention (spec §4.15); first run 60 s after boot. */
export const RETENTION_INTERVAL_MS = 15 * 60_000;
export const RETENTION_FIRST_RUN_MS = 60_000;

export type RetentionResult = {
  deleted: Record<string, number>;
  skipped: string[];
  failed: string[];
};

/**
 * One retention run that never throws: a failed table, or a run that could
 * not start (database down, credential rejected), raises `retention_failed`.
 * Lock-timeout skips are routine and only logged. Returns null when the run
 * itself failed.
 */
export async function retentionPass(
  sql: postgres.Sql,
  alert: (a: Alert) => Promise<void>,
  o: Parameters<typeof runRetention>[1] = {},
): Promise<RetentionResult | null> {
  let result: RetentionResult | null = null;
  let failed: string[];
  try {
    result = await runRetention(sql, o);
    failed = result.failed;
  } catch (error) {
    log.error("retention_run_failed", {}, error);
    failed = ["run"];
  }
  if (failed.length) {
    log.error("retention_failed", { tables: failed });
    await alert({
      key: "retention_failed",
      severity: "warning",
      title: "retention failed",
      body: `retention_failed tables=${failed.join(",")}`,
    });
  }
  return result;
}

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

export interface RetentionSchedule {
  start(): void;
  /** Runs one pass now unless one is already running (then returns null). */
  runNow(): Promise<RetentionResult | null>;
  /** Time of the last finished pass, for the worker's /healthz body. */
  lastRunAt(): number | null;
  stop(): Promise<void>;
}

/**
 * The worker's periodic retention (OPS-R6): every 15 minutes, first run 60 s
 * after boot, on its own one-connection pool for the owner credential that
 * closes when idle. Runs never overlap, and each failure alerts through
 * retentionPass.
 */
export function createRetentionSchedule(o: {
  url: string;
  alert: (a: Alert) => Promise<void>;
  intervalMs?: number;
  firstRunMs?: number;
  run?: (
    sql: postgres.Sql,
    alert: (a: Alert) => Promise<void>,
  ) => Promise<RetentionResult | null>;
}): RetentionSchedule {
  const url = new URL(o.url);
  let sql: postgres.Sql | null = null;
  let running: Promise<RetentionResult | null> | null = null;
  let last: number | null = null;
  const timers: NodeJS.Timeout[] = [];
  const pool = () =>
    (sql ??= postgres(withoutParams(url).href, {
      max: 1,
      ssl: databaseTls(url),
      connect_timeout: 10,
      idle_timeout: 30,
      connection: { application_name: "gm-retention" },
      onnotice: () => {},
    }));
  const runNow = async () => {
    if (running) return null;
    running = (o.run ?? retentionPass)(pool(), o.alert).finally(() => {
      running = null;
      last = Date.now();
    });
    return running;
  };
  return {
    start() {
      const first = setTimeout(
        () => void runNow(),
        o.firstRunMs ?? RETENTION_FIRST_RUN_MS,
      );
      const every = setInterval(
        () => void runNow(),
        o.intervalMs ?? RETENTION_INTERVAL_MS,
      );
      first.unref();
      every.unref();
      timers.push(first, every);
    },
    runNow,
    lastRunAt: () => last,
    async stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
      await running?.catch(() => undefined);
      await sql?.end({ timeout: 5 });
      sql = null;
    },
  };
}
