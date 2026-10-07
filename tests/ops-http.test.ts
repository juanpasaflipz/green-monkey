import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { trustProxy } from "../server/http.js";
import {
  clientIp,
  logRequestError,
  requestIdOf,
  requestLog,
  setLogSink,
} from "../server/logging.js";
import type postgres from "postgres";
import { opsLimiter, registerPreAuth } from "../server/routes/ops.js";
import { ownerRoutes } from "../server/owner-routes.js";
import { DomainError } from "../shared/domain.js";

/** Never queried: the routes these tests call do not touch the database. */
const noDatabase = {} as postgres.Sql;
/** Railway's edge hop in X-Forwarded-For (a documentation address, LD-46). */
const EDGE_HOP = "192.0.2.84";
/**
 * The headers Railway's edge sends for a client (verified on staging, LD-46):
 * it discards the client's own forwarding headers, appends itself after the
 * client in X-Forwarded-For and sets X-Real-IP to the client. The tests'
 * loopback peer stands in for the edge's 100.64.0.0/10 peer (both trusted).
 */
const edge = (client: string) => ({
  "X-Forwarded-For": `${client}, ${EDGE_HOP}`,
  "X-Real-IP": client,
});

let lines: Record<string, any>[] = [];
let server: http.Server | null = null;
const writes: string[] = [];
const reads: string[] = [];

beforeEach(() => {
  lines = [];
  writes.length = 0;
  reads.length = 0;
  process.env.LOG_LEVEL = "debug";
  setLogSink((line) => lines.push(JSON.parse(line)));
});
afterEach(async () => {
  setLogSink(null);
  delete process.env.LOG_LEVEL;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

/** ownerRoutes reads Google sign-in from process.env when built: build it without. */
function ownerRouter() {
  const names = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
  ];
  const saved = names.map((n) => process.env[n]);
  for (const n of names) delete process.env[n];
  try {
    return ownerRoutes(noDatabase);
  } finally {
    names.forEach((n, i) => {
      if (saved[i] !== undefined) process.env[n] = saved[i];
    });
  }
}

/** An app wired like server/index.ts: proxy trust, body parser, request log, error logging. */
async function start(env: NodeJS.ProcessEnv = { NODE_ENV: "production" }) {
  const app = express();
  app.set("trust proxy", trustProxy(env));
  app.use(express.json({ limit: "1kb" }));
  app.use((req, _res, next) => {
    const tenant = req.get("x-test-tenant");
    if (tenant)
      (req as unknown as { session: object }).session = {
        tenantId: tenant,
        role: "cashier",
      };
    next();
  });
  app.use(
    requestLog(
      (tenantId) => writes.push(tenantId),
      (tenantId) => reads.push(tenantId),
    ),
  );
  // The real /api/ops/diagnostics/ip and owner limiters (no database reached).
  registerPreAuth({ app, sql: noDatabase });
  app.use("/api/auth", ownerRouter());
  app.get("/api/limited", opsLimiter("test", 2), (req, res) =>
    res.json({ ip: clientIp(req) }),
  );
  app.get("/api/ip", (req, res) => res.json({ ip: clientIp(req) }));
  app.get("/api/public/:token/orders", () => {
    throw new TypeError("cannot read properties of undefined");
  });
  app.post("/api/public/:token/orders", (_req, res) => res.json({ ok: true }));
  app.post("/api/fails", () => {
    throw new DomainError("schema_not_ready", 503);
  });
  app.use(
    (
      error: unknown,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const requestId = requestIdOf(req);
      if (!res.headersSent) res.setHeader("X-Request-Id", requestId);
      const reply = (status: number, code: string) => {
        logRequestError(error, req, { status, code });
        return res.status(status).json({ error: code, requestId });
      };
      if (error instanceof DomainError) return reply(error.status, error.code);
      const parse = (error as { type?: string }) ?? {};
      if (parse.type === "entity.parse.failed")
        return reply(400, "invalid_json");
      if (parse.type === "entity.too.large")
        return reply(413, "payload_too_large");
      return reply(500, "internal_error");
    },
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server!.once("listening", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe("request log, client address and error logging", () => {
  it("two clients behind the proxy get independent rate-limit buckets (SEC-1/OPS-3 regression)", async () => {
    const origin = await start();
    const as = (xff: string) =>
      fetch(`${origin}/api/limited`, { headers: { "X-Forwarded-For": xff } });
    expect((await as("203.0.113.1")).status).toBe(200);
    expect((await as("203.0.113.1")).status).toBe(200);
    const limited = await as("203.0.113.1");
    expect(limited.status).toBe(429);
    const body = await limited.json();
    expect(body.error).toBe("rate_limited");
    expect(body.requestId).toBe(limited.headers.get("x-request-id"));
    // A spoofed left-most entry does not mint a fresh bucket.
    expect((await as("1.2.3.4, 203.0.113.1")).status).toBe(429);
    const other = await as("203.0.113.2");
    expect(other.status).toBe(200);
    expect((await other.json()).ip).toBe("203.0.113.2");
    expect(lines.some((l) => l.message === "rate_limited" && l.ipHash)).toBe(
      true,
    );
    expect(JSON.stringify(lines)).not.toContain("203.0.113.1");
  });

  it("X-Real-IP from a trusted peer is the client, even with a forwarded hop; an untrusted peer's is ignored", async () => {
    let origin = await start();
    const ip = async (headers: Record<string, string>) =>
      (await (await fetch(`${origin}/api/ip`, { headers })).json()).ip;
    expect(await ip({ "X-Real-IP": "198.51.100.7" })).toBe("198.51.100.7");
    expect(await ip({ "X-Real-IP": "not-an-ip" })).toBe("127.0.0.1");
    // LD-46 (deliberate change): the trusted edge's X-Real-IP wins over
    // req.ip, which behind Railway is the edge's own X-Forwarded-For hop.
    expect(
      await ip({
        "X-Real-IP": "198.51.100.7",
        "X-Forwarded-For": "203.0.113.9",
      }),
    ).toBe("198.51.100.7");
    expect(await ip({ "X-Forwarded-For": "203.0.113.9" })).toBe("203.0.113.9");
    await new Promise<void>((r) => server!.close(() => r()));
    origin = await start({ NODE_ENV: "development" });
    expect(await ip({ "X-Real-IP": "198.51.100.7" })).toBe("127.0.0.1");
  });

  it("Railway's edge shape: two clients behind one edge hop get their own ops and owner buckets (LD-46 regression)", async () => {
    const origin = await start();
    const limited = (client: string) =>
      fetch(`${origin}/api/limited`, { headers: edge(client) });
    expect((await limited("198.51.100.7")).status).toBe(200);
    expect((await limited("198.51.100.7")).status).toBe(200);
    expect((await limited("198.51.100.7")).status).toBe(429);
    const other = await limited("198.51.100.8");
    expect(other.status).toBe(200);
    expect((await other.json()).ip).toBe("198.51.100.8");
    // The owner routes' 30/min budget (owner-routes.ts) once keyed on req.ip,
    // the edge hop, so one client used it up for everyone behind that hop.
    const owner = (client: string) =>
      fetch(`${origin}/api/auth/unrouted`, {
        method: "POST",
        headers: edge(client),
      });
    for (let i = 0; i < 30; i++)
      expect((await owner("198.51.100.7")).status).toBe(404);
    expect((await owner("198.51.100.7")).status).toBe(429);
    expect((await owner("198.51.100.8")).status).toBe(404);
    expect(JSON.stringify(lines)).not.toContain("198.51.100.7");
  });

  it("/api/ops/diagnostics/ip reports the address, whether the peer is trusted and its source", async () => {
    let origin = await start();
    const probe = async (headers: Record<string, string> = {}) => {
      const response = await fetch(`${origin}/api/ops/diagnostics/ip`, {
        headers,
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      return response.json();
    };
    expect(await probe(edge("198.51.100.7"))).toEqual({
      ip: "198.51.100.7",
      peerTrusted: true,
      source: "x-real-ip",
    });
    expect(await probe({ "X-Forwarded-For": "198.51.100.9" })).toEqual({
      ip: "198.51.100.9",
      peerTrusted: true,
      source: "forwarded",
    });
    expect(await probe()).toEqual({
      ip: "127.0.0.1",
      peerTrusted: true,
      source: "peer",
    });
    await new Promise<void>((r) => server!.close(() => r()));
    origin = await start({ NODE_ENV: "development" });
    expect(await probe(edge("198.51.100.7"))).toEqual({
      ip: "127.0.0.1",
      peerTrusted: false,
      source: "peer",
    });
  });

  it("X-Railway-Request-Id is reused and returned as X-Request-Id and in the error body", async () => {
    const origin = await start();
    const reused = await fetch(`${origin}/api/public/abc/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Railway-Request-Id": "railway-req-123456",
      },
      body: "{bad",
    });
    expect(reused.status).toBe(400);
    expect(reused.headers.get("x-request-id")).toBe("railway-req-123456");
    expect(await reused.json()).toEqual({
      error: "invalid_json",
      requestId: "railway-req-123456",
    });
    const minted = await fetch(`${origin}/api/ip`, {
      headers: { "X-Railway-Request-Id": "bad id; drop" },
    });
    expect(minted.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const big = await fetch(`${origin}/api/public/abc/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x: "y".repeat(5000) }),
    });
    expect(big.status).toBe(413);
    expect((await big.json()).error).toBe("payload_too_large");
  });

  it("500 logs name, message, stack and route template, never the token path", async () => {
    const origin = await start();
    const response = await fetch(
      `${origin}/api/public/SECRET-ORDERING-TOKEN/orders`,
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    const failure = lines.find((l) => l.message === "request_failed")!;
    expect(failure).toMatchObject({
      level: "error",
      route: "/api/public/:token/orders",
      method: "GET",
      status: 500,
      errorName: "TypeError",
      errorMessage: "cannot read properties of undefined",
      requestId: body.requestId,
    });
    expect(failure.stack).toContain("TypeError");
    expect(JSON.stringify(lines)).not.toContain("SECRET-ORDERING-TOKEN");
    const access = lines.find((l) => l.message === "http_request")!;
    expect(access).toMatchObject({ level: "error", status: 500 });
  });

  it("DomainError 5xx is logged; reads log at debug; successful tenant writes notify the jobs runner", async () => {
    const origin = await start();
    await fetch(`${origin}/api/fails`, { method: "POST" });
    expect(lines.find((l) => l.message === "domain_error_5xx")).toMatchObject({
      level: "warn",
      code: "schema_not_ready",
    });
    await fetch(`${origin}/api/ip`, { headers: { "x-test-tenant": "t-read" } });
    await fetch(`${origin}/api/public/abc/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-tenant": "t-write",
      },
      body: "{}",
    });
    await fetch(`${origin}/api/fails`, {
      method: "POST",
      headers: { "x-test-tenant": "t-failed" },
    });
    // A failed read and an anonymous read notify nobody.
    await fetch(`${origin}/api/public/abc/orders`, {
      headers: { "x-test-tenant": "t-read-failed" },
    });
    await fetch(`${origin}/api/ip`);
    await new Promise((r) => setTimeout(r, 20));
    expect(writes).toEqual(["t-write"]);
    // Reads go to the separate observer (jobs resume after a restart, OPS-R12).
    expect(reads).toEqual(["t-read"]);
    const read = lines.find(
      (l) => l.message === "http_request" && l.route === "/api/ip",
    )!;
    expect(read).toMatchObject({
      level: "debug",
      tenantId: "t-read",
      role: "cashier",
    });
    const write = lines.find(
      (l) =>
        l.message === "http_request" && l.method === "POST" && l.status === 200,
    )!;
    expect(write.level).toBe("info");
    for (const l of lines.filter((l) => l.message === "http_request"))
      expect(Object.keys(l)).not.toContain("url");
  });
});
