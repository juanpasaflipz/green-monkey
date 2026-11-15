import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Verify raw bytes before JSON parsing. This authenticates delivery, not ownership
 * or entitlement. The future inbox must durably deduplicate the returned event ID.
 */
export function verifyStripeEvent(
  body: Buffer,
  signature: string,
  secret: string,
  mode: "sandbox" | "live",
  now = Date.now(),
) {
  const fail = () => {
    throw Error("stripe_webhook_invalid");
  };
  if (!/^whsec_[A-Za-z0-9]+$/.test(secret))
    throw Error("stripe_webhook_secret_required");
  if (
    !Buffer.isBuffer(body) ||
    body.length > 262_144 ||
    signature.length > 4096
  )
    return fail();
  const fields = signature.split(",").map((field) => field.trim().split("="));
  const timestamps = fields.filter(([key]) => key === "t");
  const timestamp = timestamps[0]?.[1] ?? "";
  if (
    timestamps.length !== 1 ||
    !/^\d{1,12}$/.test(timestamp) ||
    !Number.isFinite(now) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    return fail();
  const expected = createHmac("sha256", secret)
    .update(timestamp + ".")
    .update(body)
    .digest();
  const valid = fields.some(
    ([key, value]) =>
      key === "v1" &&
      /^[a-f0-9]{64}$/.test(value ?? "") &&
      timingSafeEqual(expected, Buffer.from(value, "hex")),
  );
  if (!valid) return fail();
  try {
    return z
      .object({
        id: z.string().regex(/^evt_[A-Za-z0-9]+$/),
        object: z.literal("event"),
        // A sandbox endpoint never accepts a live event, and the reverse.
        livemode: z.literal(mode === "live"),
        // Platform billing only; connected-account events belong to another scope.
        account: z.null().optional(),
        type: z.string().min(1).max(200),
        created: z.number().int().nonnegative(),
        data: z.object({ object: z.record(z.string(), z.unknown()) }),
      })
      .parse(JSON.parse(body.toString("utf8")));
  } catch {
    return fail();
  }
}

export const verifyStripeSandboxEvent = (
  body: Buffer,
  signature: string,
  secret: string,
  now = Date.now(),
) => verifyStripeEvent(body, signature, secret, "sandbox", now);

export function subscriptionEventReference(
  event: ReturnType<typeof verifyStripeEvent>,
): string | null {
  if (
    [
      "invoice.paid",
      "invoice.payment_failed",
      "invoice.voided",
      "invoice.marked_uncollectible",
    ].includes(event.type)
  ) {
    const invoice = z
      .object({
        object: z.literal("invoice"),
        parent: z
          .object({
            type: z.literal("subscription_details"),
            subscription_details: z.object({
              subscription: z.string().regex(/^sub_[A-Za-z0-9]+$/),
            }),
          })
          .nullable(),
      })
      .safeParse(event.data.object);
    if (!invoice.success) throw Error("stripe_subscription_event_invalid");
    return invoice.data.parent?.subscription_details.subscription ?? null;
  }
  if (
    ![
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "customer.subscription.paused",
      "customer.subscription.resumed",
      "customer.subscription.trial_will_end",
    ].includes(event.type)
  )
    return null;
  const parsed = z
    .object({
      object: z.literal("subscription"),
      id: z.string().regex(/^sub_[A-Za-z0-9]+$/),
    })
    .safeParse(event.data.object);
  if (!parsed.success) throw Error("stripe_subscription_event_invalid");
  // Never use the event's status/metadata/customer to authorize or grant access.
  return parsed.data.id;
}
