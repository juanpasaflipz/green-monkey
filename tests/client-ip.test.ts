import { describe, expect, it, vi } from "vitest";
import express from "express";
import { ipKeyGenerator } from "express-rate-limit";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { trustProxy } from "../server/http.js";
import { clientAddress, clientIp } from "../server/logging.js";

/**
 * clientIp / clientAddress (server/logging.ts) against Railway's verified
 * header shape (LD-46): the edge connects from 100.64.0.0/10, discards the
 * client's own X-Forwarded-For and X-Real-IP, and sends
 * `X-Forwarded-For: <client>, <edge hop>` plus `X-Real-IP: <client>`.
 * Documentation addresses only: 198.51.100.x clients, 192.0.2.84 the edge hop.
 */
const EDGE_HOP = "192.0.2.84";
const EDGE_PEER = "100.64.0.3";

/** A request built on a real Express app's request prototype, so req.ip and req.get are Express's own. */
function request(
  peer: string | undefined,
  headers: Record<string, string> = {},
  trust: string | number | boolean = trustProxy({ NODE_ENV: "production" }),
  url = "/api/orders",
): express.Request {
  const app = express();
  app.set("trust proxy", trust);
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return Object.create(app.request, {
    socket: { value: { remoteAddress: peer } },
    headers: { value: lower },
    url: { value: url },
  }) as express.Request;
}
const railway = (client: string, peer = EDGE_PEER) =>
  request(peer, {
    "X-Forwarded-For": `${client}, ${EDGE_HOP}`,
    "X-Real-IP": client,
  });

describe("clientIp behind Railway's edge (LD-46)", () => {
  it("a trusted edge peer's X-Real-IP is the client, not the edge hop req.ip resolves to", () => {
    const req = railway("198.51.100.7");
    // The bug: Express walks X-Forwarded-For to the first untrusted hop.
    expect(req.ip).toBe(EDGE_HOP);
    expect(clientAddress(req)).toEqual({
      ip: "198.51.100.7",
      source: "x-real-ip",
      peerTrusted: true,
    });
    expect(clientIp(req)).toBe("198.51.100.7");
  });

  it("two clients behind the same edge hop are two clients", () => {
    const a = railway("198.51.100.7");
    const b = railway("198.51.100.8");
    expect(a.ip).toBe(b.ip);
    expect(clientIp(a)).not.toBe(clientIp(b));
    expect(ipKeyGenerator(clientIp(a), 56)).not.toBe(
      ipKeyGenerator(clientIp(b), 56),
    );
  });

  it("an untrusted peer's spoofed X-Real-IP and X-Forwarded-For are ignored: the socket address", () => {
    const req = request("203.0.113.5", {
      "X-Real-IP": "198.51.100.9",
      "X-Forwarded-For": "198.51.100.10",
    });
    expect(clientAddress(req)).toEqual({
      ip: "203.0.113.5",
      source: "peer",
      peerTrusted: false,
    });
  });

  it("a trusted peer without X-Real-IP falls back to req.ip (the forwarded hop, else the peer)", () => {
    expect(
      clientAddress(request(EDGE_PEER, { "X-Forwarded-For": "198.51.100.7" })),
    ).toEqual({ ip: "198.51.100.7", source: "forwarded", peerTrusted: true });
    expect(clientAddress(request("127.0.0.1"))).toEqual({
      ip: "127.0.0.1",
      source: "peer",
      peerTrusted: true,
    });
  });

  it("an X-Real-IP that is not exactly one valid address is ignored", () => {
    for (const bad of ["not-an-ip", "198.51.100.7, 198.51.100.8", "", " "])
      expect(
        clientAddress(
          request(EDGE_PEER, {
            "X-Forwarded-For": "198.51.100.20",
            "X-Real-IP": bad,
          }),
        ),
      ).toEqual({
        ip: "198.51.100.20",
        source: "forwarded",
        peerTrusted: true,
      });
    expect(
      clientIp(request(EDGE_PEER, { "X-Real-IP": " 198.51.100.7 " })),
    ).toBe("198.51.100.7");
  });

  it("IPv4-mapped IPv6 peers are judged and reported as IPv4", () => {
    const trusted = request("::ffff:100.64.0.3", {
      "X-Forwarded-For": `198.51.100.7, ${EDGE_HOP}`,
      "X-Real-IP": "198.51.100.7",
    });
    expect(clientAddress(trusted)).toEqual({
      ip: "198.51.100.7",
      source: "x-real-ip",
      peerTrusted: true,
    });
    expect(
      clientAddress(
        request("::FFFF:127.0.0.1", { "X-Real-IP": "198.51.100.7" }),
      ),
    ).toMatchObject({ ip: "198.51.100.7", peerTrusted: true });
    const untrusted = request("::ffff:203.0.113.5", {
      "X-Real-IP": "198.51.100.9",
    });
    expect(clientAddress(untrusted)).toEqual({
      ip: "203.0.113.5",
      source: "peer",
      peerTrusted: false,
    });
    // A mapped X-Real-IP is the same client as its IPv4 form.
    expect(clientIp(railway("::ffff:198.51.100.7"))).toBe("198.51.100.7");
  });

  it("an IPv6 client keeps its address; limiters group it per /56", () => {
    const a = clientIp(railway("2001:db8:0:100::1"));
    expect(a).toBe("2001:db8:0:100::1");
    expect(ipKeyGenerator(a, 56)).toBe(
      ipKeyGenerator(clientIp(railway("2001:db8:0:1ff::2")), 56),
    );
    expect(ipKeyGenerator(a, 56)).not.toBe(
      ipKeyGenerator(clientIp(railway("2001:db8:0:200::1")), 56),
    );
    expect(
      clientIp(
        request("::ffff:100.64.0.3", { "X-Real-IP": "2001:db8:0:100::1" }),
      ),
    ).toBe("2001:db8:0:100::1");
  });

  it("without proxy trust (development) or with a hop count, the peer decides", () => {
    const dev = request(
      "127.0.0.1",
      { "X-Real-IP": "198.51.100.7", "X-Forwarded-For": "198.51.100.8" },
      false,
    );
    expect(clientAddress(dev)).toEqual({
      ip: "127.0.0.1",
      source: "peer",
      peerTrusted: false,
    });
    // TRUST_PROXY=1: the immediate peer is the one trusted hop.
    expect(
      clientAddress(request("10.1.2.3", { "X-Real-IP": "198.51.100.7" }, 1)),
    ).toEqual({ ip: "198.51.100.7", source: "x-real-ip", peerTrusted: true });
  });

  it("a destroyed socket without an address reports unknown, never throws", () => {
    expect(clientAddress(request(undefined))).toEqual({
      ip: "unknown",
      source: "peer",
      peerTrusted: false,
    });
  });
});

describe("a deployed web warns once when a trusted peer sends no usable X-Real-IP (NETFIX-L1)", () => {
  it("one warn per process on staging or production; none in development, for a usable header, an untrusted peer or a health check", async () => {
    const saved = process.env.APP_ENV;
    // A fresh module: the warning is once per process.
    vi.resetModules();
    const logging = await import("../server/logging.js");
    const lines: Record<string, unknown>[] = [];
    logging.setLogSink((line) => lines.push(JSON.parse(line)));
    const warned = () =>
      lines.filter((l) => l.message === "client_ip_without_real_ip");
    const noHeader = () =>
      request(EDGE_PEER, { "X-Forwarded-For": "198.51.100.7" });
    try {
      process.env.APP_ENV = "development";
      logging.clientAddress(noHeader());
      expect(warned()).toEqual([]);
      for (const env of ["staging", "production"]) {
        process.env.APP_ENV = env;
        logging.clientAddress(railway("198.51.100.7"));
        logging.clientAddress(request("203.0.113.5"));
        logging.clientAddress(request(EDGE_PEER, {}, undefined, "/api/health"));
        logging.clientAddress(request(EDGE_PEER, {}, undefined, "/health"));
        expect(warned(), env).toEqual([]);
      }
      expect(logging.clientAddress(noHeader())).toMatchObject({
        source: "forwarded",
      });
      logging.clientAddress(request(EDGE_PEER, { "X-Real-IP": "bogus" }));
      logging.clientAddress(noHeader());
      expect(warned()).toEqual([
        expect.objectContaining({
          level: "warn",
          env: "production",
          source: "forwarded",
          realIpHeader: "missing",
        }),
      ]);
      // No address in the line: neither the forwarded hop nor the peer.
      expect(JSON.stringify(warned())).not.toMatch(/198\.51\.100|100\.64/);
    } finally {
      if (saved === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = saved;
      logging.setLogSink(null);
    }
  });
});

// ---- Static ratchet: every limiter keys on clientIp ------------------------

function serverFiles(dir = "server"): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return serverFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

interface LimiterScan {
  /** "file:line" of every express-rate-limit call. */
  calls: string[];
  /** Calls whose options object has no keyGenerator (or is not an object literal). */
  missing: string[];
  /**
   * Calls whose keyGenerator does not reach clientIp: neither its own code
   * nor any function, variable or parameter default of the same file it
   * names calls clientIp (NETFIX-L2).
   */
  bypass: string[];
  /** Imports the scan cannot follow (namespace imports, require). */
  unsupported: string[];
  /** Property reads of req.ip / req.ips (the edge hop behind Railway). */
  reqIp: string[];
}

/**
 * Parses TypeScript source (no type checking) and finds every call of
 * express-rate-limit's default or named rateLimit export, under any local
 * name, plus every read of req.ip / req.ips.
 */
function scanLimiters(file: string, source: string): LimiterScan {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: LimiterScan = {
    calls: [],
    missing: [],
    bypass: [],
    unsupported: [],
    reqIp: [],
  };
  // Same-file declarations a keyGenerator may name: functions, variables
  // and parameters with a default, by name (scopes are not told apart).
  const declared = new Map<string, ts.Node[]>();
  const declare = (name: ts.Node, value: ts.Node | undefined) => {
    if (!ts.isIdentifier(name) || !value) return;
    declared.set(name.text, [...(declared.get(name.text) ?? []), value]);
  };
  const collect = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name)
      declare(node.name, node.body);
    if (ts.isVariableDeclaration(node)) declare(node.name, node.initializer);
    if (ts.isParameter(node)) declare(node.name, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(sf);
  /** Whether `node` calls clientIp, itself or through what it names. */
  const throughClientIp = (node: ts.Node, seen = new Set<ts.Node>()) => {
    let found = false;
    const walk = (n: ts.Node) => {
      if (found) return;
      if (ts.isIdentifier(n)) {
        if (n.text === "clientIp") found = true;
        for (const value of declared.get(n.text) ?? [])
          if (!seen.has(value)) {
            seen.add(value);
            walk(value);
          }
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(node);
    return found;
  };
  const where = (node: ts.Node) =>
    `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  const names = new Set<string>();
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "express-rate-limit"
    )
      continue;
    const clause = statement.importClause;
    if (clause?.name) names.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings))
      out.unsupported.push(where(statement));
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        if ((element.propertyName ?? element.name).text === "rateLimit")
          names.add(element.name.text);
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.some(
        (a) => ts.isStringLiteral(a) && a.text === "express-rate-limit",
      )
    )
      out.unsupported.push(where(node));
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      names.has(node.expression.text)
    ) {
      out.calls.push(where(node));
      const options = node.arguments[0];
      const keyed =
        options !== undefined &&
        ts.isObjectLiteralExpression(options) &&
        options.properties.some(
          (p) =>
            !ts.isSpreadAssignment(p) &&
            p.name !== undefined &&
            (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
            p.name.text === "keyGenerator",
        );
      if (!keyed) out.missing.push(where(node));
      else {
        const key = (options as ts.ObjectLiteralExpression).properties.find(
          (p) =>
            !ts.isSpreadAssignment(p) &&
            p.name !== undefined &&
            (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
            p.name.text === "keyGenerator",
        )!;
        const value = ts.isPropertyAssignment(key)
          ? key.initializer
          : ts.isShorthandPropertyAssignment(key)
            ? key.name
            : key;
        if (!throughClientIp(value)) out.bypass.push(where(node));
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ["ip", "ips"].includes(node.name.text) &&
      ts.isIdentifier(node.expression) &&
      ["req", "request"].includes(node.expression.text)
    )
      out.reqIp.push(where(node));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("every rate limiter keys on the real client (LD-46 ratchet)", () => {
  it("the scanner sees default, named and aliased imports and flags a limiter without keyGenerator, or with one that does not go through clientIp", () => {
    const scan = scanLimiters(
      "fixture.ts",
      [
        'import limit, { rateLimit as rl } from "express-rate-limit";',
        "const a = limit({ windowMs: 1, keyGenerator: (req) => ipKeyGenerator(clientIp(req), 56) });",
        "const b = rl({ windowMs: 1 });",
        "const c = limit(options);",
        "const d = limit({ ...options, keyGenerator });",
        "const ip = req.ip;",
        // NETFIX-L2: the key itself must come from clientIp, directly or
        // through a function or default declared in the same file.
        "const e = limit({ keyGenerator: (req) => req.socket.remoteAddress ?? '' });",
        "const f = limit({ keyGenerator: (req) => ipKeyGenerator(String(req.headers['x-forwarded-for']), 56) });",
        "function ipKey(req) { return ipKeyGenerator(clientIp(req), 56); }",
        "const deviceKey = (req) => device(req) ?? `ip:${ipKey(req)}`;",
        "const g = limit({ keyGenerator: ipKey });",
        "const h = limit({ keyGenerator: (req) => deviceKey(req) });",
        "function make(key = (req) => ipKey(req)) { return limit({ keyGenerator: key }); }",
        "const i = limit({ keyGenerator: (req) => tenantKey(req) });",
      ].join("\n"),
    );
    expect(scan.calls).toEqual([
      "fixture.ts:2",
      "fixture.ts:3",
      "fixture.ts:4",
      "fixture.ts:5",
      "fixture.ts:7",
      "fixture.ts:8",
      "fixture.ts:11",
      "fixture.ts:12",
      "fixture.ts:13",
      "fixture.ts:14",
    ]);
    expect(scan.missing).toEqual(["fixture.ts:3", "fixture.ts:4"]);
    expect(scan.bypass).toEqual([
      "fixture.ts:5",
      "fixture.ts:7",
      "fixture.ts:8",
      "fixture.ts:14",
    ]);
    expect(scan.reqIp).toEqual(["fixture.ts:6"]);
    expect(
      scanLimiters("ns.ts", 'import * as erl from "express-rate-limit";')
        .unsupported,
    ).toEqual(["ns.ts:1"]);
  });

  it("no rateLimit() in server/ goes without an explicit keyGenerator through clientIp, and only logging.ts reads req.ip", () => {
    const calls: string[] = [];
    const missing: string[] = [];
    const bypass: string[] = [];
    const unsupported: string[] = [];
    const reqIp: string[] = [];
    for (const file of serverFiles()) {
      const scan = scanLimiters(
        relative(process.cwd(), file),
        readFileSync(file, "utf8"),
      );
      calls.push(...scan.calls);
      missing.push(...scan.missing);
      bypass.push(...scan.bypass);
      unsupported.push(...scan.unsupported);
      if (!file.endsWith(join("server", "logging.ts")))
        reqIp.push(...scan.reqIp);
    }
    // ops, access (3), public, cfdi portal, account, owner (2), billing.
    expect(calls.length).toBeGreaterThanOrEqual(10);
    expect(calls.some((c) => c.startsWith("server/owner-routes.ts:"))).toBe(
      true,
    );
    expect(calls.some((c) => c.startsWith("server/billing-runtime.ts:"))).toBe(
      true,
    );
    expect(missing).toEqual([]);
    expect(bypass).toEqual([]);
    expect(unsupported).toEqual([]);
    expect(reqIp).toEqual([]);
  });
});
