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
export const locationQuoteSchema = z.object({
  itemId: providerId("si"),
  prorationDate: seconds,
  periodEnd: seconds,
  previousLocations: z.number().int().positive(),
  locations: z.number().int().positive(),
  amountDue: z.number().int().nonnegative(),
  currency: z.literal("mxn"),
  expiresAt: seconds,
  trialEnd: seconds.nullable(),
});
export type LocationQuote = z.infer<typeof locationQuoteSchema>;
const configSchema = z
  .object({
    secretKey: z.string().regex(/^(sk|rk)_test_[A-Za-z0-9]+$/),
    accountId: providerId("acct"),
    monthlyPriceId: providerId("price"),
    annualPriceId: providerId("price"),
    portalConfigurationId: providerId("bpc").optional(),
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
  async function quantityState(
    binding: SubscriptionBinding,
    locations: number,
  ) {
    bindingSchema.parse(binding);
    z.number()
      .int()
      .min(binding.locations)
      .max(binding.locations + 1)
      .parse(locations);
    await checkScope(binding);
    const raw = await call(`/subscriptions/${binding.subscriptionId}`);
    const extra = parse(
      z.object({
        collection_method: z.literal("charge_automatically"),
        cancel_at_period_end: z.boolean(),
        pending_update: z
          .object({
            expires_at: seconds,
            metadata: z.record(z.string(), z.string()).optional(),
          })
          .nullable(),
        latest_invoice: providerId("in").nullable(),
        metadata: z.record(z.string(), z.string()),
        items: z.object({
          data: z
            .array(
              z.object({ id: providerId("si"), quantity: z.number().int() }),
            )
            .length(1),
        }),
      }),
      raw,
    );
    const item = extra.items.data[0];
    if (![binding.locations, locations].includes(item.quantity))
      throw Error("stripe_location_quantity_mismatch");
    const sub = validateSubscription(raw, {
      ...binding,
      locations: item.quantity,
    });
    return { extra, item, sub };
  }
  async function pendingInvoice(
    scope: BillingScope,
    subscriptionId: string,
    invoiceId: string | null,
  ) {
    if (!invoiceId) return null;
    const invoice = parse(
      z.object({
        id: z.literal(invoiceId),
        customer: z.literal(scope.customerId),
        livemode: z.literal(false),
        hosted_invoice_url: z.url().nullable(),
        parent: z.object({
          type: z.literal("subscription_details"),
          subscription_details: z.object({
            subscription: z.literal(subscriptionId),
          }),
        }),
      }),
      await call(`/invoices/${invoiceId}`),
    );
    return invoice.hosted_invoice_url
      ? hostedUrl(invoice.hosted_invoice_url, "invoice.stripe.com")
      : null;
  }
  return {
    async quoteLocation(
      binding: SubscriptionBinding,
      prorationDate: number,
      operationId: string,
    ): Promise<LocationQuote> {
      seconds.parse(prorationDate);
      const state = await quantityState(binding, binding.locations + 1);
      if (
        state.item.quantity !== binding.locations ||
        state.extra.pending_update ||
        state.extra.cancel_at_period_end ||
        !["active", "trialing"].includes(state.sub.status)
      )
        throw Error("stripe_location_update_unavailable");
      const form = new URLSearchParams({
        subscription: binding.subscriptionId,
        "subscription_details[items][0][id]": state.item.id,
        "subscription_details[items][0][quantity]": String(
          binding.locations + 1,
        ),
        "subscription_details[proration_behavior]": "always_invoice",
        "subscription_details[proration_date]": String(prorationDate),
      });
      // No-card trials that cancel without a payment method have no upcoming
      // invoice to preview. Adding a location preserves the existing free trial.
      const invoice =
        state.sub.status === "trialing"
          ? { amount_due: 0 }
          : parse(
              z.object({
                amount_due: z.number().int().nonnegative(),
                currency: z.literal("mxn"),
                customer: z.literal(binding.customerId),
              }),
              await call(
                "/invoices/create_preview",
                form,
                operationKey(
                  "location-quote",
                  binding.organizationId,
                  operationId,
                ),
              ),
            );
      return {
        itemId: state.item.id,
        prorationDate,
        periodEnd: state.sub.items.data[0].current_period_end,
        previousLocations: binding.locations,
        locations: binding.locations + 1,
        amountDue: state.sub.status === "trialing" ? 0 : invoice.amount_due,
        currency: "mxn",
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        trialEnd: state.sub.status === "trialing" ? state.sub.trial_end : null,
      };
    },
    async updateLocation(
      binding: SubscriptionBinding,
      quote: LocationQuote,
      operationId: string,
    ) {
      locationQuoteSchema.parse(quote);
      z.uuid().parse(operationId);
      if (
        quote.previousLocations !== binding.locations ||
        quote.locations !== binding.locations + 1
      )
        throw Error("stripe_location_quantity_mismatch");
      const state = await quantityState(binding, quote.locations);
      if (
        state.extra.metadata.location_operation_id === operationId ||
        state.extra.pending_update?.metadata?.location_operation_id ===
          operationId
      )
        return { submitted: true, invoiceId: state.extra.latest_invoice };
      if (quote.expiresAt < Math.floor(Date.now() / 1000))
        return { expired: true };
      if (
        state.item.quantity !== binding.locations ||
        state.item.id !== quote.itemId ||
        state.sub.items.data[0].current_period_end !== quote.periodEnd ||
        state.extra.pending_update ||
        state.extra.cancel_at_period_end ||
        !["active", "trialing"].includes(state.sub.status)
      )
        throw Error("stripe_location_update_unavailable");
      const updated = parse(
        z.object({ latest_invoice: providerId("in").nullable() }),
        await call(
          `/subscriptions/${binding.subscriptionId}`,
          new URLSearchParams({
            "items[0][id]": quote.itemId,
            "items[0][quantity]": String(quote.locations),
            proration_behavior: "always_invoice",
            proration_date: String(quote.prorationDate),
            payment_behavior: "pending_if_incomplete",
            "metadata[location_operation_id]": operationId,
          }),
          operationKey("location-update", binding.organizationId, operationId),
        ),
      );
      // A successful HTTP response is not proof that payment or the update applied.
      return { submitted: true, invoiceId: updated.latest_invoice };
    },
    async readLocationUpdate(
      binding: SubscriptionBinding,
      quote: LocationQuote,
      operationId: string,
      invoiceId?: string | null,
    ) {
      locationQuoteSchema.parse(quote);
      z.uuid().parse(operationId);
      const state = await quantityState(binding, quote.locations);
      if (
        state.extra.metadata.location_operation_id !== operationId &&
        state.extra.pending_update?.metadata?.location_operation_id !==
          operationId
      ) {
        if (
          !state.extra.pending_update &&
          state.item.quantity === binding.locations &&
          invoiceId
        ) {
          const invoice = parse(
            z.object({
              id: z.literal(providerId("in").parse(invoiceId)),
              customer: z.literal(binding.customerId),
              livemode: z.literal(false),
              status: z.literal("void"),
              parent: z.object({
                subscription_details: z.object({
                  subscription: z.literal(binding.subscriptionId),
                }),
              }),
            }),
            await call(`/invoices/${invoiceId}`),
          );
          if (invoice.status === "void")
            return { state: "expired" as const, url: null };
        }
        throw Error("stripe_location_operation_mismatch");
      }
      if (
        state.item.quantity === quote.locations &&
        !state.extra.pending_update
      )
        return { state: "applied" as const, url: null };
      if (!state.extra.pending_update)
        return { state: "expired" as const, url: null };
      return {
        state: "pending" as const,
        url: await pendingInvoice(
          binding,
          binding.subscriptionId,
          state.extra.latest_invoice,
        ),
      };
    },
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
    async readCheckout(scope: BillingScope, sessionId: string) {
      providerId("cs_test").parse(sessionId);
      await checkScope(scope);
      return parse(
        z.object({
          id: z.literal(sessionId),
          object: z.literal("checkout.session"),
          livemode: z.literal(false),
          mode: z.literal("subscription"),
          customer: z.literal(scope.customerId),
          client_reference_id: z.literal(scope.organizationId),
          status: z.enum(["open", "complete", "expired"]),
          subscription: providerId("sub").nullable(),
        }),
        await call(`/checkout/sessions/${sessionId}`),
      );
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
            ...(config.portalConfigurationId
              ? { configuration: config.portalConfigurationId }
              : {}),
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
