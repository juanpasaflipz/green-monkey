// cfdi (030) unit tests 22, 26 and 27 (spec §7.1): job kinds and limits (OPS-15 regression),
// per-document retry limits and dedupe-key lengths. Pure: no database, no network.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handlers, JOB_KIND } from "../server/jobs";
import "../server/jobs/handlers/index";
import { workerHandlers } from "../server/jobs/worker-registry";
import "../server/cfdi/worker/register";
import {
  CFDI_JOB_KINDS,
  CFDI_JOB_LIMITS,
  dedupe,
  lastAttempt,
  retryOrExhaust,
  tenMinuteBucket,
} from "../server/cfdi/jobs";
import { nextSixHours, periodsThrough } from "../server/cfdi/worker/global";

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? files(path)
      : path.endsWith(".ts")
        ? [path]
        : [];
  });

describe("22. OPS-15 regression: cfdi kinds", () => {
  it("every kind cfdi enqueues is declared, matches the jobs kind regex and has a worker handler with its limits", () => {
    const enqueued = new Set<string>();
    for (const file of files("server/cfdi"))
      for (const m of readFileSync(file, "utf8").matchAll(
        /kind: "(cfdi_[a-z_]+)",\s*dedupeKey/g,
      ))
        enqueued.add(m[1]);
    enqueued.add("cfdi_stamp"); // enqueueStamp
    expect([...enqueued].sort()).toEqual(
      [...enqueued]
        .filter((k) => (CFDI_JOB_KINDS as readonly string[]).includes(k))
        .sort(),
    );
    const worker = workerHandlers();
    for (const kind of CFDI_JOB_KINDS) {
      expect(kind).toMatch(JOB_KIND);
      const entry = worker.get(kind);
      expect(entry, kind).toBeDefined();
      expect(entry!.maxAttempts).toBe(CFDI_JOB_LIMITS[kind].maxAttempts);
      expect(entry!.concurrency).toBe(CFDI_JOB_LIMITS[kind].concurrency);
      expect(entry!.leaseSeconds).toBe(CFDI_JOB_LIMITS[kind].leaseSeconds);
    }
    expect(
      Object.fromEntries(
        CFDI_JOB_KINDS.map((k) => [k, CFDI_JOB_LIMITS[k].maxAttempts]),
      ),
    ).toEqual({
      cfdi_org: 8,
      cfdi_csd: 3,
      cfdi_stamp: 20,
      cfdi_deliver: 8,
      cfdi_cancel: 12,
      cfdi_reconcile: 3,
      cfdi_global: 20,
      cfdi_refund: 60,
      cfdi_reissue: 20,
    });
  });

  it("the web registry has no cfdi kind and its handler index keeps the cfdi line commented", () => {
    expect([...handlers().keys()].filter((k) => k.startsWith("cfdi_"))).toEqual(
      [],
    );
    const index = readFileSync("server/jobs/handlers/index.ts", "utf8");
    expect(index).toMatch(/^\/\/ import "\.\/cfdi\.js";$/m);
  });
});

describe("26. retryOrExhaust", () => {
  const job = (
    attempts: number,
    payload: unknown = {},
    kind = "cfdi_stamp",
  ) => ({
    kind,
    attempts,
    payload,
  });
  it("retries below the per-document limit and dies with cfdi_attempts_exhausted at it", () => {
    expect(
      retryOrExhaust(job(11, { maxAttempts: 12 }), {
        code: "cfdi_provider_unavailable",
      }),
    ).toEqual({
      status: "retry",
      code: "cfdi_provider_unavailable",
    });
    expect(
      retryOrExhaust(job(12, { maxAttempts: 12 }), {
        code: "cfdi_provider_unavailable",
      }),
    ).toEqual({
      status: "dead",
      code: "cfdi_attempts_exhausted",
    });
    expect(lastAttempt(job(12, { maxAttempts: 12 }))).toBe(true);
    expect(lastAttempt(job(11, { maxAttempts: 12 }))).toBe(false);
  });
  it("uses the per-kind ceiling without a payload limit, and keeps afterMs", () => {
    expect(
      retryOrExhaust(job(19), { code: "cfdi_x", afterMs: 15_000.4 }),
    ).toEqual({
      status: "retry",
      code: "cfdi_x",
      afterMs: 15_000,
    });
    expect(retryOrExhaust(job(20), { code: "cfdi_x" })?.status).toBe("dead");
    expect(
      retryOrExhaust(job(3, {}, "cfdi_csd"), { code: "cfdi_x" })?.status,
    ).toBe("dead");
    expect(
      retryOrExhaust(job(59, {}, "cfdi_refund"), { code: "cfdi_x" })?.status,
    ).toBe("retry");
  });
  it("codes always match the job code regex", () => {
    const outcome = retryOrExhaust(job(1), { code: "Not A Code" });
    expect(outcome).toEqual({ status: "retry", code: "cfdi_unexpected_error" });
  });
});

describe("27. dedupe keys", () => {
  it("every key format is at most 200 characters for maximal inputs", () => {
    const id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const at = new Date("2026-12-31T23:59:59.999Z");
    const keys = [
      dedupe.provision(id),
      dedupe.refresh(at),
      dedupe.goLive(id),
      dedupe.csd(id),
      dedupe.stamp(id, ":r9999"),
      dedupe.stamp(id, ":dep"),
      dedupe.deliver(id),
      dedupe.email(id),
      dedupe.acuse(id),
      dedupe.cancel(id),
      dedupe.reconcile(id, "cancel", 260),
      dedupe.tick(at),
      dedupe.tickEnsure(at),
      dedupe.tickActivate(),
      dedupe.tickLive(),
      dedupe.tickAfterCancel(id),
      dedupe.run(id),
      dedupe.refund(id),
      dedupe.refundForce(id, id),
      dedupe.refundSweep(id, "2026-12-31"),
      dedupe.reissue(id, id),
    ];
    for (const k of keys) expect(k.length, k).toBeLessThanOrEqual(200);
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(100);
    expect(tenMinuteBucket(new Date("2026-10-05T18:47:31Z"))).toBe(
      "2026-10-05T18:40",
    );
  });
});

describe("global scheduler helpers", () => {
  it("periodsThrough covers the mode's start through today with the periodicity in force", () => {
    const periods = periodsThrough("2026-10-17", "2026-11-03", {
      globalPeriodicity: "month",
      nextPeriodicity: "day",
      nextPeriodicityFrom: "2026-11-01",
    });
    expect(periods.map((p) => p.key)).toEqual([
      "M2026-10",
      "D2026-11-01",
      "D2026-11-02",
      "D2026-11-03",
    ]);
  });
  it("tick chains converge on 6-hour UTC boundaries", () => {
    expect(nextSixHours(new Date("2026-10-05T18:47:31Z")).toISOString()).toBe(
      "2026-10-06T00:00:00.000Z",
    );
    expect(nextSixHours(new Date("2026-10-05T12:00:00Z")).toISOString()).toBe(
      "2026-10-05T18:00:00.000Z",
    );
  });
});
