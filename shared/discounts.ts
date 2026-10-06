/**
 * Discounts, courtesies, item and terminal refunds, and drawer controls (028).
 * Pure: the server and the client run the same planning code, so a dialog's
 * preview and the recorded result are identical (docs/DISCOUNTS.md).
 */
import { z } from "zod";
import {
  allocate,
  discount,
  id,
  money,
  sum,
  DomainError,
  type Order,
  type PricedLine,
} from "./domain.js";
import type { PayableUnit } from "./settlement.js";
import type { RefundTaxScope } from "./fiscal.js";
import { holdsTable } from "./service.js";

export const DISCOUNT_REASONS = [
  "courtesy",
  "complaint",
  "quality",
  "staff_meal",
  "senior_inapam",
  "promotion",
  "regular_customer",
  "other",
] as const;
export const REFUND_REASONS = [
  "customer_cancelled",
  "quality",
  "wrong_item",
  "long_wait",
  "charge_error",
  "duplicate_terminal_charge",
  "other",
] as const;
export type DiscountReason = (typeof DISCOUNT_REASONS)[number];
export type RefundReason = (typeof REFUND_REASONS)[number];
export const PERCENT_CHIPS_BPS = [500, 1000, 1500, 2000, 5000] as const;
export type StaffRole = "cashier" | "server";
export type DiscountKind = "percent" | "amount" | "comp";
export type DiscountScope = "order" | "line";

// Access's union ({employeeId,secret} | legacy {login,secret}), re-declared
// structurally so the shared module stays free of server imports; the server
// validates it again with voids.ts approvalInput (verifyApproval).
const approvalShape = z.union([
  z.object({ employeeId: id, secret: z.string().min(4).max(200) }).strict(),
  z
    .object({
      login: z.string().min(1).max(100),
      secret: z.string().min(4).max(200),
    })
    .strict(),
]);

export const discountInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(1),
    scope: z.enum(["order", "line"]),
    lineId: id.optional(),
    quantity: z.number().int().min(1).max(99).optional(),
    kind: z.enum(["percent", "amount", "comp"]),
    percentBps: z.number().int().min(1).max(10000).optional(),
    amount: money.optional(),
    reasonCode: z.enum(DISCOUNT_REASONS),
    note: z.string().trim().max(300).default(""),
    // §2.2 (DSC-R13): what the preview showed (discountExpectation). Payments
    // and service changes do not bump orders.version, so expectedVersion alone
    // cannot tell that the check moved on before the confirm.
    expectedAmount: money.refine((n) => n > 0),
    expectedBase: money.refine((n) => n > 0),
    expectedAllocations: z
      .array(
        z
          .object({
            lineId: id,
            units: z.array(z.number().int().min(0).max(999)).min(1).max(99),
            amounts: z.array(money).min(1).max(99),
          })
          .strict()
          .refine((l) => l.units.length === l.amounts.length),
      )
      .min(1)
      .max(1000),
    expectedDue: money,
    expectedCloses: z.boolean(),
    approval: approvalShape.optional(),
  })
  .strict();
export type DiscountInput = z.infer<typeof discountInput>;

/** Cross-field rules, thrown by the server as DomainError(code, 400); the client shows them inline. */
export function discountInputIssue(
  p: Pick<
    DiscountInput,
    | "scope"
    | "lineId"
    | "quantity"
    | "kind"
    | "percentBps"
    | "amount"
    | "reasonCode"
    | "note"
  >,
): string | null {
  if (p.scope === "line" && !p.lineId) return "invalid_input";
  if (
    p.scope === "order" &&
    (p.lineId !== undefined || p.quantity !== undefined)
  )
    return "invalid_input";
  if (
    p.kind === "percent" &&
    (p.percentBps === undefined || p.amount !== undefined)
  )
    return "discount_invalid";
  if (
    p.kind === "amount" &&
    (p.amount === undefined || p.amount <= 0 || p.percentBps !== undefined)
  )
    return "discount_invalid";
  if (
    p.kind === "comp" &&
    (p.amount !== undefined || p.percentBps !== undefined)
  )
    return "discount_invalid";
  if (p.reasonCode === "other" && (p.note ?? "").trim().length < 3)
    return "discount_note_required";
  return null;
}

export const discountReverseInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(1),
    note: z.string().trim().min(3).max(300),
    approval: approvalShape.optional(),
  })
  .strict();

const externalRefund = z
  .object({
    tenderId: id,
    reference: z.string().trim().min(1).max(120),
    confirmed: z.literal(true),
  })
  .strict();
export const refundInput = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("items"),
      operationId: id,
      lines: z
        .array(
          z
            .object({ lineId: id, quantity: z.number().int().min(1).max(99) })
            .strict(),
        )
        .min(1)
        .max(100),
      expectedAmount: money.refine((n) => n > 0),
      // §2.4 rule 2 (DSC-R9): the plan the preview showed, per line the units
      // it refunds (itemRefundExpectation), and the order's refunded total.
      expectedUnits: z
        .array(
          z
            .object({
              lineId: id,
              units: z.array(z.number().int().min(0).max(999)).min(1).max(99),
            })
            .strict(),
        )
        .min(1)
        .max(100),
      expectedRefunded: money,
      restock: z.boolean(),
      reasonCode: z.enum(REFUND_REASONS),
      note: z.string().trim().max(300).default(""),
      external: z.array(externalRefund).max(20).default([]),
      approval: approvalShape.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("amount"),
      operationId: id,
      tenderId: id,
      amount: money.refine((n) => n > 0),
      // §2.4 rule 2 (DSC-R9): the order's refunded total the preview saw.
      expectedRefunded: money,
      reasonCode: z.enum(REFUND_REASONS),
      note: z.string().trim().max(300).default(""),
      external: z.array(externalRefund).max(1).default([]),
      approval: approvalShape.optional(),
    })
    .strict(),
]);
export type RefundInput = z.infer<typeof refundInput>;

const limit = z
  .object({
    maxPercentBps: z.number().int().min(0).max(10000),
    maxAmount: money,
  })
  .strict();
export const moneyControlsInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(0), // 0 = no row yet
    limits: z.object({ cashier: limit, server: limit }).strict(),
    blindClose: z.boolean(),
    expectedRoles: z.array(z.enum(["manager", "cashier", "server"])).max(3),
    closeRoles: z.array(z.enum(["cashier", "server"])).max(2),
  })
  .strict();
export const cashCloseInput = z
  .object({
    operationId: id,
    counted: money,
    reason: z.string().max(300),
    // .optional() without a default: a legacy body parses to the same object,
    // so its once() fingerprint is unchanged (old bundles during a deploy).
    externalReported: money.nullable().optional(),
  })
  .strict();
export const cashReviewInput = z
  .object({ operationId: id, note: z.string().trim().min(3).max(300) })
  .strict();

export type MoneyControls = {
  limits: Record<StaffRole, { maxPercentBps: number; maxAmount: number }>;
  blindClose: boolean;
  expectedRoles: ("manager" | "cashier" | "server")[];
  closeRoles: StaffRole[];
};
export const DEFAULT_MONEY_CONTROLS: MoneyControls = {
  limits: {
    cashier: { maxPercentBps: 0, maxAmount: 0 },
    server: { maxPercentBps: 0, maxAmount: 0 },
  },
  blindClose: true,
  expectedRoles: ["manager"],
  closeRoles: [],
};
export type MoneyControlsView = MoneyControls & {
  version: number;
  canEdit: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
  you: {
    canSeeExpected: boolean;
    canClose: boolean;
    limit: { maxPercentBps: number; maxAmount: number } | "unlimited";
  };
};
/** The owner always sees expected cash; other roles only when the controls say so. */
export const canSeeExpected = (role: string, c: MoneyControls) =>
  role === "owner" || (c.expectedRoles as string[]).includes(role);
/** Owner and manager always close a drawer; cashier and server only when enabled. */
export const canCloseDrawer = (role: string, c: MoneyControls) =>
  role === "owner" ||
  role === "manager" ||
  (c.closeRoles as string[]).includes(role);

export type UnitDiscount = {
  lineId: string;
  unit: number;
  amount: number;
  scope: DiscountScope;
  discountId: string;
};
export type DiscountPlan = {
  base: number;
  amount: number;
  units: number;
  allocations: { lineId: string; unit: number; amount: number }[];
};
export type DiscountRequest = {
  scope: DiscountScope;
  lineId?: string;
  quantity?: number;
  kind: DiscountKind;
  percentBps?: number;
  amount?: number;
};

/**
 * Pure planning of one discount. `order.paymentUnits` must come from getOrder
 * (voided units removed, active discounts applied). Targets only units with a
 * balance due: paid money is corrected by refunds, never by discounts.
 */
export function planDiscount(
  order: Pick<Order, "paymentUnits" | "discounts">,
  r: DiscountRequest,
): DiscountPlan {
  const units = order.paymentUnits ?? [];
  let targets: PayableUnit[];
  if (r.scope === "order") {
    if ((order.discounts ?? []).some((d) => d.scope === "order" && !d.reversal))
      throw new DomainError("discount_already_applied", 409);
    targets = units.filter((u) => u.due > 0);
  } else {
    const eligible = units
      .filter((u) => u.lineId === r.lineId && u.due > 0 && !u.lineDiscounted)
      .sort((a, b) => a.unit - b.unit);
    const n = r.quantity ?? eligible.length;
    if (n === 0 || n > eligible.length)
      throw new DomainError("discount_units_unavailable", 409);
    targets = eligible.slice(0, n);
  }
  if (!targets.length) throw new DomainError("discount_nothing_due", 409);
  const base = sum(targets.map((t) => t.due));
  let amount: number;
  if (r.kind === "percent") {
    if (
      r.percentBps === undefined ||
      !Number.isInteger(r.percentBps) ||
      r.percentBps < 1 ||
      r.percentBps > 10000
    )
      throw new DomainError("discount_invalid");
    amount = discount(base, r.percentBps);
  } else if (r.kind === "amount") {
    if (
      r.amount === undefined ||
      !Number.isSafeInteger(r.amount) ||
      r.amount < 1
    )
      throw new DomainError("discount_invalid");
    if (r.amount > base) throw new DomainError("discount_exceeds_due", 409);
    amount = r.amount;
  } else amount = base;
  if (amount === 0) throw new DomainError("discount_too_small");
  const parts = allocate(
    amount,
    targets.map((t) => t.due),
  );
  return {
    base,
    amount,
    units: targets.length,
    allocations: targets
      .map((t, i) => ({ lineId: t.lineId, unit: t.unit, amount: parts[i] }))
      .filter((a) => a.amount > 0),
  };
}

/** "self" for owner/manager; otherwise whether the plan fits the role's limit (a comp is 100 %). */
export function discountLimitCheck(
  role: string,
  plan: Pick<DiscountPlan, "base" | "amount">,
  c: MoneyControls,
): "self" | "within" | "exceeds" {
  if (role === "owner" || role === "manager") return "self";
  if (role !== "cashier" && role !== "server") return "exceeds";
  const lim = c.limits[role];
  return plan.amount * 10000 <= plan.base * lim.maxPercentBps &&
    plan.amount <= lim.maxAmount
    ? "within"
    : "exceeds";
}

/** Unpaid units of a line in the order the server voids them: undiscounted first, then highest index. */
export function voidCandidates(
  order: Pick<Order, "paymentUnits">,
  lineId: string,
): PayableUnit[] {
  return (order.paymentUnits ?? [])
    .filter((u) => u.lineId === lineId && u.paid === 0)
    .sort(
      (a, b) =>
        Number(a.discount > 0) - Number(b.discount > 0) || b.unit - a.unit,
    );
}

/** "12.5" → 1250. Rejects 0, more than 100 and more than two decimals. */
export function percentToBps(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(text ?? "").trim());
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bps >= 1 && bps <= 10000 ? bps : null;
}
/** 1250 → "12.5 %" (es) / "12.5%" (en). */
export function formatPercentBps(bps: number, locale: "es" | "en"): string {
  const whole = Math.floor(bps / 100);
  const cents = bps % 100;
  const text = cents
    ? `${whole}.${String(cents).padStart(2, "0").replace(/0$/, "")}`
    : String(whole);
  return locale === "es" ? `${text} %` : `${text}%`;
}

/** Balance still due on a check (never negative). */
export const balanceDue = (o: Pick<Order, "total" | "paid">) =>
  Math.max(0, o.total - o.paid);
/** Amount refunds only on checks with no balance due (Σ tenders ≥ orders.total). */
export const amountRefundAllowed = (o: Pick<Order, "total" | "paid">) =>
  o.paid >= o.total;
/**
 * True when applying `plan` brings the balance to 0 on a check that does not
 * hold a table: the check closes at once and the discount becomes final.
 */
export function discountClosesCheck(
  o: Pick<Order, "total" | "paid" | "mode" | "tableId" | "channel">,
  plan: Pick<DiscountPlan, "amount">,
): boolean {
  return (
    balanceDue(o) - plan.amount === 0 &&
    !holdsTable({
      mode: o.mode,
      tableId: o.tableId,
      channel: o.channel ?? "pos",
    })
  );
}

type DiscountCheck = Pick<
  Order,
  "total" | "paid" | "mode" | "tableId" | "channel"
>;
/**
 * What a discount preview showed, as the client sends it (§2.2, DSC-R13): the
 * plan (amount, base and, per line, the units and the part of each), the
 * balance due it started from and whether it warned that the check closes.
 */
export function discountExpectation(o: DiscountCheck, plan: DiscountPlan) {
  const lines: { lineId: string; units: number[]; amounts: number[] }[] = [];
  for (const a of plan.allocations) {
    let l = lines.find((x) => x.lineId === a.lineId);
    if (!l) lines.push((l = { lineId: a.lineId, units: [], amounts: [] }));
    l.units.push(a.unit);
    l.amounts.push(a.amount);
  }
  return {
    expectedAmount: plan.amount,
    expectedBase: plan.base,
    expectedAllocations: lines,
    expectedDue: balanceDue(o),
    expectedCloses: discountClosesCheck(o, plan),
  };
}
export type DiscountExpectation = ReturnType<typeof discountExpectation>;

/**
 * Whether the server's plan, on the check as it is under the order lock, is
 * the one the client previewed (DSC-R13): the same amount, base and part per
 * unit, the same starting balance and the same closing outcome. A payment on
 * another device (or a service change, which may release the table) leaves
 * orders.version alone but changes one of them: a whole-check comp previewed at
 * −$400 would otherwise record −$300 after one plate was paid elsewhere.
 */
export function discountPlanMatches(
  o: DiscountCheck,
  plan: DiscountPlan,
  expected: DiscountExpectation,
): boolean {
  const now = discountExpectation(o, plan);
  const key = (e: DiscountExpectation) =>
    e.expectedAllocations
      .flatMap((l) =>
        l.units.map((u, i) => `${l.lineId.toLowerCase()}:${u}=${l.amounts[i]}`),
      )
      .sort()
      .join("|");
  return (
    now.expectedAmount === expected.expectedAmount &&
    now.expectedBase === expected.expectedBase &&
    now.expectedDue === expected.expectedDue &&
    now.expectedCloses === expected.expectedCloses &&
    key(now) === key(expected)
  );
}

// ---- order adjustments (getOrders' adjustmentRows member) -----------------

export type OrderDiscount = {
  id: string;
  scope: DiscountScope;
  lineId: string | null;
  kind: DiscountKind;
  percentBps: number | null;
  base: number;
  amount: number;
  units: number;
  /** Allocations on non-voided units; 0 when reversed. */
  activeAmount: number;
  /** Allocations on units voided later ("Liberado por anulación"). */
  releasedAmount: number;
  allocations: {
    lineId: string;
    unit: number;
    amount: number;
    voided: boolean;
  }[];
  reasonCode: string;
  note: string;
  actorName: string;
  approverName: string | null;
  createdAt: string;
  reversal: null | {
    at: string;
    byName: string;
    approverName: string | null;
    note: string;
    amount: number;
  };
};
export type RefundLineView = {
  id: string;
  lineId: string;
  units: number[];
  amount: number;
  restocked: boolean;
  preparationState: string;
  kitchenPending: boolean;
};
export type RefundRowView = {
  refundId: string;
  tenderId: string;
  method: "cash" | "external";
  amount: number;
  reference: string | null;
};
export type RefundBatchView = {
  id: string;
  mode: "amount" | "items";
  amount: number;
  cashAmount: number;
  externalAmount: number;
  reasonCode: string;
  note: string;
  restock: boolean;
  actorName: string;
  approverName: string;
  createdAt: string;
  businessDate: string | null;
  legacy: boolean;
  rows: RefundRowView[];
  lines: RefundLineView[];
};
export type RefundedUnit = {
  refundId: string;
  tenderId: string;
  lineId: string;
  unit: number;
  amount: number;
};
export type TenderAllocation = {
  tenderId: string;
  lineId: string;
  unit: number;
  amount: number;
};

/** One order's raw adjustment rows, as adjustmentRows reads them (JSON from one statement). */
export type AdjustmentRow = {
  discounts: {
    id: string;
    scope: DiscountScope;
    lineId: string | null;
    kind: DiscountKind;
    percentBps: number | null;
    base: number;
    amount: number;
    units: number;
    reasonCode: string;
    note: string;
    actorName: string;
    approverName: string | null;
    createdAt: string;
    reversedAt: string | null;
    reversedByName: string | null;
    reversalApproverName: string | null;
    reversalNote: string | null;
    reversedAmount: number | null;
    allocations: { lineId: string; unit: number; amount: number }[];
  }[];
  refunds: {
    refundId: string;
    tenderId: string;
    batchId: string | null;
    method: "cash" | "external";
    amount: number;
    reference: string | null;
    reason: string;
    createdAt: string;
    actorName: string;
  }[];
  batches: {
    id: string;
    mode: "amount" | "items";
    amount: number;
    cashAmount: number;
    externalAmount: number;
    reasonCode: string;
    note: string;
    restock: boolean;
    actorName: string;
    approverName: string;
    createdAt: string;
    businessDate: string | null;
  }[];
  refundUnits: RefundedUnit[];
  refundLines: (RefundLineView & { batchId: string })[];
};
export type OrderAdjustments = {
  discounts: OrderDiscount[];
  unitDiscounts: UnitDiscount[];
  lineDiscounts: Record<string, number>;
  discountTotal: number;
  refundBatches: RefundBatchView[];
  refundedUnits: RefundedUnit[];
};

const byTime = (
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
) =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Composes the discounts and refunds of one order. Active amounts exclude
 * reversed discounts and voided units; refunds without a batch (before 028)
 * become one synthetic legacy batch each.
 */
export function composeOrderAdjustments(
  row: AdjustmentRow | undefined,
  input: { lines: Pick<PricedLine, "id" | "voidedUnits">[] },
): OrderAdjustments {
  const voided = new Set(
    input.lines.flatMap((l) =>
      (l.voidedUnits ?? []).map((u) => `${l.id}:${u}`),
    ),
  );
  const discounts: OrderDiscount[] = [];
  const unitDiscounts: UnitDiscount[] = [];
  for (const d of row?.discounts ?? []) {
    const allocations = d.allocations.map((a) => ({
      ...a,
      voided: voided.has(`${a.lineId}:${a.unit}`),
    }));
    const reversed = d.reversedAt !== null;
    const live = allocations.filter((a) => !a.voided);
    if (!reversed)
      for (const a of live)
        unitDiscounts.push({
          lineId: a.lineId,
          unit: a.unit,
          amount: a.amount,
          scope: d.scope,
          discountId: d.id,
        });
    discounts.push({
      id: d.id,
      scope: d.scope,
      lineId: d.lineId,
      kind: d.kind,
      percentBps: d.percentBps,
      base: d.base,
      amount: d.amount,
      units: d.units,
      activeAmount: reversed ? 0 : sum(live.map((a) => a.amount)),
      releasedAmount: reversed
        ? d.amount - (d.reversedAmount ?? 0)
        : sum(allocations.filter((a) => a.voided).map((a) => a.amount)),
      allocations,
      reasonCode: d.reasonCode,
      note: d.note,
      actorName: d.actorName,
      approverName: d.approverName,
      createdAt: d.createdAt,
      reversal: reversed
        ? {
            at: d.reversedAt!,
            byName: d.reversedByName ?? "",
            approverName: d.reversalApproverName,
            note: d.reversalNote ?? "",
            amount: d.reversedAmount ?? 0,
          }
        : null,
    });
  }
  discounts.sort(byTime);
  const lineDiscounts: Record<string, number> = {};
  for (const u of unitDiscounts)
    lineDiscounts[u.lineId] = (lineDiscounts[u.lineId] ?? 0) + u.amount;
  const batches: RefundBatchView[] = (row?.batches ?? []).map((b) => ({
    ...b,
    legacy: false,
    rows: (row?.refunds ?? [])
      .filter((r) => r.batchId === b.id)
      .map((r) => ({
        refundId: r.refundId,
        tenderId: r.tenderId,
        method: r.method,
        amount: r.amount,
        reference: r.reference,
      })),
    lines: (row?.refundLines ?? [])
      .filter((l) => l.batchId === b.id)
      .map(({ batchId: _batch, ...l }) => ({
        ...l,
        units: [...l.units].sort((x, y) => x - y),
      })),
  }));
  for (const r of row?.refunds ?? [])
    if (!r.batchId)
      batches.push({
        id: r.refundId,
        mode: "amount",
        amount: r.amount,
        cashAmount: r.method === "cash" ? r.amount : 0,
        externalAmount: r.method === "external" ? r.amount : 0,
        reasonCode: "other",
        note: r.reason,
        restock: false,
        actorName: r.actorName,
        approverName: r.actorName,
        createdAt: r.createdAt,
        businessDate: null,
        legacy: true,
        rows: [
          {
            refundId: r.refundId,
            tenderId: r.tenderId,
            method: r.method,
            amount: r.amount,
            reference: r.reference,
          },
        ],
        lines: [],
      });
  batches.sort(byTime);
  return {
    discounts,
    unitDiscounts,
    lineDiscounts,
    discountTotal: sum(Object.values(lineDiscounts)),
    refundBatches: batches,
    refundedUnits: row?.refundUnits ?? [],
  };
}

// ---- item refunds ------------------------------------------------------------

export type ItemRefundPlan = {
  total: number;
  units: { lineId: string; unit: number; tenderId: string; amount: number }[];
  byTender: {
    tenderId: string;
    method: "cash" | "external";
    amount: number;
    reference: string | null;
  }[];
  lines: { lineId: string; units: number[]; amount: number }[];
};
type RefundableOrder = Pick<
  Order,
  "paymentUnits" | "tenderAllocations" | "refundedUnits" | "tenders"
>;

/** What each tender still holds of one unit: allocation minus earlier unit refunds. */
function unitPortions(order: RefundableOrder, lineId: string, unit: number) {
  const refunded = (tenderId: string) =>
    sum(
      (order.refundedUnits ?? [])
        .filter(
          (r) =>
            r.tenderId === tenderId && r.lineId === lineId && r.unit === unit,
        )
        .map((r) => r.amount),
    );
  const tenderOrder = new Map(
    (order.tenders ?? []).map((t: { id: string }, i: number) => [t.id, i]),
  );
  return (order.tenderAllocations ?? [])
    .filter((a) => a.lineId === lineId && a.unit === unit)
    .map((a) => ({
      tenderId: a.tenderId,
      amount: a.amount - refunded(a.tenderId),
    }))
    .filter((p) => p.amount > 0)
    .sort(
      (a, b) =>
        (tenderOrder.get(a.tenderId) ?? 0) - (tenderOrder.get(b.tenderId) ?? 0),
    );
}

/**
 * Plans an item refund: per line the highest-index fully paid units that are
 * not refunded yet, each returned in full to the tenders that paid it, in
 * tender order. Requires getOrder's tenderAllocations and refundedUnits.
 */
export function planItemRefund(
  order: RefundableOrder,
  request: { lineId: string; quantity: number }[],
): ItemRefundPlan {
  if (new Set(request.map((r) => r.lineId)).size !== request.length)
    throw new DomainError("invalid_input");
  const units: ItemRefundPlan["units"] = [];
  const lines: ItemRefundPlan["lines"] = [];
  for (const r of request) {
    const candidates = (order.paymentUnits ?? [])
      .filter((u) => u.lineId === r.lineId && u.due === 0 && u.paid > 0)
      .sort((a, b) => b.unit - a.unit)
      .map((u) => ({
        unit: u.unit,
        portions: unitPortions(order, r.lineId, u.unit),
      }))
      .filter((c) => c.portions.length > 0);
    if (r.quantity < 1 || candidates.length < r.quantity)
      throw new DomainError("refund_units_unavailable", 409);
    const chosen = candidates.slice(0, r.quantity);
    let amount = 0;
    for (const c of chosen)
      for (const p of c.portions) {
        units.push({ lineId: r.lineId, unit: c.unit, ...p });
        amount += p.amount;
      }
    lines.push({
      lineId: r.lineId,
      units: chosen.map((c) => c.unit).sort((a, b) => a - b),
      amount,
    });
  }
  const byTender: ItemRefundPlan["byTender"] = [];
  for (const t of order.tenders ?? []) {
    const amount = sum(
      units.filter((u) => u.tenderId === t.id).map((u) => u.amount),
    );
    if (!amount) continue;
    if (amount > t.amount - (t.refunded ?? 0))
      throw new DomainError("refund_exceeds", 409);
    byTender.push({
      tenderId: t.id,
      method: t.method,
      amount,
      reference: t.external_reference ?? null,
    });
  }
  if (sum(byTender.map((t) => t.amount)) !== sum(units.map((u) => u.amount)))
    throw new DomainError("refund_units_unavailable", 409);
  return { total: sum(units.map((u) => u.amount)), units, byTender, lines };
}

/**
 * The plan an item-refund preview showed, as the client sends it (§2.4 server
 * rule 2): its total and, per line, the units it refunds.
 */
export function itemRefundExpectation(
  plan: Pick<ItemRefundPlan, "total" | "lines">,
) {
  return {
    expectedAmount: plan.total,
    expectedUnits: plan.lines.map((l) => ({
      lineId: l.lineId,
      units: [...l.units],
    })),
  };
}

/**
 * Whether the server's item-refund plan is the one the client previewed: the
 * same total and, per line, the same units (DSC-R9). Equal totals are not
 * enough: when another device refunded (or paid) an identical unit in
 * between, the plan moves to the next unit at the same price.
 */
export function itemRefundPlanMatches(
  plan: Pick<ItemRefundPlan, "total" | "lines">,
  expected: ReturnType<typeof itemRefundExpectation>,
): boolean {
  if (plan.total !== expected.expectedAmount) return false;
  const key = (units: number[]) => [...units].sort((a, b) => a - b).join(",");
  const want = new Map(
    expected.expectedUnits.map((l) => [l.lineId.toLowerCase(), key(l.units)]),
  );
  return (
    want.size === expected.expectedUnits.length &&
    want.size === plan.lines.length &&
    plan.lines.every((l) => want.get(l.lineId.toLowerCase()) === key(l.units))
  );
}

/** Per line, the largest quantity for which planItemRefund succeeds. */
export function refundableQuantities(
  order: RefundableOrder,
): Record<string, number> {
  const out: Record<string, number> = {};
  const lineIds = [...new Set((order.paymentUnits ?? []).map((u) => u.lineId))];
  for (const lineId of lineIds) {
    const max = (order.paymentUnits ?? []).filter(
      (u) => u.lineId === lineId && u.due === 0 && u.paid > 0,
    ).length;
    for (let q = max; q > 0; q--) {
      try {
        planItemRefund(order, [{ lineId, quantity: q }]);
        out[lineId] = q;
        break;
      } catch {
        /* try a smaller quantity */
      }
    }
  }
  return out;
}

/**
 * Fiscal scope per refund money row (= per tender), the binding recordRefundTax
 * contract (RefundTaxScope from shared/fiscal.ts): for each tender and line, units ascending and gross = Σ amount of
 * that tender's unit rows on that line (= Σ refund_units.amount of that refund
 * row and line). Σ gross of a tender = that tender's portion. Lines in
 * first-seen order.
 */
export function refundTaxScopes(
  units: { tenderId: string; lineId: string; unit: number; amount: number }[],
): Record<string, RefundTaxScope[]> {
  const out: Record<string, RefundTaxScope[]> = {};
  for (const u of units) {
    const scopes = (out[u.tenderId] ??= []);
    let scope = scopes.find((s) => s.lineId === u.lineId);
    if (!scope) {
      scope = { lineId: u.lineId, units: [], gross: 0 };
      scopes.push(scope);
    }
    scope.units.push(u.unit);
    scope.gross += u.amount;
  }
  for (const scopes of Object.values(out))
    for (const s of scopes) s.units.sort((a, b) => a - b);
  return out;
}
