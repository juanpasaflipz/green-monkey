/**
 * Retention (DB-8, wave 1 contract §1.2). It may delete only:
 *   - oauth_login_attempts that are consumed or expired (after a 1-day grace);
 *   - jobs in a terminal state (done or dead) older than 30 days.
 * It never deletes sessions, leases, operations, audit, money, stock, cash,
 * void, offline evidence or public ordering rows (tests assert the
 * allow-list). It redacts in place only (redactionRules): the diner name and
 * note of public ordering holds older than 30 days, which 034's transition
 * trigger allows as a redaction-only update (LD-41, PUBLIC-SECURITY-3), and the
 * name and phone of loyalty members inactive for 24 months (038).
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
  /** Rows whose personal data a redaction rule blanked (never deleted). */
  redacted: Record<string, number>;
  /**
   * Tables this run did not drain: their last batch was full (or the time
   * budget ran out before their first one), so the run stopped at maxBatches
   * or its budget and matching rows may remain. A table whose last batch came
   * back short, a full batch followed by an empty one included, is drained
   * and never listed (PLAT-R3).
   */
  backlog: string[];
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
 * The daily run (migrate.js --retention-only): repeats bounded passes while the previous one left a
 * backlog (some table's last batch was full, so it stopped at maxBatches or its time budget), up to
 * maxPasses, and starts a further pass only inside RETENTION_WINDOW. A pass whose tables all ended on a
 * short batch, a full batch followed by an empty one included, is final: no extra empty pass (PLAT-R3).
 * Stops at the first failed run, failed table or lock-timeout skip, and returns that pass's
 * backlog/skipped/failed lists with the deletions and redactions summed over every pass (P-24). An
 * operator run outside the window therefore does exactly one pass.
 */
export async function retentionPasses(
  sql: postgres.Sql,
  alert: (a: Alert) => Promise<void>,
  o: {
    maxPasses?: number;
    now?: () => number;
    pass?: typeof retentionPass;
    /** runRetention options for every pass (batch size, batches per table, pause). */
    run?: Parameters<typeof runRetention>[1];
  } = {},
): Promise<RetentionResult | null> {
  const maxPasses = o.maxPasses ?? 10;
  const now = o.now ?? Date.now;
  const pass = o.pass ?? retentionPass;
  const deleted: Record<string, number> = {};
  const redacted: Record<string, number> = {};
  for (let n = 0; ; n++) {
    const r = await pass(sql, alert, o.run);
    if (!r) return null;
    for (const [table, count] of Object.entries(r.deleted))
      deleted[table] = (deleted[table] ?? 0) + count;
    for (const [table, count] of Object.entries(r.redacted ?? {}))
      redacted[table] = (redacted[table] ?? 0) + count;
    if (
      r.failed.length ||
      r.skipped.length ||
      !r.backlog.length ||
      n + 1 >= maxPasses ||
      !inRetentionWindow(now())
    ) {
      if (n > 0)
        log.info("retention_passes", {
          passes: n + 1,
          deleted,
          redacted,
          backlog: r.backlog,
        });
      return {
        deleted,
        redacted,
        backlog: r.backlog,
        skipped: r.skipped,
        failed: r.failed,
      };
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

/**
 * Personal data blanked in place, never deleted: the hold rows stay (status
 * pages, the abuse and churn reads and the owner export use them; public
 * ordering's tables are never deleted). The diner's name and note of every
 * hold older than 30 days, in any state (LD-41): an accepted hold's call name
 * lives on as the order's, which is the restaurant's sales record. 034's
 * partial index public_order_holds_unredacted serves the predicate, and its
 * transition trigger allows exactly this update.
 */
export const redactionRules: readonly {
  table: string;
  set: string;
  predicate: string;
}[] = [
  {
    table: "public_order_holds",
    set: `name = '', note = ''`,
    predicate: `(name <> '' OR note <> '') AND created_at < now() - interval '30 days'`,
  },
  // Loyalty (038, specs/loyalty-w4.md §2.11, §3.3): a club member with no activity for 24 months
  // (the last ledger row other than an import, else the last pos-lite visit, else joining) loses
  // name, phone and the notice snapshot; the member, ledger and order links stay (no loyalty row
  // is ever deleted). 038's guard trigger lets this first redaction through; 038's partial index
  // loyalty_members_inactive serves the predicate.
  {
    table: "loyalty_members",
    set: `name = '', name_key = '', phone_e164 = NULL, consent_notice_url = NULL,
        marketing_opt_in = false, redacted_at = now(), redaction_reason = 'retention',
        version = version + 1, updated_at = now()`,
    predicate: `redacted_at IS NULL
    AND coalesce(last_activity_at, legacy_last_visit_at, joined_at) < now() - interval '24 months'`,
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
): Promise<RetentionResult> {
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
  const redacted: Record<string, number> = {};
  const backlog: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  const rules = [
    ...retentionRules.map((rule) => ({
      ...rule,
      counts: deleted,
      statement: `delete from ${rule.table} where ctid in (select ctid from ${rule.table} where ${rule.predicate} limit $1)`,
    })),
    ...redactionRules.map((rule) => ({
      ...rule,
      counts: redacted,
      statement: `update ${rule.table} set ${rule.set} where ctid in (select ctid from ${rule.table} where ${rule.predicate} limit $1)`,
    })),
  ];
  for (const rule of rules) {
    if (!IDENT.test(rule.table)) throw Error("retention_table_invalid");
    rule.counts[rule.table] = 0;
    // A short (or empty) batch drains the table. A loop that ends at
    // maxBatches or the time budget, even before its first batch, leaves a
    // possible backlog.
    let drained = false;
    try {
      for (let n = 0; n < maxBatches && now() - started < budgetMs; n++) {
        if (n > 0 && pauseMs > 0)
          await new Promise((r) => setTimeout(r, pauseMs));
        const count = await sql.begin(async (raw) => {
          const tx = raw as Tx;
          // Transaction-local: the lock wait and every statement (the
          // DELETE's or UPDATE's scan above all) are bounded while ACCESS
          // EXCLUSIVE is held; a timeout rolls the whole batch back, FORCE
          // included.
          await tx`select set_config('lock_timeout', ${lockTimeoutMs + "ms"}, true),
                          set_config('statement_timeout', ${statementTimeoutMs + "ms"}, true)`;
          await tx.unsafe(
            `alter table ${rule.table} no force row level security`,
          );
          const result = await tx.unsafe(rule.statement, [batch]);
          await tx.unsafe(`alter table ${rule.table} force row level security`);
          const [state] = await tx`
            select relforcerowsecurity as forced from pg_class
            where oid = to_regclass(${"public." + rule.table})`;
          if (!state?.forced) throw Error("retention_rls_not_restored");
          return result.count;
        });
        rule.counts[rule.table] += count;
        if (count < batch) {
          drained = true;
          break;
        }
      }
      if (!drained) backlog.push(rule.table);
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
  log.info("retention_run", {
    deleted,
    redacted,
    backlog,
    skipped,
    failed,
    ms: now() - started,
  });
  return { deleted, redacted, backlog, skipped, failed };
}
