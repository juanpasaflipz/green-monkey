import { describe, it, expect, vi } from "vitest";
import {
  PRO_OFFER,
  PRO_ANNUAL_SAVING_MINOR,
  PLAN_FEATURES,
} from "../shared/plans";
import {
  provisionStripeSandboxCatalog,
  validateSandboxPrice,
  validateSandboxTaxRate,
  provisionStripeSandboxTaxRate,
  proPriceKeys,
} from "../server/stripe-catalog";

const price = (interval: "month" | "year") => ({
  id: "price_" + interval,
  active: true,
  livemode: false,
  product: "green_monkey_pro_v1",
  currency: "mxn",
  type: "recurring",
  billing_scheme: "per_unit",
  tax_behavior: "exclusive",
  lookup_key: proPriceKeys[interval],
  unit_amount: interval === "month" ? 79900 : 799000,
  recurring: { interval, interval_count: 1, usage_type: "licensed" },
});
describe("approved Pro offer", () => {
  it("bills annually for exactly ten months and includes kiosk without employee fees", () => {
    expect(PRO_OFFER.annualMinor).toBe(PRO_OFFER.monthlyMinor * 10);
    expect(PRO_ANNUAL_SAVING_MINOR).toBe(159800);
    expect(PRO_OFFER.trialDays).toBe(14);
    expect(PRO_OFFER.trialRequiresCard).toBe(false);
    expect(PRO_OFFER.perEmployeeFee).toBe(false);
    expect(PLAN_FEATURES.pro).toContain("kiosk");
  });
  it.each([
    { unit_amount: 799 },
    { currency: "usd" },
    { livemode: true },
    { tax_behavior: "inclusive" },
    { product: "unrelated" },
    { active: false },
    {
      recurring: {
        interval: "year",
        interval_count: 1,
        usage_type: "licensed",
      },
    },
  ])("rejects provider price drift %j", (override) => {
    expect(() =>
      validateSandboxPrice({ ...price("month"), ...override }, "month"),
    ).toThrow("stripe_catalog_price_mismatch");
  });
});
describe("Stripe sandbox catalog provisioning", () => {
  it("rejects a live key before contacting Stripe", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      provisionStripeSandboxCatalog("sk_live_fixture", "acct_fixture", request),
    ).rejects.toThrow("stripe_sandbox_key_required");
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects a different account before any mutation", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ id: "acct_other" }),
    );
    await expect(
      provisionStripeSandboxCatalog("sk_test_fixture", "acct_fixture", request),
    ).rejects.toThrow("stripe_account_mismatch");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("reconciles a lost product response and repeated runs without duplicate products or prices", async () => {
    let product: unknown = null,
      lost = true;
    const prices = new Map<string, unknown>();
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/account")
        return Response.json({ id: "acct_fixture" });
      if (
        init?.method === "GET" &&
        url.pathname === "/v1/products/green_monkey_pro_v1"
      )
        return product
          ? Response.json(product)
          : Response.json(
              { error: { code: "resource_missing" } },
              { status: 404 },
            );
      if (init?.method === "POST" && url.pathname === "/v1/products") {
        expect(
          (init.headers as Record<string, string>)["Idempotency-Key"],
        ).toBe("green-monkey-product-v1");
        product = {
          id: "green_monkey_pro_v1",
          name: "Green Monkey Pro",
          active: true,
          livemode: false,
          metadata: {
            application: "green_monkey",
            purpose: "saas_subscription",
          },
        };
        if (lost) {
          lost = false;
          throw Error("fictional timeout containing sk_test_fixture");
        }
        return Response.json(product);
      }
      if (init?.method === "GET" && url.pathname === "/v1/prices") {
        const p = prices.get(url.searchParams.get("lookup_keys[]")!);
        return Response.json({ data: p ? [p] : [], has_more: false });
      }
      if (init?.method === "POST" && url.pathname === "/v1/prices") {
        const form = init.body as URLSearchParams;
        const interval = form.get("recurring[interval]") as "month" | "year";
        expect(form.get("unit_amount")).toBe(
          String(price(interval).unit_amount),
        );
        const p = price(interval);
        prices.set(p.lookup_key, p);
        return Response.json(p);
      }
      throw Error("Unexpected request");
    });
    await expect(
      provisionStripeSandboxCatalog("sk_test_fixture", "acct_fixture", request),
    ).rejects.toThrow(/^stripe_catalog_request_uncertain_rerun_to_reconcile$/);
    const result = await provisionStripeSandboxCatalog(
      "sk_test_fixture",
      "acct_fixture",
      request,
    );
    expect(result.monthlyPriceId).toBe("price_month");
    expect(result.annualPriceId).toBe("price_year");
    await expect(
      provisionStripeSandboxCatalog("sk_test_fixture", "acct_fixture", request),
    ).resolves.toEqual(result);
    const posts = request.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(posts).toHaveLength(3);
  });
});

describe("SaaS IVA tax rate (account 031, GAP-6)", () => {
  const rate = {
    id: "txr_iva16",
    object: "tax_rate",
    active: true,
    livemode: false,
    inclusive: false,
    percentage: 16,
    country: "MX",
    display_name: "IVA",
    jurisdiction: "MX",
  };
  it("validateSandboxTaxRate accepts MX 16% exclusive active sandbox rate; rejects inclusive, other percentage, inactive, livemode, other country", () => {
    expect(validateSandboxTaxRate(rate).id).toBe("txr_iva16");
    for (const override of [
      { inclusive: true },
      { percentage: 8 },
      { active: false },
      { livemode: true },
      { country: "US" },
      { display_name: "VAT" },
      { id: "price_1" },
      { object: "price" },
    ])
      expect(() => validateSandboxTaxRate({ ...rate, ...override })).toThrow(
        "stripe_catalog_tax_rate_mismatch",
      );
  });
});

describe("SaaS IVA tax rate provisioning (account 031)", () => {
  const rate = {
    id: "txr_iva16",
    object: "tax_rate",
    active: true,
    livemode: false,
    inclusive: false,
    percentage: 16,
    country: "MX",
    display_name: "IVA",
    metadata: { green_monkey_tax: "iva16" },
  };
  const fake = (existing: unknown[]) =>
    vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v1/account") return Response.json({ id: "acct_fixture" });
      if (path === "/v1/tax_rates" && init?.method === "POST") {
        const body = init.body as URLSearchParams;
        expect(body.get("percentage")).toBe("16");
        expect(body.get("inclusive")).toBe("false");
        expect(body.get("country")).toBe("MX");
        expect(body.get("metadata[green_monkey_tax]")).toBe("iva16");
        expect(
          (init.headers as Record<string, string>)["Idempotency-Key"],
        ).toBe("gm-tax-rate-v1");
        return Response.json(rate);
      }
      if (path === "/v1/tax_rates") return Response.json({ data: existing });
      throw Error("unexpected " + path);
    });
  it("reuses the tagged rate, or creates it once with a fixed idempotency key", async () => {
    const reuse = fake([rate]);
    expect(
      await provisionStripeSandboxTaxRate("sk_test_x", "acct_fixture", reuse),
    ).toEqual({ accountId: "acct_fixture", taxRateId: "txr_iva16" });
    expect(reuse.mock.calls.some(([, i]) => i?.method === "POST")).toBe(false);
    const create = fake([]);
    expect(
      (await provisionStripeSandboxTaxRate("sk_test_x", "acct_fixture", create))
        .taxRateId,
    ).toBe("txr_iva16");
    await expect(
      provisionStripeSandboxTaxRate("sk_live_x", "acct_fixture", create),
    ).rejects.toThrow("stripe_sandbox_key_required");
    await expect(
      provisionStripeSandboxTaxRate(
        "sk_test_x",
        "acct_fixture",
        fake([{ ...rate, percentage: 8 }]),
      ),
    ).rejects.toThrow("stripe_catalog_tax_rate_mismatch");
  });
});
