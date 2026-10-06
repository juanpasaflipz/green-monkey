import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// The web entry's registration side effect (server/index.ts); the runner no
// longer imports it (Wave 2.0, P-1).
import "../server/jobs/handlers/index.js";
import { backoffMs, failureState, jobErrorCode } from "../server/jobs/queue.js";
import { createJobRunner, resolveOutcome } from "../server/jobs/runner.js";
import {
  clearJobHandlers,
  enqueueJob,
  handlers,
  jobRegistration,
  JOB_KIND,
  MAX_ATTEMPTS,
  MAX_ATTEMPTS_LIMIT,
  registerJobHandler,
  type RegisteredHandler,
} from "../server/jobs.js";
import {
  clearWorkerJobHandlers,
  registerWorkerJobHandler,
  workerHandlers,
} from "../server/jobs/worker-registry.js";
import type { Tx } from "../server/db.js";
import { alertRequest, createAlerter } from "../server/ops/alerts.js";
import { setLogSink, type Logger } from "../server/logging.js";

beforeAll(() => setLogSink(() => {}));
afterAll(() => setLogSink(null));

describe("jobs framework", () => {
  it("backoff doubles from 30 s, caps at 1 h, jitters ±20%", () => {
    const mid = () => 0.5;
    expect(backoffMs(1, mid)).toBe(30_000);
    expect(backoffMs(2, mid)).toBe(60_000);
    expect(backoffMs(3, mid)).toBe(120_000);
    expect(backoffMs(20, mid)).toBe(3_600_000);
    expect(backoffMs(1, () => 0)).toBe(24_000);
    expect(backoffMs(1, () => 1)).toBe(36_000);
    expect(backoffMs(30, () => 1)).toBe(4_320_000);
  });

  it("outcome mapping: throw→retry, attempts≥max→dead, blocked, done", () => {
    expect(resolveOutcome({ ok: true, outcome: undefined })).toEqual({
      action: "complete",
    });
    expect(resolveOutcome({ ok: true, outcome: { status: "done" } })).toEqual({
      action: "complete",
    });
    expect(
      resolveOutcome({
        ok: false,
        error: Object.assign(new Error("x"), { code: "provider_timeout" }),
      }),
    ).toEqual({ action: "fail", code: "provider_timeout" });
    expect(resolveOutcome({ ok: false, error: new TypeError("boom") })).toEqual(
      {
        action: "fail",
        code: "handler_error",
      },
    );
    expect(
      resolveOutcome({
        ok: true,
        outcome: { status: "retry", code: "rate_limited", afterMs: 5000 },
      }),
    ).toEqual({ action: "fail", code: "rate_limited", retryAfterMs: 5000 });
    expect(
      resolveOutcome({
        ok: true,
        outcome: { status: "blocked", code: "printer_not_paired" },
      }),
    ).toMatchObject({ blocked: true });
    expect(
      resolveOutcome({
        ok: true,
        outcome: { status: "dead", code: "invalid_payload" },
      }),
    ).toMatchObject({ dead: true });
    expect(MAX_ATTEMPTS).toBe(8);
    expect(failureState(1, {})).toBe("retry");
    expect(failureState(MAX_ATTEMPTS, {})).toBe("dead");
    expect(failureState(1, { dead: true })).toBe("dead");
    expect(failureState(MAX_ATTEMPTS, { blocked: true })).toBe("blocked");
  });

  it("stores only machine-readable error codes", () => {
    expect(jobErrorCode("printer_offline")).toBe("printer_offline");
    expect(jobErrorCode("Customer email is invalid")).toBe("handler_error");
    expect(jobErrorCode(undefined)).toBe("handler_error");
  });

  it("registers each kind once with sane defaults", () => {
    const kitchen = handlers().get("kitchen_dispatch");
    clearJobHandlers();
    const noop = async () => {};
    registerJobHandler("sample_kind", noop);
    expect(handlers().get("sample_kind")).toMatchObject({
      concurrency: 2,
      leaseSeconds: 120,
    });
    expect(() => registerJobHandler("sample_kind", noop)).toThrow();
    expect(() => registerJobHandler("Bad Kind", noop)).toThrow();
    clearJobHandlers();
    expect(kitchen).toBeDefined();
    if (kitchen) registerJobHandler("kitchen_dispatch", kitchen.handler);
  });
});

/** A logger that records message names (and nothing else). */
function recordingLogger(lines: string[]): Logger {
  const logger: Logger = {
    debug: (m) => void lines.push(m),
    info: (m) => void lines.push(m),
    warn: (m) => void lines.push(m),
    error: (m) => void lines.push(m),
    child: () => logger,
  };
  return logger;
}

/**
 * A postgres.Sql stand-in for runner tests: begin() runs the callback on a
 * tagged-template tx that answers every statement with no rows and records the
 * tenant each transaction scoped itself to (tenant()'s set_config).
 */
function fakeSql(tenants: string[]) {
  const tx = (strings: TemplateStringsArray, ...params: unknown[]) => {
    if (strings.join("?").includes("set_config('app.tenant_id'"))
      tenants.push(String(params[0]));
    return Promise.resolve([]);
  };
  return {
    begin: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as postgres.Sql;
}

describe("jobs API (Wave 2.0)", () => {
  const noop = async () => {};

  it("jobRegistration validates kind, concurrency, lease and maxAttempts 1..100; maxAttempts defaults to 8", () => {
    expect(jobRegistration("cfdi_stamp", noop)).toEqual({
      handler: noop,
      concurrency: 2,
      leaseSeconds: 120,
      maxAttempts: 8,
    });
    expect(MAX_ATTEMPTS_LIMIT).toBe(100);
    expect(
      jobRegistration("cfdi_stamp", noop, { maxAttempts: 1 }).maxAttempts,
    ).toBe(1);
    expect(
      jobRegistration("cfdi_stamp", noop, { maxAttempts: 100 }).maxAttempts,
    ).toBe(100);
    for (const kind of [
      "",
      "a",
      "Cfdi_x",
      "cfdi.stamp",
      "9cfdi",
      "x".repeat(65),
    ])
      expect(() => jobRegistration(kind, noop), kind).toThrow(
        /invalid job kind/,
      );
    expect(JOB_KIND.test("x".repeat(64))).toBe(true);
    for (const concurrency of [0, -1, 1.5])
      expect(() => jobRegistration("ok_kind", noop, { concurrency })).toThrow(
        /concurrency/,
      );
    for (const leaseSeconds of [9, 10.5])
      expect(() => jobRegistration("ok_kind", noop, { leaseSeconds })).toThrow(
        /lease/,
      );
    for (const maxAttempts of [0, 101, 2.5, Number.NaN])
      expect(() => jobRegistration("ok_kind", noop, { maxAttempts })).toThrow(
        /maxAttempts/,
      );
  });

  it("failureState is dead exactly at the kind's maxAttempts; blocked and explicit dead take precedence", () => {
    expect(failureState(2, {}, 3)).toBe("retry");
    expect(failureState(3, {}, 3)).toBe("dead");
    expect(failureState(4, {}, 3)).toBe("dead");
    expect(failureState(MAX_ATTEMPTS - 1, {})).toBe("retry");
    expect(failureState(MAX_ATTEMPTS, {})).toBe("dead");
    expect(failureState(20, {}, 100)).toBe("retry");
    expect(failureState(1, { dead: true }, 100)).toBe("dead");
    expect(failureState(3, { blocked: true }, 3)).toBe("blocked");
    expect(failureState(1, { blocked: true, dead: true }, 3)).toBe("blocked");
  });

  it("enqueueJob refuses an invalid kind, an empty or 201-character dedupe key and an invalid runAt before any SQL", async () => {
    const tx = (() => {
      throw new Error("no SQL may run");
    }) as unknown as Tx;
    const s = { tenantId: "10000000-0000-4000-8000-000000000001" };
    const job = { kind: "ops_probe", dedupeKey: "k", payload: {} };
    await expect(
      enqueueJob(tx, s, { ...job, kind: "Bad.Kind" }),
    ).rejects.toThrow(/invalid job kind/);
    await expect(enqueueJob(tx, s, { ...job, dedupeKey: "" })).rejects.toThrow(
      /dedupeKey/,
    );
    await expect(
      enqueueJob(tx, s, { ...job, dedupeKey: "k".repeat(201) }),
    ).rejects.toThrow(/dedupeKey/);
    for (const runAt of [
      new Date("not a date"),
      "2026-10-05T10:00:00Z" as unknown as Date,
      Date.now() as unknown as Date,
    ])
      await expect(enqueueJob(tx, s, { ...job, runAt })).rejects.toThrow(
        /runAt/,
      );
  });

  it("registerWorkerJobHandler refuses a duplicate worker kind and a kind already in the web registry", () => {
    try {
      registerWorkerJobHandler("opsworker_probe", noop, { maxAttempts: 3 });
      expect(workerHandlers().get("opsworker_probe")).toMatchObject({
        maxAttempts: 3,
        concurrency: 2,
      });
      expect(() => registerWorkerJobHandler("opsworker_probe", noop)).toThrow(
        "worker job handler already registered: opsworker_probe",
      );
      expect(() => registerWorkerJobHandler("kitchen_dispatch", noop)).toThrow(
        "job kind registered in both web and worker: kitchen_dispatch",
      );
      expect(() =>
        registerWorkerJobHandler("opsworker_bad", noop, { maxAttempts: 0 }),
      ).toThrow(/maxAttempts/);
      expect(workerHandlers().has("kitchen_dispatch")).toBe(false);
    } finally {
      clearWorkerJobHandlers();
    }
  });

  it("web and worker kinds are disjoint", () => {
    // Every web kind is registered by server/jobs/handlers/index.ts (imported
    // above); worker kinds are registered by the modules between
    // server/worker.ts's "worker areas: imports" markers (none in Wave 2.0).
    const web = [...handlers().keys()];
    const worker = [...workerHandlers().keys()];
    expect(web).toContain("kitchen_dispatch");
    expect(web.filter((kind) => worker.includes(kind))).toEqual([]);
  });

  it("discover mode polls at start and every sweepMs, drains each returned tenant, and on a rejected discover logs jobs_discover_failed and keeps polling", async () => {
    vi.useFakeTimers();
    try {
      const drained: string[] = [];
      const lines: string[] = [];
      const answers: Array<() => Promise<string[]>> = [
        async () => ["t-1", "t-2"],
        async () => {
          throw new Error("database unreachable");
        },
        async () => ["t-3"],
      ];
      let polls = 0;
      const only = new Map<string, RegisteredHandler>([
        ["opsworker_probe", jobRegistration("opsworker_probe", noop)],
      ]);
      const runner = createJobRunner(fakeSql(drained), {
        handlers: () => only,
        sweepMs: 1000,
        debounceMs: 10,
        log: recordingLogger(lines),
        discover: () => (answers[polls++] ?? (async () => []))(),
      });
      runner.start();
      expect(polls).toBe(1);
      await vi.advanceTimersByTimeAsync(50);
      expect(drained.sort()).toEqual(["t-1", "t-2"]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(polls).toBe(2);
      expect(lines).toContain("jobs_discover_failed");
      await vi.advanceTimersByTimeAsync(1000);
      expect(polls).toBe(3);
      await vi.advanceTimersByTimeAsync(50);
      expect(drained).toContain("t-3");
      await runner.stop(100);
      const after = polls;
      await vi.advanceTimersByTimeAsync(5000);
      expect(polls).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discover mode keeps polling with zero handlers and never overlaps a slow poll", async () => {
    vi.useFakeTimers();
    try {
      const drained: string[] = [];
      let polls = 0;
      let release: (ids: string[]) => void = () => {};
      const runner = createJobRunner(fakeSql(drained), {
        handlers: () => new Map(),
        sweepMs: 1000,
        discover: () => {
          polls++;
          return new Promise<string[]>((r) => (release = r));
        },
      });
      runner.start();
      await vi.advanceTimersByTimeAsync(3500);
      expect(polls).toBe(1);
      release(["t-1"]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(polls).toBe(2);
      release([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(polls).toBe(3);
      expect(drained).toEqual([]);
      await runner.stop(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("without discover the active-tenant sweep is unchanged", async () => {
    vi.useFakeTimers();
    try {
      const drained: string[] = [];
      const only = new Map<string, RegisteredHandler>([
        ["opsworker_probe", jobRegistration("opsworker_probe", noop)],
      ]);
      const runner = createJobRunner(fakeSql(drained), {
        handlers: () => only,
        sweepMs: 1000,
        debounceMs: 10,
        activeForMs: 2500,
      });
      runner.start();
      await vi.advanceTimersByTimeAsync(1500);
      expect(drained, "no tenant is known before activity").toEqual([]);
      runner.noteTenant("t-1");
      await vi.advanceTimersByTimeAsync(20);
      expect(drained).toEqual(["t-1"]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(drained, "the sweep revisits it").toEqual(["t-1", "t-1"]);
      await vi.advanceTimersByTimeAsync(3000);
      const count = drained.length;
      await vi.advanceTimersByTimeAsync(3000);
      expect(drained.length, "forgotten after activeForMs").toBe(count);
      await runner.stop(100);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("alerts", () => {
  const alert = {
    key: "jobs_dead",
    severity: "warning" as const,
    title: "dead jobs",
    body: "jobs_dead receipt=2",
  };

  it("formats ntfy, slack, discord and generic webhooks", () => {
    const at = new Date("2026-10-05T10:00:00Z");
    const ntfy = alertRequest(
      { url: "https://ntfy.sh/t", kind: "ntfy" },
      "production",
      alert,
      at,
    );
    expect(ntfy.init.headers).toMatchObject({
      Title: "Green Monkey production: dead jobs",
      Priority: "high",
      Tags: "warning",
    });
    expect(ntfy.init.body).toBe("jobs_dead receipt=2");
    expect(
      JSON.parse(
        alertRequest({ url: "https://x", kind: "slack" }, "staging", alert, at)
          .init.body as string,
      ),
    ).toEqual({
      text: "*Green Monkey staging: dead jobs*\njobs_dead receipt=2",
    });
    expect(
      JSON.parse(
        alertRequest(
          { url: "https://x", kind: "discord" },
          "staging",
          alert,
          at,
        ).init.body as string,
      ).content,
    ).toContain("dead jobs");
    expect(
      JSON.parse(
        alertRequest(
          { url: "https://x", kind: "generic" },
          "staging",
          alert,
          at,
        ).init.body as string,
      ),
    ).toEqual({
      env: "staging",
      key: "jobs_dead",
      severity: "warning",
      title: "dead jobs",
      body: "jobs_dead receipt=2",
      at: "2026-10-05T10:00:00.000Z",
    });
  });

  it("dedupes the same key for 30 minutes and never throws on delivery failure", async () => {
    let now = 0;
    const fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    const alerter = createAlerter(
      { url: "https://ntfy.sh/t", kind: "ntfy" },
      {
        appEnv: "staging",
        fetch: fetch as unknown as typeof globalThis.fetch,
        now: () => now,
      },
    );
    await alerter.send(alert);
    await alerter.send(alert);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 31 * 60_000;
    await alerter.send(alert);
    expect(fetch).toHaveBeenCalledTimes(2);
    await alerter.send({ ...alert, key: "web_down", severity: "critical" });
    now += 16 * 60_000;
    await alerter.send({ ...alert, key: "web_down", severity: "critical" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
