import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { allocate, DomainError, quote, type Product } from "../shared/domain";
import { legacyProductInput, productInput } from "../shared/menu-schema";
import * as taxModule from "../shared/tax";
import * as satModule from "../shared/sat";
import * as fiscalModule from "../shared/fiscal";
import {
  allocateGroupToLines,
  allocateLargestRemainder,
  allocateOrderDiscount,
  allocationOrder,
  DEFAULT_FISCAL_CONTEXT,
  effectiveFiscalIdentity,
  extractTax,
  fiscalAddressInput,
  fiscalProfileInput,
  fiscalProfileIssues,
  formatFolio,
  groupSelfInvoiceCode,
  lineSnapshot,
  lineTax,
  netCategoryTax,
  normalizeSelfInvoiceCode,
  orderTaxBreakdown,
  orderTaxSummary,
  parseFolio,
  RECOVERY_LINE_NAME,
  refundScopeCategories,
  refundScopeGross,
  refundTaxSplit,
  satTaxWithinTolerance,
  SELF_INVOICE_ALPHABET,
  SELF_INVOICE_CODE_PATTERN,
  selfInvoiceCodeFromBytes,
  TAX_CATEGORIES,
  TAX_RULES,
  taxGroups,
  ticketLineSnapshots,
  type FiscalContext,
  type FiscalProfileInput,
  type TaxCategory,
  type TaxedLine,
  type TaxGroup,
  type TaxSummary,
} from "../shared/fiscal";
import { fakeId, line, rng } from "./fixtures/fiscal";

const general = DEFAULT_FISCAL_CONTEXT;
const border: FiscalContext = {
  region: "border_north",
  defaultCategory: "iva8",
};
const rate = (c: TaxCategory) => TAX_RULES[c].rateBps;

function domainError(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
  throw new Error("expected a DomainError");
}
function expectDomain(fn: () => unknown, code: string, status: number) {
  const e = domainError(fn);
  expect({ code: e.code, status: e.status }).toEqual({ code, status });
}
/** Every invariant a ticket's tax summary must satisfy (migration 027 repeats them as checks). */
function expectReconciles(s: TaxSummary, total: number) {
  expect(s.gross).toBe(total);
  expect(s.base + s.tax).toBe(total);
  expect(s.grossBeforeDiscount - s.discount).toBe(s.gross);
  expect(s.unallocatedDiscount).toBeGreaterThanOrEqual(0);
  expect(s.unallocatedDiscount).toBeLessThanOrEqual(s.discount);
  expect(s.groups.map((g) => g.category)).toEqual(
    TAX_CATEGORIES.filter((c) => s.groups.some((g) => g.category === c)),
  );
  const sums = { gbd: 0, discount: 0, gross: 0, base: 0, tax: 0 };
  for (const g of s.groups) {
    expect(g.rateBps).toBe(rate(g.category));
    expect(g.grossBeforeDiscount - g.discount).toBe(g.gross);
    expect(g.baseBeforeDiscount - g.discountBase).toBe(g.base);
    expect(g.base + g.tax).toBe(g.gross);
    expect({ base: g.base, tax: g.tax }).toEqual(
      extractTax(g.gross, g.rateBps),
    );
    expect(g.baseBeforeDiscount).toBe(
      extractTax(g.grossBeforeDiscount, g.rateBps).base,
    );
    expect(g.discountBase).toBeGreaterThanOrEqual(0);
    expect(g.discount).toBeGreaterThanOrEqual(0);
    expect(satTaxWithinTolerance(g.base, g.tax, g.rateBps)).toBe(true);
    if (g.category === "iva0" || g.category === "exempt") expect(g.tax).toBe(0);
    sums.gbd += g.grossBeforeDiscount;
    sums.discount += g.discount;
    sums.gross += g.gross;
    sums.base += g.base;
    sums.tax += g.tax;
  }
  expect(sums).toEqual({
    gbd: s.grossBeforeDiscount,
    discount: s.discount,
    gross: s.gross,
    base: s.base,
    tax: s.tax,
  });
}
const group = (
  category: TaxCategory,
  grossBeforeDiscount: number,
  discount = 0,
): TaxGroup =>
  taxGroups([{ lineId: null, category, grossBeforeDiscount, discount }])[0];

/** A random persisted order: mixed categories, legacy lines, voids and per-line discounts. */
function randomOrder(random: ReturnType<typeof rng>) {
  const region = random.pick(taxModule.TAX_REGIONS);
  const ctx: FiscalContext = {
    region,
    defaultCategory: random.pick(taxModule.allowedCategories(region)),
  };
  const lines: TaxedLine[] = [];
  const lineDiscounts: Record<string, number> = {};
  for (let i = 0, n = random.int(1, 12); i < n; i++) {
    const quantity = random.int(1, 5);
    const total =
      random.pick([0, random.int(1, 99), random.int(100, 60_000)]) * quantity;
    const voided = Array.from({ length: quantity }, (_, u) => u).filter(
      () => random.next() < 0.15,
    );
    const l = line({
      total,
      quantity,
      voidedUnits: voided,
      legacy: random.next() < 0.2,
      ctx,
      fiscal: {
        taxCategory: random.pick(["default", ...TAX_CATEGORIES] as const),
      },
    });
    lines.push(l);
    const remaining = lineTax(l, ctx).grossBeforeDiscount;
    if (remaining > 0 && random.next() < 0.35)
      lineDiscounts[l.id] = random.int(0, remaining);
  }
  const net = lines.reduce(
    (acc, l) =>
      acc +
      lineTax(l, ctx, lineDiscounts[l.id] ?? 0).grossBeforeDiscount -
      (lineDiscounts[l.id] ?? 0),
    0,
  );
  // Sometimes a discount that discounts 028 has not wired per line: gross above orders.total.
  const surplus = random.next() < 0.3 ? random.int(0, net) : 0;
  return { lines, lineDiscounts, ctx, total: net - surplus, surplus };
}

describe("module surface", () => {
  it("re-exports every export of shared/tax.ts and shared/sat.ts unchanged", () => {
    for (const [name, value] of Object.entries({ ...taxModule, ...satModule }))
      expect((fiscalModule as Record<string, unknown>)[name], name).toBe(value);
  });
});

describe("lineTax", () => {
  it("uses exactly the units left after voids (lineRemaining)", () => {
    const l = line({ total: 100, quantity: 3, voidedUnits: [0] }); // units 34, 33, 33
    expect(lineTax(l, general)).toEqual({
      lineId: l.id,
      category: "iva16",
      grossBeforeDiscount: 66,
      discount: 0,
      quantity: 2,
      snapshot: true,
    });
    expect(
      lineTax(line({ total: 100, quantity: 3, voidedUnits: [1, 2] }), general),
    ).toMatchObject({ grossBeforeDiscount: 34, quantity: 1 });
    expect(
      lineTax(
        line({ total: 100, quantity: 3, voidedUnits: [0, 1, 2] }),
        general,
      ),
    ).toMatchObject({ grossBeforeDiscount: 0, quantity: 0 });
  });

  it("takes the category from the snapshot, not from the current restaurant default", () => {
    const zero = line({ total: 5000, fiscal: { taxCategory: "iva0" } });
    expect(lineTax(zero, border)).toMatchObject({
      category: "iva0",
      snapshot: true,
    });
    const borderLine = line({ total: 5000, ctx: border });
    // The restaurant later moved to the general region: the sent line keeps its IVA 8%.
    expect(lineTax(borderLine, general)).toMatchObject({
      category: "iva8",
      snapshot: true,
    });
  });

  it("resolves lines without a snapshot (and malformed snapshots) to the restaurant default", () => {
    const legacy = line({ total: 5000, legacy: true });
    expect(lineTax(legacy, general)).toMatchObject({
      category: "iva16",
      snapshot: false,
    });
    expect(lineTax(legacy, border)).toMatchObject({
      category: "iva8",
      snapshot: false,
    });
    const good = line({ total: 5000, fiscal: { taxCategory: "iva0" } });
    for (const bad of [
      null,
      "iva0",
      { ...good.tax, v: 2 },
      { ...good.tax, category: "ieps" },
      { ...good.tax, category: "iva0", rateBps: 1600 },
      { ...good.tax, category: "exempt", rateBps: 0 },
    ]) {
      const l = { ...good, tax: bad } as TaxedLine;
      expect(lineSnapshot(l), JSON.stringify(bad)).toBeNull();
      expect(lineTax(l, border)).toMatchObject({
        category: "iva8",
        snapshot: false,
      });
    }
  });

  it("accepts a discount from 0 up to the remaining total and refuses anything else", () => {
    const l = line({ total: 100, quantity: 3, voidedUnits: [0] });
    expect(lineTax(l, general, 66)).toMatchObject({
      grossBeforeDiscount: 66,
      discount: 66,
    });
    for (const bad of [67, -1, 0.5, Number.NaN])
      expectDomain(
        () => lineTax(l, general, bad),
        "fiscal_total_mismatch",
        409,
      );
  });
});

describe("taxGroups", () => {
  it("sums per category in canonical order, omits empty categories and extracts base and IVA", () => {
    const groups = taxGroups([
      {
        lineId: "a",
        category: "exempt",
        grossBeforeDiscount: 3000,
        discount: 0,
      },
      {
        lineId: "b",
        category: "iva16",
        grossBeforeDiscount: 9000,
        discount: 0,
      },
      { lineId: "c", category: "iva0", grossBeforeDiscount: 0, discount: 0 },
      {
        lineId: "d",
        category: "iva16",
        grossBeforeDiscount: 3500,
        discount: 500,
      },
    ]);
    expect(groups).toEqual([
      {
        category: "iva16",
        rateBps: 1600,
        grossBeforeDiscount: 12500,
        discount: 500,
        gross: 12000,
        baseBeforeDiscount: 10776,
        discountBase: 431,
        base: 10345,
        tax: 1655,
      },
      {
        category: "exempt",
        rateBps: null,
        grossBeforeDiscount: 3000,
        discount: 0,
        gross: 3000,
        baseBeforeDiscount: 3000,
        discountBase: 0,
        base: 3000,
        tax: 0,
      },
    ]);
  });

  it("keeps a fully comped category (gross 0, no IVA) so the discount is still reported", () => {
    expect(
      taxGroups([
        {
          lineId: "a",
          category: "iva16",
          grossBeforeDiscount: 4500,
          discount: 4500,
        },
      ]),
    ).toEqual([
      {
        category: "iva16",
        rateBps: 1600,
        grossBeforeDiscount: 4500,
        discount: 4500,
        gross: 0,
        baseBeforeDiscount: 3879,
        discountBase: 3879,
        base: 0,
        tax: 0,
      },
    ]);
    expect(taxGroups([])).toEqual([]);
  });

  it("refuses portions with a discount above their gross, negative or fractional amounts and unknown categories", () => {
    for (const p of [
      { grossBeforeDiscount: 100, discount: 101 },
      { grossBeforeDiscount: -1, discount: 0 },
      { grossBeforeDiscount: 100, discount: -1 },
      { grossBeforeDiscount: 10.5, discount: 0 },
    ])
      expectDomain(
        () => taxGroups([{ lineId: null, category: "iva16", ...p }]),
        "fiscal_total_mismatch",
        409,
      );
    expect(() =>
      taxGroups([
        {
          lineId: null,
          category: "ieps" as TaxCategory,
          grossBeforeDiscount: 1,
          discount: 0,
        },
      ]),
    ).toThrow(RangeError);
  });
});

describe("orderTaxSummary", () => {
  it("aggregates per category in canonical order and reconciles to the total", () => {
    const lines = [
      line({ total: 3000, fiscal: { taxCategory: "exempt" } }),
      line({ total: 9000, quantity: 2 }),
      line({ total: 4200, fiscal: { taxCategory: "iva0" } }),
      line({ total: 3500 }),
    ];
    const s = orderTaxSummary({ lines, total: 19700, ctx: general });
    expect(s).toEqual({
      groups: [
        {
          category: "iva16",
          rateBps: 1600,
          grossBeforeDiscount: 12500,
          discount: 0,
          gross: 12500,
          baseBeforeDiscount: 10776,
          discountBase: 0,
          base: 10776,
          tax: 1724,
        },
        {
          category: "iva0",
          rateBps: 0,
          grossBeforeDiscount: 4200,
          discount: 0,
          gross: 4200,
          baseBeforeDiscount: 4200,
          discountBase: 0,
          base: 4200,
          tax: 0,
        },
        {
          category: "exempt",
          rateBps: null,
          grossBeforeDiscount: 3000,
          discount: 0,
          gross: 3000,
          baseBeforeDiscount: 3000,
          discountBase: 0,
          base: 3000,
          tax: 0,
        },
      ],
      grossBeforeDiscount: 19700,
      discount: 0,
      unallocatedDiscount: 0,
      gross: 19700,
      base: 17976,
      tax: 1724,
      basis: "line_snapshot",
    });
    expectReconciles(s, 19700);
  });

  it("extracts IVA from the category total, not per line (one rounding per category)", () => {
    // Three 4-centavo lines: per-line extraction would give 1 + 1 + 1 centavos of IVA.
    const lines = [line({ total: 4 }), line({ total: 4 }), line({ total: 4 })];
    const s = orderTaxSummary({ lines, total: 12, ctx: general });
    expect(s.groups[0]).toMatchObject({ gross: 12, base: 10, tax: 2 });
    expectReconciles(s, 12);
  });

  it("after voids uses exactly the remaining units (lineRemaining)", () => {
    const lines = [
      line({ total: 100, quantity: 3, voidedUnits: [0] }), // 34 voided → 66
      line({
        total: 1000,
        quantity: 4,
        voidedUnits: [3],
        fiscal: { taxCategory: "iva0" },
      }), // 750
      line({ total: 5000, quantity: 2, voidedUnits: [0, 1] }), // fully voided → dropped
    ];
    const b = orderTaxBreakdown({ lines, total: 816, ctx: general });
    expect(
      b.portions.map((p) => [p.category, p.grossBeforeDiscount, p.quantity]),
    ).toEqual([
      ["iva16", 66, 2],
      ["iva0", 750, 3],
    ]);
    expect(
      b.summary.groups.map((g) => [g.category, g.gross, g.base, g.tax]),
    ).toEqual([
      ["iva16", 66, 57, 9],
      ["iva0", 750, 750, 0],
    ]);
    expectReconciles(b.summary, 816);
  });

  it("with line discounts: base_before − discount_base = base; discount_base ≥ 0", () => {
    const a = line({ total: 11600 });
    const b = line({ total: 5800, quantity: 2 });
    const c = line({ total: 2000, fiscal: { taxCategory: "iva0" } });
    const s = orderTaxSummary({
      lines: [a, b, c],
      lineDiscounts: { [a.id]: 1160, [c.id]: 2000 },
      total: 11600 + 5800 + 2000 - 1160 - 2000,
      ctx: general,
    });
    expect(s.groups).toEqual([
      {
        category: "iva16",
        rateBps: 1600,
        grossBeforeDiscount: 17400,
        discount: 1160,
        gross: 16240,
        baseBeforeDiscount: 15000,
        discountBase: 1000,
        base: 14000,
        tax: 2240,
      },
      {
        category: "iva0",
        rateBps: 0,
        grossBeforeDiscount: 2000,
        discount: 2000,
        gross: 0,
        baseBeforeDiscount: 2000,
        discountBase: 2000,
        base: 0,
        tax: 0,
      },
    ]);
    expect(s.unallocatedDiscount).toBe(0);
    expectReconciles(s, 16240);
  });

  it("lines without snapshot give basis issuance_default; no lines give recovery_default", () => {
    const snap = line({ total: 1000 });
    const legacy = line({ total: 1080, legacy: true });
    expect(
      orderTaxSummary({ lines: [snap], total: 1000, ctx: border }).basis,
    ).toBe("line_snapshot");
    const mixed = orderTaxSummary({
      lines: [snap, legacy],
      total: 2080,
      ctx: border,
    });
    expect(mixed.basis).toBe("issuance_default");
    expect(mixed.groups.map((g) => [g.category, g.gross, g.tax])).toEqual([
      ["iva16", 1000, 138],
      ["iva8", 1080, 80],
    ]);
    const recovery = orderTaxBreakdown({
      lines: [],
      total: 23200,
      ctx: general,
    });
    expect(recovery.summary).toMatchObject({
      basis: "recovery_default",
      gross: 23200,
      base: 20000,
      tax: 3200,
      groups: [{ category: "iva16", gross: 23200 }],
    });
    expect(recovery.portions).toEqual([
      {
        lineId: null,
        category: "iva16",
        grossBeforeDiscount: 23200,
        discount: 0,
        quantity: 1,
        snapshot: false,
      },
    ]);
    expect(
      orderTaxSummary({ lines: [], total: 10800, ctx: border }).groups,
    ).toMatchObject([{ category: "iva8", base: 10000, tax: 800 }]);
    expectReconciles(orderTaxSummary({ lines: [], total: 0, ctx: general }), 0);
  });

  it("gross above total is recorded as unallocated discount; below total throws fiscal_total_mismatch", () => {
    const a = line({ total: 6000 });
    const b = line({ total: 4000, fiscal: { taxCategory: "iva0" } });
    const s = orderTaxSummary({ lines: [a, b], total: 9000, ctx: general });
    // The 1000 surplus is spread like domain allocate() over each portion's net.
    expect(s.unallocatedDiscount).toBe(1000);
    expect(s.groups.map((g) => [g.category, g.discount, g.gross])).toEqual([
      ["iva16", 600, 5400],
      ["iva0", 400, 3600],
    ]);
    expectReconciles(s, 9000);
    expectDomain(
      () => orderTaxSummary({ lines: [a, b], total: 10001, ctx: general }),
      "fiscal_total_mismatch",
      409,
    );
    // A discount keyed to a line that is not on the order changes nothing but the surplus.
    const stray = orderTaxSummary({
      lines: [a],
      lineDiscounts: { [randomUUID()]: 50 },
      total: 5950,
      ctx: general,
    });
    expect(stray.unallocatedDiscount).toBe(50);
    expectReconciles(stray, 5950);
  });

  it("a zero-total order (prices 0, fully comped or fully voided) yields no tax", () => {
    for (const lines of [
      [line({ total: 0 })],
      [line({ total: 500, quantity: 1, voidedUnits: [0] })],
    ]) {
      const s = orderTaxSummary({ lines, total: 0, ctx: general });
      expect(s.gross + s.base + s.tax).toBe(0);
      expectReconciles(s, 0);
    }
    const comped = line({ total: 4500 });
    const s = orderTaxSummary({
      lines: [comped],
      lineDiscounts: { [comped.id]: 4500 },
      total: 0,
      ctx: general,
    });
    expect(s).toMatchObject({
      gross: 0,
      tax: 0,
      discount: 4500,
      unallocatedDiscount: 0,
    });
  });

  it("refuses duplicate lines and totals that are not money", () => {
    const a = line({ total: 100 });
    expectDomain(
      () => orderTaxSummary({ lines: [a, a], total: 200, ctx: general }),
      "duplicate_line",
      400,
    );
    for (const total of [-1, 1.5, 100_000_001])
      expectDomain(
        () => orderTaxSummary({ lines: [], total, ctx: general }),
        "invalid_amount",
        400,
      );
  });

  it("property: 3,000 random mixed-category orders (voids, discounts, legacy lines, surplus) reconcile to the centavo", () => {
    const random = rng(10);
    for (let i = 0; i < 3000; i++) {
      const o = randomOrder(random);
      const b = orderTaxBreakdown(o);
      expectReconciles(b.summary, o.total);
      expect(b.summary.unallocatedDiscount).toBe(o.surplus);
      // Independent recomputation: per category, remaining gross and wired discounts.
      for (const c of TAX_CATEGORIES) {
        const members = o.lines
          .map((l) => lineTax(l, o.ctx, o.lineDiscounts[l.id] ?? 0))
          .filter((p) => p.category === c && p.quantity > 0);
        const g = b.summary.groups.find((x) => x.category === c);
        const gbd = members.reduce((acc, p) => acc + p.grossBeforeDiscount, 0);
        const wired = members.reduce((acc, p) => acc + p.discount, 0);
        expect(g?.grossBeforeDiscount ?? 0, c).toBe(gbd);
        expect(g?.discount ?? 0, c).toBeGreaterThanOrEqual(wired);
      }
      for (const p of b.portions)
        expect(p.discount).toBeLessThanOrEqual(p.grossBeforeDiscount);
    }
  });

  it("property: for every category alone, any total splits into base + IVA that reconcile and stay within SAT tolerance", () => {
    const random = rng(11);
    for (const category of TAX_CATEGORIES) {
      const ctx: FiscalContext = {
        region: "border_south",
        defaultCategory: category,
      };
      for (let i = 0; i < 2000; i++) {
        const n = random.int(1, 6);
        const lines = Array.from({ length: n }, () =>
          line({
            total: random.int(0, 200_000),
            fiscal: { taxCategory: category },
            ctx,
          }),
        );
        const total = lines.reduce((acc, l) => acc + l.total, 0);
        const s = orderTaxSummary({ lines, total, ctx });
        expectReconciles(s, total);
        if (total > 0)
          expect(s.groups.map((g) => g.category)).toEqual([category]);
      }
    }
  });
});

describe("allocateLargestRemainder", () => {
  it.each([
    [100, [1, 1, 1], [34, 33, 33]],
    [1, [0, 1, 1], [0, 1, 0]], // tie → earlier index
    [9, [4, 7], [3, 6]], // domain allocate() gives [4, 5]
    [0, [5, 5], [0, 0]],
    [10, [0, 0], [0, 0]],
    [7, [], []],
    [12500, [6000, 4000, 2500], [6000, 4000, 2500]],
  ])("allocateLargestRemainder(%i, %j) = %j", (amount, weights, parts) => {
    expect(allocateLargestRemainder(amount, weights)).toEqual(parts);
  });

  it("property: parts sum exactly, each is the floor or ceiling of its exact share, and none exceeds its weight", () => {
    const random = rng(12);
    for (let i = 0; i < 5000; i++) {
      const weights = Array.from({ length: random.int(1, 10) }, () =>
        random.pick([0, random.int(1, 10), random.int(1, 1_000_000)]),
      );
      const W = weights.reduce((a, b) => a + b, 0);
      const amount = random.int(0, W || 100);
      const parts = allocateLargestRemainder(amount, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(W ? amount : 0);
      parts.forEach((p, k) => {
        if (!W) return expect(p).toBe(0);
        const exact = (BigInt(amount) * BigInt(weights[k])) / BigInt(W);
        expect([Number(exact), Number(exact) + 1]).toContain(p);
        expect(p).toBeLessThanOrEqual(weights[k]);
      });
    }
  });

  it("refuses negative or fractional inputs", () => {
    expect(() => allocateLargestRemainder(-1, [1])).toThrow(RangeError);
    expect(() => allocateLargestRemainder(1.5, [1])).toThrow(RangeError);
    expect(() => allocateLargestRemainder(1, [1, -1])).toThrow(RangeError);
  });
});

describe("allocateGroupToLines", () => {
  it("sums exactly to the group base and tax and flags invalid lines", () => {
    const g = group("iva16", 47); // base 41, tax 6
    const shares = allocateGroupToLines(g, [
      { lineId: "a", grossBeforeDiscount: 4, discount: 0 },
      { lineId: "b", grossBeforeDiscount: 43, discount: 0 },
    ]);
    expect(shares.reduce((acc, s) => acc + s.base, 0)).toBe(g.base);
    expect(shares.reduce((acc, s) => acc + s.tax, 0)).toBe(g.tax);
    // Line b: base 38 allows an IVA of 6 or 7 centavos (38 × 0.16 = 6.08), so its 5 is flagged.
    expect(shares).toEqual([
      {
        lineId: "a",
        baseBeforeDiscount: 3,
        discountBase: 0,
        base: 3,
        tax: 1,
        valid: true,
      },
      {
        lineId: "b",
        baseBeforeDiscount: 38,
        discountBase: 0,
        base: 38,
        tax: 5,
        valid: false,
      },
    ]);
  });

  it("gives a single line exactly its group (always valid)", () => {
    const random = rng(13);
    for (let i = 0; i < 2000; i++) {
      const category = random.pick(TAX_CATEGORIES);
      const gbd = random.int(0, 1_000_000);
      const discount = random.int(0, gbd);
      const g = group(category, gbd, discount);
      if (!g) continue;
      expect(
        allocateGroupToLines(g, [
          { lineId: "x", grossBeforeDiscount: gbd, discount },
        ]),
      ).toEqual([
        {
          lineId: "x",
          baseBeforeDiscount: g.baseBeforeDiscount,
          discountBase: g.discountBase,
          base: g.base,
          tax: g.tax,
          valid: true,
        },
      ]);
    }
  });

  it("flags a line whose discount base would be negative", () => {
    const lines = [
      { lineId: "a", grossBeforeDiscount: 191, discount: 183 },
      { lineId: "b", grossBeforeDiscount: 191, discount: 0 },
    ];
    const g = taxGroups(
      lines.map((l) => ({ ...l, category: "iva16" as const })),
    )[0];
    const shares = allocateGroupToLines(g, lines);
    expect(shares.reduce((acc, s) => acc + s.discountBase, 0)).toBe(
      g.discountBase,
    );
    expect(shares).toEqual([
      {
        lineId: "a",
        baseBeforeDiscount: 165,
        discountBase: 158,
        base: 7,
        tax: 1,
        valid: true,
      },
      {
        lineId: "b",
        baseBeforeDiscount: 164,
        discountBase: -1,
        base: 165,
        tax: 26,
        valid: false,
      },
    ]);
  });

  it("refuses lines that do not add up to the group, and an inconsistent group", () => {
    const g = group("iva16", 1000);
    for (const lines of [
      [{ lineId: "a", grossBeforeDiscount: 999, discount: 0 }],
      [{ lineId: "a", grossBeforeDiscount: 1000, discount: 1 }],
      [{ lineId: "a", grossBeforeDiscount: 1000, discount: 1001 }],
    ])
      expectDomain(
        () => allocateGroupToLines(g, lines),
        "fiscal_total_mismatch",
        409,
      );
    expectDomain(
      () =>
        allocateGroupToLines({ ...g, base: g.base + 1 }, [
          { lineId: "a", grossBeforeDiscount: 1000, discount: 0 },
        ]),
      "fiscal_total_mismatch",
      409,
    );
  });

  it("property: 3,000 random groups split exactly, with non-negative IVA and correct validity flags", () => {
    const random = rng(14);
    for (let i = 0; i < 3000; i++) {
      const category = random.pick(TAX_CATEGORIES);
      const lines = Array.from({ length: random.int(1, 8) }, (_, k) => {
        const gbd = random.pick([
          0,
          random.int(1, 100),
          random.int(100, 80_000),
        ]);
        return {
          lineId: `l${k}`,
          grossBeforeDiscount: gbd,
          discount: random.next() < 0.3 ? random.int(0, gbd) : 0,
        };
      });
      const g = taxGroups(lines.map((l) => ({ ...l, category })))[0];
      if (!g) continue;
      const shares = allocateGroupToLines(g, lines);
      const sum = (k: "base" | "tax" | "baseBeforeDiscount" | "discountBase") =>
        shares.reduce((acc, s) => acc + s[k], 0);
      expect(sum("base")).toBe(g.base);
      expect(sum("tax")).toBe(g.tax);
      expect(sum("baseBeforeDiscount")).toBe(g.baseBeforeDiscount);
      expect(sum("discountBase")).toBe(g.discountBase);
      shares.forEach((s, k) => {
        const net = lines[k].grossBeforeDiscount - lines[k].discount;
        expect(s.base + s.tax).toBe(net);
        expect(s.tax).toBeGreaterThanOrEqual(0);
        expect(s.base).toBeGreaterThanOrEqual(0);
        expect(s.valid).toBe(
          satTaxWithinTolerance(s.base, s.tax, g.rateBps) &&
            s.discountBase >= 0,
        );
      });
    }
  });

  it("regression: realistic undiscounted orders itemize with every line inside the SAT tolerance", () => {
    // With domain allocate()'s first-line remainder about one such order in five had an invalid
    // line; the largest-remainder split keeps every line valid on this seeded sample.
    const random = rng(15);
    for (let i = 0; i < 5000; i++) {
      const category = random.pick(["iva16", "iva8"] as const);
      const lines = Array.from({ length: random.int(1, 6) }, (_, k) => ({
        lineId: `l${k}`,
        grossBeforeDiscount: random.int(1000, 50_000),
        discount: 0,
      }));
      const g = taxGroups(lines.map((l) => ({ ...l, category })))[0];
      expect(allocateGroupToLines(g, lines).every((s) => s.valid)).toBe(true);
    }
  });
});

describe("ticketLineSnapshots", () => {
  it("freezes every remaining line with its share of the category group", () => {
    const taco = line({
      total: 9000,
      quantity: 2,
      name: { es: "Taco al pastor", en: "Al pastor taco" },
      optionNames: [{ es: "Queso extra", en: "Extra cheese" }],
      fiscal: {
        taxCategory: "default",
        satProductKey: "90101503",
        satUnitKey: "H87",
      },
    });
    const agua = line({
      total: 3500,
      name: { es: "Agua de jamaica", en: "Hibiscus water" },
    });
    const salsa = line({ total: 0, name: { es: "Salsa", en: "Salsa" } });
    const coffee = line({ total: 18000, fiscal: { taxCategory: "iva0" } });
    const voided = line({ total: 4000, voidedUnits: [0] });
    const legacy = line({ total: 1000, legacy: true });
    const lines = [taco, agua, salsa, coffee, voided, legacy];
    const b = orderTaxBreakdown({
      lines,
      lineDiscounts: { [coffee.id]: 1800 },
      total: 9000 + 3500 + 18000 - 1800 + 1000,
      ctx: general,
    });
    const snaps = ticketLineSnapshots(lines, b);
    expect(snaps.map((s) => s.lineId)).toEqual([
      taco.id,
      agua.id,
      salsa.id,
      coffee.id,
      legacy.id,
    ]);
    expect(snaps[0]).toMatchObject({
      productId: taco.productId,
      quantity: 2,
      name: taco.name,
      optionNames: taco.optionNames,
      category: "iva16",
      rateBps: 1600,
      satProductKey: "90101503",
      satUnitKey: "H87",
      grossBeforeDiscount: 9000,
      discount: 0,
      gross: 9000,
    });
    expect(snaps[2]).toMatchObject({ gross: 0, base: 0, tax: 0, valid: true });
    expect(snaps[3]).toMatchObject({
      category: "iva0",
      rateBps: 0,
      discount: 1800,
      gross: 16200,
      base: 16200,
      tax: 0,
      baseBeforeDiscount: 18000,
      discountBase: 1800,
    });
    expect(snaps[4]).toMatchObject({
      satProductKey: "90101501",
      satUnitKey: "E48",
    });
    for (const g of b.summary.groups) {
      const members = snaps.filter((s) => s.category === g.category);
      const sum = (k: "gross" | "base" | "tax" | "discount" | "discountBase") =>
        members.reduce((acc, s) => acc + s[k], 0);
      expect([
        sum("gross"),
        sum("base"),
        sum("tax"),
        sum("discount"),
        sum("discountBase"),
      ]).toEqual([g.gross, g.base, g.tax, g.discount, g.discountBase]);
    }
  });

  it("puts an unwired discount surplus into the line discounts so lines still add up to the total", () => {
    const random = rng(16);
    for (let i = 0; i < 1000; i++) {
      const o = randomOrder(random);
      const b = orderTaxBreakdown(o);
      const snaps = ticketLineSnapshots(o.lines, b);
      expect(snaps.reduce((acc, s) => acc + s.gross, 0)).toBe(o.total);
      expect(snaps.reduce((acc, s) => acc + s.base + s.tax, 0)).toBe(o.total);
      expect(snaps.reduce((acc, s) => acc + s.discount, 0)).toBe(
        b.summary.discount,
      );
      for (const s of snaps) {
        expect(s.gross).toBe(s.base + s.tax);
        expect(s.tax).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("gives a reconciled offline sale one synthetic line at the restaurant default", () => {
    const b = orderTaxBreakdown({ lines: [], total: 10800, ctx: border });
    expect(ticketLineSnapshots([], b)).toEqual([
      {
        lineId: null,
        productId: null,
        quantity: 1,
        name: RECOVERY_LINE_NAME,
        optionNames: [],
        category: "iva8",
        rateBps: 800,
        satProductKey: "90101501",
        satUnitKey: "E48",
        grossBeforeDiscount: 10800,
        discount: 0,
        gross: 10800,
        baseBeforeDiscount: 10000,
        discountBase: 0,
        base: 10000,
        tax: 800,
        valid: true,
      },
    ]);
    expect(RECOVERY_LINE_NAME).toEqual({
      es: "Venta sin conexión conciliada",
      en: "Reconciled offline sale",
    });
  });

  it("refuses a breakdown whose portions name lines that were not passed", () => {
    const a = line({ total: 1000 });
    const b = orderTaxBreakdown({ lines: [a], total: 1000, ctx: general });
    expectDomain(
      () => ticketLineSnapshots([], b),
      "fiscal_total_mismatch",
      409,
    );
  });
});

describe("allocateOrderDiscount", () => {
  it("allocates an order-level amount over remaining nets in (round, id) order", () => {
    const first = line({ id: fakeId(900), total: 1000, round: 2 });
    const second = line({ id: fakeId(901), total: 1000, round: 1 });
    const third = line({ id: fakeId(902), total: 1000, round: 1 });
    expect(allocationOrder([first, second, third]).map((l) => l.id)).toEqual([
      second.id,
      third.id,
      first.id,
    ]);
    // 100 over three equal nets: allocate() gives the leftover centavo to the first in order.
    expect(
      allocateOrderDiscount({ lines: [first, second, third], amount: 100 }),
    ).toEqual({
      [second.id]: 34,
      [third.id]: 33,
      [first.id]: 33,
    });
  });

  it("merges with line discounts, uses only what is still undiscounted and never exceeds a line", () => {
    const a = line({ total: 1000 });
    const b = line({ total: 3000, quantity: 3, voidedUnits: [2] }); // 2000 remaining
    const merged = allocateOrderDiscount({
      lines: [a, b],
      amount: 1500,
      lineDiscounts: { [a.id]: 1000 },
    });
    expect(merged).toEqual({ [a.id]: 1000, [b.id]: 1500 });
    expectDomain(
      () =>
        allocateOrderDiscount({
          lines: [a, b],
          amount: 2001,
          lineDiscounts: { [a.id]: 1000 },
        }),
      "fiscal_total_mismatch",
      409,
    );
    expectDomain(
      () =>
        allocateOrderDiscount({
          lines: [a],
          amount: 0,
          lineDiscounts: { [a.id]: 1001 },
        }),
      "fiscal_total_mismatch",
      409,
    );
    expect(allocateOrderDiscount({ lines: [a], amount: 0 })).toEqual({});
  });

  it("property: merged discounts stay within each line and the order reconciles with no unallocated discount", () => {
    const random = rng(17);
    for (let i = 0; i < 1000; i++) {
      const o = randomOrder(random);
      const net = o.total + o.surplus;
      const amount = random.int(0, net);
      const merged = allocateOrderDiscount({
        lines: o.lines,
        amount,
        lineDiscounts: o.lineDiscounts,
      });
      for (const l of o.lines)
        expect(merged[l.id] ?? 0).toBeLessThanOrEqual(
          lineTax(l, o.ctx).grossBeforeDiscount,
        );
      const s = orderTaxSummary({
        lines: o.lines,
        lineDiscounts: merged,
        total: net - amount,
        ctx: o.ctx,
      });
      expect(s.unallocatedDiscount).toBe(0);
      expectReconciles(s, net - amount);
    }
  });
});

describe("refundTaxSplit", () => {
  const sale = orderTaxSummary({
    lines: [
      line({ total: 12500 }),
      line({ total: 4200, fiscal: { taxCategory: "iva0" } }),
      line({ total: 3000, fiscal: { taxCategory: "exempt" } }),
    ],
    total: 19700,
    ctx: general,
  }).groups;

  it("one full refund returns exactly the sale's tax per category", () => {
    expect(
      refundTaxSplit({ refundGross: 19700, saleGroups: sale, previous: [] }),
    ).toEqual([
      {
        category: "iva16",
        rateBps: 1600,
        gross: 12500,
        base: 10776,
        tax: 1724,
      },
      { category: "iva0", rateBps: 0, gross: 4200, base: 4200, tax: 0 },
      { category: "exempt", rateBps: null, gross: 3000, base: 3000, tax: 0 },
    ]);
  });

  it("three partial refunds net to the sale's tax exactly (property test over 1,000 random splits)", () => {
    const random = rng(18);
    for (let i = 0; i < 1000; i++) {
      const groups = TAX_CATEGORIES.filter(() => random.next() < 0.7).map(
        (category) => ({
          category,
          rateBps: rate(category),
          gross: random.int(1, 500_000),
        }),
      );
      if (!groups.length) continue;
      const total = groups.reduce((acc, g) => acc + g.gross, 0);
      const cut1 = random.int(1, total);
      const cut2 = random.int(cut1, total);
      const refunds = [cut1, cut2 - cut1, total - cut2].filter((x) => x > 0);
      const previous: { category: TaxCategory; gross: number; tax: number }[] =
        [];
      for (const refundGross of refunds) {
        const rows = refundTaxSplit({
          refundGross,
          saleGroups: groups,
          previous,
        });
        expect(rows.reduce((acc, r) => acc + r.gross, 0)).toBe(refundGross);
        for (const r of rows) {
          expect(r.base + r.tax).toBe(r.gross);
          expect(r.base).toBeGreaterThanOrEqual(0);
          expect(r.tax).toBeGreaterThanOrEqual(0);
          // Complement extraction differs from this refund's own extraction by at most 1 centavo (P4).
          expect(
            Math.abs(r.tax - extractTax(r.gross, r.rateBps).tax),
          ).toBeLessThanOrEqual(1);
          previous.push({ category: r.category, gross: r.gross, tax: r.tax });
        }
      }
      for (const g of groups) {
        const mine = previous.filter((p) => p.category === g.category);
        expect(mine.reduce((acc, p) => acc + p.gross, 0)).toBe(g.gross);
        expect(mine.reduce((acc, p) => acc + p.tax, 0)).toBe(
          extractTax(g.gross, g.rateBps).tax,
        );
      }
      expectDomain(
        () => refundTaxSplit({ refundGross: 1, saleGroups: groups, previous }),
        "fiscal_refund_exceeds",
        409,
      );
    }
  });

  it("mixed categories split proportionally to unrefunded gross and never go negative", () => {
    const first = refundTaxSplit({
      refundGross: 9850,
      saleGroups: sale,
      previous: [],
    });
    expect(first).toEqual([
      { category: "iva16", rateBps: 1600, gross: 6250, base: 5388, tax: 862 },
      { category: "iva0", rateBps: 0, gross: 2100, base: 2100, tax: 0 },
      { category: "exempt", rateBps: null, gross: 1500, base: 1500, tax: 0 },
    ]);
    // After an item refund of the exempt line only, the next refund skips that category.
    const previous = [
      ...first,
      { category: "exempt" as const, gross: 1500, tax: 0 },
    ];
    const next = refundTaxSplit({
      refundGross: 8350,
      saleGroups: sale,
      previous,
    });
    expect(next).toEqual([
      { category: "iva16", rateBps: 1600, gross: 6250, base: 5388, tax: 862 },
      { category: "iva0", rateBps: 0, gross: 2100, base: 2100, tax: 0 },
    ]);
    expect(first[0].tax + next[0].tax).toBe(1724);
    // A category refunded beyond what the (later) sale groups hold is simply not offered again.
    expect(
      refundTaxSplit({
        refundGross: 100,
        saleGroups: [{ category: "iva16", rateBps: 1600, gross: 1000 }],
        previous: [{ category: "iva0", gross: 5000, tax: 0 }],
      }),
    ).toEqual([
      { category: "iva16", rateBps: 1600, gross: 100, base: 86, tax: 14 },
    ]);
  });

  it("item-scoped refund uses the scope categories and rejects scope above remaining", () => {
    expect(
      refundTaxSplit({
        refundGross: 4200,
        saleGroups: sale,
        previous: [],
        scope: [{ category: "iva0", gross: 4200 }],
      }),
    ).toEqual([
      { category: "iva0", rateBps: 0, gross: 4200, base: 4200, tax: 0 },
    ]);
    expect(
      refundTaxSplit({
        refundGross: 5000,
        saleGroups: sale,
        previous: [],
        scope: [
          { category: "iva16", gross: 2500 },
          { category: "iva16", gross: 2500 },
        ],
      }),
    ).toEqual([
      { category: "iva16", rateBps: 1600, gross: 5000, base: 4310, tax: 690 },
    ]);
    expectDomain(
      () =>
        refundTaxSplit({
          refundGross: 4201,
          saleGroups: sale,
          previous: [],
          scope: [{ category: "iva0", gross: 4201 }],
        }),
      "fiscal_refund_exceeds",
      409,
    );
    expectDomain(
      () =>
        refundTaxSplit({
          refundGross: 100,
          saleGroups: sale,
          previous: [{ category: "iva0", gross: 4200, tax: 0 }],
          scope: [{ category: "iva0", gross: 100 }],
        }),
      "fiscal_refund_exceeds",
      409,
    );
    expectDomain(
      () =>
        refundTaxSplit({
          refundGross: 4000,
          saleGroups: sale,
          previous: [],
          scope: [{ category: "iva0", gross: 4200 }],
        }),
      "fiscal_total_mismatch",
      409,
    );
  });

  it("refuses refunds above what is left, and malformed inputs", () => {
    expectDomain(
      () =>
        refundTaxSplit({ refundGross: 19701, saleGroups: sale, previous: [] }),
      "fiscal_refund_exceeds",
      409,
    );
    expectDomain(
      () => refundTaxSplit({ refundGross: 1, saleGroups: [], previous: [] }),
      "fiscal_refund_exceeds",
      409,
    );
    expect(
      refundTaxSplit({ refundGross: 0, saleGroups: sale, previous: [] }),
    ).toEqual([]);
    expectDomain(
      () => refundTaxSplit({ refundGross: -5, saleGroups: sale, previous: [] }),
      "invalid_amount",
      400,
    );
    expect(() =>
      refundTaxSplit({
        refundGross: 10,
        saleGroups: [{ category: "iva16", rateBps: 800, gross: 100 }],
        previous: [],
      }),
    ).toThrow(RangeError);
  });
});

describe("refundScopeGross", () => {
  it("maps refunded units to category amounts with the unit allocation used by voids", () => {
    const tacos = line({ total: 100, quantity: 3 }); // units 34, 33, 33
    const coffee = line({
      total: 9000,
      quantity: 2,
      fiscal: { taxCategory: "iva0" },
    });
    expect(
      refundScopeGross({
        lines: [tacos, coffee],
        scope: [
          { lineId: tacos.id, units: [0, 2] },
          { lineId: coffee.id, units: [1] },
        ],
        ctx: general,
      }),
    ).toEqual([
      { category: "iva16", gross: 67 },
      { category: "iva0", gross: 4500 },
    ]);
  });

  it("nets each unit's share of the line discount, allocated over the remaining units only", () => {
    const l = line({ total: 3000, quantity: 3, voidedUnits: [1] }); // remaining units 0 and 2
    const scope = (units: number[]) =>
      refundScopeGross({
        lines: [l],
        lineDiscounts: { [l.id]: 501 },
        scope: [{ lineId: l.id, units }],
        ctx: general,
      });
    expect(scope([0])).toEqual([{ category: "iva16", gross: 1000 - 251 }]);
    expect(scope([2])).toEqual([{ category: "iva16", gross: 1000 - 250 }]);
    expect(scope([0, 2])).toEqual([{ category: "iva16", gross: 2000 - 501 }]);
  });

  it("rejects unknown lines, voided, repeated or out-of-range units", () => {
    const l = line({ total: 300, quantity: 3, voidedUnits: [1] });
    for (const scope of [
      [{ lineId: randomUUID(), units: [0] }],
      [{ lineId: l.id, units: [1] }],
      [{ lineId: l.id, units: [0, 0] }],
      [
        { lineId: l.id, units: [0] },
        { lineId: l.id, units: [0] },
      ],
      [{ lineId: l.id, units: [3] }],
      [{ lineId: l.id, units: [-1] }],
      [{ lineId: l.id, units: [0.5] }],
    ])
      expectDomain(
        () => refundScopeGross({ lines: [l], scope, ctx: general }),
        "invalid_allocation",
        409,
      );
  });

  it("property: refunding every remaining unit equals the line's net, and the split nets the category IVA", () => {
    const random = rng(19);
    for (let i = 0; i < 1000; i++) {
      const o = randomOrder(random);
      const scope = o.lines.map((l) => ({
        lineId: l.id,
        units: Array.from({ length: l.quantity }, (_, u) => u).filter(
          (u) => !(l.voidedUnits ?? []).includes(u),
        ),
      }));
      const rows = refundScopeGross({ ...o, scope });
      const s = orderTaxSummary({ ...o, total: o.total + o.surplus });
      expect(rows).toEqual(
        s.groups
          .filter((g) => g.gross > 0)
          .map((g) => ({ category: g.category, gross: g.gross })),
      );
      const refundGross = rows.reduce((acc, r) => acc + r.gross, 0);
      const split = refundTaxSplit({
        refundGross,
        saleGroups: s.groups,
        previous: [],
        scope: rows,
      });
      expect(split.map((r) => r.tax)).toEqual(
        s.groups.filter((g) => g.gross > 0).map((g) => g.tax),
      );
    }
  });

  it("is a fallback only: refundScopeCategories refuses it on a discounted line", () => {
    const l = line({ total: 3000, quantity: 3 });
    // Without gross on a discounted line the even spread would be wrong: refused (a 500).
    expect(() =>
      refundScopeCategories({
        lines: [l],
        lineDiscounts: { [l.id]: 300 },
        scope: [{ lineId: l.id, units: [0] }],
        ctx: general,
      }),
    ).toThrow(new RangeError("refund_scope_gross_required"));
    // On an undiscounted line it is exactly refundScopeGross.
    expect(
      refundScopeCategories({
        lines: [l],
        scope: [{ lineId: l.id, units: [0, 2] }],
        ctx: general,
      }),
    ).toEqual(
      refundScopeGross({
        lines: [l],
        scope: [{ lineId: l.id, units: [0, 2] }],
        ctx: general,
      }),
    );
  });
});

/**
 * Applies a sequence of post-ticket refunds to one category with refundTaxSplit, returning the
 * adjustment rows it would store.
 */
function refundSequence(
  category: TaxCategory,
  sale: number,
  amounts: number[],
): { category: TaxCategory; gross: number; tax: number }[] {
  const previous: { category: TaxCategory; gross: number; tax: number }[] = [];
  for (const refundGross of amounts) {
    const rows = refundTaxSplit({
      refundGross,
      saleGroups: [{ category, rateBps: rate(category), gross: sale }],
      previous,
    });
    for (const r of rows)
      previous.push({ category: r.category, gross: r.gross, tax: r.tax });
  }
  return previous;
}
/** 1–5 random refund amounts that add up to at most `sale` (all of it when `whole`). */
function randomRefunds(
  random: ReturnType<typeof rng>,
  sale: number,
  whole = false,
): number[] {
  const n = random.int(1, 5);
  const cuts = Array.from({ length: n - 1 }, () => random.int(0, sale)).sort(
    (a, b) => a - b,
  );
  const end = whole ? sale : random.int(cuts.at(-1) ?? 0, sale);
  const points = [0, ...cuts, end];
  return points
    .slice(1)
    .map((p, i) => p - points[i])
    .filter((x) => x > 0);
}

describe("complement refund extraction", () => {
  const vat = ["iva16", "iva8"] as const;

  it("refundTaxSplit P1: after any sequence of post-ticket refunds, ticket tax − Σ adjustment tax = extractTax(G − R) exactly (property, 5,000 random sequences of 1–5 refunds at 16% and 8%)", () => {
    const random = rng(2701);
    for (let i = 0; i < 5000; i++) {
      const category = random.pick(vat);
      const sale = random.int(1, random.pick([500, 50_000, 2_000_000]));
      const rows = refundSequence(category, sale, randomRefunds(random, sale));
      const refunded = rows.reduce((a, r) => a + r.gross, 0);
      const refundedTax = rows.reduce((a, r) => a + r.tax, 0);
      expect(extractTax(sale, rate(category)).tax - refundedTax).toBe(
        extractTax(sale - refunded, rate(category)).tax,
      );
    }
  });

  it("refundTaxSplit P2: refunding the whole sale in any number of refunds nets the category IVA to exactly 0 (property)", () => {
    const random = rng(2702);
    for (let i = 0; i < 3000; i++) {
      const category = random.pick(vat);
      const sale = random.int(1, 1_000_000);
      const rows = refundSequence(
        category,
        sale,
        randomRefunds(random, sale, true),
      );
      expect(rows.reduce((a, r) => a + r.gross, 0)).toBe(sale);
      expect(rows.reduce((a, r) => a + r.tax, 0)).toBe(
        extractTax(sale, rate(category)).tax,
      );
    }
  });

  it("refundTaxSplit P3: every row has 0 ≤ tax ≤ gross and base + tax = gross (property)", () => {
    const random = rng(2703);
    for (let i = 0; i < 3000; i++) {
      const groups = TAX_CATEGORIES.filter(() => random.next() < 0.7).map(
        (category) => ({
          category,
          rateBps: rate(category),
          gross: random.int(1, 300_000),
        }),
      );
      if (!groups.length) continue;
      const sale = groups.reduce((a, g) => a + g.gross, 0);
      const previous: { category: TaxCategory; gross: number; tax: number }[] =
        [];
      for (const refundGross of randomRefunds(random, sale)) {
        for (const r of refundTaxSplit({
          refundGross,
          saleGroups: groups,
          previous,
        })) {
          expect(r.tax).toBeGreaterThanOrEqual(0);
          expect(r.tax).toBeLessThanOrEqual(r.gross);
          expect(r.base + r.tax).toBe(r.gross);
          expect(r.rateBps).toBe(rate(r.category));
          if (!r.rateBps) expect(r.tax).toBe(0);
          previous.push({ category: r.category, gross: r.gross, tax: r.tax });
        }
      }
    }
  });

  it("refundTaxSplit P4: each refund's IVA is within 1 centavo of extractTax(refund gross) (property)", () => {
    const random = rng(2704);
    for (let i = 0; i < 5000; i++) {
      const category = random.pick(vat);
      const sale = random.int(1, 2_000_000);
      for (const r of refundSequence(
        category,
        sale,
        randomRefunds(random, sale),
      ))
        expect(
          Math.abs(r.tax - extractTax(r.gross, rate(category)).tax),
        ).toBeLessThanOrEqual(1);
    }
  });

  it("refundTaxSplit P5: refunds recorded against a provisional gross that later changes deviate from extractTax(S_final − R) by at most the number of gross changes (property, 100,000 sequences)", () => {
    const random = rng(2705);
    let worst = 0;
    for (let i = 0; i < 100_000; i++) {
      const category = random.pick(vat);
      const r = rate(category);
      let sale = random.int(1, 200_000);
      let refunded = 0;
      let changes = 0;
      let refundedAny = false;
      const previous: { category: TaxCategory; gross: number; tax: number }[] =
        [];
      for (let step = random.int(1, 6); step > 0; step--) {
        if (random.next() < 0.5) {
          // A pre-ticket item refund against the provisional gross.
          if (sale - refunded <= 0) continue;
          const amount = random.int(1, sale - refunded);
          for (const row of refundTaxSplit({
            refundGross: amount,
            saleGroups: [{ category, rateBps: r, gross: sale }],
            previous,
          }))
            previous.push({ category, gross: row.gross, tax: row.tax });
          refunded += amount;
          refundedAny = true;
        } else {
          // A new round grows the gross, or a void of other units shrinks it (never below R).
          const next =
            random.next() < 0.6
              ? sale + random.int(1, 50_000)
              : random.int(refunded, sale);
          if (next !== sale && refundedAny) changes++;
          sale = next;
        }
      }
      const deviation = Math.abs(
        extractTax(sale, r).tax -
          previous.reduce((a, p) => a + p.tax, 0) -
          extractTax(sale - refunded, r).tax,
      );
      expect(deviation).toBeLessThanOrEqual(changes);
      worst = Math.max(worst, deviation);
    }
    expect(worst).toBeGreaterThan(0);
  });

  it("regression (review): partial refund then global netting — fiscal's net IVA equals extractTax(net gross), where the cumulative form was 1 centavo off", () => {
    // Sale 10000 at 16% (IVA 1379), refund 4: the cumulative row had IVA extract(4) = 1,
    // leaving 1378, while extract(9996) = 1379. The complement row has IVA 0.
    expect(extractTax(10000, 1600).tax).toBe(1379);
    expect(extractTax(4, 1600).tax).toBe(1);
    expect(extractTax(9996, 1600).tax).toBe(1379);
    const [a] = refundSequence("iva16", 10000, [4]);
    expect(a).toMatchObject({ gross: 4, tax: 0 });
    expect(
      netCategoryTax(
        [{ category: "iva16", rateBps: 1600, gross: 10000, tax: 1379 }],
        [a],
      ),
    ).toEqual([
      { category: "iva16", rateBps: 1600, gross: 9996, base: 8617, tax: 1379 },
    ]);
    // Sale 12345, refund 6789: cumulative 936 (net 767), canonical extract(5556) = 766,
    // complement 937 (net 766).
    expect(extractTax(6789, 1600).tax).toBe(936);
    expect(extractTax(12345, 1600).tax).toBe(1703);
    expect(extractTax(5556, 1600).tax).toBe(766);
    const [b] = refundSequence("iva16", 12345, [6789]);
    expect(b).toEqual({ category: "iva16", gross: 6789, tax: 937 });
    expect(1703 - b.tax).toBe(766);
  });
});

describe("refundScopeCategories", () => {
  it("MONEY-4: a line the ticket froze under the issuance default is refunded in that category after the default changed", () => {
    // Priced before 027 (no snapshot), ticketed under IVA 16%; the default is now IVA 8%.
    const l = line({ total: 3000, quantity: 3, legacy: true });
    const scope = [{ lineId: l.id, units: [0], gross: 1000 }];
    expect(
      refundScopeCategories({
        lines: [l],
        scope,
        ctx: border,
        categories: { [l.id]: "iva16" },
      }),
    ).toEqual([{ category: "iva16", gross: 1000 }]);
    // Without a ticket (provisional) the current default still applies.
    expect(refundScopeCategories({ lines: [l], scope, ctx: border })).toEqual([
      { category: "iva8", gross: 1000 },
    ]);
  });

  it("scope gross is used verbatim", () => {
    // 3 units of 1000 at IVA 16%; discounts 028 discounted units 0 and 1 by 150 each, and
    // unit 0 was paid half by cash (425) and half by card (425). One scope call per refund row.
    const l = line({ total: 3000, quantity: 3 });
    const lineDiscounts = { [l.id]: 300 };
    const cash = refundScopeCategories({
      lines: [l],
      lineDiscounts,
      scope: [{ lineId: l.id, units: [0], gross: 425 }],
      ctx: general,
    });
    const card = refundScopeCategories({
      lines: [l],
      lineDiscounts,
      scope: [{ lineId: l.id, units: [0], gross: 425 }],
      ctx: general,
    });
    expect(cash).toEqual([{ category: "iva16", gross: 425 }]);
    expect(card).toEqual([{ category: "iva16", gross: 425 }]);
    // refundScopeGross spreads the line discount evenly (100 per unit) and would claim 900.
    expect(
      refundScopeGross({
        lines: [l],
        lineDiscounts,
        scope: [{ lineId: l.id, units: [0] }],
        ctx: general,
      }),
    ).toEqual([{ category: "iva16", gross: 900 }]);
    // Unit 2 (undiscounted) refunded in full by one row, unit 1 (discounted) by another.
    expect(
      refundScopeCategories({
        lines: [l],
        lineDiscounts,
        scope: [
          { lineId: l.id, units: [2], gross: 1000 },
          { lineId: l.id, units: [1], gross: 850 },
        ],
        ctx: general,
      }),
    ).toEqual([{ category: "iva16", gross: 1850 }]);
  });

  it("groups gross by the line's snapshot category and legacy lines by the restaurant default", () => {
    const taco = line({ total: 2000, quantity: 2 });
    const beans = line({
      total: 900,
      quantity: 3,
      fiscal: { taxCategory: "iva0" },
    });
    const legacy = line({ total: 500, legacy: true });
    const scope = [
      { lineId: taco.id, units: [1], gross: 1000 },
      { lineId: beans.id, units: [0, 1], gross: 600 },
      { lineId: legacy.id, units: [0], gross: 500 },
    ];
    expect(
      refundScopeCategories({
        lines: [taco, beans, legacy],
        scope,
        ctx: general,
      }),
    ).toEqual([
      { category: "iva16", gross: 1500 },
      { category: "iva0", gross: 600 },
    ]);
    // In a border restaurant whose default is IVA 8%, the legacy line follows the default;
    // snapshot lines keep the category they were sold with.
    expect(
      refundScopeCategories({
        lines: [taco, beans, legacy],
        scope,
        ctx: border,
      }),
    ).toEqual([
      { category: "iva16", gross: 1000 },
      { category: "iva8", gross: 500 },
      { category: "iva0", gross: 600 },
    ]);
  });

  it("rejects unknown lines, voided, repeated or out-of-range units, negative gross, and gross above the units' gross", () => {
    const l = line({ total: 100, quantity: 3, voidedUnits: [1] }); // units 34, 33, 33
    const call =
      (scope: { lineId: string; units: number[]; gross?: number }[]) => () =>
        refundScopeCategories({ lines: [l], scope, ctx: general });
    for (const scope of [
      [{ lineId: randomUUID(), units: [0], gross: 1 }],
      [{ lineId: l.id, units: [1], gross: 1 }],
      [{ lineId: l.id, units: [0, 0], gross: 1 }],
      [
        { lineId: l.id, units: [0], gross: 1 },
        { lineId: l.id, units: [0], gross: 1 },
      ],
      [{ lineId: l.id, units: [3], gross: 1 }],
      [{ lineId: l.id, units: [-1], gross: 1 }],
      [{ lineId: l.id, units: [0.5], gross: 1 }],
    ])
      expectDomain(call(scope), "invalid_allocation", 409);
    expectDomain(
      call([{ lineId: l.id, units: [0], gross: -1 }]),
      "fiscal_total_mismatch",
      409,
    );
    expectDomain(
      call([{ lineId: l.id, units: [0], gross: 1.5 }]),
      "fiscal_total_mismatch",
      409,
    );
    expectDomain(
      call([{ lineId: l.id, units: [0], gross: 35 }]),
      "fiscal_refund_exceeds",
      409,
    );
    expectDomain(
      call([{ lineId: l.id, units: [0, 2], gross: 68 }]),
      "fiscal_refund_exceeds",
      409,
    );
    expect(call([{ lineId: l.id, units: [0, 2], gross: 67 }])()).toEqual([
      { category: "iva16", gross: 67 },
    ]);
    // A refund row can return less than its units' gross (two tenders, discounts).
    expect(call([{ lineId: l.id, units: [0], gross: 0 }])()).toEqual([]);
  });

  it("an entry without gross on a discounted line throws refund_scope_gross_required; on an undiscounted line it uses the unit gross", () => {
    const discounted = line({ total: 900, quantity: 3 });
    const plain = line({ total: 100, quantity: 3 });
    expect(() =>
      refundScopeCategories({
        lines: [discounted, plain],
        lineDiscounts: { [discounted.id]: 1 },
        scope: [{ lineId: discounted.id, units: [0] }],
        ctx: general,
      }),
    ).toThrow(RangeError);
    expect(
      refundScopeCategories({
        lines: [discounted, plain],
        lineDiscounts: { [discounted.id]: 1 },
        scope: [{ lineId: plain.id, units: [0, 1] }],
        ctx: general,
      }),
    ).toEqual([{ category: "iva16", gross: 67 }]);
  });
});

describe("netCategoryTax", () => {
  it("sale groups minus post-ticket adjustments give extractTax(net gross) per category; negative nets throw fiscal_total_mismatch", () => {
    const random = rng(2713);
    for (let i = 0; i < 2000; i++) {
      const sale = TAX_CATEGORIES.filter(() => random.next() < 0.7).map(
        (category) => {
          const gross = random.int(1, 400_000);
          return {
            category,
            rateBps: rate(category),
            gross,
            tax: extractTax(gross, rate(category)).tax,
          };
        },
      );
      if (!sale.length) continue;
      const total = sale.reduce((a, g) => a + g.gross, 0);
      const previous: { category: TaxCategory; gross: number; tax: number }[] =
        [];
      for (const refundGross of randomRefunds(random, total))
        for (const r of refundTaxSplit({
          refundGross,
          saleGroups: sale,
          previous,
        }))
          previous.push({ category: r.category, gross: r.gross, tax: r.tax });
      const net = netCategoryTax(sale, previous);
      for (const g of sale) {
        const left =
          g.gross -
          previous
            .filter((p) => p.category === g.category)
            .reduce((a, p) => a + p.gross, 0);
        const row = net.find((n) => n.category === g.category);
        if (left === 0) expect(row).toBeUndefined();
        else
          expect(row).toEqual({
            category: g.category,
            rateBps: g.rateBps,
            gross: left,
            ...extractTax(left, g.rateBps),
          });
      }
      expect(net.map((n) => n.category)).toEqual(
        TAX_CATEGORIES.filter((c) => net.some((n) => n.category === c)),
      );
    }
    const sale = [
      { category: "iva16" as const, rateBps: 1600, gross: 1000, tax: 138 },
    ];
    expectDomain(
      () =>
        netCategoryTax(sale, [{ category: "iva16", gross: 1001, tax: 138 }]),
      "fiscal_total_mismatch",
      409,
    );
    expectDomain(
      () => netCategoryTax(sale, [{ category: "iva16", gross: 100, tax: 139 }]),
      "fiscal_total_mismatch",
      409,
    );
    // A refund of a category the sale never had, and IVA left on a zero net.
    expectDomain(
      () => netCategoryTax(sale, [{ category: "iva0", gross: 1, tax: 0 }]),
      "fiscal_total_mismatch",
      409,
    );
    expectDomain(
      () =>
        netCategoryTax(sale, [{ category: "iva16", gross: 1000, tax: 137 }]),
      "fiscal_total_mismatch",
      409,
    );
    expectDomain(
      () =>
        netCategoryTax(
          [{ category: "iva0", rateBps: 0, gross: 100, tax: 1 }],
          [],
        ),
      "fiscal_total_mismatch",
      409,
    );
    expect(() =>
      netCategoryTax(
        [{ category: "iva16", rateBps: 800, gross: 1, tax: 0 }],
        [],
      ),
    ).toThrow(RangeError);
    expect(
      netCategoryTax(sale, [{ category: "iva16", gross: 1000, tax: 138 }]),
    ).toEqual([]);
  });
});

describe("folios", () => {
  it.each([
    ["A", 123, "A-000123"],
    ["", 123, "000123"],
    ["", 1, "000001"],
    ["SUC2", 999_999, "SUC2-999999"],
    ["", 1_234_567, "1234567"],
    ["B", 10_000_000, "B-10000000"],
  ])("formatFolio(%j, %i) = %s", (series, n, folio) => {
    expect(formatFolio(series, n)).toBe(folio);
    expect(parseFolio(folio)).toEqual({ series, number: n });
  });

  it("formatFolio refuses numbers below 1, fractions and invalid series", () => {
    for (const n of [0, -1, 1.5, Number.NaN, 2 ** 53])
      expect(() => formatFolio("A", n), `${n}`).toThrow(RangeError);
    for (const series of ["a", "A-B", "ABCDEFGHIJK", "Ñ", " A"])
      expect(() => formatFolio(series, 1), series).toThrow(RangeError);
  });

  it.each([
    ["A-000123", { series: "A", number: 123 }],
    ["a-123", { series: "A", number: 123 }],
    ["123", { series: "", number: 123 }],
    ["  000123 ", { series: "", number: 123 }],
    ["2026-000042", { series: "2026", number: 42 }],
    ["ABCDEFGHIJ-1", { series: "ABCDEFGHIJ", number: 1 }],
  ])("parseFolio(%j)", (text, parsed) => {
    expect(parseFolio(text)).toEqual(parsed);
  });

  it("parseFolio returns null for anything that is not a folio", () => {
    for (const text of [
      "",
      "A-",
      "-1",
      "A-0",
      "000000",
      "A000123",
      "A--1",
      "A-1-2",
      "ABCDEFGHIJK-1",
      "A-12345678901234567",
      "A-99999999999999999",
      "9999999999999999", // 16 digits, above Number.MAX_SAFE_INTEGER
      "#42",
      "A-1.5",
    ])
      expect(parseFolio(text), text).toBeNull();
  });

  it("property: parseFolio(formatFolio(series, n)) round-trips", () => {
    const random = rng(23);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");
    for (let i = 0; i < 5000; i++) {
      const series = Array.from({ length: random.int(0, 10) }, () =>
        random.pick(alphabet),
      ).join("");
      const n = random.pick([
        random.int(1, 999_999),
        random.int(1, Number.MAX_SAFE_INTEGER),
      ]);
      expect(parseFolio(formatFolio(series, n))).toEqual({ series, number: n });
    }
  });
});

describe("self-invoice codes", () => {
  it("newSelfInvoiceCode yields 12 Crockford characters for fixed bytes", () => {
    expect(
      selfInvoiceCodeFromBytes(
        Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      ),
    ).toBe("0123456789AB");
    expect(
      selfInvoiceCodeFromBytes(
        Uint8Array.from([
          31, 63, 95, 127, 159, 191, 223, 255, 32, 64, 18, 21, 99, 99,
        ]),
      ),
    ).toBe("ZZZZZZZZ00JN"); // byte & 31; bytes after the 12th are ignored
    expect(() => selfInvoiceCodeFromBytes(new Uint8Array(11))).toThrow(
      RangeError,
    );
  });

  it("uses the 32-character alphabet without I, L, O or U, matching the database check", () => {
    expect(SELF_INVOICE_ALPHABET).toHaveLength(32);
    expect(new Set(SELF_INVOICE_ALPHABET).size).toBe(32);
    for (const c of "ILOU") expect(SELF_INVOICE_ALPHABET).not.toContain(c);
    for (let b = 0; b < 256; b++) {
      const code = selfInvoiceCodeFromBytes(new Uint8Array(12).fill(b));
      expect(SELF_INVOICE_CODE_PATTERN.test(code), code).toBe(true);
    }
  });

  it("prints grouped as XXXX-XXXX-XXXX and normalizes what a customer types back", () => {
    expect(groupSelfInvoiceCode("0123456789AB")).toBe("0123-4567-89AB");
    expect(normalizeSelfInvoiceCode("0123-4567-89ab")).toBe("0123456789AB");
    expect(normalizeSelfInvoiceCode(" o123 4567 89AB ")).toBe("0123456789AB");
    expect(normalizeSelfInvoiceCode("IL23-4567-89AB")).toBe("1123456789AB");
    for (const bad of [
      "",
      "0123-4567-89A",
      "0123-4567-89ABC",
      "0123-4567-89AU",
      "0123_4567_89AB",
    ])
      expect(normalizeSelfInvoiceCode(bad), bad).toBeNull();
  });
});

describe("fiscal profile", () => {
  const base = (over: Partial<FiscalProfileInput> = {}): FiscalProfileInput =>
    fiscalProfileInput.parse({
      operationId: randomUUID(),
      expectedVersion: 0,
      identity: {
        rfc: "EKU9003173C9",
        legalName: "Escuela Kemper Urgate",
        regime: "601",
        postalCode: "06700",
      },
      taxRegion: "general",
      defaultTaxCategory: "iva16",
      ...over,
    });
  const identity = (over: Record<string, unknown>) =>
    ({ ...base().identity!, ...over }) as FiscalProfileInput["identity"];
  const codes = (p: FiscalProfileInput) =>
    fiscalProfileIssues(p).map(
      (i) => `${i.field}:${i.code}${i.warning ? ":warning" : ""}`,
    );

  it("parses strictly, trims, uppercases and fills defaults", () => {
    const p = fiscalProfileInput.parse({
      operationId: randomUUID(),
      expectedVersion: 3,
      identity: {
        rfc: " eku9003173c9 ",
        legalName: "  Alimentos El Güero ",
        regime: " 601 ",
        postalCode: " 06700 ",
        address: {
          street: " Av. Insurgentes Sur 123 ",
          state: "Ciudad de México",
        },
      },
      ticketSeries: " a1 ",
      taxRegion: "border_north",
      defaultTaxCategory: "iva8",
      borderConfirmed: true,
    });
    expect(p.identity).toEqual({
      rfc: "EKU9003173C9",
      legalName: "Alimentos El Güero",
      regime: "601",
      postalCode: "06700",
      address: {
        street: "Av. Insurgentes Sur 123",
        neighborhood: "",
        municipality: "",
        state: "Ciudad de México",
      },
    });
    expect(p.ticketSeries).toBe("A1");
    expect(base().identity!.address).toEqual({
      street: "",
      neighborhood: "",
      municipality: "",
      state: "",
    });
    expect(base()).toMatchObject({ ticketSeries: "", borderConfirmed: false });
    expect(
      fiscalProfileInput.safeParse({ ...base(), identity: null }).success,
    ).toBe(true);
    for (const bad of [
      { ...base(), extra: 1 },
      { ...base(), operationId: "not-a-uuid" },
      { ...base(), expectedVersion: -1 },
      { ...base(), taxRegion: "border" },
      { ...base(), defaultTaxCategory: "ieps" },
      { ...base(), ticketSeries: "ABCDEFGHIJK" },
      { ...base(), identity: { ...base().identity, rfc: "EKU9003173C9XX" } },
      { ...base(), identity: { ...base().identity, postalCode: "067000" } },
      { ...base(), identity: { ...base().identity, nickname: "x" } },
    ])
      expect(
        fiscalProfileInput.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
    expect(
      fiscalAddressInput.safeParse({ street: "x".repeat(121) }).success,
    ).toBe(false);
    expect(fiscalAddressInput.safeParse({ colonia: "Roma" }).success).toBe(
      false,
    );
  });

  it.each([
    ["a complete persona moral profile", {}, []],
    [
      "a persona física under 612",
      { identity: identity({ rfc: "XIQB891116QE4", regime: "612" }) },
      [],
    ],
    [
      "RESICO for a persona moral",
      { identity: identity({ regime: "626" }) },
      [],
    ],
    [
      "RESICO for a persona física",
      { identity: identity({ rfc: "XIQB891116QE4", regime: "626" }) },
      [],
    ],
    ["no identity (tax settings only)", { identity: null }, []],
    [
      "an all-blank identity, which saves as incomplete",
      {
        identity: identity({
          rfc: "",
          legalName: "",
          regime: "",
          postalCode: "",
        }),
      },
      [],
    ],
    [
      "only an address",
      {
        identity: identity({
          rfc: "",
          legalName: "",
          regime: "",
          postalCode: "",
          address: {
            street: "Calle 1",
            neighborhood: "",
            municipality: "",
            state: "",
          },
        }),
      },
      [
        "rfc:fiscal_identity_incomplete",
        "legalName:fiscal_identity_incomplete",
        "regime:fiscal_identity_incomplete",
        "postalCode:fiscal_identity_incomplete",
      ],
    ],
    [
      "an RFC without the rest",
      { identity: identity({ legalName: "", regime: "", postalCode: "" }) },
      [
        "legalName:fiscal_identity_incomplete",
        "regime:fiscal_identity_incomplete",
        "postalCode:fiscal_identity_incomplete",
      ],
    ],
    [
      "a generic RFC",
      { identity: identity({ rfc: "XAXX010101000" }) },
      ["rfc:fiscal_generic_rfc"],
    ],
    [
      "a foreign generic RFC",
      { identity: identity({ rfc: "XEXX010101000" }) },
      ["rfc:fiscal_generic_rfc"],
    ],
    [
      "a malformed RFC",
      { identity: identity({ rfc: "EKU9013173C9" }) },
      ["rfc:fiscal_invalid_rfc"],
    ],
    [
      "a check digit mismatch (warning only)",
      { identity: identity({ rfc: "EKU9003173C8" }) },
      ["rfc:fiscalRfcCheckDigit:warning"],
    ],
    [
      "a legal name over 254 characters",
      { identity: identity({ legalName: "A".repeat(255) }) },
      ["legalName:fiscal_invalid_legal_name"],
    ],
    [
      "a non-issuer regime",
      { identity: identity({ regime: "605" }) },
      ["regime:fiscal_invalid_regime"],
    ],
    [
      "an unknown regime",
      { identity: identity({ regime: "999" }) },
      ["regime:fiscal_invalid_regime"],
    ],
    [
      "a persona física regime on a company RFC",
      { identity: identity({ regime: "612" }) },
      ["regime:fiscal_regime_mismatch"],
    ],
    [
      "a company regime on a persona física RFC",
      { identity: identity({ rfc: "XIQB891116QE4", regime: "601" }) },
      ["regime:fiscal_regime_mismatch"],
    ],
    [
      "a four-digit postal code",
      { identity: identity({ postalCode: "6700" }) },
      ["postalCode:fiscal_invalid_postal_code"],
    ],
    [
      "a postal code with letters",
      { identity: identity({ postalCode: "O6700" }) },
      ["postalCode:fiscal_invalid_postal_code"],
    ],
    [
      "an accented series",
      { ticketSeries: "SUCÑ" },
      ["ticketSeries:fiscal_invalid_series"],
    ],
    [
      "IVA 8% as the default outside a border region",
      { defaultTaxCategory: "iva8" },
      ["defaultTaxCategory:fiscal_border_rate_not_allowed"],
    ],
    [
      "a border region without the attestation (Tapachula, Chiapas)",
      {
        taxRegion: "border_south",
        identity: identity({ postalCode: "30700" }),
      },
      ["borderConfirmed:fiscal_border_confirmation_required"],
    ],
    [
      "a confirmed border region with IVA 8% as the default (Tijuana)",
      {
        taxRegion: "border_north",
        identity: identity({ postalCode: "22000" }),
        defaultTaxCategory: "iva8",
        borderConfirmed: true,
      },
      [],
    ],
    [
      "SAT-1: a confirmed border region without any issuer identity",
      {
        taxRegion: "border_north",
        identity: null,
        defaultTaxCategory: "iva8",
        borderConfirmed: true,
      },
      [
        "rfc:fiscal_border_identity_required",
        "postalCode:fiscal_border_identity_required",
      ],
    ],
    [
      "SAT-1: the northern border region with a CDMX postal code",
      {
        taxRegion: "border_north",
        defaultTaxCategory: "iva8",
        borderConfirmed: true,
      },
      ["postalCode:fiscal_border_postal_code"],
    ],
    [
      "SAT-1: the southern border region with a Tijuana postal code (a northern state)",
      {
        taxRegion: "border_south",
        identity: identity({ postalCode: "22000" }),
        borderConfirmed: true,
      },
      ["postalCode:fiscal_border_postal_code"],
    ],
    [
      "SAT-1: an incomplete identity in a border region reports the identity, not the region",
      {
        taxRegion: "border_north",
        identity: identity({ rfc: "", postalCode: "22000" }),
        borderConfirmed: true,
      },
      ["rfc:fiscal_identity_incomplete"],
    ],
    [
      "SAT-2: more than one branch without the branch address",
      { multipleBranches: true },
      [
        "street:fiscal_address_required",
        "municipality:fiscal_address_required",
        "state:fiscal_address_required",
      ],
    ],
    [
      "SAT-2: more than one branch with only the street",
      {
        multipleBranches: true,
        identity: identity({
          address: {
            street: "Av. Revolución 1234",
            neighborhood: "",
            municipality: " ",
            state: "",
          },
        }),
      },
      ["municipality:fiscal_address_required", "state:fiscal_address_required"],
    ],
    [
      "SAT-2: more than one branch with street, municipality and state",
      {
        multipleBranches: true,
        identity: identity({
          address: {
            street: "Av. Revolución 1234",
            neighborhood: "",
            municipality: "Tijuana",
            state: "Baja California",
          },
        }),
      },
      [],
    ],
    [
      "SAT-2: more than one branch and no identity at all",
      { multipleBranches: true, identity: null },
      [
        "street:fiscal_address_required",
        "municipality:fiscal_address_required",
        "state:fiscal_address_required",
      ],
    ],
  ] as [string, Partial<FiscalProfileInput>, string[]][])(
    "fiscalProfileIssues: %s",
    (_name, over, expected) => {
      expect(codes(base(over))).toEqual(expected);
    },
  );

  it("identity all-or-nothing, regime by RFC kind, CP, series, iva8 requires border, border requires confirmation — in field order", () => {
    const p = base({
      identity: identity({
        rfc: "XAXX010101000",
        legalName: "",
        regime: "605",
        postalCode: "1",
      }),
      ticketSeries: "Ñ",
      taxRegion: "general",
      defaultTaxCategory: "iva8",
    });
    expect(codes(p)).toEqual([
      "rfc:fiscal_generic_rfc",
      "legalName:fiscal_identity_incomplete",
      "regime:fiscal_invalid_regime",
      "postalCode:fiscal_invalid_postal_code",
      "ticketSeries:fiscal_invalid_series",
      "defaultTaxCategory:fiscal_border_rate_not_allowed",
    ]);
    // The server throws the first non-warning issue; a check-digit warning alone never blocks.
    const warningOnly = fiscalProfileIssues(
      base({ identity: identity({ rfc: "EKU9003173C8" }) }),
    );
    expect(warningOnly.find((i) => !i.warning)).toBeUndefined();
    expect(
      fiscalProfileIssues(
        base({
          taxRegion: "border_north",
          identity: identity({ rfc: "EKU9003173C8", postalCode: "22000" }),
        }),
      ).find((i) => !i.warning),
    ).toEqual({
      field: "borderConfirmed",
      code: "fiscal_border_confirmation_required",
    });
  });

  it("SAT-1: border postal codes by state prefix (SAT Catálogo de códigos postales)", () => {
    const { BORDER_POSTAL_PREFIXES, borderPostalCodeAllowed } = fiscalModule;
    for (const cp of [
      "22000", // Tijuana, Baja California
      "21100", // Mexicali, Baja California
      "83000", // Hermosillo, Sonora
      "84000", // Nogales, Sonora
      "32000", // Ciudad Juárez, Chihuahua
      "26000", // Piedras Negras, Coahuila
      "64000", // Monterrey, Nuevo León
      "88500", // Reynosa, Tamaulipas
    ])
      expect(borderPostalCodeAllowed("border_north", cp), cp).toBe(true);
    for (const cp of [
      "24000", // Campeche
      "30700", // Tapachula, Chiapas
      "77000", // Chetumal, Quintana Roo
      "86900", // Tenosique, Tabasco
    ])
      expect(borderPostalCodeAllowed("border_south", cp), cp).toBe(true);
    for (const [region, cp] of [
      ["border_north", "06700"], // CDMX
      ["border_north", "23000"], // La Paz, Baja California Sur
      ["border_north", "34000"], // Durango
      ["border_north", "77000"], // a southern state
      ["border_south", "22000"], // a northern state
      ["border_south", "97000"], // Mérida, Yucatán
      ["border_north", "2200"],
      ["border_north", "22OOO"],
      ["border_south", ""],
    ] as const)
      expect(borderPostalCodeAllowed(region, cp), `${region} ${cp}`).toBe(
        false,
      );
    // Ten states, no prefix in both regions.
    const north = new Set(BORDER_POSTAL_PREFIXES.border_north);
    expect(north.size).toBe(18);
    expect(
      BORDER_POSTAL_PREFIXES.border_south.filter((p) => north.has(p)),
    ).toEqual([]);
  });

  it("validates raw client form state the same way as the parsed input", () => {
    const raw = {
      ...base(),
      identity: identity({
        rfc: " eku9003173c9 ",
        legalName: "  x  ",
        postalCode: " 06700 ",
      }),
      ticketSeries: " a1 ",
    } as FiscalProfileInput;
    expect(fiscalProfileIssues(raw)).toEqual([]);
    expect(effectiveFiscalIdentity(null)).toBeNull();
    expect(
      effectiveFiscalIdentity(
        identity({ rfc: " ", legalName: "", regime: "", postalCode: "" }),
      ),
    ).toBeNull();
  });
});

describe("allocate() assumptions this module relies on", () => {
  it("domain allocate never gives a part above its weight when the amount fits", () => {
    const random = rng(24);
    for (let i = 0; i < 5000; i++) {
      const weights = Array.from({ length: random.int(1, 8) }, () =>
        random.pick([0, random.int(1, 50), random.int(1, 100_000)]),
      );
      const W = weights.reduce((a, b) => a + b, 0);
      if (!W) continue;
      const parts = allocate(random.int(0, W), weights);
      parts.forEach((p, k) => expect(p).toBeLessThanOrEqual(weights[k]));
    }
  });
});

describe("quote tax snapshot", () => {
  const product = (
    price: number,
    fiscal?: unknown,
    extra: Partial<Product> = {},
  ): Product => ({
    id: randomUUID(),
    name: { es: "Producto", en: "Product" },
    category: { es: "Pruebas", en: "Tests" },
    price,
    available: true,
    station: "kitchen",
    groups: [],
    cost: null,
    version: 1,
    ...(fiscal === undefined ? {} : { fiscal }),
    ...extra,
  });
  const lineOf = (p: Product, quantity = 1, options: string[] = []) => ({
    id: randomUUID(),
    productId: p.id,
    quantity,
    options,
    note: "",
  });

  it('quote with a border fiscal context snapshots iva8 for an iva8 product and the restaurant default for "default" products', () => {
    const burrito = product(2000, { taxCategory: "iva8" });
    const soda = product(1000);
    const beans = product(5000, {
      taxCategory: "iva0",
      satProductKey: "50201708",
      satUnitKey: "KGM",
    });
    const lines = quote(
      [lineOf(burrito, 2), lineOf(soda), lineOf(beans)],
      [burrito, soda, beans],
      false,
      border,
    );
    expect(lines.map((l) => [l.tax!.category, l.tax!.basis])).toEqual([
      ["iva8", "product"],
      ["iva8", "default"],
      ["iva0", "product"],
    ]);
    expect(lines[0].tax).toEqual({
      v: 1,
      category: "iva8",
      rateBps: 800,
      basis: "product",
      satProductKey: "90101501",
      satUnitKey: "E48",
      ...extractTax(4000, 800),
    });
    expect([lines[2].tax!.satProductKey, lines[2].tax!.satUnitKey]).toEqual([
      "50201708",
      "KGM",
    ]);
    // The default context (client previews): general region, IVA 16%; an iva8 product falls back.
    expect(
      quote([lineOf(burrito)], [burrito]).map((l) => [
        l.tax!.category,
        l.tax!.basis,
      ]),
    ).toEqual([["iva16", "fallback"]]);
  });

  it("quote: every line's snapshot base + tax equals its total and the snapshot is computed from the same total (property over random catalogs)", () => {
    const random = rng(2714);
    for (let i = 0; i < 500; i++) {
      const region = random.pick(taxModule.TAX_REGIONS);
      const ctx: FiscalContext = {
        region,
        defaultCategory: random.pick(taxModule.allowedCategories(region)),
      };
      const option = {
        id: randomUUID(),
        name: { es: "Extra", en: "Extra" },
        price: random.int(0, 3000),
        available: true,
      };
      const catalog = Array.from({ length: random.int(1, 6) }, () =>
        product(
          random.int(0, 60_000),
          random.next() < 0.3
            ? undefined
            : {
                taxCategory: random.pick([
                  "default",
                  ...TAX_CATEGORIES,
                ] as const),
              },
          random.next() < 0.3
            ? {
                groups: [
                  {
                    id: randomUUID(),
                    name: { es: "Extras", en: "Extras" },
                    min: 0,
                    max: 1,
                    options: [option],
                  },
                ],
              }
            : {},
        ),
      );
      const lines = quote(
        catalog.map((p) =>
          lineOf(
            p,
            random.int(1, 9),
            p.groups.length && random.next() < 0.5 ? [option.id] : [],
          ),
        ),
        catalog,
        false,
        ctx,
      );
      for (const l of lines) {
        const t = l.tax!;
        expect(t.base + t.tax).toBe(l.total);
        expect({ base: t.base, tax: t.tax }).toEqual(
          extractTax(l.total, t.rateBps),
        );
        expect(t.rateBps).toBe(rate(t.category));
        expect(taxModule.allowedCategories(region)).toContain(t.category);
      }
    }
  });

  it("menu-schema: productInput accepts an optional strict fiscal object, rejects unknown fiscal keys and bad SAT keys; legacyProductInput is unchanged", () => {
    const base = {
      operationId: randomUUID(),
      id: randomUUID(),
      expectedVersion: 0,
      name: { es: "Café", en: "" },
      categoryId: randomUUID(),
      price: 1000,
      station: "kitchen",
    };
    expect(productInput.safeParse(base).success).toBe(true);
    expect(productInput.parse(base).fiscal).toBeUndefined();
    expect(
      productInput.parse({ ...base, fiscal: { taxCategory: "iva0" } }).fiscal,
    ).toEqual({ taxCategory: "iva0", satProductKey: null, satUnitKey: null });
    for (const fiscal of [
      { taxCategory: "iva0", extra: 1 },
      { taxCategory: "iva21" },
      { satProductKey: "1234567" },
      { satUnitKey: "e48" },
      { satUnitKey: "ABCD" },
    ])
      expect(productInput.safeParse({ ...base, fiscal }).success).toBe(false);
    const legacy = {
      operationId: randomUUID(),
      id: randomUUID(),
      name: { es: "Café", en: "Coffee" },
      category: { es: "Bebidas", en: "Drinks" },
      price: 1000,
      available: true,
      station: "bar",
      expectedVersion: 0,
      cost: null,
      recipe: [],
    };
    expect(legacyProductInput.safeParse(legacy).success).toBe(true);
    expect(
      legacyProductInput.safeParse({
        ...legacy,
        fiscal: { taxCategory: "iva0" },
      }).success,
    ).toBe(false);
  });
});
