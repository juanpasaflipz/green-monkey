// Kiosk self-checkout (039) DB and HTTP suite (specs/kiosk-w4.md §8.2, adapted to LD-72: on
// payment only; critic R4, R9–R14, R20–R25, R35, R36). The real diner router over loopback with a
// cookie jar per tablet, the payments worker on the jobs login against the MP and Clip HTTP fake
// (tests/fakes/payments-fake.ts), payments' web settle job, and the media route with the fs store.
//
// Every value here is fictional and obviously so: test card brand and last four digits from the
// providers' test documentation ("visa" / "4242"), secrets spelled "...-not-real", ids like
// 1000001, loopback only. Run: npm run test:db:kiosk (part of test:db:qualification).
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import cookieParser from "cookie-parser";
import postgres from "postgres";
import { ZodError } from "zod";
import { isolatedTarget, requireWorker } from "./isolated-target.js";
import {
  checkRole,
  checkWorkerRole,
  connect,
  connectWorker,
  tenant,
  type Tx,
} from "../server/db.js";
import { setLogSink } from "../server/logging.js";
import { handlers } from "../server/jobs.js";
import { createJobRunner } from "../server/jobs/runner.js";
import { workerHandlers } from "../server/jobs/worker-registry.js";
import "../server/jobs/handlers/payments.js";
import "../server/jobs/handlers/loyalty.js";
import "../server/jobs/handlers/kiosk.js";
import "../server/payments/worker/register.js";
import { publishPaymentsPlatform } from "../server/payments/worker/boot.js";
import { setPaymentsRuntime } from "../server/payments/worker/runtime.js";
import { parseCredentialKeyring } from "../server/cfdi/config.js";
import { saveCredentials } from "../server/payments/providers.js";
import { saveTerminal } from "../server/payments/settings.js";
import { requestCancel, resolveAttempt } from "../server/payments/terminal.js";
import { publicOrdering } from "../server/public-ordering.js";
import { createLink, revokeLink, rotateLink } from "../server/public-links.js";
import { acceptHold, inbox, rejectHold } from "../server/public-holds.js";
import { closeCash } from "../server/cash.js";
import { saveFiscalProfile } from "../server/fiscal.js";
import { getOrder } from "../server/orders.js";
import {
  createPairing,
  kioskSettingsView,
  revokeKioskDevice,
  saveKioskSettings,
  saveStation,
  saveSuggestions,
} from "../server/kiosk-settings.js";
import { DomainError, type Session } from "../shared/domain.js";
import { legalConfig } from "../server/legal.js";
import { LEGAL_CI_ENV } from "./fixtures/legal-ci.js";
import {
  getLoyaltySettings,
  saveLoyaltySettings,
} from "../server/loyalty/settings.js";
import { enrollMember } from "../server/loyalty/members.js";
import type { LoyaltySettingsView } from "../shared/loyalty.js";
import { runRetention } from "../server/ops/retention.js";
import {
  mediaRoute,
  removeProductImage,
  uploadProductImage,
} from "../server/media.js";
import { uploadBody } from "./fixtures/webp.js";
import { kioskReport } from "../server/kiosk-report.js";
import { LINK_HEADER, STATUS_HEADER } from "../shared/public-ordering.js";
import { KIOSK_COOKIE, type KioskCheckoutView } from "../shared/kiosk.js";
import type { SessionAccess } from "../shared/access.js";
import { startPaymentsFake } from "./fakes/payments-fake.js";
import { noRetries } from "./db-retries.js";

const logLines: string[] = [];
setLogSink((line) => {
  logLines.push(line);
  if (process.env.KIOSK_DB_DEBUG && /"level":"(warn|error)"/.test(line))
    console.error(line);
});

const target = isolatedTarget(process.env);
const admin = postgres(target.migration, { max: 2, onnotice: () => {} });
const sql = connect(target.runtime);
await checkRole(sql);
const worker = connectWorker(requireWorker(target));
await checkWorkerRole(worker);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = Date.now().toString(36);
const mediaRoot = await mkdtemp(join(tmpdir(), "gm-kiosk-media-"));
process.env.MEDIA_STORE = "fs";
process.env.MEDIA_FS_ROOT = mediaRoot;
delete process.env.KIOSK_SELF_CHECKOUT_ENABLED;
delete process.env.MENU_PHOTOS_ENABLED;

// ---- The payments fake and the worker runtime pointed at it (fictional credentials).
const FAKE = {
  mpToken: "TEST-mp-access-token-not-real-0000",
  mpSecret: "testWebhookSecretNotReal0000",
  mpUserId: "1000001",
  clipKey: "test-clip-api-key-not-real",
  clipSecret: "test-clip-secret-key-not-real",
};
const fake = await startPaymentsFake(FAKE);
const TEST_CARD = {
  brand: "visa",
  type: "credit_card" as const,
  last4: "4242",
};
const runtime = {
  providers: ["mercadopago", "clip"] as ("mercadopago" | "clip")[],
  mercadopagoApiUrl: fake.mpBase,
  clipApiUrl: fake.clipBase,
  ring: parseCredentialKeyring(
    "t1:" + Buffer.alloc(32, 7).toString("base64url"),
  ),
  appUrl: "https://pos.example.test",
  alert: () => {},
};
setPaymentsRuntime(runtime);
const [platformBefore] =
  await admin`select providers,upload_kid,upload_public_jwk from payments_platform where id=1`;
{
  const { paymentsVault } = await import("../server/vault/vault.js");
  await publishPaymentsPlatform(worker, {
    providers: ["mercadopago", "clip"],
    uploadKid: runtime.ring.active,
    uploadPublicJwk: paymentsVault.uploadKeyPair(runtime.ring).publicJwk,
  });
}
const dead: { kind: string; code: string }[] = [];
const workerRunner = createJobRunner(worker, {
  handlers: workerHandlers,
  concurrency: 4,
  sweepMs: 3_600_000,
  onDead: (job, code) => dead.push({ kind: job.kind, code }),
});
const webKinds = new Map(
  ["payments_settle", "loyalty_reconcile", "media_purge", "media_stale"].map(
    (k) => [k, handlers().get(k)!] as const,
  ),
);
const webRunner = createJobRunner(sql, {
  handlers: () => webKinds,
  concurrency: 2,
  sweepMs: 3_600_000,
  onDead: (job, code) => dead.push({ kind: job.kind, code }),
});

// ---- Fictional restaurants: A (Pro; till "Caja mostrador" with an open drawer) and B.
const organizationId = randomUUID();
const A = randomUUID(),
  B = randomUUID();
const ids = {
  owner: randomUUID(),
  manager: randomUUID(),
  cashier: randomUUID(),
  ownerB: randomUUID(),
  till: randomUUID(),
  till2: randomUUID(),
  deviceB: randomUUID(),
  drawer: randomUUID(),
  drawerB: randomUUID(),
  taco: randomUUID(),
  agua: randomUUID(),
  papas: randomUUID(),
  gratis: randomUUID(),
  tacoB: randomUUID(),
};
const restaurant = {
  name: "Kiosco ficticio " + run,
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
};
const session = (
  tenantId: string,
  employeeId: string,
  role: string,
  deviceId: string,
  access?: Partial<SessionAccess>,
): Session => ({
  id: randomUUID(),
  tenantId,
  employeeId,
  name: role,
  role,
  deviceId,
  expiresAt: "",
  offlineUntil: "",
  csrf: "",
  restaurant,
  ...(access
    ? {
        access: {
          absoluteExpiresAt: null,
          authenticatedAt: new Date().toISOString(),
          deviceName: "Caja mostrador",
          deviceKind: "terminal",
          idleLockSeconds: null,
          ownerAccount: false,
          ...access,
        } as SessionAccess,
      }
    : {}),
});
const owner = session(A, ids.owner, "owner", ids.till, {});
const manager = session(A, ids.manager, "manager", ids.till, {});
const cashier = session(A, ids.cashier, "cashier", ids.till);
const ownerB = session(B, ids.ownerB, "owner", ids.deviceB, {});

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
async function rejects(promise: Promise<unknown>, code: string | RegExp) {
  await assert.rejects(promise, (e: any) => {
    const got = String(e.code ?? e.message);
    if (code instanceof RegExp) assert.match(`${got} ${e.message ?? ""}`, code);
    else assert.equal(got, code);
    return true;
  });
}
const write = <T>(s: Session, fn: (tx: Tx) => Promise<T>) =>
  tenant(sql, s.tenantId, fn);
async function asOwner<T>(tenantId: string, fn: (tx: any) => Promise<T>) {
  return admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}
const one = async (tenantId: string, q: (tx: any) => Promise<any[]>) =>
  (await asOwner(tenantId, q))[0] as Record<string, any>;

// ---- Job rounds: worker kinds (push, poll, cancel) then the web settle.
async function round(tenantId: string) {
  await admin`update jobs set next_at=now() where tenant_id=${tenantId}
    and state='available' and kind like 'payments\\_%'`;
  const w = await workerRunner.drainTenant(tenantId);
  while (workerRunner.running() > 0) await sleep(10);
  const s = await webRunner.drainTenant(tenantId);
  while (webRunner.running() > 0) await sleep(10);
  return w + s;
}
async function drive(attemptId: string, states: string[], tenantId = A) {
  for (let i = 0; i < 40; i++) {
    const r = await one(
      tenantId,
      (tx) => tx`select state from payment_attempts where id=${attemptId}`,
    );
    if (states.includes(r.state)) return r.state as string;
    await round(tenantId);
  }
  throw new Error(`attempt ${attemptId} never reached ${states.join("|")}`);
}

/** Worker kinds only (no web settle) until the attempt reaches `state`. */
async function workerUntil(attemptId: string, state: string, tenantId = A) {
  for (let i = 0; i < 40; i++) {
    const r = await one(
      tenantId,
      (tx) => tx`select state from payment_attempts where id=${attemptId}`,
    );
    if (r.state === state) return;
    await admin`update jobs set next_at=now() where tenant_id=${tenantId}
      and state='available' and kind like 'payments\\_%' and kind<>'payments_settle'`;
    await workerRunner.drainTenant(tenantId);
    while (workerRunner.running() > 0) await sleep(10);
  }
  throw new Error(`attempt ${attemptId} never reached ${state}`);
}

// ---- The diner router as server/index.ts mounts it, with a cookie jar per tablet.
type Tablet = { cookie: string | null; ip: string };
let ipSeq = 10;
const newTablet = (): Tablet => ({ cookie: null, ip: `198.51.100.${ipSeq++}` });
const app = express();
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());
app.use("/api/public", publicOrdering(sql));
app.get("/media/:assetId/:variant.webp", mediaRoute(sql));
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
              : String(error),
      }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
type Reply = { status: number; body: any; setCookie: string | null };
async function call(
  method: "GET" | "POST",
  path: string,
  o: {
    link: string;
    tablet?: Tablet;
    status?: string;
    body?: unknown;
    ip?: string;
  },
): Promise<Reply> {
  // Every request claims its own documentation-range address unless a test pins one, so the
  // per-IP limiters (checked on their own in K19) never interfere with the flows.
  const ip = o.ip ?? `198.51.${(ipSeq >> 8) % 256}.${ipSeq++ % 256}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": `${ip}, 192.0.2.84`,
    "x-real-ip": ip,
    [LINK_HEADER]: o.link,
  };
  if (o.status) headers[STATUS_HEADER] = o.status;
  if (o.tablet?.cookie) headers.cookie = `${KIOSK_COOKIE}=${o.tablet.cookie}`;
  const r = await fetch(origin + "/api/public" + path, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(o.body ?? {}) : undefined,
  });
  const setCookie = r.headers.get("set-cookie");
  if (o.tablet && setCookie) {
    const m = new RegExp(`${KIOSK_COOKIE}=([^;]*)`).exec(setCookie);
    if (m) o.tablet.cookie = m[1] || null;
  }
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, setCookie };
}
const statusKey = () =>
  Buffer.from(randomUUID().replace(/-/g, ""), "hex").toString("base64url");
const line = (productId: string, quantity = 1, origin?: "suggestion") => ({
  id: randomUUID(),
  productId,
  quantity,
  options: [],
  ...(origin ? { origin } : {}),
});

type Kiosk = {
  link: string;
  linkId: string;
  stationId: string;
  tablet: Tablet;
};
async function newKiosk(label: string, s: Session = manager): Promise<Kiosk> {
  const l = await write(s, (tx) => createLink(tx, s, { kind: "kiosk", label }));
  const r = await one(
    s.tenantId,
    (tx) => tx`select station_id from public_links where id=${l.id}`,
  );
  return {
    link: l.token,
    linkId: l.id,
    stationId: r.station_id,
    tablet: newTablet(),
  };
}
async function stationVersion(tenantId: string, stationId: string) {
  return (
    await one(
      tenantId,
      (tx) => tx`select version from kiosk_stations where id=${stationId}`,
    )
  ).version as number;
}
async function configure(k: Kiosk, terminalId: string | null, till = ids.till) {
  const v = await stationVersion(A, k.stationId);
  await write(manager, (tx) =>
    saveStation(tx, manager, k.stationId, {
      operationId: randomUUID(),
      expectedVersion: v,
      terminalId,
      registerDeviceId: till,
    }),
  );
}
async function pair(k: Kiosk) {
  const p = await write(manager, (tx) =>
    createPairing(tx, manager, k.stationId),
  );
  const r = await call("POST", "/kiosk/pair", {
    link: k.link,
    tablet: k.tablet,
    body: { operationId: randomUUID(), code: p.code },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r;
}
async function order(
  k: Kiosk,
  lines: ReturnType<typeof line>[],
  total: number,
  extra: Record<string, unknown> = {},
) {
  const key = statusKey();
  const r = await call("POST", "/kiosk/orders", {
    link: k.link,
    tablet: k.tablet,
    body: {
      operationId: randomUUID(),
      statusKey: key,
      lines,
      name: "Ana",
      expectedTotal: total,
      fulfillment: "here",
      ...extra,
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return {
    key,
    ...(r.body as { checkout: KioskCheckoutView; counterOnly: string | null }),
  };
}
async function charge(k: Kiosk, key: string, operationId = randomUUID()) {
  return call("POST", "/kiosk/charge", {
    link: k.link,
    tablet: k.tablet,
    body: { operationId, statusKey: key },
  });
}
const checkout = (k: Kiosk, key: string) =>
  call("GET", "/kiosk/checkout", {
    link: k.link,
    tablet: k.tablet,
    status: key,
  });
const sync = (k: Kiosk, key: string) =>
  call("POST", "/kiosk/checkout/sync", {
    link: k.link,
    tablet: k.tablet,
    body: { statusKey: key },
  });
async function holdOf(key: string, tenantId = A) {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256")
    .update("gm-public-status-v1:" + key)
    .digest("hex");
  return one(
    tenantId,
    (tx) => tx`select h.*,c.attempt_id,c.attempt_count,c.payment_choice,
      c.loyalty_member_id,c.device_id as checkout_device
    from public_order_holds h left join kiosk_checkouts c on c.tenant_id=h.tenant_id and c.hold_id=h.id
    where h.status_key_hash=${h}`,
  );
}
async function attemptOf(key: string) {
  const h = await holdOf(key);
  return one(
    A,
    (tx) => tx`select * from payment_attempts where id=${h.attempt_id}`,
  );
}
async function staffOnline(
  tenantId: string,
  employeeId: string,
  deviceId: string,
) {
  await admin`insert into sessions(tenant_id,id,employee_id,device_id,token_hash,csrf,expires_at,
      offline_until,created_at,last_seen_at,authenticated_at,absolute_expires_at)
    values(${tenantId},${randomUUID()},${employeeId},${deviceId},${"fx-" + randomUUID()},'fixture',
      now()+interval '8 hours',now()+interval '4 hours',now(),now(),now(),now()+interval '16 hours')`;
}
const setAvailable = (productId: string, available: boolean) =>
  asOwner(
    A,
    (tx) =>
      tx`update catalog set data=jsonb_set(data,'{available}',to_jsonb(${available}::boolean)) where id=${productId}`,
  ).then(() =>
    asOwner(
      A,
      (tx) =>
        tx`update menu_state set revision=revision+1 where tenant_id=${A}`,
    ),
  );

const terminals = { mp: "", clip: "", manual: "" };
let failed = false;
try {
  await admin`insert into organizations(id,name) values(${organizationId},${restaurant.name})`;
  await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,free_location)
    values (${A},${organizationId},${restaurant.name},'MXN',${restaurant.timezone},${restaurant.cutoff},false),
           (${B},${organizationId},${restaurant.name + " B"},'MXN',${restaurant.timezone},${restaurant.cutoff},false)`;
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source)
    values (${A},'active',now()+interval '1 day','fixture'),(${B},'active',now()+interval '1 day','fixture')`;
  for (const [tenantId, employee, role, name] of [
    [A, ids.owner, "owner", "Olga Dueña"],
    [A, ids.manager, "manager", "Marisol Vega"],
    [A, ids.cashier, "cashier", "Carlos Caja"],
    [B, ids.ownerB, "owner", "Beto Dueño"],
  ])
    await admin`insert into employees(tenant_id,id,name,login,secret_hash,role)
      values(${tenantId},${employee},${name},${"k" + randomUUID().slice(0, 12)},'fixture',${role})`;
  await admin`insert into devices(tenant_id,id,name,token_hash,free_slot)
    values (${A},${ids.till},'Caja mostrador','fixture',1),(${A},${ids.till2},'Caja barra','fixture',null),
           (${B},${ids.deviceB},'Caja B','fixture',1)`;
  await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at)
    values (${A},${ids.drawer},${ids.till},${ids.cashier},100000,now()-interval '2 hours'),
           (${B},${ids.drawerB},${ids.deviceB},${ids.ownerB},0,now()-interval '1 hour')`;
  await admin`insert into restaurant_account_settings(tenant_id,privacy_notice_url)
    values(${A},'https://example.com/aviso-de-privacidad')`;
  const product = (
    tenantId: string,
    productId: string,
    name: string,
    price: number,
  ) =>
    admin`insert into catalog(tenant_id,id,data) values(${tenantId},${productId},${admin.json(
      {
        id: productId,
        name: { es: name, en: name },
        category: { es: "Pruebas", en: "Tests" },
        categoryId: randomUUID(),
        price,
        available: true,
        station: "kitchen",
        groups: [],
        cost: 1500,
        recipe: [],
        version: 1,
      },
    )})`;
  await product(A, ids.taco, "Taco ficticio", 4500);
  await product(A, ids.agua, "Agua ficticia", 300);
  await product(A, ids.papas, "Papas ficticias", 3500);
  await product(A, ids.gratis, "Salsa gratis", 0);
  await product(B, ids.tacoB, "Taco B", 2000);
  await asOwner(
    A,
    (tx) =>
      tx`insert into menu_state(tenant_id,revision) values(${A},1) on conflict do nothing`,
  );
  await staffOnline(A, ids.cashier, ids.till);
  await staffOnline(B, ids.ownerB, ids.deviceB);
  await write(owner, (tx) =>
    saveFiscalProfile(tx, owner, {
      operationId: randomUUID(),
      expectedVersion: 0,
      identity: {
        rfc: "EKU9003173C9",
        legalName: "ALIMENTOS DE PRUEBA",
        regime: "601",
        postalCode: "06700",
        address: {
          street: "Av. Ficticia 123",
          neighborhood: "Roma Norte",
          municipality: "Cuauhtémoc",
          state: "Ciudad de México",
        },
      },
      ticketSeries: "",
      taxRegion: "general",
      defaultTaxCategory: "iva16",
      borderConfirmed: false,
    }),
  );
  // Integrated payments: both providers connected through the fake, then terminals.
  for (const [provider, body] of [
    [
      "mercadopago",
      { accessToken: FAKE.mpToken, webhookSecret: FAKE.mpSecret },
    ],
    ["clip", { apiKey: FAKE.clipKey, secretKey: FAKE.clipSecret }],
  ] as const) {
    await write(owner, (tx) =>
      saveCredentials(tx, owner, provider, body, {
        appEnv: "test",
        appUrl: "https://pos.example.test",
      }),
    );
    for (let i = 0; i < 10; i++) await round(A);
  }
  const accounts = await asOwner(
    A,
    (tx) =>
      tx`select provider,state from payment_provider_accounts where tenant_id=${A} order by provider`,
  );
  assert.deepEqual(
    accounts.map((a: any) => `${a.provider}:${a.state}`),
    ["clip:active", "mercadopago:active"],
  );
  const integrated = async (
    name: string,
    kind: string,
    providerDeviceId: string | null,
  ) =>
    (
      await write(manager, (tx) =>
        saveTerminal(tx, manager, {
          operationId: randomUUID(),
          name,
          kind,
          ...(providerDeviceId ? { providerDeviceId } : {}),
          feeBp: 350,
        }),
      )
    ).terminals.find((t) => t.name === name)!.id;
  terminals.mp = await integrated(
    "MP Kiosco",
    "mercadopago_point",
    "NEWLAND_N950__FAKE0001",
  );
  terminals.clip = await integrated(
    "Clip Kiosco",
    "clip_pinpad",
    "P8220724FAKE01",
  );
  terminals.manual = await integrated("Banco ficticio", "manual", null);
  await write(manager, (tx) =>
    saveKioskSettings(tx, manager, {
      operationId: randomUUID(),
      expectedVersion: 0,
      paymentMode: "card_and_counter",
      askFulfillment: true,
      suggestions: true,
      loyaltyAtKiosk: false,
    }),
  );

  // ----------------------------------------------------------------------------------------------
  await test("K1. 039 shape: RLS forced on the six tables; the media lookup policy; no DELETE for the runtime role; identity triggers", async () => {
    const forced =
      await admin`select relname from pg_class where relname = any(${[
        "kiosk_settings",
        "kiosk_stations",
        "kiosk_devices",
        "kiosk_checkouts",
        "menu_media",
        "menu_suggestions",
      ]}) and relrowsecurity and relforcerowsecurity order by relname`;
    assert.equal(forced.length, 6);
    const grants =
      await admin`select table_name,privilege_type from information_schema.role_table_grants
      where grantee=current_setting('app.runtime_role',true) or grantee in ('gm_app')
        and table_name in ('kiosk_settings','kiosk_stations','kiosk_devices','kiosk_checkouts','menu_media','menu_suggestions')
        and privilege_type='DELETE'`;
    assert.equal(grants.length, 0, "no DELETE on kiosk tables");
    // The runtime role cannot point a link at another station, nor blank a member reference.
    const k = await newKiosk("Forma " + run);
    await rejects(
      write(
        manager,
        (tx) =>
          tx`update public_links set station_id=null where id=${k.linkId}`,
      ),
      /permission denied/,
    );
    await rejects(
      write(
        manager,
        (tx) => tx`update kiosk_checkouts set loyalty_member_id=null`,
      ),
      /permission denied/,
    );
    // Identity triggers (as the owner).
    await rejects(
      asOwner(
        A,
        (tx) =>
          tx`update kiosk_stations set created_by=${ids.cashier} where id=${k.stationId}`,
      ),
      /kiosk_station_immutable/,
    );
    await rejects(
      asOwner(
        A,
        (tx) => tx`delete from kiosk_stations where id=${k.stationId}`,
      ),
      /kiosk_station_immutable|violates foreign key/,
    );
    await rejects(
      asOwner(
        A,
        (tx) =>
          tx`update public_links set station_id=null where id=${k.linkId}`,
      ),
      /public_link_immutable/,
    );
    // The media lookup: no tenant, exactly the ready id supplied.
    const mediaA = randomUUID(),
      mediaUploading = randomUUID();
    await asOwner(A, async (tx) => {
      await tx`insert into menu_media(tenant_id,id,state,width,height,variants,created_by)
        values(${A},${mediaA},'ready',4,3,${tx.json({ thumb: { sha256: "x" } })},${ids.owner})`;
      await tx`insert into menu_media(tenant_id,id,created_by) values(${A},${mediaUploading},${ids.owner})`;
    });
    const look = (id: string) =>
      sql.begin(async (raw) => {
        const tx = raw as Tx;
        await tx`select set_config('app.media_id', ${id}, true)`;
        return tx`select id from menu_media`;
      });
    assert.deepEqual(
      (await look(mediaA)).map((r: any) => r.id),
      [mediaA],
    );
    assert.equal(
      (await look(mediaUploading)).length,
      0,
      "an uploading asset is not served",
    );
    assert.equal(
      (await sql`select id from menu_media`).length,
      0,
      "nothing without a tenant or a media id",
    );
    await rejects(
      asOwner(
        A,
        (tx) =>
          tx`update menu_media set state='uploading',variants=null,width=null,height=null where id=${mediaA}`,
      ),
      /menu_media_immutable/,
    );
    await write(manager, (tx) =>
      revokeLink(tx, manager, k.linkId, { operationId: randomUUID() }),
    );
  });

  await test("K2. holds: a kiosk hold may be dine-in without a table; a counter QR hold may not; decision_source 'kiosk' only on an accepted kiosk hold", async () => {
    const counter = await write(manager, (tx) =>
      createLink(tx, manager, { kind: "counter", label: "Mostrador " + run }),
    );
    const base = (linkId: string, channel: string, mode: string) =>
      asOwner(
        A,
        (
          tx,
        ) => tx`insert into public_order_holds(tenant_id,id,link_id,operation_id,request_hash,status_key_hash,
          business_date,number,channel,mode,table_id,policy,lines,priced,quoted_total,menu_revision,order_operation_id,expires_at)
        values(${A},${randomUUID()},${linkId},${randomUUID()},${"a".repeat(64)},${randomUUID().replace(/-/g, "").padEnd(64, "0")},
          current_date,${Math.floor(Math.random() * 1e6) + 1000},${channel},${mode},null,'accept',
          ${tx.json([line(ids.taco)])},'[]',4500,1,${randomUUID()},now()+interval '30 minutes')`,
      );
    const k = await newKiosk("Modo " + run);
    await base(k.linkId, "kiosk", "dine_in");
    await rejects(
      base(counter.id, "qr", "dine_in"),
      /public_order_holds_table_mode/,
    );
    await rejects(
      asOwner(
        A,
        (tx) =>
          tx`update public_order_holds set state='cancelled',decided_at=now(),decision_source='kiosk' where link_id=${k.linkId}`,
      ),
      /public_order_holds_kiosk_decision/,
    );
    await write(manager, (tx) =>
      revokeLink(tx, manager, k.linkId, { operationId: randomUUID() }),
    );
  });

  // The main kiosk: Clip terminal (Clip has no expiry; the fake approves on command).
  const main = await newKiosk("Entrada " + run);
  await configure(main, terminals.clip);

  await test("K3. pairing: one-time 8-digit code; wrong, expired, used and exhausted codes get one answer; the cookie is HttpOnly, SameSite=Strict, scoped to the kiosk path; a new code replaces the tablet; unpairing and deactivation revoke it; rotation keeps it", async () => {
    const k = await newKiosk("Pareo " + run);
    const p = await write(manager, (tx) =>
      createPairing(tx, manager, k.stationId),
    );
    assert.match(p.code, /^[0-9]{8}$/);
    // Step-up is required to create a code.
    await rejects(
      write(manager, (tx) =>
        createPairing(
          tx,
          session(A, ids.manager, "manager", ids.till, {
            authenticatedAt: new Date(Date.now() - 86_400_000).toISOString(),
          }),
          k.stationId,
        ),
      ),
      "step_up_required",
    );
    const wrong = String((Number(p.code) + 1) % 1e8).padStart(8, "0");
    const t = newTablet();
    // The pairing limiter is 5 per IP per 15 minutes; the code itself dies after 5 wrong tries
    // from anywhere, so each try here comes from another address.
    for (let i = 0; i < 4; i++) {
      const r = await call("POST", "/kiosk/pair", {
        link: k.link,
        tablet: newTablet(),
        body: { operationId: randomUUID(), code: wrong },
      });
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "kiosk_pairing_invalid");
      assert.equal(r.setCookie, null);
    }
    const ok = await call("POST", "/kiosk/pair", {
      link: k.link,
      tablet: t,
      body: { operationId: randomUUID(), code: p.code },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.stationLabel, "Pareo " + run);
    assert.match(
      ok.setCookie!,
      new RegExp(
        `^${KIOSK_COOKIE}=[A-Za-z0-9_-]{22}; Max-Age=34560000; Path=/api/public/kiosk; Expires=[^;]+; HttpOnly; SameSite=Strict$`,
      ),
    );
    // Used: the same code again is the same answer.
    const used = await call("POST", "/kiosk/pair", {
      link: k.link,
      tablet: newTablet(),
      body: { operationId: randomUUID(), code: p.code },
    });
    assert.equal(used.body.error, "kiosk_pairing_invalid");
    // The secret is stored only as a hash.
    const d = await one(
      A,
      (tx) =>
        tx`select secret_hash,pairing_code_hash,paired_at from kiosk_devices where station_id=${k.stationId} and revoked_at is null`,
    );
    assert.notEqual(d.secret_hash, t.cookie);
    assert.equal(d.pairing_code_hash, null);
    assert.ok(
      !logLines.some((l) => l.includes(t.cookie!) || l.includes(p.code)),
      "neither the code nor the cookie is logged",
    );
    const state = await call("GET", "/kiosk/state", {
      link: k.link,
      tablet: t,
    });
    assert.equal(state.body.bound, true);
    // Exhausted: five wrong tries kill a code, even the right one after.
    const p2 = await write(manager, (tx) =>
      createPairing(tx, manager, k.stationId),
    );
    const t2 = newTablet();
    assert.equal(
      (await call("GET", "/kiosk/state", { link: k.link, tablet: t })).body
        .bound,
      false,
      "a new code replaces the paired tablet",
    );
    const wrong2 = String((Number(p2.code) + 7) % 1e8).padStart(8, "0");
    for (let i = 0; i < 5; i++)
      await call("POST", "/kiosk/pair", {
        link: k.link,
        tablet: newTablet(),
        body: { operationId: randomUUID(), code: wrong2 },
      });
    const dead5 = await call("POST", "/kiosk/pair", {
      link: k.link,
      tablet: t2,
      body: { operationId: randomUUID(), code: p2.code },
    });
    assert.equal(dead5.body.error, "kiosk_pairing_invalid");
    // Expired.
    const p3 = await write(manager, (tx) =>
      createPairing(tx, manager, k.stationId),
    );
    await asOwner(
      A,
      (tx) =>
        tx`update kiosk_devices set pairing_expires_at=now()-interval '1 second' where station_id=${k.stationId} and revoked_at is null`,
    );
    assert.equal(
      (
        await call("POST", "/kiosk/pair", {
          link: k.link,
          tablet: newTablet(),
          body: { operationId: randomUUID(), code: p3.code },
        })
      ).body.error,
      "kiosk_pairing_invalid",
    );
    // Pair, rotate the link (binding kept), unpair (binding gone).
    const p4 = await write(manager, (tx) =>
      createPairing(tx, manager, k.stationId),
    );
    const t4 = newTablet();
    assert.equal(
      (
        await call("POST", "/kiosk/pair", {
          link: k.link,
          tablet: t4,
          body: { operationId: randomUUID(), code: p4.code },
        })
      ).status,
      200,
    );
    const rotated = await write(manager, (tx) =>
      rotateLink(tx, manager, k.linkId),
    );
    assert.equal(
      (await call("GET", "/kiosk/state", { link: rotated.token, tablet: t4 }))
        .body.bound,
      true,
      "rotation keeps the station and its tablet",
    );
    assert.equal(
      (await call("GET", "/kiosk/state", { link: k.link, tablet: t4 })).body
        .error,
      "public_link_invalid",
    );
    const live = await one(
      A,
      (tx) =>
        tx`select id from kiosk_devices where station_id=${k.stationId} and revoked_at is null`,
    );
    await write(manager, (tx) =>
      revokeKioskDevice(tx, manager, live.id, { operationId: randomUUID() }),
    );
    assert.equal(
      (await call("GET", "/kiosk/state", { link: rotated.token, tablet: t4 }))
        .body.bound,
      false,
    );
    // Deactivating the kiosk link archives the station and revokes a pending code.
    await write(manager, (tx) => createPairing(tx, manager, k.stationId));
    await write(manager, (tx) =>
      revokeLink(tx, manager, rotated.id, { operationId: randomUUID() }),
    );
    const st = await one(
      A,
      (tx) =>
        tx`select archived_at,(select count(*)::int from kiosk_devices d where d.station_id=s.id and d.revoked_at is null) as live from kiosk_stations s where id=${k.stationId}`,
    );
    assert.ok(st.archived_at);
    assert.equal(st.live, 0);
  });

  await test("K4. unbound kiosk: an order becomes a counter-only hold (as before 039), with a checkout; card and member lookups need the binding (403 kiosk_device_required)", async () => {
    const t = newTablet();
    const k = { ...main, tablet: t };
    const state = await call("GET", "/kiosk/state", {
      link: k.link,
      tablet: t,
    });
    assert.equal(state.body.bound, false);
    assert.equal(state.body.selfCheckout, false);
    assert.equal(state.body.card, false);
    const o = await order(k, [line(ids.taco, 2)], 9000);
    assert.equal(o.counterOnly, "unbound");
    assert.equal(o.checkout.holdState, "pending");
    const h = await holdOf(o.key);
    assert.equal(h.mode, "dine_in");
    assert.equal(h.table_id, null);
    assert.equal(h.checkout_device, null);
    const c = await charge(k, o.key);
    assert.equal(c.status, 403);
    assert.equal(c.body.error, "kiosk_device_required");
    const m = await call("POST", "/kiosk/member", {
      link: k.link,
      tablet: t,
      body: { phone: "5555550101" },
    });
    assert.equal(m.body.error, "kiosk_device_required");
    // A tablet bound to another station is unbound here.
    const elsewhere = await newKiosk("Otra " + run);
    await configure(elsewhere, terminals.clip);
    await pair(elsewhere);
    const cross = await call("GET", "/kiosk/state", {
      link: k.link,
      tablet: elsewhere.tablet,
    });
    assert.equal(cross.body.bound, false);
    assert.equal(
      (await charge({ ...k, tablet: elsewhere.tablet }, o.key)).body.error,
      "kiosk_device_required",
    );
    // A forged cookie is the same as none.
    t.cookie = "AAAAAAAAAAAAAAAAAAAAAA";
    assert.equal((await charge(k, o.key)).body.error, "kiosk_device_required");
  });

  await pair(main);

  await test("K9. card approved: the hold becomes the order with the charge as its tender in the receiving till's drawer, a folio, decision_source 'kiosk', the drawer opener as actor; the webhook-style job and two syncs race onto one settle (one order, one tender, one ticket)", async () => {
    const state = await call("GET", "/kiosk/state", {
      link: main.link,
      tablet: main.tablet,
    });
    assert.equal(state.body.selfCheckout, true);
    assert.equal(state.body.card, true);
    const o = await order(
      main,
      [line(ids.taco, 2), line(ids.papas, 1, "suggestion")],
      12500,
    );
    assert.equal(o.counterOnly, null);
    const op = randomUUID();
    const c = await charge(main, o.key, op);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.payment.state, "pending");
    assert.equal(c.body.payment.amount, 12500);
    // A replay of the same operation id answers the same attempt; a new one while live is refused.
    const replay = await charge(main, o.key, op);
    assert.equal(replay.status, 200);
    assert.equal((await holdOf(o.key)).attempt_count, 1);
    assert.equal(
      (await charge(main, o.key)).body.error,
      "kiosk_charge_pending",
    );
    const a = await attemptOf(o.key);
    assert.equal(a.target, "kiosk_hold");
    assert.equal(a.origin, "kiosk");
    assert.equal(a.session_id, null);
    assert.equal(a.device_id, ids.till);
    assert.equal(a.cash_session_id, ids.drawer);
    assert.equal(a.employee_id, ids.cashier, "the drawer opener");
    await drive(a.id, ["pending"]);
    fake.approve(fake.chargeFor(a.id)!.id, { ...TEST_CARD });
    // The worker reads approved and queues payments_settle; the kiosk syncs twice at the same time.
    await workerUntil(a.id, "approved");
    await noRetries("K9 settle race", () =>
      Promise.all([
        webRunner.drainTenant(A),
        sync(main, o.key),
        sync(main, o.key),
      ]),
    );
    while (webRunner.running() > 0) await sleep(10);
    const after = await attemptOf(o.key);
    assert.equal(after.state, "settled");
    const h = await holdOf(o.key);
    assert.equal(h.state, "accepted");
    assert.equal(h.decision_source, "kiosk");
    assert.equal(h.decided_by, ids.cashier);
    assert.equal(h.paid_at_accept, true);
    const counts = await one(
      A,
      (tx) => tx`select
        (select count(*)::int from orders where id=${h.order_id}) as orders,
        (select count(*)::int from tenders where order_id=${h.order_id}) as tenders,
        (select count(*)::int from fiscal_tickets where order_id=${h.order_id}) as tickets,
        (select session_id from tenders where order_id=${h.order_id} limit 1) as drawer,
        (select sum(amount)::int from tenders where order_id=${h.order_id}) as paid`,
    );
    assert.deepEqual(
      { ...counts },
      { orders: 1, tenders: 1, tickets: 1, drawer: ids.drawer, paid: 12500 },
    );
    const ord = await write(manager, (tx) => getOrder(tx, h.order_id));
    assert.equal(ord.mode, "dine_in");
    assert.equal(ord.channel, "kiosk");
    assert.match(ord.name, /^K-\d+ · Ana$/);
    const view = (await checkout(main, o.key)).body as KioskCheckoutView;
    assert.equal(view.paid, true);
    assert.equal(view.payment.state, "settled");
    assert.ok(view.folio);
    assert.equal(view.orderNumber, ord.number);
    const audit = await one(
      A,
      (tx) =>
        tx`select detail from audit where operation='public.hold_accepted' and entity_id=${h.id}`,
    );
    assert.deepEqual(audit.detail.via, { kind: "kiosk" });
    // The suggestion line kept its origin in the hold (report attribution).
    assert.equal(
      (h.lines as any[]).filter((l) => l.origin === "suggestion").length,
      1,
    );
  });

  await test("K10. decline: the hold stays pending; a retry is a new attempt, at most 3; Pagar en caja makes a normal inbox card that staff accept", async () => {
    const o = await order(main, [line(ids.taco)], 4500);
    for (let i = 0; i < 3; i++) {
      const c = await charge(main, o.key);
      assert.equal(c.status, 200, JSON.stringify(c.body));
      const a = await attemptOf(o.key);
      await drive(a.id, ["pending"]);
      fake.decline(fake.chargeFor(a.id)!.id);
      await drive(a.id, ["declined"]);
      const v = (await sync(main, o.key)).body as KioskCheckoutView;
      assert.equal(v.payment.state, "declined");
      assert.equal(v.holdState, "pending");
    }
    assert.equal(
      (await charge(main, o.key)).body.error,
      "kiosk_charge_attempts",
    );
    const counter = await call("POST", "/kiosk/counter", {
      link: main.link,
      tablet: main.tablet,
      body: { statusKey: o.key },
    });
    assert.equal(counter.status, 200);
    assert.equal(counter.body.paymentChoice, "counter");
    const h = await holdOf(o.key);
    const box = await write(cashier, (tx) => inbox(tx, cashier));
    const card = box.holds.find((x) => x.id === h.id)!;
    assert.equal(card.kiosk!.charging, false);
    assert.equal(card.kiosk!.paymentChoice, "counter");
    const accepted = await write(cashier, (tx) =>
      acceptHold(tx, cashier, h.id, {
        operationId: randomUUID(),
        target: { kind: "new" },
        payment: { method: "cash", amount: 4500, tip: 0, received: 5000 },
      }),
    );
    assert.equal(accepted.order.paid, 4500);
    assert.equal((await holdOf(o.key)).decision_source, "staff");
  });

  await test("K11/K12. a charge in progress blocks staff accept, reject and the diner's cancel (kiosk_charge_in_progress); timeout cancel withdraws; an uncancellable one stays pending and a late approval still creates the order", async () => {
    const o = await order(main, [line(ids.taco)], 4500);
    await charge(main, o.key);
    const a = await attemptOf(o.key);
    const h = await holdOf(o.key);
    await rejects(
      write(cashier, (tx) =>
        acceptHold(tx, cashier, h.id, {
          operationId: randomUUID(),
          target: { kind: "new" },
        }),
      ),
      "kiosk_charge_in_progress",
    );
    await rejects(
      write(cashier, (tx) =>
        rejectHold(tx, cashier, h.id, {
          operationId: randomUUID(),
          reason: "other",
        }),
      ),
      "kiosk_charge_in_progress",
    );
    const cancelOrder = await call("POST", "/kiosk/cancel", {
      link: main.link,
      tablet: main.tablet,
      body: { statusKey: o.key },
    });
    assert.equal(cancelOrder.body.error, "kiosk_charge_in_progress");
    assert.equal(
      (
        await call("POST", "/kiosk/counter", {
          link: main.link,
          tablet: main.tablet,
          body: { statusKey: o.key },
        })
      ).body.error,
      "kiosk_charge_pending",
    );
    const box = await write(cashier, (tx) => inbox(tx, cashier));
    assert.equal(box.holds.find((x) => x.id === h.id)!.kiosk!.charging, true);
    // The kiosk's timeout: the request was never sent (created) → withdrawn at once.
    const cancel = await call("POST", "/kiosk/charge/cancel", {
      link: main.link,
      tablet: main.tablet,
      body: { operationId: randomUUID(), statusKey: o.key },
    });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    assert.ok(["withdrawn", "pending_cancel"].includes(cancel.body.outcome));
    await drive(a.id, ["cancelled"]);
    // The next attempt reaches the reader and the reader keeps it: in progress, then a late approval.
    const c2 = await charge(main, o.key);
    assert.equal(c2.status, 200, JSON.stringify(c2.body));
    const a2 = await attemptOf(o.key);
    await drive(a2.id, ["pending"]);
    fake.atTerminalUncancellable(fake.chargeFor(a2.id)!.id);
    const cancel2 = await call("POST", "/kiosk/charge/cancel", {
      link: main.link,
      tablet: main.tablet,
      body: { operationId: randomUUID(), statusKey: o.key },
    });
    assert.equal(cancel2.status, 200);
    for (let i = 0; i < 4; i++) await round(A);
    const still = (await sync(main, o.key)).body as KioskCheckoutView;
    assert.equal(still.payment.state, "pending", "the reader still holds it");
    // The kiosk resets; the guest pays on the reader later: the order is created anyway.
    fake.approve(fake.chargeFor(a2.id)!.id, { ...TEST_CARD });
    await drive(a2.id, ["settled"]);
    assert.equal((await holdOf(o.key)).state, "accepted");
    // A manager's "Cancelar cobro en curso" on another hold withdraws a created attempt.
    const o3 = await order(main, [line(ids.agua, 2)], 600);
    await charge(main, o3.key);
    const a3 = await attemptOf(o3.key);
    const v = await write(manager, (tx) =>
      requestCancel(tx, manager, a3.id, { operationId: randomUUID() }),
    );
    assert.equal(v.state, "cancelled");
  });

  await test("K13. approved but the product was 86'd: review with kiosk_settle_unavailable, a red card first in the inbox, the drawer cannot close; an operator retry after the product is back creates the order; reject and refund needs the provider refund recorded first", async () => {
    const o = await order(main, [line(ids.papas)], 3500);
    await charge(main, o.key);
    const a = await attemptOf(o.key);
    await drive(a.id, ["pending"]);
    await setAvailable(ids.papas, false);
    fake.approve(fake.chargeFor(a.id)!.id, { ...TEST_CARD });
    await drive(a.id, ["review"]);
    const r = await attemptOf(o.key);
    assert.equal(r.error_code, "kiosk_settle_unavailable");
    assert.equal(r.order_id, null);
    assert.equal(r.tender_id, null);
    const h = await holdOf(o.key);
    assert.equal(h.state, "pending");
    const view = (await checkout(main, o.key)).body as KioskCheckoutView;
    assert.equal(view.paidNoOrder, true);
    const box = await write(cashier, (tx) => inbox(tx, cashier));
    assert.equal(box.holds[0].id, h.id, "the red card sorts first");
    assert.equal(box.holds[0].kiosk!.review!.code, "kiosk_settle_unavailable");
    assert.equal(box.holds[0].kiosk!.review!.amount, 3500);
    await rejects(
      write(manager, (tx) =>
        closeCash(tx, manager, {
          operationId: randomUUID(),
          counted: 100000,
          reason: "Corte de prueba",
        }),
      ),
      "payments_attempt_unresolved",
    );
    // Retry while still 86'd: refused, still review.
    await rejects(
      write(cashier, (tx) =>
        resolveAttempt(tx, cashier, a.id, {
          operationId: randomUUID(),
          outcome: "retry",
        }),
      ),
      /kiosk_settle_unavailable|unavailable/,
    );
    await setAvailable(ids.papas, true);
    const done = await write(cashier, (tx) =>
      resolveAttempt(tx, cashier, a.id, {
        operationId: randomUUID(),
        outcome: "retry",
      }),
    );
    assert.equal(done.attempt.state, "settled");
    const h2 = await holdOf(o.key);
    assert.equal(h2.state, "accepted");
    assert.equal(h2.decision_source, "kiosk");
    // A price that changed between the start and the approval is a review too.
    const op = await order(main, [line(ids.agua, 2)], 600);
    await charge(main, op.key);
    const ap = await attemptOf(op.key);
    await drive(ap.id, ["pending"]);
    await asOwner(
      A,
      (tx) =>
        tx`update catalog set data=jsonb_set(data,'{price}','350') where id=${ids.agua}`,
    );
    fake.approve(fake.chargeFor(ap.id)!.id, { ...TEST_CARD });
    await drive(ap.id, ["review"]);
    assert.equal(
      (await attemptOf(op.key)).error_code,
      "kiosk_settle_price_changed",
    );
    assert.equal((await holdOf(op.key)).state, "pending");
    await asOwner(
      A,
      (tx) =>
        tx`update catalog set data=jsonb_set(data,'{price}','300') where id=${ids.agua}`,
    );
    await write(cashier, (tx) =>
      resolveAttempt(tx, cashier, ap.id, {
        operationId: randomUUID(),
        outcome: "retry",
      }),
    );
    assert.equal((await attemptOf(op.key)).state, "settled");
    // (c) Another 86: the manager records the provider refund, then rejects the hold.
    const o2 = await order(main, [line(ids.papas)], 3500);
    await charge(main, o2.key);
    const b = await attemptOf(o2.key);
    await drive(b.id, ["pending"]);
    await setAvailable(ids.papas, false);
    fake.approve(fake.chargeFor(b.id)!.id, { ...TEST_CARD });
    await drive(b.id, ["review"]);
    const hb = await holdOf(o2.key);
    await rejects(
      write(cashier, (tx) =>
        rejectHold(tx, cashier, hb.id, {
          operationId: randomUUID(),
          reason: "unavailable",
        }),
      ),
      "kiosk_charge_in_progress",
    );
    await write(manager, (tx) =>
      resolveAttempt(tx, manager, b.id, {
        operationId: randomUUID(),
        outcome: "refunded_at_provider",
        note: "Reembolso completo hecho en la app de Clip",
        confirmed: true,
      }),
    );
    await write(cashier, (tx) =>
      rejectHold(tx, cashier, hb.id, {
        operationId: randomUUID(),
        reason: "unavailable",
      }),
    );
    assert.equal((await holdOf(o2.key)).state, "rejected");
    await setAvailable(ids.papas, true);
  });

  await test("K14. a price changed after the order: the charge start answers public_price_changed and the hold is unchanged", async () => {
    const o = await order(main, [line(ids.agua)], 300);
    await asOwner(
      A,
      (tx) =>
        tx`update catalog set data=jsonb_set(data,'{price}','400') where id=${ids.agua}`,
    );
    const c = await charge(main, o.key);
    assert.equal(c.status, 409);
    assert.equal(c.body.error, "public_price_changed");
    const h = await holdOf(o.key);
    assert.equal(h.attempt_count, 0);
    assert.equal(h.state, "pending");
    await asOwner(
      A,
      (tx) =>
        tx`update catalog set data=jsonb_set(data,'{price}','300') where id=${ids.agua}`,
    );
    // Below the provider minimum on MP, unavailable on a manual terminal.
    const mp = await newKiosk("MP " + run);
    await configure(mp, terminals.mp);
    await pair(mp);
    const small = await order(mp, [line(ids.agua)], 300);
    assert.equal(
      (await charge(mp, small.key)).body.error,
      "kiosk_amount_below_min",
    );
    const manual = await newKiosk("Manual " + run);
    await configure(manual, terminals.manual);
    await pair(manual);
    const st = await call("GET", "/kiosk/state", {
      link: manual.link,
      tablet: manual.tablet,
    });
    assert.equal(
      st.body.card,
      false,
      "a manual terminal is not a kiosk card reader (critic R14)",
    );
    const m = await order(manual, [line(ids.taco)], 4500);
    assert.equal(m.counterOnly, "no_terminal");
    assert.equal(
      (await charge(manual, m.key)).body.error,
      "kiosk_card_unavailable",
    );
  });

  await test("K15/K20. the kiosk switch off: card refused, counter only, while an approved charge still settles (the job path never reads either switch); a live kiosk charge blocks the drawer close", async () => {
    const o = await order(main, [line(ids.taco)], 4500);
    await charge(main, o.key);
    const a = await attemptOf(o.key);
    await drive(a.id, ["pending"]);
    process.env.KIOSK_SELF_CHECKOUT_ENABLED = "false";
    const st = await call("GET", "/kiosk/state", {
      link: main.link,
      tablet: main.tablet,
    });
    assert.equal(st.body.selfCheckout, false);
    const o2 = await order(main, [line(ids.taco)], 4500);
    assert.equal(o2.counterOnly, "disabled");
    assert.equal(
      (await charge(main, o2.key)).body.error,
      "kiosk_card_unavailable",
    );
    fake.approve(fake.chargeFor(a.id)!.id, { ...TEST_CARD });
    await drive(a.id, ["settled"]);
    delete process.env.KIOSK_SELF_CHECKOUT_ENABLED;
    // A drawer close with a live kiosk charge is refused (payments P-5 covers hold targets).
    const o3 = await order(main, [line(ids.taco)], 4500);
    await charge(main, o3.key);
    await rejects(
      write(manager, (tx) =>
        closeCash(tx, manager, {
          operationId: randomUUID(),
          counted: 100000,
          reason: "Corte de prueba",
        }),
      ),
      "payments_attempt_unresolved",
    );
    const a3 = await attemptOf(o3.key);
    await write(manager, (tx) =>
      requestCancel(tx, manager, a3.id, { operationId: randomUUID() }),
    );
    await drive(a3.id, ["cancelled"]);
  });

  await test("K-zero. a till without an open drawer: counter only (till_closed); a zero total with self-checkout: the kiosk accepts it itself (no charge)", async () => {
    const k = await newKiosk("Gratis " + run);
    await configure(k, terminals.clip, ids.till2);
    await pair(k);
    const closed = await order(k, [line(ids.taco)], 4500);
    assert.equal(closed.counterOnly, "till_closed");
    assert.equal(
      (await charge(k, closed.key)).body.error,
      "kiosk_card_unavailable",
    );
    const free0 = await order(k, [line(ids.gratis)], 0);
    assert.equal(
      (await holdOf(free0.key)).state,
      "pending",
      "no open till: no kiosk accept",
    );
    await configure(k, terminals.clip, ids.till);
    const o = await order(k, [line(ids.gratis)], 0);
    const h = await holdOf(o.key);
    assert.equal(h.state, "accepted");
    assert.equal(h.decision_source, "kiosk");
    assert.equal(o.checkout.holdState, "accepted");
    assert.equal(o.checkout.paid, true);
  });

  await test("K-settings. settings view and saves: managers only; versions; station terminal and till", async () => {
    const v = await write(manager, (tx) => kioskSettingsView(tx, manager));
    assert.equal(v.settings.paymentMode, "card_and_counter");
    const st = v.stations.find((x) => x.id === main.stationId)!;
    assert.equal(st.terminalId, terminals.clip);
    assert.equal(st.registerDeviceId, ids.till);
    assert.equal(st.tillOpen, true);
    assert.equal(st.device!.state, "paired");
    await rejects(
      write(cashier, (tx) => kioskSettingsView(tx, cashier)),
      "forbidden",
    );
    await rejects(
      write(manager, (tx) =>
        saveKioskSettings(tx, manager, {
          operationId: randomUUID(),
          expectedVersion: 0,
          paymentMode: "counter",
          askFulfillment: true,
          suggestions: true,
          loyaltyAtKiosk: false,
        }),
      ),
      "kiosk_settings_changed",
    );
    await rejects(
      write(manager, (tx) =>
        saveSuggestions(tx, manager, ids.taco, {
          operationId: randomUUID(),
          expectedVersion: 0,
          productIds: [ids.taco],
        }),
      ),
      "invalid_input",
    );
  });

  // Tenant B never sees A's kiosk rows.
  await test("K-tenancy. another restaurant's session reads none of A's kiosk rows", async () => {
    const rows = await write(
      ownerB,
      (tx) => tx`select
      (select count(*)::int from kiosk_stations) as stations,
      (select count(*)::int from kiosk_checkouts) as checkouts,
      (select count(*)::int from kiosk_devices) as devices`,
    );
    assert.deepEqual({ ...rows[0] }, { stations: 0, checkouts: 0, devices: 0 });
  });

  await test("K16. club at the kiosk: lookup by phone never creates and shows no name; 5 lookups per device per 5 minutes; the member token rides on the checkout and the settle links the order before the tender; stamps on the done screen; a join offer for non-members; retention blanks the reference at 30 days", async () => {
    const LEGAL = legalConfig(LEGAL_CI_ENV);
    const v = (await write(owner, (tx) =>
      getLoyaltySettings(tx, owner, LEGAL),
    )) as LoyaltySettingsView;
    await write(owner, (tx) =>
      saveLoyaltySettings(
        tx,
        owner,
        {
          operationId: randomUUID(),
          expectedVersion: v.version,
          enabled: true,
          programName: "",
          stampsRequired: 10,
          stampThreshold: 0,
          maxStampsPerOrder: null,
          rewardKind: "item",
          rewardDescription: "Un producto gratis",
          rewardAmount: null,
          rewardMaxAmount: 15000,
          maxRewardsPerOrder: 1,
          promptAtCheckout: true,
          receiptJoinQr: true,
          linkWindowDays: 7,
          privacyAttested: true,
        },
        LEGAL,
      ),
    );
    const member = (
      await write(cashier, (tx) =>
        enrollMember(tx, cashier, {
          operationId: randomUUID(),
          phone: "5555550123",
          country: "MX",
          name: "Ana Ficticia",
          consent: true,
          marketingOptIn: false,
        }),
      )
    ).member;
    const k = await newKiosk("Club " + run);
    await configure(k, terminals.clip);
    await pair(k);
    // Off at the kiosk until the setting is on.
    const off = await call("POST", "/kiosk/member", {
      link: k.link,
      tablet: k.tablet,
      body: { phone: "5555550123" },
    });
    assert.equal(off.body.error, "loyalty_disabled");
    const sv = await one(
      A,
      (tx) => tx`select version from kiosk_settings where tenant_id=${A}`,
    );
    await write(manager, (tx) =>
      saveKioskSettings(tx, manager, {
        operationId: randomUUID(),
        expectedVersion: sv.version,
        paymentMode: "card_and_counter",
        askFulfillment: true,
        suggestions: true,
        loyaltyAtKiosk: true,
      }),
    );
    const membersBefore = (
      await one(
        A,
        (tx) =>
          tx`select count(*)::int as n from loyalty_members where tenant_id=${A}`,
      )
    ).n;
    const ip = "203.0.113.77";
    const found = await call("POST", "/kiosk/member", {
      link: k.link,
      tablet: k.tablet,
      ip,
      body: { phone: "5555550123" },
    });
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.equal(found.body.found, true);
    assert.equal(found.body.stamps, 0);
    assert.equal(found.body.required, 10);
    assert.ok(
      !JSON.stringify(found.body).includes("Ana"),
      "no name at the kiosk (R21)",
    );
    assert.ok(
      !JSON.stringify(found.body).includes("5555550123"),
      "the phone is masked",
    );
    const missing = await call("POST", "/kiosk/member", {
      link: k.link,
      tablet: k.tablet,
      ip,
      body: { phone: "5555550199" },
    });
    assert.deepEqual(missing.body, { found: false });
    assert.equal(
      (
        await one(
          A,
          (tx) =>
            tx`select count(*)::int as n from loyalty_members where tenant_id=${A}`,
        )
      ).n,
      membersBefore,
      "a lookup never creates",
    );
    for (let i = 0; i < 3; i++)
      await call("POST", "/kiosk/member", {
        link: k.link,
        tablet: k.tablet,
        ip,
        body: { phone: "5555550199" },
      });
    const limited = await call("POST", "/kiosk/member", {
      link: k.link,
      tablet: k.tablet,
      ip,
      body: { phone: "5555550199" },
    });
    assert.equal(
      limited.status,
      429,
      "the sixth lookup in 5 minutes from one device",
    );
    // The token is bound to this station: another kiosk's order drops it.
    const o = await order(k, [line(ids.taco, 2)], 9000, {
      memberToken: found.body.memberToken,
    });
    assert.equal((await holdOf(o.key)).loyalty_member_id, member.id);
    const otherKiosk = await newKiosk("Club2 " + run);
    await configure(otherKiosk, terminals.clip);
    await pair(otherKiosk);
    const other = await order(otherKiosk, [line(ids.taco)], 4500, {
      memberToken: found.body.memberToken,
    });
    assert.equal((await holdOf(other.key)).loyalty_member_id, null);
    await charge(k, o.key);
    const a = await attemptOf(o.key);
    await drive(a.id, ["pending"]);
    fake.approve(fake.chargeFor(a.id)!.id, { ...TEST_CARD });
    await drive(a.id, ["settled"]);
    const h = await holdOf(o.key);
    const link = await one(
      A,
      (tx) =>
        tx`select member_id,via from loyalty_order_links where order_id=${h.order_id}`,
    );
    assert.deepEqual({ ...link }, { member_id: member.id, via: "kiosk" });
    const done = (await sync(k, o.key)).body as KioskCheckoutView;
    assert.equal(done.loyalty!.member, true);
    assert.equal(done.loyalty!.stampsEarned, 1);
    assert.equal(done.loyalty!.stamps, 1);
    assert.equal(done.joinOffer, null);
    // A non-member's paid order offers the join QR.
    const o2 = await order(k, [line(ids.taco)], 4500);
    await charge(k, o2.key);
    const a2 = await attemptOf(o2.key);
    await drive(a2.id, ["pending"]);
    fake.approve(fake.chargeFor(a2.id)!.id, { ...TEST_CARD });
    await drive(a2.id, ["settled"]);
    const done2 = (await sync(k, o2.key)).body as KioskCheckoutView;
    assert.equal(done2.loyalty, null);
    assert.match(done2.joinOffer!.url, /\/club#/);
    // Retention: the member reference is blanked 30 days after the checkout, nothing else changes.
    await admin.begin(async (tx) => {
      await tx`alter table kiosk_checkouts disable trigger kiosk_checkouts_transition`;
      await tx`update kiosk_checkouts set created_at=now()-interval '31 days' where hold_id=${h.id}`;
      await tx`alter table kiosk_checkouts enable trigger kiosk_checkouts_transition`;
    });
    await runRetention(admin, { pauseMs: 0 });
    const after = await one(
      A,
      (tx) =>
        tx`select loyalty_member_id,attempt_id from kiosk_checkouts where hold_id=${h.id}`,
    );
    assert.equal(after.loyalty_member_id, null);
    assert.equal(after.attempt_id, a.id);
    assert.equal(
      (
        await one(
          A,
          (tx) =>
            tx`select member_id from loyalty_order_links where order_id=${h.order_id}`,
        )
      ).member_id,
      member.id,
      "loyalty keeps its own link under its own rule",
    );
  });

  await test("K17. photos: upload (fs store) → ready asset → the product's image → revision bump → the diner catalog; served immutable, nosniff, sandboxed, same-origin; removal 404s at once; purge at 7 days; a half-done upload is swept; another tenant's id is 404", async () => {
    const before = (
      await one(
        A,
        (tx) => tx`select revision from menu_state where tenant_id=${A}`,
      )
    ).revision;
    const uploadOp = randomUUID();
    const r = await uploadProductImage(
      sql,
      owner,
      { operationId: uploadOp, productId: ids.taco },
      uploadBody(1600, 1200, { metadata: true }),
    );
    assert.equal(r.image!.w, 1200);
    const m = await one(
      A,
      (tx) =>
        tx`select state,width,height,variants from menu_media where id=${r.image!.id}`,
    );
    assert.equal(m.state, "ready");
    assert.deepEqual(Object.keys(m.variants).sort(), ["card", "hero", "thumb"]);
    assert.ok(
      Number(
        (
          await one(
            A,
            (tx) => tx`select revision from menu_state where tenant_id=${A}`,
          )
        ).revision,
      ) > Number(before),
    );
    const menu = await call("GET", "/menu", { link: main.link });
    const taco = menu.body.catalog.find((p: any) => p.id === ids.taco);
    assert.deepEqual(taco.image, { id: r.image!.id, w: 1200, h: 900 });
    // A replay of the operation id answers the first result (no second asset).
    const assets = (
      await one(
        A,
        (tx) =>
          tx`select count(*)::int as n from menu_media where tenant_id=${A}`,
      )
    ).n;
    const same = await uploadProductImage(
      sql,
      owner,
      { operationId: uploadOp, productId: ids.taco },
      uploadBody(1600, 1200),
    );
    assert.equal(same.image!.id, r.image!.id);
    assert.equal(
      (
        await one(
          A,
          (tx) =>
            tx`select count(*)::int as n from menu_media where tenant_id=${A}`,
        )
      ).n,
      assets,
    );
    // Served: headers and bytes without metadata.
    const res = await fetch(`${origin}/media/${r.image!.id}/hero.webp`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/webp");
    assert.equal(
      res.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      res.headers.get("content-security-policy"),
      "default-src 'none'; sandbox",
    );
    assert.equal(
      res.headers.get("cross-origin-resource-policy"),
      "same-origin",
    );
    assert.equal(res.headers.get("etag"), `"${m.variants.hero.sha256}"`);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(
      !bytes.includes(Buffer.from("GPS")),
      "no EXIF/GPS in what is served",
    );
    assert.equal(
      (
        await fetch(`${origin}/media/${r.image!.id}/hero.webp`, {
          headers: { "if-none-match": `"${m.variants.hero.sha256}"` },
        })
      ).status,
      304,
    );
    assert.equal(
      (await fetch(`${origin}/media/${r.image!.id}/huge.webp`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${origin}/media/${randomUUID()}/hero.webp`)).status,
      404,
    );
    // Staff only; managers and owners.
    await rejects(
      uploadProductImage(
        sql,
        cashier,
        { operationId: randomUUID(), productId: ids.taco },
        uploadBody(400, 300),
      ),
      "forbidden",
    );
    await rejects(
      uploadProductImage(
        sql,
        owner,
        { operationId: randomUUID(), productId: ids.taco },
        Buffer.from("not an image"),
      ),
      /media_/,
    );
    // Removal: 404 at once, purge 7 days later.
    const doc = await one(
      A,
      (tx) =>
        tx`select (data->>'version')::int as v from catalog where id=${ids.taco}`,
    );
    await write(manager, (tx) =>
      removeProductImage(tx, manager, ids.taco, {
        operationId: randomUUID(),
        expectedVersion: doc.v,
      }),
    );
    assert.equal(
      (await fetch(`${origin}/media/${r.image!.id}/hero.webp`)).status,
      404,
    );
    assert.equal(
      (await call("GET", "/menu", { link: main.link })).body.catalog.find(
        (p: any) => p.id === ids.taco,
      ).image,
      undefined,
    );
    await webRunner.drainTenant(A);
    assert.equal(
      (
        await one(
          A,
          (tx) => tx`select state from menu_media where id=${r.image!.id}`,
        )
      ).state,
      "deleted",
      "not before 7 days",
    );
    await admin.begin(async (tx) => {
      await tx`alter table menu_media disable trigger menu_media_transition`;
      await tx`update menu_media set deleted_at=now()-interval '8 days' where id=${r.image!.id}`;
      await tx`alter table menu_media enable trigger menu_media_transition`;
    });
    await admin`update jobs set next_at=now() where tenant_id=${A} and kind='media_purge'`;
    await webRunner.drainTenant(A);
    while (webRunner.running() > 0) await sleep(10);
    assert.equal(
      (
        await one(
          A,
          (tx) => tx`select state from menu_media where id=${r.image!.id}`,
        )
      ).state,
      "purged",
    );
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(
      await readdir(join(mediaRoot, "m", A, r.image!.id)).catch(() => []),
      [],
    );
    // A half-done upload (tx A only) is swept after an hour.
    const stale = randomUUID();
    await asOwner(
      A,
      (tx) =>
        tx`insert into menu_media(tenant_id,id,created_by) values(${A},${stale},${ids.owner})`,
    );
    await asOwner(
      A,
      (
        tx,
      ) => tx`insert into jobs(tenant_id,id,kind,dedupe_key,payload,state,next_at)
      values(${A},${randomUUID()},'media_stale',${stale},${tx.json({ assetId: stale })},'available',now())`,
    );
    await webRunner.drainTenant(A);
    while (webRunner.running() > 0) await sleep(10);
    assert.equal(
      (await one(A, (tx) => tx`select state from menu_media where id=${stale}`))
        .state,
      "purged",
    );
    // MENU_PHOTOS_ENABLED=false: no photos anywhere.
    const r2 = await uploadProductImage(
      sql,
      owner,
      { operationId: randomUUID(), productId: ids.agua },
      uploadBody(400, 300),
    );
    process.env.MENU_PHOTOS_ENABLED = "false";
    assert.equal(
      (await fetch(`${origin}/media/${r2.image!.id}/thumb.webp`)).status,
      404,
    );
    assert.equal(
      (await call("GET", "/menu", { link: main.link })).body.catalog.find(
        (p: any) => p.id === ids.agua,
      ).image,
      undefined,
    );
    await rejects(
      uploadProductImage(
        sql,
        owner,
        { operationId: randomUUID(), productId: ids.agua },
        uploadBody(400, 300),
      ),
      "media_disabled",
    );
    delete process.env.MENU_PHOTOS_ENABLED;
    // Another tenant cannot attach to A's product nor read A's asset by id with its session.
    await rejects(
      uploadProductImage(
        sql,
        ownerB,
        { operationId: randomUUID(), productId: ids.taco },
        uploadBody(400, 300),
      ),
      "not_found",
    );
    assert.equal(
      (await write(ownerB, (tx) => tx`select id from menu_media`)).length,
      0,
    );
  });

  await test("K18. suggestions: product and cart sets are replaced by UPDATE (never deleted); the kiosk reads only sellable products", async () => {
    const save = (
      source: string | null,
      productIds: string[],
      expectedVersion: number,
    ) =>
      write(manager, (tx) =>
        saveSuggestions(tx, manager, source, {
          operationId: randomUUID(),
          expectedVersion,
          productIds,
        }),
      );
    const p1 = await save(ids.taco, [ids.papas, ids.agua], 0);
    assert.equal(p1.version, 1);
    await rejects(save(ids.taco, [ids.papas], 0), "menu_changed");
    await save(ids.taco, [ids.agua, ids.papas], 1);
    await save(null, [ids.papas, ids.agua, ids.gratis], 0);
    await rejects(
      save(
        ids.taco,
        [ids.agua, ids.papas, ids.gratis, ids.taco, randomUUID()],
        2,
      ),
      "invalid_input",
    );
    await setAvailable(ids.agua, false);
    const st = await call("GET", "/kiosk/state", {
      link: main.link,
      tablet: main.tablet,
    });
    assert.deepEqual(st.body.suggestions.byProduct[ids.taco], [ids.papas]);
    assert.deepEqual(st.body.suggestions.cart, [ids.papas, ids.gratis]);
    assert.deepEqual(
      st.body.suggestions.popular,
      [],
      "curated cart set: no popular fallback",
    );
    await setAvailable(ids.agua, true);
    const rows = await one(
      A,
      (tx) =>
        tx`select count(*)::int as n from menu_suggestions where tenant_id=${A}`,
    );
    assert.equal(rows.n, 2, "one row per product set plus the cart row");
  });

  await test("K19. malformed link tokens cost no database work and have their own bucket; a non-kiosk link is not a kiosk", async () => {
    const r = await call("GET", "/kiosk/state", { link: "not-a-token" });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "public_link_invalid");
    const counter = await write(manager, (tx) =>
      createLink(tx, manager, { kind: "counter", label: "Barra " + run }),
    );
    assert.equal(
      (await call("GET", "/kiosk/state", { link: counter.token })).body.error,
      "public_link_invalid",
    );
  });

  await test("K23. burst under noRetries: kiosk settles, staff accepts and rejects, a link rotation and drawer reads run together without a deadlock or a retry", async () => {
    const k = await newKiosk("Burst " + run);
    await configure(k, terminals.mp);
    await pair(k);
    const k2 = await newKiosk("Burst2 " + run);
    await configure(k2, terminals.clip);
    await pair(k2);
    const paid = [];
    for (const kk of [k, k2]) {
      const o = await order(kk, [line(ids.taco, 2)], 9000);
      await charge(kk, o.key);
      const a = await attemptOf(o.key);
      await drive(a.id, ["pending"]);
      fake.approve(fake.chargeFor(a.id)!.id, { ...TEST_CARD });
      await workerUntil(a.id, "approved");
      paid.push({ kk, o, a });
    }
    const counterHolds = [];
    for (let i = 0; i < 4; i++) {
      const o = await order(k, [line(ids.agua)], 300);
      await call("POST", "/kiosk/counter", {
        link: k.link,
        tablet: k.tablet,
        body: { statusKey: o.key },
      });
      counterHolds.push((await holdOf(o.key)).id);
    }
    await noRetries("K23 burst", () =>
      Promise.all([
        ...paid.map((p) => sync(p.kk, p.o.key)),
        webRunner.drainTenant(A),
        ...counterHolds.slice(0, 2).map((id) =>
          write(cashier, (tx) =>
            acceptHold(tx, cashier, id, {
              operationId: randomUUID(),
              target: { kind: "new" },
              payment: { method: "cash", amount: 300, tip: 0, received: 300 },
            }),
          ),
        ),
        ...counterHolds.slice(2).map((id) =>
          write(cashier, (tx) =>
            rejectHold(tx, cashier, id, {
              operationId: randomUUID(),
              reason: "other",
            }),
          ),
        ),
        write(manager, (tx) => rotateLink(tx, manager, k2.linkId)),
        write(cashier, (tx) => inbox(tx, cashier)),
      ]),
    );
    while (webRunner.running() > 0) await sleep(10);
    for (const p of paid)
      assert.equal((await attemptOf(p.o.key)).state, "settled");
    const tickets = await one(
      A,
      (tx) =>
        tx`select count(*)::int as n, count(distinct order_id)::int as d from fiscal_tickets where tenant_id=${A}`,
    );
    assert.equal(tickets.n, tickets.d, "one ticket per order");
  });

  await test("K-report. Finanzas › Kiosco: orders by where they were paid, charges approved without an order and how they ended, accepted suggestion lines", async () => {
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: restaurant.timezone,
    }).format(new Date(Date.now() - restaurant.cutoff * 60_000));
    const r = await write(manager, (tx) =>
      kioskReport(tx, manager, { from: day, to: day }),
    );
    const counts = await one(
      A,
      (tx) => tx`select
        count(*) filter (where state='accepted' and decision_source='kiosk')::int as kiosk,
        count(*) filter (where state='accepted' and decision_source='staff')::int as staff
      from public_order_holds where tenant_id=${A} and channel='kiosk'`,
    );
    assert.equal(r.paidAtKiosk, counts.kiosk);
    assert.equal(r.paidAtCounter, counts.staff);
    assert.equal(r.orders, counts.kiosk + counts.staff);
    assert.ok(r.paidAtKiosk >= 8);
    assert.equal(r.suggestions.lines, 1, "K9's suggested papas");
    assert.equal(r.suggestions.amount, 3500);
    assert.equal(r.review.refunded, 1);
    assert.equal(r.review.refundedAmount, 3500);
    assert.ok(r.review.resolved >= 3, "two retries and one refund");
    await rejects(
      write(cashier, (tx) => kioskReport(tx, cashier, { from: day, to: day })),
      "forbidden",
    );
  });

  await test("K24. R13 amount mismatches: a total above the charge collects the exact rest in the same accept (manager, recent PIN, the charge as its card tender); a total below it is refused until lines are restored, or «Rechazar y reembolsar» rejects the hold and records the provider refund; the operator retry needs no PIN and works long after the hold expired", async () => {
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const staleManager = session(A, ids.manager, "manager", ids.till, {
      authenticatedAt: hourAgo,
    });
    const staleCashier = session(A, ids.cashier, "cashier", ids.till, {
      authenticatedAt: hourAgo,
    });
    const NOTE = "Cobro revisado en la app del proveedor";
    // Its own kiosk (the main link's per-window order cap is spent by now), on the Clip reader.
    const desk = await newKiosk("Resolver " + run);
    await configure(desk, terminals.clip);
    await pair(desk);
    /** An approved kiosk charge left in review: the hold, its attempt and the review code. */
    async function inReview(
      lines: ReturnType<typeof line>[],
      total: number,
      breakIt: () => Promise<unknown>,
    ) {
      const o = await order(desk, lines, total);
      assert.equal((await charge(desk, o.key)).status, 200);
      const a = await attemptOf(o.key);
      await drive(a.id, ["pending"]);
      await breakIt();
      fake.approve(fake.chargeFor(a.id)!.id, { ...TEST_CARD });
      await drive(a.id, ["review"]);
      return { key: o.key, hold: await holdOf(o.key), attemptId: a.id };
    }
    const setPrice = (productId: string, price: number) =>
      asOwner(
        A,
        (tx) =>
          tx`update catalog set data=jsonb_set(data,'{price}',to_jsonb(${price}::int)) where id=${productId}`,
      );
    const accept = (
      s: Session,
      holdId: string,
      body: Record<string, unknown>,
    ) =>
      write(s, (tx) =>
        acceptHold(tx, s, holdId, {
          target: { kind: "new" },
          ...body,
        }),
      );
    async function untouched(key: string, attemptId: string) {
      const h = await holdOf(key);
      assert.equal(h.state, "pending");
      assert.equal(h.order_id, null);
      const a = await one(
        A,
        (tx) =>
          tx`select state,tender_id,order_id from payment_attempts where id=${attemptId}`,
      );
      assert.deepEqual(
        { ...a },
        { state: "review", tender_id: null, order_id: null },
      );
    }

    // (a) Total above the charge: the price rose between the start and the approval.
    const up = await inReview([line(ids.agua, 2)], 600, () =>
      setPrice(ids.agua, 350),
    );
    assert.equal(
      (await attemptOf(up.key)).error_code,
      "kiosk_settle_price_changed",
    );
    const cashRest = { amount: 100, tip: 0, received: 200, method: "cash" };
    const withCharge = (rest: unknown) => ({
      method: "attempt",
      attemptId: up.attemptId,
      note: NOTE,
      rest,
    });
    await rejects(
      accept(cashier, up.hold.id, {
        operationId: randomUUID(),
        acknowledgedTotal: 700,
        payment: withCharge(cashRest),
      }),
      "forbidden",
    );
    await rejects(
      accept(staleManager, up.hold.id, {
        operationId: randomUUID(),
        acknowledgedTotal: 700,
        payment: withCharge(cashRest),
      }),
      "step_up_required",
    );
    for (const rest of [null, { ...cashRest, amount: 50, received: 50 }])
      await rejects(
        accept(manager, up.hold.id, {
          operationId: randomUUID(),
          acknowledgedTotal: 700,
          payment: withCharge(rest),
        }),
        "public_payment_must_cover_total",
      );
    // The new total must be acknowledged, as on any card (MONEY-1).
    await rejects(
      accept(manager, up.hold.id, {
        operationId: randomUUID(),
        payment: withCharge(cashRest),
      }),
      "public_hold_price_changed",
    );
    await untouched(up.key, up.attemptId);
    const op = randomUUID();
    const body = {
      operationId: op,
      acknowledgedTotal: 700,
      payment: withCharge(cashRest),
    };
    const done = await accept(manager, up.hold.id, body);
    assert.equal(done.order.total, 700);
    assert.equal(done.order.paid, 700);
    const replay = await accept(manager, up.hold.id, body);
    assert.equal(replay.order.id, done.order.id, "the accept's key replays it");
    const ha = await holdOf(up.key);
    assert.equal(ha.state, "accepted");
    assert.equal(ha.decision_source, "staff");
    assert.equal(ha.decided_by, ids.manager);
    assert.equal(ha.paid_at_accept, true);
    assert.equal(ha.accepted_total, 700);
    const tenders = await asOwner(
      A,
      (
        tx,
      ) => tx`select method,amount,tip,received,session_id,attempt_id,provider,card_last4
        from tenders where order_id=${done.order.id} order by amount desc`,
    );
    assert.deepEqual(
      tenders.map((t: any) => ({ ...t })),
      [
        {
          method: "external",
          amount: 600,
          tip: 0,
          received: 600,
          session_id: ids.drawer,
          attempt_id: up.attemptId,
          provider: (await attemptOf(up.key)).provider,
          card_last4: "4242",
        },
        {
          method: "cash",
          amount: 100,
          tip: 0,
          received: 200,
          session_id: ids.drawer,
          attempt_id: null,
          provider: null,
          card_last4: null,
        },
      ],
    );
    const settled = await attemptOf(up.key);
    assert.equal(settled.state, "settled");
    assert.equal(settled.order_id, done.order.id);
    assert.equal(settled.resolution, "recorded");
    assert.equal(settled.resolution_note, NOTE);
    assert.equal(settled.resolved_by, ids.manager);
    await setPrice(ids.agua, 300);

    // (b) Total below the charge: an 86'd line left out is refused (no partial refund);
    // restoring it so the total equals the charge accepts with the charge alone.
    const down = await inReview([line(ids.taco), line(ids.agua)], 4800, () =>
      setAvailable(ids.agua, false),
    );
    const agua = (down.hold.lines as { id: string; productId: string }[]).find(
      (l) => l.productId === ids.agua,
    )!;
    for (const rest of [null, cashRest])
      await rejects(
        accept(manager, down.hold.id, {
          operationId: randomUUID(),
          excludeLineIds: [agua.id],
          acknowledgedTotal: 4500,
          payment: {
            method: "attempt",
            attemptId: down.attemptId,
            note: NOTE,
            rest,
          },
        }),
        "kiosk_charge_above_total",
      );
    await untouched(down.key, down.attemptId);
    await setAvailable(ids.agua, true);
    const restored = await accept(manager, down.hold.id, {
      operationId: randomUUID(),
      payment: { method: "attempt", attemptId: down.attemptId, note: NOTE },
    });
    assert.equal(restored.order.total, 4800);
    assert.equal(restored.order.paid, 4800);
    assert.equal(
      (
        await one(
          A,
          (tx) =>
            tx`select count(*)::int as n,sum(amount)::int as paid from tenders where order_id=${restored.order.id}`,
        )
      ).n,
      1,
    );

    // (c) «Rechazar y reembolsar»: managers with a recent PIN and a note; the hold is rejected
    // and the charge dismissed as refunded at the provider, in one transaction.
    const gone = await inReview([line(ids.papas)], 3500, () =>
      setAvailable(ids.papas, false),
    );
    const reject = (s: Session, refund: Record<string, unknown>) =>
      write(s, (tx) =>
        rejectHold(tx, s, gone.hold.id, {
          operationId: randomUUID(),
          reason: "unavailable",
          refund,
        }),
      );
    const refund = {
      attemptId: gone.attemptId,
      note: "Reembolso completo hecho en la app de Mercado Pago",
      confirmed: true,
    };
    await rejects(reject(cashier, refund), "forbidden");
    await rejects(reject(staleManager, refund), "step_up_required");
    await assert.rejects(reject(manager, { ...refund, confirmed: undefined }));
    await assert.rejects(reject(manager, { ...refund, note: "corto" }));
    await rejects(
      reject(manager, { ...refund, attemptId: up.attemptId }),
      "payments_attempt_not_found",
    );
    await untouched(gone.key, gone.attemptId);
    await reject(manager, refund);
    const hr = await holdOf(gone.key);
    assert.equal(hr.state, "rejected");
    assert.equal(hr.reject_reason, "unavailable");
    assert.equal(hr.order_id, null);
    const dismissed = await attemptOf(gone.key);
    assert.equal(dismissed.state, "dismissed");
    assert.equal(dismissed.resolution, "refunded_at_provider");
    assert.equal(dismissed.resolution_note, refund.note);
    assert.equal(dismissed.resolved_by, ids.manager);
    assert.equal(dismissed.tender_id, null);
    const audits = await asOwner(
      A,
      (tx) => tx`select operation,detail from audit
        where (operation='public.hold_rejected' and entity_id=${gone.hold.id})
           or (operation='payment.terminal_resolved' and detail->>'attemptId'=${gone.attemptId})
        order by operation`,
    );
    assert.deepEqual(
      audits.map((r: any) => [
        r.operation,
        r.detail.refundedAttemptId ?? r.detail.outcome,
      ]),
      [
        ["payment.terminal_resolved", "refunded_at_provider"],
        ["public.hold_rejected", gone.attemptId],
      ],
    );
    await setAvailable(ids.papas, true);

    // (d) The operator retry (R13): no PIN, from review with the provider's data once the checks
    // pass, also 30 minutes after the hold expired (money taken in time, R12). The manager's
    // record keeps payments' step-up.
    const late = await inReview([line(ids.papas)], 3500, () =>
      setAvailable(ids.papas, false),
    );
    // The named-trigger pattern (LD-12): both rows are immutable evidence for every role.
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${A}, true)`;
      await tx`alter table public_order_holds disable trigger public_order_holds_transition`;
      await tx`alter table payment_attempts disable trigger payment_attempts_transition`;
      // Everything moves back by the same span, so the hold expired 30 minutes ago and the
      // charge still started while it was valid.
      await tx`update payment_attempts a
        set created_at=a.created_at-(h.expires_at-now()+interval '30 minutes')
        from public_order_holds h
        where a.tenant_id=${A} and a.id=${late.attemptId} and h.tenant_id=a.tenant_id and h.id=a.hold_id`;
      await tx`update public_order_holds
        set created_at=created_at-(expires_at-now()+interval '30 minutes'),
          expires_at=now()-interval '30 minutes'
        where tenant_id=${A} and id=${late.hold.id}`;
      await tx`alter table payment_attempts enable trigger payment_attempts_transition`;
      await tx`alter table public_order_holds enable trigger public_order_holds_transition`;
    });
    assert.ok(
      (
        await one(
          A,
          (tx) =>
            tx`select expires_at<now()-interval '20 minutes' as long_ago from public_order_holds where id=${late.hold.id}`,
        )
      ).long_ago,
    );
    await setAvailable(ids.papas, true);
    await rejects(
      write(staleManager, (tx) =>
        resolveAttempt(tx, staleManager, late.attemptId, {
          operationId: randomUUID(),
          outcome: "record",
          note: NOTE,
          confirmed: true,
        }),
      ),
      "step_up_required",
    );
    const retried = await write(staleCashier, (tx) =>
      resolveAttempt(tx, staleCashier, late.attemptId, {
        operationId: randomUUID(),
        outcome: "retry",
      }),
    );
    assert.equal(retried.attempt.state, "settled");
    const hl = await holdOf(late.key);
    assert.equal(hl.state, "accepted");
    assert.equal(hl.decision_source, "kiosk");
    assert.equal(retried.order?.paid, 3500);
  });

  assert.deepEqual(dead, [], "no job went dead");
  assert.deepEqual(fake.violations, [], "the fake saw no contract breach");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  server.close();
  // payments_platform is one global row: put back what the run found.
  if (platformBefore)
    await admin`update payments_platform set providers=${platformBefore.providers},
      upload_kid=${platformBefore.upload_kid},
      upload_public_jwk=${platformBefore.upload_public_jwk ? admin.json(platformBefore.upload_public_jwk) : null},
      updated_at=now() where id=1`;
  else await admin`delete from payments_platform where id=1`;
  setPaymentsRuntime(null);
  await workerRunner.stop(2000);
  await webRunner.stop(2000);
  await fake.close();
  await rm(mediaRoot, { recursive: true, force: true });
  await sql.end();
  await worker.end();
  await admin.end();
}
if (failed) process.exit(1);
console.log(`kiosk DB: ${checks} checks passed`);
