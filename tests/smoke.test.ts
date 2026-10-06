import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * scripts/ops/smoke.mjs against a fake deployment (PLATFORM-OPS-2): a deployed run passes
 * only when the worker behind /api/ops/status runs the expected commit with its jobs
 * runner on; --local keeps the old, worker-agnostic behaviour.
 */
const sha = "0123456789abcdef0123456789abcdef01234567";
const old = "fedcba9876543210fedcba9876543210fedcba98";
let worker: Record<string, unknown> = {};
let degraded = false;
let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const json = (status: number, body: unknown, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/version")
      return json(200, { commit: sha, version: "1" });
    if (req.url === "/api/health") return json(200, { ok: true });
    if (req.url === "/api/ops/status")
      return json(200, {
        ok: true,
        version: "1",
        commit: sha,
        db: "ok",
        schema: "ready",
        worker,
        degraded,
      });
    if (req.url === "/api/ops/diagnostics/ip")
      return json(200, {
        ip: "203.0.113.50",
        peerTrusted: true,
        forwardedHop: true,
      });
    if (req.url === "/api/public/smoke/orders")
      return json(
        400,
        { error: "invalid_json", requestId: "req-1" },
        { "X-Request-Id": "req-1" },
      );
    if (req.url === "/api/session") return json(401, { error: "unauthorized" });
    json(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Runs the smoke asynchronously (the fake server lives in this process). */
function smoke(...extra: string[]) {
  return new Promise<{ code: number; report: Record<string, any> }>((resolve) =>
    execFile(
      process.execPath,
      [
        "scripts/ops/smoke.mjs",
        "--base-url",
        base,
        "--expect-commit",
        sha,
        "--timeout",
        "1",
        "--poll-ms",
        "50",
        ...extra,
      ],
      { encoding: "utf8" },
      (error, stdout) =>
        resolve({
          code: error ? Number((error as { code?: number }).code ?? 1) : 0,
          report: JSON.parse(stdout.trim().split("\n").at(-1) || "{}"),
        }),
    ),
  );
}
const healthy = (o: Record<string, unknown> = {}) => ({
  status: "ok",
  lastBeatAt: new Date().toISOString(),
  commit: sha,
  jobs: true,
  ...o,
});

describe("CD smoke (scripts/ops/smoke.mjs)", { timeout: 20_000 }, () => {
  it("passes when the worker runs the deployed commit with its jobs runner on", async () => {
    worker = healthy();
    degraded = false;
    const { code, report } = await smoke();
    expect(report.error).toBeUndefined();
    expect(code).toBe(0);
    expect(
      report.checks.find((c: any) => c.name === "ops_status"),
    ).toMatchObject({ ok: true, workerCommit: sha, workerJobs: true });
  });

  it("fails while the previous worker still answers (a new worker that never booted)", async () => {
    worker = healthy({ commit: old });
    const { code, report } = await smoke();
    expect(code).toBe(1);
    expect(report.error).toBe("ops_status failed");
    expect(report.checks.at(-1).error).toContain(
      `worker serving ${old.slice(0, 12)}`,
    );
  });

  it("fails when the worker's jobs runner is off or the status is degraded", async () => {
    worker = healthy({ jobs: false });
    let result = await smoke();
    expect(result.code).toBe(1);
    expect(result.report.checks.at(-1).error).toContain(
      "worker jobs runner is off",
    );
    worker = healthy();
    degraded = true;
    result = await smoke();
    expect(result.code).toBe(1);
    expect(result.report.checks.at(-1).error).toContain("degraded");
    degraded = false;
  });

  it("--local keeps the worker-agnostic check", async () => {
    worker = healthy({ commit: old, jobs: false });
    const { code } = await smoke("--local");
    expect(code).toBe(0);
  });
});
