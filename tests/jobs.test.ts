import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { backoffMs, failureState, jobErrorCode } from "../server/jobs/queue.js";
import { resolveOutcome } from "../server/jobs/runner.js";
import {
  clearJobHandlers,
  handlers,
  registerJobHandler,
} from "../server/jobs/registry.js";
import { alertRequest, createAlerter } from "../server/ops/alerts.js";
import { setLogSink } from "../server/log.js";

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

  it("outcome mapping: throw→retry, attempts≥max→dead, blocked, completed", () => {
    expect(resolveOutcome({ ok: true, outcome: undefined })).toEqual({
      action: "complete",
    });
    expect(
      resolveOutcome({ ok: true, outcome: { status: "completed" } }),
    ).toEqual({ action: "complete" });
    expect(
      resolveOutcome({ ok: false, error: Object.assign(new Error("x"), { code: "provider_timeout" }) }),
    ).toEqual({ action: "fail", code: "provider_timeout" });
    expect(resolveOutcome({ ok: false, error: new TypeError("boom") })).toEqual({
      action: "fail",
      code: "handler_error",
    });
    expect(
      resolveOutcome({
        ok: true,
        outcome: { status: "retry", code: "rate_limited", afterMs: 5000 },
      }),
    ).toEqual({ action: "fail", code: "rate_limited", retryAfterMs: 5000 });
    expect(
      resolveOutcome({ ok: true, outcome: { status: "blocked", code: "printer_not_paired" } }),
    ).toMatchObject({ blocked: true });
    expect(
      resolveOutcome({ ok: true, outcome: { status: "dead", code: "invalid_payload" } }),
    ).toMatchObject({ dead: true });
    expect(failureState({ attempts: 1, maxAttempts: 8 }, {})).toBe("retry");
    expect(failureState({ attempts: 8, maxAttempts: 8 }, {})).toBe("dead");
    expect(failureState({ attempts: 1, maxAttempts: 8 }, { dead: true })).toBe("dead");
    expect(failureState({ attempts: 8, maxAttempts: 8 }, { blocked: true })).toBe(
      "blocked",
    );
  });

  it("stores only machine-readable error codes", () => {
    expect(jobErrorCode("printer_offline")).toBe("printer_offline");
    expect(jobErrorCode("Customer email is invalid")).toBe("handler_error");
    expect(jobErrorCode(undefined)).toBe("handler_error");
  });

  it("registers each kind once with sane defaults", () => {
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
    const ntfy = alertRequest({ url: "https://ntfy.sh/t", kind: "ntfy" }, "production", alert, at);
    expect(ntfy.init.headers).toMatchObject({
      Title: "Green Monkey production: dead jobs",
      Priority: "high",
      Tags: "warning",
    });
    expect(ntfy.init.body).toBe("jobs_dead receipt=2");
    expect(
      JSON.parse(
        alertRequest({ url: "https://x", kind: "slack" }, "staging", alert, at).init
          .body as string,
      ),
    ).toEqual({ text: "*Green Monkey staging: dead jobs*\njobs_dead receipt=2" });
    expect(
      JSON.parse(
        alertRequest({ url: "https://x", kind: "discord" }, "staging", alert, at).init
          .body as string,
      ).content,
    ).toContain("dead jobs");
    expect(
      JSON.parse(
        alertRequest({ url: "https://x", kind: "generic" }, "staging", alert, at).init
          .body as string,
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
      { appEnv: "staging", fetch: fetch as unknown as typeof globalThis.fetch, now: () => now },
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
