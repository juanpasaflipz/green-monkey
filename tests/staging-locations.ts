import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
  throw Error("explicit_staging_locations_target_required");
const runLabel = process.env.QUALIFICATION_RUN ?? "";
if (!/^[a-z0-9-]{0,64}$/.test(runLabel))
  throw Error("invalid_qualification_run");
const path = `work/billing/staging-locations${runLabel ? "-" + runLabel : ""}.json`;
type State = {
  subject: string;
  guestSubject: string;
  locationOperation: string;
  inviteOperation: string;
  tenantId?: string;
  secondId?: string;
  quoteId?: string;
  subscriptionId?: string;
  completed?: boolean;
};
let state: State;
try {
  state = JSON.parse(await readFile(path, "utf8"));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  state = {
    subject: "locations-" + randomUUID(),
    guestSubject: "guest-" + randomUUID(),
    locationOperation: randomUUID(),
    inviteOperation: randomUUID(),
  };
  await writeFile(path, JSON.stringify(state), { mode: 0o600, flag: "wx" });
}
if (state.completed) throw Error("already_qualified_use_saved_evidence");
const save = () => writeFile(path, JSON.stringify(state), { mode: 0o600 });
const app = connect(process.env.DATABASE_URL!);
const worker = postgres(process.env.BILLING_DATABASE_URL!, { max: 1 });
try {
  await checkRole(app);
  async function actor(subject: string, email: string) {
    const cookie = await signInGoogleOwner(app, {
      issuer: "https://accounts.google.com",
      subject,
      email,
      name: "Synthetic location qualification",
    });
    const cookies = new Map([["gm_account", cookie]]);
    return async (
      path: string,
      body?: unknown,
      csrf?: string,
      expected = 200,
      extra: Record<string, string> = {},
    ) => {
      const r = await fetch(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; "),
          "Content-Type": "application/json",
          ...(csrf ? { "x-csrf-token": csrf } : {}),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20000),
      });
      assert.equal(r.status, expected, path);
      for (const value of r.headers.getSetCookie()) {
        const pair = value.split(";", 1)[0];
        const i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      return r.json();
    };
  }
  async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
    for (let i = 0; i < 45; i++) {
      const value = await read();
      if (done(value)) return value;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw Error("staging_location_timeout");
  }
  const api = await actor(state.subject, "locations-qualification@example.com");
  const account = await api("/api/auth/account");
  if (!state.tenantId) {
    const r = await api(
      "/api/auth/account/signup",
      {
        restaurantName: "Locations sandbox qualification",
        currency: "MXN",
        timezone: "America/Mexico_City",
        cutoff: 240,
        openingDays: [1, 2, 3, 4, 5, 6, 7],
        trialRequested: true,
      },
      account.csrf,
    );
    state.tenantId = r.tenantId;
    await save();
  }
  const initial = await until(
    () => api("/api/billing/status?tenantId=" + state.tenantId),
    (s) => s.entitlement?.status === "trialing",
  );
  const trialEnd = initial.entitlement.access_until;
  await api(
    "/api/auth/account/enter",
    { tenantId: state.tenantId },
    account.csrf,
  );
  const firstSession = await api("/api/session");
  if (!state.secondId) {
    const r = await api(
      "/api/auth/account/locations",
      {
        operationId: state.locationOperation,
        sourceTenantId: state.tenantId,
        restaurantName: "Second sandbox qualification location",
        currency: "MXN",
        timezone: "America/Mexico_City",
        cutoff: 240,
        openingDays: [1, 2, 3, 4, 5, 6, 7],
      },
      account.csrf,
    );
    state.secondId = r.tenantId;
    await save();
  }
  if (!state.quoteId) {
    await api(
      "/api/auth/account/enter",
      { tenantId: state.secondId },
      account.csrf,
      409,
    );
    const q = await api(
      "/api/billing/locations/quote",
      { tenantId: state.secondId },
      account.csrf,
      202,
    );
    state.quoteId = q.operationId;
    await save();
  }
  const quote = await until(
    () => api("/api/billing/status?tenantId=" + state.secondId),
    (s) =>
      (s.operation?.id === state.quoteId &&
        s.operation.state === "succeeded") ||
      s.entitlement?.status === "trialing",
  );
  if (quote.entitlement?.status !== "trialing") {
    assert.equal(quote.operation.result.amountDue, 0);
    assert.equal(quote.operation.result.locations, 2);
    await api(
      "/api/billing/locations/confirm",
      { quoteId: state.quoteId, consent: false },
      account.csrf,
      400,
    );
    await api(
      "/api/billing/locations/confirm",
      { quoteId: state.quoteId, consent: true },
      account.csrf,
      202,
    );
    await api(
      "/api/billing/locations/confirm",
      { quoteId: state.quoteId, consent: true },
      account.csrf,
      202,
    );
  }
  const activated = await until(
    () => api("/api/billing/status?tenantId=" + state.secondId),
    (s) => s.entitlement?.status === "trialing",
  );
  assert.equal(activated.entitlement.access_until, trialEnd);
  await api(
    "/api/auth/account/enter",
    { tenantId: state.secondId },
    account.csrf,
  );
  const secondSession = await api("/api/session");
  assert.notEqual(secondSession.tenantId, firstSession.tenantId);
  await api("/api/catalog", undefined, undefined, 409, {
    "x-tenant-id": firstSession.tenantId,
    "x-session-id": firstSession.id,
  });
  await api(
    "/api/auth/account/enter",
    { tenantId: state.tenantId },
    account.csrf,
  );
  assert.equal((await api("/api/session")).deviceId, firstSession.deviceId);
  const invitation = await api(
    "/api/auth/account/invitations",
    {
      operationId: state.inviteOperation,
      tenantId: state.secondId,
      email: "locations-guest@example.com",
      role: "manager",
    },
    account.csrf,
  );
  const guest = await actor(state.guestSubject, "locations-guest@example.com");
  const guestAccount = await guest("/api/auth/account");
  await guest(
    "/api/auth/account/enter",
    { tenantId: state.secondId },
    guestAccount.csrf,
    403,
  );
  await guest(
    "/api/auth/account/invitations/accept",
    { token: invitation.path.split("#invite=")[1] },
    guestAccount.csrf,
  );
  await guest(
    "/api/auth/account/enter",
    { tenantId: state.secondId },
    guestAccount.csrf,
  );
  assert.equal((await guest("/api/session")).role, "manager");
  await guest(
    "/api/billing/status?tenantId=" + state.secondId,
    undefined,
    undefined,
    403,
  );
  const [binding] =
    await worker`select b.* from organization_billing b join billing_locations l on l.organization_id=b.organization_id where l.tenant_id=${state.secondId!}`;
  const provider = stripeSandboxBilling({
    secretKey: process.env.STRIPE_SECRET_KEY!,
    accountId: process.env.STRIPE_EXPECTED_ACCOUNT_ID!,
    monthlyPriceId: process.env.STRIPE_PRICE_PRO_MONTHLY!,
    annualPriceId: process.env.STRIPE_PRICE_PRO_ANNUAL!,
    appUrl: origin,
  });
  const canonical = await provider.readSubscription({
    organizationId: binding.organization_id,
    customerId: binding.customer_id,
    subscriptionId: binding.subscription_id,
    interval: "month",
    locations: 2,
  });
  assert.equal(canonical.status, "trialing");
  assert.equal(canonical.accessUntil, trialEnd);
  state.subscriptionId = binding.subscription_id;
  await save();
  const canceled = await fetch(
    "https://api.stripe.com/v1/subscriptions/" + binding.subscription_id,
    {
      method: "DELETE",
      headers: {
        Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY,
        "Stripe-Version": STRIPE_BILLING_API_VERSION,
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  assert.equal(canceled.ok, true);
  for (const tenant of [state.tenantId, state.secondId])
    await until(
      () => api("/api/billing/status?tenantId=" + tenant),
      (s) => s.entitlement?.status === "canceled",
    );
  state.completed = true;
  await save();
  const version = await (await fetch(origin + "/api/version")).json();
  await writeFile(
    "docs/evidence/staging/locations.json",
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        origin,
        version,
        sandbox: true,
        syntheticIdentity: true,
        trialEndPreserved: true,
        quantity: 2,
        confirmationRequired: true,
        duplicateConfirmation: true,
        pendingEntryDenied: true,
        switching: true,
        deviceReused: true,
        staleTabRejected: true,
        managerInvitation: true,
        guestBillingDenied: true,
        canceledBothToFree: true,
        tenants: [state.tenantId, state.secondId],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Staging locations passed: trial quantity, explicit confirmation, activation, switching, device reuse, stale-tab rejection, invitation, billing ownership, and cancellation for both locations.",
  );
} finally {
  await worker.end();
  await app.end();
}
