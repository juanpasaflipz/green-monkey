import "dotenv/config";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import { billingRuntime } from "../server/billing-runtime.js";
import { DomainError } from "../shared/domain.js";
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { billingStore, checkBillingRole } from "../server/billing-store.js";
import {
  signInGoogleOwner,
  withOwner,
  createOwnerRestaurant,
  ownerCookie,
} from "../server/owner-accounts.js";
const { runtime, migration } = isolatedTarget(process.env);
const admin = postgres(migration, { max: 1 }),
  app = postgres(runtime, { max: 4 });
const role = "gm_billing_test_" + randomBytes(6).toString("hex");
const password = randomBytes(32).toString("hex");
const cookies: string[] = [];
const accounts: string[] = [],
  tenants: string[] = [],
  orgs: string[] = [];
let worker: postgres.Sql | undefined;
try {
  await admin.unsafe(
    `create role "${role}" login password '${password}' nosuperuser nobypassrls`,
  );
  await admin.unsafe(`grant gm_billing_worker to "${role}"`);
  await admin.unsafe(
    `grant connect on database "${new URL(migration).pathname.slice(1)}" to "${role}"`,
  );
  const u = new URL(runtime);
  u.username = role;
  u.password = password;
  worker = postgres(u.href, { max: 4 });
  await checkBillingRole(worker);
  await assert.rejects(
    checkBillingRole(app),
    /restricted_billing_role_required/,
  );
  const store = billingStore(worker);
  for (let i = 0; i < 2; i++) {
    const cookie = await signInGoogleOwner(app, {
      issuer: "https://accounts.google.com",
      subject: randomUUID(),
      email: "billing-fixture@example.com",
      name: "Billing fixture",
    });
    cookies.push(cookie);
    const account = ownerCookie(cookie).accountId;
    accounts.push(account);
    const r = await withOwner(app, cookie, undefined, (tx, a) =>
      createOwnerRestaurant(tx, a, {
        trialRequested: true,
        restaurantName: "Billing fixture",
        currency: "MXN",
        timezone: "America/Mexico_City",
        cutoff: 240,
        openingDays: [1],
      }),
    );
    tenants.push(r.tenantId);
    const [o] =
      await admin`select organization_id from restaurants where id=${r.tenantId}`;
    orgs.push(o.organization_id);
  }
  await assert.rejects(
    store.request(accounts[1], tenants[0], "trial", "month"),
    /forbidden/,
  );
  await assert.rejects(store.status(accounts[1], tenants[0]), /forbidden/);
  const requests = await Promise.all(
    Array.from({ length: 6 }, () =>
      store.request(accounts[0], tenants[0], "trial", "month"),
    ),
  );
  assert.equal(
    new Set(requests.map((r) => r.operationId)).size,
    1,
    "concurrent requests share durable operation",
  );
  await assert.rejects(
    app`insert into restaurant_entitlements(tenant_id,status,source) values(${tenants[0]},'free','stripe')`,
    /permission denied/,
  );
  await assert.rejects(
    app`insert into billing_events(id,subscription_id) values('evt_Forbidden','sub_Forbidden')`,
    /permission denied/,
  );
  await assert.rejects(
    store.request(accounts[0], tenants[0], "trial", "year"),
    /billing_request_pending/,
  );
  const claims = await Promise.all([
    store.claim(),
    store.claim(),
    store.claim(),
  ]);
  const op = claims.find(Boolean)!;
  assert.equal(claims.filter(Boolean).length, 1, "only one org lease");
  await assert.rejects(
    worker`update billing_operations set payload='{}' where id=${op.id}`,
    /billing_operation_immutable/,
  );
  await admin`update billing_operations set lease_until=now()-interval '1 second' where id=${op.id}`;
  const recovered = await store.claim();
  assert.ok(recovered);
  assert.equal(recovered.id, op.id);
  assert.equal(
    await store.complete(op.id, op.lease_token, { customerId: "cus_Stale" }),
    false,
    "expired worker cannot write",
  );
  assert.equal(
    await store.complete(recovered.id, recovered.lease_token, {
      customerId: "cus_BillingFixture",
    }),
    true,
  );
  const trial = await store.claim();
  assert.equal(trial?.kind, "trial");
  await store.event("evt_BillingFixture", "sub_BillingFixture");
  await store.event("evt_BillingFixture", "sub_BillingFixture");
  await store.complete(trial!.id, trial!.lease_token, {
    subscriptionId: "sub_BillingFixture",
    trialEnd: new Date(Date.now() + 86400000).toISOString(),
  });
  await assert.rejects(
    store.request(accounts[0], tenants[0], "trial", "month"),
    /trial_already_used/,
  );
  await assert.rejects(
    store.request(accounts[0], tenants[0], "checkout", "month"),
    /billing_use_existing_subscription/,
  );
  await store.schedule();
  const reconcile = await store.claim();
  assert.equal(reconcile?.kind, "reconcile");
  await store.complete(
    reconcile!.id,
    reconcile!.lease_token,
    {},
    {
      status: "active",
      accessUntil: new Date(Date.now() + 86400000).toISOString(),
      source: "stripe",
    },
  );
  assert.equal(
    (await store.status(accounts[0], tenants[0])).entitlement?.status,
    "active",
  );
  assert.equal((await store.status(accounts[1], tenants[1])).entitlement, null);
  const [event] =
    await admin`select count(*)::int as n,bool_and(processed_at is not null) as processed from billing_events where id='evt_BillingFixture'`;
  assert.equal(event.n, 1);
  assert.equal(event.processed, true);
  await store.event("evt_BillingPastDue", "sub_BillingFixture");
  await store.schedule();
  const past = await store.claim();
  await store.complete(
    past!.id,
    past!.lease_token,
    {},
    { status: "past_due", accessUntil: null, source: "stripe" },
  );
  assert.equal(
    (await store.status(accounts[0], tenants[0])).entitlement?.access_until,
    null,
    "past_due never invents grace",
  );
  await store.request(accounts[1], tenants[1], "checkout", "year");
  await store.signupIntents();
  const [intents] =
    await admin`select bool_and(processed_at is not null) as processed from signup_billing_intents where tenant_id in (${tenants[0]},${tenants[1]})`;
  assert.equal(
    intents.processed,
    true,
    "later owner choice does not stall signup intent processing",
  );
  const old = await store.claim();
  await admin`update billing_operations set lease_until=now()-interval '1 second',first_attempt_at=now()-interval '24 hours' where id=${old!.id}`;
  assert.equal(await store.claim(), null);
  assert.equal(
    (await store.status(accounts[1], tenants[1])).operation?.state,
    "review",
  );
  await assert.rejects(
    worker`insert into billing_locations(organization_id,tenant_id) values(${orgs[1]},${tenants[0]})`,
    /duplicate key|foreign key/,
  );
  const runtimeBilling = await billingRuntime(
    app,
    {
      DATABASE_URL: runtime,
      BILLING_DATABASE_URL: u.href,
      BILLING_SANDBOX_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_test_fixture",
      STRIPE_EXPECTED_ACCOUNT_ID: "acct_fixture",
      STRIPE_PRICE_PRO_MONTHLY: "price_month",
      STRIPE_PRICE_PRO_ANNUAL: "price_year",
      STRIPE_PORTAL_CONFIG_ID: "bpc_fixture",
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
      APP_URL: "http://127.0.0.1:3003",
    },
    { runWorker: false },
  );
  const http = express();
  http.use("/webhook", runtimeBilling.webhook);
  http.use(express.json());
  http.use(cookieParser());
  http.use("/billing", runtimeBilling.routes);
  http.use(
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
  const server = http.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const origin = "http://127.0.0.1:" + address.port;
  try {
    assert.equal(
      (await fetch(origin + "/billing/status?tenantId=" + tenants[0])).status,
      401,
    );
    assert.equal(
      (
        await fetch(origin + "/billing/status?tenantId=" + tenants[0], {
          headers: { cookie: "gm_account=" + cookies[1] },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + "/billing/request", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie: "gm_account=" + cookies[0],
            "x-csrf-token": "wrong",
          },
          body: JSON.stringify({
            tenantId: tenants[0],
            kind: "portal",
            interval: "month",
            consent: true,
          }),
        })
      ).status,
      403,
    );
    const raw = JSON.stringify({
      id: "evt_HttpFixture",
      object: "event",
      livemode: false,
      type: "customer.subscription.updated",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "sub_BillingFixture",
          object: "subscription",
          status: "active",
        },
      },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature =
      "t=" +
      timestamp +
      ",v1=" +
      createHmac("sha256", "whsec_fixture")
        .update(timestamp + "." + raw)
        .digest("hex");
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await fetch(origin + "/webhook", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "stripe-signature": signature,
            },
            body: raw,
          })
        ).status,
        200,
      );
    assert.equal(
      (
        await fetch(origin + "/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": signature,
          },
          body: raw + " ",
        })
      ).status,
      400,
    );
    const [inbox] =
      await admin`select count(*)::int as n from billing_events where id='evt_HttpFixture'`;
    assert.equal(inbox.n, 1);
    assert.equal(
      (await store.status(accounts[0], tenants[0])).entitlement?.status,
      "past_due",
      "event snapshot never directly grants access",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtimeBilling.close();
  }
  console.log(
    "Billing DB checks passed: ownership, six-way request dedupe, restricted grants, immutable operations, exclusive leases, restart recovery, stale-write fencing, one trial, duplicate events, isolated grants, past-due revocation and old-key review.",
  );
} finally {
  for (const org of orgs) {
    await admin`delete from billing_events where subscription_id in(select subscription_id from organization_billing where organization_id=${org})`;
    await admin`delete from billing_operations where organization_id=${org}`;
    await admin`delete from billing_locations where organization_id=${org}`;
    await admin`delete from organization_billing where organization_id=${org}`;
  }
  for (const tenant of tenants) {
    for (const table of [
      "signup_billing_intents",
      "restaurant_entitlements",
      "audit",
      "owner_memberships",
      "employees",
    ])
      await admin.unsafe(`delete from ${table} where tenant_id=$1`, [tenant]);
    await admin`delete from restaurants where id=${tenant}`;
  }
  for (const account of accounts) {
    await admin`delete from organizations where created_by_account=${account}`;
    await admin`delete from owner_sessions where account_id=${account}`;
    await admin`delete from owner_accounts where id=${account}`;
  }
  await worker?.end();
  await app.end();
  await admin.unsafe(
    `revoke connect on database "${new URL(migration).pathname.slice(1)}" from "${role}"`,
  );
  await admin.unsafe(`revoke gm_billing_worker from "${role}"`);
  await admin.unsafe(`drop role "${role}"`);
  await admin.end();
}
