import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import type postgres from "postgres";
import { trustProxy } from "../server/http.js";
import { publicOrdering } from "../server/public-ordering.js";
import { PUBLIC_RATES } from "../server/public-limits.js";
import { newPublicToken } from "../server/public-tokens.js";
import { DomainError } from "../shared/domain.js";
import { LINK_HEADER } from "../shared/public-ordering.js";

let server: http.Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

/**
 * The real public ordering router behind proxy trust wired like
 * server/index.ts. The database handle is a stub that knows no links: a
 * malformed token is refused before it is touched and a well-formed one is
 * looked up and not found, so every request the limits let through answers
 * 404 public_link_invalid.
 */
const noLinks = {
  begin: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(() => Promise.resolve([])),
} as unknown as postgres.Sql;

async function start(env: NodeJS.ProcessEnv = { NODE_ENV: "production" }) {
  const app = express();
  app.set("trust proxy", trustProxy(env));
  app.use(express.json({ limit: "1kb" }));
  app.use("/api/public", publicOrdering(noLinks));
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
    token = "x",
  ) => {
    const r = await fetch(origin + path, {
      method,
      headers: {
        "content-type": "application/json",
        [LINK_HEADER]: token,
        ...headers,
      },
      body: method === "POST" ? "{}" : undefined,
    });
    const body = await r.json();
    return {
      status: r.status,
      error: body.error as string,
      limit: r.headers.get("ratelimit-limit"),
    };
  };
}

/** Sends `n` requests as one client; returns the statuses. */
async function burst(
  send: Awaited<ReturnType<typeof start>>,
  n: number,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  token: () => string = () => "x",
) {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++)
    statuses.push((await send(method, path, headers, token())).status);
  return statuses;
}

const realIp = (ip: string) => ({ "X-Real-IP": ip });

describe("public ordering limits key on the real client address (LD-11 MENU-INT-1)", () => {
  // ABUSE-3 (deliberate change): malformed tokens have their own bucket, so
  // the menu ceiling is exercised with well-formed (unknown) tokens.
  it("menu loads: clients the edge forwards with X-Real-IP get their own budget, whatever the well-formed token", async () => {
    const send = await start();
    const a = realIp("198.51.100.7");
    const statuses = await burst(
      send,
      PUBLIC_RATES.menuPerIp,
      "GET",
      "menu",
      a,
      newPublicToken,
    );
    expect(statuses.every((s) => s === 404)).toBe(true);
    const refused = await send("GET", "menu", a, newPublicToken());
    expect([refused.status, refused.error]).toEqual([429, "rate_limited"]);
    expect(refused.limit).toBe(String(PUBLIC_RATES.menuPerIp));
    // Another diner behind the same edge is a different client.
    const b = await send("GET", "menu", realIp("198.51.100.8"));
    expect([b.status, b.error]).toEqual([404, "public_link_invalid"]);
  });

  it("order submissions: the per-IP order budget holds across many links and is per client, not per edge", async () => {
    const send = await start();
    const a = realIp("198.51.100.7");
    const statuses = await burst(
      send,
      PUBLIC_RATES.submitPerIp,
      "POST",
      "orders",
      a,
      newPublicToken,
    );
    expect(statuses.every((s) => s === 404)).toBe(true);
    const refused = await send("POST", "orders", a, newPublicToken());
    expect(refused.status).toBe(429);
    expect(refused.limit).toBe(String(PUBLIC_RATES.submitPerIp));
    expect(
      (await send("POST", "orders", realIp("198.51.100.8"), newPublicToken()))
        .status,
    ).toBe(404);
  });

  // ABUSE-3 (deliberate change): malformed tokens used to share the per-IP
  // write bucket; they now share one bucket of their own, so they still mint
  // no keys and no longer drain the budgets of diners behind the same IP.
  it("requests with a malformed token share one per-IP bucket of their own, so spellings mint no keys and drain no shared budget", async () => {
    const send = await start();
    const a = realIp("198.51.100.7");
    const spellings = ["", "x", "eyJhbGciOi.payload.sig", "A".repeat(23)];
    const statuses: number[] = [];
    for (let i = 0; i < PUBLIC_RATES.malformedPerIp; i++)
      statuses.push(
        (
          await send(
            i % 2 ? "POST" : "GET",
            i % 2 ? "orders" : "menu",
            a,
            spellings[i % spellings.length],
          )
        ).status,
      );
    expect(statuses.every((s) => s === 404)).toBe(true);
    const refused = await send("POST", "orders", a, "y");
    expect(refused.status).toBe(429);
    expect(refused.limit).toBe(String(PUBLIC_RATES.malformedPerIp));
    expect((await send("GET", "revision", a, "z")).status).toBe(429);
    // The shared budgets of that client are untouched.
    expect((await send("POST", "orders", a, newPublicToken())).status).toBe(
      404,
    );
    expect((await send("GET", "menu", a, newPublicToken())).status).toBe(404);
    // Another client is another bucket.
    expect(
      (await send("POST", "orders", realIp("198.51.100.8"), "y")).status,
    ).toBe(404);
  });

  it("revision polls: the per-link budget and the per-IP ceiling both key on the client", async () => {
    const send = await start();
    const a = realIp("198.51.100.7");
    const b = realIp("198.51.100.8");
    const link = newPublicToken();
    const perLink = await burst(
      send,
      PUBLIC_RATES.revisionPerIpLink,
      "GET",
      "revision",
      a,
      () => link,
    );
    expect(perLink.every((s) => s === 404)).toBe(true);
    const linkRefusal = await send("GET", "revision", a, link);
    expect(linkRefusal.status).toBe(429);
    expect(linkRefusal.limit).toBe(String(PUBLIC_RATES.revisionPerIpLink));
    expect((await send("GET", "revision", b, link)).status).toBe(404);
    // The per-IP ceiling: every poll so far counted against client a.
    const used = PUBLIC_RATES.revisionPerIpLink + 1;
    await burst(
      send,
      PUBLIC_RATES.revisionPerIp - used,
      "GET",
      "revision",
      a,
      newPublicToken,
    );
    const ceiling = await send("GET", "revision", a, newPublicToken());
    expect(ceiling.status).toBe(429);
    expect(ceiling.limit).toBe(String(PUBLIC_RATES.revisionPerIp));
    expect((await send("GET", "revision", b, newPublicToken())).status).toBe(
      404,
    );
  });

  it("X-Forwarded-For clients are separate; IPv6 clients group per /56; an untrusted peer's X-Real-IP mints no key", async () => {
    let send = await start();
    const xff = (ip: string) => ({ "X-Forwarded-For": ip });
    await burst(
      send,
      PUBLIC_RATES.menuPerIp,
      "GET",
      "menu",
      xff("203.0.113.1"),
    );
    expect((await send("GET", "menu", xff("203.0.113.1"))).status).toBe(429);
    expect((await send("GET", "menu", xff("203.0.113.2"))).status).toBe(404);
    // One /56 is one client network: another address in it shares the bucket,
    // an address outside it does not.
    await burst(
      send,
      PUBLIC_RATES.menuPerIp,
      "GET",
      "menu",
      realIp("2001:db8:0:100::1"),
    );
    expect(
      (await send("GET", "menu", realIp("2001:db8:0:1ff::2"))).status,
    ).toBe(429);
    expect(
      (await send("GET", "menu", realIp("2001:db8:0:200::1"))).status,
    ).toBe(404);
    // Without proxy trust the header is the client's own claim and is ignored:
    // every spelling of it lands in the peer's one bucket.
    await new Promise<void>((r) => server!.close(() => r()));
    send = await start({ NODE_ENV: "development" });
    await burst(
      send,
      PUBLIC_RATES.menuPerIp,
      "GET",
      "menu",
      realIp("198.51.100.7"),
    );
    expect((await send("GET", "menu", realIp("198.51.100.9"))).status).toBe(
      429,
    );
  });
});
