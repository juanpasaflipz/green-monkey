import "dotenv/config";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { generatePairingCode, pairingHash } from "../server/access-pairing.js";
import { signInGoogleOwner } from "../server/owner-accounts.js";

// Local development fixtures only, like tests/restart-http.ts.
const target = new URL(process.env.DATABASE_URL ?? "");
if (
  target.hostname !== "127.0.0.1" ||
  !/^\/green_monkey(_[a-z][a-z0-9]*)?_dev$/.test(target.pathname) ||
  !process.env.MIGRATION_DATABASE_URL
)
  throw Error(
    "Access HTTP checks require the isolated local development fixture",
  );
const TENANT = "10000000-0000-4000-8000-000000000001";
const OWNER = "20000000-0000-4000-8000-000000000001";
const CASHIER = "20000000-0000-4000-8001-000000000001";
// The fixture's second fictional restaurant and its owner.
const OTHER_TENANT = "10000000-0000-4000-8000-000000000002";
const OTHER_OWNER = "20000000-0000-4000-8000-000000000002";
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
  // Only this runner uses the fixture admin URL; the server under test never
  // holds a migration credential (as in CI's browser step).
  delete e.MIGRATION_DATABASE_URL;
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
    return {
      status: response.status,
      json,
      cleared,
      headers: response.headers,
    };
  }
}

let checks = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
async function newCode(name: string, tenant = TENANT, creator = OWNER) {
  const code = generatePairingCode();
  await admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id',${tenant},true)`;
    await tx`insert into device_pairing_codes(tenant_id,id,code_hash,device_name,created_by,expires_at)
      values(${tenant},${randomUUID()},${pairingHash(code)},${name},${creator},now()+interval '10 minutes')`;
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
  await check(
    "/api/access/terminal without demo config returns demo:null (SEC-4)",
    async () => {
      const r = await new Browser().request("GET", "/api/access/terminal");
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { paired: false, google: false, demo: null });
      assert.equal(r.headers.get("cache-control"), "no-store");
    },
  );
  await check(
    "/api/login without a device for a non-demo tenant → 401 device_not_paired",
    async () => {
      const r = await new Browser().request("POST", "/api/login", {
        tenantId: TENANT,
        login: "owner",
        secret: "demo-green-monkey",
      });
      assert.equal(r.status, 401);
      assert.equal(r.json.error, "device_not_paired");
      assert.deepEqual(r.cleared, []);
    },
  );
  await check(
    "/api/auth/google/start on a terminal redirects to /app?auth_error=terminal; /api/auth/account/enter on a terminal → 403 device_is_terminal (GAP-2)",
    async () => {
      const { browser } = await pairedCashier(
        `HTTP terminal ${randomUUID().slice(0, 4)}`,
      );
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
      const plain = await new Browser().request(
        "POST",
        "/api/auth/account/enter",
        {
          tenantId: TENANT,
        },
      );
      assert.equal(plain.json.error, "unauthorized");
    },
  );
  await check(
    "the terminal guard also refuses case variants, a trailing slash, HEAD and account-center commands (RESIDUAL-ACC-22)",
    async () => {
      const { browser } = await pairedCashier(
        `HTTP variants ${randomUUID().slice(0, 4)}`,
      );
      const cookie = [...browser.cookies]
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
      for (const [method, path] of [
        ["GET", "/api/auth/google/start/"],
        ["GET", "/api/auth/Google/Start"],
        ["GET", "/api/auth/GOOGLE/START/"],
        ["HEAD", "/api/auth/google/start"],
        ["HEAD", "/api/auth/Google/start/"],
      ] as const) {
        const r = await fetch(origin + path, {
          method,
          redirect: "manual",
          headers: { cookie },
        });
        assert.equal(r.status, 303, `${method} ${path}`);
        assert.equal(
          r.headers.get("location"),
          "/app?auth_error=terminal",
          `${method} ${path}`,
        );
      }
      for (const path of [
        "/api/auth/Account/enter",
        "/api/auth/account/enter/",
        "/api/auth/ACCOUNT/signup",
        "/api/auth/Account/Invitations",
        "/api/auth/account/locations/",
        "/api/auth/account-center/recovery-codes",
        "/api/auth/Account-Center/anything",
      ]) {
        const r = await browser.request("POST", path, { tenantId: TENANT });
        assert.equal(r.status, 403, path);
        assert.equal(r.json.error, "device_is_terminal", path);
      }
      // Reads stay open, and an unpaired browser still reaches account auth.
      const summary = await browser.request("GET", "/api/auth/Account");
      assert.equal(summary.json.error, "unauthorized");
      const plain = await new Browser().request(
        "POST",
        "/api/auth/Account/enter/",
        {
          tenantId: TENANT,
        },
      );
      assert.equal(plain.json.error, "unauthorized");
    },
  );
  await check(
    "logout succeeds with no cookies, an expired session and a valid session, and clears gm_session only (FOH-7)",
    async () => {
      const anonymous = await new Browser().request("POST", "/api/logout");
      assert.equal(anonymous.status, 200);
      assert.deepEqual(anonymous.json, { ok: true });
      assert.deepEqual(anonymous.cleared, ["gm_session"]);
      const expired = await pairedCashier(
        `HTTP expired ${randomUUID().slice(0, 4)}`,
      );
      await admin`update sessions set expires_at=now()-interval '1 second',absolute_expires_at=now()-interval '1 second' where id=${expired.session.id}`;
      const r1 = await expired.browser.request(
        "POST",
        "/api/access/logout",
        {},
      );
      assert.equal(r1.status, 200);
      assert.deepEqual(r1.cleared, ["gm_session"]);
      assert.ok(expired.browser.cookies.has("gm_device"));
      const valid = await pairedCashier(
        `HTTP valid ${randomUUID().slice(0, 4)}`,
      );
      const r2 = await valid.browser.request("POST", "/api/logout");
      assert.equal(r2.status, 200);
      assert.deepEqual(r2.cleared, ["gm_session"]);
      assert.ok(valid.browser.cookies.has("gm_device"));
      const [row] =
        await admin`select end_reason,revoked from sessions where id=${valid.session.id}`;
      assert.deepEqual(row, { end_reason: "logout", revoked: false });
    },
  );
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
  await check(
    "revoked device → 401 device_revoked with Set-Cookie clearing gm_device",
    async () => {
      const valid = await pairedCashier(
        `HTTP revoked ${randomUUID().slice(0, 4)}`,
      );
      await admin`update devices set active=false,revoked_at=now(),revoked_reason='revoked' where id=${valid.deviceId}`;
      const r = await valid.browser.request("GET", "/api/session");
      assert.equal(r.status, 401);
      assert.equal(r.json.error, "device_revoked");
      assert.deepEqual(r.cleared.sort(), ["gm_device", "gm_session"]);
      const terminal = await valid.browser.request(
        "GET",
        "/api/access/terminal",
      );
      assert.equal(terminal.json.paired, false);
    },
  );
  await check(
    "a revoked device on its roster: /api/access/terminal says device_revoked, so the pairing gate tells the cashier why (SEC-5, restaurant-day A15.7)",
    async () => {
      const valid = await pairedCashier(
        `HTTP roster ${randomUUID().slice(0, 4)}`,
      );
      await valid.browser.request("POST", "/api/logout");
      await admin`update devices set active=false,revoked_at=now(),revoked_reason='revoked' where id=${valid.deviceId}`;
      const terminal = await valid.browser.request(
        "GET",
        "/api/access/terminal",
      );
      assert.equal(terminal.status, 200);
      assert.equal(terminal.json.paired, false);
      assert.equal(terminal.json.reason, "device_revoked");
      assert.ok(terminal.cleared.includes("gm_device"));
      // The credential is gone now: a fresh read is a plain unpaired browser.
      const again = await valid.browser.request("GET", "/api/access/terminal");
      assert.equal(again.json.reason, undefined);
    },
  );
  await check(
    "anonymous floods from the restaurant's IP never spend a paired terminal's PIN or gate budget, and one device's budget is its own (A9/ACC-FLOOR-4)",
    async () => {
      // Guest Wi-Fi on the same public IP: cookie-less requests, then a forged cookie.
      const anonymous = new Browser();
      for (let i = 0; i < 30; i++) {
        const r = await anonymous.request("POST", "/api/access/pin", {});
        assert.equal(r.status, 401, `anonymous pin ${i}`);
        assert.equal(r.json.error, "device_not_paired");
      }
      const flooded = await anonymous.request("POST", "/api/access/pin", {});
      assert.equal(flooded.status, 429);
      assert.equal(flooded.json.error, "too_many_attempts");
      const forged = new Browser();
      forged.cookies.set("gm_device", "eyJpZCI6IngifQ.forged");
      assert.equal(
        (await forged.request("POST", "/api/access/pin", {})).status,
        429,
      );
      // Earlier checks already spent a few of this IP's anonymous gate requests.
      let served = 0;
      for (; served <= 120; served++) {
        const r = await anonymous.request("GET", "/api/access/terminal");
        if (r.status === 429) break;
        assert.equal(r.status, 200, `anonymous gate ${served}`);
      }
      assert.ok(
        served > 100 && served <= 120,
        `anonymous gate limit after ${served}`,
      );
      // Paired terminals on the same IP still sign in and load the gate.
      const a = await pairedCashier(`HTTP flood A ${randomUUID().slice(0, 4)}`);
      const gate = await a.browser.request("GET", "/api/access/terminal");
      assert.equal(gate.status, 200);
      assert.equal(gate.json.paired, true);
      // One device spending its own budget does not affect another device.
      for (let i = 0; i < 29; i++)
        assert.equal(
          (await a.browser.request("POST", "/api/access/pin", {})).status,
          400,
          `device A pin ${i}`,
        );
      assert.equal(
        (await a.browser.request("POST", "/api/access/pin", {})).status,
        429,
      );
      const b = await pairedCashier(`HTTP flood B ${randomUUID().slice(0, 4)}`);
      assert.equal(b.session.employeeId, CASHIER);
    },
  );
  await check(
    "devices paired in another restaurant on the same IP never spend this restaurant's backstop; each restaurant keeps its own (ACC-R-1)",
    async () => {
      // Anyone can pair devices in their own Free restaurant. From a shared IP
      // (guest Wi-Fi, a food court, carrier NAT) 21 such devices each spend
      // their full 30 PIN requests a minute: 20 of them fill that restaurant's
      // backstop of 600, and the 21st is refused by it.
      const devices: Browser[] = [];
      for (let i = 0; i < 21; i++) {
        const b = new Browser();
        const paired = await b.request("POST", "/api/access/pair", {
          code: await newCode(
            `HTTP other ${i} ${randomUUID().slice(0, 4)}`,
            OTHER_TENANT,
            OTHER_OWNER,
          ),
        });
        assert.equal(paired.status, 200, JSON.stringify(paired.json));
        devices.push(b);
      }
      for (const [n, b] of devices.slice(0, 20).entries()) {
        for (let i = 0; i < 30; i++)
          assert.equal(
            (await b.request("POST", "/api/access/pin", {})).status,
            400,
            `other restaurant device ${n} pin ${i}`,
          );
        assert.equal(
          (await b.request("POST", "/api/access/pin", {})).status,
          429,
        );
      }
      const backstopped = await devices[20].request(
        "POST",
        "/api/access/pin",
        {},
      );
      assert.equal(
        backstopped.status,
        429,
        "the other restaurant's own backstop still holds",
      );
      assert.equal(backstopped.json.error, "too_many_attempts");
      // This restaurant's terminals on the same IP still load the gate and sign in.
      const ours = await pairedCashier(
        `HTTP backstop ${randomUUID().slice(0, 4)}`,
      );
      assert.equal(ours.session.employeeId, CASHIER);
      const gate = await ours.browser.request("GET", "/api/access/terminal");
      assert.equal(gate.status, 200);
      assert.equal(gate.json.paired, true);
      assert.equal(
        (await ours.browser.request("POST", "/api/access/logout", {})).status,
        200,
      );
    },
  );
  await check(
    "pairing a browser as a terminal ends the Google owner sign-in it held and clears gm_account (ACC-R-3)",
    async () => {
      // A legacy tablet where the owner used Google "Entrar" before this release.
      const account = await signInGoogleOwner(admin, {
        issuer: "https://accounts.google.com",
        subject: randomUUID(),
        email: "legacy-tablet@example.com",
        name: "Legacy tablet fixture",
      });
      const tablet = new Browser();
      tablet.cookies.set("gm_account", account);
      assert.equal(
        (await tablet.request("GET", "/api/auth/account")).status,
        200,
      );
      const paired = await tablet.request("POST", "/api/access/pair", {
        code: await newCode(`HTTP legacy ${randomUUID().slice(0, 4)}`),
      });
      assert.equal(paired.status, 200, JSON.stringify(paired.json));
      assert.ok(paired.cleared.includes("gm_account"), paired.cleared.join());
      assert.equal(tablet.cookies.has("gm_account"), false);
      assert.equal(
        (await tablet.request("GET", "/api/auth/account")).status,
        401,
      );
      assert.equal(
        (await tablet.request("GET", "/api/auth/account/invitations")).status,
        401,
      );
      // A copy of the old cookie is ended on the server too.
      const copy = new Browser();
      copy.cookies.set("gm_account", account);
      const stale = await copy.request("GET", "/api/auth/account");
      assert.equal(stale.status, 401);
      assert.equal(stale.json.error, "unauthorized");
    },
  );
  await check(
    "the 11th failed pairing attempt in a minute → 429 too_many_attempts",
    async () => {
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
    },
  );
  await stop();

  // Local/staging fixture server: DEMO_TENANT_ID set.
  await start(true);
  await check(
    "with DEMO_TENANT_ID the gate offers the demo form and the demo owner pairs a browser",
    async () => {
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
    },
  );
  await stop();

  await check(
    "the server refuses to start with DEMO_TENANT_ID in production (D22)",
    async () => {
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
    },
  );
  console.log(`Access HTTP passed: ${checks} checks.`);
} finally {
  await stop();
  await admin.end();
}
