import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  allocate,
  discount,
  type Order,
  type PricedLine,
} from "../shared/domain";
import {
  allocatePayment,
  lineRemaining,
  payableUnits,
  type Allocation,
} from "../shared/settlement";
import {
  amountRefundAllowed,
  balanceDue,
  canCloseDrawer,
  canSeeExpected,
  cashCloseInput,
  composeOrderAdjustments,
  DEFAULT_MONEY_CONTROLS,
  discountClosesCheck,
  discountExpectation,
  discountInput,
  discountInputIssue,
  discountIsFinal,
  discountIssuesTicket,
  discountLimitCheck,
  discountPlanMatches,
  itemRefundsBlocked,
  REFUND_REASONS,
  DISCOUNT_REASONS,
  RESERVED_DISCOUNT_REASON,
  SELECTABLE_DISCOUNT_REASONS,
  unapprovedDiscounts,
  formatPercentBps,
  itemRefundExpectation,
  itemRefundPlanMatches,
  moneyControlsInput,
  percentToBps,
  planDiscount,
  planItemRefund,
  refundableQuantities,
  refundInput,
  refundTaxScopes,
  voidCandidates,
  type AdjustmentRow,
  type MoneyControls,
  type OrderDiscount,
  type RefundedUnit,
  type TenderAllocation,
  type UnitDiscount,
} from "../shared/discounts";
import {
  DEFAULT_FISCAL_CONTEXT,
  extractTax,
  orderTaxSummary,
} from "../shared/fiscal";
import { line as fiscalLine, rng } from "./fixtures/fiscal";
import {
  countText,
  discountRemovable,
  reasonLabel,
  discountRowLabel,
  removableAfterReload,
} from "../src/features/discounts/format";
import { strings, type Key } from "../src/i18n";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "no error";
};

function line(
  total: number,
  quantity: number,
  extra: Partial<PricedLine> = {},
) {
  return {
    id: randomUUID(),
    productId: randomUUID(),
    quantity,
    options: [],
    note: "",
    name: { es: "Taco al pastor", en: "Al pastor taco" },
    optionNames: [],
    unitPrice: Math.floor(total / quantity),
    total,
    cost: null,
    station: "kitchen",
    recipe: [],
    productVersion: 1,
    round: 1,
    voidedUnits: [],
    ...extra,
  } as PricedLine;
}

type Tender = {
  id: string;
  method: "cash" | "external";
  amount: number;
  refunded: number;
  external_reference: string | null;
};
/** An order view as getOrder builds it, from raw allocations and unit discounts. */
function view(input: {
  lines: PricedLine[];
  allocations?: TenderAllocation[];
  unitDiscounts?: UnitDiscount[];
  tenders?: Tender[];
  refundedUnits?: RefundedUnit[];
  discounts?: Order["discounts"];
  total?: number;
}): Order {
  const allocations = input.allocations ?? [];
  const units = payableUnits(
    input.lines,
    allocations.map(({ tenderId: _t, ...a }) => a),
    input.unitDiscounts ?? [],
  ).filter(
    (u) =>
      !input.lines
        .find((l) => l.id === u.lineId)
        ?.voidedUnits?.includes(u.unit),
  );
  const tenders = input.tenders ?? [];
  const gross = input.lines.reduce((a, l) => a + lineRemaining(l).total, 0);
  const disc = (input.unitDiscounts ?? []).reduce((a, d) => a + d.amount, 0);
  return {
    id: randomUUID(),
    number: 1,
    version: 1,
    mode: "takeaway",
    tableId: null,
    name: "",
    note: "",
    lines: input.lines,
    total: input.total ?? gross - disc,
    paid: tenders.reduce((a, t) => a + t.amount, 0),
    refunded: tenders.reduce((a, t) => a + t.refunded, 0),
    state: "active",
    createdAt: new Date().toISOString(),
    rounds: [],
    tenders,
    channel: "pos",
    paymentUnits: units,
    tenderAllocations: allocations,
    refundedUnits: input.refundedUnits ?? [],
    discounts: input.discounts ?? [],
  };
}
/** Applies a plan's allocations as active unit discounts. */
const asUnitDiscounts = (
  plan: ReturnType<typeof planDiscount>,
  scope: "order" | "line",
  discountId = randomUUID(),
): UnitDiscount[] => plan.allocations.map((a) => ({ ...a, scope, discountId }));

const tender = (
  method: "cash" | "external",
  amount: number,
  ref?: string,
): Tender => ({
  id: randomUUID(),
  method,
  amount,
  refunded: 0,
  external_reference: method === "external" ? (ref ?? "482913") : null,
});
const controls = (cashier: {
  maxPercentBps: number;
  maxAmount: number;
}): MoneyControls => ({
  ...DEFAULT_MONEY_CONTROLS,
  limits: { cashier, server: { maxPercentBps: 0, maxAmount: 0 } },
});

describe("discount planning (FIT-8)", () => {
  it("1. planDiscount: 10% order discount allocates by unit due, sums exactly and never exceeds a unit due", () => {
    const taco = line(9000, 2);
    const cafe = line(12000, 1);
    const o = view({ lines: [taco, cafe] });
    const plan = planDiscount(o, {
      scope: "order",
      kind: "percent",
      percentBps: 1000,
    });
    expect(plan).toEqual({
      base: 21000,
      amount: 2100,
      units: 3,
      allocations: [
        { lineId: taco.id, unit: 0, amount: 450 },
        { lineId: taco.id, unit: 1, amount: 450 },
        { lineId: cafe.id, unit: 0, amount: 1200 },
      ],
    });
    for (const a of plan.allocations) {
      const u = o.paymentUnits!.find(
        (x) => x.lineId === a.lineId && x.unit === a.unit,
      )!;
      expect(a.amount).toBeLessThanOrEqual(u.due);
    }
  });

  it("2. planDiscount: percentage rounding equals discount() and the SQL CHECK formula for 10,000 random bases", () => {
    const r = rng(28);
    for (let i = 0; i < 10_000; i++) {
      const base = r.int(1, 2_000_000);
      const bps = r.int(1, 10000);
      const o = view({ lines: [line(base, 1)] });
      const plan = planDiscount(o, {
        scope: "order",
        kind: "percent",
        percentBps: bps,
      });
      const sqlCheck = Math.floor((base * bps + 5000) / 10000);
      if (sqlCheck === 0) continue;
      expect(plan.amount).toBe(discount(base, bps));
      expect(plan.amount).toBe(sqlCheck);
    }
  });

  it("3. allocate lemma: parts ≤ weights whenever amount ≤ Σ weights (property, 5,000 cases)", () => {
    const r = rng(3);
    for (let i = 0; i < 5000; i++) {
      const weights = Array.from({ length: r.int(1, 12) }, () =>
        r.int(1, 50000),
      );
      const total = weights.reduce((a, b) => a + b, 0);
      const amount = r.int(0, total);
      const parts = allocate(amount, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
      parts.forEach((p, k) => expect(p).toBeLessThanOrEqual(weights[k]));
    }
  });

  it("4. planDiscount: fixed amount above the due throws discount_exceeds_due; zero result throws discount_too_small", () => {
    const o = view({ lines: [line(4500, 1)] });
    expect(
      code(() =>
        planDiscount(o, { scope: "order", kind: "amount", amount: 4501 }),
      ),
    ).toBe("discount_exceeds_due");
    expect(
      planDiscount(o, { scope: "order", kind: "amount", amount: 4500 }).amount,
    ).toBe(4500);
    const small = view({ lines: [line(40, 1)] });
    expect(
      code(() =>
        planDiscount(small, {
          scope: "order",
          kind: "percent",
          percentBps: 100,
        }),
      ),
    ).toBe("discount_too_small");
  });

  it("5. planDiscount: comp equals the targeted due and leaves those units with due 0", () => {
    const taco = line(13500, 3);
    const o = view({ lines: [taco] });
    const plan = planDiscount(o, {
      scope: "line",
      lineId: taco.id,
      quantity: 1,
      kind: "comp",
    });
    expect(plan).toMatchObject({ base: 4500, amount: 4500, units: 1 });
    const after = view({
      lines: [taco],
      unitDiscounts: asUnitDiscounts(plan, "line"),
    });
    expect(after.paymentUnits!.map((u) => u.due)).toEqual([0, 4500, 4500]);
    expect(after.total).toBe(9000);
  });

  it("6. planDiscount: line scope takes the lowest eligible units, skips units with a line discount, refuses too many", () => {
    const taco = line(13500, 3);
    const o = view({ lines: [taco] });
    const first = planDiscount(o, {
      scope: "line",
      lineId: taco.id,
      quantity: 2,
      kind: "percent",
      percentBps: 1000,
    });
    expect(first.allocations.map((a) => a.unit)).toEqual([0, 1]);
    const after = view({
      lines: [taco],
      unitDiscounts: asUnitDiscounts(first, "line"),
    });
    const second = planDiscount(after, {
      scope: "line",
      lineId: taco.id,
      kind: "comp",
    });
    expect(second.allocations.map((a) => a.unit)).toEqual([2]);
    expect(
      code(() =>
        planDiscount(after, {
          scope: "line",
          lineId: taco.id,
          quantity: 2,
          kind: "comp",
        }),
      ),
    ).toBe("discount_units_unavailable");
  });

  it("7. planDiscount: an order discount applies after line discounts to what remains due; a second order discount is refused", () => {
    const taco = line(9000, 2);
    const o = view({ lines: [taco] });
    const lineComp = planDiscount(o, {
      scope: "line",
      lineId: taco.id,
      quantity: 1,
      kind: "comp",
    });
    const after = view({
      lines: [taco],
      unitDiscounts: asUnitDiscounts(lineComp, "line"),
    });
    const orderPlan = planDiscount(after, {
      scope: "order",
      kind: "percent",
      percentBps: 1000,
    });
    expect(orderPlan).toMatchObject({ base: 4500, amount: 450, units: 1 });
    const withOrder = {
      ...after,
      discounts: [
        { scope: "order", reversal: null } as NonNullable<
          Order["discounts"]
        >[number],
      ],
    };
    expect(
      code(() =>
        planDiscount(withOrder, {
          scope: "order",
          kind: "percent",
          percentBps: 500,
        }),
      ),
    ).toBe("discount_already_applied");
    // A reversed order discount no longer blocks a new one.
    const reversed = {
      ...after,
      discounts: [
        {
          scope: "order",
          reversal: {
            at: "",
            byName: "",
            approverName: null,
            note: "",
            amount: 0,
          },
        } as NonNullable<Order["discounts"]>[number],
      ],
    };
    expect(
      planDiscount(reversed, {
        scope: "order",
        kind: "percent",
        percentBps: 500,
      }).amount,
    ).toBe(225);
  });

  it("8. planDiscount: paid units are never targeted after a partial payment", () => {
    const taco = line(13500, 3);
    const cash = tender("cash", 4500);
    const o = view({
      lines: [taco],
      allocations: [
        { tenderId: cash.id, lineId: taco.id, unit: 0, amount: 4500 },
      ],
      tenders: [cash],
    });
    const plan = planDiscount(o, { scope: "order", kind: "comp" });
    expect(plan.allocations.map((a) => a.unit)).toEqual([1, 2]);
    expect(plan.base).toBe(9000);
    const nothing = view({
      lines: [line(4500, 1, { id: taco.id })],
      allocations: [
        { tenderId: cash.id, lineId: taco.id, unit: 0, amount: 4500 },
      ],
      tenders: [cash],
    });
    expect(
      code(() => planDiscount(nothing, { scope: "order", kind: "comp" })),
    ).toBe("discount_nothing_due");
  });

  it("9. discountLimitCheck: self for managers; for cashier and server the request's kind rule (MONEY-2) and the amount cap; comp needs 100%", () => {
    const c = controls({ maxPercentBps: 1000, maxAmount: 5000 });
    const check = (total: number) => ({ total, discount: 0, discounts: [] });
    const pct = (percentBps: number) => ({
      kind: "percent" as const,
      percentBps,
    });
    const fixed = { kind: "amount" as const };
    const comp = { kind: "comp" as const };
    const plan = (base: number, amount: number) => ({ base, amount });
    expect(discountLimitCheck("owner", comp, plan(10, 10), c, check(10))).toBe(
      "self",
    );
    expect(
      discountLimitCheck("manager", comp, plan(10, 10), c, check(10)),
    ).toBe("self");
    expect(
      discountLimitCheck(
        "cashier",
        pct(1000),
        plan(20000, 2000),
        c,
        check(20000),
      ),
    ).toBe("within");
    expect(
      discountLimitCheck(
        "cashier",
        pct(1001),
        plan(20000, 2002),
        c,
        check(20000),
      ),
    ).toBe("exceeds");
    // The amount cap holds whatever the percentage.
    expect(
      discountLimitCheck(
        "cashier",
        pct(1000),
        plan(60000, 6000),
        c,
        check(60000),
      ),
    ).toBe("exceeds");
    expect(
      discountLimitCheck("cashier", fixed, plan(20000, 2000), c, check(20000)),
    ).toBe("within");
    expect(
      discountLimitCheck("cashier", fixed, plan(20000, 2001), c, check(20000)),
    ).toBe("exceeds");
    // A comp is 100 %: a 10 % limit never covers it.
    expect(
      discountLimitCheck("cashier", comp, plan(4500, 4500), c, check(4500)),
    ).toBe("exceeds");
    expect(
      discountLimitCheck(
        "server",
        pct(500),
        plan(20000, 1000),
        c,
        check(20000),
      ),
    ).toBe("exceeds");
    expect(
      discountLimitCheck(
        "kitchen",
        pct(500),
        plan(20000, 1000),
        c,
        check(20000),
      ),
    ).toBe("exceeds");
    const comps = controls({ maxPercentBps: 10000, maxAmount: 4500 });
    expect(
      discountLimitCheck("cashier", comp, plan(4500, 4500), comps, check(4500)),
    ).toBe("within");
    // A comp of 99.99 % is not a comp: the limit must be 100 %.
    const almost = controls({ maxPercentBps: 9999, maxAmount: 100000 });
    expect(
      discountLimitCheck(
        "cashier",
        comp,
        plan(4500, 4500),
        almost,
        check(4500),
      ),
    ).toBe("exceeds");
  });

  it("9b. MONEY-2: a percentage at exactly the limit is within on odd bases (half-up rounding); a fixed amount compares with discount(base, limit)", () => {
    const ten = controls({ maxPercentBps: 1000, maxAmount: 1_000_000 });
    const one = (total: number) => ({ total, discount: 0, discounts: [] });
    // The INAPAM scenario: $134.55 due, 10 % chip → −$13.46 (1345.5 rounds up).
    expect(discount(13455, 1000)).toBe(1346);
    expect(
      discountLimitCheck(
        "cashier",
        { kind: "percent", percentBps: 1000 },
        { base: 13455, amount: 1346 },
        ten,
        one(13455),
      ),
    ).toBe("within");
    // Every odd base from $10.00 to $199.99 at exactly the 10 % limit.
    for (let base = 1000; base < 20000; base++)
      expect(
        discountLimitCheck(
          "cashier",
          { kind: "percent", percentBps: 1000 },
          { base, amount: discount(base, 1000) },
          ten,
          one(base),
        ),
        `base ${base}`,
      ).toBe("within");
    // 12.5 % on a $45.00 taco: 562.5 → 563.
    const eighth = controls({ maxPercentBps: 1250, maxAmount: 1_000_000 });
    expect(
      discountLimitCheck(
        "cashier",
        { kind: "percent", percentBps: 1250 },
        { base: 4500, amount: discount(4500, 1250) },
        eighth,
        one(4500),
      ),
    ).toBe("within");
    // A fixed amount: up to discount(base, limit), the same rounding.
    const fixed = { kind: "amount" as const };
    expect(
      discountLimitCheck(
        "cashier",
        fixed,
        { base: 13455, amount: 1346 },
        ten,
        one(13455),
      ),
    ).toBe("within");
    expect(
      discountLimitCheck(
        "cashier",
        fixed,
        { base: 13455, amount: 1347 },
        ten,
        one(13455),
      ),
    ).toBe("exceeds");
    expect(
      discountLimitCheck(
        "cashier",
        fixed,
        { base: 4501, amount: 450 },
        ten,
        one(4501),
      ),
    ).toBe("within");
    expect(
      discountLimitCheck(
        "cashier",
        fixed,
        { base: 4501, amount: 451 },
        ten,
        one(4501),
      ),
    ).toBe("exceeds");
  });

  it("9c. MONEY-3 / APPROVALS-1: the limits hold per check for discounts recorded without an approver; split or stacked discounts add up", () => {
    const staff = (
      amount: number,
      over: Partial<OrderDiscount> = {},
    ): OrderDiscount => ({
      id: randomUUID(),
      scope: "line",
      lineId: "l",
      kind: "comp",
      percentBps: null,
      base: amount,
      amount,
      units: 1,
      activeAmount: amount,
      releasedAmount: 0,
      allocations: [],
      reasonCode: "courtesy",
      note: "",
      actorName: "Dani Demo",
      approverName: null,
      createdAt: "2026-10-05T12:00:00.000Z",
      reversal: null,
      ...over,
    });
    const comp = { kind: "comp" as const };
    // "Cashiers may comp up to $50": 10 tacos at $45, one comp at a time.
    const cap50 = controls({ maxPercentBps: 10000, maxAmount: 5000 });
    const first = { total: 45000, discount: 0, discounts: [] };
    expect(
      discountLimitCheck(
        "cashier",
        comp,
        { base: 4500, amount: 4500 },
        cap50,
        first,
      ),
    ).toBe("within");
    const second = {
      total: 40500,
      discount: 4500,
      discounts: [staff(4500)],
    };
    expect(unapprovedDiscounts(second)).toEqual({ amount: 4500, count: 1 });
    expect(
      discountLimitCheck(
        "cashier",
        comp,
        { base: 4500, amount: 4500 },
        cap50,
        second,
      ),
    ).toBe("exceeds");
    // Approved and reversed discounts do not count.
    const approved = {
      total: 40500,
      discount: 4500,
      discounts: [
        staff(4500, { approverName: "Luis" }),
        staff(4500, {
          activeAmount: 0,
          reversal: {
            at: "2026-10-05T12:01:00.000Z",
            byName: "Luis",
            approverName: "Luis",
            note: "No aplicaba",
            amount: 4500,
          },
        }),
      ],
    };
    expect(unapprovedDiscounts(approved)).toEqual({ amount: 0, count: 0 });
    expect(
      discountLimitCheck(
        "cashier",
        comp,
        { base: 4500, amount: 4500 },
        cap50,
        approved,
      ),
    ).toBe("within");
    // 10 %: a 10 % line discount on every line is exactly 10 % of the check;
    // a 10 % check discount on top of it would make it 19 %.
    const ten = controls({ maxPercentBps: 1000, maxAmount: 1_000_000 });
    const pct = { kind: "percent" as const, percentBps: 1000 };
    const lines = {
      total: 67500,
      discount: 7500,
      discounts: [staff(5400), staff(2100)],
    };
    expect(
      discountLimitCheck("cashier", pct, { base: 21000, amount: 2100 }, ten, {
        total: 69600,
        discount: 5400,
        discounts: [staff(5400)],
      }),
    ).toBe("within");
    expect(
      discountLimitCheck(
        "cashier",
        pct,
        { base: 67500, amount: 6750 },
        ten,
        lines,
      ),
    ).toBe("exceeds");
    // Each discount keeps its half centavo of rounding: two 10 % line
    // discounts on $123.45 items (1235 each) fit 10 % of $246.90.
    expect(discount(12345, 1000)).toBe(1235);
    expect(
      discountLimitCheck("cashier", pct, { base: 12345, amount: 1235 }, ten, {
        total: 23455,
        discount: 1235,
        discounts: [staff(1235)],
      }),
    ).toBe("within");
  });

  it("10. payableUnits with discounts: due = total − discount − paid; allocatePayment item split charges the discounted due", () => {
    const taco = line(13500, 3);
    const unitDiscounts: UnitDiscount[] = [
      {
        lineId: taco.id,
        unit: 0,
        amount: 4500,
        scope: "line",
        discountId: "d1",
      },
      {
        lineId: taco.id,
        unit: 1,
        amount: 450,
        scope: "order",
        discountId: "d2",
      },
    ];
    const units = payableUnits([taco], [], unitDiscounts);
    expect(units.map((u) => [u.discount, u.due, u.lineDiscounted])).toEqual([
      [4500, 0, true],
      [450, 4050, false],
      [0, 4500, false],
    ]);
    const split = allocatePayment(units, 4050, [`${taco.id}:1`]);
    expect(split).toEqual([{ lineId: taco.id, unit: 1, amount: 4050 }]);
    expect(code(() => allocatePayment(units, 4500, [`${taco.id}:0`]))).toBe(
      "items_changed",
    );
    const paid = payableUnits([taco], split as Allocation[], unitDiscounts);
    expect(paid.map((u) => u.due)).toEqual([0, 0, 4500]);
    expect(
      code(() =>
        payableUnits(
          [taco],
          [{ lineId: taco.id, unit: 0, amount: 1 }],
          unitDiscounts,
        ),
      ),
    ).toBe("invalid_allocation");
  });

  it("11. voidCandidates: undiscounted units first, then highest index", () => {
    const taco = line(13500, 3);
    const o = view({
      lines: [taco],
      unitDiscounts: [
        {
          lineId: taco.id,
          unit: 2,
          amount: 4500,
          scope: "line",
          discountId: "c",
        },
      ],
    });
    expect(voidCandidates(o, taco.id).map((u) => u.unit)).toEqual([1, 0, 2]);
    // FISCAL-4: once the check has its fiscal ticket, its discounted (comped)
    // units are frozen on it and are not voidable; zero-priced units still are.
    const ticketed = {
      ...o,
      fiscal: { ticket: { folio: "A-000001" } },
    } as unknown as Order;
    expect(voidCandidates(ticketed, taco.id).map((u) => u.unit)).toEqual([
      1, 0,
    ]);
  });

  it("12. composeOrderAdjustments: active amounts exclude voided and reversed allocations; legacy refunds become synthetic batches", () => {
    const taco = line(13500, 3, { voidedUnits: [2] });
    const at = "2026-10-05T14:00:00.000Z";
    const row: AdjustmentRow = {
      discounts: [
        {
          id: "d1",
          scope: "order",
          lineId: null,
          kind: "percent",
          percentBps: 1000,
          base: 13500,
          amount: 1350,
          units: 3,
          reasonCode: "senior_inapam",
          note: "",
          actorName: "Ana",
          approverName: "Luis",
          createdAt: at,
          reversedAt: null,
          reversedByName: null,
          reversalApproverName: null,
          reversalNote: null,
          reversedAmount: null,
          allocations: [
            { lineId: taco.id, unit: 0, amount: 450 },
            { lineId: taco.id, unit: 1, amount: 450 },
            { lineId: taco.id, unit: 2, amount: 450 },
          ],
        },
        {
          id: "d2",
          scope: "line",
          lineId: taco.id,
          kind: "comp",
          percentBps: null,
          base: 4050,
          amount: 4050,
          units: 1,
          reasonCode: "courtesy",
          note: "",
          actorName: "Ana",
          approverName: null,
          createdAt: "2026-10-05T14:01:00.000Z",
          reversedAt: "2026-10-05T14:02:00.000Z",
          reversedByName: "Luis",
          reversalApproverName: "Luis",
          reversalNote: "error de captura",
          reversedAmount: 4050,
          allocations: [{ lineId: taco.id, unit: 0, amount: 4050 }],
        },
      ],
      refunds: [
        {
          refundId: "r1",
          tenderId: "t1",
          batchId: null,
          method: "cash",
          amount: 500,
          reference: null,
          reason: "devolución antigua",
          createdAt: at,
          actorName: "Luis",
        },
      ],
      batches: [],
      refundUnits: [],
      refundLines: [],
    };
    const adj = composeOrderAdjustments(row, { lines: [taco] });
    expect(
      adj.discounts.map((d) => [d.id, d.activeAmount, d.releasedAmount]),
    ).toEqual([
      ["d1", 900, 450],
      ["d2", 0, 0],
    ]);
    expect(adj.unitDiscounts.map((u) => u.unit)).toEqual([0, 1]);
    expect(adj.lineDiscounts).toEqual({ [taco.id]: 900 });
    expect(adj.discountTotal).toBe(900);
    expect(adj.discounts[1].reversal).toMatchObject({
      byName: "Luis",
      amount: 4050,
    });
    expect(adj.refundBatches).toEqual([
      expect.objectContaining({
        id: "r1",
        legacy: true,
        mode: "amount",
        reasonCode: "other",
        note: "devolución antigua",
        approverName: "Luis",
        cashAmount: 500,
        externalAmount: 0,
      }),
    ]);
    expect(
      composeOrderAdjustments(undefined, { lines: [taco] }).discountTotal,
    ).toBe(0);
  });
});

describe("item refunds (MON-4)", () => {
  /** §4.3 worked example: taco ×3 at 4500 with a 10 % line discount on units {0,1}, café 12000. */
  function worked() {
    const taco = line(13500, 3);
    const cafe = line(12000, 1);
    const unitDiscounts: UnitDiscount[] = [
      { lineId: taco.id, unit: 0, amount: 450, scope: "line", discountId: "d" },
      { lineId: taco.id, unit: 1, amount: 450, scope: "line", discountId: "d" },
    ];
    const cash = tender("cash", 6075);
    const card = tender("external", 18525, "482913");
    const allocations: TenderAllocation[] = [
      { tenderId: cash.id, lineId: taco.id, unit: 0, amount: 4050 },
      { tenderId: cash.id, lineId: taco.id, unit: 1, amount: 2025 },
      { tenderId: card.id, lineId: taco.id, unit: 1, amount: 2025 },
      { tenderId: card.id, lineId: taco.id, unit: 2, amount: 4500 },
      { tenderId: card.id, lineId: cafe.id, unit: 0, amount: 12000 },
    ];
    // allocatePayment fills units in order, so the two payments allocate exactly so.
    const units = payableUnits([taco, cafe], [], unitDiscounts);
    expect(allocatePayment(units, 6075)).toEqual(
      allocations.slice(0, 2).map(({ tenderId: _t, ...a }) => a),
    );
    return { taco, cafe, cash, card, unitDiscounts, allocations };
  }

  it("13. planItemRefund: highest fully paid units, split by tender allocations, minus earlier unit refunds", () => {
    const w = worked();
    const o = view({
      lines: [w.taco, w.cafe],
      allocations: w.allocations,
      unitDiscounts: w.unitDiscounts,
      tenders: [w.cash, w.card],
    });
    expect(o.total).toBe(24600);
    const plan = planItemRefund(o, [{ lineId: w.taco.id, quantity: 2 }]);
    expect(plan.total).toBe(8550);
    expect(plan.lines).toEqual([
      { lineId: w.taco.id, units: [1, 2], amount: 8550 },
    ]);
    expect(plan.byTender).toEqual([
      { tenderId: w.cash.id, method: "cash", amount: 2025, reference: null },
      {
        tenderId: w.card.id,
        method: "external",
        amount: 6525,
        reference: "482913",
      },
    ]);
    // After refunding unit 2, the next refund takes unit 1 and then unit 0.
    const refundedUnits: RefundedUnit[] = [
      {
        refundId: "r",
        tenderId: w.card.id,
        lineId: w.taco.id,
        unit: 2,
        amount: 4500,
      },
    ];
    const after = view({
      lines: [w.taco, w.cafe],
      allocations: w.allocations,
      unitDiscounts: w.unitDiscounts,
      tenders: [w.cash, { ...w.card, refunded: 4500 }],
      refundedUnits,
    });
    expect(
      planItemRefund(after, [{ lineId: w.taco.id, quantity: 1 }]).units,
    ).toEqual([
      { lineId: w.taco.id, unit: 1, tenderId: w.cash.id, amount: 2025 },
      { lineId: w.taco.id, unit: 1, tenderId: w.card.id, amount: 2025 },
    ]);
    expect(
      code(() => planItemRefund(after, [{ lineId: w.taco.id, quantity: 3 }])),
    ).toBe("refund_units_unavailable");
    expect(
      code(() =>
        planItemRefund(o, [
          { lineId: w.taco.id, quantity: 1 },
          { lineId: w.taco.id, quantity: 1 },
        ]),
      ),
    ).toBe("invalid_input");
  });

  it("14. planItemRefund: partially paid units are not refundable; tender capacity consumed by amount refunds gives refund_exceeds", () => {
    const taco = line(9000, 2);
    const cash = tender("cash", 6000);
    const allocations: TenderAllocation[] = [
      { tenderId: cash.id, lineId: taco.id, unit: 0, amount: 4500 },
      { tenderId: cash.id, lineId: taco.id, unit: 1, amount: 1500 },
    ];
    const partial = view({ lines: [taco], allocations, tenders: [cash] });
    expect(refundableQuantities(partial)).toEqual({ [taco.id]: 1 });
    expect(
      code(() => planItemRefund(partial, [{ lineId: taco.id, quantity: 2 }])),
    ).toBe("refund_units_unavailable");
    const consumed = view({
      lines: [taco],
      allocations,
      tenders: [{ ...cash, refunded: 3000 }],
    });
    expect(
      code(() => planItemRefund(consumed, [{ lineId: taco.id, quantity: 1 }])),
    ).toBe("refund_exceeds");
  });

  it("DSC-R9: a stale preview of an identical unit has the same total but other units; itemRefundPlanMatches tells them apart", () => {
    // Two tacos at 4500 paid in cash; two devices preview refunding one.
    const taco = line(9000, 2);
    const cash = tender("cash", 9000);
    const allocations: TenderAllocation[] = [
      { tenderId: cash.id, lineId: taco.id, unit: 0, amount: 4500 },
      { tenderId: cash.id, lineId: taco.id, unit: 1, amount: 4500 },
    ];
    const request = [{ lineId: taco.id, quantity: 1 }];
    const stale = view({ lines: [taco], allocations, tenders: [cash] });
    const previewed = planItemRefund(stale, request);
    const expected = itemRefundExpectation(previewed);
    expect(expected).toEqual({
      expectedAmount: 4500,
      expectedUnits: [{ lineId: taco.id, units: [1] }],
    });
    expect(itemRefundPlanMatches(previewed, expected)).toBe(true);
    // The other device refunded unit 1: the server now plans unit 0 for 4500.
    const after = view({
      lines: [taco],
      allocations,
      tenders: [{ ...cash, refunded: 4500 }],
      refundedUnits: [
        {
          refundId: "r",
          tenderId: cash.id,
          lineId: taco.id,
          unit: 1,
          amount: 4500,
        },
      ],
    });
    const server = planItemRefund(after, request);
    expect(server.total).toBe(previewed.total);
    expect(server.lines[0].units).toEqual([0]);
    expect(itemRefundPlanMatches(server, expected)).toBe(false);
    expect(after.refunded).not.toBe(stale.refunded);
    // Order of lines and of units, and the id's case, do not matter; a missing
    // or an extra line, another total or a duplicated line id do.
    const both = planItemRefund(stale, [{ lineId: taco.id, quantity: 2 }]);
    expect(
      itemRefundPlanMatches(both, {
        expectedAmount: 9000,
        expectedUnits: [{ lineId: taco.id.toUpperCase(), units: [1, 0] }],
      }),
    ).toBe(true);
    expect(
      itemRefundPlanMatches(both, {
        ...itemRefundExpectation(both),
        expectedAmount: 8999,
      }),
    ).toBe(false);
    expect(
      itemRefundPlanMatches(both, {
        expectedAmount: 9000,
        expectedUnits: [
          { lineId: taco.id, units: [0, 1] },
          { lineId: taco.id, units: [0, 1] },
        ],
      }),
    ).toBe(false);
    expect(
      itemRefundPlanMatches(both, {
        expectedAmount: 9000,
        expectedUnits: [
          { lineId: taco.id, units: [0, 1] },
          { lineId: randomUUID(), units: [0] },
        ],
      }),
    ).toBe(false);
  });

  it("15. refundableQuantities matches the largest successful planItemRefund per line", () => {
    const w = worked();
    const o = view({
      lines: [w.taco, w.cafe],
      allocations: w.allocations,
      unitDiscounts: w.unitDiscounts,
      tenders: [w.cash, { ...w.card, refunded: 12000 }],
    });
    const q = refundableQuantities(o);
    // The card has 6525 left: taco units 2 (4500) and 1 (2025 card + 2025 cash) fit, the café does not.
    expect(q).toEqual({ [w.taco.id]: 3 });
    for (const [lineId, n] of Object.entries(q)) {
      expect(() => planItemRefund(o, [{ lineId, quantity: n }])).not.toThrow();
      expect(
        code(() => planItemRefund(o, [{ lineId, quantity: n + 1 }])),
      ).not.toBe("no error");
    }
    expect(
      code(() => planItemRefund(o, [{ lineId: w.cafe.id, quantity: 1 }])),
    ).toBe("refund_exceeds");
  });

  it("23. refundTaxScopes: per tender and line, units ascending and gross = Σ unit amounts; the §4.3 worked example", () => {
    const w = worked();
    const o = view({
      lines: [w.taco, w.cafe],
      allocations: w.allocations,
      unitDiscounts: w.unitDiscounts,
      tenders: [w.cash, w.card],
    });
    const plan = planItemRefund(o, [{ lineId: w.taco.id, quantity: 2 }]);
    const scopes = refundTaxScopes(plan.units);
    expect(scopes).toEqual({
      [w.cash.id]: [{ lineId: w.taco.id, units: [1], gross: 2025 }],
      [w.card.id]: [{ lineId: w.taco.id, units: [1, 2], gross: 6525 }],
    });
    for (const t of plan.byTender)
      expect(scopes[t.tenderId].reduce((a, s) => a + s.gross, 0)).toBe(
        t.amount,
      );
    // Complement extraction on the iva16 group (S = 12600): 279 then 900 (fiscal §4.3).
    const S = 12600;
    const tax = (g: number) => extractTax(g, 1600).tax;
    expect(tax(S) - tax(S - 2025)).toBe(279);
    expect(tax(S - 2025) - tax(S - 2025 - 6525)).toBe(900);
  });
});

describe("fiscal interaction (§4.3)", () => {
  it("16. fiscal reconciliation property: random orders with voids, discounts and payments have no unallocated discount", () => {
    const r = rng(1028);
    const zero = { taxCategory: "iva0" };
    for (let i = 0; i < 400; i++) {
      const lines = Array.from({ length: r.int(1, 4) }, () => {
        const quantity = r.int(1, 5);
        const unit = r.int(1, 30000);
        return fiscalLine({
          total: unit * quantity,
          quantity,
          fiscal: r.next() < 0.3 ? zero : {},
        }) as PricedLine;
      });
      const voidSome = () => {
        for (const l of lines)
          for (let u = 0; u < l.quantity; u++)
            if (r.next() < 0.1 && !l.voidedUnits!.includes(u))
              l.voidedUnits = [...l.voidedUnits!, u].sort((a, b) => a - b);
      };
      voidSome();
      let unitDiscounts: UnitDiscount[] = [];
      const discounts: NonNullable<Order["discounts"]> = [];
      for (let k = 0; k < r.int(0, 3); k++) {
        const o = view({ lines, unitDiscounts, discounts });
        const scope = r.next() < 0.5 ? "order" : "line";
        const candidate = lines[r.int(0, lines.length - 1)];
        try {
          const plan = planDiscount(o, {
            scope,
            lineId: scope === "line" ? candidate.id : undefined,
            kind: r.pick(["percent", "amount", "comp"] as const),
            percentBps: r.int(1, 10000),
            amount: r.int(1, 20000),
          });
          unitDiscounts = [...unitDiscounts, ...asUnitDiscounts(plan, scope)];
          if (scope === "order")
            discounts.push({
              scope: "order",
              reversal: null,
            } as (typeof discounts)[number]);
        } catch {
          /* nothing eligible or over the due: skip */
        }
      }
      // Voids after discounts release the discounts of the voided units.
      voidSome();
      const live = unitDiscounts.filter(
        (d) =>
          !lines.find((l) => l.id === d.lineId)!.voidedUnits!.includes(d.unit),
      );
      const lineDiscounts: Record<string, number> = {};
      for (const d of live)
        lineDiscounts[d.lineId] = (lineDiscounts[d.lineId] ?? 0) + d.amount;
      const gross = lines.reduce((a, l) => a + lineRemaining(l).total, 0);
      const total = gross - live.reduce((a, d) => a + d.amount, 0);
      const summary = orderTaxSummary({
        lines,
        lineDiscounts,
        total,
        ctx: DEFAULT_FISCAL_CONTEXT,
      });
      expect(summary.unallocatedDiscount).toBe(0);
      expect(summary.groups.reduce((a, g) => a + g.gross, 0)).toBe(total);
      // A random payment never exceeds what is due.
      const o = view({ lines, unitDiscounts: live, discounts });
      const due = o.paymentUnits!.reduce((a, u) => a + u.due, 0);
      expect(due).toBe(total);
      if (due > 0) {
        const paid = allocatePayment(o.paymentUnits!, r.int(1, due));
        for (const a of paid) {
          const u = o.paymentUnits!.find(
            (x) => x.lineId === a.lineId && x.unit === a.unit,
          )!;
          expect(a.amount).toBeLessThanOrEqual(u.due);
        }
      }
    }
  });

  it("17. mixed-rate order discount: worked example of §4.3 to the centavo (iva16 8100/6983/1117, iva0 10800)", () => {
    const taco = fiscalLine({ total: 9000, quantity: 2 }) as PricedLine;
    const cafe = fiscalLine({
      total: 12000,
      quantity: 1,
      fiscal: { taxCategory: "iva0" },
    }) as PricedLine;
    const o = view({ lines: [taco, cafe] });
    const plan = planDiscount(o, {
      scope: "order",
      kind: "percent",
      percentBps: 1000,
    });
    expect(plan.amount).toBe(2100);
    const adj = asUnitDiscounts(plan, "order");
    const lineDiscounts: Record<string, number> = {};
    for (const d of adj)
      lineDiscounts[d.lineId] = (lineDiscounts[d.lineId] ?? 0) + d.amount;
    expect(lineDiscounts).toEqual({ [taco.id]: 900, [cafe.id]: 1200 });
    const summary = orderTaxSummary({
      lines: [taco, cafe],
      lineDiscounts,
      total: 18900,
      ctx: DEFAULT_FISCAL_CONTEXT,
    });
    const iva16 = summary.groups.find((g) => g.category === "iva16")!;
    const iva0 = summary.groups.find((g) => g.category === "iva0")!;
    expect([iva16.gross, iva16.base, iva16.tax]).toEqual([8100, 6983, 1117]);
    expect([iva16.baseBeforeDiscount, iva16.discountBase]).toEqual([7759, 776]);
    expect([iva0.gross, iva0.tax, iva0.discount]).toEqual([10800, 0, 1200]);
    expect(summary.gross).toBe(18900);
    expect(summary.unallocatedDiscount).toBe(0);
  });
});

describe("inputs and helpers", () => {
  it("18. discountInputIssue and refundInput: strict schemas, cross-field rules and 'other' needs a note", () => {
    const base = {
      operationId: randomUUID(),
      expectedVersion: 1,
      scope: "order" as const,
      kind: "percent" as const,
      percentBps: 1000,
      reasonCode: "courtesy" as const,
      // DSC-R13: the request carries what its preview showed.
      expectedAmount: 900,
      expectedBase: 9000,
      expectedAllocations: [
        { lineId: randomUUID(), units: [0, 1], amounts: [450, 450] },
      ],
      expectedDue: 9000,
      expectedCloses: false,
    };
    const p = discountInput.parse(base);
    expect(p.note).toBe("");
    for (const key of [
      "expectedAmount",
      "expectedBase",
      "expectedAllocations",
      "expectedDue",
      "expectedCloses",
    ] as const) {
      const { [key]: _omitted, ...without } = base;
      expect(discountInput.safeParse(without).success).toBe(false);
    }
    expect(
      discountInput.safeParse({
        ...base,
        expectedAllocations: [
          { lineId: randomUUID(), units: [0, 1], amounts: [900] },
        ],
      }).success,
    ).toBe(false);
    expect(
      discountInput.safeParse({ ...base, expectedAllocations: [] }).success,
    ).toBe(false);
    expect(discountInputIssue(p)).toBeNull();
    expect(discountInput.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(discountInputIssue({ ...p, scope: "line" })).toBe("invalid_input");
    expect(discountInputIssue({ ...p, lineId: randomUUID() })).toBe(
      "invalid_input",
    );
    expect(discountInputIssue({ ...p, amount: 10 })).toBe("discount_invalid");
    expect(
      discountInputIssue({ ...p, kind: "amount", percentBps: undefined }),
    ).toBe("discount_invalid");
    expect(discountInputIssue({ ...p, kind: "comp" })).toBe("discount_invalid");
    expect(discountInputIssue({ ...p, reasonCode: "other", note: " a " })).toBe(
      "discount_note_required",
    );
    expect(
      discountInputIssue({ ...p, reasonCode: "other", note: "frío" }),
    ).toBeNull();
    const lineId = randomUUID();
    const itemsRequest = {
      mode: "items",
      operationId: randomUUID(),
      lines: [{ lineId, quantity: 1 }],
      expectedAmount: 4500,
      expectedUnits: [{ lineId, units: [1] }],
      expectedRefunded: 0,
      restock: false,
      reasonCode: "quality",
    };
    const items = refundInput.parse(itemsRequest);
    expect(items).toMatchObject({ note: "", external: [] });
    // DSC-R9: the preview's units and refunded total are required.
    for (const missing of ["expectedUnits", "expectedRefunded"] as const) {
      const { [missing]: _drop, ...rest } = itemsRequest;
      expect(refundInput.safeParse(rest).success).toBe(false);
    }
    expect(
      refundInput.safeParse({
        mode: "amount",
        operationId: randomUUID(),
        tenderId: randomUUID(),
        amount: 100,
        reasonCode: "charge_error",
      }).success,
    ).toBe(false);
    expect(
      refundInput.safeParse({
        mode: "amount",
        operationId: randomUUID(),
        tenderId: randomUUID(),
        amount: 100,
        expectedRefunded: 0,
        reasonCode: "charge_error",
      }).success,
    ).toBe(true);
    expect(
      refundInput.safeParse({
        mode: "amount",
        operationId: randomUUID(),
        tenderId: randomUUID(),
        amount: 100,
        reasonCode: "other",
        external: [
          { tenderId: randomUUID(), reference: "1", confirmed: false },
        ],
      }).success,
    ).toBe(false);
    expect(
      refundInput.safeParse({
        mode: "amount",
        operationId: randomUUID(),
        amount: 1,
      }).success,
    ).toBe(false);
    expect(
      moneyControlsInput.safeParse({
        operationId: randomUUID(),
        expectedVersion: 0,
        limits: {
          cashier: { maxPercentBps: 10001, maxAmount: 0 },
          server: { maxPercentBps: 0, maxAmount: 0 },
        },
        blindClose: true,
        expectedRoles: [],
        closeRoles: [],
      }).success,
    ).toBe(false);
  });

  it("19. percentToBps and formatPercentBps round-trip; rejects 0, 100.01 and three decimals", () => {
    expect(percentToBps("12.5")).toBe(1250);
    expect(percentToBps(" 10 ")).toBe(1000);
    expect(percentToBps("0.01")).toBe(1);
    expect(percentToBps("100")).toBe(10000);
    for (const bad of ["0", "100.01", "1.234", "", "-5", "abc", "1e2"])
      expect(percentToBps(bad)).toBeNull();
    for (const bps of [1, 50, 500, 1000, 1250, 1255, 9999, 10000]) {
      const text = formatPercentBps(bps, "en");
      expect(percentToBps(text.replace("%", ""))).toBe(bps);
    }
    expect(formatPercentBps(1250, "es")).toBe("12.5 %");
    expect(formatPercentBps(1000, "en")).toBe("10%");
    expect(formatPercentBps(1205, "es")).toBe("12.05 %");
  });

  it("20. cashCloseInput legacy body parses to the same object (fingerprint stable)", () => {
    const legacy = { operationId: randomUUID(), counted: 50000, reason: "" };
    const parsed = cashCloseInput.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(legacy));
    expect(
      cashCloseInput.parse({ ...legacy, externalReported: 1200 })
        .externalReported,
    ).toBe(1200);
    expect(cashCloseInput.safeParse({ ...legacy, other: 1 }).success).toBe(
      false,
    );
  });

  it("21. canSeeExpected / canCloseDrawer defaults: owner and manager only", () => {
    const c = DEFAULT_MONEY_CONTROLS;
    expect(
      ["owner", "manager", "cashier", "server", "kitchen"].map((r) =>
        canSeeExpected(r, c),
      ),
    ).toEqual([true, true, false, false, false]);
    expect(
      ["owner", "manager", "cashier", "server", "kitchen"].map((r) =>
        canCloseDrawer(r, c),
      ),
    ).toEqual([true, true, false, false, false]);
    const open: MoneyControls = {
      ...c,
      expectedRoles: ["cashier"],
      closeRoles: ["server"],
    };
    expect(canSeeExpected("manager", open)).toBe(false);
    expect(canSeeExpected("owner", open)).toBe(true);
    expect(canSeeExpected("cashier", open)).toBe(true);
    expect(canCloseDrawer("server", open)).toBe(true);
    expect(canCloseDrawer("cashier", open)).toBe(false);
  });

  it("24. amountRefundAllowed and balanceDue: false/positive while paid < total, true/0 once paid ≥ total", () => {
    expect(balanceDue({ total: 1000, paid: 400 })).toBe(600);
    expect(amountRefundAllowed({ total: 1000, paid: 400 })).toBe(false);
    expect(balanceDue({ total: 1000, paid: 1000 })).toBe(0);
    expect(amountRefundAllowed({ total: 1000, paid: 1000 })).toBe(true);
    // A recovery order: total = paid by construction.
    expect(amountRefundAllowed({ total: 25000, paid: 25000 })).toBe(true);
    expect(balanceDue({ total: 1000, paid: 1200 })).toBe(0);
  });

  it("25. discountClosesCheck: a whole-check comp on a takeaway or tableless check is true; on a dine-in table check false; a partial discount false", () => {
    const o = {
      total: 9000,
      paid: 0,
      mode: "takeaway",
      tableId: null,
      channel: "pos",
    };
    expect(discountClosesCheck(o, { amount: 9000 })).toBe(true);
    expect(
      discountClosesCheck({ ...o, mode: "dine_in" }, { amount: 9000 }),
    ).toBe(true);
    expect(
      discountClosesCheck(
        { ...o, mode: "dine_in", tableId: randomUUID() },
        { amount: 9000 },
      ),
    ).toBe(false);
    expect(discountClosesCheck(o, { amount: 900 })).toBe(false);
    expect(discountClosesCheck({ ...o, paid: 4500 }, { amount: 4500 })).toBe(
      true,
    );
  });

  it("25b. FISCAL-2: a discount that settles a dine-in table check with a total above 0 issues its ticket, so it is final; at a zero total it stays correctable", () => {
    const table = {
      total: 9000,
      paid: 4500,
      mode: "dine_in",
      tableId: randomUUID(),
      channel: "pos",
      restaurantSnapshot: null,
    };
    // The last unpaid taco comped: total 4500 = paid → paid + ticket.
    expect(discountClosesCheck(table, { amount: 4500 })).toBe(false);
    expect(discountIssuesTicket(table, { amount: 4500 })).toBe(true);
    expect(discountIsFinal(table, { amount: 4500 })).toBe(true);
    // Nothing paid, comped to 0: no ticket for a zero total.
    expect(discountIssuesTicket({ ...table, paid: 0 }, { amount: 9000 })).toBe(
      false,
    );
    expect(discountIsFinal({ ...table, paid: 0 }, { amount: 9000 })).toBe(
      false,
    );
    // A balance still due afterwards: no ticket yet.
    expect(discountIssuesTicket(table, { amount: 450 })).toBe(false);
    // A takeaway check closes instead (final either way).
    const takeaway = { ...table, mode: "takeaway", tableId: null };
    expect(discountIssuesTicket(takeaway, { amount: 4500 })).toBe(false);
    expect(discountIsFinal(takeaway, { amount: 4500 })).toBe(true);
    // Fiscal tickets are MXN only.
    expect(
      discountIssuesTicket(
        {
          ...table,
          restaurantSnapshot: {
            name: "Diner",
            currency: "USD",
            timezone: "America/Mexico_City",
            cutoff: 240,
          },
        },
        { amount: 4500 },
      ),
    ).toBe(false);
    // The preview carries it: a confirm on a check that would no longer
    // issue the ticket (or newly would) answers discount_changed.
    const taco = line(9000, 2);
    const paidOne = view({
      lines: [taco],
      allocations: [{ tenderId: "t", lineId: taco.id, unit: 0, amount: 4500 }],
      tenders: [{ ...tender("cash", 4500), id: "t" }],
    });
    const atTable = { ...paidOne, mode: "dine_in", tableId: randomUUID() };
    const comp = { scope: "order" as const, kind: "comp" as const };
    expect(
      discountExpectation(atTable, planDiscount(atTable, comp)).expectedCloses,
    ).toBe(true);
  });

  it("25c. FISCAL-2 / MONEY-4: Quitar descuento is never offered on a ticketed check; a check discount whose units were all voided can still be removed (it frees the slot)", () => {
    const taco = line(9000, 2, { voidedUnits: [0, 1] });
    const released: OrderDiscount = {
      id: "d1",
      scope: "order",
      lineId: null,
      kind: "percent",
      percentBps: 1000,
      base: 9000,
      amount: 900,
      units: 2,
      activeAmount: 0,
      releasedAmount: 900,
      allocations: [
        { lineId: taco.id, unit: 0, amount: 450, voided: true },
        { lineId: taco.id, unit: 1, amount: 450, voided: true },
      ],
      reasonCode: "senior_inapam",
      note: "",
      actorName: "Ana",
      approverName: "Luis",
      createdAt: "2026-10-05T12:00:00.000Z",
      reversal: null,
    };
    const o = view({ lines: [taco], discounts: [released] });
    expect(discountRemovable(o, released)).toBe(true);
    expect(
      discountRemovable(o, { ...released, scope: "line", lineId: taco.id }),
    ).toBe(false);
    const live = view({
      lines: [line(9000, 2)],
      discounts: [{ ...released, activeAmount: 900, releasedAmount: 0 }],
    });
    const d = live.discounts![0];
    expect(discountRemovable(live, d)).toBe(true);
    expect(
      discountRemovable(
        { ...live, fiscal: { ticket: { folio: "A-1" } } } as unknown as Order,
        d,
      ),
    ).toBe(false);
  });

  it("26. FISCAL-3: after an amount refund a check whose lines span two tax categories takes no item refunds; one category still does", () => {
    const tax = (category: string) =>
      ({
        v: 1,
        category,
        rateBps: category === "iva16" ? 1600 : 0,
        basis: "inclusive",
        satProductKey: "90101500",
        satUnitKey: "H87",
        base: 0,
        tax: 0,
      }) as unknown as PricedLine["tax"];
    const latte = line(10000, 1, { tax: tax("iva16") });
    const beans = line(20000, 1, { tax: tax("iva0") });
    const amountBatch = {
      id: "b",
      mode: "amount",
    } as unknown as NonNullable<Order["refundBatches"]>[number];
    const mixed = view({ lines: [latte, beans] });
    expect(itemRefundsBlocked(mixed)).toBe(false);
    expect(itemRefundsBlocked({ ...mixed, refundBatches: [amountBatch] })).toBe(
      true,
    );
    const single = view({
      lines: [latte, line(5000, 1, { tax: tax("iva16") })],
    });
    expect(
      itemRefundsBlocked({ ...single, refundBatches: [amountBatch] }),
    ).toBe(false);
    // A fully voided line no longer counts.
    const voidedBeans = view({
      lines: [latte, { ...beans, voidedUnits: [0] }],
    });
    expect(
      itemRefundsBlocked({ ...voidedBeans, refundBatches: [amountBatch] }),
    ).toBe(false);
  });

  it("27. MONEY-8 / UI-8: no duplicate-terminal-charge reason; printed reason labels say 'Otro', never the form's instruction", () => {
    expect(REFUND_REASONS as readonly string[]).not.toContain(
      "duplicate_terminal_charge",
    );
    expect(reasonLabel("discount", "other", "es")).toBe("Otro");
    expect(reasonLabel("refund", "other", "en")).toBe("Other");
    expect(reasonLabel("refund", "something_old", "es")).toBe("Otro");
    expect(reasonLabel("refund", "quality", "es")).toBe(
      "Producto con defecto o queja",
    );
    expect(reasonLabel("discount", "quality", "es")).toBe(
      "Producto con defecto",
    );
  });

  it("28. loyalty (038 §2.6): the club reward is a reason Descuento never offers, labelled 'Recompensa del club', and it never counts against a cashier's limit", () => {
    expect(DISCOUNT_REASONS as readonly string[]).toContain("loyalty_reward");
    expect(RESERVED_DISCOUNT_REASON).toBe("loyalty_reward");
    expect(SELECTABLE_DISCOUNT_REASONS as readonly string[]).not.toContain(
      "loyalty_reward",
    );
    expect(SELECTABLE_DISCOUNT_REASONS).toEqual(
      DISCOUNT_REASONS.filter((r) => r !== "loyalty_reward"),
    );
    expect(reasonLabel("discount", "loyalty_reward", "es")).toBe(
      "Recompensa del club",
    );
    expect(reasonLabel("discount", "loyalty_reward", "en")).toBe(
      "Loyalty reward",
    );
    // Rows on the ticket, Detalle and Vender name the reward, never "Cortesía" (§2.6).
    expect(
      discountRowLabel({ kind: "comp", percentBps: null, reasonCode: "loyalty_reward" }, "es"),
    ).toBe("Recompensa del club");
    expect(
      discountRowLabel({ kind: "amount", percentBps: null, reasonCode: "loyalty_reward" }, "en"),
    ).toBe("Loyalty reward");
    expect(discountRowLabel({ kind: "comp", percentBps: null, reasonCode: "courtesy" }, "es")).toBe(
      discountRowLabel({ kind: "comp", percentBps: null }, "es"),
    );
    const reward = {
      id: randomUUID(),
      scope: "line" as const,
      lineId: "l",
      kind: "comp" as const,
      percentBps: null,
      base: 8500,
      amount: 8500,
      units: 1,
      activeAmount: 8500,
      releasedAmount: 0,
      allocations: [],
      reasonCode: "loyalty_reward",
      note: "",
      actorName: "Dani Demo",
      approverName: null,
      createdAt: "2026-10-05T12:00:00.000Z",
      reversal: null,
    };
    const staff = { ...reward, id: randomUUID(), reasonCode: "courtesy", base: 4500, amount: 4500, activeAmount: 4500 };
    expect(unapprovedDiscounts({ discounts: [reward] })).toEqual({ amount: 0, count: 0 });
    expect(unapprovedDiscounts({ discounts: [reward, staff] })).toEqual({ amount: 4500, count: 1 });
  });
});

describe("count strings (DSC-R14)", () => {
  const pairs: [Key, Key][] = [
    ["discountsEligibleUnits", "discountsEligibleUnitsOne"],
    ["discountsRefundAvailable", "discountsRefundAvailableOne"],
    ["discountsRefundKitchen", "discountsRefundKitchenOne"],
    ["discountsDrawerPayments", "discountsDrawerPaymentsOne"],
  ];
  it("a count of 1 reads in the singular in Spanish and English; other counts use the plural template", () => {
    const es = (k: Key) => strings.es[k];
    const en = (k: Key) => strings.en[k];
    expect(pairs.map(([many, one]) => countText(es, many, one, 1))).toEqual([
      "1 pieza sin cobrar",
      "1 reembolsable",
      "Cocina recibirá el aviso de no preparar 1 producto.",
      "1 cobro",
    ]);
    expect(pairs.map(([many, one]) => countText(es, many, one, 2))).toEqual([
      "2 piezas sin cobrar",
      "2 reembolsables",
      "Cocina recibirá el aviso de no preparar 2 productos.",
      "2 cobros",
    ]);
    expect(pairs.map(([many, one]) => countText(en, many, one, 1))).toEqual([
      "1 unpaid unit",
      "1 refundable",
      "The kitchen will be told not to prepare 1 item.",
      "1 payment",
    ]);
    expect(
      countText(en, "discountsDrawerPayments", "discountsDrawerPaymentsOne", 0),
    ).toBe("0 payments");
  });
});

describe("discount preview guard (DSC-R13)", () => {
  // Four plates at $100 on a takeaway check.
  const plates = line(40000, 4);
  const open = view({ lines: [plates] });
  const cash = tender("cash", 10000);
  /** The same check after another terminal charged plate 0 by item split. */
  const onePaid = view({
    lines: [plates],
    allocations: [
      { tenderId: cash.id, lineId: plates.id, unit: 0, amount: 10000 },
    ],
    tenders: [cash],
  });
  const previewOn = (o: Order, r: Parameters<typeof planDiscount>[1]) =>
    discountExpectation(o, planDiscount(o, r));
  const matches = (
    o: Order,
    r: Parameters<typeof planDiscount>[1],
    expected: ReturnType<typeof discountExpectation>,
  ) => discountPlanMatches(o, planDiscount(o, r), expected);

  it("discountExpectation groups the parts per line, with the starting balance and the closing outcome", () => {
    const taco = line(9000, 2);
    const cafe = line(12000, 1);
    const o = view({ lines: [taco, cafe] });
    expect(
      previewOn(o, { scope: "order", kind: "percent", percentBps: 1000 }),
    ).toEqual({
      expectedAmount: 2100,
      expectedBase: 21000,
      expectedAllocations: [
        { lineId: taco.id, units: [0, 1], amounts: [450, 450] },
        { lineId: cafe.id, units: [0], amounts: [1200] },
      ],
      expectedDue: 21000,
      expectedCloses: false,
    });
  });

  it("a whole-check comp previewed at −$400 does not match the −$300 plan after one plate was paid elsewhere; the same check matches", () => {
    const comp = { scope: "order" as const, kind: "comp" as const };
    const expected = previewOn(open, comp);
    expect(expected.expectedAmount).toBe(40000);
    expect(matches(open, comp, expected)).toBe(true);
    expect(planDiscount(onePaid, comp).amount).toBe(30000);
    expect(matches(onePaid, comp, expected)).toBe(false);
  });

  it("a 10% discount previewed at −$40 does not match the −$30 plan after a payment in between", () => {
    const pct = {
      scope: "order" as const,
      kind: "percent" as const,
      percentBps: 1000,
    };
    const expected = previewOn(open, pct);
    expect(expected.expectedAmount).toBe(4000);
    expect(planDiscount(onePaid, pct).amount).toBe(3000);
    expect(matches(onePaid, pct, expected)).toBe(false);
  });

  it("a fixed −$100 previewed with no closing warning does not match once $300 were paid in between (it would close the takeaway check)", () => {
    const fixed = {
      scope: "order" as const,
      kind: "amount" as const,
      amount: 10000,
    };
    const expected = previewOn(open, fixed);
    expect(expected.expectedCloses).toBe(false);
    const units = payableUnits([plates], []);
    const paid300 = view({
      lines: [plates],
      allocations: allocatePayment(units, 30000).map((a) => ({
        ...a,
        tenderId: cash.id,
      })),
      tenders: [{ ...cash, amount: 30000 }],
    });
    expect(discountClosesCheck(paid300, planDiscount(paid300, fixed))).toBe(
      true,
    );
    expect(matches(paid300, fixed, expected)).toBe(false);
  });

  it("the same plan with a different starting balance or closing outcome does not match: a payment of another line, or a table check moved to takeaway", () => {
    const taco = line(4500, 1);
    const bowl = line(12500, 1);
    const card = tender("external", 12500);
    const before = view({ lines: [taco, bowl] });
    const tacoOff = {
      scope: "line" as const,
      lineId: taco.id,
      quantity: 1,
      kind: "amount" as const,
      amount: 4500,
    };
    const expected = previewOn(before, tacoOff);
    const bowlPaid = view({
      lines: [taco, bowl],
      allocations: [
        { tenderId: card.id, lineId: bowl.id, unit: 0, amount: 12500 },
      ],
      tenders: [card],
    });
    expect(previewOn(bowlPaid, tacoOff).expectedAllocations).toEqual(
      expected.expectedAllocations,
    );
    expect(matches(bowlPaid, tacoOff, expected)).toBe(false);
    // Service change: assignService leaves orders.version alone.
    const comp = { scope: "order" as const, kind: "comp" as const };
    const atTable = {
      ...open,
      mode: "dine_in" as const,
      tableId: randomUUID(),
    };
    const tableExpected = previewOn(atTable, comp);
    expect(tableExpected.expectedCloses).toBe(false);
    expect(matches(atTable, comp, tableExpected)).toBe(true);
    expect(matches(open, comp, tableExpected)).toBe(false);
  });

  it("the comparison ignores the order of lines and the case of ids, but not which unit gets which part", () => {
    const taco = line(9000, 2);
    const cafe = line(12000, 1);
    const o = view({ lines: [taco, cafe] });
    const pct = {
      scope: "order" as const,
      kind: "percent" as const,
      percentBps: 1000,
    };
    const expected = previewOn(o, pct);
    expect(
      matches(o, pct, {
        ...expected,
        expectedAllocations: [...expected.expectedAllocations]
          .reverse()
          .map((l) => ({ ...l, lineId: l.lineId.toUpperCase() })),
      }),
    ).toBe(true);
    expect(
      matches(o, pct, {
        ...expected,
        expectedAllocations: [
          { lineId: taco.id, units: [0, 1], amounts: [400, 500] },
          { lineId: cafe.id, units: [0], amounts: [1200] },
        ],
      }),
    ).toBe(false);
  });
});

describe("Quitar descuento after a reload (DSC-R10)", () => {
  const taco = line(9000, 2);
  const discountOn = (
    units: number[],
    over: Partial<OrderDiscount> = {},
  ): OrderDiscount => ({
    id: "d1",
    scope: "line",
    lineId: taco.id,
    kind: "percent",
    percentBps: 1000,
    base: 4500 * units.length,
    amount: 450 * units.length,
    units: units.length,
    activeAmount: 450 * units.length,
    releasedAmount: 0,
    allocations: units.map((unit) => ({
      lineId: taco.id,
      unit,
      amount: 450,
      voided: false,
    })),
    reasonCode: "regular_customer",
    note: "",
    actorName: "Alex Demo",
    approverName: null,
    createdAt: "2026-10-05T12:00:00.000Z",
    reversal: null,
    ...over,
  });

  it("follows the reloaded check even when it is the same object the dialog was given (Vender)", () => {
    const chosen = discountOn([0, 1]);
    // Vender hands the reloaded order back as the dialog's `order` prop, so
    // order === initial again: only the reload flag tells.
    const fresh = view({
      lines: [taco],
      discounts: [discountOn([0, 1])],
      allocations: [{ tenderId: "t", lineId: taco.id, unit: 0, amount: 4050 }],
    });
    expect(removableAfterReload(fresh, chosen, false)).toBe(chosen);
    expect(removableAfterReload(fresh, chosen, true)).toBeNull();
  });

  it("after a reload shows the discount's current amount, or null when it was removed elsewhere", () => {
    const chosen = discountOn([0, 1]);
    // Another device voided unit 1: the discount is still removable, for less.
    const voided = discountOn([0, 1], {
      activeAmount: 450,
      releasedAmount: 450,
      allocations: [
        { lineId: taco.id, unit: 0, amount: 450, voided: false },
        { lineId: taco.id, unit: 1, amount: 450, voided: true },
      ],
    });
    const fresh = view({
      lines: [{ ...taco, voidedUnits: [1] }],
      discounts: [voided],
    });
    expect(removableAfterReload(fresh, chosen, true)?.activeAmount).toBe(450);
    const reversed = view({
      lines: [taco],
      discounts: [
        discountOn([0, 1], {
          activeAmount: 0,
          reversal: {
            at: "2026-10-05T12:05:00.000Z",
            byName: "Alex Demo",
            approverName: null,
            note: "Se aplicó por error",
            amount: 900,
          },
        }),
      ],
    });
    expect(removableAfterReload(reversed, chosen, true)).toBeNull();
    expect(
      removableAfterReload(view({ lines: [taco] }), chosen, true),
    ).toBeNull();
  });
});
