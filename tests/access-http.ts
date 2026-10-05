import "dotenv/config";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { generatePairingCode, pairingHash } from "../server/access-pairing.js";

// Local development fixtures only, like tests/restart-http.ts.
const target = new URL(process.env.DATABASE_URL ?? "");
if (
  target.hostname !== "127.0.0.1" ||
  !/^\/green_monkey(_[a-z]+)?_dev$/.test(target.pathname) ||
  !process.env.MIGRATION_DATABASE_URL
)
  throw Error("Access HTTP checks require the isolated local development fixture");
const TENANT = "10000000-0000-4000-8000-000000000001";
const OWNER = "20000000-0000-4000-8000-000000000001";
const CASHIER = "20000000-0000-4000-8001-000000000001";
const port = Number(process.env.RESTART_TEST_PORT ?? 3003),
  origin = `http://127.0.0.1:${port}`;
const admin = postgres(process.env.MIGRATION_DATABASE_URL, { max: 1 });
let server: ChildProcess | undefined;

function env(demo: boolean, extra: Record<string, string> = {}) {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    APP_URL: origin,
    BILLING_SANDBOX_ENABLED: "false",
    ...extra,
  };
  if (demo) e.DEMO_TENANT_ID = TENANT;
  else delete e.DEMO_TENANT_ID;
  return e;
}
async function start(demo: boolean) {
  server = spawn(process.execPath, ["build/server/index.js"], {
    env: env(demo),
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null)
      throw Error("Access test server exited before readiness");
    try {
      if ((await fetch(origin + "/api/health")).ok) return;
    } catch {
      /* starting */
    }
    await delay(100);
  }
  throw Error("Access test readiness timeout");
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const child = server,
    exited = once(child, "exit");
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 11000);
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
}

/** A cookie jar per simulated browser. */
class Browser {
  cookies = new Map<string, string>();
  csrf = "";
  async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    redirect: RequestRedirect = "follow",
  ) {
    const response = await fetch(origin + path, {
      method,
      redirect,
      headers: {
        "Content-Type": "application/json",
        ...(this.csrf ? { "x-csrf-token": this.csrf } : {}),
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookies = response.headers.getSetCookie();
    const cleared: string[] = [];
    for (const cookie of setCookies) {
      const pair = cookie.split(";", 1)[0],
        separator = pair.indexOf("="),
        name = pair.slice(0, separator),
        value = pair.slice(separator + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(cookie)) {
        this.cookies.delete(name);
        cleared.push(name);
      } else this.cookies.set(name, value);
    }
    const text = await response.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* redirects and HTML */
    }
    return { status: response.status, json, cleared, headers: response.headers };
  }
}

let checks = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
async function newCode(name: string) {
  const code = generatePairingCode();
  await admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id',${TENANT},true)`;
    await tx`insert into device_pairing_codes(tenant_id,id,code_hash,device_name,created_by,expires_at)
      values(${TENANT},${randomUUID()},${pairingHash(code)},${name},${OWNER},now()+interval '10 minutes')`;
  });
  return code;
}
async function pairedCashier(name: string) {
  const b = new Browser();
  const paired = await b.request("POST", "/api/access/pair", {
    code: await newCode(name),
  });
  assert.equal(paired.status, 200, JSON.stringify(paired.json));
  assert.equal(paired.json.device.kind, "terminal");
  const signed = await b.request("POST", "/api/access/pin", {
    employeeId: CASHIER,
    secret: "123456",
  });
  assert.equal(signed.status, 200, JSON.stringify(signed.json));
  const session = await b.request("GET", "/api/session");
  assert.equal(session.status, 200);
  b.csrf = session.json.csrf;
  return { browser: b, session: session.json, deviceId: paired.json.device.id };
}

try {
  // Production-like server: DEMO_TENANT_ID unset.
  await start(false);
  await check("/api/access/terminal without demo config returns demo:null (SEC-4)", async () => {
    const r = await new Browser().request("GET", "/api/access/terminal");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { paired: false, google: false, demo: null });
    assert.equal(r.headers.get("cache-control"), "no-store");
  });
  await check("/api/login without a device for a non-demo tenant → 401 device_not_paired", async () => {
    const r = await new Browser().request("POST", "/api/login", {
      tenantId: TENANT,
      login: "owner",
      secret: "demo-green-monkey",
    });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, "device_not_paired");
    assert.deepEqual(r.cleared, []);
  });
  await check("/api/auth/google/start on a terminal redirects to /app?auth_error=terminal; /api/auth/account/enter on a terminal → 403 device_is_terminal (GAP-2)", async () => {
    const { browser } = await pairedCashier(`HTTP terminal ${randomUUID().slice(0, 4)}`);
    const start = await browser.request(
      "GET",
      "/api/auth/google/start",
      undefined,
      "manual",
    );
    assert.equal(start.status, 303);
    assert.equal(start.headers.get("location"), "/app?auth_error=terminal");
    const enter = await browser.request("POST", "/api/auth/account/enter", {
      tenantId: TENANT,
    });
    assert.equal(enter.status, 403);
    assert.equal(enter.json.error, "device_is_terminal");
    const providers = await browser.request("GET", "/api/auth/providers");
    assert.equal(providers.json.terminal, true);
    assert.equal(providers.json.google, false);
    // An unpaired browser is not affected by the terminal guard.
    const plain = await new Browser().request("POST", "/api/auth/account/enter", {
      tenantId: TENANT,
    });
    assert.equal(plain.json.error, "unauthorized");
  });
  await check("logout succeeds with no cookies, an expired session and a valid session, and clears gm_session only (FOH-7)", async () => {
    const anonymous = await new Browser().request("POST", "/api/logout");
    assert.equal(anonymous.status, 200);
    assert.deepEqual(anonymous.json, { ok: true });
    assert.deepEqual(anonymous.cleared, ["gm_session"]);
    const expired = await pairedCashier(`HTTP expired ${randomUUID().slice(0, 4)}`);
    await admin`update sessions set expires_at=now()-interval '1 second',absolute_expires_at=now()-interval '1 second' where id=${expired.session.id}`;
    const r1 = await expired.browser.request("POST", "/api/access/logout", {});
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.cleared, ["gm_session"]);
    assert.ok(expired.browser.cookies.has("gm_device"));
    const valid = await pairedCashier(`HTTP valid ${randomUUID().slice(0, 4)}`);
    const r2 = await valid.browser.request("POST", "/api/logout");
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.cleared, ["gm_session"]);
    assert.ok(valid.browser.cookies.has("gm_device"));
    const [row] =
      await admin`select end_reason,revoked from sessions where id=${valid.session.id}`;
    assert.deepEqual(row, { end_reason: "logout", revoked: false });
  });
  await check("GET /api/session after logout → 401 session_ended", async () => {
    const valid = await pairedCashier(`HTTP ended ${randomUUID().slice(0, 4)}`);
    const cookie = valid.browser.cookies.get("gm_session")!;
    await valid.browser.request("POST", "/api/logout");
    valid.browser.cookies.set("gm_session", cookie);
    const r = await valid.browser.request("GET", "/api/session");
    assert.equal(r.status, 401);
    assert.equal(r.json.error, "session_ended");
    assert.deepEqual(r.cleared, ["gm_session"]);
  });
  await check("revoked device → 401 device_revoked with Set-Cookie clearing gm_device", async () => {
    const valid = await pairedCashier(`HTTP revoked ${randomUUID().slice(0, 4)}`);
    await admin`update devices set active=false,revoked_at=now(),revoked_reason='revoked' where id=${valid.deviceId}`;
    const r = await valid.browser.request("GET", "/api/session");
    assert.equal(r.status, 401);
    assert.equal(r.json.error, "device_revoked");
    assert.deepEqual(r.cleared.sort(), ["gm_device", "gm_session"]);
    const terminal = await valid.browser.request("GET", "/api/access/terminal");
    assert.equal(terminal.json.paired, false);
  });
  await check("the 11th failed pairing attempt in a minute → 429 too_many_attempts", async () => {
    const b = new Browser();
    for (let i = 0; i < 10; i++) {
      const r = await b.request("POST", "/api/access/pair", {
        code: generatePairingCode(),
      });
      assert.equal(r.status, 400);
      assert.equal(r.json.error, "pairing_code_invalid");
    }
    const r = await b.request("POST", "/api/access/pair", {
      code: generatePairingCode(),
    });
    assert.equal(r.status, 429);
    assert.equal(r.json.error, "too_many_attempts");
  });
  await stop();

  // Local/staging fixture server: DEMO_TENANT_ID set.
  await start(true);
  await check("with DEMO_TENANT_ID the gate offers the demo form and the demo owner pairs a browser", async () => {
    const b = new Browser();
    const gate = await b.request("GET", "/api/access/terminal");
    assert.deepEqual(gate.json.demo, { tenantId: TENANT, login: "owner" });
    const login = await b.request("POST", "/api/login", {
      tenantId: TENANT,
      login: "owner",
      secret: "demo-green-monkey",
    });
    assert.equal(login.status, 200);
    assert.ok(b.cookies.has("gm_device") && b.cookies.has("gm_session"));
    const session = await b.request("GET", "/api/session");
    assert.equal(session.json.role, "owner");
    assert.equal(session.json.access.deviceKind, "terminal");
    // A non-owner cannot pair a browser even on the demo tenant.
    const cashier = await new Browser().request("POST", "/api/login", {
      tenantId: TENANT,
      login: "cashier",
      secret: "123456",
    });
    assert.equal(cashier.status, 403);
    assert.equal(cashier.json.error, "pair_device");
  });
  await stop();

  await check("the server refuses to start with DEMO_TENANT_ID in production (D22)", async () => {
    const child = spawn(process.execPath, ["build/server/index.js"], {
      env: env(true, { RAILWAY_ENVIRONMENT_NAME: "Production" }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => (stderr += chunk));
    const [code] = await Promise.race([
      once(child, "exit"),
      delay(15000).then(() => {
        child.kill("SIGKILL");
        throw Error("server started with demo access in production");
      }),
    ]);
    assert.notEqual(code, 0);
    // The guard itself refused, not some other startup failure.
    assert.match(stderr, /DEMO_TENANT_ID must not be set in production/);
  });
  console.log(`Access HTTP passed: ${checks} checks.`);
} finally {
  await stop();
  await admin.end();
}
