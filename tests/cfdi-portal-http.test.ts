// cfdi (030) self-invoicing portal limits over real HTTP (spec §2.7, §7.3 item 2's limiter part,
// cfdi-rebase S13): the cfdi pre-auth routes behind proxy trust wired like server/index.ts. Every
// request is refused before any database work (unknown code, bad token, invalid body), so the
// database handle is never touched.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import type postgres from "postgres";
import { ZodError } from "zod";
import { trustProxy } from "../server/http.js";
import { registerPreAuth } from "../server/routes/cfdi.js";
import { PORTAL_LIMITS } from "../server/cfdi/portal.js";
import { resetKeyring } from "../server/keyring.js";
import { setLogSink } from "../server/logging.js";
import { DomainError } from "../shared/domain.js";

setLogSink(() => {});
let server: http.Server | null = null;
const savedJwt = process.env.JWT_SECRET;
beforeEach(() => {
  process.env.JWT_SECRET = "synthetic-cfdi-portal-http-secret-0123456789";
  resetKeyring();
});
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  if (savedJwt === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = savedJwt;
  resetKeyring();
});

async function start() {
  const app = express();
  app.set("trust proxy", trustProxy({ NODE_ENV: "production" }));
  app.use(express.json({ limit: "256kb" }));
  registerPreAuth({ app, sql: {} as postgres.Sql });
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) =>
      res
        .status(
          error instanceof DomainError
            ? error.status
            : error instanceof ZodError
              ? 400
              : 500,
        )
        .json({
          error:
            error instanceof DomainError
              ? error.code
              : error instanceof ZodError
                ? "invalid_input"
                : "internal_error",
        }),
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server!.once("listening", r));
  const origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/cfdi/portal/`;
  return async (
    method: "GET" | "POST",
    path: string,
    headers: Record<string, string>,
  ) => {
    const r = await fetch(origin + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: method === "POST" ? "{}" : undefined,
    });
    const body = (await r.json()) as { error?: string; requestId?: string };
    return {
      status: r.status,
      error: body.error,
      requestId: body.requestId,
      limit: r.headers.get("ratelimit-limit"),
      cookies: r.headers.get("set-cookie"),
    };
  };
}
type Send = Awaited<ReturnType<typeof start>>;

async function burst(
  send: Send,
  n: number,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
) {
  const out: number[] = [];
  for (let i = 0; i < n; i++)
    out.push((await send(method, path, headers)).status);
  return out;
}
const realIp = (ip: string) => ({ "X-Real-IP": ip });

describe("cfdi portal limits key on the real client address (LD-9/LD-11, spec §2.7)", () => {
  it("status polls: the 61st request in a minute from one client gets 429 rate_limited with a request id; another client is unaffected", async () => {
    const send = await start();
    const a = realIp("198.51.100.7");
    const statuses = await burst(
      send,
      PORTAL_LIMITS.status,
      "GET",
      "requests/not-a-token",
      a,
    );
    expect(statuses.every((s) => s === 401)).toBe(true);
    const refused = await send("GET", "requests/not-a-token", a);
    expect(refused.status).toBe(429);
    expect(refused.error).toBe("rate_limited");
    expect(refused.requestId).toBeTruthy();
    expect(refused.limit).toBe(String(PORTAL_LIMITS.status));
    // The file route shares the status budget.
    expect((await send("GET", "files/not-a-token/pdf", a)).status).toBe(429);
    const b = await send("GET", "requests/not-a-token", realIp("198.51.100.8"));
    expect(b.status).toBe(401);
    expect(b.error).toBe("unauthorized");
    expect(b.cookies).toBeNull();
  });

  it("lookups: 30 per minute per client; an unknown code is cfdi_portal_code_not_found", async () => {
    const send = await start();
    const a = realIp("203.0.113.9");
    const first = await send("GET", "tickets/short", a);
    expect(first).toMatchObject({
      status: 404,
      error: "cfdi_portal_code_not_found",
    });
    const statuses = await burst(
      send,
      PORTAL_LIMITS.lookup - 1,
      "GET",
      "tickets/short",
      a,
    );
    expect(statuses.every((s) => s === 404)).toBe(true);
    expect((await send("GET", "tickets/short", a)).status).toBe(429);
  });

  it("submissions and RFC access have their own small budgets", async () => {
    const send = await start();
    const a = realIp("192.0.2.44");
    expect(
      (
        await burst(
          send,
          PORTAL_LIMITS.submit,
          "POST",
          "tickets/short/invoices",
          a,
        )
      ).every((s) => s === 400),
    ).toBe(true);
    expect((await send("POST", "tickets/short/invoices", a)).status).toBe(429);
    expect(
      (
        await burst(
          send,
          PORTAL_LIMITS.access,
          "POST",
          "tickets/short/access",
          a,
        )
      ).every((s) => s === 400),
    ).toBe(true);
    expect((await send("POST", "tickets/short/access", a)).status).toBe(429);
  });

  it("IPv6 clients are grouped by /56: two addresses of one /56 share a budget, another /56 does not", async () => {
    const send = await start();
    const one = realIp("2001:db8:1234:5600::1");
    const sameNetwork = realIp("2001:db8:1234:56ff::2");
    const otherNetwork = realIp("2001:db8:1234:5700::1");
    await burst(
      send,
      PORTAL_LIMITS.access,
      "POST",
      "tickets/short/access",
      one,
    );
    expect(
      (await send("POST", "tickets/short/access", sameNetwork)).status,
    ).toBe(429);
    expect(
      (await send("POST", "tickets/short/access", otherNetwork)).status,
    ).toBe(400);
  });
});
