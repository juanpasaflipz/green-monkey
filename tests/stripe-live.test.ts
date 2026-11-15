import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { stripeBilling } from "../server/stripe-billing";
import { verifyStripeEvent } from "../server/stripe-webhook";
import {
  proPriceKeys,
  stripeKeyMatches,
  validatePrice,
  validateTaxRate,
} from "../server/stripe-catalog";
import { billingMode } from "../server/billing-mode";

// Fictional ids only. A live key here is a fixture string, never a real key.
const organizationId = "10000000-0000-4000-8000-000000000001";
const operationId = "20000000-0000-4000-8000-000000000001";
const scope = { organizationId, customerId: "cus_fixture" };
const metadata = {
  application: "green_monkey",
  purpose: "saas_subscription",
  organization_id: organizationId,
};
const tax = {
  mode: "tax_rate" as const,
  taxRateId: "txr_iva16",
  collectTaxId: true,
};
const live = {
  mode: "live" as const,
  secretKey: "sk_live_fixture",
  accountId: "acct_fixture",
  monthlyPriceId: "price_month",
  annualPriceId: "price_year",
  appUrl: "https://example.test",
  tax,
};
const price = (interval: "month" | "year", livemode: boolean) => ({
  id: "price_" + interval,
  active: true,
  livemode,
  product: "green_monkey_pro_v1",
  currency: "mxn",
  type: "recurring",
  billing_scheme: "per_unit",
  tax_behavior: "exclusive",
  lookup_key: proPriceKeys[interval],
  unit_amount: interval === "month" ? 79900 : 799000,
  recurring: { interval, interval_count: 1, usage_type: "licensed" },
});
const taxRate = (livemode: boolean) => ({
  id: "txr_iva16",
  object: "tax_rate",
  active: true,
  livemode,
  inclusive: false,
  percentage: 16,
  country: "MX",
  display_name: "IVA",
});

/** A fake Stripe that answers every object with the given livemode. */
function stripe(livemode: boolean) {
  const request = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/account") return Response.json({ id: "acct_fixture" });
    if (path.startsWith("/v1/customers"))
      return Response.json({ id: "cus_fixture", livemode, metadata });
    if (path.startsWith("/v1/prices/"))
      return Response.json(
        price(path.endsWith("year") ? "year" : "month", livemode),
      );
    if (path.startsWith("/v1/tax_rates/"))
      return Response.json(taxRate(livemode));
    if (path === "/v1/checkout/sessions")
      return Response.json({
        id: "cs_live_fixture",
        livemode,
        mode: "subscription",
        customer: "cus_fixture",
        client_reference_id: organizationId,
        url: "https://checkout.stripe.com/c/pay/fixture",
      });
    throw Error("unexpected fixture URL " + path);
  });
  return {
    request,
    posts: () =>
      request.mock.calls.filter(([, init]) => init?.method === "POST"),
  };
}

describe("billing mode switches", () => {
  const prod = { APP_ENV: "production" };
  it.each([
    [{}, "off"],
    [{ BILLING_SANDBOX_ENABLED: "true" }, "sandbox"],
    [{ ...prod, BILLING_LIVE_ENABLED: "true" }, "live"],
    [{ ...prod, BILLING_LIVE_ENABLED: "false" }, "off"],
  ] as const)("%j is %s", (env, mode) => {
    expect(billingMode(env)).toBe(mode);
  });
  it("never runs live outside production", () => {
    for (const APP_ENV of ["development", "test", "staging"])
      expect(() =>
        billingMode({ APP_ENV, BILLING_LIVE_ENABLED: "true" }),
      ).toThrow("billing_live_production_only");
  });
  it("refuses both switches together and an unclear live value", () => {
    expect(() =>
      billingMode({
        ...prod,
        BILLING_SANDBOX_ENABLED: "true",
        BILLING_LIVE_ENABLED: "true",
      }),
    ).toThrow("billing_mode_conflict");
    for (const value of ["1", "yes", "TRUE", "on"])
      expect(() =>
        billingMode({ ...prod, BILLING_LIVE_ENABLED: value }),
      ).toThrow("billing_mode_invalid");
  });
});

describe("live Stripe transport", () => {
  it("accepts only live keys in live mode and only test keys in sandbox", () => {
    expect(stripeKeyMatches("sk_live_fixture", "live")).toBe(true);
    expect(stripeKeyMatches("rk_live_fixture", "live")).toBe(true);
    expect(stripeKeyMatches("sk_test_fixture", "live")).toBe(false);
    expect(stripeKeyMatches("sk_live_fixture", "sandbox")).toBe(false);
    const request = vi.fn<typeof fetch>();
    expect(() =>
      stripeBilling({ ...live, secretKey: "sk_test_fixture" }, request),
    ).toThrow("stripe_billing_live_config_required");
    expect(() =>
      stripeBilling(
        { ...live, mode: "sandbox", secretKey: "sk_live_fixture" },
        request,
      ),
    ).toThrow("stripe_billing_sandbox_config_required");
    expect(request).not.toHaveBeenCalled();
  });
  it("never runs live without IVA", () => {
    const request = vi.fn<typeof fetch>();
    expect(() =>
      stripeBilling(
        { ...live, tax: { mode: "off", taxRateId: null, collectTaxId: false } },
        request,
      ),
    ).toThrow("stripe_billing_live_config_required");
    expect(request).not.toHaveBeenCalled();
  });
  it("creates a taxed checkout when every object is live", async () => {
    const s = stripe(true);
    const service = stripeBilling(live, s.request);
    await service.createCheckout(scope, "month", 1, operationId);
    const form = s.posts()[0][1]?.body as URLSearchParams;
    expect(form.get("subscription_data[default_tax_rates][0]")).toBe(
      "txr_iva16",
    );
    expect(form.get("tax_id_collection[enabled]")).toBe("true");
  });
  it("refuses a test-mode object before creating anything in live mode", async () => {
    const s = stripe(false);
    const service = stripeBilling(live, s.request);
    await expect(
      service.createCheckout(scope, "month", 1, operationId),
    ).rejects.toThrow();
    expect(s.posts()).toHaveLength(0);
  });
  it("refuses a live object in sandbox mode", async () => {
    const s = stripe(true);
    const service = stripeBilling(
      { ...live, mode: "sandbox", secretKey: "sk_test_fixture" },
      s.request,
    );
    await expect(
      service.createCheckout(scope, "month", 1, operationId),
    ).rejects.toThrow();
    expect(s.posts()).toHaveLength(0);
  });
  it("validates prices and the IVA rate by mode", () => {
    expect(validatePrice(price("year", true), "year", "live").id).toBe(
      "price_year",
    );
    expect(() => validatePrice(price("year", false), "year", "live")).toThrow(
      "stripe_catalog_price_mismatch",
    );
    expect(validateTaxRate(taxRate(true), "live").id).toBe("txr_iva16");
    expect(() => validateTaxRate(taxRate(true), "sandbox")).toThrow(
      "stripe_catalog_tax_rate_mismatch",
    );
  });
});

describe("live webhook verification", () => {
  const secret = "whsec_fixture";
  const now = 1_800_000_000;
  const signed = (livemode: boolean) => {
    const body = Buffer.from(
      JSON.stringify({
        id: "evt_fixture",
        object: "event",
        livemode,
        type: "customer.subscription.updated",
        created: now,
        data: { object: { object: "subscription", id: "sub_fixture" } },
      }),
    );
    const digest = createHmac("sha256", secret)
      .update(now + ".")
      .update(body)
      .digest("hex");
    return { body, signature: `t=${now},v1=${digest}` };
  };
  it("a live endpoint accepts live events and refuses test events", () => {
    const l = signed(true);
    expect(
      verifyStripeEvent(l.body, l.signature, secret, "live", now * 1000).id,
    ).toBe("evt_fixture");
    const t = signed(false);
    expect(() =>
      verifyStripeEvent(t.body, t.signature, secret, "live", now * 1000),
    ).toThrow("stripe_webhook_invalid");
  });
  it("a sandbox endpoint refuses live events", () => {
    const l = signed(true);
    expect(() =>
      verifyStripeEvent(l.body, l.signature, secret, "sandbox", now * 1000),
    ).toThrow("stripe_webhook_invalid");
  });
});
