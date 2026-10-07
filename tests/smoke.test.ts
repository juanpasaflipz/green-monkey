import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * scripts/ops/smoke.mjs against a fake deployment (PLATFORM-OPS-2): a deployed run passes
 * only when the worker behind /api/ops/status runs the expected commit with its jobs
 * runner on; --local keeps the old, worker-agnostic behaviour. The client_ip check
 * (LD-46) requires, behind the edge, a trusted peer, the edge's X-Real-IP as the source,
 * a public address, and no change from spoofed forwarding headers.
 */
const sha = "0123456789abcdef0123456789abcdef01234567";
const old = "fedcba9876543210fedcba9876543210fedcba98";
let worker: Record<string, unknown> = {};
let degraded = false;
/** The smoke's spoofed headers (scripts/ops/smoke.mjs SPOOFED). */
const SPOOF_XFF = "203.0.113.7";
const SPOOF_REAL_IP = "203.0.113.8";
type ReqHeaders = http.IncomingHttpHeaders;
/** What Railway's edge hands the web (LD-46): the client's own headers discarded. */
const railway = () => ({
  ip: "198.51.100.50",
  peerTrusted: true,
  source: "x-real-ip",
});
let diagnostics: (headers: ReqHeaders) => Record<string, unknown> = railway;
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
      return json(200, diagnostics(req.headers));
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

describe("CD smoke client_ip (LD-46)", { timeout: 20_000 }, () => {
  const clientIp = async () => {
    worker = healthy();
    degraded = false;
    const result = await smoke();
    return {
      ...result,
      check: result.report.checks.find((c: any) => c.name === "client_ip"),
    };
  };
  afterEach(() => {
    diagnostics = railway;
  });

  it("passes behind Railway's edge: trusted peer, X-Real-IP source, public, spoof-invariant", async () => {
    const { code, check } = await clientIp();
    expect(code).toBe(0);
    expect(check).toMatchObject({
      ok: true,
      peerTrusted: true,
      source: "x-real-ip",
    });
    // The report never prints the address.
    expect(JSON.stringify(check)).not.toContain("198.51.100.50");
  });

  it("fails when the address is the edge's X-Forwarded-For hop (the staging failure)", async () => {
    diagnostics = () => ({
      ip: "192.0.2.84",
      peerTrusted: true,
      source: "forwarded",
    });
    const { code, report, check } = await clientIp();
    expect(code).toBe(1);
    expect(report.error).toBe("client_ip failed");
    expect(check.error).toContain("plain: source is forwarded, not x-real-ip");
    expect(check.error).toContain(
      "spoofed: source is forwarded, not x-real-ip",
    );
  });

  it("fails when the edge's peer is not trusted", async () => {
    diagnostics = () => ({
      ip: "198.51.100.50",
      peerTrusted: false,
      source: "peer",
    });
    const { code, check } = await clientIp();
    expect(code).toBe(1);
    expect(check.error).toContain("plain: peerTrusted is false");
    expect(check.error).toContain("source is peer, not x-real-ip");
  });

  it("fails when a client-supplied X-Real-IP or X-Forwarded-For comes back", async () => {
    const seen: (string | undefined)[] = [];
    diagnostics = (headers) => {
      seen.push(headers["x-real-ip"] as string | undefined);
      return { ...railway(), ip: headers["x-real-ip"] ?? "198.51.100.50" };
    };
    let result = await clientIp();
    expect(seen).toEqual([undefined, SPOOF_REAL_IP]);
    expect(result.code).toBe(1);
    expect(result.check.error).toContain(
      "spoofed: ip is a client-supplied forwarding header value",
    );
    expect(result.check.error).toContain(
      "spoofed: forwarding headers changed the client IP",
    );
    diagnostics = (headers) => ({
      ...railway(),
      ...(headers["x-forwarded-for"]
        ? { ip: SPOOF_XFF, source: "forwarded" }
        : {}),
    });
    result = await clientIp();
    expect(result.code).toBe(1);
    expect(result.check.error).toContain(
      "spoofed: ip is a client-supplied forwarding header value",
    );
    expect(result.check.error).toContain("spoofed: source is forwarded");
  });

  it("fails when the answers differ without echoing a spoofed value (a per-request edge hop)", async () => {
    let n = 0;
    diagnostics = () => ({ ...railway(), ip: `198.51.100.${++n}` });
    const { code, check } = await clientIp();
    expect(code).toBe(1);
    expect(check.error).toBe(
      "spoofed: forwarding headers changed the client IP",
    );
  });

  it("fails on a private, proxy or non-IP address", async () => {
    for (const [ip, message] of [
      ["100.64.0.3", "plain: ip is a proxy or private address, not public"],
      ["10.0.0.8", "plain: ip is a proxy or private address, not public"],
      ["::1", "plain: ip is a proxy or private address, not public"],
      ["unknown", "plain: ip is not an IP address"],
    ]) {
      diagnostics = () => ({ ...railway(), ip });
      const { code, check } = await clientIp();
      expect(code, ip).toBe(1);
      expect(check.error, ip).toBe(message);
    }
  });

  it("--local skips the edge checks (loopback is the trusted peer)", async () => {
    diagnostics = () => ({
      ip: "127.0.0.1",
      peerTrusted: true,
      source: "peer",
    });
    worker = healthy();
    const { code, report } = await smoke("--local");
    expect(code).toBe(0);
    expect(
      report.checks.find((c: any) => c.name === "client_ip"),
    ).toMatchObject({ ok: true, local: true, ip: "127.0.0.1" });
  });
});
