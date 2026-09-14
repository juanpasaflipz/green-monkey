import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "dotenv";
import { STRIPE_BILLING_API_VERSION } from "../server/stripe-billing.js";
const secret = process.env.STRIPE_SECRET_KEY!;
if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(secret))
  throw Error("sandbox_required");
const url = "https://green-monkey-staging.up.railway.app/api/billing/webhook";
async function call(path: string, form?: URLSearchParams, key?: string) {
  const response = await fetch("https://api.stripe.com/v1" + path, {
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
  if (!response.ok) throw Error("sandbox_webhook_http_" + response.status);
  return response.json();
}
const account = await call("/account");
if (account.id !== process.env.STRIPE_EXPECTED_ACCOUNT_ID)
  throw Error("sandbox_account_mismatch");
let saved: Record<string, string> | undefined;
try {
  saved = parse(await readFile(".env.stripe-webhook", "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
if (saved) {
  const endpoint = await call(
    "/webhook_endpoints/" + saved.STRIPE_WEBHOOK_ENDPOINT_ID,
  );
  if (endpoint.url !== url || endpoint.livemode !== false)
    throw Error("saved_webhook_mismatch");
  console.log("Saved sandbox webhook verified.");
} else {
  let op: { id: string; createdAt: string };
  const path = "work/billing-webhook-operation.json";
  try {
    op = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    op = { id: randomUUID(), createdAt: new Date().toISOString() };
    await writeFile(path, JSON.stringify(op), { mode: 0o600, flag: "wx" });
  }
  if (Date.now() - Date.parse(op.createdAt) > 23 * 3600000)
    throw Error("old_webhook_operation_requires_review");
  const form = new URLSearchParams({
    url,
    api_version: STRIPE_BILLING_API_VERSION,
    description: "Green Monkey staging sandbox billing",
    "metadata[application]": "green_monkey",
  });
  for (const event of [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "customer.subscription.paused",
    "customer.subscription.resumed",
    "customer.subscription.trial_will_end",
    "invoice.paid",
    "invoice.payment_failed",
    "invoice.voided",
    "invoice.marked_uncollectible",
  ])
    form.append("enabled_events[]", event);
  const endpoint = await call(
    "/webhook_endpoints",
    form,
    "gm-webhook:" + op.id,
  );
  if (
    endpoint.url !== url ||
    endpoint.livemode !== false ||
    !/^we_[A-Za-z0-9]+$/.test(endpoint.id) ||
    !/^whsec_[A-Za-z0-9]+$/.test(endpoint.secret)
  )
    throw Error("webhook_response_mismatch");
  await writeFile(
    ".env.stripe-webhook",
    `STRIPE_WEBHOOK_ENDPOINT_ID=${endpoint.id}\nSTRIPE_WEBHOOK_SECRET=${endpoint.secret}\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log("Sandbox webhook created; signing secret saved privately.");
}
