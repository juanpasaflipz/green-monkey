import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import {
  stripeSandboxBilling,
  STRIPE_BILLING_API_VERSION,
} from "../server/stripe-billing.js";
const trial = JSON.parse(
  await readFile("work/billing-sandbox-check.json", "utf8"),
);
if (!trial.canceled || !trial.customerId)
  throw Error("completed_sandbox_trial_check_required");
const path = "work/billing-hosted-check.json";
let state: {
  configOperation: string;
  checkoutOperation: string;
  portalOperation: string;
  configurationId?: string;
  checkoutId?: string;
  portalId?: string;
  expired?: boolean;
};
try {
  state = JSON.parse(await readFile(path, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  state = {
    configOperation: randomUUID(),
    checkoutOperation: randomUUID(),
    portalOperation: randomUUID(),
  };
  await writeFile(path, JSON.stringify(state), { mode: 0o600, flag: "wx" });
}
const save = () => writeFile(path, JSON.stringify(state), { mode: 0o600 });
const secret = process.env.STRIPE_SECRET_KEY!;
if (!/^(sk|rk)_test_/.test(secret)) throw Error("sandbox_required");
async function call(path: string, form?: URLSearchParams, key?: string) {
  const r = await fetch("https://api.stripe.com/v1" + path, {
    method: form ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + secret,
      "Stripe-Version": STRIPE_BILLING_API_VERSION,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(form ? { body: form } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Error("sandbox_hosted_check_http_" + r.status);
  return r.json();
}
const account = await call("/account");
assert.equal(account.id, process.env.STRIPE_EXPECTED_ACCOUNT_ID);
if (!state.configurationId) {
  const c = await call(
    "/billing_portal/configurations",
    new URLSearchParams({
      "business_profile[headline]": "Green Monkey — sandbox",
      "features[payment_method_update][enabled]": "true",
      "features[invoice_history][enabled]": "true",
      "features[subscription_cancel][enabled]": "true",
      "features[subscription_cancel][mode]": "at_period_end",
      "features[subscription_update][enabled]": "false",
    }),
    "gm-portal-config:" + state.configOperation,
  );
  assert.equal(c.livemode, false);
  assert.match(c.id, /^bpc_/);
  state.configurationId = c.id;
  await save();
}
await writeFile(
  ".env.stripe-portal",
  `STRIPE_PORTAL_CONFIG_ID=${state.configurationId}\n`,
  { mode: 0o600 },
);
const provider = stripeSandboxBilling({
  secretKey: secret,
  accountId: process.env.STRIPE_EXPECTED_ACCOUNT_ID!,
  monthlyPriceId: process.env.STRIPE_PRICE_PRO_MONTHLY!,
  annualPriceId: process.env.STRIPE_PRICE_PRO_ANNUAL!,
  portalConfigurationId: state.configurationId,
  appUrl: "https://green-monkey-staging.up.railway.app",
});
const scope = {
  organizationId: trial.organizationId,
  customerId: trial.customerId,
};
if (!state.portalId) {
  const portal = await provider.createPortal(scope, state.portalOperation);
  state.portalId = portal.sessionId;
  await save();
}
if (!state.checkoutId) {
  const checkout = await provider.createCheckout(
    scope,
    "year",
    1,
    state.checkoutOperation,
  );
  state.checkoutId = checkout.sessionId;
  await save();
  const repeat = await provider.createCheckout(
    scope,
    "year",
    1,
    state.checkoutOperation,
  );
  assert.equal(repeat.sessionId, checkout.sessionId);
}
const checkout = await provider.readCheckout(scope, state.checkoutId!);
if (!state.expired) {
  assert.equal(checkout.status, "open");
  assert.equal(checkout.subscription, null);
  await call(
    "/checkout/sessions/" + state.checkoutId + "/expire",
    new URLSearchParams(),
    "gm-expire:" + state.checkoutOperation,
  );
  state.expired = true;
  await save();
}
assert.equal(
  (await provider.readCheckout(scope, state.checkoutId!)).status,
  "expired",
);
await writeFile(
  "docs/evidence/stripe-sandbox-hosted.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      accountId: account.id,
      configurationId: state.configurationId,
      portalSessionCreated: true,
      checkoutSessionCreated: true,
      checkoutSameKeyRetry: true,
      checkoutExpired: true,
      paidCheckoutCompleted: false,
      livePayments: false,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Sandbox portal, annual Checkout creation/retry, canonical session read and expiry passed; no paid checkout completed.",
);
