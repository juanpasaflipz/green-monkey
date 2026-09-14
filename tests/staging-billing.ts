import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import postgres from "postgres";
import { connect, checkRole } from "../server/db.js";
import { signInGoogleOwner } from "../server/owner-accounts.js";
import {
  stripeSandboxBilling,
  STRIPE_BILLING_API_VERSION,
} from "../server/stripe-billing.js";
const origin = "https://green-monkey-staging.up.railway.app";
const target = new URL(process.env.DATABASE_URL!);
if (
  process.env.STAGING_URL !== origin ||
  process.env.STAGING_ORIGIN_ALLOWLIST !== origin ||
  target.pathname !== "/green_monkey_staging" ||
  `${target.hostname}:${target.port || "5432"}${target.pathname}` !==
    process.env.QUALIFICATION_DATABASE_ALLOWLIST
)
  throw Error("explicit_staging_billing_target_required");
const phase = process.env.BILLING_CHECK_PHASE ?? "trial";
if (!["trial", "cancel"].includes(phase)) throw Error("invalid_phase");
const path = "work/billing/staging-fixture.json";
await mkdir("work/billing", { recursive: true });
let state: {
  subject: string;
  tenantId?: string;
  subscriptionId?: string;
  trialEnd?: string;
  portalUrl?: string;
  trialVerified?: boolean;
  portalCardVerified?: boolean;
  restartOperationId?: string;
  restartObservedAt?: string;
  cancelVerified?: boolean;
};
try {
  state = JSON.parse(await readFile(path, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  state = { subject: "billing-qualification-" + randomUUID() };
  await writeFile(path, JSON.stringify(state), { mode: 0o600, flag: "wx" });
}
const save = () => writeFile(path, JSON.stringify(state), { mode: 0o600 });
const sql = connect(process.env.DATABASE_URL!),
  worker = postgres(process.env.BILLING_DATABASE_URL!, { max: 1 });
try {
  await checkRole(sql);
  const cookie = await signInGoogleOwner(sql, {
    issuer: "https://accounts.google.com",
    subject: state.subject,
    email: "billing-qualification@example.com",
    name: "Synthetic billing qualification",
  });
  const cookies = new Map([["gm_account", cookie]]);
  async function api(
    path: string,
    body?: unknown,
    csrf?: string,
    expected = 200,
  ) {
    const response = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; "),
        "Content-Type": "application/json",
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, expected, path);
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";", 1)[0],
        i = pair.indexOf("=");
      cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return response.json();
  }
  async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
    for (let i = 0; i < 30; i++) {
      const value = await read();
      if (done(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw Error("staging_billing_timeout");
  }
  const account = await api("/api/auth/account");
  if (!state.tenantId) {
    const created = await api(
      "/api/auth/account/signup",
      {
        restaurantName: "Billing sandbox qualification",
        currency: "MXN",
        timezone: "America/Mexico_City",
        cutoff: 240,
        openingDays: [1, 2, 3, 4, 5, 6, 7],
        trialRequested: true,
      },
      account.csrf,
    );
    state.tenantId = created.tenantId;
    await save();
  }
  await api(
    "/api/auth/account/enter",
    { tenantId: state.tenantId },
    account.csrf,
  );
  const provider = stripeSandboxBilling({
    secretKey: process.env.STRIPE_SECRET_KEY!,
    accountId: process.env.STRIPE_EXPECTED_ACCOUNT_ID!,
    monthlyPriceId: process.env.STRIPE_PRICE_PRO_MONTHLY!,
    annualPriceId: process.env.STRIPE_PRICE_PRO_ANNUAL!,
    appUrl: origin,
  });
  if (phase === "trial") {
    assert.ok(
      !state.cancelVerified,
      "use existing cancellation evidence after cleanup",
    );
    const status = await until(
      () => api("/api/billing/status?tenantId=" + state.tenantId),
      (s) => s.entitlement?.status === "trialing",
    );
    assert.equal(status.billing.trial_used, true);
    assert.equal((await api("/api/plan")).plan, "pro");
    await api(
      "/api/billing/request",
      {
        tenantId: state.tenantId,
        kind: "trial",
        interval: "month",
        consent: true,
      },
      account.csrf,
      409,
    );
    const [binding] =
      await worker`select b.* from organization_billing b join billing_locations l on l.organization_id=b.organization_id where l.tenant_id=${state.tenantId}`;
    state.subscriptionId = binding.subscription_id;
    state.trialEnd = status.entitlement.access_until;
    const canonical = await provider.readSubscription({
      organizationId: binding.organization_id,
      customerId: binding.customer_id,
      subscriptionId: binding.subscription_id,
      interval: "month",
      locations: 1,
    });
    assert.equal(canonical.status, "trialing");
    assert.equal(canonical.accessUntil, state.trialEnd);
    await until(
      async () => {
        const [r] =
          await worker`select count(*)::int as n from billing_events where subscription_id=${state.subscriptionId!} and processed_at is not null`;
        return r.n;
      },
      (n) => n > 0,
    );
    state.trialVerified = true;
    await save();
    await api(
      "/api/billing/request",
      {
        tenantId: state.tenantId,
        kind: "portal",
        interval: "month",
        consent: true,
      },
      account.csrf,
      202,
    );
    const portal = await until(
      () => api("/api/billing/status?tenantId=" + state.tenantId),
      (s) => !!s.hostedUrl,
    );
    state.portalUrl = portal.hostedUrl;
    await save();
    console.log(
      "Deployed signup → durable no-card trial → Pro and real processed Stripe webhook passed. Existing-subscription portal ready privately.",
    );
  } else {
    assert.ok(state.trialVerified && state.subscriptionId);
    assert.ok(
      state.portalCardVerified &&
        state.restartOperationId &&
        state.restartObservedAt,
    );
    const restarted = await until(
      async () => {
        const [operation] =
          await worker`select state,completed_at,attempts from billing_operations where id=${state.restartOperationId!}`;
        return operation;
      },
      (operation) => operation?.state === "succeeded",
    );
    assert.ok(
      new Date(restarted.completed_at).getTime() >
        Date.parse(state.restartObservedAt),
    );
    const [binding] =
      await worker`select b.* from organization_billing b join billing_locations l on l.organization_id=b.organization_id where l.tenant_id=${state.tenantId}`;
    const before = await provider.readSubscription({
      organizationId: binding.organization_id,
      customerId: binding.customer_id,
      subscriptionId: binding.subscription_id,
      interval: "month",
      locations: 1,
    });
    if (!state.cancelVerified) {
      assert.equal(before.status, "trialing");
      assert.equal(
        before.accessUntil,
        state.trialEnd,
        "portal preserves original trial end",
      );
      const response = await fetch(
        "https://api.stripe.com/v1/subscriptions/" + state.subscriptionId,
        {
          method: "DELETE",
          headers: {
            Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY,
            "Stripe-Version": STRIPE_BILLING_API_VERSION,
          },
          signal: AbortSignal.timeout(15000),
        },
      );
      assert.ok(response.ok, "sandbox cancellation");
    }
    await until(
      () => api("/api/plan"),
      (p) => p.plan === "free",
    );
    await until(
      async () => {
        const [r] =
          await worker`select status from restaurant_entitlements where tenant_id=${state.tenantId!}`;
        return r.status;
      },
      (s) => s === "canceled",
    );
    state.cancelVerified = true;
    await save();
    const events =
      await worker`select id,processed_at from billing_events where subscription_id=${state.subscriptionId}`;
    await writeFile(
      "docs/evidence/staging/billing.json",
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          tenantId: state.tenantId,
          subscriptionId: state.subscriptionId,
          trialEnd: state.trialEnd,
          trialVerified: state.trialVerified,
          portalPreservedTrial: true,
          portalCardVerified: state.portalCardVerified,
          pendingOperationSurvivedRestart: true,
          cancellationToFree: true,
          processedEventCount: events.filter((e) => e.processed_at).length,
          livePayments: false,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      "Deployed canonical cancellation → Free verified; original trial end preserved and records retained.",
    );
  }
} finally {
  await sql.end();
  await worker.end();
}
