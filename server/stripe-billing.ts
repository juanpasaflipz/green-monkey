import { z } from "zod";
import { PRO_OFFER, type Entitlement } from "../shared/plans.js";
import { validateSandboxPrice } from "./stripe-catalog.js";

export const STRIPE_BILLING_API_VERSION = "2026-08-26.dahlia";
const providerId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`));
const seconds = z.number().int().nonnegative().max(253402300799);
const scopeSchema = z.object({
  organizationId: z.uuid(),
  customerId: providerId("cus"),
});
export type BillingScope = z.infer<typeof scopeSchema>;
const bindingSchema = scopeSchema.extend({
  subscriptionId: providerId("sub"),
  interval: z.enum(["month", "year"]),
  locations: z.number().int().min(1).max(1000),
});
export type SubscriptionBinding = z.infer<typeof bindingSchema>;
const configSchema = z
  .object({
    secretKey: z.string().regex(/^(sk|rk)_test_[A-Za-z0-9]+$/),
    accountId: providerId("acct"),
    monthlyPriceId: providerId("price"),
    annualPriceId: providerId("price"),
    appUrl: z.url().refine((value) => {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/" &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["localhost", "127.0.0.1"].includes(url.hostname)))
      );
    }),
  })
  .refine((v) => v.monthlyPriceId !== v.annualPriceId);
export type StripeBillingConfig = z.infer<typeof configSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw Error("stripe_billing_response_mismatch");
  return result.data;
}
function metadata(organizationId: string) {
  return {
    application: "green_monkey",
    purpose: "saas_subscription",
    organization_id: organizationId,
  };
}
function checkMetadata(value: unknown, organizationId: string) {
  parse(
    z.object({
      application: z.literal("green_monkey"),
      purpose: z.literal("saas_subscription"),
      organization_id: z.literal(organizationId),
    }),
    value,
  );
}
function hostedUrl(value: string, host: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.host !== host ||
    url.username ||
    url.password
  )
    throw Error("stripe_billing_response_mismatch");
  return value;
}

/** Sandbox transport only. Callers must persist authorized organization/customer/
 * subscription bindings and immutable operation IDs BEFORE invoking mutations.
 * Do not mount this adapter directly as request handlers or hold a DB transaction
 * across its network calls. It deliberately cannot write local entitlements.
 */
export function stripeSandboxBilling(
  input: StripeBillingConfig,
  request: typeof fetch = fetch,
) {
  const validated = configSchema.safeParse(input);
  if (!validated.success) throw Error("stripe_billing_sandbox_config_required");
  const config = validated.data;
  const priceId = (interval: "month" | "year") =>
    interval === "month" ? config.monthlyPriceId : config.annualPriceId;
  async function call(
    path: string,
    form?: URLSearchParams,
    operationId?: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await request("https://api.stripe.com/v1" + path, {
        method: form ? "POST" : "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${config.secretKey}`,
          "Stripe-Version": STRIPE_BILLING_API_VERSION,
          ...(form
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
          ...(operationId ? { "Idempotency-Key": operationId } : {}),
        },
        ...(form ? { body: form } : {}),
      });
    } catch {
      throw Error("stripe_billing_request_uncertain");
    }
    if (!response.ok)
      throw Error(`stripe_billing_request_failed_${response.status}`);
    try {
      return await response.json();
    } catch {
      throw Error("stripe_billing_request_uncertain");
    }
  }
  async function account() {
    const actual = parse(
      z.object({ id: z.literal(config.accountId) }),
      await call("/account"),
    );
    return actual.id;
  }
  async function customer(scope: BillingScope) {
    const value = parse(
      z.object({
        id: z.literal(scope.customerId),
        livemode: z.literal(false),
        deleted: z.literal(false).optional(),
        metadata: z.unknown(),
      }),
      await call(`/customers/${scope.customerId}`),
    );
    checkMetadata(value.metadata, scope.organizationId);
  }
  async function price(interval: "month" | "year") {
    const value = validateSandboxPrice(
      await call(`/prices/${priceId(interval)}`),
      interval,
    );
    if (value.id !== priceId(interval))
      throw Error("stripe_billing_response_mismatch");
  }
  const operationKey = (
    kind: string,
    organizationId: string,
    operationId: string,
  ) => {
    z.uuid().parse(operationId);
    return `gm-billing-v1:${kind}:${organizationId}:${operationId}`;
  };
  async function checkScope(value: BillingScope) {
    const scope = scopeSchema.parse(value);
    await account();
    await customer(scope);
    return scope;
  }
  function validateSubscription(value: unknown, binding: SubscriptionBinding) {
    const result = parse(
      z.object({
        id: z.literal(binding.subscriptionId),
        object: z.literal("subscription"),
        customer: z.literal(binding.customerId),
        livemode: z.literal(false),
        currency: z.literal("mxn"),
        metadata: z.unknown(),
        status: z.enum([
          "trialing",
          "active",
          "past_due",
          "canceled",
          "paused",
          "unpaid",
          "incomplete",
          "incomplete_expired",
        ]),
        trial_end: seconds.nullable(),
        cancel_at: seconds.nullable(),
        pause_collection: z.null(),
        items: z.object({
          has_more: z.literal(false),
          data: z
            .array(
              z.object({
                quantity: z.literal(binding.locations),
                current_period_end: seconds,
                price: z.unknown(),
              }),
            )
            .length(1),
        }),
      }),
      value,
    );
    checkMetadata(result.metadata, binding.organizationId);
    const checked = validateSandboxPrice(
      result.items.data[0].price,
      binding.interval,
    );
    if (checked.id !== priceId(binding.interval))
      throw Error("stripe_billing_response_mismatch");
    return result;
  }
  return {
    async createCustomer(organizationId: string, operationId: string) {
      z.uuid().parse(organizationId);
      const key = operationKey("customer", organizationId, operationId);
      await account();
      const form = new URLSearchParams();
      for (const [name, value] of Object.entries(metadata(organizationId)))
        form.set(`metadata[${name}]`, value);
      const result = parse(
        z.object({
          id: providerId("cus"),
          livemode: z.literal(false),
          metadata: z.unknown(),
        }),
        await call("/customers", form, key),
      );
      checkMetadata(result.metadata, organizationId);
      return { customerId: result.id };
    },
    async createTrial(
      scope: BillingScope,
      interval: "month" | "year",
      operationId: string,
    ) {
      scopeSchema.parse(scope);
      z.enum(["month", "year"]).parse(interval);
      const key = operationKey("trial", scope.organizationId, operationId);
      await checkScope(scope);
      await price(interval);
      const form = new URLSearchParams({
        customer: scope.customerId,
        "items[0][price]": priceId(interval),
        "items[0][quantity]": "1",
        trial_period_days: String(PRO_OFFER.trialDays),
        "trial_settings[end_behavior][missing_payment_method]": "cancel",
        "payment_settings[save_default_payment_method]": "off",
      });
      for (const [name, value] of Object.entries(
        metadata(scope.organizationId),
      ))
        form.set(`metadata[${name}]`, value);
      const value = await call("/subscriptions", form, key);
      const id = parse(z.object({ id: providerId("sub") }), value).id;
      const result = validateSubscription(value, {
        ...scope,
        subscriptionId: id,
        interval,
        locations: 1,
      });
      if (result.status !== "trialing" || result.trial_end === null)
        throw Error("stripe_billing_response_mismatch");
      return {
        subscriptionId: id,
        trialEnd: new Date(result.trial_end * 1000).toISOString(),
      };
    },
    async createCheckout(
      scope: BillingScope,
      interval: "month" | "year",
      locations: number,
      operationId: string,
    ) {
      scopeSchema.parse(scope);
      z.enum(["month", "year"]).parse(interval);
      z.number().int().min(1).max(1000).parse(locations);
      const key = operationKey("checkout", scope.organizationId, operationId);
      await checkScope(scope);
      await price(interval);
      const form = new URLSearchParams({
        mode: "subscription",
        customer: scope.customerId,
        client_reference_id: scope.organizationId,
        "line_items[0][price]": priceId(interval),
        "line_items[0][quantity]": String(locations),
        success_url: new URL("/app?billing=returned", config.appUrl).href,
        cancel_url: new URL("/app?billing=canceled", config.appUrl).href,
      });
      for (const [name, value] of Object.entries(
        metadata(scope.organizationId),
      ))
        form.set(`subscription_data[metadata][${name}]`, value);
      const result = parse(
        z.object({
          id: providerId("cs_test"),
          livemode: z.literal(false),
          mode: z.literal("subscription"),
          customer: z.literal(scope.customerId),
          client_reference_id: z.literal(scope.organizationId),
          url: z.url(),
        }),
        await call("/checkout/sessions", form, key),
      );
      return {
        sessionId: result.id,
        url: hostedUrl(result.url, "checkout.stripe.com"),
      };
    },
    async createPortal(scope: BillingScope, operationId: string) {
      scopeSchema.parse(scope);
      const key = operationKey("portal", scope.organizationId, operationId);
      await checkScope(scope);
      const result = parse(
        z.object({
          id: providerId("bps"),
          livemode: z.literal(false),
          customer: z.literal(scope.customerId),
          url: z.url(),
        }),
        await call(
          "/billing_portal/sessions",
          new URLSearchParams({
            customer: scope.customerId,
            return_url: new URL("/app", config.appUrl).href,
          }),
          key,
        ),
      );
      return {
        sessionId: result.id,
        url: hostedUrl(result.url, "billing.stripe.com"),
      };
    },
    async readSubscription(input: SubscriptionBinding): Promise<Entitlement> {
      const binding = bindingSchema.parse(input);
      await checkScope(binding);
      const result = validateSubscription(
        await call(`/subscriptions/${binding.subscriptionId}`),
        binding,
      );
      // Status alone is insufficient: every grant has a provider-bounded expiry.
      // No renewal grace is silently introduced; the seven-day proposal is not approved.
      const status =
        result.status === "unpaid" ||
        result.status === "incomplete" ||
        result.status === "incomplete_expired"
          ? "free"
          : result.status;
      let until: number | null = null;
      if (status === "active") until = result.items.data[0].current_period_end;
      if (status === "trialing") {
        if (result.trial_end === null)
          throw Error("stripe_billing_response_mismatch");
        until = Math.min(
          result.trial_end,
          result.items.data[0].current_period_end,
        );
      }
      // Past-due cannot borrow a new unpaid period as Pro access.
      if (result.cancel_at !== null && until !== null)
        until = Math.min(until, result.cancel_at);
      return {
        status,
        accessUntil:
          until === null ? null : new Date(until * 1000).toISOString(),
        source: "stripe",
      };
    },
  };
}
