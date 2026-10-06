/**
 * Retention (DB-8, wave 1 contract §1.2). It may delete only:
 *   - oauth_login_attempts that are consumed or expired (after a 1-day grace);
 *   - jobs in a terminal state (done or dead) older than 30 days.
 * It never deletes sessions, leases, operations, audit, money, stock, cash,
 * void or offline evidence rows (tests assert the allow-list).
 *
 * Both tables force row-level security and the runtime role has no DELETE,
 * so the pass runs as the schema owner from GitHub Actions: once per deploy
 * (`migrate.js --grants --retention`) and daily from
 * .github/workflows/retention.yml (`--retention-only`, up to 10 passes while a
 * backlog remains) inside RETENTION_WINDOW, after the nightly backup. No
 * Railway service holds the credential (Wave 2.0 (l)). Each batch uses the
 * owner pattern migrations use
 * for backfills: in one transaction, NO FORCE ROW LEVEL SECURITY, a bounded
 * DELETE, FORCE ROW LEVEL SECURITY, so nobody ever observes the table without
 * FORCE. The ALTER takes ACCESS EXCLUSIVE until commit, and every order and
 * payment inserts into jobs, so each batch is bounded (OPS-R10): the ALTER
 * waits at most RETENTION_LOCK_TIMEOUT_MS (others queue behind it only that
 * long) and every statement at most RETENTION_STATEMENT_TIMEOUT_MS, so a scan
 * that outgrows the bound aborts and alerts instead of freezing sales. No
 * index serves the jobs predicate yet; RUNBOOK "Open follow-ups" records the
 * DDL-free design (a maintenance DELETE policy or a partial index).
 */
import type postgres from "postgres";
import type { Tx } from "../db.js";
import { log } from "../logging.js";
import type { Alert } from "./alerts.js";

/** Rows one batch deletes at most (runRetention's default). */
export const RETENTION_BATCH = 5000;
/** Longest wait for the ACCESS EXCLUSIVE lock; jobs inserts queue behind it. */
export const RETENTION_LOCK_TIMEOUT_MS = 200;
/** Longest any statement of a batch runs while the lock is held. */
export const RETENTION_STATEMENT_TIMEOUT_MS = 1500;
/** Pause between batches so inserts queued behind a batch drain first. */
export const RETENTION_PAUSE_MS = 250;

export interface RetentionWindow {
  timeZone: string;
  /** First local hour inside the window (inclusive). */
  startHour: number;
  /** First local hour after the window (exclusive). */
  endHour: number;
}

/**
 * The daily retention run (.github/workflows/retention.yml) starts, and
 * retentionPasses starts a further pass, only between 04:00 and 07:00 in
 * Mexico City (UTC-6 all year): after the nightly backup starts (03:30) and
 * before most restaurants open, breakfast service included (OPS-R10,
 * OPS-R15). A restaurant already selling then can still see order and
 * payment inserts pause for up to about 1.7 s per batch (the lock wait plus
 * the statement bound).
 */
export const RETENTION_WINDOW: RetentionWindow = {
  timeZone: "America/Mexico_City",
  startHour: 4,
  endHour: 7,
};

/** Whether `at` falls inside the window, in the window's time zone. */
export function inRetentionWindow(
  at: number | Date,
  window: RetentionWindow = RETENTION_WINDOW,
): boolean {
  const hour =
    Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: window.timeZone,
        hour: "numeric",
        hourCycle: "h23",
      }).format(at),
    ) % 24;
  return hour >= window.startHour && hour < window.endHour;
}

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

/**
 * The daily run (migrate.js --retention-only): repeats bounded passes while the previous one deleted at
 * least one full batch from some table (a backlog may remain), up to maxPasses, and starts a further pass
 * only inside RETENTION_WINDOW. Stops at the first failed run, failed table or lock-timeout skip, and
 * returns that pass's skipped/failed lists with the deletions summed over every pass (P-24). An operator
 * run outside the window therefore does exactly one pass.
 */
export async function retentionPasses(
  sql: postgres.Sql,
  alert: (a: Alert) => Promise<void>,
  o: {
    maxPasses?: number;
    now?: () => number;
    pass?: typeof retentionPass;
  } = {},
): Promise<RetentionResult | null> {
  const maxPasses = o.maxPasses ?? 10;
  const now = o.now ?? Date.now;
  const pass = o.pass ?? retentionPass;
  const deleted: Record<string, number> = {};
  for (let n = 0; ; n++) {
    const r = await pass(sql, alert);
    if (!r) return null;
    for (const [table, count] of Object.entries(r.deleted))
      deleted[table] = (deleted[table] ?? 0) + count;
    const backlog = Object.values(r.deleted).some(
      (count) => count >= RETENTION_BATCH,
    );
    if (
      r.failed.length ||
      r.skipped.length ||
      !backlog ||
      n + 1 >= maxPasses ||
      !inRetentionWindow(now())
    ) {
      if (n > 0) log.info("retention_passes", { passes: n + 1, deleted });
      return { deleted, skipped: r.skipped, failed: r.failed };
    }
  }
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
 * Deletes expired rows in bounded batches within a time budget. A lock
 * timeout skips the table for this run; any other error, including a
 * statement timeout, is logged and reported in `failed`. Never throws for a
 * single table's failure.
 */
export async function runRetention(
  sql: postgres.Sql,
  o: {
    batch?: number;
    maxBatches?: number;
    budgetMs?: number;
    lockTimeoutMs?: number;
    statementTimeoutMs?: number;
    pauseMs?: number;
    now?: () => number;
  } = {},
): Promise<{
  deleted: Record<string, number>;
  skipped: string[];
  failed: string[];
}> {
  const batch = o.batch ?? RETENTION_BATCH;
  const maxBatches = o.maxBatches ?? 20;
  const budgetMs = o.budgetMs ?? 60_000;
  const lockTimeoutMs = o.lockTimeoutMs ?? RETENTION_LOCK_TIMEOUT_MS;
  const statementTimeoutMs =
    o.statementTimeoutMs ?? RETENTION_STATEMENT_TIMEOUT_MS;
  const pauseMs = o.pauseMs ?? RETENTION_PAUSE_MS;
  for (const ms of [lockTimeoutMs, statementTimeoutMs])
    if (!Number.isInteger(ms) || ms < 1)
      throw Error("retention_timeout_invalid");
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
        if (n > 0 && pauseMs > 0)
          await new Promise((r) => setTimeout(r, pauseMs));
        const count = await sql.begin(async (raw) => {
          const tx = raw as Tx;
          // Transaction-local: the lock wait and every statement (the
          // DELETE's scan above all) are bounded while ACCESS EXCLUSIVE is
          // held; a timeout rolls the whole batch back, FORCE included.
          await tx`select set_config('lock_timeout', ${lockTimeoutMs + "ms"}, true),
                          set_config('statement_timeout', ${statementTimeoutMs + "ms"}, true)`;
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
        log.error(
          "retention_table_failed",
          {
            table: rule.table,
            reason: code === "57014" ? "statement_timeout" : "error",
          },
          error,
        );
      }
    }
  }
  log.info("retention_run", { deleted, skipped, failed, ms: now() - started });
  return { deleted, skipped, failed };
}
