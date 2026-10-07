import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type postgres from "postgres";
import type { Alert } from "../server/ops/alerts.js";
import {
  inRetentionWindow,
  RETENTION_BATCH,
  RETENTION_LOCK_TIMEOUT_MS,
  RETENTION_STATEMENT_TIMEOUT_MS,
  RETENTION_WINDOW,
  redactionRules,
  retentionPass,
  retentionPasses,
  retentionRules,
  runRetention,
  type RetentionResult,
} from "../server/ops/retention.js";
import { setLogSink } from "../server/logging.js";

setLogSink(() => {});

/** A pool whose transactions fail with one PostgreSQL error code. */
const failing = (code: string) =>
  ({
    begin: async () => {
      throw Object.assign(new Error(code), { code });
    },
  }) as unknown as postgres.Sql;
/** A pool whose batches delete nothing. */
const empty = { begin: async () => 0 } as unknown as postgres.Sql;

describe("retention pass (OPS-R6)", () => {
  it("alerts retention_failed with table names only when a table fails", async () => {
    const alerts: Alert[] = [];
    const result = await retentionPass(failing("XX000"), async (a) => {
      alerts.push(a);
    });
    expect(result?.failed).toEqual([
      "oauth_login_attempts",
      "jobs",
      "public_order_holds",
    ]);
    expect(alerts).toEqual([
      {
        key: "retention_failed",
        severity: "warning",
        title: "retention failed",
        body: "retention_failed tables=oauth_login_attempts,jobs,public_order_holds",
      },
    ]);
  });

  it("treats lock timeouts as routine skips without an alert", async () => {
    const alerts: Alert[] = [];
    const result = await retentionPass(failing("55P03"), async (a) => {
      alerts.push(a);
    });
    expect(result?.skipped).toEqual([
      "oauth_login_attempts",
      "jobs",
      "public_order_holds",
    ]);
    expect(alerts).toEqual([]);
  });

  it("a clean run reports zero deletions and no alert", async () => {
    const alerts: Alert[] = [];
    const result = await retentionPass(empty, async (a) => {
      alerts.push(a);
    });
    expect(result).toEqual({
      deleted: { oauth_login_attempts: 0, jobs: 0 },
      redacted: { public_order_holds: 0 },
      skipped: [],
      failed: [],
    });
    expect(alerts).toEqual([]);
  });

  it("a statement timeout fails the table and alerts; it is not a routine skip (OPS-R10)", async () => {
    const alerts: Alert[] = [];
    const result = await retentionPass(failing("57014"), async (a) => {
      alerts.push(a);
    });
    expect(result?.failed).toEqual([
      "oauth_login_attempts",
      "jobs",
      "public_order_holds",
    ]);
    expect(result?.skipped).toEqual([]);
    expect(alerts.map((a) => a.key)).toEqual(["retention_failed"]);
  });
});

describe("retention bounds and off-hours window (OPS-R10)", () => {
  it("every batch bounds the lock wait and each statement before it takes ACCESS EXCLUSIVE", async () => {
    const statements: { text: string; values: unknown[] }[] = [];
    const tx = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join("$");
        statements.push({ text, values });
        return Promise.resolve(
          text.includes("relforcerowsecurity") ? [{ forced: true }] : [],
        );
      },
      {
        unsafe: (text: string, values: unknown[] = []) => {
          statements.push({ text, values });
          return Promise.resolve(Object.assign([], { count: 0 }));
        },
      },
    );
    const sql = {
      begin: async (fn: (t: typeof tx) => Promise<number>) => fn(tx),
    } as unknown as postgres.Sql;
    const result = await runRetention(sql, { pauseMs: 0 });
    expect(result.failed).toEqual([]);
    expect(RETENTION_LOCK_TIMEOUT_MS).toBe(200);
    expect(RETENTION_STATEMENT_TIMEOUT_MS).toBe(1500);
    for (const table of [
      "oauth_login_attempts",
      "jobs",
      "public_order_holds",
    ]) {
      const alter = statements.findIndex(
        (s) => s.text === `alter table ${table} no force row level security`,
      );
      expect(alter).toBeGreaterThan(0);
      const bounds = statements[alter - 1];
      expect(bounds.text).toContain("set_config('lock_timeout'");
      expect(bounds.text).toContain("set_config('statement_timeout'");
      expect(bounds.values).toEqual(["200ms", "1500ms"]);
    }
    await expect(runRetention(sql, { statementTimeoutMs: 0 })).rejects.toThrow(
      "retention_timeout_invalid",
    );
  });

  it("deletes only from the two allow-listed tables and only redacts holds older than 30 days, in place (LD-41, PUBLIC-SECURITY-3)", async () => {
    expect(retentionRules.map((r) => r.table)).toEqual([
      "oauth_login_attempts",
      "jobs",
    ]);
    expect(redactionRules).toEqual([
      {
        table: "public_order_holds",
        set: "name = '', note = ''",
        predicate:
          "(name <> '' OR note <> '') AND created_at < now() - interval '30 days'",
      },
    ]);
    const statements: string[] = [];
    const tx = Object.assign(
      (strings: TemplateStringsArray) => {
        const text = strings.join("$");
        return Promise.resolve(
          text.includes("relforcerowsecurity") ? [{ forced: true }] : [],
        );
      },
      {
        unsafe: (text: string) => {
          statements.push(text);
          return Promise.resolve(Object.assign([], { count: 0 }));
        },
      },
    );
    const sql = {
      begin: async (fn: (t: typeof tx) => Promise<number>) => fn(tx),
    } as unknown as postgres.Sql;
    await runRetention(sql, { pauseMs: 0 });
    const holds = statements.filter((t) => t.includes("public_order_holds"));
    expect(holds).toEqual([
      "alter table public_order_holds no force row level security",
      "update public_order_holds set name = '', note = '' where ctid in (select ctid from public_order_holds where (name <> '' OR note <> '') AND created_at < now() - interval '30 days' limit $1)",
      "alter table public_order_holds force row level security",
    ]);
    expect(statements.some((t) => /^delete from public_/.test(t))).toBe(false);
  });

  it("the window is 04:00-07:00 in Mexico City, before breakfast service (OPS-R15)", () => {
    expect(RETENTION_WINDOW).toEqual({
      timeZone: "America/Mexico_City",
      startHour: 4,
      endHour: 7,
    });
    const at = (iso: string) => inRetentionWindow(Date.parse(iso));
    // Mexico City is UTC-6 all year.
    expect(at("2026-10-05T09:59:00Z")).toBe(false); // 03:59, backup time
    expect(at("2026-10-05T10:00:00Z")).toBe(true); // 04:00
    expect(at("2026-10-05T12:59:00Z")).toBe(true); // 06:59
    expect(at("2026-10-05T13:00:00Z")).toBe(false); // 07:00, breakfast
    expect(at("2026-10-05T15:59:00Z")).toBe(false); // 09:59, breakfast
    expect(at("2026-10-05T16:00:00Z")).toBe(false); // 10:00
    expect(at("2026-10-05T18:30:00Z")).toBe(false); // 12:30, service
    expect(at("2026-10-06T05:00:00Z")).toBe(false); // 23:00, service
    expect(at("2026-10-06T06:00:00Z")).toBe(false); // 00:00
    expect(at("2026-01-15T10:30:00Z")).toBe(true); // winter, 04:30
  });

  it("server/worker.ts never mentions MIGRATION_DATABASE_URL, retentionPass or createRetentionSchedule (Wave 2.0 (l))", () => {
    const source = readFileSync("server/worker.ts", "utf8");
    for (const name of [
      "MIGRATION_DATABASE_URL",
      "retentionPass",
      "createRetentionSchedule",
    ])
      expect(source, name).not.toContain(name);
    expect(readFileSync("server/ops/retention.ts", "utf8")).not.toMatch(
      /createRetentionSchedule|RetentionSchedule|RETENTION_INTERVAL_MS/,
    );
  });
});

describe("retentionPasses (P-24)", () => {
  // 05:15 and 06:59 in Mexico City (UTC-6), inside the window; 07:00 is not.
  const inside = Date.parse("2026-10-05T11:15:00Z");
  const lastMinute = Date.parse("2026-10-05T12:59:00Z");
  const after = Date.parse("2026-10-05T13:00:00Z");
  const noAlert = async () => {};
  const sql = {} as postgres.Sql;
  /** An injected pass that returns the scripted results in order and counts calls. */
  function scripted(results: (RetentionResult | null)[]) {
    const calls = { n: 0 };
    const pass = (async () => {
      const r = results[Math.min(calls.n, results.length - 1)];
      calls.n++;
      return r;
    }) as unknown as typeof retentionPass;
    return { pass, calls };
  }
  const full = (
    jobs = RETENTION_BATCH,
    oauth = 0,
    holds = 0,
  ): RetentionResult => ({
    deleted: { oauth_login_attempts: oauth, jobs },
    redacted: { public_order_holds: holds },
    skipped: [],
    failed: [],
  });

  it("repeats while a pass deleted a full RETENTION_BATCH from some table and sums deletions", async () => {
    expect(RETENTION_BATCH).toBe(5000);
    const { pass, calls } = scripted([
      full(20 * RETENTION_BATCH, 3),
      full(RETENTION_BATCH, 0),
      full(1200, 0),
    ]);
    const result = await retentionPasses(sql, noAlert, {
      pass,
      now: () => inside,
    });
    expect(calls.n).toBe(3);
    expect(result).toEqual({
      deleted: {
        oauth_login_attempts: 3,
        jobs: 21 * RETENTION_BATCH + 1200,
      },
      redacted: { public_order_holds: 0 },
      skipped: [],
      failed: [],
    });
  });

  it("a full batch of redacted holds is a backlog too, and redactions are summed (LD-41)", async () => {
    const { pass, calls } = scripted([
      full(0, 0, RETENTION_BATCH),
      full(0, 0, 7),
    ]);
    const result = await retentionPasses(sql, noAlert, {
      pass,
      now: () => inside,
    });
    expect(calls.n).toBe(2);
    expect(result?.redacted).toEqual({
      public_order_holds: RETENTION_BATCH + 7,
    });
  });

  it("stops after a short pass", async () => {
    const { pass, calls } = scripted([full(RETENTION_BATCH - 1, 10)]);
    await retentionPasses(sql, noAlert, { pass, now: () => inside });
    expect(calls.n).toBe(1);
  });

  it("stops at maxPasses (default 10)", async () => {
    const { pass, calls } = scripted([full()]);
    const result = await retentionPasses(sql, noAlert, {
      pass,
      now: () => inside,
    });
    expect(calls.n).toBe(10);
    expect(result?.deleted.jobs).toBe(10 * RETENTION_BATCH);
    const three = scripted([full()]);
    await retentionPasses(sql, noAlert, {
      pass: three.pass,
      now: () => inside,
      maxPasses: 3,
    });
    expect(three.calls.n).toBe(3);
  });

  it("stops when the clock leaves RETENTION_WINDOW; an operator call outside the window runs exactly one pass", async () => {
    let clock = lastMinute;
    const { pass, calls } = scripted([full()]);
    const timed = (async (...args: Parameters<typeof retentionPass>) => {
      const r = await pass(...args);
      clock = after; // this pass ran past 07:00
      return r;
    }) as typeof retentionPass;
    await retentionPasses(sql, noAlert, { pass: timed, now: () => clock });
    expect(calls.n).toBe(1);
    const operator = scripted([full()]);
    await retentionPasses(sql, noAlert, {
      pass: operator.pass,
      now: () => Date.parse("2026-10-05T19:00:00Z"), // 13:00, service hours
    });
    expect(operator.calls.n).toBe(1);
  });

  it("stops at the first skip, failed table or null run, returning that pass's lists", async () => {
    const skipped = scripted([
      full(),
      {
        deleted: { oauth_login_attempts: 0, jobs: 0 },
        redacted: { public_order_holds: 0 },
        skipped: ["jobs"],
        failed: [],
      },
      full(),
    ]);
    expect(
      await retentionPasses(sql, noAlert, {
        pass: skipped.pass,
        now: () => inside,
      }),
    ).toEqual({
      deleted: { oauth_login_attempts: 0, jobs: RETENTION_BATCH },
      redacted: { public_order_holds: 0 },
      skipped: ["jobs"],
      failed: [],
    });
    expect(skipped.calls.n).toBe(2);
    const failed = scripted([
      {
        deleted: { oauth_login_attempts: 0, jobs: RETENTION_BATCH },
        redacted: { public_order_holds: 0 },
        skipped: [],
        failed: ["oauth_login_attempts"],
      },
      full(),
    ]);
    expect(
      (
        await retentionPasses(sql, noAlert, {
          pass: failed.pass,
          now: () => inside,
        })
      )?.failed,
    ).toEqual(["oauth_login_attempts"]);
    expect(failed.calls.n).toBe(1);
    const broken = scripted([full(), null, full()]);
    expect(
      await retentionPasses(sql, noAlert, {
        pass: broken.pass,
        now: () => inside,
      }),
    ).toBeNull();
    expect(broken.calls.n).toBe(2);
  });

  it("uses retentionPass by default and passes the pool and alert through", async () => {
    const alerts: Alert[] = [];
    const result = await retentionPasses(
      failing("XX000"),
      async (a) => {
        alerts.push(a);
      },
      { now: () => inside },
    );
    expect(result?.failed).toEqual([
      "oauth_login_attempts",
      "jobs",
      "public_order_holds",
    ]);
    expect(alerts.map((a) => a.key)).toEqual(["retention_failed"]);
    expect(
      await retentionPasses(empty, noAlert, { now: () => inside }),
    ).toEqual({
      deleted: { oauth_login_attempts: 0, jobs: 0 },
      redacted: { public_order_holds: 0 },
      skipped: [],
      failed: [],
    });
  });
});
