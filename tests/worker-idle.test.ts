// Idle pacing of the worker's database loops (WORKER_IDLE_MS): an idle worker stops querying
// so Neon can suspend the compute, and wakes or due work bring it back.
import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { nextDelay, staleAfterMs } from "../server/ops/idle.js";
import { createJobRunner } from "../server/jobs/runner.js";
import { createWatchdog } from "../server/ops/watchdog.js";
import { loadConfig } from "../server/config-rules.js";

describe("idle pacing helpers", () => {
  it("clamps the next delay between the busy and idle intervals", () => {
    expect(nextDelay(null, 5000, 1_800_000)).toBe(1_800_000);
    expect(nextDelay(-250, 5000, 1_800_000)).toBe(5000);
    expect(nextDelay(90_000.2, 5000, 1_800_000)).toBe(90_001);
    expect(nextDelay(9e9, 5000, 1_800_000)).toBe(1_800_000);
    expect(nextDelay(Number.NaN, 5000, 1_800_000)).toBe(1_800_000);
  });

  it("calls a loop stale only after a full idle period plus slack", () => {
    expect(staleAfterMs(1_800_000)).toBe(1_920_000);
    expect(staleAfterMs(0)).toBe(120_000);
  });

  it("WORKER_IDLE_MS defaults to 30 min on the worker, is bounded, and is 0 on the web", () => {
    expect(loadConfig({}, "worker").workerIdleMs).toBe(1_800_000);
    expect(
      loadConfig({ WORKER_IDLE_MS: "600000" }, "worker").workerIdleMs,
    ).toBe(600_000);
    for (const bad of ["59999", "21600001", "abc", "-5"])
      expect(() => loadConfig({ WORKER_IDLE_MS: bad }, "worker")).toThrow(
        "invalid_worker_idle_ms",
      );
    expect(
      loadConfig(
        {
          DATABASE_URL:
            "postgresql://gm_app:pw@127.0.0.1:5432/green_monkey_dev",
          JWT_SECRET: "x".repeat(40),
        },
        "web",
      ).workerIdleMs,
    ).toBe(0);
  });
});

describe("adaptive worker discovery (runner idleSweepMs)", () => {
  const sql = (() => {
    throw Error("no tenant drains in these tests");
  }) as unknown as postgres.Sql;

  it("sleeps for the idle delay after an empty pass, sweeps fast while tenants are found, and a poke runs now and is followed by one fast pass", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const found: string[][] = [];
      let idleAsks = 0;
      const runner = createJobRunner(sql, {
        handlers: () => new Map(),
        sweepMs: 5000,
        debounceMs: 10,
        discover: async () => {
          polls++;
          return found.shift() ?? [];
        },
        idleSweepMs: async () => {
          idleAsks++;
          return 600_000;
        },
      });
      runner.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(polls, "discovery at start").toBe(1);
      expect(idleAsks).toBe(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(polls, "no discovery inside the idle delay").toBe(1);
      runner.poke();
      await vi.advanceTimersByTimeAsync(20);
      expect(polls, "a poke runs discovery now").toBe(2);
      expect(idleAsks, "a poked pass does not sleep idle").toBe(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(polls, "a poked pass is followed by one fast pass").toBe(3);
      expect(idleAsks).toBe(2);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(polls, "the idle delay elapsed").toBe(4);
      await runner.stop(100);
      await vi.advanceTimersByTimeAsync(10 * 600_000);
      expect(polls, "no discovery after stop").toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps sweeping every sweepMs after a failed discovery or a failed idle lookup", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const runner = createJobRunner(sql, {
        handlers: () => new Map(),
        sweepMs: 5000,
        log: {
          warn: () => {},
          info: () => {},
          error: () => {},
          debug: () => {},
          child() {
            return this;
          },
        } as never,
        discover: async () => {
          polls++;
          if (polls === 1) throw Error("db down");
          return [];
        },
        idleSweepMs: async () => {
          throw Error("db down");
        },
      });
      runner.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(polls).toBe(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(polls, "a failed discovery retries after sweepMs").toBe(2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(polls, "a failed idle lookup falls back to sweepMs").toBe(3);
      await runner.stop(100);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("watchdog pacing", () => {
  it("probes the configured path and runs the billing query at most every billingEveryMs", async () => {
    vi.useFakeTimers();
    try {
      const urls: string[] = [];
      let billingQueries = 0;
      const billingSql = (async () => {
        billingQueries++;
        return [{ review: 0, retrying: 0 }];
      }) as unknown as postgres.Sql;
      const watchdog = createWatchdog({
        appUrl: "https://web.example.test",
        billingSql,
        alert: async () => {},
        fetch: (async (url: string) => {
          urls.push(url);
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
        probePath: "/health",
        billingEveryMs: 1_800_000,
      });
      await watchdog.check();
      await vi.advanceTimersByTimeAsync(60_000);
      await watchdog.check();
      expect(urls).toEqual([
        "https://web.example.test/health",
        "https://web.example.test/health",
      ]);
      expect(billingQueries).toBe(1);
      await vi.advanceTimersByTimeAsync(1_800_000);
      await watchdog.check();
      expect(billingQueries).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
