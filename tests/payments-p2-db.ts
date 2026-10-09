// Payments (037), phase P2 DB suite (spec §12.2 items 5-7 and 13-15, critic R10 and R13): the
// integrated start, exactly-once settle and manager resolution against a real database; the
// worker's push, poll, cancel and webhook handlers on the jobs login (gm_worker) against the MP
// and Clip HTTP fake (tests/fakes/payments-fake.ts); provider webhooks through the real pre-auth
// route; credentials sealed at entry and never readable by the web login, logged or returned;
// /capabilities; vault rekey; and the lock-order bursts (LO-R9, noRetries).
//
// Every value here is fictional and obviously so: test card brand and last four digits from the
// providers' test documentation ("visa" / "4242"), secrets spelled "...-not-real", loopback only.
// Run: npm run test:db:payments-p2 (part of test:db:qualification).
import "dotenv/config";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import express from "express";
import postgres from "postgres";
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
import type { Alert } from "../server/ops/alerts.js";
import { enqueueJob, handlers } from "../server/jobs.js";
import { cancelJob, requeueJob } from "../server/jobs/queue.js";
import { createJobRunner } from "../server/jobs/runner.js";
import { workerHandlers } from "../server/jobs/worker-registry.js";
import "../server/jobs/handlers/payments.js";
import "../server/jobs/handlers/loyalty.js";
import { linkOrderMember } from "../server/loyalty/links.js";
import { redeemReward } from "../server/loyalty/rewards.js";
import { adjustMember, enrollMember } from "../server/loyalty/members.js";
import {
  getLoyaltySettings,
  saveLoyaltySettings,
} from "../server/loyalty/settings.js";
import { reconcileOrder } from "../server/loyalty/ledger.js";
import { legalConfig } from "../server/legal.js";
import { LEGAL_CI_ENV } from "./fixtures/legal-ci.js";
import {
  rewardDiscountRequest,
  type LoyaltySettingsView,
} from "../shared/loyalty.js";
import "../server/payments/worker/register.js";
import { publishPaymentsPlatform } from "../server/payments/worker/boot.js";
import {
  openAccount,
  setPaymentsRuntime,
} from "../server/payments/worker/runtime.js";
import { parseCredentialKeyring } from "../server/cfdi/config.js";
import { rekeyPaymentSecrets } from "../server/vault/rekey.js";
import { createOrder, getOrder, recordPayment } from "../server/orders.js";
import { voidLines } from "../server/voids.js";
import { applyDiscount } from "../server/discounts.js";
import { closeCash } from "../server/cash.js";
import { saveFiscalProfile } from "../server/fiscal.js";
import { newTender } from "../server/offline-sync.js";
import { acceptHold } from "../server/public-holds.js";
import { discountExpectation, planDiscount } from "../shared/discounts.js";
import { archiveTerminal, saveTerminal } from "../server/payments/settings.js";
import {
  disableProvider,
  providerCapabilities,
  providersView,
  requestDeviceMode,
  requestDevices,
  saveCredentials,
} from "../server/payments/providers.js";
import {
  activeAttempts,
  getAttempt,
  requestCancel,
  resolveAttempt,
  settleAttemptEntry,
  startTerminalCharge,
  syncAttemptCore,
} from "../server/payments/terminal.js";
import {
  webhookBody,
  webhookBodyErrors,
  webhookIpKey,
  webhookRoute,
} from "../server/payments/webhooks.js";
import { exceptionRows } from "../server/reports/exceptions.js";
import { snapshotTenant } from "../server/reports/snapshot.js";
import { businessDate, type Order, type Session } from "../shared/domain.js";
import type { AttemptState, AttemptView } from "../shared/payments.js";
import type { SessionAccess } from "../shared/access.js";
import { startPaymentsFake } from "./fakes/payments-fake.js";
import { noRetries } from "./db-retries.js";

// ---- Captured log lines (credentials must never reach one) and alerts.
const logLines: string[] = [];
setLogSink((line) => {
  logLines.push(line);
  if (process.env.PAYMENTS_DB_DEBUG && /"level":"(warn|error)"/.test(line))
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

// ---- Obviously fake provider credentials (the fake accepts exactly these).
const FAKE = {
  mpToken: "TEST-mp-access-token-not-real-0000",
  mpSecret: "testWebhookSecretNotReal0000",
  mpUserId: "1000001",
  clipKey: "test-clip-api-key-not-real",
  clipSecret: "test-clip-secret-key-not-real",
};
const fake = await startPaymentsFake({
  mpToken: FAKE.mpToken,
  mpSecret: FAKE.mpSecret,
  mpUserId: FAKE.mpUserId,
  clipKey: FAKE.clipKey,
  clipSecret: FAKE.clipSecret,
});
/** Test card data from the providers' test documentation. */
const TEST_CARD = {
  brand: "visa",
  type: "credit_card" as const,
  last4: "4242",
};

// ---- The worker runtime as paymentsWorkerBoot wires it, pointed at the fake.
const keyOne = "t1:" + Buffer.alloc(32, 7).toString("base64url");
const keyTwo = "t2:" + Buffer.alloc(32, 9).toString("base64url");
const alerts: Alert[] = [];
const runtime = {
  providers: ["mercadopago", "clip"] as ("mercadopago" | "clip")[],
  mercadopagoApiUrl: fake.mpBase,
  clipApiUrl: fake.clipBase,
  ring: parseCredentialKeyring(keyOne),
  appUrl: "https://pos.example.test",
  alert: (a: Alert) => {
    alerts.push(a);
  },
};
setPaymentsRuntime(runtime);
const [platformBefore] =
  await admin`select providers,upload_kid,upload_public_jwk from payments_platform where id=1`;
async function publish(providers: ("mercadopago" | "clip")[]) {
  const { paymentsVault } = await import("../server/vault/vault.js");
  await publishPaymentsPlatform(worker, {
    providers,
    uploadKid: runtime.ring.active,
    uploadPublicJwk: paymentsVault.uploadKeyPair(runtime.ring).publicJwk,
  });
}

// ---- Job runners: the worker kinds on the jobs login, payments_settle on the web login.
const dead: { kind: string; code: string }[] = [];
const workerRunner = createJobRunner(worker, {
  handlers: workerHandlers,
  concurrency: 4,
  sweepMs: 3_600_000,
  onDead: (job, code) => dead.push({ kind: job.kind, code }),
});
// The club's reconcile (loyalty 038) is a web job too: a settle of a linked order queues it.
const webKinds = new Map([
  ["payments_settle", handlers().get("payments_settle")!],
  ["loyalty_reconcile", handlers().get("loyalty_reconcile")!],
]);
const webRunner = createJobRunner(sql, {
  handlers: () => webKinds,
  concurrency: 2,
  sweepMs: 3_600_000,
  onDead: (job, code) => dead.push({ kind: job.kind, code }),
});

// ---- Fictional restaurants: A (Pro, two registers) and B (another tenant).
const organizationId = randomUUID();
const A = randomUUID(),
  B = randomUUID();
const ids = {
  owner: randomUUID(),
  manager: randomUUID(),
  cashier: randomUUID(),
  ownerB: randomUUID(),
  device1: randomUUID(),
  device2: randomUUID(),
  device3: randomUUID(),
  deviceB: randomUUID(),
  drawer1: randomUUID(),
  drawer2: randomUUID(),
  drawerB: randomUUID(),
  taco: randomUUID(),
  agua: randomUUID(),
  tacoB: randomUUID(),
};
const restaurant = {
  name: "Cobros integrados ficticios " + run,
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
          deviceName: "Caja cobros",
          deviceKind: "terminal",
          idleLockSeconds: null,
          ownerAccount: false,
          ...access,
        } as SessionAccess,
      }
    : {}),
});
/** A session that just stepped up (owner and manager actions with step-up). */
const fresh = (tenantId: string, employeeId: string, role: string) =>
  session(tenantId, employeeId, role, ids.device1, {});
const stale = (tenantId: string, employeeId: string, role: string) =>
  session(tenantId, employeeId, role, ids.device1, {
    authenticatedAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
const owner = session(A, ids.owner, "owner", ids.device1);
const manager = session(A, ids.manager, "manager", ids.device1);
const cashier = session(A, ids.cashier, "cashier", ids.device1);
const cashier2 = session(A, ids.cashier, "cashier", ids.device2);
const ownerB = session(B, ids.ownerB, "owner", ids.deviceB);

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
/** The table owner inside one tenant's scope (fixture rows and read-backs). */
async function asOwner<T>(tenantId: string, fn: (tx: any) => Promise<T>) {
  return admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}
const today = businessDate(
  new Date().toISOString(),
  restaurant.timezone,
  restaurant.cutoff,
);

async function newOrder(
  s: Session,
  lines: { product: string; quantity: number }[],
): Promise<Order> {
  return write(s, (tx) =>
    createOrder(tx, s, {
      operationId: randomUUID(),
      lines: lines.map((l) => ({
        id: randomUUID(),
        productId: l.product,
        quantity: l.quantity,
        options: [],
        note: "",
      })),
      mode: "takeaway",
      tableId: null,
      name: "Cobro integrado",
      note: "",
      channel: "pos",
    }),
  );
}
function start(
  s: Session,
  orderId: string,
  terminalId: string,
  amount: number,
  extra: Record<string, unknown> = {},
) {
  return write(s, (tx) =>
    startTerminalCharge(tx, s, {
      operationId: randomUUID(),
      orderId,
      terminalId,
      amount,
      tip: 0,
      ...extra,
    }),
  );
}
const attemptRow = async (attemptId: string) =>
  (
    await asOwner(
      A,
      (tx) => tx`select * from payment_attempts where id=${attemptId}`,
    )
  )[0] as Record<string, any>;
const stateOf = async (attemptId: string) =>
  (await attemptRow(attemptId)).state as AttemptState;
const eventsOf = async (attemptId: string) =>
  (
    await asOwner(
      A,
      (tx) =>
        tx`select kind,actor,detail from payment_attempt_events where attempt_id=${attemptId}
          order by created_at, id`,
    )
  ).map((e: any) => ({
    kind: e.kind as string,
    actor: e.actor,
    detail: e.detail,
  }));

/** Makes the tenant's waiting payments jobs due (polls are scheduled seconds ahead). */
async function due(tenantId: string) {
  await admin`update jobs set next_at = now() where tenant_id = ${tenantId}
    and state = 'available' and kind like 'payments\\_%'`;
}
/** Postpones the tenant's waiting jobs of these kinds (a check that must not rely on them). */
async function hold(tenantId: string, kinds: string[]) {
  await admin`update jobs set next_at = now() + interval '1 hour' where tenant_id = ${tenantId}
    and state = 'available' and kind = any(${kinds}::text[])`;
}
/**
 * One round: every due payments job of the tenant, worker kinds then the web settle. With
 * `due: false` only what is already due runs (held polls stay held).
 */
async function round(tenantId: string, o: { due?: boolean } = {}) {
  if (o.due !== false) await due(tenantId);
  const w = await workerRunner.drainTenant(tenantId);
  while (workerRunner.running() > 0) await sleep(10);
  const s = await webRunner.drainTenant(tenantId);
  while (webRunner.running() > 0) await sleep(10);
  return w + s;
}
/** Runs rounds until the attempt reaches one of `states` (the worker and web settle chain). */
async function drive(
  attemptId: string,
  states: AttemptState[],
  o: { tenantId?: string; rounds?: number } = {},
): Promise<AttemptState> {
  const tenantId = o.tenantId ?? A;
  for (let i = 0; i < (o.rounds ?? 40); i++) {
    const now = (
      await asOwner(
        tenantId,
        (tx) => tx`select state from payment_attempts where id=${attemptId}`,
      )
    )[0]?.state as AttemptState;
    if (states.includes(now)) return now;
    await round(tenantId);
  }
  throw new Error(
    `drive: attempt ${attemptId} never reached ${states.join("|")} (now ${await stateOf(attemptId)})`,
  );
}
/** Runs rounds until no payments job of the tenant is due (setup jobs; never a live poll chain). */
async function drain(tenantId: string, rounds = 30) {
  for (let i = 0; i < rounds; i++) {
    const n = await round(tenantId);
    if (n === 0) return;
  }
  throw new Error("drain: payments jobs keep coming");
}
const count = async (tenantId: string, query: (tx: any) => Promise<any[]>) =>
  Number((await asOwner(tenantId, query))[0].n);

// ---- The pre-auth webhook route, mounted as server/index.ts does (before authentication).
const hookApp = express();
// As server/index.ts: the webhook path's own 16 KB parser before the app's 256 KB one.
hookApp.use("/api/payments/webhooks", ...webhookBody, webhookBodyErrors);
hookApp.use(express.json({ limit: "256kb" }));
hookApp.post("/api/payments/webhooks/:provider/:hook", webhookRoute(sql));
const hookServer: http.Server = hookApp.listen(0, "127.0.0.1");
await new Promise((r) => hookServer.once("listening", r));
const hookOrigin = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}`;
/** Posts a notification to a notification URL (path only: the origin is the test server's). */
async function notify(
  url: string,
  o: { query?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const path = new URL(url).pathname;
  const r = await fetch(hookOrigin + path + (o.query ? `?${o.query}` : ""), {
    method: "POST",
    headers: { "content-type": "application/json", ...(o.headers ?? {}) },
    body: JSON.stringify(o.body ?? {}),
  });
  assert.equal(r.status, 200, "a notification is always answered 200");
  assert.equal(await r.text(), "", "with an empty body");
}

const hooks = { mercadopago: "", clip: "" };
const terminals = { mp: "", mpStandalone: "", clip: "", manual: "" };

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
      values(${tenantId},${employee},${name},${"p" + randomUUID().slice(0, 12)},'fixture',${role})`;
  await admin`insert into devices(tenant_id,id,name,token_hash,free_slot)
    values (${A},${ids.device1},'Caja mostrador','fixture',1),(${A},${ids.device2},'Barra','fixture',null),
           (${A},${ids.device3},'Terraza sin caja','fixture',null),(${B},${ids.deviceB},'Caja B','fixture',1)`;
  await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at)
    values (${A},${ids.drawer1},${ids.device1},${ids.cashier},100000,now()-interval '2 hours'),
           (${A},${ids.drawer2},${ids.device2},${ids.cashier},50000,now()-interval '1 hour'),
           (${B},${ids.drawerB},${ids.deviceB},${ids.ownerB},0,now()-interval '1 hour')`;
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
  await product(B, ids.tacoB, "Taco B", 2000);
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
  terminals.manual = (
    await write(manager, (tx) =>
      saveTerminal(tx, manager, {
        operationId: randomUUID(),
        name: "Banco ficticio",
        kind: "manual",
        feeBp: 175,
      }),
    )
  ).terminals.find((t) => t.name === "Banco ficticio")!.id;

  const caps = (tenantId: string) =>
    tenant(sql, tenantId, (tx) => providerCapabilities(tx));
  /** Every place a plaintext credential could leak to: tables the web or worker write, and logs. */
  async function assertNowhere(
    tenantId: string,
    values: string[],
    label: string,
  ) {
    for (const value of values) {
      const like = `%${value}%`;
      const [row] = await asOwner(
        tenantId,
        (tx) => tx`select
          (select count(*) from operations where tenant_id=${tenantId} and (result::text like ${like} or hash like ${like}))::int as operations,
          (select count(*) from audit where tenant_id=${tenantId} and detail::text like ${like})::int as audit,
          (select count(*) from jobs where tenant_id=${tenantId} and payload::text like ${like})::int as jobs,
          (select count(*) from payment_attempt_events where tenant_id=${tenantId} and detail::text like ${like})::int as events,
          (select count(*) from payment_provider_accounts where tenant_id=${tenantId}
            and concat_ws(' ',account_label,provider_account_id,hook_hash,error_code) like ${like})::int as accounts,
          (select count(*) from payment_secrets where tenant_id=${tenantId} and payload_secret like ${like})::int as secrets`,
      );
      assert.deepEqual(
        { ...row },
        {
          operations: 0,
          audit: 0,
          jobs: 0,
          events: 0,
          accounts: 0,
          secrets: 0,
        },
        `${label}: a credential value reached a table`,
      );
      assert.ok(
        !logLines.some((l) => l.includes(value)),
        `${label}: a credential value reached a log line`,
      );
    }
  }

  await test("R30 /capabilities: worker_not_configured, then not_connected, per provider and per restaurant", async () => {
    await publish(["mercadopago"]);
    assert.deepEqual(await caps(A), {
      mercadopago: { enabled: false, reason: "not_connected" },
      clip: { enabled: false, reason: "worker_not_configured" },
    });
    await publish(["mercadopago", "clip"]);
    assert.deepEqual(await caps(A), {
      mercadopago: { enabled: false, reason: "not_connected" },
      clip: { enabled: false, reason: "not_connected" },
    });
  });

  await test("14. credentials (Mercado Pago): owner with step-up only; sealed at entry to the worker key; the web login cannot read the box; the worker verifies, re-seals and activates; the upload is wiped; capabilities follow", async () => {
    const body = { accessToken: FAKE.mpToken, webhookSecret: FAKE.mpSecret };
    const env = { appEnv: "test", appUrl: "https://pos.example.test" };
    await rejects(
      write(manager, (tx) =>
        saveCredentials(
          tx,
          fresh(A, ids.manager, "manager"),
          "mercadopago",
          body,
          env,
        ),
      ),
      "forbidden",
    );
    await rejects(
      write(owner, (tx) =>
        saveCredentials(
          tx,
          stale(A, ids.owner, "owner"),
          "mercadopago",
          body,
          env,
        ),
      ),
      "step_up_required",
    );
    await rejects(
      write(owner, (tx) =>
        saveCredentials(
          tx,
          fresh(A, ids.owner, "owner"),
          "mercadopago",
          { ...body, webhookSecret: "not a secret!" },
          env,
        ),
      ),
      "payments_credentials_invalid_format",
    );
    // A staging or production worker refuses MP test tokens (Point needs production ones).
    await rejects(
      write(owner, (tx) =>
        saveCredentials(tx, fresh(A, ids.owner, "owner"), "mercadopago", body, {
          ...env,
          appEnv: "production",
        }),
      ),
      "payments_credentials_invalid_format",
    );
    const saved = await write(owner, (tx) =>
      saveCredentials(
        tx,
        fresh(A, ids.owner, "owner"),
        "mercadopago",
        body,
        env,
      ),
    );
    assert.equal(saved.state, "verifying");
    assert.match(
      saved.webhookUrl,
      /^https:\/\/pos\.example\.test\/api\/payments\/webhooks\/mercadopago\/[A-Za-z0-9_-]{22}$/,
    );
    hooks.mercadopago = saved.webhookUrl;
    const hookToken = saved.webhookUrl.split("/").pop()!;
    assert.deepEqual(Object.keys(saved).sort(), [
      "provider",
      "state",
      "webhookUrl",
    ]);
    assert.deepEqual((await caps(A)).mercadopago, {
      enabled: false,
      reason: "verifying",
    });
    // Sealed at entry: a compact JWE under the worker's upload kid, never the plaintext.
    const [upload] = await asOwner(
      A,
      (
        tx,
      ) => tx`select s.id,s.kid,s.payload_secret,s.wiped_at from payment_secrets s
        join payment_provider_accounts a on a.tenant_id=s.tenant_id and a.upload_secret_id=s.id
        where a.tenant_id=${A} and a.provider='mercadopago'`,
    );
    assert.equal(upload.kid, "t1");
    assert.equal(String(upload.payload_secret).split(".").length, 5);
    for (const v of [FAKE.mpToken, FAKE.mpSecret, hookToken])
      assert.ok(!String(upload.payload_secret).includes(v));
    // The web login has no SELECT on the boxes (scripts/grants.sql: insert only).
    await rejects(
      write(owner, (tx) => tx`select payload_secret from payment_secrets`),
      /permission denied/,
    );
    await rejects(
      write(owner, (tx) => tx`select id from payment_secrets`),
      /permission denied/,
    );
    await drain(A);
    const [account] = await asOwner(
      A,
      (
        tx,
      ) => tx`select state,account_label,provider_account_id,credential_secret_id,upload_secret_id,
          error_code from payment_provider_accounts where tenant_id=${A} and provider='mercadopago'`,
    );
    assert.deepEqual(
      [
        account.state,
        account.account_label,
        account.provider_account_id,
        account.error_code,
      ],
      ["active", "RESTAURANTE_FICTICIO", FAKE.mpUserId, null],
    );
    const [wiped] = await asOwner(
      A,
      (tx) =>
        tx`select payload_secret,wiped_at from payment_secrets where id=${upload.id}`,
    );
    assert.equal(
      wiped.payload_secret,
      null,
      "the upload box is wiped once verified",
    );
    assert.ok(wiped.wiped_at);
    const [atRest] = await asOwner(
      A,
      (tx) =>
        tx`select purpose,kid,payload_secret from payment_secrets where id=${account.credential_secret_id}`,
    );
    assert.equal(atRest.purpose, "mp_credentials");
    assert.equal(atRest.kid, "t1");
    assert.equal(String(atRest.payload_secret).split(".").length, 5);
    assert.deepEqual(await caps(A).then((c) => c.mercadopago), {
      enabled: true,
    });
    // Device discovery ran after activation (payments_devices).
    const view = await write(manager, (tx) => providersView(tx, manager));
    assert.deepEqual(
      view.devices
        .filter((d) => d.provider === "mercadopago")
        .map((d) => [d.deviceId, d.operatingMode]),
      [
        ["NEWLAND_N950__FAKE0001", "PDV"],
        ["NEWLAND_N950__FAKE0002", "STANDALONE"],
      ],
    );
    const json = JSON.stringify(view);
    for (const v of [FAKE.mpToken, FAKE.mpSecret, hookToken])
      assert.ok(
        !json.includes(v),
        "the providers view never returns a credential",
      );
    await assertNowhere(
      A,
      [FAKE.mpToken, FAKE.mpSecret, hookToken],
      "MP connect",
    );
    assert.deepEqual(fake.violations, []);
  });

  await test("14. credentials (Clip): sealed, verified by listing the readers, active with a reader label; the notification URL is shown once and stored only as a hash", async () => {
    const saved = await write(owner, (tx) =>
      saveCredentials(
        tx,
        fresh(A, ids.owner, "owner"),
        "clip",
        { apiKey: FAKE.clipKey, secretKey: FAKE.clipSecret },
        { appEnv: "test", appUrl: "https://pos.example.test/" },
      ),
    );
    assert.match(
      saved.webhookUrl,
      /^https:\/\/pos\.example\.test\/api\/payments\/webhooks\/clip\/[A-Za-z0-9_-]{22}$/,
    );
    hooks.clip = saved.webhookUrl;
    const hookToken = saved.webhookUrl.split("/").pop()!;
    await drain(A);
    const [account] = await asOwner(
      A,
      (
        tx,
      ) => tx`select state,account_label,hook_hash,upload_secret_id from payment_provider_accounts
        where tenant_id=${A} and provider='clip'`,
    );
    assert.deepEqual(
      [account.state, account.account_label],
      ["active", "Clip · 1 lector"],
    );
    assert.match(account.hook_hash, /^[0-9a-f]{64}$/);
    const [upload] = await asOwner(
      A,
      (tx) =>
        tx`select payload_secret from payment_secrets where id=${account.upload_secret_id}`,
    );
    assert.equal(upload.payload_secret, null);
    assert.deepEqual((await caps(A)).clip, { enabled: true });
    const view = await write(manager, (tx) => providersView(tx, manager));
    assert.deepEqual(
      view.devices
        .filter((d) => d.provider === "clip")
        .map((d) => [d.deviceId, d.status]),
      [["P8220724FAKE01", "active"]],
    );
    await assertNowhere(
      A,
      [FAKE.clipKey, FAKE.clipSecret, hookToken],
      "Clip connect",
    );
  });

  await test("14. credentials failures: a provider 401 and a non-Mexican MP account fail the account; the upload box is wiped in every branch; nothing leaks", async () => {
    const ownerFreshB = session(B, ids.ownerB, "owner", ids.deviceB, {});
    const env = { appEnv: "test", appUrl: "https://pos.example.test" };
    const uploadOf = async (provider: string) =>
      (
        await asOwner(
          B,
          (tx) => tx`select a.state,a.error_code,s.payload_secret,s.wiped_at
            from payment_provider_accounts a
            join payment_secrets s on s.tenant_id=a.tenant_id and s.id=a.upload_secret_id
            where a.tenant_id=${B} and a.provider=${provider}`,
        )
      )[0];
    const wrongToken = "TEST-wrong-access-token-not-real-00";
    await write(ownerB, (tx) =>
      saveCredentials(
        tx,
        ownerFreshB,
        "mercadopago",
        {
          accessToken: wrongToken,
          webhookSecret: FAKE.mpSecret,
        },
        env,
      ),
    );
    await drain(B);
    let row = await uploadOf("mercadopago");
    assert.deepEqual(
      [row.state, row.error_code, row.payload_secret],
      ["failed", "payments_credentials_rejected", null],
    );
    assert.ok(row.wiped_at);
    assert.deepEqual((await caps(B)).mercadopago, {
      enabled: false,
      reason: "payments_credentials_rejected",
    });
    fake.mp.siteId = "MLA";
    try {
      await write(ownerB, (tx) =>
        saveCredentials(
          tx,
          ownerFreshB,
          "mercadopago",
          {
            accessToken: FAKE.mpToken,
            webhookSecret: FAKE.mpSecret,
          },
          env,
        ),
      );
      await drain(B);
    } finally {
      fake.mp.siteId = "MLM";
    }
    row = await uploadOf("mercadopago");
    assert.deepEqual(
      [row.state, row.error_code, row.payload_secret],
      ["failed", "payments_account_country", null],
    );
    const wrongKey = "test-wrong-clip-key-not-real";
    await write(ownerB, (tx) =>
      saveCredentials(
        tx,
        ownerFreshB,
        "clip",
        {
          apiKey: wrongKey,
          secretKey: FAKE.clipSecret,
        },
        env,
      ),
    );
    await drain(B);
    row = await uploadOf("clip");
    assert.deepEqual(
      [row.state, row.error_code, row.payload_secret],
      ["failed", "payments_credentials_rejected", null],
    );
    const [{ n }] = await asOwner(
      B,
      (tx) => tx`select count(*)::int as n from payment_secrets
        where tenant_id=${B} and payload_secret is not null`,
    );
    assert.equal(n, 0, "no box survives a failed verification");
    await assertNowhere(
      B,
      [wrongToken, wrongKey, FAKE.mpToken, FAKE.mpSecret, FAKE.clipSecret],
      "failed connects",
    );
    // Tenant A's accounts are untouched by B's failures.
    assert.deepEqual(await caps(A), {
      mercadopago: { enabled: true },
      clip: { enabled: true },
    });
  });

  // ---- Integrated terminals on the devices the providers listed (Configuración, P2).
  const integrated = async (
    name: string,
    kind: string,
    providerDeviceId: string,
    feeBp: number,
  ) =>
    (
      await write(manager, (tx) =>
        saveTerminal(tx, manager, {
          operationId: randomUUID(),
          name,
          kind,
          providerDeviceId,
          feeBp,
        }),
      )
    ).terminals.find((t) => t.name === name)!.id;
  terminals.mp = await integrated(
    "MP Caja",
    "mercadopago_point",
    "NEWLAND_N950__FAKE0001",
    350,
  );
  terminals.mpStandalone = await integrated(
    "MP Barra",
    "mercadopago_point",
    "NEWLAND_N950__FAKE0002",
    350,
  );
  terminals.clip = await integrated(
    "Clip Caja",
    "clip_pinpad",
    "P8220724FAKE01",
    360,
  );
  const cancelCreated = (attemptId: string) =>
    write(cashier, (tx) =>
      requestCancel(tx, cashier, attemptId, { operationId: randomUUID() }),
    );

  await test("5. start: integrated terminals only; Pro, provider served and account active; drawer, balance and MP minimum; one live attempt per order and per terminal; an idempotent replay; concurrent starts on one terminal (one wins, the other payments_terminal_busy, no retries)", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 2 }]);
    await rejects(
      start(cashier, o.id, terminals.manual, 4500),
      "payments_terminal_not_integrated",
    );
    await rejects(
      start(cashier, o.id, terminals.mp, o.total + 1),
      "overpayment",
    );
    const small = await newOrder(cashier, [{ product: ids.agua, quantity: 1 }]);
    await rejects(
      start(cashier, small.id, terminals.mp, 300),
      "payments_amount_below_min",
    );
    const noDrawer = session(A, ids.cashier, "cashier", ids.device3);
    await rejects(start(noDrawer, o.id, terminals.mp, 4500), "drawer_required");
    // The worker does not serve MP now: unavailable (503), not a configuration problem.
    await publish(["clip"]);
    await rejects(
      start(cashier, o.id, terminals.mp, 4500),
      "payments_provider_unavailable",
    );
    await publish(["mercadopago", "clip"]);
    await admin`update payment_provider_accounts set state='failed',error_code='payments_credentials_rejected'
      where tenant_id=${A} and provider='mercadopago'`;
    await rejects(
      start(cashier, o.id, terminals.mp, 4500),
      "payments_provider_not_configured",
    );
    await admin`update payment_provider_accounts set state='active',error_code=null
      where tenant_id=${A} and provider='mercadopago'`;
    await admin`update restaurant_entitlements set access_until=now()-interval '1 day' where tenant_id=${A}`;
    await rejects(start(cashier, o.id, terminals.mp, 4500), "pro_required");
    await admin`update restaurant_entitlements set access_until=now()+interval '1 day' where tenant_id=${A}`;
    // A start and its replay: one attempt, one push job, the same view.
    const operationId = randomUUID();
    const body = {
      operationId,
      orderId: o.id,
      terminalId: terminals.mp,
      amount: 4500,
      tip: 0,
    };
    const first = await write(cashier, (tx) =>
      startTerminalCharge(tx, cashier, body),
    );
    const replay = await write(cashier, (tx) =>
      startTerminalCharge(tx, cashier, body),
    );
    assert.deepEqual(replay, first);
    assert.equal(first.state, "created");
    assert.equal(first.orderNumber, o.number);
    assert.equal(first.terminalLabel, "MP Caja");
    assert.equal(
      await count(
        A,
        (tx) =>
          tx`select count(*) as n from payment_attempts where tenant_id=${A} and operation_id=${operationId}`,
      ),
      1,
    );
    assert.equal(
      await count(
        A,
        (tx) =>
          tx`select count(*) as n from jobs where tenant_id=${A} and kind='payments_push' and dedupe_key=${first.id}`,
      ),
      1,
    );
    // One live attempt per order (another terminal) and per terminal (another order).
    await rejects(
      start(cashier, o.id, terminals.clip, 4500),
      "payments_order_attempt_live",
    );
    const other = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    await rejects(
      start(cashier2, other.id, terminals.mp, 4500),
      "payments_terminal_busy",
    );
    // The order's other writers refuse while the charge is live (P1 guards, now with a real start).
    await rejects(
      write(cashier, (tx) =>
        recordPayment(tx, cashier, o.id, {
          operationId: randomUUID(),
          amount: 4500,
          tip: 0,
          received: 4500,
          method: "cash",
        }),
      ),
      "payments_order_attempt_live",
    );
    const cancelled = await cancelCreated(first.id);
    assert.equal(
      cancelled.state,
      "cancelled",
      "nothing was sent: cancelled at once",
    );
    // Concurrent starts on one terminal from two registers.
    const a = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const b = await newOrder(cashier2, [{ product: ids.taco, quantity: 1 }]);
    const results = await noRetries("concurrent starts", () =>
      Promise.allSettled([
        start(cashier, a.id, terminals.clip, 4500),
        start(cashier2, b.id, terminals.clip, 4500),
      ]),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    assert.equal(won.length, 1, "one start wins");
    assert.equal(lost.length, 1);
    assert.equal(
      (lost[0] as PromiseRejectedResult).reason.code,
      "payments_terminal_busy",
    );
    await cancelCreated(
      (won[0] as PromiseFulfilledResult<AttemptView>).value.id,
    );
    // Restaurant B sees none of A's attempts.
    assert.deepEqual(
      await write(ownerB, (tx) => activeAttempts(tx, ownerB)),
      [],
    );
  });

  const mpOrderReads = (ref: string) =>
    fake.requests.filter(
      (r) => r.method === "GET" && r.path === `/mp/v1/orders/${ref}`,
    ).length;
  const tenderOf = async (attemptId: string) =>
    (
      await asOwner(
        A,
        (
          tx,
        ) => tx`select method,amount,tip,received,terminal_id,terminal_label,provider,provider_reference,
            external_reference,card_type,card_brand,card_last4,fee,fee_source,session_id
          from tenders where tenant_id=${A} and attempt_id=${attemptId}`,
      )
    ).map((t: any) => ({ ...t }));
  const mpNotification = (
    ref: string,
    requestId: string,
    signature?: string,
  ) => ({
    query: `data.id=${ref}&type=order`,
    body: { action: "order.processed", type: "order", data: { id: ref } },
    headers: {
      "x-request-id": requestId,
      ...(signature === undefined ? {} : { "x-signature": signature }),
    },
  });
  /** An x-signature in MP's format, computed with a secret that is not the account's. */
  const forged = (ref: string, requestId: string) => {
    const ts = String(Date.now());
    const v1 = createHmac("sha256", "wrongSecretNotReal0000")
      .update(`id:${ref.toLowerCase()};request-id:${requestId};ts:${ts};`)
      .digest("hex");
    return `ts=${ts},v1=${v1}`;
  };

  await test("13. MP end to end: push (idempotency key = attempt id) → pending → a notification with a valid signature re-reads the order → approved with the test card and the provider fee → payments_settle records one tender, the fiscal ticket and the receipt job", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 2 }]);
    const view = await start(cashier, o.id, terminals.mp, o.total);
    assert.equal(await drive(view.id, ["pending"]), "pending");
    const charge = fake.chargeFor(view.id)!;
    assert.ok(charge, "the order was created at the provider");
    assert.equal(charge.amount, o.total);
    assert.equal(charge.device, "NEWLAND_N950__FAKE0001");
    const creates = fake.requests.filter(
      (r) => r.method === "POST" && r.path === "/mp/v1/orders",
    );
    assert.equal(creates.at(-1)!.idempotencyKey, view.id);
    assert.equal((await attemptRow(view.id)).provider_reference, charge.id);
    // The customer pays; only the notification (not a poll) may find out.
    await hold(A, ["payments_poll"]);
    fake.approve(charge.id, { ...TEST_CARD, fee: 315 });
    const requestId = randomUUID();
    const reads = mpOrderReads(charge.id);
    await notify(
      hooks.mercadopago,
      mpNotification(charge.id, requestId, fake.signMp(charge.id, requestId)),
    );
    await round(A, { due: false });
    assert.equal(mpOrderReads(charge.id), reads + 1, "one verified re-read");
    assert.equal(await stateOf(view.id), "settled");
    const kinds = (await eventsOf(view.id)).map((e) => e.kind);
    assert.deepEqual(kinds, [
      "created",
      "sent",
      "pending",
      "webhook",
      "approved",
      "settled",
    ]);
    const [tender] = await tenderOf(view.id);
    assert.deepEqual(
      {
        method: tender.method,
        amount: tender.amount,
        received: tender.received,
        terminal: tender.terminal_label,
        provider: tender.provider,
        reference: tender.provider_reference,
        card: [tender.card_type, tender.card_brand, tender.card_last4],
        fee: [tender.fee, tender.fee_source],
        drawer: tender.session_id,
      },
      {
        method: "external",
        amount: o.total,
        received: o.total,
        terminal: "MP Caja",
        provider: "mercadopago",
        reference: charge.id,
        card: ["credit", "visa", "4242"],
        fee: [315, "provider"],
        drawer: ids.drawer1,
      },
    );
    const [order] = await asOwner(
      A,
      (tx) =>
        tx`select check_state,close_reason from orders where tenant_id=${A} and id=${o.id}`,
    );
    assert.deepEqual(
      [order.check_state, order.close_reason],
      ["closed", "settled"],
    );
    assert.equal(
      await count(
        A,
        (tx) =>
          tx`select count(*) as n from fiscal_tickets where tenant_id=${A} and order_id=${o.id}`,
      ),
      1,
    );
    assert.equal(
      await count(
        A,
        (
          tx,
        ) => tx`select count(*) as n from jobs where tenant_id=${A} and kind='receipt'
        and payload->>'orderId'=${o.id}`,
      ),
      1,
    );
    // The staff view: settled, the card and the terminal, no secret or raw payload.
    const seen = await write(cashier, (tx) => getAttempt(tx, cashier, view.id));
    assert.deepEqual(
      [seen.state, seen.cardBrand, seen.cardLast4, seen.paidAmount],
      ["settled", "visa", "4242", o.total],
    );
  });

  await test("webhooks (MP): a notification with a forged or missing signature is rejected by the worker with no provider read (fails closed); polling still settles the charge", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const view = await start(cashier, o.id, terminals.mp, o.total);
    await drive(view.id, ["pending"]);
    const ref = (await attemptRow(view.id)).provider_reference as string;
    await hold(A, ["payments_poll"]);
    fake.approve(ref, { ...TEST_CARD });
    const reads = mpOrderReads(ref);
    const forgedId = randomUUID();
    // Each notification runs before the next (a waiting one coalesces later hints).
    await notify(
      hooks.mercadopago,
      mpNotification(ref, forgedId, forged(ref, forgedId)),
    );
    await round(A, { due: false });
    await notify(hooks.mercadopago, mpNotification(ref, randomUUID()));
    await round(A, { due: false });
    // A valid signature over another request id does not verify this one either.
    const signedOther = fake.signMp(ref, randomUUID());
    await notify(
      hooks.mercadopago,
      mpNotification(ref, randomUUID(), signedOther),
    );
    await round(A, { due: false });
    assert.equal(
      await stateOf(view.id),
      "pending",
      "nothing trusted a forged notification",
    );
    assert.equal(
      mpOrderReads(ref),
      reads,
      "a rejected notification never reads the provider",
    );
    const rejected = (await eventsOf(view.id)).filter(
      (e) => e.kind === "webhook_rejected",
    );
    assert.equal(rejected.length, 3);
    // The poll chain (held above) still reaches the provider and settles.
    assert.equal(await drive(view.id, ["settled"]), "settled");
    assert.equal((await tenderOf(view.id)).length, 1);
  });

  /** Pushed and pending at the fake; returns the attempt and its provider reference. */
  async function pending(
    o: Order,
    terminalId: string,
    amount = o.total,
    s = cashier,
  ) {
    const view = await start(s, o.id, terminalId, amount);
    assert.equal(await drive(view.id, ["pending"]), "pending");
    return {
      id: view.id,
      ref: (await attemptRow(view.id)).provider_reference as string,
    };
  }
  /** Runs only the worker (no web settle): the approval is recorded, the settle job waits. */
  async function workerOnly(tenantId = A) {
    await due(tenantId);
    await workerRunner.drainTenant(tenantId);
    while (workerRunner.running() > 0) await sleep(10);
  }
  const resolve = (
    s: Session,
    attemptId: string,
    body: Record<string, unknown>,
  ) =>
    write(s, (tx) =>
      resolveAttempt(tx, s, attemptId, { operationId: randomUUID(), ...body }),
    );
  const NOTE = "Revisado en la app del proveedor (prueba)";

  await test("6. settle exactly once: the payments_settle job, two syncs and a direct settle race on one approved charge (no retries) → one tender, one fiscal ticket, one receipt job", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 2 }]);
    const a = await pending(o, terminals.mp);
    fake.approve(a.ref, { ...TEST_CARD });
    await workerOnly();
    assert.equal(await stateOf(a.id), "approved");
    assert.equal(
      await count(
        A,
        (
          tx,
        ) => tx`select count(*) as n from jobs where tenant_id=${A} and kind='payments_settle'
        and dedupe_key=${a.id} and state='available'`,
      ),
      1,
      "the worker queued the web settle",
    );
    const results = await noRetries("settle race", () =>
      Promise.all([
        webRunner.drainTenant(A),
        syncAttemptCore(sql, A, a.id),
        syncAttemptCore(sql, A, a.id),
        settleAttemptEntry(sql, A, a.id, "sync"),
      ]),
    );
    while (webRunner.running() > 0) await sleep(10);
    assert.equal(await stateOf(a.id), "settled");
    for (const r of results.slice(1, 3) as {
      attempt: AttemptView;
      order?: Order;
    }[]) {
      assert.equal(r.attempt.state, "settled");
      assert.equal(
        r.order?.paid,
        o.total,
        "every sync answers with the recorded order",
      );
    }
    assert.equal((await tenderOf(a.id)).length, 1);
    assert.equal(
      await count(
        A,
        (tx) =>
          tx`select count(*) as n from tenders where tenant_id=${A} and order_id=${o.id}`,
      ),
      1,
    );
    assert.equal(
      await count(
        A,
        (tx) =>
          tx`select count(*) as n from fiscal_tickets where tenant_id=${A} and order_id=${o.id}`,
      ),
      1,
    );
    assert.equal(
      await count(
        A,
        (
          tx,
        ) => tx`select count(*) as n from jobs where tenant_id=${A} and kind='receipt'
        and payload->>'orderId'=${o.id}`,
      ),
      1,
    );
    assert.equal(
      (await eventsOf(a.id)).filter((e) => e.kind === "settled").length,
      1,
    );
    // A later sync is a read: the same order, nothing new.
    const again = await syncAttemptCore(sql, A, a.id);
    assert.equal(again.order?.paid, o.total);
    assert.equal((await tenderOf(a.id)).length, 1);
  });

  await test("7. review path: an offline sale fills the balance while a charge is approved → review (never a second tender); retry is refused while it does not fit; the manager's «reembolsado en el proveedor» (step-up, note) dismisses it; Excepciones lists both", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const a = await pending(o, terminals.mp);
    fake.approve(a.ref, { ...TEST_CARD });
    await workerOnly();
    assert.equal(await stateOf(a.id), "approved");
    // Offline evidence is always applied (OFF-8), even with the approved charge.
    await write(cashier, (tx) =>
      newTender(
        tx,
        cashier,
        o.id,
        {
          method: "cash",
          amount: o.total,
          tip: 0,
          received: o.total,
          reference: "",
          externalConfirmed: false,
        },
        ids.drawer1,
      ),
    );
    await round(A, { due: false });
    const row = await attemptRow(a.id);
    assert.deepEqual(
      [row.state, row.error_code],
      ["review", "payments_settle_order_changed"],
    );
    assert.equal(
      (await tenderOf(a.id)).length,
      0,
      "the charge never became a second tender",
    );
    // In the active list for the banner, as review.
    const active = await write(cashier, (tx) => activeAttempts(tx, cashier));
    assert.equal(active.find((x) => x.id === a.id)?.state, "review");
    await rejects(
      resolve(cashier, a.id, { outcome: "retry" }),
      "payments_settle_order_changed",
    );
    await rejects(
      resolve(cashier, a.id, {
        outcome: "refunded_at_provider",
        note: NOTE,
        confirmed: true,
      }),
      "forbidden",
    );
    await rejects(
      resolve(stale(A, ids.manager, "manager"), a.id, {
        outcome: "refunded_at_provider",
        note: NOTE,
        confirmed: true,
      }),
      "step_up_required",
    );
    await rejects(
      resolve(fresh(A, ids.manager, "manager"), a.id, {
        outcome: "refunded_at_provider",
        confirmed: true,
      }),
      "payments_note_required",
    );
    // «No se cobró» is for an unknown outcome only; this one was paid.
    await rejects(
      resolve(fresh(A, ids.manager, "manager"), a.id, {
        outcome: "not_charged",
        note: NOTE,
        confirmed: true,
      }),
      "payments_not_approved",
    );
    const done = await resolve(fresh(A, ids.manager, "manager"), a.id, {
      outcome: "refunded_at_provider",
      note: NOTE,
      confirmed: true,
    });
    assert.deepEqual(
      [done.attempt.state, done.attempt.resolution],
      ["dismissed", "refunded_at_provider"],
    );
    const after = await attemptRow(a.id);
    assert.equal(after.resolved_by, ids.manager);
    assert.equal(after.resolution_note, NOTE);
    assert.ok(
      !(await write(cashier, (tx) => activeAttempts(tx, cashier))).some(
        (x) => x.id === a.id,
      ),
      "a dismissed charge leaves the banner",
    );
    // Excepciones lists both steps: the review and the manager's resolution with its note.
    const ex = await snapshotTenant(sql, A, (tx) =>
      exceptionRows(tx, owner, {
        from: today,
        to: today,
        kinds: "terminal_attempt_review,terminal_attempt_dismissed",
      }),
    );
    const mine = ex.rows.filter((r) => r.detail.attemptId === a.id);
    assert.deepEqual(
      mine
        .map((r) => [r.kind, r.amount, r.orderId, r.reasonCode, r.note])
        .sort(),
      [
        [
          "terminal_attempt_dismissed",
          o.total,
          o.id,
          "refunded_at_provider",
          NOTE,
        ],
        [
          "terminal_attempt_review",
          o.total,
          o.id,
          "payments_settle_order_changed",
          "",
        ],
      ],
    );
    assert.equal(
      mine.find((r) => r.kind === "terminal_attempt_dismissed")?.approverName,
      "Marisol Vega",
    );
  });

  await test("R13 retry: an approved charge sent to review by an order change settles on any operator's retry (no step-up) once it fits; a flagged approval (another account) never retries", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const a = await pending(o, terminals.mp);
    fake.approve(a.ref, { ...TEST_CARD });
    await workerOnly();
    // The order is briefly not payable (as during a recovery), so the settle goes to review.
    const [{ state: before }] =
      await admin`select state from orders where tenant_id=${A} and id=${o.id}`;
    await admin`update orders set state='recovery_pending' where tenant_id=${A} and id=${o.id}`;
    await round(A, { due: false });
    assert.deepEqual(
      [(await attemptRow(a.id)).state, (await attemptRow(a.id)).error_code],
      ["review", "payments_settle_order_changed"],
    );
    await admin`update orders set state=${before} where tenant_id=${A} and id=${o.id}`;
    const retried = await resolve(cashier, a.id, { outcome: "retry" });
    assert.equal(retried.attempt.state, "settled");
    assert.equal(retried.order?.paid, o.total);
    assert.equal((await tenderOf(a.id))[0].card_last4, "4242");
    // An approval for another account is flagged: review, and no retry can apply it.
    const o2 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const b = await pending(o2, terminals.mp);
    fake.approve(b.ref, { ...TEST_CARD, terminalId: "__other_user" });
    await round(A);
    const flagged = await attemptRow(b.id);
    assert.deepEqual(
      [flagged.state, flagged.error_code],
      ["review", "payments_provider_mismatch"],
    );
    await rejects(
      resolve(cashier, b.id, { outcome: "retry" }),
      "payments_not_approved",
    );
    await resolve(fresh(A, ids.manager, "manager"), b.id, {
      outcome: "refunded_at_provider",
      note: NOTE,
      confirmed: true,
    });
    assert.equal(await stateOf(b.id), "dismissed");
    // A flagged approval the manager records keeps what MP reported (P2-MONEY-5): the $40 tip
    // added on the terminal is the tender's tip, with MP's card and fee (before: amount + the POS
    // tip, no card, the $40 lost).
    const o3 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const c = await pending(o3, terminals.mp);
    fake.approve(c.ref, {
      ...TEST_CARD,
      paid: o3.total + 4000,
      tip: 4000,
      fee: 250,
      terminalId: "NEWLAND_N950__FAKE9999",
    });
    await round(A);
    assert.deepEqual(
      [(await attemptRow(c.id)).state, (await attemptRow(c.id)).error_code],
      ["review", "payments_provider_mismatch"],
    );
    const recorded = await resolve(fresh(A, ids.manager, "manager"), c.id, {
      outcome: "record",
      note: NOTE,
      confirmed: true,
    });
    assert.equal(recorded.attempt.state, "settled");
    const [t3] = await tenderOf(c.id);
    assert.deepEqual(
      [t3.amount, t3.tip, t3.received, t3.card_brand, t3.card_last4, t3.fee],
      [o3.total, 4000, o3.total + 4000, "visa", "4242", 250],
    );
  });

  await test("13. Clip: a notification is only a hint (it triggers a re-read and nothing else); an approval with a tip read back from Clip settles with the estimated fee", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 2 }]);
    const a = await pending(o, terminals.clip);
    const charge = fake.charges.get(a.ref)!;
    assert.equal(charge.device, "P8220724FAKE01");
    assert.equal(charge.reference, a.id, "Clip's reference is the attempt id");
    await hold(A, ["payments_poll"]);
    // A hint while the reader still waits: re-read, still pending, no state change.
    const reads = fake.requests.length;
    await notify(hooks.clip, { body: { id: a.ref, status: "COMPLETED" } });
    await round(A, { due: false });
    assert.equal(
      await stateOf(a.id),
      "pending",
      "the hint's own claims are never trusted",
    );
    assert.ok(
      fake.requests
        .slice(reads)
        .some((r) => r.method === "GET" && r.path === "/clip/payment"),
      "the hint caused a re-read",
    );
    // Paid with a tip at the reader; the next hint finds it.
    fake.approve(a.ref, { ...TEST_CARD, paid: o.total + 1000 });
    await notify(hooks.clip, { body: { id: a.ref } });
    await round(A, { due: false });
    assert.equal(await stateOf(a.id), "settled");
    const [tender] = await tenderOf(a.id);
    assert.deepEqual(
      [
        tender.amount,
        tender.tip,
        tender.received,
        tender.provider,
        tender.card_last4,
        tender.fee_source,
      ],
      [o.total, 1000, o.total + 1000, "clip", "4242", "estimated"],
    );
    // 3.60 % of what the reader charged, rounded.
    assert.equal(tender.fee, Math.round(((o.total + 1000) * 360) / 10000));
    const kinds = (await eventsOf(a.id)).map((e) => e.kind);
    assert.deepEqual(kinds.filter((k) => k === "webhook").length, 2);
    // A hint for an id that is not live does nothing at all.
    const jobsBefore = await count(
      A,
      (tx) => tx`select count(*) as n from jobs where tenant_id=${A}`,
    );
    await notify(hooks.clip, { body: { id: a.ref } });
    await notify(hooks.clip, { body: { id: "pinpad-not-a-live-charge" } });
    assert.equal(
      await count(
        A,
        (tx) => tx`select count(*) as n from jobs where tenant_id=${A}`,
      ),
      jobsBefore,
    );
  });

  await test("13. Clip create timeout → unknown (never re-sent) with a withdraw by serial number; the manager records it with a typed reference (step-up) → one tender without card data", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    // The reader took the request before the withdrawal (a request it had not taken is withdrawn
    // and cancelled: the Clip deadline test).
    fake.next("clip", "timeoutTaken");
    const view = await start(cashier, o.id, terminals.clip, o.total);
    assert.equal(
      await drive(view.id, ["unknown", "pending", "declined"]),
      "unknown",
    );
    const row = await attemptRow(view.id);
    assert.deepEqual(
      [row.error_code, row.provider_reference],
      ["payments_clip_create_outcome_unknown", null],
    );
    const posts = fake.requests.filter(
      (r) => r.method === "POST" && r.path === "/clip/payment",
    );
    assert.equal(
      [...fake.charges.values()].filter((c) => c.reference === view.id).length,
      1,
      "the create was sent exactly once",
    );
    assert.ok(posts.length >= 1);
    assert.ok(
      fake.requests.some(
        (r) =>
          r.method === "DELETE" &&
          r.path === "/clip/payment/serial-number/P8220724FAKE01",
      ),
      "whatever the reader had not picked up was withdrawn",
    );
    assert.ok(alerts.some((x) => /payments_attempt_unknown/.test(x.body)));
    // The terminal stays busy while the outcome is unknown.
    const other = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    await rejects(
      start(cashier, other.id, terminals.clip, other.total),
      "payments_terminal_busy",
    );
    const mgr = fresh(A, ids.manager, "manager");
    await rejects(
      resolve(mgr, view.id, { outcome: "record", note: NOTE, confirmed: true }),
      "payments_reference_required",
    );
    await rejects(
      resolve(cashier, view.id, {
        outcome: "record",
        reference: "AUT123456",
        note: NOTE,
        confirmed: true,
      }),
      "forbidden",
    );
    // No amount from Clip: the manager types the one its history shows, and it must be the amount
    // sent to the reader (spec §4.3 step 3; P2-MONEY-5).
    await rejects(
      resolve(mgr, view.id, {
        outcome: "record",
        reference: "AUT123456",
        note: NOTE,
        confirmed: true,
      }),
      "payments_charged_required",
    );
    await rejects(
      resolve(mgr, view.id, {
        outcome: "record",
        reference: "AUT123456",
        charged: o.total + 100,
        note: NOTE,
        confirmed: true,
      }),
      "payments_charged_mismatch",
    );
    const recorded = await resolve(mgr, view.id, {
      outcome: "record",
      reference: "AUT123456",
      charged: o.total,
      note: NOTE,
      confirmed: true,
    });
    assert.equal(recorded.attempt.state, "settled");
    assert.equal(recorded.attempt.resolution, "recorded");
    const [tender] = await tenderOf(view.id);
    // No card data from a lost answer; the fee is the terminal's estimate (3.60 %).
    assert.deepEqual(
      [
        tender.provider_reference,
        tender.card_type,
        tender.card_last4,
        tender.fee,
        tender.fee_source,
      ],
      ["AUT123456", null, null, 162, "estimated"],
    );
    assert.equal(recorded.order?.paid, o.total);
    // The reader completes the payment the manager recorded (the fake's reader is free again).
    fake.approve(fake.chargeFor(view.id)!.id, { ...TEST_CARD });
    // A reference already recorded on another charge is a clear 409, never a 500 (unique index).
    const o2 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    fake.next("clip", "timeoutTaken");
    const v2 = await start(cashier, o2.id, terminals.clip, o2.total);
    assert.equal(await drive(v2.id, ["unknown", "pending"]), "unknown");
    await rejects(
      resolve(mgr, v2.id, {
        outcome: "record",
        reference: "aut123456",
        charged: o2.total,
        note: NOTE,
        confirmed: true,
      }),
      "payments_reference_taken",
    );
    const own = await resolve(mgr, v2.id, {
      outcome: "record",
      reference: "AUT654321",
      charged: o2.total,
      note: NOTE,
      confirmed: true,
    });
    assert.equal(own.attempt.state, "settled");
    fake.approve(fake.chargeFor(v2.id)!.id, { ...TEST_CARD });
  });

  await test("Clip's own deadline and «No se cobró» (P2-MONEY-3, P2-PROVIDERS-3): a request the reader never took is withdrawn at its deadline (cancelled, the order is free); one the reader holds becomes unknown, is still read, and «No se cobró» is refused until the reader settles it, which records it by itself; a lost create the reader never took is withdrawn by serial and cancelled", async () => {
    const mgr = fresh(A, ids.manager, "manager");
    const age = (attemptId: string) =>
      asOwner(
        A,
        (
          tx,
        ) => tx`update payment_attempts set sent_at = now() - interval '11 minutes'
          where id=${attemptId}`,
      );
    // (a) The diner walked away before the reader took it: withdrawn at the deadline.
    const o1 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const c1 = await pending(o1, terminals.clip);
    await age(c1.id);
    assert.equal(await drive(c1.id, ["cancelled", "unknown"]), "cancelled");
    assert.equal(fake.charges.get(c1.ref)!.status, "canceled");
    assert.ok(
      fake.requests.some(
        (r) => r.method === "DELETE" && r.path === `/clip/payment/${c1.ref}`,
      ),
    );
    // (b) The reader holds it (the diner is still paying): unknown, alerted, still read.
    const o2 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const c2 = await pending(o2, terminals.clip);
    fake.atTerminalUncancellable(c2.ref);
    await age(c2.id);
    assert.equal(await drive(c2.id, ["unknown", "cancelled"]), "unknown");
    assert.equal(
      (await attemptRow(c2.id)).error_code,
      "payments_attempt_timeout",
    );
    // «No se cobró» is refused: the reader may still take it (before: dismissed, and a later
    // payment on the reader was never recorded).
    await rejects(
      resolve(mgr, c2.id, {
        outcome: "not_charged",
        note: NOTE,
        confirmed: true,
      }),
      "payments_provider_may_charge",
    );
    await round(A);
    await round(A);
    assert.equal(await stateOf(c2.id), "unknown", "no flip back to pending");
    assert.equal(
      await count(
        A,
        (
          tx,
        ) => tx`select count(*)::int as n from jobs where kind='payments_poll'
          and state in ('queued','available','running') and payload->>'attemptId'=${c2.id}`,
      ),
      1,
      "still watched",
    );
    fake.approve(c2.ref, { ...TEST_CARD });
    assert.equal(await drive(c2.id, ["settled"]), "settled");
    // (c) A lost create the reader never took: the delete by serial withdraws it, and Clip's
    // answer names the attempt → cancelled, with its id (never a second create).
    const o3 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    fake.next("clip", "timeout");
    const v3 = await start(cashier, o3.id, terminals.clip, o3.total);
    assert.equal(await drive(v3.id, ["cancelled", "unknown"]), "cancelled");
    const row3 = await attemptRow(v3.id);
    assert.deepEqual(
      [row3.provider_reference, row3.provider_status],
      [fake.chargeFor(v3.id)!.id, "serial_withdrawn"],
    );
    assert.equal(
      [...fake.charges.values()].filter((c) => c.reference === v3.id).length,
      1,
      "one create",
    );
  });

  await test("Clip deadline during a Clip API outage (P2V-FIXES-1): the first poll past the deadline gets a 5xx, a 429 or a 404 (read and withdrawal alike); the attempt still becomes unknown (payments_attempt_timeout), alerted, with exactly one queued watch poll, never pending with no chain", async () => {
    for (const status of [503, 429, 404]) {
      const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
      const c = await pending(o, terminals.clip);
      await asOwner(
        A,
        (
          tx,
        ) => tx`update payment_attempts set sent_at = now() - interval '11 minutes'
          where id=${c.id}`,
      );
      alerts.length = 0;
      // Clip answers this status to the read and to the withdrawal (DELETE /payment/{id}).
      fake.failClip(status, status);
      await round(A);
      const row = await attemptRow(c.id);
      assert.deepEqual(
        [row.state, row.error_code],
        ["unknown", "payments_attempt_timeout"],
        `read ${status}`,
      );
      assert.equal(
        await count(
          A,
          (
            tx,
          ) => tx`select count(*)::int as n from jobs where kind='payments_poll'
            and state in ('queued','available','running') and payload->>'attemptId'=${c.id}`,
        ),
        1,
        `read ${status}: one watch poll`,
      );
      assert.ok(
        alerts.some(
          (x) =>
            x.key.startsWith("payments_attempt_unknown_") &&
            /reason=no_final_status/.test(x.body),
        ),
        `read ${status}: alerted`,
      );
      // Clip is back and the reader shows it cancelled: the watch settles it by itself.
      fake.cancelOnTerminal(c.ref);
      assert.equal(await drive(c.id, ["cancelled"]), "cancelled");
    }
  });

  await test("13. MP create with a lost answer is retried with the same idempotency key (one order at MP); a 429 on create backs off and retries; «No se cobró» dismisses an unknown outcome only when MP never said paid", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    fake.next("mercadopago", "timeout");
    const view = await start(cashier, o.id, terminals.mp, o.total);
    assert.equal(
      await drive(view.id, ["pending", "unknown", "declined"]),
      "pending",
    );
    assert.equal(
      [...fake.charges.values()].filter((c) => c.reference === view.id).length,
      1,
      "the retry with the same key found the order MP had created",
    );
    const keys = fake.requests
      .filter(
        (r) =>
          r.method === "POST" &&
          r.path === "/mp/v1/orders" &&
          r.idempotencyKey === view.id,
      )
      .map((r) => r.idempotencyKey);
    assert.ok(keys.length >= 2, "the create was sent again with the same key");
    // Cancel it (MP cancels an order the terminal has not taken).
    await write(cashier, (tx) =>
      requestCancel(tx, cashier, view.id, { operationId: randomUUID() }),
    );
    assert.equal(await drive(view.id, ["cancelled"]), "cancelled");
    // 429 on create: a retry, not a decline.
    const o2 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    fake.next("mercadopago", "rateLimit429");
    const v2 = await start(cashier, o2.id, terminals.mp, o2.total);
    assert.equal(
      await drive(v2.id, ["pending", "declined", "unknown"]),
      "pending",
    );
    // MP unreachable on every try: unknown, then «No se cobró».
    await write(cashier, (tx) =>
      requestCancel(tx, cashier, v2.id, { operationId: randomUUID() }),
    );
    await drive(v2.id, ["cancelled"]);
    const o3 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    fake.next("mercadopago", "server5xx");
    fake.next("mercadopago", "server5xx");
    fake.next("mercadopago", "server5xx");
    const v3 = await start(cashier, o3.id, terminals.mp, o3.total);
    assert.equal(
      await drive(v3.id, ["unknown", "pending", "declined"]),
      "unknown",
    );
    assert.equal(
      (await attemptRow(v3.id)).error_code,
      "payments_provider_unreachable",
    );
    // MP may still hold an order made by a lost send until it expires: «No se cobró» waits for
    // the expiry margin (P2-MONEY-3); a manager tries now and is refused with the reason.
    await rejects(
      resolve(fresh(A, ids.manager, "manager"), v3.id, {
        outcome: "not_charged",
        note: NOTE,
        confirmed: true,
      }),
      "payments_provider_may_charge",
    );
    await asOwner(
      A,
      (
        tx,
      ) => tx`update payment_attempts set sent_at = now() - interval '13 minutes'
        where id=${v3.id}`,
    );
    const done = await resolve(fresh(A, ids.manager, "manager"), v3.id, {
      outcome: "not_charged",
      note: NOTE,
      confirmed: true,
    });
    assert.deepEqual(
      [done.attempt.state, done.attempt.resolution],
      ["dismissed", "not_charged"],
    );
    assert.equal((await tenderOf(v3.id)).length, 0);
  });

  await test("MP 429s (P2-PROVIDERS-8): a create answered only 429 made no order: the push backs off 10 s then 20 s and declines it payments_provider_unavailable (the manual fallback), never unknown; a 5xx among the tries keeps the unknown path; MP is read every 5 s while a charge is fresh, Clip every 2 s", async () => {
    const pushJob = async (attemptId: string) =>
      (
        await asOwner(
          A,
          (tx) => tx`select state,attempts,error_code,
              extract(epoch from next_at - now())::float8 as wait_s
            from jobs where kind='payments_push' and dedupe_key=${attemptId}`,
        )
      )[0] as Record<string, any>;
    const creates = (attemptId: string) =>
      fake.requests.filter(
        (r) =>
          r.method === "POST" &&
          r.path === "/mp/v1/orders" &&
          r.idempotencyKey === attemptId,
      ).length;
    // (a) 429 on every try.
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    for (let i = 0; i < 3; i++) fake.next("mercadopago", "rateLimit429");
    const view = await start(cashier, o.id, terminals.mp, o.total);
    await round(A);
    let job = await pushJob(view.id);
    assert.deepEqual(
      [job.state, job.attempts, job.error_code, await stateOf(view.id)],
      ["available", 1, "payments_provider_rate_limited", "sending"],
    );
    assert.ok(job.wait_s > 5 && job.wait_s <= 10, `first wait ${job.wait_s}`);
    await round(A);
    job = await pushJob(view.id);
    assert.equal(job.attempts, 2);
    assert.ok(job.wait_s > 15 && job.wait_s <= 20, `second wait ${job.wait_s}`);
    await round(A);
    const row = await attemptRow(view.id);
    assert.deepEqual(
      [row.state, row.error_code, row.provider_reference],
      ["declined", "payments_provider_unavailable", null],
    );
    assert.equal((await pushJob(view.id)).state, "done");
    assert.equal(creates(view.id), 3, "three tries, one key");
    assert.equal(
      [...fake.charges.values()].filter((c) => c.reference === view.id).length,
      0,
      "MP made no order",
    );
    assert.deepEqual(
      (await eventsOf(view.id)).map((e) => e.kind),
      [
        "created",
        "sent",
        "rate_limited",
        "resent",
        "rate_limited",
        "resent",
        "rate_limited",
        "declined",
      ],
    );
    assert.deepEqual((await eventsOf(view.id)).at(-1)?.detail, {
      code: "payments_provider_unavailable",
      source: "rate_limited",
      before: "sending",
      httpStatus: 429,
    });
    // The order is free again: the cashier charges it on a manual terminal (the fallback).
    assert.equal(
      (await write(cashier, (tx) => activeAttempts(tx, cashier))).some(
        (a: AttemptView) => a.id === view.id,
      ),
      false,
    );
    const again = await pending(o, terminals.mp);
    await write(cashier, (tx) =>
      requestCancel(tx, cashier, again.id, { operationId: randomUUID() }),
    );
    assert.equal(await drive(again.id, ["cancelled"]), "cancelled");

    // (b) A 5xx first (MP may have made the order), then 429s: unknown, as before, with a recovery.
    const o2 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    fake.next("mercadopago", "server5xx");
    fake.next("mercadopago", "rateLimit429");
    fake.next("mercadopago", "rateLimit429");
    const v2 = await start(cashier, o2.id, terminals.mp, o2.total);
    for (let i = 0; i < 3; i++) await round(A, { due: i > 0 });
    const row2 = await attemptRow(v2.id);
    assert.deepEqual(
      [row2.state, row2.error_code],
      ["unknown", "payments_provider_unreachable"],
    );
    assert.equal(creates(v2.id), 3);
    // The recovery's identical re-POST finds (here: makes) MP's order; the cashier cancels it.
    assert.equal(await drive(v2.id, ["pending"]), "pending");
    await write(cashier, (tx) =>
      requestCancel(tx, cashier, v2.id, { operationId: randomUUID() }),
    );
    assert.equal(await drive(v2.id, ["cancelled"]), "cancelled");

    // (c) Read cadence of a fresh charge: the poll chain's links are 5 s apart for MP, 2 s for Clip.
    const link = async (attemptId: string, seq: number, from: Date) =>
      Number(
        (
          await asOwner(
            A,
            (
              tx,
            ) => tx`select extract(epoch from next_at - ${from}::timestamptz)::float8 as s
              from jobs where kind='payments_poll' and payload->>'attemptId'=${attemptId}
                and (payload->>'seq')::int=${seq}`,
          )
        )[0].s,
      );
    const clock = async () =>
      (await admin`select clock_timestamp() as t`)[0].t as Date;
    for (const [terminalId, ms] of [
      [terminals.mp, 5000],
      [terminals.clip, 2000],
    ] as const) {
      const oc = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
      const vc = await start(cashier, oc.id, terminalId, oc.total);
      const before = await clock();
      await round(A, { due: false });
      const after = await clock();
      assert.equal(await stateOf(vc.id), "pending");
      const span = (after.getTime() - before.getTime()) / 1000;
      const first = await link(vc.id, 1, before);
      assert.ok(
        first >= ms / 1000 - 0.05 && first <= ms / 1000 + span + 0.05,
        `first read ${first} s after the push (${ms} ms)`,
      );
      const before2 = await clock();
      await round(A);
      const after2 = await clock();
      const span2 = (after2.getTime() - before2.getTime()) / 1000;
      const second = await link(vc.id, 2, before2);
      assert.ok(
        second >= ms / 1000 - 0.05 && second <= ms / 1000 + span2 + 0.05,
        `next read ${second} s after the first (${ms} ms)`,
      );
      await write(cashier, (tx) =>
        requestCancel(tx, cashier, vc.id, { operationId: randomUUID() }),
      );
      assert.equal(await drive(vc.id, ["cancelled"]), "cancelled");
    }
  });

  await test("Clip 429 (LD-82): a create answered 429 made no payment request (unambiguous): the push declines it payments_provider_unavailable at once (the manual fallback); never re-sent, never unknown, nothing to withdraw; the order and the reader are free again", async () => {
    const posts = () =>
      fake.requests.filter(
        (r) => r.method === "POST" && r.path === "/clip/payment",
      ).length;
    const withdrawals = () =>
      fake.requests.filter(
        (r) =>
          r.method === "DELETE" &&
          r.path.startsWith("/clip/payment/serial-number/"),
      ).length;
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const before = { posts: posts(), withdrawals: withdrawals() };
    fake.next("clip", "rateLimit429");
    const view = await start(cashier, o.id, terminals.clip, o.total);
    assert.equal(
      await drive(view.id, ["declined", "unknown", "pending"]),
      "declined",
    );
    // More rounds change nothing: no retry of the push, no recovery job.
    await drain(A);
    const row = await attemptRow(view.id);
    assert.deepEqual(
      [row.state, row.error_code, row.provider_reference],
      ["declined", "payments_provider_unavailable", null],
    );
    assert.equal(posts() - before.posts, 1, "one create, never re-sent");
    assert.equal(withdrawals() - before.withdrawals, 0, "nothing to withdraw");
    assert.equal(
      [...fake.charges.values()].filter((c) => c.reference === view.id).length,
      0,
      "Clip made no payment request",
    );
    assert.deepEqual(
      (await eventsOf(view.id)).map((e) => e.kind),
      ["created", "sent", "declined"],
    );
    assert.deepEqual((await eventsOf(view.id)).at(-1)?.detail, {
      code: "payments_provider_unavailable",
      providerCode: null,
      httpStatus: 429,
    });
    const [job] = await asOwner(
      A,
      (tx) =>
        tx`select state,attempts from jobs where kind='payments_push' and dedupe_key=${view.id}`,
    );
    assert.deepEqual([job.state, job.attempts], ["done", 1]);
    // The order and the reader are free: the next charge on them goes out at once.
    const again = await pending(o, terminals.clip);
    await write(cashier, (tx) =>
      requestCancel(tx, cashier, again.id, { operationId: randomUUID() }),
    );
    assert.equal(await drive(again.id, ["cancelled"]), "cancelled");
  });

  await test("dead push: when payments_push goes dead with the attempt still sending (its last claim fails, or its lease expires on that claim), the attempt becomes unknown (payments_push_failed) and nothing is sent again; Cobros en terminal lists it with Resolver, Excepciones after 10 minutes, and a manager resolves it", async () => {
    const pushJob = async (attemptId: string) =>
      (
        await asOwner(
          A,
          (tx) => tx`select id,state,attempts,error_code from jobs
            where kind='payments_push' and dedupe_key=${attemptId}`,
        )
      )[0] as {
        id: string;
        state: string;
        attempts: number;
        error_code: string;
      };
    const exceptions = async () =>
      (
        await write(owner, (tx) =>
          exceptionRows(tx, owner, {
            from: businessDate(
              new Date(Date.now() - 86_400_000).toISOString(),
              restaurant.timezone,
              restaurant.cutoff,
            ),
            to: today,
            limit: "500",
          }),
        )
      ).rows as { kind: string; detail: { attemptId?: string } }[];
    const listed = async (kind: string, attemptId: string) =>
      (await exceptions()).some(
        (r) => r.kind === kind && r.detail.attemptId === attemptId,
      );
    // (a) MP: a settled charge leaves its order id recorded for this restaurant; the next create
    // is answered with that same id, so recording the answer fails on every claim (3) until the
    // job is dead, with the attempt sending.
    const o1 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const first = await pending(o1, terminals.mp);
    fake.approve(first.ref, { ...TEST_CARD });
    assert.equal(await drive(first.id, ["settled"]), "settled");
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    fake.next("mercadopago", "reusedOrderId");
    const deadBefore = dead.length;
    const alertsBefore = alerts.length;
    const view = await start(cashier, o.id, terminals.mp, o.total);
    assert.equal(
      await drive(view.id, ["unknown", "pending", "declined"]),
      "unknown",
    );
    const row = await attemptRow(view.id);
    assert.deepEqual(
      [row.error_code, row.provider_reference],
      ["payments_push_failed", null],
    );
    assert.deepEqual(
      dead.splice(deadBefore).map((d) => d.kind),
      ["payments_push"],
      "the push went dead (removed here: the suite's final check expects none)",
    );
    const job = await pushJob(view.id);
    assert.deepEqual([job.state, job.attempts], ["dead", 3]);
    assert.deepEqual((await eventsOf(view.id)).at(-1), {
      kind: "unknown",
      actor: "worker",
      detail: { code: "payments_push_failed", before: "sending" },
    });
    assert.ok(
      alerts
        .slice(alertsBefore)
        .some((a) =>
          /payments_attempt_unknown .*reason=push_failed/.test(a.body),
        ),
    );
    // MP idempotency: every create carried the attempt id as its key; a staff requeue of the dead
    // job finds the attempt unknown and sends nothing.
    const creates = () =>
      fake.requests.filter(
        (r) => r.method === "POST" && r.path === "/mp/v1/orders",
      ).length;
    const sameKey = () =>
      fake.requests.filter(
        (r) =>
          r.method === "POST" &&
          r.path === "/mp/v1/orders" &&
          r.idempotencyKey === view.id,
      ).length;
    assert.equal(sameKey(), 3);
    // Not a dead end (P2-CONCURRENCY-5): the queued recovery re-POSTs the identical create under
    // the same key (the fake checks the body) to learn the order id. Here MP answers with another
    // attempt's order, so nothing is adopted and the attempt stays unknown for a manager.
    await round(A);
    assert.equal(sameKey(), 4, "one recovery re-POST, same key");
    assert.deepEqual(
      (await eventsOf(view.id)).slice(-2).map((e) => [e.kind, e.detail]),
      [
        ["resent", { source: "recover" }],
        ["recover_mismatch", { source: "recover", mismatch: "identity" }],
      ],
    );
    assert.deepEqual(
      [await stateOf(view.id), (await attemptRow(view.id)).provider_reference],
      ["unknown", null],
    );
    const createsBefore = creates();
    await write(manager, (tx) => requeueJob(tx, manager, job.id));
    await round(A);
    assert.equal(creates(), createsBefore, "a requeued push sends nothing");
    assert.equal((await pushJob(view.id)).state, "done");
    assert.equal(await stateOf(view.id), "unknown");
    // Cobros en terminal (and the waiting panel) show it as live and unknown: Resolver.
    const charges = await write(cashier, (tx) => activeAttempts(tx, cashier));
    assert.deepEqual(
      charges
        .filter((a: AttemptView) => a.id === view.id)
        .map((a: AttemptView) => [a.state, a.errorCode]),
      [["unknown", "payments_push_failed"]],
    );
    // Excepciones lists an unknown outcome only after 10 minutes.
    assert.equal(await listed("terminal_attempt_unknown_open", view.id), false);
    // The manager resolves it with the existing outcomes: «No se cobró» (step-up, note), once
    // MP's order (if a send made one) has expired (P2-MONEY-3).
    await rejects(
      resolve(fresh(A, ids.manager, "manager"), view.id, {
        outcome: "not_charged",
        note: NOTE,
        confirmed: true,
      }),
      "payments_provider_may_charge",
    );
    await asOwner(
      A,
      (
        tx,
      ) => tx`update payment_attempts set sent_at = now() - interval '13 minutes'
        where id=${view.id}`,
    );
    const done = await resolve(fresh(A, ids.manager, "manager"), view.id, {
      outcome: "not_charged",
      note: NOTE,
      confirmed: true,
    });
    assert.deepEqual(
      [done.attempt.state, done.attempt.resolution],
      ["dismissed", "not_charged"],
    );
    assert.equal((await tenderOf(view.id)).length, 0);
    assert.equal(await listed("terminal_attempt_dismissed", view.id), true);

    // (b) Clip, lease expired on the last claim (the worker died after committing sending). The
    // attempt was started 11 minutes ago: a fixture row as startTerminalCharge writes it.
    const o2 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const clipAttempt = randomUUID();
    await asOwner(A, async (tx) => {
      await tx`insert into payment_attempts(tenant_id,id,operation_id,settle_operation_id,target,origin,
          order_id,terminal_id,provider,provider_device_id,terminal_label,amount,tip,currency,employee_id,
          device_id,session_id,cash_session_id,created_at)
        values(${A},${clipAttempt},${randomUUID()},${randomUUID()},'order','pos',${o2.id},${terminals.clip},
          'clip','P8220724FAKE01','Clip Caja',${o2.total},0,'MXN',${ids.cashier},${ids.device1},
          ${randomUUID()},${ids.drawer1},now() - interval '11 minutes')`;
      await enqueueJob(
        tx,
        { tenantId: A },
        {
          kind: "payments_push",
          dedupeKey: clipAttempt,
          payload: { attemptId: clipAttempt },
        },
      );
    });
    await tenant(
      worker,
      A,
      (
        tx,
      ) => tx`update payment_attempts set state='sending',sent_at=now(),version=version+1
        where id=${clipAttempt}`,
    );
    await admin`update jobs set state='running', attempts=3, lease_until=now() - interval '1 second'
      where tenant_id=${A} and kind='payments_push' and dedupe_key=${clipAttempt}`;
    const clipCreates = () =>
      fake.requests.filter(
        (r) => r.method === "POST" && r.path.startsWith("/clip/"),
      ).length;
    const clipBefore = clipCreates();
    // A fresh runner (the restarted worker) expires the lost job on its first drain.
    const expired: string[] = [];
    const restarted = createJobRunner(worker, {
      handlers: workerHandlers,
      concurrency: 4,
      sweepMs: 3_600_000,
      onDead: (j, code) => expired.push(`${j.kind}:${code}`),
    });
    await restarted.drainTenant(A);
    while (restarted.running() > 0) await sleep(10);
    await restarted.stop(2000);
    assert.deepEqual(expired, ["payments_push:lease_expired"]);
    const clipRow = await attemptRow(clipAttempt);
    assert.deepEqual(
      [clipRow.state, clipRow.error_code],
      ["unknown", "payments_push_failed"],
    );
    assert.equal(clipCreates(), clipBefore, "Clip is never sent again");
    assert.equal(
      await listed("terminal_attempt_unknown_open", clipAttempt),
      true,
      "Excepciones lists it once it is older than 10 minutes",
    );
    // «No se cobró» needs the reader's answer first (P2-MONEY-3): the recovery's delete by serial
    // number finds nothing of this attempt waiting on the reader.
    await rejects(
      resolve(fresh(A, ids.manager, "manager"), clipAttempt, {
        outcome: "not_charged",
        note: NOTE,
        confirmed: true,
      }),
      "payments_provider_may_charge",
    );
    await round(A);
    assert.deepEqual(
      [
        await stateOf(clipAttempt),
        (await attemptRow(clipAttempt)).provider_status,
      ],
      ["unknown", "serial_clear"],
    );
    assert.equal(clipCreates(), clipBefore, "Clip is never sent again");
    const doneClip = await resolve(
      fresh(A, ids.manager, "manager"),
      clipAttempt,
      { outcome: "not_charged", note: NOTE, confirmed: true },
    );
    assert.equal(doneClip.attempt.state, "dismissed");
  });

  await test("staff cancel of a push (P2-CONCURRENCY-6): a manager cancels a payments_push that MP's 5xx keeps retrying; the web hands it to the worker (never claimed again, nothing sent), and the worker writes it dead together with its hook: the attempt is unknown with its recovery queued, never left «Enviando»", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    fake.next("mercadopago", "server5xx");
    const view = await start(cashier, o.id, terminals.mp, o.total);
    await round(A);
    const pushJob = async () =>
      (
        await asOwner(
          A,
          (
            tx,
          ) => tx`select id,state,attempts,error_code,lease_until < now() as expired
            from jobs where kind='payments_push' and dedupe_key=${view.id}`,
        )
      )[0] as Record<string, any>;
    const before = await pushJob();
    assert.deepEqual(
      [before.state, before.attempts, before.error_code],
      ["available", 1, "payments_provider_unreachable"],
      "MP's 5xx: the push waits for its retry",
    );
    assert.equal(await stateOf(view.id), "sending");
    const creates = () =>
      fake.requests.filter(
        (r) =>
          r.method === "POST" &&
          r.path === "/mp/v1/orders" &&
          r.idempotencyKey === view.id,
      ).length;
    assert.equal(creates(), 1);
    // «Cancelar» in Operaciones (the web login): the job is handed to the worker.
    await write(manager, (tx) => cancelJob(tx, manager, before.id));
    const handed = await pushJob();
    assert.deepEqual(
      [handed.state, handed.error_code, handed.expired],
      ["running", "job_cancel_requested", true],
    );
    await rejects(
      write(manager, (tx) => cancelJob(tx, manager, before.id)),
      "job_not_cancellable",
    );
    // The running worker never claims it again (its expiry pass is not due): nothing is sent.
    await round(A);
    assert.equal(creates(), 1, "a cancelled push is never sent again");
    assert.equal((await pushJob()).state, "running");
    assert.equal(await stateOf(view.id), "sending");
    // The worker's next lease-expiry pass writes it dead (cancelled) and runs pushDead with it.
    const deadAlerts: string[] = [];
    const alertsBefore = alerts.length;
    const next = createJobRunner(worker, {
      handlers: workerHandlers,
      concurrency: 4,
      sweepMs: 3_600_000,
      onDead: (j, code) => deadAlerts.push(`${j.kind}:${code}`),
    });
    await next.drainTenant(A);
    while (next.running() > 0) await sleep(10);
    await next.stop(2000);
    const after = await pushJob();
    assert.deepEqual(
      [after.state, after.error_code, after.attempts],
      ["dead", "cancelled", 1],
    );
    assert.deepEqual(deadAlerts, [], "a staff cancel is not a dead-job alert");
    const row = await attemptRow(view.id);
    assert.deepEqual(
      [row.state, row.error_code],
      ["unknown", "payments_push_failed"],
    );
    assert.deepEqual((await eventsOf(view.id)).at(-1), {
      kind: "unknown",
      actor: "worker",
      detail: { code: "payments_push_failed", before: "sending" },
    });
    assert.ok(
      alerts
        .slice(alertsBefore)
        .some((a) =>
          /payments_attempt_unknown .*reason=push_failed/.test(a.body),
        ),
      "the unknown outcome is alerted once the transaction committed",
    );
    assert.equal(
      await count(
        A,
        (tx) => tx`select count(*) as n from jobs where kind='payments_webhook'
          and dedupe_key=${`recover:${view.id}:dead`}`,
      ),
      1,
      "its recovery is queued",
    );
    assert.equal(creates(), 1);
    // The recovery's identical re-POST (same key) creates or finds MP's order; the cashier then
    // cancels it from the POS like any pending charge.
    assert.equal(
      await drive(view.id, ["pending", "declined", "cancelled"]),
      "pending",
    );
    assert.equal(creates(), 2, "one recovery re-POST, same key");
    await write(cashier, (tx) =>
      requestCancel(tx, cashier, view.id, { operationId: randomUUID() }),
    );
    assert.equal(await drive(view.id, ["cancelled"]), "cancelled");
  });

  await test("MP recovery (P2-MONEY-2, P2-MONEY-4, P2-PROVIDERS-2, P2-CONCURRENCY-5, P2-PROVIDERS-7): a refused re-POST is unknown, never declined, and the identical re-POST adopts the order MP made; a cashier's cancel learns the order id first; a push that died before MP saw it creates the order on recovery; a notification naming the attempt adopts a lost order; already_queued_order_for_terminal on a first send is «queue busy»", async () => {
    const createsFor = (attemptId: string) =>
      fake.requests.filter(
        (r) =>
          r.method === "POST" &&
          r.path === "/mp/v1/orders" &&
          r.idempotencyKey === attemptId,
      ).length;
    const ordersFor = (attemptId: string) =>
      [...fake.charges.values()].filter((c) => c.reference === attemptId);
    // (a) MP made the order, the answer was lost, and the same-key re-POST is answered 409
    // already_queued_order_for_terminal (its own order waiting on the device): unknown, not
    // declined (which freed the order and the terminal while the device showed the charge).
    const o1 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    fake.next("mercadopago", "timeout");
    fake.nextReplay("queued2205");
    const v1 = await start(cashier, o1.id, terminals.mp, o1.total);
    assert.equal(
      await drive(v1.id, ["unknown", "declined", "pending"]),
      "unknown",
    );
    assert.equal(
      (await attemptRow(v1.id)).error_code,
      "payments_provider_unreachable",
    );
    // The automatic recovery re-POSTs the identical body: MP returns the original order.
    assert.equal(await drive(v1.id, ["pending"]), "pending");
    const row1 = await attemptRow(v1.id);
    assert.equal(row1.provider_reference, ordersFor(v1.id)[0].id);
    assert.equal(ordersFor(v1.id).length, 1, "one order at MP");
    assert.equal(createsFor(v1.id), 3, "every send carried the attempt id");
    fake.approve(row1.provider_reference, { ...TEST_CARD });
    assert.equal(await drive(v1.id, ["settled"]), "settled");
    assert.equal((await tenderOf(v1.id)).length, 1);

    // (b) A re-POST answered 409 idempotency_key_already_used is unknown too. The cashier cancels:
    // the cancel learns the order id (identical re-POST) and cancels it at MP.
    const o2 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    fake.next("mercadopago", "timeout");
    fake.nextReplay("idempotencyKeyUsed");
    const v2 = await start(cashier, o2.id, terminals.mp, o2.total);
    assert.equal(
      await drive(v2.id, ["unknown", "declined", "pending"]),
      "unknown",
    );
    await hold(A, ["payments_webhook"]);
    await write(cashier, (tx) =>
      requestCancel(tx, cashier, v2.id, { operationId: randomUUID() }),
    );
    assert.equal(await drive(v2.id, ["cancelled"]), "cancelled");
    assert.equal(ordersFor(v2.id)[0].status, "canceled", "cancelled at MP");
    assert.equal(
      (await attemptRow(v2.id)).provider_reference,
      ordersFor(v2.id)[0].id,
    );

    // (c) A first send answered already_queued_order_for_terminal (another order is waiting on
    // the device): declined «queue busy», with the manual fallback.
    const o3 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    fake.next("mercadopago", "queued2205");
    const v3 = await start(cashier, o3.id, terminals.mp, o3.total);
    assert.equal(
      await drive(v3.id, ["declined", "unknown", "pending"]),
      "declined",
    );
    assert.equal(
      (await attemptRow(v3.id)).error_code,
      "payments_terminal_queue_busy",
    );

    // (d) The push died (lease lost on its last claim) before MP saw the create: the recovery's
    // re-POST creates the order now, within the charge's window, and adopts it.
    const o4 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const v4 = randomUUID();
    await asOwner(A, async (tx) => {
      await tx`insert into payment_attempts(tenant_id,id,operation_id,settle_operation_id,target,origin,
          order_id,terminal_id,provider,provider_device_id,terminal_label,amount,tip,currency,employee_id,
          device_id,session_id,cash_session_id)
        values(${A},${v4},${randomUUID()},${randomUUID()},'order','pos',${o4.id},${terminals.mp},
          'mercadopago','NEWLAND_N950__FAKE0001','MP Caja',${o4.total},0,'MXN',${ids.cashier},
          ${ids.device1},${randomUUID()},${ids.drawer1})`;
      await enqueueJob(
        tx,
        { tenantId: A },
        {
          kind: "payments_push",
          dedupeKey: v4,
          payload: { attemptId: v4 },
        },
      );
    });
    await tenant(
      worker,
      A,
      (
        tx,
      ) => tx`update payment_attempts set state='sending',sent_at=now(),version=version+1
        where id=${v4}`,
    );
    await admin`update jobs set state='running', attempts=3, lease_until=now() - interval '1 second'
      where tenant_id=${A} and kind='payments_push' and dedupe_key=${v4}`;
    const expired: string[] = [];
    const restarted = createJobRunner(worker, {
      handlers: workerHandlers,
      concurrency: 4,
      sweepMs: 3_600_000,
      onDead: (j, code) => expired.push(`${j.kind}:${code}`),
    });
    await restarted.drainTenant(A);
    while (restarted.running() > 0) await sleep(10);
    await restarted.stop(2000);
    assert.deepEqual(expired, ["payments_push:lease_expired"]);
    assert.equal(await stateOf(v4), "unknown");
    assert.equal(ordersFor(v4).length, 0, "MP never saw the create");
    assert.equal(await drive(v4, ["pending"]), "pending");
    assert.equal(ordersFor(v4).length, 1);
    assert.equal(createsFor(v4), 1);
    fake.approve((await attemptRow(v4)).provider_reference, { ...TEST_CARD });
    assert.equal(await drive(v4, ["settled"]), "settled");

    // (e) The answer was lost and every re-POST failed (MP degraded): unknown. MP did make the
    // order and the diner paid it. Its order.processed notification names the attempt
    // (data.external_reference): the worker verifies the signature, reads the order, checks it
    // names this attempt and device, adopts it and settles; nothing is sent again.
    const o5 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    fake.next("mercadopago", "timeout");
    fake.nextReplay("server5xx");
    fake.nextReplay("server5xx");
    const v5 = await start(cashier, o5.id, terminals.mp, o5.total);
    assert.equal(
      await drive(v5.id, ["unknown", "declined", "pending"]),
      "unknown",
    );
    await hold(A, ["payments_webhook"]);
    const order5 = ordersFor(v5.id)[0];
    fake.approve(order5.id, { ...TEST_CARD });
    const sends = createsFor(v5.id);
    const requestId = `req-${randomUUID()}`;
    const notice = mpNotification(
      order5.id,
      requestId,
      fake.signMp(order5.id, requestId),
    );
    await notify(hooks.mercadopago, {
      ...notice,
      body: {
        ...notice.body,
        data: { id: order5.id, external_reference: v5.id },
      },
    });
    await round(A, { due: false });
    assert.equal(await drive(v5.id, ["settled"]), "settled");
    assert.equal(createsFor(v5.id), sends, "adopted from the notification");
    assert.ok(
      (await eventsOf(v5.id)).some(
        (e) =>
          e.kind === "reference_recovered" && e.detail.source === "mercadopago",
      ),
    );
  });

  await test("13. cancel: approved during the cancel stays approved and settles (the worker re-reads first); Clip's 400 on a taken charge keeps it pending with «cancélalo en la terminal» until the reader cancels; approved or later is not cancellable", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const a = await pending(o, terminals.mp);
    const cancel = await write(cashier, (tx) =>
      requestCancel(tx, cashier, a.id, { operationId: randomUUID() }),
    );
    assert.deepEqual([cancel.state, cancel.cancelRequested], ["pending", true]);
    // The customer pays before the worker's cancel runs.
    fake.approve(a.ref, { ...TEST_CARD });
    const cancelsBefore = fake.requests.filter((r) =>
      r.path.endsWith("/cancel"),
    ).length;
    assert.equal(await drive(a.id, ["settled", "cancelled"]), "settled");
    assert.equal(
      fake.requests.filter((r) => r.path.endsWith("/cancel")).length,
      cancelsBefore,
      "no cancel reached MP for a paid order",
    );
    await rejects(
      write(cashier, (tx) =>
        requestCancel(tx, cashier, a.id, { operationId: randomUUID() }),
      ),
      "payments_not_cancellable",
    );
    // Clip: the reader already took the charge; Clip refuses the delete.
    const o2 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const b = await pending(o2, terminals.clip);
    fake.atTerminalUncancellable(b.ref);
    await write(cashier, (tx) =>
      requestCancel(tx, cashier, b.id, { operationId: randomUUID() }),
    );
    await hold(A, ["payments_poll"]);
    await round(A, { due: false });
    const row = await attemptRow(b.id);
    assert.deepEqual(
      [row.state, row.error_code],
      ["pending", "payments_cancel_on_terminal"],
      "a refused cancel never frees the order",
    );
    await rejects(
      write(cashier, (tx) =>
        recordPayment(tx, cashier, o2.id, {
          operationId: randomUUID(),
          amount: o2.total,
          tip: 0,
          received: o2.total,
          method: "cash",
        }),
      ),
      "payments_order_attempt_live",
    );
    // The cashier cancels on the reader; the next read frees the order.
    fake.cancelOnTerminal(b.ref);
    assert.equal(await drive(b.id, ["cancelled"]), "cancelled");
    const paid = await write(cashier, (tx) =>
      recordPayment(tx, cashier, o2.id, {
        operationId: randomUUID(),
        amount: o2.total,
        tip: 0,
        received: o2.total,
        method: "cash",
      }),
    );
    assert.equal(paid.paid, o2.total);
  });

  await test("cancel outlives its job (P2-PROVIDERS-5, P2-CONCURRENCY-4, P2-PROVIDERS-6): a cancel requested while a slow MP push is still sending ends cancelled even when its own job dies first; MP's 202 for an order on the device is not a cancel (the diner who pays first is recorded); every MP cancel carries the at_terminal header and its own key", async () => {
    // (a) MP is slow: the first create fails, the cashier cancels while the attempt is sending,
    // and the cancel job's budget runs out before the push records MP's answer.
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    fake.next("mercadopago", "server5xx");
    const v = await start(cashier, o.id, terminals.mp, o.total);
    await round(A);
    assert.equal(await stateOf(v.id), "sending");
    await write(cashier, (tx) =>
      requestCancel(tx, cashier, v.id, { operationId: randomUUID() }),
    );
    await admin`update jobs set state='dead', error_code='test_budget_spent'
      where tenant_id=${A} and kind='payments_cancel' and payload->>'attemptId'=${v.id}`;
    assert.equal(await drive(v.id, ["cancelled"]), "cancelled");
    assert.equal(fake.chargeFor(v.id)!.status, "canceled", "cancelled at MP");
    // (b) The order is on the device: MP answers the cancel 202 and asks the device; the diner
    // taps first, so MP processes it. The attempt waits for the read and settles.
    const o2 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const a2 = await pending(o2, terminals.mp);
    fake.atTerminal(a2.ref);
    await write(cashier, (tx) =>
      requestCancel(tx, cashier, a2.id, { operationId: randomUUID() }),
    );
    await hold(A, ["payments_poll"]);
    await round(A, { due: false });
    const row2 = await attemptRow(a2.id);
    assert.deepEqual(
      [row2.state, row2.error_code],
      ["pending", "payments_cancel_sent"],
      "a 202 is not a cancel",
    );
    fake.approve(a2.ref, { ...TEST_CARD });
    assert.equal(await drive(a2.id, ["settled", "cancelled"]), "settled");
    // (c) Asked again for a device that confirms: cancelled by the read, not by the 202.
    const o3 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const a3 = await pending(o3, terminals.mp);
    fake.atTerminal(a3.ref);
    await write(cashier, (tx) =>
      requestCancel(tx, cashier, a3.id, { operationId: randomUUID() }),
    );
    assert.equal(await drive(a3.id, ["cancelled", "settled"]), "cancelled");
    const cancels = fake.requests.filter(
      (r) =>
        r.method === "POST" &&
        (r.path === `/mp/v1/orders/${a2.ref}/cancel` ||
          r.path === `/mp/v1/orders/${a3.ref}/cancel`),
    );
    assert.equal(cancels.length, 2);
    assert.notEqual(cancels[0].idempotencyKey, cancels[1].idempotencyKey);
    assert.ok(
      cancels.every((r) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          r.idempotencyKey ?? "",
        ),
      ),
      "one UUID per cancel operation",
    );
  });

  await test("13. provider outcomes: declined, expired and refunded-before-settle (review, then dismissed by a manager); 429 on reads backs off without touching the attempt", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const d = await pending(o, terminals.mp);
    fake.decline(d.ref);
    assert.equal(await drive(d.id, ["declined"]), "declined");
    // A card refused at the terminal says so (P2-UX-14), with MP's reason kept.
    assert.deepEqual(
      [
        (await attemptRow(d.id)).error_code,
        (await attemptRow(d.id)).provider_status,
      ],
      ["payments_card_declined", "failed/rejected"],
    );
    const e = await pending(o, terminals.mp);
    fake.expire(e.ref);
    assert.equal(await drive(e.id, ["expired"]), "expired");
    // 429 on reads: the attempt is untouched and the next poll waits (back-off).
    const r = await pending(o, terminals.clip);
    fake.rateLimitReads(1);
    const before = await attemptRow(r.id);
    await round(A);
    const after = await attemptRow(r.id);
    assert.deepEqual(
      [after.state, after.version],
      [before.state, before.version],
    );
    const [next] = await asOwner(
      A,
      (
        tx,
      ) => tx`select extract(epoch from (next_at - now()))::float8 as wait from jobs
        where tenant_id=${A} and kind='payments_poll' and payload->>'attemptId'=${r.id}
          and state='available' order by created_at desc limit 1`,
    );
    // 3.5 s (the observed 429 back-off), longer than the 2 s fast cadence.
    assert.ok(next.wait > 3, `the next read backs off (got ${next.wait} s)`);
    fake.approve(r.ref, { ...TEST_CARD });
    assert.equal(await drive(r.id, ["settled"]), "settled");
    // Refunded at MP before the settle: review, never a tender.
    const o2 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const m = await pending(o2, terminals.mp);
    await hold(A, ["payments_poll"]);
    fake.approve(m.ref, { ...TEST_CARD });
    fake.refund(m.ref);
    await write(cashier, (tx) =>
      resolveAttempt(tx, cashier, m.id, {
        operationId: randomUUID(),
        outcome: "check",
      }),
    );
    await round(A, { due: false });
    assert.equal(
      await stateOf(m.id),
      "review",
      "«Volver a consultar» re-read the provider",
    );
    const refunded = await attemptRow(m.id);
    assert.equal(refunded.error_code, "payments_refunded_before_settle");
    assert.equal((await tenderOf(m.id)).length, 0);
    // Refunded at the provider: «Sí se cobró: registrar» is refused (P2-MONEY-5).
    await rejects(
      resolve(fresh(A, ids.manager, "manager"), m.id, {
        outcome: "record",
        note: NOTE,
        confirmed: true,
      }),
      "payments_refunded_before_settle",
    );
    await rejects(
      resolve(fresh(A, ids.manager, "manager"), m.id, {
        outcome: "not_charged",
        note: NOTE,
        confirmed: true,
      }),
      "payments_not_approved",
    );
    await resolve(fresh(A, ids.manager, "manager"), m.id, {
      outcome: "refunded_at_provider",
      note: NOTE,
      confirmed: true,
    });
    assert.equal(await stateOf(m.id), "dismissed");
  });

  await test("webhooks: screened before any work — an unknown hook, a malformed token, another provider's path, a non-order topic, an id that is not live and an oversized body are answered 200 with no job and no write", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const live = await pending(o, terminals.mp);
    const jobs = () =>
      count(A, (tx) => tx`select count(*) as n from jobs where tenant_id=${A}`);
    const before = await jobs();
    const dropped = () =>
      logLines
        .filter((l) => l.includes('"message":"payments_webhook_dropped"'))
        .map((l) => JSON.parse(l).reason as string);
    const seen = dropped().length;
    const unknownHook =
      "https://pos.example.test/api/payments/webhooks/mercadopago/" +
      "A".repeat(22);
    const rid = randomUUID();
    await notify(
      unknownHook,
      mpNotification(live.ref, rid, fake.signMp(live.ref, rid)),
    );
    await notify(
      hooks.mercadopago.slice(0, -1) + "!",
      mpNotification(live.ref, rid),
    );
    await notify(
      hooks.mercadopago.replace("/mercadopago/", "/stripe/"),
      mpNotification(live.ref, rid),
    );
    // The Clip hook does not accept an MP notification (the account's provider must match).
    await notify(
      hooks.clip.replace("/clip/", "/mercadopago/"),
      mpNotification(live.ref, rid),
    );
    await notify(hooks.mercadopago, {
      query: `data.id=${live.ref}&type=payment`,
      body: {
        action: "payment.created",
        type: "payment",
        data: { id: live.ref },
      },
    });
    await notify(
      hooks.mercadopago,
      mpNotification("ORDNOTLIVE000000000000000000", rid),
    );
    await notify(hooks.mercadopago, {
      ...mpNotification(live.ref, rid),
      body: {
        type: "order",
        data: { id: live.ref },
        padding: "x".repeat(20_000),
      },
    });
    assert.equal(await jobs(), before, "no screened notification wrote a job");
    assert.deepEqual(dropped().slice(seen), [
      "no_match",
      "format",
      "format",
      "no_match",
      "topic",
      "no_match",
      "body_size",
    ]);
    // A malformed JSON body is screened by the webhook's own parser: 200, empty (P2-SECURITY-6;
    // before, the app's parser answered 400 through the global error handler).
    const malformed = await fetch(
      hookOrigin +
        new URL(hooks.mercadopago).pathname +
        `?data.id=${live.ref}&type=order`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"type":"order","data":',
      },
    );
    assert.deepEqual([malformed.status, await malformed.text()], [200, ""]);
    // A body over 16 KB never reaches the app's 256 KB parser (also 200, empty).
    const huge = await fetch(hookOrigin + new URL(hooks.mercadopago).pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(100_000) }),
    });
    assert.deepEqual([huge.status, await huge.text()], [200, ""]);
    assert.equal(await jobs(), before, "no screened notification wrote a job");
    assert.deepEqual(dropped().slice(seen + 7), ["format", "body_size"]);
    // The same notification, well formed, queues exactly one re-read.
    await notify(
      hooks.mercadopago,
      mpNotification(live.ref, rid, fake.signMp(live.ref, rid)),
    );
    assert.equal(await jobs(), before + 1);
    // A burst for the same charge while that re-read waits is coalesced into it (P2-SECURITY-4):
    // no second job, no second event.
    for (let i = 0; i < 5; i++) {
      const burst = randomUUID();
      await notify(
        hooks.mercadopago,
        mpNotification(live.ref, burst, fake.signMp(live.ref, burst)),
      );
    }
    assert.equal(await jobs(), before + 1, "one waiting re-read per charge");
    assert.deepEqual(dropped().slice(-5), Array(5).fill("coalesced"));
    // Notifications are limited per client network: IPv6 per /56, also for compressed text
    // (P2-SECURITY-3: the hand-rolled key split one /64 into 257 keys).
    assert.equal(webhookIpKey("2001:db8::1"), webhookIpKey("2001:db8::2"));
    assert.equal(webhookIpKey("2001:db8::1"), webhookIpKey("2001:db8::ab12"));
    assert.equal(
      webhookIpKey("2001:db8:1:a::1"),
      webhookIpKey("2001:db8:1:ab::1"),
    );
    assert.notEqual(
      webhookIpKey("2001:db8:1:100::1"),
      webhookIpKey("2001:db8:1:a::1"),
    );
    assert.equal(webhookIpKey("203.0.113.7"), "203.0.113.7");
    await write(cashier, (tx) =>
      requestCancel(tx, cashier, live.id, { operationId: randomUUID() }),
    );
    assert.equal(await drive(live.id, ["cancelled"]), "cancelled");
  });

  await test("devices: «Buscar terminales» (managers, at most one queued a minute) refreshes the cache; the MP mode switch (step-up) reaches the device; a second PDV is refused by MP and changes nothing", async () => {
    await rejects(
      write(cashier, (tx) => requestDevices(tx, cashier, "mercadopago")),
      "forbidden",
    );
    await write(manager, (tx) => requestDevices(tx, manager, "mercadopago"));
    await write(manager, (tx) => requestDevices(tx, manager, "mercadopago"));
    assert.ok(
      (await count(
        A,
        (
          tx,
        ) => tx`select count(*) as n from jobs where tenant_id=${A} and kind='payments_devices'
        and state='available'`,
      )) <= 1,
      "a burst of refreshes queues one discovery a minute",
    );
    await drain(A);
    await rejects(
      write(manager, (tx) =>
        requestDeviceMode(
          tx,
          stale(A, ids.manager, "manager"),
          "NEWLAND_N950__FAKE0002",
          {
            operationId: randomUUID(),
            mode: "PDV",
          },
        ),
      ),
      "step_up_required",
    );
    // Two PDV devices on one point of sale: MP refuses; the cache keeps the real modes.
    await write(manager, (tx) =>
      requestDeviceMode(
        tx,
        fresh(A, ids.manager, "manager"),
        "NEWLAND_N950__FAKE0002",
        {
          operationId: randomUUID(),
          mode: "PDV",
        },
      ),
    );
    await drain(A);
    const modes = async () =>
      Object.fromEntries(
        (await write(manager, (tx) => providersView(tx, manager))).devices
          .filter((d) => d.provider === "mercadopago")
          .map((d) => [d.deviceId, d.operatingMode]),
      );
    assert.deepEqual(await modes(), {
      NEWLAND_N950__FAKE0001: "PDV",
      NEWLAND_N950__FAKE0002: "STANDALONE",
    });
    await write(manager, (tx) =>
      requestDeviceMode(
        tx,
        fresh(A, ids.manager, "manager"),
        "NEWLAND_N950__FAKE0001",
        {
          operationId: randomUUID(),
          mode: "STANDALONE",
        },
      ),
    );
    await drain(A);
    assert.equal((await modes()).NEWLAND_N950__FAKE0001, "STANDALONE");
    await write(manager, (tx) =>
      requestDeviceMode(
        tx,
        fresh(A, ids.manager, "manager"),
        "NEWLAND_N950__FAKE0001",
        {
          operationId: randomUUID(),
          mode: "PDV",
        },
      ),
    );
    await drain(A);
    assert.equal((await modes()).NEWLAND_N950__FAKE0001, "PDV");
    // A charge waiting on that device: its mode does not change under it (P2-PROVIDERS-10).
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const live = await pending(o, terminals.mp);
    await rejects(
      write(manager, (tx) =>
        requestDeviceMode(
          tx,
          fresh(A, ids.manager, "manager"),
          "NEWLAND_N950__FAKE0001",
          { operationId: randomUUID(), mode: "STANDALONE" },
        ),
      ),
      "payments_terminal_busy",
    );
    await write(cashier, (tx) =>
      requestCancel(tx, cashier, live.id, { operationId: randomUUID() }),
    );
    assert.equal(await drive(live.id, ["cancelled"]), "cancelled");
    // A push that dies before anything was sent (no worker runtime for its three claims)
    // declines the charge: the order and the terminal are free again (P2-MONEY-7).
    const o2 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const deadBefore = dead.length;
    setPaymentsRuntime(null);
    let never: AttemptView;
    try {
      never = await start(cashier, o2.id, terminals.mp, o2.total);
      for (let i = 0; i < 3; i++) await round(A);
    } finally {
      setPaymentsRuntime(runtime);
    }
    assert.deepEqual(
      dead.splice(deadBefore).map((d) => d.kind),
      ["payments_push"],
      "removed here: the suite's final check expects none",
    );
    const row = await attemptRow(never.id);
    assert.deepEqual(
      [row.state, row.error_code],
      ["declined", "payments_provider_unavailable"],
    );
    assert.equal(fake.chargeFor(never.id), null, "nothing reached MP");
  });

  await test("15. lock order: starts on two terminals, a settle (job and sync), a void, a discount, an offline sale, a public pay-first accept, a drawer close and the club's work on linked orders (a member linked, a reward redeemed, the after-payment reconcile; R16) run together with no deadlock and no retry (LO-R9)", async () => {
    // R16 (loyalty 038 is in): the club on, a member linked to the charge that settles in the
    // burst, another holding one reward. Fictional people and phones.
    await asOwner(
      A,
      (tx) =>
        tx`insert into restaurant_account_settings(tenant_id,privacy_notice_url)
        values(${A},'https://example.com/aviso-de-privacidad')`,
    );
    const program = (await write(owner, (tx) =>
      getLoyaltySettings(tx, owner),
    )) as LoyaltySettingsView;
    await write(owner, (tx) =>
      saveLoyaltySettings(
        tx,
        owner,
        {
          operationId: randomUUID(),
          expectedVersion: program.version,
          enabled: true,
          programName: "",
          stampsRequired: 10,
          stampThreshold: 40000,
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
        legalConfig(LEGAL_CI_ENV),
      ),
    );
    const enroll = async (name: string, phone: string) =>
      (
        await write(cashier, (tx) =>
          enrollMember(tx, cashier, {
            operationId: randomUUID(),
            phone,
            country: "MX",
            name,
            consent: true,
            marketingOptIn: false,
          }),
        )
      ).member;
    const ana = await enroll("Ana Ficticia", "5550001501");
    const beto = await enroll("Beto Ficticio", "5550001502");
    await write(manager, (tx) =>
      adjustMember(tx, manager, beto.id, {
        operationId: randomUUID(),
        stamps: 0,
        rewards: 1,
        reason: "correction",
        note: "Saldo de prueba",
      }),
    );
    const link = (s: Session, orderId: string, memberId: string) =>
      write(s, (tx) =>
        linkOrderMember(tx, s, orderId, {
          operationId: randomUUID(),
          memberId,
        }),
      );
    // Prepared: an approved charge on a linked order waiting for its settle, and a pay-first
    // public hold.
    const settling = await newOrder(cashier, [
      { product: ids.taco, quantity: 1 },
    ]);
    await link(cashier, settling.id, ana.id);
    const x = await pending(settling, terminals.mpStandalone);
    fake.approve(x.ref, { ...TEST_CARD });
    await workerOnly();
    assert.equal(await stateOf(x.id), "approved");
    const linkId = randomUUID();
    const hex = () =>
      randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const holdId = randomUUID();
    await asOwner(A, async (tx) => {
      await tx`insert into public_links(tenant_id,id,token_hash,kind,channel,label,created_by)
        values(${A},${linkId},${hex()},'counter','qr','Mostrador',${ids.owner})`;
      const [n] =
        await tx`insert into public_hold_numbers(tenant_id,business_date,value)
        values(${A},${today},1) on conflict(tenant_id,business_date)
        do update set value=public_hold_numbers.value+1 returning value`;
      const lineId = randomUUID();
      await tx`insert into public_order_holds(tenant_id,id,link_id,operation_id,request_hash,
          status_key_hash,business_date,number,channel,mode,table_id,policy,lines,priced,quoted_total,
          menu_revision,order_operation_id,created_at,expires_at)
        values(${A},${holdId},${linkId},${randomUUID()},${"0".repeat(64)},${hex()},${today},${n.value},
          'qr','takeaway',null,'pay_first',
          ${tx.json([{ id: lineId, productId: ids.taco, quantity: 1, options: [] }])},
          ${tx.json([{ id: lineId, quantity: 1, name: { es: "Taco ficticio", en: "Taco ficticio" }, optionNames: [], unitPrice: 4500, total: 4500 }])},
          4500,0,${randomUUID()},now(),now()+interval '30 minutes')`;
    });
    const o1 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const o2 = await newOrder(cashier2, [{ product: ids.taco, quantity: 1 }]);
    const o4 = await newOrder(cashier, [{ product: ids.taco, quantity: 2 }]);
    const o5 = await newOrder(cashier, [{ product: ids.taco, quantity: 2 }]);
    const o6 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const discountBody = {
      operationId: randomUUID(),
      expectedVersion: o5.version,
      scope: "order",
      kind: "percent",
      percentBps: 1000,
      reasonCode: "courtesy",
      note: "",
    };
    const managerAt2 = session(A, ids.manager, "manager", ids.device2);
    // Beto's reward on one taco of o7, as RedeemRewardDialog sends it.
    const o7 = await newOrder(cashier2, [{ product: ids.taco, quantity: 2 }]);
    const reward = rewardDiscountRequest(program, o7, o7.lines[0].id);
    const redeemBody = {
      operationId: randomUUID(),
      memberId: beto.id,
      expectedVersion: o7.version,
      lineId: o7.lines[0].id,
      ...discountExpectation(o7, planDiscount(o7, reward)),
    };
    const results = await noRetries("payments P2 burst", () =>
      Promise.allSettled([
        start(cashier, o1.id, terminals.mp, o1.total),
        start(cashier2, o2.id, terminals.clip, o2.total),
        webRunner.drainTenant(A),
        syncAttemptCore(sql, A, x.id),
        write(manager, (tx) =>
          voidLines(
            tx,
            manager,
            o4.id,
            {
              operationId: randomUUID(),
              expectedVersion: o4.version,
              lines: [{ lineId: o4.lines[0].id, quantity: 1 }],
              reason: "Cliente cambió de opinión",
              stockDisposition: "no_return",
            },
            ids.manager,
          ),
        ),
        write(manager, (tx) =>
          applyDiscount(
            tx,
            manager,
            o5.id,
            {
              ...discountBody,
              ...discountExpectation(
                o5,
                planDiscount(o5, discountBody as never),
              ),
            },
            { approverId: null },
          ),
        ),
        write(cashier, (tx) =>
          newTender(
            tx,
            cashier,
            o6.id,
            {
              method: "cash",
              amount: o6.total,
              tip: 0,
              received: o6.total,
              reference: "",
              externalConfirmed: false,
            },
            ids.drawer1,
          ),
        ),
        write(cashier, (tx) =>
          acceptHold(tx, cashier, holdId, {
            operationId: randomUUID(),
            target: { kind: "new" },
            payment: { amount: 4500, received: 5000, method: "cash" },
          }),
        ),
        write(managerAt2, (tx) =>
          closeCash(tx, managerAt2, {
            operationId: randomUUID(),
            counted: 0,
            reason: "Corte de prueba del burst",
          }),
        ),
        // R16: the club's work on linked orders, against the same orders and members.
        link(cashier, o1.id, ana.id),
        write(cashier2, (tx) => redeemReward(tx, cashier2, o7.id, redeemBody)),
        write(cashier, (tx) => reconcileOrder(tx, A, settling.id)).catch(
          (e) => {
            // A link that changed between its read and its lock: the job retries (row 49).
            if (e.code !== "loyalty_retry") throw e;
          },
        ),
      ]),
    );
    while (webRunner.running() > 0) await sleep(10);
    // The close and the start on the same register race: either the close wins (the start then
    // needs an open drawer) or the start does (the close then waits for the charge).
    for (const r of results)
      if (r.status === "rejected")
        assert.ok(
          ["drawer_required", "payments_attempt_unresolved"].includes(
            (r.reason as { code?: string }).code ?? "",
          ),
          String(r.reason),
        );
    results.forEach((r, i) => {
      if (i !== 1 && i !== 8)
        assert.equal(r.status, "fulfilled", `burst item ${i}`);
    });
    assert.equal(await stateOf(x.id), "settled");
    assert.equal((await tenderOf(x.id)).length, 1);
    for (const r of results.slice(0, 2))
      if (r.status === "fulfilled")
        await cancelCreated((r.value as AttemptView).id);
    // The settle's club hook queued the reconcile; it stamps Ana once, and Beto's reward is spent.
    await webRunner.drainTenant(A);
    while (webRunner.running() > 0) await sleep(10);
    const ledger = await asOwner(
      A,
      (tx) => tx`select m.name,m.stamps,m.rewards,m.rewards_redeemed,
          (select coalesce(sum(stamps_delta),0)::int from loyalty_ledger l where l.member_id=m.id) as ledger_stamps,
          (select coalesce(sum(rewards_delta),0)::int from loyalty_ledger l where l.member_id=m.id) as ledger_rewards,
          (select string_agg(kind||':'||stamps_delta,',' order by created_at,id) from loyalty_ledger l
            where l.member_id=m.id and l.order_id=${settling.id}) as settled_kinds
        from loyalty_members m where m.id in (${ana.id},${beto.id}) order by m.name`,
    );
    assert.deepEqual(
      ledger.map((m: any) => [
        m.name,
        m.stamps,
        m.rewards,
        m.rewards_redeemed,
        m.ledger_stamps,
        m.ledger_rewards,
        m.settled_kinds,
      ]),
      [
        ["Ana Ficticia", 1, 0, 0, 1, 0, "earn:1"],
        ["Beto Ficticio", 0, 0, 1, 0, 0, null],
      ],
      "the terminal settle stamped the linked member once; the reward unit is spent",
    );
    const redeemed = await write(cashier2, (tx) => getOrder(tx, o7.id));
    assert.equal(
      redeemed.discounts!.filter((d) => d.reasonCode === "loyalty_reward")
        .length,
      1,
    );
  });

  await test("stranded charges (P2-MONEY-1, P2-PROVIDERS-1, P2-CONCURRENCY-1): a rotated MP token fails the account only after MP's own verification refuses it; every pending MP charge keeps its poll chain and reaches unknown at its deadline; the owner reconnects while charges are live and the worker re-reads them; a 403 for a terminal of another account declines that charge and leaves the account alone", async () => {
    const pollsQueued = async (attemptId: string) =>
      count(
        A,
        (
          tx,
        ) => tx`select count(*)::int as n from jobs where kind='payments_poll'
          and state in ('queued','available','running') and payload->>'attemptId'=${attemptId}`,
      );
    const o1 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const o2 = await newOrder(cashier, [{ product: ids.taco, quantity: 2 }]);
    const a1 = await pending(o1, terminals.mp);
    const a2 = await pending(o2, terminals.mpStandalone);
    // The owner rotates the token in MP's panel during service: every call with the old one is 401.
    const oldToken = fake.mp.accessToken;
    const rotated = "TEST-mp-rotated-token-not-real-0001";
    fake.mp.accessToken = rotated;
    const alertsBefore = alerts.length;
    await round(A);
    assert.deepEqual((await caps(A)).mercadopago, {
      enabled: false,
      reason: "payments_credentials_rejected",
    });
    assert.ok(
      fake.requests.some((r) => r.path === "/mp/users/me"),
      "the account failed only after its verification call was refused",
    );
    assert.ok(
      alerts
        .slice(alertsBefore)
        .some((x) =>
          /payments_account_failed .*provider=mercadopago/.test(x.body),
        ),
    );
    // Both charges stay pending with a live chain (before: the chain ended with the first link
    // whose account could not be opened, and nothing could ever move them again).
    await round(A);
    await round(A);
    for (const a of [a1, a2]) {
      assert.equal(await stateOf(a.id), "pending");
      assert.equal(await pollsQueued(a.id), 1, "one live chain per charge");
    }
    // «Volver a consultar» while the account is failed keeps one chain (never two).
    await resolve(cashier, a1.id, { outcome: "check" });
    await round(A);
    assert.equal(await pollsQueued(a1.id), 1);
    // The diner pays a1 on the terminal; MP's notification cannot be matched (account failed).
    fake.approve(a1.ref, { ...TEST_CARD });
    // At the deadline (expiry + 2 min) both become unknown: resolvable, alerted, never stuck.
    await asOwner(
      A,
      (
        tx,
      ) => tx`update payment_attempts set sent_at = now() - interval '13 minutes'
        where id in (${a1.id}, ${a2.id})`,
    );
    await round(A);
    for (const a of [a1, a2]) {
      const row = await attemptRow(a.id);
      assert.deepEqual(
        [row.state, row.error_code],
        ["unknown", "payments_provider_not_configured"],
      );
      assert.equal(await pollsQueued(a.id), 0);
    }
    assert.ok(
      alerts
        .slice(alertsBefore)
        .some((x) =>
          /payments_attempt_unknown .*reason=account_unusable/.test(x.body),
        ),
    );
    // The owner repairs the account while both charges are live (before: payments_attempts_live).
    const repaired = await write(owner, (tx) =>
      saveCredentials(
        tx,
        fresh(A, ids.owner, "owner"),
        "mercadopago",
        { accessToken: rotated, webhookSecret: FAKE.mpSecret },
        { appEnv: "test", appUrl: "https://pos.example.test" },
      ),
    );
    hooks.mercadopago = repaired.webhookUrl;
    // Verified, active, and each live charge is re-read: a1 was paid → settled by itself.
    assert.equal(await drive(a1.id, ["settled"]), "settled");
    assert.deepEqual((await caps(A)).mercadopago, { enabled: true });
    assert.equal((await tenderOf(a1.id)).length, 1);
    // a2 is still on the terminal at MP: pending again with a chain; the cashier cancels it.
    assert.equal(await drive(a2.id, ["pending"]), "pending");
    await write(cashier, (tx) =>
      requestCancel(tx, cashier, a2.id, { operationId: randomUUID() }),
    );
    assert.equal(await drive(a2.id, ["cancelled"]), "cancelled");
    // A 403 for a terminal linked to another account declines that charge only.
    const o3 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    fake.next("mercadopago", "terminalNotOwned");
    const v3 = await start(cashier, o3.id, terminals.mp, o3.total);
    assert.equal(
      await drive(v3.id, ["declined", "unknown", "pending"]),
      "declined",
    );
    assert.equal(
      (await attemptRow(v3.id)).error_code,
      "payments_terminal_not_linked",
    );
    assert.deepEqual((await caps(A)).mercadopago, { enabled: true });
    // The suite's other restaurant still uses the original token: put it back for both.
    fake.mp.accessToken = oldToken;
    const back = await write(owner, (tx) =>
      saveCredentials(
        tx,
        fresh(A, ids.owner, "owner"),
        "mercadopago",
        { accessToken: oldToken, webhookSecret: FAKE.mpSecret },
        { appEnv: "test", appUrl: "https://pos.example.test" },
      ),
    );
    hooks.mercadopago = back.webhookUrl;
    await drain(A);
    assert.deepEqual((await caps(A)).mercadopago, { enabled: true });
  });

  await test("upload boxes (P2-SECURITY-1): a save replaced before its job ran is wiped when that job runs; a box whose job never ran is swept by the disconnect; a verification job that goes dead wipes its box and fails the account instead of leaving it «Verificando»", async () => {
    const ownerFreshB = session(B, ids.ownerB, "owner", ids.deviceB, {});
    const env = { appEnv: "test", appUrl: "https://pos.example.test" };
    const body = { accessToken: FAKE.mpToken, webhookSecret: FAKE.mpSecret };
    const save = () =>
      write(ownerB, (tx) =>
        saveCredentials(tx, ownerFreshB, "mercadopago", body, env),
      );
    const uploads = () =>
      asOwner(
        B,
        (
          tx,
        ) => tx`select id, payload_secret is not null as sealed from payment_secrets
          where tenant_id=${B} and purpose='credentials_upload' order by created_at`,
      ) as Promise<{ id: string; sealed: boolean }[]>;
    const before = (await uploads()).length;
    // The owner saves, then saves again before the worker ran (Reemplazar while «Verificando»).
    await save();
    await save();
    await drain(B);
    assert.deepEqual((await caps(B)).mercadopago, { enabled: true });
    assert.deepEqual(
      (await uploads()).slice(before).map((u) => u.sealed),
      [false, false],
      "both boxes wiped (before: the superseded one stayed sealed)",
    );
    // A save whose job is cancelled from Operations never runs; another save activates.
    await save();
    await admin`update jobs set state='dead', error_code='cancelled'
      where tenant_id=${B} and kind='payments_credentials' and state='available'`;
    await save();
    await drain(B);
    assert.equal(
      (await uploads()).filter((u) => u.sealed).length,
      1,
      "the cancelled job's box is still sealed",
    );
    // Disconnect: payments_wipe also sweeps it; nothing of B stays sealed.
    await write(ownerB, (tx) =>
      disableProvider(tx, ownerFreshB, "mercadopago"),
    );
    await drain(B);
    const [{ n }] = await asOwner(
      B,
      (tx) => tx`select count(*)::int as n from payment_secrets
        where tenant_id=${B} and payload_secret is not null and purpose in
          ('credentials_upload','mp_credentials')`,
    );
    assert.equal(n, 0, "a disconnect leaves no sealed MP credential or upload");
    // The worker serves no provider for three claims: the job goes dead, and its hook wipes the
    // box and fails the account (before: «Verificando» forever, the box sealed).
    setPaymentsRuntime(null);
    const deadBefore = dead.length;
    try {
      await save();
      for (let i = 0; i < 3; i++) await round(B);
    } finally {
      setPaymentsRuntime(runtime);
    }
    assert.deepEqual(
      dead.splice(deadBefore).map((d) => d.kind),
      ["payments_credentials"],
      "removed here: the suite's final check expects none",
    );
    assert.deepEqual((await caps(B)).mercadopago, {
      enabled: false,
      reason: "payments_provider_unreachable",
    });
    assert.equal((await uploads()).filter((u) => u.sealed).length, 0);
    // The owner saves again and it works.
    await save();
    await drain(B);
    assert.deepEqual((await caps(B)).mercadopago, { enabled: true });
  });

  await test("vault rekey (LD-76 deviation 1): with a new key first, a credential is re-sealed on use and vault:rekey lists both restaurants through 037's worker listing policy and re-seals the rest under the new kid (counts only, no value logged); the listing needs its flag and gives the web login nothing; charging works once the old key is dropped", async () => {
    const secrets = async (tenantId: string) =>
      Object.fromEntries(
        (
          await asOwner(
            tenantId,
            (tx) => tx`select purpose,kid,payload_secret from payment_secrets
              where tenant_id=${tenantId} and purpose in ('mp_credentials','clip_credentials') and wiped_at is null`,
          )
        ).map((r: any) => [r.purpose, { kid: r.kid, box: r.payload_secret }]),
      );
    // Restaurant B connects Mercado Pago (its earlier tries failed) while t1 is the only key.
    await write(ownerB, (tx) =>
      saveCredentials(
        tx,
        session(B, ids.ownerB, "owner", ids.deviceB, {}),
        "mercadopago",
        { accessToken: FAKE.mpToken, webhookSecret: FAKE.mpSecret },
        { appEnv: "test", appUrl: "https://pos.example.test" },
      ),
    );
    await drain(B);
    assert.deepEqual((await caps(B)).mercadopago, { enabled: true });
    const beforeB = await secrets(B);
    assert.equal(beforeB.mp_credentials.kid, "t1");
    const before = await secrets(A);
    assert.deepEqual(
      [before.mp_credentials.kid, before.clip_credentials.kid],
      ["t1", "t1"],
    );
    // The listing policy: only the jobs login, only inside a transaction that sets the flag.
    const listed = (flag: boolean, login: typeof sql) =>
      login.begin(async (tx) => {
        if (flag)
          await tx`select set_config('app.payments_rekey_list', 'on', true)`;
        return (
          await tx`select distinct tenant_id from payment_provider_accounts
            where tenant_id in (${A}, ${B}) order by tenant_id`
        ).map((r: any) => r.tenant_id as string);
      });
    assert.deepEqual(await listed(true, worker), [A, B].sort());
    assert.deepEqual(await listed(false, worker), [], "no flag, no listing");
    assert.deepEqual(
      await listed(true, sql),
      [],
      "the flag lists nothing for the web login",
    );
    // The web login still has no SELECT on payment_secrets, with or without the flag.
    await rejects(sql`select count(*) from payment_secrets`, "42501");
    await rejects(
      sql.begin(async (tx) => {
        await tx`select set_config('app.payments_rekey_list', 'on', true)`;
        await tx`select set_config('app.tenant_id', ${A}, true)`;
        return tx`select payload_secret from payment_secrets`;
      }),
      "42501",
    );
    runtime.ring = parseCredentialKeyring(`${keyTwo},${keyOne}`);
    await publish(["mercadopago", "clip"]);
    // A charge opens the MP box with the old kid and writes it back under the new one.
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const a = await pending(o, terminals.mp);
    let now = await secrets(A);
    assert.equal(now.mp_credentials.kid, "t2", "re-sealed on use");
    assert.notEqual(now.mp_credentials.box, before.mp_credentials.box);
    assert.equal(now.clip_credentials.kid, "t1", "not used yet");
    const lines: Record<string, unknown>[] = [];
    // No tenant list given: the script finds both restaurants on its own.
    const result = await rekeyPaymentSecrets(worker, runtime.ring, (l) =>
      lines.push(l),
    );
    assert.ok(result.tenants >= 2, "both restaurants listed");
    assert.ok(result.resealed >= 2, "A's Clip and B's Mercado Pago");
    assert.equal(result.failed, 0);
    now = await secrets(A);
    assert.deepEqual(
      [now.mp_credentials.kid, now.clip_credentials.kid],
      ["t2", "t2"],
    );
    const nowB = await secrets(B);
    assert.equal(nowB.mp_credentials.kid, "t2", "the other restaurant too");
    assert.notEqual(nowB.mp_credentials.box, beforeB.mp_credentials.box);
    for (const line of lines)
      assert.doesNotMatch(JSON.stringify(line), /not-real|NotReal/);
    // Safe to run again: nothing left under the old kid in either restaurant.
    const again = await rekeyPaymentSecrets(worker, runtime.ring);
    assert.equal(
      (await secrets(A)).clip_credentials.box,
      now.clip_credentials.box,
      "a second run re-seals nothing it already moved",
    );
    assert.equal(
      (await secrets(B)).mp_credentials.box,
      nowB.mp_credentials.box,
    );
    assert.equal(again.failed, 0);
    // The old key dropped: the pending charge still settles, and a Clip charge works.
    runtime.ring = parseCredentialKeyring(keyTwo);
    await publish(["mercadopago", "clip"]);
    fake.approve(a.ref, { ...TEST_CARD });
    assert.equal(await drive(a.id, ["settled"]), "settled");
    const o2 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const c = await pending(o2, terminals.clip);
    fake.approve(c.ref, { ...TEST_CARD });
    assert.equal(await drive(c.id, ["settled"]), "settled");
  });

  await test("archive or deactivation vs start (P2-CONCURRENCY-7): an archive holding the terminal row first makes a start on it wait and then refuse (payments_terminal_inactive), a deactivation too; a start first makes the archive wait and then refuse (payments_terminal_busy), and a deactivation too (LD-82: «Activa» off is refused while a charge on the terminal is live, a rename is not); never a created attempt on an archived terminal, no retries", async () => {
    const mgr = fresh(A, ids.manager, "manager");
    const device = "NEWLAND_N950__FAKE0003";
    const terminal = await integrated(
      "MP Carrera",
      "mercadopago_point",
      device,
      350,
    );
    const version = async (terminalId: string) =>
      Number(
        (
          await asOwner(
            A,
            (tx) =>
              tx`select version from payment_terminals where id=${terminalId}`,
          )
        )[0].version,
      );
    const attemptsOn = (terminalId: string) =>
      count(
        A,
        (tx) =>
          tx`select count(*) as n from payment_attempts where terminal_id=${terminalId}`,
      );
    /** Until a backend of this database waits on a lock (true) or `done` settles first (false). */
    const waiter = async (done: Promise<unknown>) => {
      let settled = false;
      void done.then(
        () => (settled = true),
        () => (settled = true),
      );
      for (let i = 0; i < 400 && !settled; i++) {
        const [w] = await admin`select count(*)::int as n from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock'`;
        if (w.n > 0) return true;
        await sleep(10);
      }
      return false;
    };
    /** One transaction that runs `fn`, then holds its locks until released. */
    const held = <T>(s: Session, fn: (tx: Tx) => Promise<T>) => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let ready!: () => void;
      const done = new Promise<void>((r) => (ready = r));
      const result = write(s, async (tx) => {
        const value = await fn(tx);
        ready();
        await gate;
        return value;
      });
      // A failure before `ready` must not leave the caller waiting on it.
      void result.catch(() => ready());
      return { result, done, release };
    };
    const startOn = (o: Order) =>
      write(cashier, (tx) =>
        startTerminalCharge(tx, cashier, {
          operationId: randomUUID(),
          orderId: o.id,
          terminalId: terminal,
          amount: o.total,
          tip: 0,
        }),
      );

    // (a) The archive holds the row (FOR UPDATE, archived, not committed); a start arrives.
    const o1 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const archiveFrom = await version(terminal);
    const archive = held(mgr, (tx) =>
      archiveTerminal(tx, mgr, terminal, {
        operationId: randomUUID(),
        expectedVersion: archiveFrom,
      }),
    );
    await archive.done;
    const a = await noRetries("archive first", async () => {
      const starting = startOn(o1);
      const waited = await waiter(starting);
      archive.release();
      const [archived, started] = await Promise.allSettled([
        archive.result,
        starting,
      ]);
      return { waited, archived, started };
    });
    assert.equal(a.archived.status, "fulfilled");
    assert.equal(a.waited, true, "the start waits for the archive's row lock");
    assert.equal(a.started.status, "rejected");
    assert.equal(
      (a.started as PromiseRejectedResult).reason?.code,
      "payments_terminal_inactive",
    );
    assert.equal(
      await attemptsOn(terminal),
      0,
      "no attempt on the archived terminal",
    );

    // (b) A start holds the row (FOR SHARE, its created attempt not committed); an archive arrives.
    const second = await integrated(
      "MP Carrera 2",
      "mercadopago_point",
      device,
      350,
    );
    const o2 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const starting = held(cashier, (tx) =>
      startTerminalCharge(tx, cashier, {
        operationId: randomUUID(),
        orderId: o2.id,
        terminalId: second,
        amount: o2.total,
        tip: 0,
      }),
    );
    await starting.done;
    const secondFrom = await version(second);
    const b = await noRetries("start first", async () => {
      const archiving = write(mgr, (tx) =>
        archiveTerminal(tx, mgr, second, {
          operationId: randomUUID(),
          expectedVersion: secondFrom,
        }),
      );
      const waited = await waiter(archiving);
      starting.release();
      const [started, archived] = await Promise.allSettled([
        starting.result,
        archiving,
      ]);
      return { waited, started, archived };
    });
    assert.equal(b.started.status, "fulfilled");
    assert.equal(b.waited, true, "the archive waits for the start's row lock");
    assert.equal(b.archived.status, "rejected");
    assert.equal(
      (b.archived as PromiseRejectedResult).reason?.code,
      "payments_terminal_busy",
    );
    const live = (b.started as PromiseFulfilledResult<AttemptView>).value;
    assert.equal(await stateOf(live.id), "created");
    await write(cashier, (tx) =>
      requestCancel(tx, cashier, live.id, { operationId: randomUUID() }),
    );
    assert.equal(await stateOf(live.id), "cancelled");

    // (c) A deactivation (Guardar with «Activa» off) holding the row first: the start refuses too.
    const o3 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const deactivateFrom = await version(second);
    const deactivate = held(mgr, (tx) =>
      saveTerminal(tx, mgr, {
        operationId: randomUUID(),
        terminalId: second,
        name: "MP Carrera 2",
        kind: "mercadopago_point",
        providerDeviceId: device,
        feeBp: 350,
        active: false,
        expectedVersion: deactivateFrom,
      }),
    );
    await deactivate.done;
    const c = await noRetries("deactivation first", async () => {
      const started = write(cashier, (tx) =>
        startTerminalCharge(tx, cashier, {
          operationId: randomUUID(),
          orderId: o3.id,
          terminalId: second,
          amount: o3.total,
          tip: 0,
        }),
      );
      const waited = await waiter(started);
      deactivate.release();
      await deactivate.result;
      return { waited, started: await Promise.allSettled([started]) };
    });
    assert.equal(
      c.waited,
      true,
      "the start waits for the deactivation's row lock",
    );
    assert.equal(c.started[0].status, "rejected");
    assert.equal(
      (c.started[0] as PromiseRejectedResult).reason?.code,
      "payments_terminal_inactive",
    );
    assert.equal(await attemptsOn(second), 1, "only (b)'s cancelled attempt");
    const lastFrom = await version(second);
    await write(mgr, (tx) =>
      archiveTerminal(tx, mgr, second, {
        operationId: randomUUID(),
        expectedVersion: lastFrom,
      }),
    );

    // (d) LD-82: a deactivation is refused like an archive while a charge on the terminal is live.
    const third = await integrated(
      "MP Carrera 3",
      "mercadopago_point",
      device,
      350,
    );
    const save = (active: boolean, name: string, expectedVersion: number) =>
      write(mgr, (tx) =>
        saveTerminal(tx, mgr, {
          operationId: randomUUID(),
          terminalId: third,
          name,
          kind: "mercadopago_point",
          providerDeviceId: device,
          feeBp: 350,
          active,
          expectedVersion,
        }),
      );
    // (d1) A start holds the row (FOR SHARE, its created attempt not committed); «Activa» off
    // arrives, waits for the start and then refuses.
    const o4 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const starting4 = held(cashier, (tx) =>
      startTerminalCharge(tx, cashier, {
        operationId: randomUUID(),
        orderId: o4.id,
        terminalId: third,
        amount: o4.total,
        tip: 0,
      }),
    );
    await starting4.done;
    const thirdFrom = await version(third);
    const d = await noRetries("start before a deactivation", async () => {
      const deactivating = save(false, "MP Carrera 3", thirdFrom);
      const waited = await waiter(deactivating);
      starting4.release();
      const [started, deactivated] = await Promise.allSettled([
        starting4.result,
        deactivating,
      ]);
      return { waited, started, deactivated };
    });
    assert.equal(d.started.status, "fulfilled");
    assert.equal(
      d.waited,
      true,
      "the deactivation waits for the start's row lock",
    );
    assert.equal(d.deactivated.status, "rejected");
    assert.equal(
      (d.deactivated as PromiseRejectedResult).reason?.code,
      "payments_terminal_busy",
    );
    const live4 = (d.started as PromiseFulfilledResult<AttemptView>).value;
    // (d2) Still live: «Activa» off is refused again; a rename that keeps it active is not.
    await rejects(
      save(false, "MP Carrera 3", thirdFrom),
      "payments_terminal_busy",
    );
    await save(true, "MP Carrera Tres", thirdFrom);
    const [row4] = await asOwner(
      A,
      (tx) => tx`select active,name from payment_terminals where id=${third}`,
    );
    assert.deepEqual([row4.active, row4.name], [true, "MP Carrera Tres"]);
    // (d3) Once the charge is final the deactivation goes through.
    await write(cashier, (tx) =>
      requestCancel(tx, cashier, live4.id, { operationId: randomUUID() }),
    );
    assert.equal(await stateOf(live4.id), "cancelled");
    await save(false, "MP Carrera Tres", await version(third));
    const [off] = await asOwner(
      A,
      (tx) => tx`select active from payment_terminals where id=${third}`,
    );
    assert.equal(off.active, false);
    const thirdLast = await version(third);
    await write(mgr, (tx) =>
      archiveTerminal(tx, mgr, third, {
        operationId: randomUUID(),
        expectedVersion: thirdLast,
      }),
    );
  });

  await test("re-seal race (P2-CONCURRENCY-2): two worker steps that open one restaurant's credentials under an older kid at the same time both succeed; one re-seals, the other's compare-and-set touches nothing", async () => {
    // The first key active again (both keys stay known to every run's ring: the shared test
    // database keeps earlier runs' restaurants, which vault:rekey lists).
    runtime.ring = parseCredentialKeyring(`${keyOne},${keyTwo}`);
    await publish(["mercadopago", "clip"]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The first step opens (and re-seals) the MP box and keeps its transaction open.
    const first = tenant(worker, A, async (tx) => {
      const opened = await openAccount(tx, runtime, A, "mercadopago");
      await gate;
      return opened.credentials.provider;
    });
    await sleep(200);
    // The second read the old kid (the first has not committed) and re-seals too: its UPDATE
    // waits for the first, then finds the kid changed (before: 037 raised
    // payment_secret_reseal_invalid and the step's transaction aborted).
    const second = tenant(
      worker,
      A,
      async (tx) =>
        (await openAccount(tx, runtime, A, "mercadopago")).credentials.provider,
    );
    await sleep(200);
    release();
    assert.deepEqual(
      await noRetries("re-seal race", () => Promise.all([first, second])),
      ["mercadopago", "mercadopago"],
    );
    const [box] = await asOwner(
      A,
      (
        tx,
      ) => tx`select s.kid from payment_secrets s join payment_provider_accounts a
        on a.tenant_id=s.tenant_id and a.credential_secret_id=s.id
        where a.tenant_id=${A} and a.provider='mercadopago'`,
    );
    assert.equal(box.kid, "t1");
    // Charging works under the new key.
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const a = await pending(o, terminals.mp);
    fake.approve(a.ref, { ...TEST_CARD });
    assert.equal(await drive(a.id, ["settled"]), "settled");
  });

  await test("disconnect: refused while a charge is live; then the account is disabled, the worker wipes its credentials, /capabilities says not_connected and integrated starts stop", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const live = await pending(o, terminals.clip);
    await rejects(
      write(owner, (tx) =>
        disableProvider(tx, fresh(A, ids.owner, "owner"), "clip"),
      ),
      "payments_attempts_live",
    );
    await rejects(
      write(manager, (tx) =>
        disableProvider(tx, fresh(A, ids.manager, "manager"), "clip"),
      ),
      "forbidden",
    );
    await rejects(
      write(owner, (tx) =>
        disableProvider(tx, stale(A, ids.owner, "owner"), "clip"),
      ),
      "step_up_required",
    );
    fake.cancelOnTerminal(live.ref);
    assert.equal(await drive(live.id, ["cancelled"]), "cancelled");
    const view = await write(owner, (tx) =>
      disableProvider(tx, fresh(A, ids.owner, "owner"), "clip"),
    );
    assert.equal(
      view.accounts.find((x) => x.provider === "clip")?.state,
      "disabled",
    );
    await drain(A);
    const [{ n }] = await asOwner(
      A,
      (tx) => tx`select count(*)::int as n from payment_secrets
        where tenant_id=${A} and purpose='clip_credentials' and payload_secret is not null`,
    );
    assert.equal(n, 0, "the worker wiped the Clip credentials");
    assert.deepEqual((await caps(A)).clip, {
      enabled: false,
      reason: "not_connected",
    });
    assert.deepEqual((await caps(A)).mercadopago, { enabled: true });
    const o2 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    await rejects(
      start(cashier, o2.id, terminals.clip, o2.total),
      "payments_provider_not_configured",
    );
  });

  await test("credentials never leave the vault: after every flow above no table of either restaurant and no log line holds a credential or a notification token", async () => {
    const tokens = [hooks.mercadopago, hooks.clip].map((u) =>
      u.split("/").pop()!,
    );
    const values = [
      FAKE.mpToken,
      "TEST-mp-rotated-token-not-real-0001",
      FAKE.mpSecret,
      FAKE.clipKey,
      FAKE.clipSecret,
      ...tokens,
    ];
    await assertNowhere(A, values, "A after every flow");
    await assertNowhere(B, values, "B after every flow");
  });

  assert.deepEqual(fake.violations, [], "the fake saw no contract breach");
  assert.deepEqual(dead, [], "no payments job went dead");
  console.log(`payments P2 DB: ${checks} checks passed`);
} finally {
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
  await new Promise<void>((r) => hookServer.close(() => r()));
  await fake.close();
  await sql.end();
  await worker.end();
  await admin.end();
}
