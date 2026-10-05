import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import type postgres from "postgres";
import { trustProxy } from "../server/http.js";
import {
  PUBLIC_ORDERS_PER_MINUTE,
  PUBLIC_REQUESTS_PER_MINUTE,
  REVISION_POLLS_PER_IP_PER_MINUTE,
  REVISION_POLLS_PER_MINUTE,
  publicOrdering,
} from "../server/public-ordering.js";
import { DomainError } from "../shared/domain.js";

let server: http.Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

/**
 * The real public ordering router behind proxy trust wired like
 * server/index.ts. Every request carries an unsigned token, so a request the
 * limits let through is refused with 401 before any database work: the
 * database handle is never touched.
 */
async function start(env: NodeJS.ProcessEnv = { NODE_ENV: "production" }) {
  const app = express();
  app.set("trust proxy", trustProxy(env));
  app.use(express.json({ limit: "1kb" }));
  app.use("/api/public", publicOrdering({} as postgres.Sql));
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) =>
      res.status(error instanceof DomainError ? error.status : 500).json({
        error: error instanceof DomainError ? error.code : "internal_error",
      }),
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server!.once("listening", r));
  const origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/public/`;
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
    await r.arrayBuffer();
    return { status: r.status, limit: r.headers.get("ratelimit-limit") };
  };
}

/** Sends `n` requests as one client; returns the statuses. */
async function burst(
  send: Awaited<ReturnType<typeof start>>,
  n: number,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
) {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++)
    statuses.push((await send(method, path, headers)).status);
  return statuses;
}

const realIp = (ip: string) => ({ "X-Real-IP": ip });

describe("public ordering limits key on the real client address (LD-11 MENU-INT-1)", () => {
  it("catalog loads and receipts: clients the edge forwards with X-Real-IP get their own shared budget", async () => {
    const send = await start();
    const a = realIp("198.51.100.7");
    const statuses = await burst(
      send,
      PUBLIC_REQUESTS_PER_MINUTE,
      "GET",
      "x/catalog",
      a,
    );
    expect(statuses.every((s) => s === 401)).toBe(true);
    expect((await send("GET", "x/catalog", a)).status).toBe(429);
    expect((await send("GET", "receipt/x", a)).status).toBe(429);
    // Another diner behind the same edge is a different client.
    const b = realIp("198.51.100.8");
    expect((await send("GET", "x/catalog", b)).status).toBe(401);
    expect((await send("GET", "receipt/x", b)).status).toBe(401);
  });

  it("order submissions: the order budget is per client, not per edge", async () => {
    const send = await start();
    const a = realIp("198.51.100.7");
    const statuses = await burst(
      send,
      PUBLIC_ORDERS_PER_MINUTE,
      "POST",
      "x/orders",
      a,
    );
    expect(statuses.every((s) => s === 401)).toBe(true);
    const refused = await send("POST", "x/orders", a);
    expect(refused.status).toBe(429);
    expect(refused.limit).toBe(String(PUBLIC_ORDERS_PER_MINUTE));
    expect(
      (await send("POST", "x/orders", realIp("198.51.100.8"))).status,
    ).toBe(401);
  });

  it("revision polls: the per-link budget and the per-IP ceiling both key on the client", async () => {
    const send = await start();
    const a = realIp("198.51.100.7");
    const b = realIp("198.51.100.8");
    // Per link (an unsigned token shares the "-" link key per client).
    const perLink = await burst(
      send,
      REVISION_POLLS_PER_MINUTE,
      "GET",
      "x/revision",
      a,
    );
    expect(perLink.every((s) => s === 401)).toBe(true);
    const linkRefusal = await send("GET", "x/revision", a);
    expect(linkRefusal.status).toBe(429);
    expect(linkRefusal.limit).toBe(String(REVISION_POLLS_PER_MINUTE));
    expect((await send("GET", "x/revision", b)).status).toBe(401);
    // The per-IP ceiling: every poll so far counted against client a.
    const used = REVISION_POLLS_PER_MINUTE + 1;
    await burst(
      send,
      REVISION_POLLS_PER_IP_PER_MINUTE - used,
      "GET",
      "y/revision",
      a,
    );
    const ceiling = await send("GET", "z/revision", a);
    expect(ceiling.status).toBe(429);
    expect(ceiling.limit).toBe(String(REVISION_POLLS_PER_IP_PER_MINUTE));
    expect((await send("GET", "z/revision", b)).status).toBe(401);
  });

  it("X-Forwarded-For clients are separate; IPv6 clients group per /56; an untrusted peer's X-Real-IP mints no key", async () => {
    let send = await start();
    const xff = (ip: string) => ({ "X-Forwarded-For": ip });
    await burst(
      send,
      PUBLIC_REQUESTS_PER_MINUTE,
      "GET",
      "x/catalog",
      xff("203.0.113.1"),
    );
    expect((await send("GET", "x/catalog", xff("203.0.113.1"))).status).toBe(
      429,
    );
    expect((await send("GET", "x/catalog", xff("203.0.113.2"))).status).toBe(
      401,
    );
    // One /56 is one client network: another address in it shares the bucket,
    // an address outside it does not.
    await burst(
      send,
      PUBLIC_REQUESTS_PER_MINUTE,
      "GET",
      "x/catalog",
      realIp("2001:db8:0:100::1"),
    );
    expect(
      (await send("GET", "x/catalog", realIp("2001:db8:0:1ff::2"))).status,
    ).toBe(429);
    expect(
      (await send("GET", "x/catalog", realIp("2001:db8:0:200::1"))).status,
    ).toBe(401);
    // Without proxy trust the header is the client's own claim and is ignored:
    // every spelling of it lands in the peer's one bucket.
    await new Promise<void>((r) => server!.close(() => r()));
    send = await start({ NODE_ENV: "development" });
    await burst(
      send,
      PUBLIC_REQUESTS_PER_MINUTE,
      "GET",
      "x/catalog",
      realIp("198.51.100.7"),
    );
    expect(
      (await send("GET", "x/catalog", realIp("198.51.100.9"))).status,
    ).toBe(429);
  });
});
