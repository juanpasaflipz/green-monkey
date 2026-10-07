/**
 * Account (031) checks against the compiled server (NODE_ENV=production) on
 * the isolated local development fixture, like tests/access-http.ts. The
 * runner alone holds the fixture admin URL; the servers it starts never do.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { generatePairingCode, pairingHash } from "../server/access-pairing.js";
import { newPublicToken } from "../server/public-tokens.js";
import { LINK_HEADER, STATUS_HEADER } from "../shared/public-ordering.js";
import { LEGAL_CI_ENV } from "./fixtures/legal-ci.js";

const target = new URL(process.env.DATABASE_URL ?? "");
if (
  target.hostname !== "127.0.0.1" ||
  !/^\/green_monkey(_[a-z]+)?_dev$/.test(target.pathname) ||
  !process.env.MIGRATION_DATABASE_URL
)
  throw Error(
    "Account HTTP checks require the isolated local development fixture",
  );
const TENANT = "10000000-0000-4000-8000-000000000001";
const OWNER = "20000000-0000-4000-8000-000000000001";
const CASHIER = "20000000-0000-4000-8001-000000000001";
const port = Number(process.env.RESTART_TEST_PORT ?? 3003),
  origin = `http://127.0.0.1:${port}`;
const admin = postgres(process.env.MIGRATION_DATABASE_URL, { max: 1 });
let server: ChildProcess | undefined;

async function start(extra: Record<string, string>, unset: string[] = []) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    APP_URL: origin,
    BILLING_SANDBOX_ENABLED: "false",
    ...extra,
  };
  delete env.DEMO_TENANT_ID;
  delete env.MIGRATION_DATABASE_URL;
  delete env.APP_ENV;
  for (const key of unset) delete env[key];
  server = spawn(process.execPath, ["build/server/index.js"], {
    env,
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null)
      throw Error("Account test server exited before readiness");
    try {
      if ((await fetch(origin + "/api/health")).ok) return;
    } catch {
      /* starting */
    }
    await delay(100);
  }
  throw Error("Account test readiness timeout");
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

class Browser {
  cookies = new Map<string, string>();
  csrf = "";
  async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    raw?: string,
  ) {
    const response = await fetch(origin + path, {
      method,
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        ...(this.csrf ? { "x-csrf-token": this.csrf } : {}),
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      ...(raw !== undefined
        ? { body: raw }
        : body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0],
        separator = pair.indexOf("=");
      const name = pair.slice(0, separator),
        value = pair.slice(separator + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(cookie))
        this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString("utf8");
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* downloads, HTML */
    }
    return {
      status: response.status,
      json,
      text,
      bytes,
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
async function paired(employeeId: string, secret: string) {
  const code = generatePairingCode();
  await admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id',${TENANT},true)`;
    await tx`insert into device_pairing_codes(tenant_id,id,code_hash,device_name,created_by,expires_at)
      values(${TENANT},${randomUUID()},${pairingHash(code)},${"Account HTTP " + code.slice(0, 4)},${OWNER},now()+interval '10 minutes')`;
  });
  const b = new Browser();
  const pair = await b.request("POST", "/api/access/pair", { code });
  assert.equal(pair.status, 200, JSON.stringify(pair.json));
  const pin = await b.request("POST", "/api/access/pin", {
    employeeId,
    secret,
  });
  assert.equal(pin.status, 200, JSON.stringify(pin.json));
  const session = await b.request("GET", "/api/session");
  b.csrf = session.json.csrf;
  return {
    browser: b,
    session: session.json,
    deviceId: pair.json.device.id as string,
  };
}

try {
  await start({ ...LEGAL_CI_ENV, PUBLIC_ORDERING_ENABLED: "false" });
  const owner = await paired(OWNER, "demo-green-monkey");
  await check(
    "1 account-center POST from a paired shared terminal → 403 device_is_terminal; without gm_account elsewhere → 401 unauthorized",
    async () => {
      const cashier = await paired(CASHIER, "123456");
      for (const path of [
        "/api/auth/account-center/recovery-codes",
        "/api/auth/account-center/co-owners/invite",
        "/api/auth/account-center/transfers",
        "/api/auth/account-center/tax-profile",
        "/api/auth/account-center/recovery/redeem",
      ]) {
        const r = await cashier.browser.request("POST", path, {});
        assert.equal(r.status, 403, path);
        assert.equal(r.json.error, "device_is_terminal", path);
        const plain = await new Browser().request("POST", path, {});
        assert.equal(plain.status, 401, path);
        assert.equal(plain.json.error, "unauthorized", path);
      }
    },
  );
  await check(
    "2 PUBLIC_ORDERING_ENABLED=false: the diner routes (/api/public menu, revision, orders, status and status/cancel) and the staff /api/ordering/links routes → 404 public_ordering_disabled before any limiter; malformed JSON still → 400 invalid_json",
    async () => {
      // Public ordering (032): opaque link and status tokens travel in
      // headers, never in a path; well-formed ones so only the gate refuses.
      const headers = {
        "Content-Type": "application/json",
        [LINK_HEADER]: newPublicToken(),
        [STATUS_HEADER]: newPublicToken(),
      };
      for (const [method, path] of [
        ["GET", "/api/public/menu"],
        ["GET", "/api/public/revision"],
        ["POST", "/api/public/orders"],
        ["GET", "/api/public/status"],
        ["POST", "/api/public/status/cancel"],
      ] as const) {
        const r = await fetch(origin + path, {
          method,
          headers,
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        assert.equal(r.status, 404, path);
        assert.deepEqual(
          await r.json(),
          { error: "public_ordering_disabled" },
          path,
        );
        assert.equal(
          r.headers.get("ratelimit-limit"),
          null,
          "gate runs before the limiter",
        );
        assert.equal(r.headers.get("ratelimit-policy"), null);
      }
      const created = await owner.browser.request(
        "POST",
        "/api/ordering/links",
        { kind: "counter", label: "Account HTTP" },
      );
      assert.equal(created.status, 404);
      assert.equal(created.json.error, "public_ordering_disabled");
      const listed = await owner.browser.request("GET", "/api/ordering/links");
      assert.equal(listed.status, 404);
      assert.equal(listed.json.error, "public_ordering_disabled");
      // The CD smoke (scripts/ops/smoke.mjs) posts malformed JSON here.
      const malformed = await new Browser().request(
        "POST",
        "/api/public/smoke/orders",
        undefined,
        "{",
      );
      assert.equal(malformed.status, 400);
      assert.equal(malformed.json.error, "invalid_json");
    },
  );
  await check(
    "4 GET /api/account-config with the fictional CI legal set and NODE_ENV=production: published, no missing key; publicOrdering reflects the variable (false is the kill switch: switchedOff)",
    async () => {
      const r = await new Browser().request("GET", "/api/account-config");
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("cache-control"), "public, max-age=300");
      assert.equal(r.json.legal.status, "published");
      assert.equal(r.json.legal.signupOpen, true);
      assert.equal(r.json.legal.entity.name, LEGAL_CI_ENV.LEGAL_ENTITY_NAME);
      assert.ok(
        !("missing" in r.json.legal),
        "missing is never sent in production",
      );
      assert.equal(r.json.support.email, LEGAL_CI_ENV.SUPPORT_EMAIL);
      // "false" is the operator's kill switch, not a deployment that never
      // offered QR ordering (PUBLIC-UX-4).
      assert.deepEqual(r.json.publicOrdering, {
        enabled: false,
        switchedOff: true,
      });
      assert.deepEqual(r.json.saasTax, {
        mode: "off",
        ratePercent: null,
        collectTaxId: false,
        taxProfileEnabled: false,
        cfdiEnabled: false,
      });
    },
  );
  await check(
    "5 export download routes: Cache-Control no-store; ?tenant mismatch → 409 session_changed; a terminal owner with a recent PIN downloads",
    async () => {
      const tables = await owner.browser.request(
        "GET",
        "/api/account-data/tables",
      );
      assert.equal(tables.status, 200, JSON.stringify(tables.json));
      assert.ok(tables.json.some((t: { name: string }) => t.name === "orders"));
      const mismatch = await owner.browser.request(
        "GET",
        `/api/account-data/export.json?tenant=${randomUUID()}`,
      );
      assert.equal(mismatch.status, 409);
      assert.equal(mismatch.json.error, "session_changed");
      const json = await owner.browser.request(
        "GET",
        `/api/account-data/export.json?tenant=${TENANT}`,
      );
      assert.equal(json.status, 200);
      assert.equal(json.headers.get("cache-control"), "no-store");
      assert.match(
        json.headers.get("content-disposition") ?? "",
        /attachment; filename="green-monkey-.+\.json"/,
      );
      assert.equal(json.json.format, "green-monkey-export");
      assert.equal(json.json.restaurant.id, TENANT);
      const csv = await owner.browser.request(
        "GET",
        `/api/account-data/export/csv/orders?tenant=${TENANT}`,
      );
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
      // Excel needs the UTF-8 byte order mark (Response.text() would strip it).
      assert.deepEqual([...csv.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      const header = csv.text.slice(1).split("\r\n", 1)[0].split(",");
      assert.ok(
        header.includes("id") && header.includes("total"),
        header.join(),
      );
      assert.ok(!header.some((c) => /_hash$|_secret$|_token$|csrf/.test(c)));
      const cashier = await paired(CASHIER, "123456");
      const refused = await cashier.browser.request(
        "GET",
        `/api/account-data/export.json?tenant=${TENANT}`,
      );
      assert.equal(refused.status, 403);
      assert.equal(refused.json.error, "forbidden");
    },
  );
  await check(
    "R-20 a refused (step_up_required) export does not consume the 10/hour budget",
    async () => {
      const stale = await paired(OWNER, "demo-green-monkey");
      await admin`update sessions set authenticated_at=now()-interval '2 hours' where id=${stale.session.id}`;
      for (let i = 0; i < 11; i++) {
        const r = await stale.browser.request(
          "GET",
          `/api/account-data/export.json?tenant=${TENANT}`,
        );
        assert.equal(r.status, 403, `attempt ${i}`);
        assert.equal(r.json.error, "step_up_required");
      }
      await admin`update sessions set authenticated_at=now() where id=${stale.session.id}`;
      const allowed = await stale.browser.request(
        "GET",
        `/api/account-data/export.json?tenant=${TENANT}`,
      );
      assert.equal(allowed.status, 200);
    },
  );
  await check(
    "C30 every /api/account-data/* path, routed or not (a CFDI file path included), refuses a cashier (403 forbidden) and a stale terminal owner (403 step_up_required) before any route or limiter; the CSV route never serves cfdi_files or cfdi_secrets",
    async () => {
      const paths = [
        "/api/account-data/tables",
        `/api/account-data/export.json?tenant=${TENANT}`,
        `/api/account-data/export/csv/cfdi_files?tenant=${TENANT}`,
        `/api/account-data/cfdi/files/${randomUUID()}/xml?tenant=${TENANT}`,
      ];
      const cashier = await paired(CASHIER, "123456");
      const stale = await paired(OWNER, "demo-green-monkey");
      await admin`update sessions set authenticated_at=now()-interval '2 hours' where id=${stale.session.id}`;
      for (const path of paths) {
        for (const [who, error] of [
          [cashier, "forbidden"],
          [stale, "step_up_required"],
        ] as const) {
          const r = await who.browser.request("GET", path);
          assert.equal(r.status, 403, `${error} ${path}`);
          assert.equal(r.json.error, error, path);
          assert.equal(r.headers.get("ratelimit-limit"), null, path);
        }
      }
      await admin`update sessions set authenticated_at=now() where id=${stale.session.id}`;
      for (const table of ["cfdi_files", "cfdi_secrets"]) {
        const r = await stale.browser.request(
          "GET",
          `/api/account-data/export/csv/${table}?tenant=${TENANT}`,
        );
        assert.equal(r.status, 404, table);
        assert.equal(r.json.error, "export_table_unknown", table);
      }
      const unrouted = await stale.browser.request("GET", paths[3]);
      assert.equal(unrouted.status, 404);
      assert.equal(unrouted.json.error, "not_found");
    },
  );
  await check(
    "ACC-9 once the hourly export budget is spent, the /account-data/tables pre-check refuses (429 rate_limited) before the client starts a download",
    async () => {
      const device = await paired(OWNER, "demo-green-monkey");
      let exports = 0;
      let refused: Awaited<ReturnType<Browser["request"]>> | null = null;
      for (let i = 0; i <= 10 && !refused; i++) {
        const tables = await device.browser.request(
          "GET",
          "/api/account-data/tables",
        );
        if (tables.status === 429) {
          refused = tables;
          break;
        }
        assert.equal(tables.status, 200, JSON.stringify(tables.json));
        const download = await device.browser.request(
          "GET",
          `/api/account-data/export.json?tenant=${TENANT}`,
        );
        assert.equal(download.status, 200, `export ${i}`);
        exports++;
      }
      assert.ok(refused, "the pre-check refuses once the budget is spent");
      assert.equal(refused.json.error, "rate_limited");
      assert.match(refused.json.requestId, /^[A-Za-z0-9_-]{8,128}$/);
      // Earlier checks used part of the same tenant's 10 per hour.
      assert.ok(exports >= 1 && exports <= 10, String(exports));
      const blocked = await device.browser.request(
        "GET",
        `/api/account-data/export.json?tenant=${TENANT}`,
      );
      assert.equal(blocked.status, 429);
      assert.equal(blocked.json.error, "rate_limited");
    },
  );
  await check(
    "R-08 account rate limits answer 429 {error:'rate_limited', requestId} keyed on the client address",
    async () => {
      let last: Awaited<ReturnType<Browser["request"]>> | null = null;
      for (let i = 0; i < 6; i++)
        last = await new Browser().request(
          "POST",
          "/api/auth/account-center/recovery/redeem",
          { code: "ABCD-EFGH-JKMN-PQRS-TVWX-YZ23" },
        );
      assert.equal(last!.status, 429);
      assert.equal(last!.json.error, "rate_limited");
      assert.match(last!.json.requestId, /^[A-Za-z0-9_-]{8,128}$/);
    },
  );
  await stop();

  // Without the legal set (CI sets it on this step): documents unpublished.
  await start({ PUBLIC_ORDERING_ENABLED: "true" }, Object.keys(LEGAL_CI_ENV));
  await check(
    "3 PUBLIC_ORDERING_ENABLED=true: the diner menu (/api/public/menu) includes restaurant.privacyNoticeUrl; account-config reports enabled and unpublished documents",
    async () => {
      const device = await paired(OWNER, "demo-green-monkey");
      // The fixture's own settings row (if any) is restored afterwards.
      const before = await admin.begin(async (tx) => {
        await tx`select set_config('app.tenant_id',${TENANT},true)`;
        const [row] =
          await tx`select privacy_notice_url from restaurant_account_settings where tenant_id=${TENANT}`;
        await tx`insert into restaurant_account_settings(tenant_id,privacy_notice_url)
        values(${TENANT},'https://taqueria-demo.mx/privacidad')
        on conflict(tenant_id) do update set privacy_notice_url=excluded.privacy_notice_url`;
        return row as { privacy_notice_url: string | null } | undefined;
      });
      // Public ordering (032): a revocable counter code; the diner menu reads
      // its token from a header. The code is deactivated afterwards (LD-P9).
      const link = await device.browser.request("POST", "/api/ordering/links", {
        kind: "counter",
        label: "Account HTTP privacy",
      });
      assert.equal(link.status, 200, JSON.stringify(link.json));
      const menu = async () => {
        const r = await fetch(origin + "/api/public/menu", {
          headers: { [LINK_HEADER]: link.json.token },
        });
        return { status: r.status, json: await r.json() };
      };
      // The settings row is restored even when the first menu assertion
      // fails, and the revoke's status is asserted only after both cleanups,
      // so neither hides the original failure (PUB-B3-L2).
      let revoked: Awaited<ReturnType<Browser["request"]>> | undefined;
      try {
        try {
          const catalog = await menu();
          assert.equal(catalog.status, 200, JSON.stringify(catalog.json));
          assert.equal(
            catalog.json.restaurant.privacyNoticeUrl,
            "https://taqueria-demo.mx/privacidad",
          );
        } finally {
          await admin.begin(async (tx) => {
            await tx`select set_config('app.tenant_id',${TENANT},true)`;
            if (before)
              await tx`update restaurant_account_settings set privacy_notice_url=${before.privacy_notice_url}
              where tenant_id=${TENANT}`;
            else
              await tx`delete from restaurant_account_settings where tenant_id=${TENANT}`;
          });
        }
        const restored = await menu();
        assert.equal(
          restored.json.restaurant.privacyNoticeUrl,
          before?.privacy_notice_url ?? null,
        );
      } finally {
        revoked = await device.browser.request(
          "POST",
          `/api/ordering/links/${link.json.id}/revoke`,
          { operationId: randomUUID() },
        );
      }
      assert.equal(revoked!.status, 200, JSON.stringify(revoked!.json));
      const config = await new Browser().request("GET", "/api/account-config");
      assert.deepEqual(config.json.publicOrdering, {
        enabled: true,
        switchedOff: false,
      });
      assert.equal(config.json.legal.status, "unpublished");
      assert.equal(config.json.legal.entity, null);
    },
  );
  console.log(`Account HTTP checks passed (${checks}).`);
} finally {
  await stop();
  await admin.end();
}
