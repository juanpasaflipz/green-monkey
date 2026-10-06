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
  MAX_LEASE_SECONDS,
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
const noopHandler = async () => {};
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

/**
 * A postgres.Sql stand-in that serves a per-tenant queue: the claim statement returns up
 * to n queued jobs of the claimed kind (after `claimDelayMs`, so concurrent drains really
 * interleave), the lease-expiry statement returns the tenant's `lost` jobs once, and the
 * fenced writes succeed. `claims` records [tenant, kind, n, maxAttempts] per claim.
 */
function queueSql(o: {
  queues: Map<string, { kind: string; id: string }[]>;
  lost?: Map<string, { kind: string; id: string; attempts: number }[]>;
  claimDelayMs?: number;
  claims?: [string, string, number, number][];
  statements?: string[];
}) {
  return {
    begin: async (fn: (t: unknown) => Promise<unknown>) => {
      let tenantId = "";
      const tx = async (
        strings: TemplateStringsArray,
        ...params: unknown[]
      ) => {
        const text = strings.join("?");
        o.statements?.push(text);
        if (text.includes("set_config('app.tenant_id'")) {
          tenantId = String(params[0]);
          return [];
        }
        if (text.includes("error_code='lease_expired'")) {
          const [kind] = params as [string];
          const all = o.lost?.get(tenantId) ?? [];
          const mine = all.filter((j) => j.kind === kind);
          o.lost?.set(
            tenantId,
            all.filter((j) => j.kind !== kind),
          );
          return mine.map((j) => ({
            tenant_id: tenantId,
            id: j.id,
            kind: j.kind,
            dedupe_key: j.id,
            payload: {},
            attempts: j.attempts,
            lease: null,
            created_at: new Date(0),
          }));
        }
        if (text.includes("with c as (")) {
          const [kinds, maxAttempts, n] = params as [string[], number, number];
          o.claims?.push([tenantId, kinds[0], n, maxAttempts]);
          if (o.claimDelayMs)
            await new Promise((r) => setTimeout(r, o.claimDelayMs));
          const queue = o.queues.get(tenantId) ?? [];
          const taken = queue.filter((j) => kinds.includes(j.kind)).slice(0, n);
          o.queues.set(
            tenantId,
            queue.filter((j) => !taken.includes(j)),
          );
          return taken.map((j) => ({
            tenant_id: tenantId,
            id: j.id,
            kind: j.kind,
            dedupe_key: j.id,
            payload: {},
            attempts: 1,
            lease: "2026-10-05 12:00:00.123456+00",
            created_at: new Date(0),
          }));
        }
        if (text.includes("returning lease_until::text as lease"))
          return [{ lease: "2026-10-05 12:10:00.123456+00" }];
        return Object.assign([], { count: 1 });
      };
      return fn(tx);
    },
  } as unknown as postgres.Sql;
}

describe("runner limits and liveness (PLATFORM-OPS-1, OPS-3, OPS-5, OPS-6)", () => {
  it("50 tenants drained at once never run more than the global or per-kind concurrency, and every job runs", async () => {
    const kinds = ["opsa_probe", "opsb_probe"];
    const queues = new Map<string, { kind: string; id: string }[]>();
    const tenants = Array.from({ length: 50 }, (_, i) => `t-${i}`);
    for (const t of tenants)
      queues.set(
        t,
        kinds.flatMap((kind) =>
          [1, 2].map((n) => ({ kind, id: `${t}-${kind}-${n}` })),
        ),
      );
    let running = 0;
    let maxRunning = 0;
    const perKind = new Map<string, number>();
    const maxPerKind = new Map<string, number>();
    const ran = new Set<string>();
    const handler =
      (kind: string) =>
      async ({ job }: { job: { id: string } }) => {
        running++;
        perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
        maxRunning = Math.max(maxRunning, running);
        maxPerKind.set(
          kind,
          Math.max(maxPerKind.get(kind) ?? 0, perKind.get(kind)!),
        );
        await new Promise((r) => setTimeout(r, 3));
        ran.add(job.id);
        running--;
        perKind.set(kind, perKind.get(kind)! - 1);
      };
    const registry = new Map<string, RegisteredHandler>(
      kinds.map((kind) => [
        kind,
        jobRegistration(kind, handler(kind) as never, { concurrency: 2 }),
      ]),
    );
    const runner = createJobRunner(queueSql({ queues, claimDelayMs: 2 }), {
      handlers: () => registry,
      concurrency: 4,
      sweepMs: 1000,
      debounceMs: 1,
    });
    // Every tenant drains at once (discovery notes them together); later
    // rounds stand in for the next sweeps, which pick up what a bounded drain
    // left.
    let claimed = 0;
    for (
      let round = 0;
      round < 200 && [...queues.values()].some((q) => q.length);
      round++
    )
      claimed += (
        await Promise.all(tenants.map((t) => runner.drainTenant(t)))
      ).reduce((a, b) => a + b, 0);
    // Let the last handlers settle.
    for (let i = 0; i < 50 && runner.running() > 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(maxRunning, "global limit").toBeLessThanOrEqual(4);
    expect(maxRunning, "the limit is used").toBe(4);
    for (const kind of kinds)
      expect(maxPerKind.get(kind), kind).toBeLessThanOrEqual(2);
    expect({
      claimed,
      ran: ran.size,
      left: [...queues.values()].flat().length,
    }).toEqual({ claimed: 200, ran: 200, left: 0 });
    await runner.stop(100);
  }, 30_000);

  it("a handler that ignores its abort signal stops counting at lease expiry; the tenant's drain finishes and its next job runs", async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const queues = new Map([
        [
          "t-1",
          [
            { kind: "opsworker_probe", id: "hung" },
            { kind: "opsworker_probe", id: "next" },
          ],
        ],
      ]);
      const ran: string[] = [];
      const registry = new Map<string, RegisteredHandler>([
        [
          "opsworker_probe",
          jobRegistration(
            "opsworker_probe",
            (async ({ job }: { job: { id: string } }) => {
              ran.push(job.id);
              // A provider call without the signal that never answers.
              if (job.id === "hung") await new Promise(() => {});
            }) as never,
            { concurrency: 1, leaseSeconds: 10 },
          ),
        ],
      ]);
      const runner = createJobRunner(queueSql({ queues }), {
        handlers: () => registry,
        concurrency: 4,
        sweepMs: 1000,
        log: recordingLogger(lines),
      });
      let settled = false;
      const drain = runner.drainTenant("t-1").then((n) => {
        settled = true;
        return n;
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(ran).toEqual(["hung"]);
      expect(runner.running()).toBe(1);
      expect(settled, "the drain waits for the slot, in bounded steps").toBe(
        false,
      );
      // The lease timer fires 2 s before the 10 s lease expires.
      await vi.advanceTimersByTimeAsync(4000);
      expect(lines).toContain("job_lease_expired");
      expect(ran).toEqual(["hung", "next"]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(settled).toBe(true);
      expect(await drain).toBe(2);
      expect(runner.running(), "the hung handler holds no slot").toBe(0);
      await runner.stop(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a handler aborted at lease expiry cannot renew its lease by heartbeating: ctx.extendLease throws job_lease_lost without SQL, so the kind's next job never runs beside it (PLAT-HR-4)", async () => {
    vi.useFakeTimers();
    try {
      const statements: string[] = [];
      const queues = new Map([
        [
          "t-1",
          [
            { kind: "opsworker_probe", id: "late" },
            { kind: "opsworker_probe", id: "next" },
          ],
        ],
      ]);
      const heartbeats: string[] = [];
      let release!: () => void;
      const stuck = new Promise<void>((r) => (release = r));
      const registry = new Map<string, RegisteredHandler>([
        [
          "opsworker_probe",
          jobRegistration(
            "opsworker_probe",
            (async (ctx: {
              job: { id: string };
              signal: AbortSignal;
              extendLease: (s: number) => Promise<void>;
            }) => {
              if (ctx.job.id !== "late") return;
              // Ignores its signal, then heartbeats after the abort.
              await stuck;
              heartbeats.push(
                `${ctx.signal.aborted}:` +
                  (await ctx.extendLease(60).then(
                    () => "extended",
                    (e: { code?: string }) => String(e.code),
                  )),
              );
            }) as never,
            { concurrency: 1, leaseSeconds: 10 },
          ),
        ],
      ]);
      const runner = createJobRunner(queueSql({ queues, statements }), {
        handlers: () => registry,
        concurrency: 4,
        sweepMs: 1000,
        log: recordingLogger([]),
      });
      void runner.drainTenant("t-1");
      // The lease timer fires at 8 s (2 s before the 10 s lease).
      await vi.advanceTimersByTimeAsync(8500);
      release();
      await vi.advanceTimersByTimeAsync(10);
      expect(heartbeats).toEqual(["true:job_lease_lost"]);
      expect(
        statements.filter((t) => t.includes("update jobs set lease_until")),
        "the late heartbeat reached no SQL",
      ).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(3000);
      await runner.stop(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a drain waiting on a full kind ends within sweepMs steps even when nothing settles", async () => {
    vi.useFakeTimers();
    try {
      const queues = new Map([
        [
          "t-1",
          [
            { kind: "opsworker_probe", id: "a" },
            { kind: "opsworker_probe", id: "b" },
          ],
        ],
      ]);
      const registry = new Map<string, RegisteredHandler>([
        [
          "opsworker_probe",
          jobRegistration(
            "opsworker_probe",
            (async () => new Promise(() => {})) as never,
            { concurrency: 1, leaseSeconds: 3600 },
          ),
        ],
      ]);
      const runner = createJobRunner(queueSql({ queues }), {
        handlers: () => registry,
        sweepMs: 1000,
      });
      let settled = false;
      void runner.drainTenant("t-1").then(() => (settled = true));
      // 100 bounded waits of sweepMs at most: the drain never hangs on the
      // running job's promise.
      await vi.advanceTimersByTimeAsync(101_000);
      expect(settled).toBe(true);
      const stopped = runner.stop(10);
      await vi.advanceTimersByTimeAsync(2000);
      await stopped;
    } finally {
      vi.useRealTimers();
    }
  });

  it("claims pass the kind's maxAttempts, and jobs whose lease expired on their last claim go dead with lease_expired and alert", async () => {
    const claims: [string, string, number, number][] = [];
    const dead: [string, string][] = [];
    const lines: string[] = [];
    const registry = new Map<string, RegisteredHandler>([
      [
        "opsworker_probe",
        jobRegistration("opsworker_probe", noopHandler, { maxAttempts: 3 }),
      ],
    ]);
    const runner = createJobRunner(
      queueSql({
        queues: new Map(),
        lost: new Map([
          ["t-1", [{ kind: "opsworker_probe", id: "crashed", attempts: 3 }]],
        ]),
        claims,
      }),
      {
        handlers: () => registry,
        log: recordingLogger(lines),
        onDead: (job, code) => void dead.push([job.id, code]),
      },
    );
    expect(await runner.drainTenant("t-1")).toBe(0);
    expect(claims).toEqual([["t-1", "opsworker_probe", 2, 3]]);
    expect(dead).toEqual([["crashed", "lease_expired"]]);
    expect(lines).toContain("job_dead");
    // Once dead it is not reported again.
    await runner.drainTenant("t-1");
    expect(dead).toHaveLength(1);
    await runner.stop(10);
  });

  it("the lease-expiry statement runs at most once per sweepMs per tenant and kind, not on every drain (PLAT-HR-7)", async () => {
    vi.useFakeTimers();
    try {
      const statements: string[] = [];
      const registry = new Map<string, RegisteredHandler>([
        ["opsworker_probe", jobRegistration("opsworker_probe", noopHandler)],
      ]);
      const runner = createJobRunner(
        queueSql({ queues: new Map(), statements }),
        { handlers: () => registry, sweepMs: 1000 },
      );
      const expiries = () =>
        statements.filter((t) => t.includes("error_code='lease_expired'"))
          .length;
      const claims = () =>
        statements.filter((t) => t.includes("with c as (")).length;
      await runner.drainTenant("t-1");
      await runner.drainTenant("t-1");
      await runner.drainTenant("t-2");
      expect({ claims: claims(), expiries: expiries() }).toEqual({
        claims: 3,
        expiries: 2,
      });
      await vi.advanceTimersByTimeAsync(1000);
      await runner.drainTenant("t-1");
      expect(expiries(), "due again after sweepMs").toBe(3);
      await runner.stop(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leases are whole seconds from 10 to 3600, at registration and in ctx.extendLease (before any SQL)", async () => {
    expect(MAX_LEASE_SECONDS).toBe(3600);
    expect(
      jobRegistration("ok_kind", noopHandler, { leaseSeconds: 3600 })
        .leaseSeconds,
    ).toBe(3600);
    for (const leaseSeconds of [3601, 86_400, 30 * 86_400])
      expect(() =>
        jobRegistration("ok_kind", noopHandler, { leaseSeconds }),
      ).toThrow(/lease/);
    const statements: string[] = [];
    const outcomes: unknown[] = [];
    const registry = new Map<string, RegisteredHandler>([
      [
        "opsworker_probe",
        jobRegistration("opsworker_probe", (async (ctx: {
          extendLease: (s: number) => Promise<void>;
        }) => {
          for (const seconds of [86_400, 9, 10.5, Number.NaN])
            outcomes.push(
              await ctx.extendLease(seconds).then(
                () => "extended",
                (e: Error) => e.message,
              ),
            );
          outcomes.push(await ctx.extendLease(600).then(() => "extended"));
        }) as never),
      ],
    ]);
    const runner = createJobRunner(
      queueSql({
        queues: new Map([["t-1", [{ kind: "opsworker_probe", id: "j" }]]]),
        statements,
      }),
      { handlers: () => registry },
    );
    await runner.drainTenant("t-1");
    for (let i = 0; i < 20 && runner.running() > 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(outcomes.slice(0, 4)).toEqual(
      Array(4).fill("job lease must be an integer from 10 to 3600 seconds"),
    );
    expect(outcomes[4]).toBe("extended");
    // Only the valid extension reached the database.
    expect(
      statements.filter((t) => t.includes("update jobs set lease_until")),
    ).toHaveLength(1);
    await runner.stop(10);
  });
});

describe("job controls (PLATFORM-OPS-3)", () => {
  it("POST /api/jobs/:id/requeue and /cancel need a recent PIN and a manager before any SQL", async () => {
    const { register } = await import("../server/routes/ops.js");
    const routes = new Map<
      string,
      (tx: Tx, s: never, req: never) => Promise<unknown>
    >();
    register({
      app: null as never,
      sql: null as never,
      route: (method, path, fn) =>
        void routes.set(`${method} ${path}`, fn as never),
    });
    expect([...routes.keys()]).toEqual([
      "post /jobs/:id/requeue",
      "post /jobs/:id/cancel",
    ]);
    const tx = (() => {
      throw new Error("no SQL may run");
    }) as unknown as Tx;
    const access = (authenticatedAt: string) => ({
      absoluteExpiresAt: null,
      authenticatedAt,
      deviceName: "Caja",
      deviceKind: "shared",
      idleLockSeconds: 180,
      ownerAccount: false,
    });
    const req = { params: { id: "40000000-0000-4000-8000-000000000001" } };
    for (const fn of routes.values()) {
      await expect(
        fn(
          tx,
          {
            role: "manager",
            access: access("2000-01-01T00:00:00Z"),
          } as never,
          req as never,
        ),
      ).rejects.toMatchObject({ code: "step_up_required", status: 403 });
      await expect(
        fn(
          tx,
          {
            role: "cashier",
            access: access(new Date().toISOString()),
          } as never,
          req as never,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        fn(
          tx,
          {
            role: "manager",
            access: access(new Date().toISOString()),
          } as never,
          { params: { id: "not-a-uuid" } } as never,
        ),
      ).rejects.toThrow();
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
