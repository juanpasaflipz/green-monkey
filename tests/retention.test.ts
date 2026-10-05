import { describe, expect, it } from "vitest";
import type postgres from "postgres";
import type { Alert } from "../server/ops/alerts.js";
import {
  createRetentionSchedule,
  inRetentionWindow,
  RETENTION_LOCK_TIMEOUT_MS,
  RETENTION_STATEMENT_TIMEOUT_MS,
  RETENTION_WINDOW,
  retentionPass,
  runRetention,
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
    expect(result?.failed).toEqual(["oauth_login_attempts", "jobs"]);
    expect(alerts).toEqual([
      {
        key: "retention_failed",
        severity: "warning",
        title: "retention failed",
        body: "retention_failed tables=oauth_login_attempts,jobs",
      },
    ]);
  });

  it("treats lock timeouts as routine skips without an alert", async () => {
    const alerts: Alert[] = [];
    const result = await retentionPass(failing("55P03"), async (a) => {
      alerts.push(a);
    });
    expect(result?.skipped).toEqual(["oauth_login_attempts", "jobs"]);
    expect(alerts).toEqual([]);
  });

  it("a clean run reports zero deletions and no alert", async () => {
    const alerts: Alert[] = [];
    const result = await retentionPass(empty, async (a) => {
      alerts.push(a);
    });
    expect(result).toEqual({
      deleted: { oauth_login_attempts: 0, jobs: 0 },
      skipped: [],
      failed: [],
    });
    expect(alerts).toEqual([]);
  });

  it("the schedule runs first after firstRunMs, then on its interval, never overlapping", async () => {
    let runs = 0;
    let release!: () => void;
    const schedule = createRetentionSchedule({
      url: "postgresql://nobody:x@127.0.0.1:1/none",
      alert: async () => {},
      firstRunMs: 5,
      intervalMs: 10,
      // 05:00 in Mexico City: inside the off-hours window (OPS-R10).
      now: () => Date.parse("2026-10-05T11:00:00Z"),
      run: async () => {
        runs++;
        await new Promise<void>((r) => (release = r));
        return null;
      },
    });
    schedule.start();
    await new Promise((r) => setTimeout(r, 60));
    expect(runs).toBe(1); // the first run is still active; ticks were skipped
    expect(schedule.lastRunAt()).toBeNull();
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(schedule.lastRunAt()).not.toBeNull();
    release();
    await schedule.stop();
  });

  it("a statement timeout fails the table and alerts; it is not a routine skip (OPS-R10)", async () => {
    const alerts: Alert[] = [];
    const result = await retentionPass(failing("57014"), async (a) => {
      alerts.push(a);
    });
    expect(result?.failed).toEqual(["oauth_login_attempts", "jobs"]);
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
    for (const table of ["oauth_login_attempts", "jobs"]) {
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

  it("a tick outside the window never touches the database; inside it runs one pass", async () => {
    let clock = Date.parse("2026-10-05T19:00:00Z"); // 13:00, service hours
    let runs = 0;
    const schedule = createRetentionSchedule({
      url: "postgresql://nobody:x@127.0.0.1:1/none",
      alert: async () => {},
      now: () => clock,
      run: async () => {
        runs++;
        return { deleted: {}, skipped: [], failed: [] };
      },
    });
    expect(await schedule.tick()).toBeNull();
    expect(runs).toBe(0);
    expect(schedule.lastRunAt()).toBeNull();
    clock = Date.parse("2026-10-05T11:15:00Z"); // 05:15
    expect(await schedule.tick()).toEqual({
      deleted: {},
      skipped: [],
      failed: [],
    });
    expect(runs).toBe(1);
    // runNow (tests, operators) is not gated by the window.
    clock = Date.parse("2026-10-05T19:00:00Z");
    await schedule.runNow();
    expect(runs).toBe(2);
    await schedule.stop();
  });
});
