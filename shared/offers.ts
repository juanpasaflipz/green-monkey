import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import {
  allocate,
  discount,
  DomainError,
  id,
  manualDiscountInput,
  money,
  offerCode,
  sum,
  type ManualDiscount,
  type PricedLine,
} from "./domain.js";

/** Versioned contract: change when stacking, ordering or rounding rules change. */
export const OFFER_RULES_VERSION = 1;
export const offerChannels = ["pos", "qr", "kiosk"] as const;
export { offerCode, manualDiscountInput, type ManualDiscount };
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const offerFields = z
  .object({
    id,
    name: z.string().trim().min(1).max(80),
    kind: z.enum(["percent", "amount"]),
    /** Basis points for percent offers; minor units per order (order scope) or
     * per unit (product/category scope) for amount offers. */
    value: z.number().int().min(1).max(100_000_000),
    scope: z.enum(["order", "product", "category"]),
    targets: z.array(z.string().min(1).max(120)).max(100).default([]),
    minSubtotal: money.default(0),
    maxReduction: money
      .refine((n) => n > 0)
      .nullable()
      .default(null),
    days: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .default([1, 2, 3, 4, 5, 6, 7]),
    fromMinute: z.number().int().min(0).max(1439).default(0),
    toMinute: z.number().int().min(1).max(1440).default(1440),
    startsOn: day.nullable().default(null),
    endsOn: day.nullable().default(null),
    channels: z
      .array(z.enum(offerChannels))
      .min(1)
      .max(3)
      .default([...offerChannels]),
    code: offerCode.nullable().default(null),
    usageLimit: z.number().int().min(1).max(1_000_000).nullable().default(null),
    stackable: z.boolean().default(true),
    active: z.boolean().default(true),
  })
  .strict()
  .superRefine((o, ctx) => {
    if (o.kind === "percent" && o.value > 10000)
      ctx.addIssue({ code: "custom", message: "invalid_discount" });
    if (o.scope !== "order" && !o.targets.length)
      ctx.addIssue({ code: "custom", message: "targets_required" });
    if (o.scope === "order" && o.targets.length)
      ctx.addIssue({ code: "custom", message: "targets_not_allowed" });
    if (o.startsOn && o.endsOn && o.startsOn > o.endsOn)
      ctx.addIssue({ code: "custom", message: "invalid_period" });
    if (new Set(o.days).size !== o.days.length)
      ctx.addIssue({ code: "custom", message: "invalid_days" });
  });
export const offerInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(0),
    offer: offerFields,
  })
  .strict();
export type Offer = z.infer<typeof offerFields> & {
  version: number;
  redeemed: number;
};
export type OfferClock = { date: string; weekday: number; minute: number };
/** Offers are scheduled on the restaurant's local wall clock, never the server's. */
export function offerClock(instant: string, zone: string): OfferClock {
  const local = Temporal.Instant.from(instant).toZonedDateTimeISO(zone);
  return {
    date: local.toPlainDate().toString(),
    weekday: local.dayOfWeek,
    minute: local.hour * 60 + local.minute,
  };
}
export type OfferContext = {
  channel: string;
  clock: OfferClock;
  /** Only the first submission of an order may redeem codes or fixed order amounts. */
  firstRound: boolean;
  code?: string | null;
  manual?: Pick<ManualDiscount, "kind" | "value" | "reason"> | null;
};
export type AppliedOffer = {
  kind: "promotion" | "manual";
  id: string | null;
  version: number | null;
  name: string;
  code: string | null;
  amount: number;
  reason?: string;
};
export type CodeStatus = "applied" | "invalid" | "not_eligible" | "superseded";
export type OfferQuote = {
  rules: number;
  lines: PricedLine[];
  subtotal: number;
  discount: number;
  total: number;
  applied: AppliedOffer[];
  code: { code: string; status: CodeStatus } | null;
};

function inWindow(o: Offer, c: OfferClock) {
  if (o.startsOn && c.date < o.startsOn) return false;
  if (o.endsOn && c.date > o.endsOn) return false;
  // A window such as 22:00–02:00 wraps midnight; the weekday is the local day
  // on which the order is placed.
  const inside =
    o.fromMinute < o.toMinute
      ? c.minute >= o.fromMinute && c.minute < o.toMinute
      : c.minute >= o.fromMinute || c.minute < o.toMinute;
  return inside && o.days.includes(c.weekday);
}
export function eligible(o: Offer, ctx: OfferContext, subtotal: number) {
  if (!o.active || !(o.channels as string[]).includes(ctx.channel))
    return false;
  if (!inWindow(o, ctx.clock)) return false;
  if (o.usageLimit !== null && o.redeemed >= o.usageLimit) return false;
  if (o.code !== null && (!ctx.firstRound || o.code !== ctx.code)) return false;
  if (o.kind === "amount" && o.scope === "order" && !ctx.firstRound)
    return false;
  return subtotal >= o.minSubtotal;
}
const matchesLine = (o: Offer, l: PricedLine, category: string | undefined) =>
  o.scope === "product"
    ? o.targets.includes(l.productId)
    : o.scope === "category" && !!category && o.targets.includes(category);

type Plan = { perLine: Map<string, number>[]; total: number };
/** perLine[i] maps offer id → reduction on line i. */
function plan(
  lines: PricedLine[],
  categories: (string | undefined)[],
  offers: Offer[],
): Plan {
  const perLine = lines.map(() => new Map<string, number>());
  const remaining = lines.map((l) => l.total);
  const capLeft = new Map(
    offers.map((o) => [o.id, o.maxReduction ?? Number.MAX_SAFE_INTEGER]),
  );
  const take = (o: Offer, wanted: number, available: number) =>
    Math.max(0, Math.min(wanted, available, capLeft.get(o.id)!));
  // 1. Item and category offers: the single best offer per line.
  lines.forEach((l, i) => {
    let best: { o: Offer; n: number } | null = null;
    for (const o of offers) {
      if (o.scope === "order" || !matchesLine(o, l, categories[i])) continue;
      const n = take(
        o,
        o.kind === "percent"
          ? discount(l.total, o.value)
          : Math.min(o.value * l.quantity, l.total),
        l.total,
      );
      if (n > 0 && (!best || n > best.n)) best = { o, n };
    }
    if (best) {
      perLine[i].set(best.o.id, best.n);
      remaining[i] -= best.n;
      capLeft.set(best.o.id, capLeft.get(best.o.id)! - best.n);
    }
  });
  // 2. Order offers on what is left: percentages first, then fixed amounts.
  for (const o of offers.filter((o) => o.scope === "order")) {
    const base = sum(remaining);
    if (base <= 0) break;
    const n = take(
      o,
      o.kind === "percent" ? discount(base, o.value) : o.value,
      base,
    );
    if (n <= 0) continue;
    allocate(n, remaining).forEach((part, i) => {
      if (!part) return;
      perLine[i].set(o.id, (perLine[i].get(o.id) ?? 0) + part);
      remaining[i] -= part;
    });
    capLeft.set(o.id, capLeft.get(o.id)! - n);
  }
  return {
    perLine,
    total: sum(lines.map((l, i) => l.total - remaining[i])),
  };
}
const order = (a: Offer, b: Offer) =>
  (a.kind === b.kind ? 0 : a.kind === "percent" ? -1 : 1) ||
  b.value - a.value ||
  a.id.localeCompare(b.id);

/**
 * Deterministic pricing shared by every channel.
 *
 * - Stackable offers combine: best item/category offer per line, then order
 *   offers (percentages by descending value, then fixed amounts) on the remainder.
 * - A non-stackable offer only ever applies alone. The guest receives whichever
 *   plan reduces the order most; ties keep the combined plan, then the lowest id.
 * - A manual staff discount is applied last, on what remains.
 * - Percentages round half-up in minor units; order-level reductions are
 *   allocated across lines by largest-remainder so line totals always add up.
 */
export function applyOffers(
  priced: PricedLine[],
  categoryByProduct: Record<string, string>,
  offers: Offer[],
  ctx: OfferContext,
): OfferQuote {
  const subtotal = sum(priced.map((l) => l.total));
  const categories = priced.map((l) => categoryByProduct[l.productId]);
  const usable = offers.filter((o) => eligible(o, ctx, subtotal)).sort(order);
  let best = plan(
    priced,
    categories,
    usable.filter((o) => o.stackable),
  );
  for (const exclusive of usable.filter((o) => !o.stackable)) {
    const alone = plan(priced, categories, [exclusive]);
    if (alone.total > best.total) best = alone;
  }
  const applied: AppliedOffer[] = [];
  for (const o of usable) {
    const amount = sum(best.perLine.map((m) => m.get(o.id) ?? 0));
    if (amount > 0)
      applied.push({
        kind: "promotion",
        id: o.id,
        version: o.version,
        name: o.name,
        code: o.code,
        amount,
      });
  }
  const remaining = priced.map(
    (l, i) => l.total - sum([...best.perLine[i].values()]),
  );
  const manualParts = priced.map(() => 0);
  if (ctx.manual) {
    const base = sum(remaining);
    const amount = Math.min(
      base,
      ctx.manual.kind === "percent"
        ? discount(base, ctx.manual.value)
        : ctx.manual.value,
    );
    if (amount <= 0) throw new DomainError("invalid_discount");
    allocate(amount, remaining).forEach((part, i) => {
      manualParts[i] = part;
      remaining[i] -= part;
    });
    applied.push({
      kind: "manual",
      id: null,
      version: null,
      name: ctx.manual.reason,
      code: null,
      amount,
      reason: ctx.manual.reason,
    });
  }
  const lines = priced.map((l, i) => {
    const reduction = l.total - remaining[i];
    if (!reduction) return l;
    return {
      ...l,
      gross: l.total,
      discount: reduction,
      total: remaining[i],
      offers: [
        ...[...best.perLine[i]].map(([offerId, amount]) => ({
          id: offerId as string | null,
          amount,
        })),
        ...(manualParts[i] ? [{ id: null, amount: manualParts[i] }] : []),
      ],
    };
  });
  let code: OfferQuote["code"] = null;
  if (ctx.code) {
    const named = offers.find((o) => o.code === ctx.code);
    code = {
      code: ctx.code,
      status: !named
        ? "invalid"
        : !usable.includes(named)
          ? "not_eligible"
          : applied.some((a) => a.id === named.id)
            ? "applied"
            : "superseded",
    };
  }
  const total = sum(remaining);
  return {
    rules: OFFER_RULES_VERSION,
    lines,
    subtotal,
    discount: subtotal - total,
    total,
    applied,
    code,
  };
}
