import { describe, expect, it } from "vitest";
import type postgres from "postgres";
import type { Alert } from "../server/ops/alerts.js";
import {
  createRetentionSchedule,
  retentionPass,
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
});
