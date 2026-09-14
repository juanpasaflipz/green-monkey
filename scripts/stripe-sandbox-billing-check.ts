import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  stripeSandboxBilling,
  STRIPE_BILLING_API_VERSION,
} from "../server/stripe-billing.js";
import { accessPlan } from "../shared/plans.js";
import assert from "node:assert/strict";
const path = "work/billing-sandbox-check.json";
await mkdir("work", { recursive: true });
// Saved IDs precede every creation; reruns never substitute a new operation.
let state: {
  organizationId: string;
  customerOperation: string;
  trialOperation: string;
  portalOperation: string;
  customerId?: string;
  subscriptionId?: string;
  trialVerified?: boolean;
  canceled?: boolean;
};
try {
  state = JSON.parse(await readFile(path, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  state = {
    organizationId: randomUUID(),
    customerOperation: randomUUID(),
    trialOperation: randomUUID(),
    portalOperation: randomUUID(),
  };
  await writeFile(path, JSON.stringify(state), { mode: 0o600, flag: "wx" });
}
const save = () => writeFile(path, JSON.stringify(state), { mode: 0o600 });
const provider = stripeSandboxBilling({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  accountId: process.env.STRIPE_EXPECTED_ACCOUNT_ID!,
  monthlyPriceId: process.env.STRIPE_PRICE_PRO_MONTHLY!,
  annualPriceId: process.env.STRIPE_PRICE_PRO_ANNUAL!,
  appUrl: "https://green-monkey-staging.up.railway.app",
});
if (!state.customerId) {
  const customer = await provider.createCustomer(
    state.organizationId,
    state.customerOperation,
  );
  state.customerId = customer.customerId;
  await save();
}
const scope = {
  organizationId: state.organizationId,
  customerId: state.customerId,
};
if (!state.subscriptionId) {
  const trial = await provider.createTrial(
    scope,
    "month",
    state.trialOperation,
  );
  state.subscriptionId = trial.subscriptionId;
  await save();
}
const binding = {
  ...scope,
  subscriptionId: state.subscriptionId,
  interval: "month" as const,
  locations: 1,
};
if (!state.canceled) {
  const entitlement = await provider.readSubscription(binding);
  assert.equal(entitlement.status, "trialing");
  assert.equal(accessPlan(entitlement), "pro");
  const days = (Date.parse(entitlement.accessUntil!) - Date.now()) / 86400000;
  assert.ok(days > 13 && days <= 14);
  state.trialVerified = true;
  await save();
  const repeated = await provider.createTrial(
    scope,
    "month",
    state.trialOperation,
  );
  assert.equal(repeated.subscriptionId, state.subscriptionId);
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
  if (!response.ok) throw Error("sandbox_cancel_failed");
  state.canceled = true;
  await save();
}
const canceled = await provider.readSubscription(binding);
assert.equal(canceled.status, "canceled");
assert.equal(accessPlan(canceled), "free");
await mkdir("docs/evidence", { recursive: true });
await writeFile(
  "docs/evidence/stripe-sandbox-trial.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      accountId: process.env.STRIPE_EXPECTED_ACCOUNT_ID,
      organizationId: state.organizationId,
      customerId: state.customerId,
      subscriptionId: state.subscriptionId,
      trialVerified: state.trialVerified,
      idempotentTrial: true,
      canceled: true,
      accessAfterCancellation: "free",
      livePayments: false,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Real sandbox trial, bounded Pro, same-key retry, cancellation and Free projection passed.",
);
