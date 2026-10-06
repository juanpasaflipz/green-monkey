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
  discountInput,
  discountInputIssue,
  discountLimitCheck,
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

  it("9. discountLimitCheck: self for managers; within/exceeds for cashier and server by percent and amount; comp is 100%", () => {
    const c = controls({ maxPercentBps: 1000, maxAmount: 5000 });
    expect(discountLimitCheck("owner", { base: 10, amount: 10 }, c)).toBe(
      "self",
    );
    expect(discountLimitCheck("manager", { base: 10, amount: 10 }, c)).toBe(
      "self",
    );
    expect(
      discountLimitCheck("cashier", { base: 20000, amount: 2000 }, c),
    ).toBe("within");
    expect(
      discountLimitCheck("cashier", { base: 20000, amount: 2001 }, c),
    ).toBe("exceeds");
    expect(
      discountLimitCheck("cashier", { base: 60000, amount: 5001 }, c),
    ).toBe("exceeds");
    expect(discountLimitCheck("cashier", { base: 4500, amount: 4500 }, c)).toBe(
      "exceeds",
    );
    expect(discountLimitCheck("server", { base: 20000, amount: 1 }, c)).toBe(
      "exceeds",
    );
    expect(discountLimitCheck("kitchen", { base: 20000, amount: 1 }, c)).toBe(
      "exceeds",
    );
    const comp = controls({ maxPercentBps: 10000, maxAmount: 4500 });
    expect(
      discountLimitCheck("cashier", { base: 4500, amount: 4500 }, comp),
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
    };
    const p = discountInput.parse(base);
    expect(p.note).toBe("");
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
});
