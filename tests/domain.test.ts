import { payableUnits, allocatePayment } from "../shared/settlement";
import { restaurantSettings } from "../shared/restaurant";
import { describe, it, expect } from "vitest";
import {
  minor,
  currencyExponent,
  allocate,
  discount,
  tax,
  convert,
  businessDate,
  boundaries,
  nextPreparation,
  finance,
  forecast,
  quote,
  type Product,
} from "../shared/domain";
import { randomUUID } from "node:crypto";
describe("exact money", () => {
  it("rounds decimal strings explicitly", () => {
    expect(minor("1.005")).toBe(101);
    expect(minor("0.29")).toBe(29);
    expect(() => minor("NaN")).toThrow();
    expect(() => minor("100000000")).toThrow();
  });
  it("deterministically allocates cents", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(1, [0, 1, 1])).toEqual([0, 1, 0]);
    expect(() => allocate(3, [])).toThrow();
  });
  it("calculates discounts and configured taxes", () => {
    expect(discount(999, 1500)).toBe(150);
    expect(discount(999, 10000)).toBe(999);
    expect(tax(11600, 1600, true)).toBe(1600);
    expect(tax(10000, 1600, false)).toBe(1600);
  });
});
describe("units and time", () => {
  it("converts explicitly and rejects dimensional mismatches", () => {
    expect(convert("1.25", "kg", "g")).toBe("1250.000000");
    expect(() => convert("1", "kg", "piece")).toThrow();
  });
  it("uses restaurant cutoff with half-open intervals", () => {
    expect(
      businessDate("2026-01-01T08:00:00Z", "America/Mexico_City", 240),
    ).toBe("2025-12-31");
    const b = boundaries("2026-01-01", "America/Mexico_City", 240);
    expect(b.start).toBe("2026-01-01T10:00:00Z");
    expect(businessDate(b.end, "America/Mexico_City", 240)).toBe("2026-01-02");
  });
  it("handles DST and leap days", () => {
    const b = boundaries("2026-03-08", "America/New_York", 0);
    expect(Date.parse(b.end) - Date.parse(b.start)).toBe(23 * 3600_000);
    expect(boundaries("2024-02-29", "UTC", 0).end).toBe("2024-03-01T00:00:00Z");
  });
});
describe("pricing and lifecycle", () => {
  it("requires modifiers and rejects unknown ones", () => {
    const option = randomUUID();
    const p: Product = {
      id: randomUUID(),
      name: { es: "Taco", en: "Taco" },
      category: { es: "Comida", en: "Food" },
      price: 1000,
      available: true,
      station: "kitchen",
      cost: 200,
      version: 1,
      groups: [
        {
          id: randomUUID(),
          name: { es: "Salsa", en: "Salsa" },
          min: 1,
          max: 1,
          options: [
            {
              id: option,
              name: { es: "Verde", en: "Green" },
              price: 50,
              available: true,
            },
          ],
        },
      ],
    };
    const line = {
      id: randomUUID(),
      productId: p.id,
      quantity: 2,
      note: "",
      options: [] as string[],
    };
    expect(() => quote([line], [p])).toThrow();
    expect(quote([{ ...line, options: [option] }], [p])[0].total).toBe(2100);
    expect(() => quote([{ ...line, options: [randomUUID()] }], [p])).toThrow();
  });
  it("never moves a ready ticket backwards", () => {
    expect(nextPreparation("active", "ready")).toBe("ready");
    expect(() => nextPreparation("ready", "active")).toThrow();
  });
});
describe("financial definitions", () => {
  it("separates tips, taxes, refunds and expenses", () => {
    expect(
      finance({
        gross: 11600,
        discounts: 0,
        refunds: 1000,
        taxes: 1600,
        tips: 500,
        cogs: 3000,
        fees: 100,
        commissions: 200,
        expenses: 1000,
      }),
    ).toMatchObject({ netSales: 9000, contribution: 5700, profit: 4700 });
  });
  it("derives forecast profit from forecast inputs", () => {
    const p = forecast(10000, 8000, 0.1, 0.2);
    expect(p.profit).toBe(p.sales - p.costs);
    expect(p.profit).toBe(1400);
  });
});

it("uses the currency minor-unit exponent", () => {
  expect(currencyExponent("JPY")).toBe(0);
  expect(currencyExponent("KWD")).toBe(3);
  expect(minor("1.234", currencyExponent("KWD"))).toBe(1234);
});

describe("item settlement", () => {
  const line = {
    id: "line",
    quantity: 3,
    total: 100,
    name: { es: "Taco", en: "Taco" },
  } as import("../shared/domain").PricedLine;
  it("retains penny allocation and partially paid units", () => {
    const units = payableUnits([line], []);
    expect(units.map((u) => u.total)).toEqual([34, 33, 33]);
    const allocations = allocatePayment(units, 40);
    const remaining = payableUnits([line], allocations);
    expect(remaining.map((u) => u.due)).toEqual([0, 27, 33]);
    expect(allocatePayment(remaining, 27, ["line:1"])).toEqual([
      { lineId: "line", unit: 1, amount: 27 },
    ]);
  });
  it("rejects duplicate, unknown, already-paid or mismatched selections", () => {
    const units = payableUnits(
      [line],
      [{ lineId: "line", unit: 0, amount: 34 }],
    );
    for (const [amount, items] of [
      [33, ["line:0"]],
      [33, ["other:0"]],
      [33, ["line:1", "line:1"]],
      [32, ["line:1"]],
    ] as [number, string[]][])
      expect(() => allocatePayment(units, amount, items)).toThrow();
    expect(() =>
      payableUnits([line], [{ lineId: "line", unit: 1, amount: 34 }]),
    ).toThrow();
  });
});
it("validates restaurant settings without assuming tax or currency rates", () => {
  const settings = {
    operationId: randomUUID(),
    expectedVersion: 1,
    name: "Restaurant",
    currency: "MXN",
    timezone: "America/Mexico_City",
    cutoff: 240,
    openingDays: [1, 2, 3, 4, 5],
  };
  expect(restaurantSettings.safeParse(settings).success).toBe(true);
  expect(
    restaurantSettings.safeParse({ ...settings, timezone: "not/a-zone" })
      .success,
  ).toBe(false);
  expect(
    restaurantSettings.safeParse({ ...settings, currency: "ZZZ" }).success,
  ).toBe(false);
  expect(
    restaurantSettings.safeParse({ ...settings, openingDays: [1, 1] }).success,
  ).toBe(false);
});
