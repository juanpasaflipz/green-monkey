import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  stripeSandboxBilling,
  STRIPE_BILLING_API_VERSION,
} from "../server/stripe-billing";
import {
  verifyStripeSandboxEvent,
  subscriptionEventReference,
} from "../server/stripe-webhook";
import { accessPlan } from "../shared/plans";
import { proPriceKeys } from "../server/stripe-catalog";

const organizationId = "10000000-0000-4000-8000-000000000001";
const operationId = "20000000-0000-4000-8000-000000000001";
const config = {
  secretKey: "sk_test_fixture",
  accountId: "acct_fixture",
  monthlyPriceId: "price_month",
  annualPriceId: "price_year",
  appUrl: "https://example.test",
};
const scope = { organizationId, customerId: "cus_fixture" };
const binding = {
  ...scope,
  subscriptionId: "sub_fixture",
  interval: "month" as const,
  locations: 1,
};
const metadata = {
  application: "green_monkey",
  purpose: "saas_subscription",
  organization_id: organizationId,
};
const now = 1_800_000_000;
const price = (interval = "month") => ({
  id: "price_" + interval,
  active: true,
  livemode: false,
  product: "green_monkey_pro_v1",
  currency: "mxn",
  type: "recurring",
  billing_scheme: "per_unit",
  tax_behavior: "exclusive",
  lookup_key: proPriceKeys[interval as "month" | "year"],
  unit_amount: interval === "month" ? 79900 : 799000,
  recurring: { interval, interval_count: 1, usage_type: "licensed" },
});
const subscription = () => ({
  id: "sub_fixture",
  object: "subscription",
  customer: "cus_fixture",
  livemode: false,
  currency: "mxn",
  metadata,
  status: "active",
  trial_end: null as number | null,
  cancel_at: null as number | null,
  pause_collection: null,
  items: {
    has_more: false,
    data: [{ quantity: 1, current_period_end: now + 86400, price: price() }],
  },
});

describe("additional location billing", () => {
  const quote = () => ({
    itemId: "si_fixture",
    prorationDate: now,
    periodEnd: now + 86400,
    previousLocations: 1,
    locations: 2,
    amountDue: 79900,
    currency: "mxn" as const,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    trialEnd: null,
  });
  function locationFixture(
    options: {
      trial?: boolean;
      pending?: boolean;
      applied?: boolean;
      foreign?: boolean;
      voided?: boolean;
    } = {},
  ) {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v1/account")
        return Response.json({ id: config.accountId });
      if (path === "/v1/customers/cus_fixture")
        return Response.json({
          id: scope.customerId,
          livemode: false,
          metadata,
        });
      if (path === "/v1/invoices/create_preview")
        return Response.json({
          customer: scope.customerId,
          currency: "mxn",
          amount_due: 39950,
        });
      if (path === "/v1/invoices/in_fixture")
        return Response.json({
          id: "in_fixture",
          customer: scope.customerId,
          livemode: false,
          status: options.voided ? "void" : "open",
          hosted_invoice_url: "https://invoice.stripe.com/i/fixture",
          parent: {
            type: "subscription_details",
            subscription_details: { subscription: binding.subscriptionId },
          },
        });
      if (path === "/v1/subscriptions/sub_fixture") {
        if (init?.method === "POST")
          return Response.json({ latest_invoice: "in_fixture" });
        const sub = subscription();
        return Response.json({
          ...sub,
          status: options.trial ? "trialing" : "active",
          trial_end: options.trial ? now + 86400 : null,
          collection_method: "charge_automatically",
          cancel_at_period_end: false,
          latest_invoice: "in_fixture",
          metadata: {
            ...metadata,
            ...(options.applied && { location_operation_id: operationId }),
          },
          pending_update: options.pending
            ? {
                expires_at: now + 86400,
                metadata: {
                  location_operation_id: options.foreign
                    ? "other"
                    : operationId,
                },
              }
            : null,
          items: {
            ...sub.items,
            data: [
              {
                ...sub.items.data[0],
                id: "si_fixture",
                quantity: options.applied ? 2 : 1,
              },
            ],
          },
        });
      }
      throw Error("unexpected provider call");
    });
    return { request, provider: stripeSandboxBilling(config, request) };
  }
  it("quotes a no-card trial at zero without requesting a nonexistent invoice", async () => {
    const { provider, request } = locationFixture({ trial: true });
    const result = await provider.quoteLocation(binding, now, operationId);
    expect(result.amountDue).toBe(0);
    expect(result.trialEnd).toBe(now + 86400);
    expect(
      request.mock.calls.some(([url]) =>
        String(url).includes("create_preview"),
      ),
    ).toBe(false);
  });
  it("uses the provider proration quote and preserves the consented proration date", async () => {
    const { provider, request } = locationFixture();
    const result = await provider.quoteLocation(binding, now, operationId);
    expect(result.amountDue).toBe(39950);
    await provider.updateLocation(binding, result, operationId);
    const posts = request.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("subscriptions/") && init?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    const form = posts[0][1]!.body as URLSearchParams;
    expect(form.get("proration_date")).toBe(String(now));
    expect(form.get("payment_behavior")).toBe("pending_if_incomplete");
    expect(form.has("trial_end")).toBe(false);
  });
  it("recovers a failed payment from pending metadata without repeating the mutation", async () => {
    const { provider, request } = locationFixture({ pending: true });
    expect(
      await provider.updateLocation(binding, quote(), operationId),
    ).toEqual({ submitted: true, invoiceId: "in_fixture" });
    expect(
      await provider.readLocationUpdate(
        binding,
        quote(),
        operationId,
        "in_fixture",
      ),
    ).toEqual({
      state: "pending",
      url: "https://invoice.stripe.com/i/fixture",
    });
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
  });
  it("does not adopt another pending update", async () => {
    const { provider } = locationFixture({ pending: true, foreign: true });
    await expect(
      provider.readLocationUpdate(binding, quote(), operationId, "in_fixture"),
    ).rejects.toThrow("stripe_location_operation_mismatch");
  });
  it("recognizes a voided original invoice after Stripe discards pending metadata", async () => {
    const { provider } = locationFixture({ voided: true });
    expect(
      await provider.readLocationUpdate(
        binding,
        quote(),
        operationId,
        "in_fixture",
      ),
    ).toEqual({ state: "expired", url: null });
  });
  it("does not treat an open invoice as an expired update", async () => {
    const { provider } = locationFixture();
    await expect(
      provider.readLocationUpdate(binding, quote(), operationId, "in_fixture"),
    ).rejects.toThrow("stripe_billing_response_mismatch");
  });
  it("requires canonical quantity and operation metadata before activation", async () => {
    const { provider } = locationFixture({ applied: true });
    expect(
      await provider.readLocationUpdate(binding, quote(), operationId),
    ).toEqual({ state: "applied", url: null });
  });
});
function fixture(
  options: {
    subscription?: unknown;
    customer?: unknown;
    account?: unknown;
    checkout?: unknown;
    portal?: unknown;
    price?: unknown;
  } = {},
) {
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    expect((init?.headers as Record<string, string>)["Stripe-Version"]).toBe(
      STRIPE_BILLING_API_VERSION,
    );
    expect(init?.redirect).toBe("error");
    if (path === "/v1/account")
      return Response.json(options.account ?? { id: "acct_fixture" });
    if (path.startsWith("/v1/customers"))
      return Response.json(
        options.customer ?? { id: "cus_fixture", livemode: false, metadata },
      );
    if (path.startsWith("/v1/prices/"))
      return Response.json(
        options.price ?? price(path.endsWith("year") ? "year" : "month"),
      );
    if (path.startsWith("/v1/subscriptions"))
      return Response.json(options.subscription ?? subscription());
    if (path === "/v1/checkout/sessions")
      return Response.json(
        options.checkout ?? {
          id: "cs_test_fixture",
          livemode: false,
          mode: "subscription",
          customer: "cus_fixture",
          client_reference_id: organizationId,
          url: "https://checkout.stripe.com/c/pay/fixture",
        },
      );
    if (path === "/v1/billing_portal/sessions")
      return Response.json(
        options.portal ?? {
          id: "bps_fixture",
          livemode: false,
          customer: "cus_fixture",
          url: "https://billing.stripe.com/p/session/fixture",
        },
      );
    throw Error("unexpected fixture URL");
  });
  return {
    request,
    service: stripeSandboxBilling(config, request),
    posts: () =>
      request.mock.calls.filter(([, init]) => init?.method === "POST"),
  };
}

describe("sandbox subscription transport", () => {
  it.each([
    { secretKey: "sk_live_fixture" },
    { accountId: "" },
    { annualPriceId: "price_month" },
    { appUrl: "https://user:password@example.test" },
    { appUrl: "http://example.test" },
    { appUrl: "https://example.test/path" },
  ])("rejects invalid configuration before network access %j", (override) => {
    const request = vi.fn<typeof fetch>();
    expect(() =>
      stripeSandboxBilling({ ...config, ...override }, request),
    ).toThrow("stripe_billing_sandbox_config_required");
    expect(request).not.toHaveBeenCalled();
  });
  it("checks account identity before creating a customer", async () => {
    const f = fixture({ account: { id: "acct_other" } });
    await expect(
      f.service.createCustomer(organizationId, operationId),
    ).rejects.toThrow("stripe_billing_response_mismatch");
    expect(f.posts()).toHaveLength(0);
  });
  it("creates an organization customer without copying identity email or restaurant tenders", async () => {
    const f = fixture();
    expect(await f.service.createCustomer(organizationId, operationId)).toEqual(
      { customerId: "cus_fixture" },
    );
    const form = f.posts()[0][1]?.body as URLSearchParams;
    expect([...form.keys()]).toEqual([
      "metadata[application]",
      "metadata[purpose]",
      "metadata[organization_id]",
    ]);
  });
  it("rejects a customer bound to another organization before checkout or portal", async () => {
    const f = fixture({
      customer: {
        id: "cus_fixture",
        livemode: false,
        metadata: { ...metadata, organization_id: operationId },
      },
    });
    await expect(
      f.service.createCheckout(scope, "month", 1, operationId),
    ).rejects.toThrow("stripe_billing_response_mismatch");
    await expect(f.service.createPortal(scope, operationId)).rejects.toThrow(
      "stripe_billing_response_mismatch",
    );
    expect(f.posts()).toHaveLength(0);
  });
  it("rejects price drift before creating a subscription session", async () => {
    const f = fixture({ price: { ...price(), unit_amount: 799 } });
    await expect(
      f.service.createCheckout(scope, "month", 1, operationId),
    ).rejects.toThrow("stripe_catalog_price_mismatch");
    expect(f.posts()).toHaveLength(0);
  });
  it("requests the approved trial with cancellation for missing payment details", async () => {
    const sub = {
      ...subscription(),
      status: "trialing",
      trial_end: now + 14 * 86400,
    };
    const f = fixture({ subscription: sub });
    expect(await f.service.createTrial(scope, "month", operationId)).toEqual({
      subscriptionId: "sub_fixture",
      trialEnd: new Date(sub.trial_end * 1000).toISOString(),
    });
    const form = f.posts()[0][1]?.body as URLSearchParams;
    expect(form.get("trial_period_days")).toBe("14");
    expect(
      form.get("trial_settings[end_behavior][missing_payment_method]"),
    ).toBe("cancel");
    expect(form.get("items[0][quantity]")).toBe("1");
    expect(form.has("default_payment_method")).toBe(false);
  });
  it("uses configured annual price and server return URLs; the result grants no access", async () => {
    const f = fixture();
    expect(
      await f.service.createCheckout(scope, "year", 2, operationId),
    ).toEqual({
      sessionId: "cs_test_fixture",
      url: "https://checkout.stripe.com/c/pay/fixture",
    });
    const form = f.posts()[0][1]?.body as URLSearchParams;
    expect(form.get("line_items[0][price]")).toBe("price_year");
    expect(form.get("line_items[0][quantity]")).toBe("2");
    expect(form.get("success_url")).toBe(
      "https://example.test/app?billing=returned",
    );
    expect(form.has("trial_period_days")).toBe(false);
  });
  it("opens only the bound customer's portal", async () => {
    const f = fixture();
    expect(await f.service.createPortal(scope, operationId)).toEqual({
      sessionId: "bps_fixture",
      url: "https://billing.stripe.com/p/session/fixture",
    });
    expect((f.posts()[0][1]?.body as URLSearchParams).get("customer")).toBe(
      scope.customerId,
    );
  });
  it("rejects an unexpected hosted redirect", async () => {
    const f = fixture({
      portal: {
        id: "bps_fixture",
        livemode: false,
        customer: "cus_fixture",
        url: "https://billing.stripe.com.evil.test/p/session",
      },
    });
    await expect(f.service.createPortal(scope, operationId)).rejects.toThrow(
      "stripe_billing_response_mismatch",
    );
  });
  it("reuses the same provider key and payload after a lost response without leaking errors", async () => {
    const f = fixture();
    let lost = true;
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const response = await f.request(url, init);
      if (init?.method === "POST" && lost) {
        lost = false;
        throw Error("sk_test_fixture private details");
      }
      return response;
    });
    const service = stripeSandboxBilling(config, request);
    await expect(
      service.createCustomer(organizationId, operationId),
    ).rejects.toThrow(/^stripe_billing_request_uncertain$/);
    await service.createCustomer(organizationId, operationId);
    const posts = f.posts();
    expect(posts).toHaveLength(2);
    expect(posts[0][1]?.headers).toEqual(posts[1][1]?.headers);
    expect(String(posts[0][1]?.body)).toBe(String(posts[1][1]?.body));
  });
  it("rejects invalid operation IDs before provider access", async () => {
    const f = fixture();
    await expect(
      f.service.createCheckout(scope, "month", 1, "arbitrary"),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
});

describe("canonical subscription entitlement projection", () => {
  it("bounds active access by the current item period and expires exactly at the boundary", async () => {
    const result = await fixture().service.readSubscription(binding);
    expect(accessPlan(result, now * 1000)).toBe("pro");
    expect(accessPlan(result, (now + 86400) * 1000)).toBe("free");
  });
  it("uses canonical canceled state even when an older event claims active", async () => {
    const f = fixture({
      subscription: { ...subscription(), status: "canceled" },
    });
    const event = signedEvent({
      ...eventFixture(),
      data: {
        object: { object: "subscription", id: "sub_fixture", status: "active" },
      },
    });
    expect(
      subscriptionEventReference(
        verifyStripeSandboxEvent(
          event.body,
          event.signature,
          webhookSecret,
          now * 1000,
        ),
      ),
    ).toBe(binding.subscriptionId);
    expect(
      accessPlan(await f.service.readSubscription(binding), now * 1000),
    ).toBe("free");
  });
  it.each([
    "past_due",
    "unpaid",
    "incomplete",
    "incomplete_expired",
    "paused",
    "canceled",
  ])("does not grant new Pro access for %s", async (status) => {
    const f = fixture({ subscription: { ...subscription(), status } });
    expect(
      accessPlan(await f.service.readSubscription(binding), now * 1000),
    ).toBe("free");
  });
  it("caps a trial at the earlier explicit cancellation", async () => {
    const f = fixture({
      subscription: {
        ...subscription(),
        status: "trialing",
        trial_end: now + 3600,
        cancel_at: now + 1800,
      },
    });
    expect((await f.service.readSubscription(binding)).accessUntil).toBe(
      new Date((now + 1800) * 1000).toISOString(),
    );
  });
  it.each([
    { customer: "cus_other" },
    { id: "sub_other" },
    { livemode: true },
    { currency: "usd" },
    { metadata: { ...metadata, organization_id: operationId } },
    { items: { has_more: true, data: subscription().items.data } },
    {
      items: {
        has_more: false,
        data: [{ ...subscription().items.data[0], quantity: 2 }],
      },
    },
    {
      items: {
        has_more: false,
        data: [{ ...subscription().items.data[0], price: price("year") }],
      },
    },
    { status: "trialing", trial_end: null },
    { pause_collection: { behavior: "void" } },
  ])("rejects mismatched canonical state %j", async (override) => {
    const f = fixture({ subscription: { ...subscription(), ...override } });
    await expect(f.service.readSubscription(binding)).rejects.toThrow();
  });
});

const webhookSecret = "whsec_fixture";
const eventFixture = () => ({
  id: "evt_fixture",
  object: "event",
  livemode: false,
  type: "customer.subscription.updated",
  created: now - 86400,
  data: { object: { object: "subscription", id: "sub_fixture" } },
});
function signedEvent(event: unknown = eventFixture(), timestamp = now) {
  const body = Buffer.from(JSON.stringify(event));
  const digest = createHmac("sha256", webhookSecret)
    .update(timestamp + ".")
    .update(body)
    .digest("hex");
  return { body, signature: `t=${timestamp},v1=${digest}`, digest };
}
describe("raw Stripe sandbox webhook verification", () => {
  it("verifies retry delivery timestamps independently of event creation time", () => {
    const e = signedEvent();
    expect(
      verifyStripeSandboxEvent(e.body, e.signature, webhookSecret, now * 1000)
        .id,
    ).toBe("evt_fixture");
  });
  it("accepts rotated v1 signatures and ignores v0", () => {
    const e = signedEvent();
    expect(
      verifyStripeSandboxEvent(
        e.body,
        `t=${now},v0=invalid,v1=${"0".repeat(64)},v1=${e.digest}`,
        webhookSecret,
        now * 1000,
      ).id,
    ).toBe("evt_fixture");
  });
  it.each([-301, 301])(
    "rejects old or future delivery timestamps %s",
    (offset) => {
      const e = signedEvent(eventFixture(), now + offset);
      expect(() =>
        verifyStripeSandboxEvent(
          e.body,
          e.signature,
          webhookSecret,
          now * 1000,
        ),
      ).toThrow("stripe_webhook_invalid");
    },
  );
  it("rejects changed raw bytes", () => {
    const e = signedEvent();
    expect(() =>
      verifyStripeSandboxEvent(
        Buffer.concat([e.body, Buffer.from(" ")]),
        e.signature,
        webhookSecret,
        now * 1000,
      ),
    ).toThrow("stripe_webhook_invalid");
  });
  it.each([
    "",
    `t=${now},v0=${"0".repeat(64)}`,
    `t=${now},v1=00`,
    `t=${now},t=${now},v1=${"0".repeat(64)}`,
  ])("rejects malformed signatures %s", (header) => {
    expect(() =>
      verifyStripeSandboxEvent(
        signedEvent().body,
        header,
        webhookSecret,
        now * 1000,
      ),
    ).toThrow("stripe_webhook_invalid");
  });
  it.each([{ livemode: true }, { account: "acct_connected" }])(
    "rejects live/connected-account events %j",
    (override) => {
      const e = signedEvent({ ...eventFixture(), ...override });
      expect(() =>
        verifyStripeSandboxEvent(
          e.body,
          e.signature,
          webhookSecret,
          now * 1000,
        ),
      ).toThrow("stripe_webhook_invalid");
    },
  );
  it("does not turn checkout or restaurant-payment events into subscription grants", () => {
    const e = signedEvent({
      ...eventFixture(),
      type: "checkout.session.completed",
    });
    expect(
      subscriptionEventReference(
        verifyStripeSandboxEvent(
          e.body,
          e.signature,
          webhookSecret,
          now * 1000,
        ),
      ),
    ).toBeNull();
  });
});

describe("invoice reconciliation references", () => {
  it("uses the subscription reference in modern invoice parent details", () => {
    const event = {
      id: "evt_invoice",
      object: "event" as const,
      livemode: false as const,
      type: "invoice.payment_failed",
      created: now,
      data: {
        object: {
          object: "invoice",
          parent: {
            type: "subscription_details",
            subscription_details: { subscription: "sub_fixture" },
          },
          status: "paid",
        },
      },
    };
    expect(subscriptionEventReference(event)).toBe("sub_fixture");
  });
  it("ignores one-off invoices and rejects malformed subscription references", () => {
    const event = {
      id: "evt_invoice",
      object: "event" as const,
      livemode: false as const,
      type: "invoice.paid",
      created: now,
      data: { object: { object: "invoice", parent: null } },
    };
    expect(subscriptionEventReference(event)).toBeNull();
    expect(() =>
      subscriptionEventReference({
        ...event,
        data: {
          object: {
            object: "invoice",
            parent: {
              type: "subscription_details",
              subscription_details: { subscription: "cus_wrong" },
            },
          },
        },
      }),
    ).toThrow("stripe_subscription_event_invalid");
  });
});

describe("canonical Checkout completion", () => {
  const session = {
    id: "cs_test_saved",
    object: "checkout.session",
    livemode: false,
    mode: "subscription",
    customer: scope.customerId,
    client_reference_id: organizationId,
    status: "complete",
    subscription: "sub_fixture",
  };
  const transport = (value: unknown) =>
    vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/account")
        return Response.json({ id: config.accountId });
      if (path.startsWith("/v1/customers/"))
        return Response.json({
          id: scope.customerId,
          livemode: false,
          metadata,
        });
      return Response.json(value);
    });
  it("reads the saved session and returns only a binding candidate", async () => {
    const result = await stripeSandboxBilling(
      config,
      transport(session),
    ).readCheckout(scope, "cs_test_saved");
    expect(result.subscription).toBe("sub_fixture");
    expect(result).not.toHaveProperty("accessUntil");
  });
  it.each([
    { ...session, customer: "cus_other" },
    { ...session, client_reference_id: "other" },
    { ...session, livemode: true },
    { ...session, id: "cs_test_other" },
  ])("rejects foreign or live sessions", async (value) => {
    await expect(
      stripeSandboxBilling(config, transport(value)).readCheckout(
        scope,
        "cs_test_saved",
      ),
    ).rejects.toThrow("stripe_billing_response_mismatch");
  });
});
