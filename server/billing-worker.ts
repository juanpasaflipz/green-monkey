import type { billingStore } from "./billing-store.js";
import type {
  stripeSandboxBilling,
  SubscriptionBinding,
} from "./stripe-billing.js";

export async function billingTick(
  store: ReturnType<typeof billingStore>,
  provider: ReturnType<typeof stripeSandboxBilling>,
) {
  await store.signupIntents();
  await store.schedule();
  const op = await store.claim();
  if (!op) return false;
  try {
    const scope = {
      organizationId: op.organization_id as string,
      customerId: op.binding.customer_id as string,
    };
    const subscriptionBinding: SubscriptionBinding = {
      ...scope,
      subscriptionId: op.binding.subscription_id,
      interval: op.binding.interval,
      locations: op.locations,
    };
    let result: Record<string, unknown>;
    if (op.kind === "location_quote")
      result =
        op.payload.prorationDate! < Math.floor(Date.now() / 1000) - 600
          ? { expired: true }
          : await provider.quoteLocation(
              subscriptionBinding,
              op.payload.prorationDate!,
              op.id,
            );
    else if (op.kind === "location_update")
      result = await provider.updateLocation(
        subscriptionBinding,
        op.payload.quote!,
        op.id,
      );
    else if (op.kind === "location_watch") {
      const update = await provider.readLocationUpdate(
        subscriptionBinding,
        op.payload.quote!,
        op.payload.mutationId!,
        op.payload.invoiceId,
      );
      if (update.state === "pending") {
        await store.defer(op.id, op.lease_token, { url: update.url });
        return true;
      }
      if (update.state === "expired") result = { expired: true };
      else {
        const entitlement = await provider.readSubscription({
          ...subscriptionBinding,
          locations: op.payload.quote!.locations,
        });
        await store.complete(
          op.id,
          op.lease_token,
          { applied: true },
          entitlement,
        );
        return true;
      }
    } else if (op.kind === "customer")
      result = await provider.createCustomer(scope.organizationId, op.id);
    else if (op.kind === "trial")
      result = await provider.createTrial(scope, op.payload.interval, op.id);
    else if (op.kind === "checkout")
      result = await provider.createCheckout(
        scope,
        op.payload.interval,
        op.locations,
        op.id,
      );
    else if (op.kind === "portal")
      result = await provider.createPortal(scope, op.id);
    else if (op.kind === "checkout_watch") {
      const checkout = await provider.readCheckout(
        scope,
        op.payload.sessionId!,
      );
      if (checkout.status === "open") throw Error("checkout_pending");
      if (checkout.status === "expired") result = { expired: true };
      else {
        if (!checkout.subscription)
          throw Error("checkout_subscription_pending");
        const entitlement = await provider.readSubscription({
          ...scope,
          subscriptionId: checkout.subscription,
          interval: op.payload.interval,
          locations: op.locations,
        });
        await store.complete(
          op.id,
          op.lease_token,
          { subscriptionId: checkout.subscription },
          entitlement,
        );
        return true;
      }
    } else {
      const binding: SubscriptionBinding = {
        ...scope,
        subscriptionId: op.binding.subscription_id,
        interval: op.binding.interval,
        locations: op.locations,
      };
      const entitlement = await provider.readSubscription(binding);
      await store.complete(op.id, op.lease_token, {}, entitlement);
      return true;
    }
    await store.complete(op.id, op.lease_token, result);
  } catch {
    // Persisted retry state survives process death. Provider error bodies and
    // hosted-session URLs must never be emitted into logs.
    await store.retry(op.id, op.lease_token);
  }
  return true;
}
