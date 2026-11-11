import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { type PricedLine } from "../shared/domain";
import {
  applyOffers,
  eligible,
  offerClock,
  offerFields,
  type Offer,
  type OfferContext,
} from "../shared/offers";

const productA = randomUUID(),
  productB = randomUUID();
const line = (productId: string, total: number, quantity = 1): PricedLine => ({
  id: randomUUID(),
  productId,
  quantity,
  options: [],
  note: "",
  name: { es: "x", en: "x" },
  optionNames: [],
  unitPrice: total / quantity,
  total,
  cost: null,
  station: "kitchen",
  recipe: [],
  productVersion: 1,
});
let sequence = 0;
const offer = ({ version, redeemed, ...o }: Partial<Offer>): Offer => ({
  ...offerFields.parse({
    id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    name: "Offer",
    kind: "percent",
    value: 1000,
    scope: "order",
    ...o,
  }),
  version: version ?? 1,
  redeemed: redeemed ?? 0,
});
// Wednesday 2026-11-11 13:30 in Mexico City.
const clock = offerClock("2026-11-11T19:30:00Z", "America/Mexico_City");
const ctx = (c: Partial<OfferContext> = {}): OfferContext => ({
  channel: "pos",
  clock,
  firstRound: true,
  ...c,
});
const categories = { [productA]: "Burritos", [productB]: "Bebidas" };

describe("offer scheduling", () => {
  it("uses the restaurant wall clock", () => {
    expect(clock).toEqual({ date: "2026-11-11", weekday: 3, minute: 810 });
    expect(offerClock("2026-11-12T05:30:00Z", "America/Mexico_City")).toEqual({
      date: "2026-11-11",
      weekday: 3,
      minute: 1410,
    });
  });
  it("honours days, hours, dates, channels, limits and minimums", () => {
    const ok = (o: Partial<Offer>, c = ctx(), subtotal = 10000) =>
      eligible(offer(o), c, subtotal);
    expect(ok({})).toBe(true);
    expect(ok({ days: [1, 2] })).toBe(false);
    expect(ok({ fromMinute: 810, toMinute: 811 })).toBe(true);
    expect(ok({ fromMinute: 811, toMinute: 900 })).toBe(false);
    expect(ok({ fromMinute: 0, toMinute: 810 })).toBe(false);
    expect(ok({ fromMinute: 1320, toMinute: 120 })).toBe(false);
    expect(ok({ fromMinute: 1320, toMinute: 840 })).toBe(true);
    expect(ok({ startsOn: "2026-11-12" })).toBe(false);
    expect(ok({ endsOn: "2026-11-10" })).toBe(false);
    expect(ok({ startsOn: "2026-11-11", endsOn: "2026-11-11" })).toBe(true);
    expect(ok({ channels: ["qr"] })).toBe(false);
    expect(ok({ active: false })).toBe(false);
    expect(ok({ usageLimit: 2, redeemed: 2 })).toBe(false);
    expect(ok({ usageLimit: 2, redeemed: 1 })).toBe(true);
    expect(ok({ minSubtotal: 10001 })).toBe(false);
    expect(ok({ code: "HOLA10" })).toBe(false);
    expect(ok({ code: "HOLA10" }, ctx({ code: "HOLA10" }))).toBe(true);
    expect(
      ok({ code: "HOLA10" }, ctx({ code: "HOLA10", firstRound: false })),
    ).toBe(false);
    expect(ok({ kind: "amount", value: 500 }, ctx({ firstRound: false }))).toBe(
      false,
    );
  });
  it("validates definitions", () => {
    const base = { id: randomUUID(), name: "x", kind: "percent", value: 500 };
    expect(() => offerFields.parse({ ...base, scope: "product" })).toThrow();
    expect(() =>
      offerFields.parse({ ...base, scope: "order", value: 10001 }),
    ).toThrow();
    expect(() =>
      offerFields.parse({ ...base, scope: "order", targets: ["x"] }),
    ).toThrow();
    expect(
      offerFields.parse({ ...base, scope: "order", code: " hola10 " }).code,
    ).toBe("HOLA10");
  });
});

describe("offer pricing", () => {
  it("leaves undiscounted lines untouched", () => {
    const lines = [line(productA, 9900)];
    const q = applyOffers(lines, categories, [], ctx());
    expect(q).toMatchObject({ subtotal: 9900, discount: 0, total: 9900 });
    expect(q.lines[0]).toBe(lines[0]);
  });
  it("allocates an order percentage so lines add up exactly", () => {
    const q = applyOffers(
      [line(productA, 3333), line(productB, 3333), line(productA, 3335)],
      categories,
      [offer({ value: 1500 })],
      ctx(),
    );
    expect(q.discount).toBe(1500); // 15% of 100.01 = 15.0015 → 15.00
    expect(q.total).toBe(8501);
    expect(q.lines.reduce((a, l) => a + l.total, 0)).toBe(8501);
    expect(q.lines.reduce((a, l) => a + (l.discount ?? 0), 0)).toBe(1500);
    for (const l of q.lines) expect(l.gross! - l.discount!).toBe(l.total);
  });
  it("picks the best item offer per line and then stacks order offers", () => {
    const item = offer({ scope: "product", targets: [productA], value: 2000 });
    const category = offer({
      scope: "category",
      targets: ["Burritos"],
      kind: "amount",
      value: 1000,
    });
    const ten = offer({ value: 1000 });
    const fixed = offer({ kind: "amount", value: 500 });
    const q = applyOffers(
      [line(productA, 10000, 2), line(productB, 4000)],
      categories,
      [fixed, ten, category, item],
      ctx(),
    );
    // Line A: 20% = 2000 ties $10 × 2 = 2000 → the percentage sorts first.
    // Remainder 8000 + 4000 = 12000 → 10% = 1200 → then $5.
    expect(q.applied.map((a) => [a.id, a.amount])).toEqual([
      [item.id, 2000],
      [ten.id, 1200],
      [fixed.id, 500],
    ]);
    expect(q.total).toBe(14000 - 3700);
    expect(q.lines.reduce((a, l) => a + l.total, 0)).toBe(q.total);
  });
  it("applies a non-stackable offer alone only when it is the better deal", () => {
    const stack = offer({ value: 1000 });
    const exclusive = offer({ value: 2500, stackable: false });
    const weak = offer({ value: 500, stackable: false });
    const lines = [line(productA, 10000)];
    const better = applyOffers(lines, categories, [stack, exclusive], ctx());
    expect(better.applied).toHaveLength(1);
    expect(better.applied[0]).toMatchObject({ id: exclusive.id, amount: 2500 });
    const worse = applyOffers(lines, categories, [stack, weak], ctx());
    expect(worse.applied[0]).toMatchObject({ id: stack.id, amount: 1000 });
  });
  it("caps reductions and never goes below zero", () => {
    const capped = applyOffers(
      [line(productA, 100000)],
      categories,
      [offer({ value: 5000, maxReduction: 3000 })],
      ctx(),
    );
    expect(capped.discount).toBe(3000);
    const free = applyOffers(
      [line(productA, 800)],
      categories,
      [offer({ kind: "amount", value: 5000 }), offer({ value: 10000 })],
      ctx(),
    );
    expect(free.total).toBe(0);
    expect(free.discount).toBe(800);
    expect(free.lines[0].total).toBe(0);
  });
  it("reports what happened to a typed code", () => {
    const lines = [line(productA, 10000)];
    const code = offer({ code: "HOLA10", value: 1000, stackable: false });
    const auto = offer({ value: 2000 });
    const status = (offers: Offer[], c: Partial<OfferContext>) =>
      applyOffers(lines, categories, offers, ctx(c)).code?.status;
    expect(status([code], { code: "HOLA10" })).toBe("applied");
    expect(status([code], { code: "NOPE" })).toBe("invalid");
    expect(status([{ ...code, active: false }], { code: "HOLA10" })).toBe(
      "not_eligible",
    );
    expect(status([code, auto], { code: "HOLA10" })).toBe("superseded");
    expect(status([code], {})).toBeUndefined();
  });
  it("applies a manual discount last and records the reason", () => {
    const q = applyOffers(
      [line(productA, 10000), line(productB, 5000)],
      categories,
      [offer({ value: 1000 })],
      ctx({ manual: { kind: "percent", value: 10000, reason: "Cortesía" } }),
    );
    expect(q.total).toBe(0);
    expect(q.applied.map((a) => [a.kind, a.amount])).toEqual([
      ["promotion", 1500],
      ["manual", 13500],
    ]);
    expect(q.lines[0].offers).toHaveLength(2);
    expect(() =>
      applyOffers([line(productA, 0)], categories, [], {
        ...ctx(),
        manual: { kind: "amount", value: 100, reason: "abc" },
      }),
    ).toThrow();
  });
  it("is deterministic regardless of offer order", () => {
    const offers = [
      offer({ value: 700 }),
      offer({ kind: "amount", value: 333 }),
      offer({ scope: "category", targets: ["Bebidas"], value: 1234 }),
      offer({ value: 700 }),
    ];
    const lines = [line(productA, 9999, 3), line(productB, 4567)];
    const a = applyOffers(lines, categories, offers, ctx());
    const b = applyOffers(lines, categories, [...offers].reverse(), ctx());
    expect(a).toEqual(b);
  });
});
