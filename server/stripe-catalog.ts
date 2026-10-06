import { z } from "zod";
import { PRO_OFFER } from "../shared/plans.js";

const productId = "green_monkey_pro_v1";
const productSchema = z.object({
  id: z.literal(productId),
  active: z.literal(true),
  livemode: z.literal(false),
  name: z.literal("Green Monkey Pro"),
  metadata: z.object({
    application: z.literal("green_monkey"),
    purpose: z.literal("saas_subscription"),
  }),
});
export const proPriceKeys = {
  month: "green_monkey_pro_mxn_month_v1",
  year: "green_monkey_pro_mxn_year_v1",
} as const;
export function validateSandboxPrice(
  value: unknown,
  interval: "month" | "year",
) {
  const parsed = z
    .object({
      id: z.string().startsWith("price_"),
      active: z.literal(true),
      livemode: z.literal(false),
      product: z.literal(productId),
      currency: z.literal("mxn"),
      type: z.literal("recurring"),
      billing_scheme: z.literal("per_unit"),
      tax_behavior: z.literal("exclusive"),
      lookup_key: z.literal(proPriceKeys[interval]),
      unit_amount: z.literal(
        interval === "month" ? PRO_OFFER.monthlyMinor : PRO_OFFER.annualMinor,
      ),
      recurring: z.object({
        interval: z.literal(interval),
        interval_count: z.literal(1),
        usage_type: z.literal("licensed"),
      }),
    })
    .safeParse(value);
  if (!parsed.success) throw Error("stripe_catalog_price_mismatch");
  return parsed.data;
}

/**
 * The SaaS IVA rate (account 031, GAP-6): an active, exclusive 16 % Mexican
 * sandbox Tax Rate. Its percentage and country are immutable in Stripe.
 */
export function validateSandboxTaxRate(value: unknown) {
  const parsed = z
    .object({
      id: z.string().regex(/^txr_[A-Za-z0-9]+$/),
      object: z.literal("tax_rate"),
      active: z.literal(true),
      livemode: z.literal(false),
      inclusive: z.literal(false),
      percentage: z.literal(16),
      country: z.literal("MX"),
      display_name: z.string().regex(/IVA/),
    })
    .safeParse(value);
  if (!parsed.success) throw Error("stripe_catalog_tax_rate_mismatch");
  return parsed.data;
}

/** Explicit sandbox provisioning command, not a web route or checkout service. */
export async function provisionStripeSandboxCatalog(
  secret: string,
  expectedAccountId: string,
  request: typeof fetch = fetch,
) {
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(secret))
    throw Error("stripe_sandbox_key_required");
  if (!/^acct_[A-Za-z0-9]+$/.test(expectedAccountId))
    throw Error("stripe_expected_account_required");
  async function call(
    method: "GET" | "POST",
    path: string,
    body?: URLSearchParams,
    key?: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await request("https://api.stripe.com/v1" + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${secret}`,
          ...(body
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(body ? { body } : {}),
      });
    } catch {
      throw Error("stripe_catalog_request_uncertain_rerun_to_reconcile");
    }
    const data = await response.json().catch(() => null);
    if (
      response.status === 404 &&
      method === "GET" &&
      path === `/products/${productId}` &&
      z
        .object({ error: z.object({ code: z.literal("resource_missing") }) })
        .safeParse(data).success
    )
      return null;
    if (!response.ok || !data)
      throw Error(`stripe_catalog_request_failed_${response.status}`);
    return data;
  }
  const account = z
    .object({ id: z.string() })
    .parse(await call("GET", "/account"));
  if (account.id !== expectedAccountId) throw Error("stripe_account_mismatch");
  let product = await call("GET", `/products/${productId}`);
  if (!product)
    product = await call(
      "POST",
      "/products",
      new URLSearchParams({
        id: productId,
        name: "Green Monkey Pro",
        unit_label: "restaurante",
        "metadata[application]": "green_monkey",
        "metadata[purpose]": "saas_subscription",
      }),
      "green-monkey-product-v1",
    );
  if (!productSchema.safeParse(product).success)
    throw Error("stripe_catalog_product_mismatch");
  const result: { month?: string; year?: string } = {};
  for (const interval of ["month", "year"] as const) {
    const lookupKey = proPriceKeys[interval];
    const query = new URLSearchParams({
      "lookup_keys[]": lookupKey,
      limit: "2",
    });
    const list = z
      .object({ data: z.array(z.unknown()).max(1), has_more: z.literal(false) })
      .safeParse(await call("GET", "/prices?" + query));
    if (!list.success) throw Error("stripe_catalog_lookup_ambiguous");
    let price = list.data.data[0];
    if (!price)
      price = await call(
        "POST",
        "/prices",
        new URLSearchParams({
          product: productId,
          currency: "mxn",
          unit_amount: String(
            interval === "month"
              ? PRO_OFFER.monthlyMinor
              : PRO_OFFER.annualMinor,
          ),
          "recurring[interval]": interval,
          "recurring[interval_count]": "1",
          "recurring[usage_type]": "licensed",
          billing_scheme: "per_unit",
          tax_behavior: "exclusive",
          lookup_key: lookupKey,
          "metadata[application]": "green_monkey",
          "metadata[purpose]": "saas_subscription",
        }),
        lookupKey,
      );
    result[interval] = validateSandboxPrice(price, interval).id;
  }
  return {
    accountId: account.id,
    productId,
    monthlyPriceId: result.month!,
    annualPriceId: result.year!,
  };
}

/**
 * Explicit sandbox provisioning of the SaaS IVA rate (account 031, GAP-6):
 * reuses the active rate tagged metadata[green_monkey_tax]=iva16, else creates
 * it once (fixed idempotency key), and returns it only after validation.
 */
export async function provisionStripeSandboxTaxRate(
  secret: string,
  expectedAccountId: string,
  request: typeof fetch = fetch,
): Promise<{ accountId: string; taxRateId: string }> {
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(secret))
    throw Error("stripe_sandbox_key_required");
  if (!/^acct_[A-Za-z0-9]+$/.test(expectedAccountId))
    throw Error("stripe_expected_account_required");
  async function call(path: string, body?: URLSearchParams): Promise<unknown> {
    let response: Response;
    try {
      response = await request("https://api.stripe.com/v1" + path, {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${secret}`,
          ...(body
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                "Idempotency-Key": "gm-tax-rate-v1",
              }
            : {}),
        },
        ...(body ? { body } : {}),
      });
    } catch {
      throw Error("stripe_catalog_request_uncertain_rerun_to_reconcile");
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data)
      throw Error(`stripe_catalog_request_failed_${response.status}`);
    return data;
  }
  const account = z.object({ id: z.string() }).parse(await call("/account"));
  if (account.id !== expectedAccountId) throw Error("stripe_account_mismatch");
  const list = z
    .object({
      data: z.array(
        z
          .object({ metadata: z.record(z.string(), z.string()).optional() })
          .passthrough(),
      ),
    })
    .safeParse(await call("/tax_rates?active=true&limit=100"));
  if (!list.success) throw Error("stripe_catalog_tax_rate_mismatch");
  const tagged = list.data.data.filter(
    (r) => r.metadata?.green_monkey_tax === "iva16",
  );
  if (tagged.length > 1) throw Error("stripe_catalog_lookup_ambiguous");
  const rate =
    tagged[0] ??
    (await call(
      "/tax_rates",
      new URLSearchParams({
        display_name: "IVA",
        percentage: "16",
        inclusive: "false",
        country: "MX",
        jurisdiction: "MX",
        description: "IVA 16% Green Monkey SaaS",
        "metadata[green_monkey_tax]": "iva16",
      }),
    ));
  return { accountId: account.id, taxRateId: validateSandboxTaxRate(rate).id };
}
