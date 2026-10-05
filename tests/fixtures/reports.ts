// Helpers for the reports unit tests: a seeded random "sales world" (orders with lines, voids,
// discounts and comps, recovery orders, tenders collected on the sale day or later, offline late
// syncs, refunds on later days, paid-outs, fiscal tickets) and a reference aggregator that turns it
// into the S1–S5 per-day aggregates exactly as the §4.5 SQL defines them. The ground truth used by
// the property tests is computed separately, straight from the world's records.
import {
  addDays,
  rangeDates,
  type CollectionDayAggregate,
  type DateRange,
  type FiscalTotals,
  type LineDayAggregate,
  type PaidOutDayAggregate,
  type RefundDayAggregate,
  type RestockDayAggregate,
  type SalesDayAggregate,
  type TenderMethod,
} from "../../shared/reports";
import { rng } from "./fiscal";

type Random = ReturnType<typeof rng>;

export type WorldLine = {
  quantity: number;
  unitPrice: number;
  /** Unit cost snapshot (menu 025); null on legacy lines. */
  cost: number | null;
  voidedUnits: number;
  /** Voided units not returned to stock. */
  wasteUnits: number;
  /** Active discount allocation per remaining unit. */
  unitDiscounts: number[];
  comp: boolean;
};
export type WorldTender = {
  id: number;
  method: TenderMethod;
  amount: number;
  tip: number;
  /** Collection date (the sale day for offline-synced tenders). */
  collectionDate: string;
  /** Business date of created_at (later than collectionDate for late syncs). */
  recordedDate: string;
};
export type WorldRefund = {
  tenderId: number;
  method: TenderMethod;
  amount: number;
  date: string;
  /** created_at ≥ fiscal_epoch() (legacy pre-fiscal refunds are false). */
  afterEpoch: boolean;
  restockedCost: number;
};
export type WorldOrder = {
  date: string;
  state: "open" | "paid" | "cancelled" | "recovery_pending";
  channel: "pos" | "qr" | "offline";
  lines: WorldLine[];
  /** Recovery orders have no lines: their total is set directly. */
  recoveryTotal: number;
  ticketed: boolean;
  tenders: WorldTender[];
};
export type World = {
  orders: WorldOrder[];
  refunds: WorldRefund[];
  paidOuts: { date: string; amount: number }[];
  fiscal: boolean;
};

export const lineGross = (l: WorldLine) =>
  (l.quantity - l.voidedUnits) * l.unitPrice;
export const lineDiscount = (l: WorldLine) =>
  l.unitDiscounts.reduce((a, b) => a + b, 0);
export const orderDiscount = (o: WorldOrder) =>
  o.lines.reduce((a, l) => a + lineDiscount(l), 0);
export const orderTotal = (o: WorldOrder) =>
  o.state === "recovery_pending"
    ? o.recoveryTotal
    : o.lines.reduce((a, l) => a + lineGross(l) - lineDiscount(l), 0);
export const orderPaid = (o: WorldOrder) =>
  o.tenders.reduce((a, t) => a + t.amount, 0);

function randomLine(random: Random, cancelled: boolean): WorldLine {
  const quantity = random.int(1, 4);
  const unitPrice = random.pick([0, random.int(1, 99), random.int(100, 9999)]);
  const voidedUnits = cancelled
    ? quantity
    : random.next() < 0.2
      ? random.int(1, quantity)
      : 0;
  const unitDiscounts = Array.from({ length: quantity - voidedUnits }, () =>
    random.next() < 0.25 ? random.int(0, unitPrice) : 0,
  );
  return {
    quantity,
    unitPrice,
    cost:
      random.next() < 0.15 ? null : random.int(0, Math.max(0, unitPrice - 1)),
    voidedUnits,
    wasteUnits: random.int(0, voidedUnits),
    unitDiscounts,
    comp: random.next() < 0.3,
  };
}

/** A random world over `range` widened by two days on each side. */
export function randomWorld(
  random: Random,
  range: DateRange,
  opts: { fiscal?: boolean } = {},
): World {
  const fiscal = opts.fiscal ?? random.next() < 0.85;
  const dates = rangeDates({
    from: addDays(range.from, -2),
    to: addDays(range.to, 2),
  });
  const orders: WorldOrder[] = [];
  let tenderId = 0;
  for (let n = random.int(0, 40); n > 0; n--) {
    const date = random.pick(dates);
    const roll = random.next();
    const state =
      roll < 0.07 ? "cancelled" : roll < 0.15 ? "recovery_pending" : "open";
    const channel =
      state === "recovery_pending"
        ? "offline"
        : random.pick(["pos", "pos", "qr", "offline"] as const);
    const order: WorldOrder = {
      date,
      state,
      channel,
      lines:
        state === "recovery_pending"
          ? []
          : Array.from({ length: random.int(1, 4) }, () =>
              randomLine(random, state === "cancelled"),
            ),
      recoveryTotal: state === "recovery_pending" ? random.int(1, 50_000) : 0,
      ticketed: false,
      tenders: [],
    };
    const total = orderTotal(order);
    const pay = random.next();
    const paid =
      total === 0
        ? 0
        : pay < 0.7
          ? total
          : pay < 0.85
            ? random.int(1, total)
            : 0;
    const parts =
      paid > 1 && random.next() < 0.4 ? [random.int(1, paid - 1)] : [];
    if (paid > 0) parts.push(paid - parts.reduce((a, b) => a + b, 0));
    for (const amount of parts) {
      const late = channel === "offline" && random.next() < 0.5;
      const nextDay =
        state !== "recovery_pending" &&
        channel !== "offline" &&
        random.next() < 0.2;
      const collectionDate = nextDay ? addDays(date, 1) : date;
      order.tenders.push({
        id: ++tenderId,
        method: random.pick(["cash", "external"] as const),
        amount,
        tip: random.next() < 0.4 ? random.int(0, 500) : 0,
        collectionDate,
        recordedDate: late ? addDays(collectionDate, 1) : collectionDate,
      });
    }
    if (state === "open" && paid === total && total > 0) order.state = "paid";
    order.ticketed =
      fiscal && total > 0 && paid === total && random.next() < 0.9;
    orders.push(order);
  }
  const refunds: WorldRefund[] = [];
  for (const o of orders)
    for (const t of o.tenders)
      if (random.next() < 0.15)
        refunds.push({
          tenderId: t.id,
          method: t.method,
          amount: random.int(1, t.amount),
          date: addDays(t.collectionDate, random.int(0, 2)),
          afterEpoch: random.next() < 0.95,
          restockedCost: random.next() < 0.5 ? random.int(0, 2_000) : 0,
        });
  const paidOuts = dates.flatMap((date) =>
    Array.from({ length: random.int(0, 2) }, () => ({
      date,
      amount: random.int(100, 5_000),
    })),
  );
  return { orders, refunds, paidOuts, fiscal };
}

const within = (range: DateRange, date: string) =>
  date >= range.from && date <= range.to;

/** The S1–S5 aggregates of a world for `range`, as the §4.5 statements compute them. */
export function aggregateWorld(world: World, range: DateRange) {
  const orders = world.orders.filter((o) => within(range, o.date));
  const byDate = <T>(
    items: T[],
    key: (item: T) => string,
    build: (date: string, rows: T[]) => object,
  ) => {
    const groups = new Map<string, T[]>();
    for (const item of items) {
      const k = key(item);
      groups.set(k, [...(groups.get(k) ?? []), item]);
    }
    return [...groups].map(([k, rows]) => build(k, rows));
  };
  const sum = <T>(rows: T[], f: (r: T) => number) =>
    rows.reduce((a, r) => a + f(r), 0);
  const tips = (o: WorldOrder) => sum(o.tenders, (t) => t.tip);
  const recovery = (o: WorldOrder) => o.state === "recovery_pending";

  const sales = byDate(
    orders,
    (o) => o.date,
    (date, rows): SalesDayAggregate => ({
      date,
      orders: rows.filter((o) => orderTotal(o) > 0).length,
      cancelled: rows.filter((o) => o.state === "cancelled").length,
      recoveryCount: rows.filter(recovery).length,
      recoveryTotal: sum(rows.filter(recovery), orderTotal),
      ticketedRecoveryGross: sum(
        rows.filter((o) => recovery(o) && o.ticketed),
        (o) => orderTotal(o) + orderDiscount(o),
      ),
      discounts: sum(rows, orderDiscount),
      total: sum(rows, orderTotal),
      paid: sum(rows, orderPaid),
      tips: sum(rows, tips),
      openChecks: rows.filter((o) => orderTotal(o) > orderPaid(o)).length,
      overpaid: rows.filter((o) => orderPaid(o) > orderTotal(o)).length,
      ticketed: rows.filter((o) => o.ticketed).length,
      ticketedGross: sum(
        rows.filter((o) => o.ticketed),
        orderTotal,
      ),
      ticketedOrderTotal: sum(
        rows.filter((o) => o.ticketed),
        orderTotal,
      ),
      unticketedOpen: sum(
        rows.filter((o) => !o.ticketed && orderTotal(o) > orderPaid(o)),
        orderTotal,
      ),
      unticketedPaid: sum(
        rows.filter(
          (o) =>
            !o.ticketed && orderTotal(o) > 0 && orderTotal(o) <= orderPaid(o),
        ),
        orderTotal,
      ),
      offlineCount: rows.filter(
        (o) => o.channel === "offline" && orderTotal(o) > 0,
      ).length,
      offlineTotal: sum(
        rows.filter((o) => o.channel === "offline"),
        orderTotal,
      ),
      offlineTips: sum(
        rows.filter((o) => o.channel === "offline"),
        tips,
      ),
    }),
  ) as SalesDayAggregate[];

  const lineFacts = orders.flatMap((o) => o.lines.map((l) => ({ o, l })));
  const lines = byDate(
    lineFacts,
    (x) => x.o.date,
    (date, rows): LineDayAggregate => {
      const costed = rows.filter((x) => x.l.cost !== null);
      const ticketed = rows.filter((x) => x.o.ticketed);
      const remainingCost = (x: { l: WorldLine }) =>
        (x.l.cost as number) * (x.l.quantity - x.l.voidedUnits);
      return {
        date,
        lineNet: sum(rows, (x) => lineGross(x.l) - lineDiscount(x.l)),
        voided: sum(rows, (x) => x.l.voidedUnits * x.l.unitPrice),
        voidedUnits: sum(rows, (x) => x.l.voidedUnits),
        cancelledAmount: sum(
          rows.filter((x) => x.o.state === "cancelled"),
          (x) => x.l.voidedUnits * x.l.unitPrice,
        ),
        lineDiscounts: sum(rows, (x) => lineDiscount(x.l)),
        courtesies: sum(
          rows.filter((x) => x.l.comp),
          (x) => lineDiscount(x.l),
        ),
        cogs: sum(
          costed.filter((x) => x.o.ticketed),
          remainingCost,
        ),
        cogsAll: sum(costed, remainingCost),
        coveredGross: sum(
          costed.filter((x) => x.o.ticketed),
          (x) => lineGross(x.l),
        ),
        ticketedLineGross: sum(ticketed, (x) => lineGross(x.l)),
        wasteCost: sum(costed, (x) => (x.l.cost as number) * x.l.wasteUnits),
      };
    },
  ) as LineDayAggregate[];

  const tenders = world.orders
    .flatMap((o) => o.tenders)
    .filter((t) => within(range, t.collectionDate));
  const collections = byDate(
    tenders,
    (t) => t.collectionDate + "|" + t.method,
    (key, rows): CollectionDayAggregate => {
      const late = rows.filter((t) => t.collectionDate < t.recordedDate);
      return {
        date: key.split("|")[0],
        method: key.split("|")[1] as TenderMethod,
        count: rows.length,
        amount: sum(rows, (t) => t.amount),
        tips: sum(rows, (t) => t.tip),
        lateCount: late.length,
        lateAmount: sum(late, (t) => t.amount),
      };
    },
  ) as CollectionDayAggregate[];

  const refundsInRange = world.refunds.filter((r) => within(range, r.date));
  const refunds = byDate(
    refundsInRange,
    (r) => r.date + "|" + r.method,
    (key, rows): RefundDayAggregate => ({
      date: key.split("|")[0],
      method: key.split("|")[1] as TenderMethod,
      count: rows.length,
      amount: sum(rows, (r) => r.amount),
      fiscalAmount: sum(
        rows.filter((r) => r.afterEpoch),
        (r) => r.amount,
      ),
    }),
  ) as RefundDayAggregate[];
  const restocks = byDate(
    refundsInRange,
    (r) => r.date,
    (date, rows): RestockDayAggregate => ({
      date,
      restockedCost: sum(rows, (r) => r.restockedCost),
    }),
  ) as RestockDayAggregate[];
  const paidOuts = byDate(
    world.paidOuts.filter((p) => within(range, p.date)),
    (p) => p.date,
    (date, rows): PaidOutDayAggregate => ({
      date,
      count: rows.length,
      amount: sum(rows, (p) => p.amount),
    }),
  ) as PaidOutDayAggregate[];

  return { sales, lines, collections, refunds, restocks, paidOuts };
}

/**
 * fiscalSummary totals for the world's tickets in `range` (null when the restaurant issues no
 * tickets). The base uses a flat 16 % extraction per ticket; reports never recomputes IVA, it only
 * needs consistent totals to compose the margin and the fiscal checks.
 *
 * `refundGross` is every refund after fiscal_epoch() in range, ticketed order or not: fiscal's
 * recordRefundTax (fiscal spec §4.7 step 4) writes fiscal_adjustments for a refund of an order
 * without a ticket too (kill switch, pre-epoch order, pre-ticket item refund), from the order's
 * provisional tax groups, and fiscalSummary sums every adjustment by its business date. Only a
 * batchless refund recorded by the previous revision during a deploy overlap has no adjustment;
 * refunds_vs_fiscal fails on purpose for that day (reports spec §2.2, DB test 37).
 */
export function worldFiscalTotals(
  world: World,
  range: DateRange,
): FiscalTotals | null {
  if (!world.fiscal) return null;
  const base = (gross: number) => Math.floor((gross * 100) / 116);
  const tickets = world.orders.filter(
    (o) => o.ticketed && within(range, o.date),
  );
  const gross = tickets.reduce((a, o) => a + orderTotal(o), 0);
  const ticketBase = tickets.reduce((a, o) => a + base(orderTotal(o)), 0);
  const refundGross = world.refunds
    .filter((r) => r.afterEpoch && within(range, r.date))
    .reduce((a, r) => a + r.amount, 0);
  return {
    gross,
    base: ticketBase,
    refundGross,
    netGross: gross - refundGross,
    netBase: ticketBase - base(refundGross),
  };
}
