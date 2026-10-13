/**
 * Histórico POS Lite (040, docs/SALES_HISTORY.md): Juanberto's past pos-lite kiosk and POS-terminal
 * sales as report history only. Pure: the export file's schema (scripts/history/poslite-sales-export.sql
 * emits it), the pesos → centavos conversion with its reconciliation, the per-order normalisation
 * with rejection reasons, and the aggregation into day, payment-method and product rows. The
 * server (server/sales-history.ts) supplies each order's business date (business_date_at, 029).
 *
 * pos-lite semantics (read-only inspection of pos-lite's schema and rows, docs/SALES_HISTORY.md §2):
 * - `total` = `subtotal` + `tax`; `tax` is 16 % on top of `subtotal`, so `total` includes IVA.
 * - `tip` is NOT in `total`; it is stored on the order and on each `order_payments` row.
 * - Line `unit_price` includes IVA (and the chosen modifiers); `total` = Σ quantity × unit_price
 *   of the non-voided lines − order `discount_amount` − Σ line `discount_amount`.
 * - `split` orders carry their parts in `order_payments` (status paid/succeeded): Σ amount =
 *   `total`, Σ tip = order `tip`.
 * - A sale is dated by COALESCE(paid_at, created_at), as pos-lite's own reports do; completed_at
 *   is the kitchen's completion and can fall on a later day.
 *
 * Money: pos-lite numeric pesos → integer centavos with Decimal, ROUND_HALF_UP (half away from
 * zero) at 2 decimals. pos-lite stores 2 decimals, so the rule is a no-op on its data; any value
 * with more decimals is rounded and counted in `reconciliation.rounded`.
 */
import { Decimal } from "decimal.js";
import { z } from "zod";

export const SALES_HISTORY_SOURCE = "pos-lite-sales";
/** The upload's size limit: pos-lite's whole history is far smaller (about 0.5 KB an order). */
export const SALES_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
export const SALES_HISTORY_MAX_ORDERS = 200_000;
/** The read view's widest range (business dates). */
export const SALES_HISTORY_MAX_DAYS = 400;
export const SALES_HISTORY_CHANNELS = ["kiosk", "pos"] as const;
export type HistoryChannel = (typeof SALES_HISTORY_CHANNELS)[number];
export const SALES_HISTORY_METHODS = ["cash", "card", "transfer", "other"] as const;
export type HistoryMethod = (typeof SALES_HISTORY_METHODS)[number];
export const REJECT_REASONS = [
  "channel",
  "instant",
  "money",
  "totals",
  "payments",
  "refund",
  "duplicate",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** pos-lite `orders.source` → the channel shown here; anything else is rejected. */
const CHANNEL: Record<string, HistoryChannel> = { customer_kiosk: "kiosk", pos: "pos" };
/** pos-lite payment methods; unknown ones are shown as "other", never dropped. */
const METHOD: Record<string, HistoryMethod> = {
  cash: "cash",
  card: "card",
  mp_terminal: "card",
  clip: "card",
  getnet: "card",
  terminal: "card",
  transfer: "transfer",
  spei: "transfer",
};
export const historyMethod = (m: string | null | undefined): HistoryMethod =>
  METHOD[(m ?? "").trim().toLowerCase()] ?? "other";
/** The payment rows that count: pos-lite marks settled parts paid or succeeded. */
const SETTLED = new Set(["paid", "succeeded"]);

const pesos = z.union([z.number(), z.string().max(32)]).nullable().optional();
const instant = z.string().min(10).max(40).nullable().optional();
const posLiteLine = z
  .object({
    name: z.string().max(500).nullable().optional(),
    quantity: z.coerce.number(),
    unit_price: pesos,
    discount_amount: pesos,
  })
  .strip();
const posLitePayment = z
  .object({
    method: z.string().max(40).nullable().optional(),
    amount: pesos,
    tip: pesos,
    status: z.string().max(40).nullable().optional(),
  })
  .strip();
const posLiteOrder = z
  .object({
    id: z.union([z.string().min(1).max(64), z.number().int().min(0)]),
    created_at: instant,
    paid_at: instant,
    completed_at: instant,
    source: z.string().max(40).nullable().optional(),
    payment_method: z.string().max(40).nullable().optional(),
    subtotal: pesos,
    tax: pesos,
    tip: pesos,
    total: pesos,
    discount_amount: pesos,
    refund_total: pesos,
    lines: z.array(posLiteLine).max(500).default([]),
    payments: z.array(posLitePayment).max(50).default([]),
  })
  .strip();
/** The export file (one JSON document). Unknown keys are dropped: nothing personal is kept. */
export const salesHistoryExport = z
  .object({
    source: z.literal(SALES_HISTORY_SOURCE),
    sourceTenantId: z.string().min(1).max(100),
    sourceName: z.string().max(200).nullable().optional(),
    targetTenantId: z.string().uuid(),
    exportedAt: z.string().min(10).max(40).refine((v) => !Number.isNaN(Date.parse(v))),
    currency: z.string().regex(/^[A-Z]{3}$/),
    summary: z
      .object({
        orders: z.number().int().min(0),
        total: pesos,
        tax: pesos,
        tip: pesos,
      })
      .strip(),
    orders: z.array(posLiteOrder).max(SALES_HISTORY_MAX_ORDERS),
  })
  .strip();
export type SalesHistoryExport = z.infer<typeof salesHistoryExport>;
export type PosLiteSale = SalesHistoryExport["orders"][number];

/** Exact decimal of a pos-lite money value; null for anything that is not a finite number. */
export function decimalOf(v: unknown): Decimal | null {
  // pos-lite leaves optional amounts (tip, discount, refund_total) NULL: they are zero.
  if (v === null || v === undefined) return new Decimal(0);
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  const text = typeof v === "number" ? String(v) : String(v).trim();
  if (!/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(text)) return null;
  return new Decimal(text);
}
/** Pesos → integer centavos, ROUND_HALF_UP (half away from zero). */
export function toCentavos(v: Decimal): number {
  return v.times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}
const hasSubCentavo = (v: Decimal) => !v.times(100).isInteger();

export type HistoryPart = { method: HistoryMethod; amount: number; tip: number };
export type HistoryLine = { name: string; quantity: number; amount: number };
/** One accepted pos-lite sale in centavos (never stored as such: only its aggregates are). */
export type HistorySale = {
  legacyId: string;
  /** The instant that dates the sale: paid_at, else created_at (ISO). */
  at: string;
  channel: HistoryChannel;
  /** Σ quantity × unit_price of the lines (IVA included, before discounts). */
  gross: number;
  /** Order discount + line discounts. */
  discount: number;
  subtotal: number;
  tax: number;
  total: number;
  tip: number;
  refunds: number;
  parts: HistoryPart[];
  lines: HistoryLine[];
};
export type HistoryRejection = { legacyId: string; reason: RejectReason };
export type MoneyTotals = { orders: number; total: number; tax: number; tip: number; refunds: number };
export type Reconciliation = {
  /** Exact sums of the accepted sales' pesos as written in the file ("1234.50"). */
  source: { total: string; tax: string; tip: string; refunds: string };
  /** Sums of the converted centavos. */
  converted: { total: number; tax: number; tip: number; refunds: number };
  /** True when every converted sum equals its exact source sum × 100. */
  matches: boolean;
  /** Money values that had more than 2 decimals and were rounded. */
  rounded: number;
  /** The file's own summary (every exported order) agrees with its order list. */
  summaryOk: boolean;
  /** Accepted sales whose lines (gross − discount) differ from their total (shown, not rejected). */
  linesMismatch: number;
};
export type Normalized = {
  accepted: HistorySale[];
  rejected: HistoryRejection[];
  reconciliation: Reconciliation;
};

const productName = (v: string | null | undefined) =>
  (v ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "Sin nombre";
const isoOf = (v: string | null | undefined) => {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

/**
 * Every order of the file as an accepted sale or a rejection. Rejected: a channel other than kiosk
 * or POS; no valid instant; a money value that is not a number or is negative; total ≠ subtotal +
 * tax; a split whose settled parts do not add up to the total and tip; refunds above the total; a
 * repeated pos-lite id.
 */
export function normalizeSalesHistory(file: SalesHistoryExport): Normalized {
  const accepted: HistorySale[] = [];
  const rejected: HistoryRejection[] = [];
  const seen = new Set<string>();
  let rounded = 0,
    linesMismatch = 0;
  const src = { total: new Decimal(0), tax: new Decimal(0), tip: new Decimal(0), refunds: new Decimal(0) };
  for (const o of file.orders) {
    const legacyId = String(o.id);
    const reject = (reason: RejectReason) => rejected.push({ legacyId, reason });
    if (seen.has(legacyId)) {
      reject("duplicate");
      continue;
    }
    seen.add(legacyId);
    const channel = CHANNEL[o.source ?? ""];
    if (!channel) {
      reject("channel");
      continue;
    }
    const at = isoOf(o.paid_at) ?? isoOf(o.created_at);
    if (!at) {
      reject("instant");
      continue;
    }
    const money = [o.subtotal, o.tax, o.tip, o.total, o.discount_amount, o.refund_total].map(decimalOf);
    if (money.some((d) => d === null || d.isNegative())) {
      reject("money");
      continue;
    }
    const [subtotalD, taxD, tipD, totalD, discountD, refundD] = money as Decimal[];
    const lineMoney = o.lines.map((l) => [decimalOf(l.unit_price), decimalOf(l.discount_amount)] as const);
    if (
      lineMoney.some(([u, d]) => u === null || d === null || u.isNegative() || d.isNegative()) ||
      o.lines.some((l) => !Number.isInteger(l.quantity) || l.quantity < 0 || l.quantity > 100_000)
    ) {
      reject("money");
      continue;
    }
    let localRounded = 0;
    const c = (d: Decimal) => {
      if (hasSubCentavo(d)) localRounded++;
      return toCentavos(d);
    };
    const subtotal = c(subtotalD!),
      tax = c(taxD!),
      tip = c(tipD!),
      total = c(totalD!),
      orderDiscount = c(discountD!),
      refunds = c(refundD!);
    if (subtotal + tax !== total) {
      reject("totals");
      continue;
    }
    if (refunds > total) {
      reject("refund");
      continue;
    }
    let parts: HistoryPart[];
    if ((o.payment_method ?? "").trim().toLowerCase() === "split") {
      const settled = o.payments.filter((p) => SETTLED.has((p.status ?? "").trim().toLowerCase()));
      const pm = settled.map((p) => [decimalOf(p.amount), decimalOf(p.tip)] as const);
      if (!settled.length || pm.some(([a, t]) => a === null || t === null || a.isNegative() || t.isNegative())) {
        reject("payments");
        continue;
      }
      parts = settled.map((p, i) => ({
        method: historyMethod(p.method),
        amount: c(pm[i]![0]!),
        tip: c(pm[i]![1]!),
      }));
      if (
        parts.reduce((a, p) => a + p.amount, 0) !== total ||
        parts.reduce((a, p) => a + p.tip, 0) !== tip
      ) {
        reject("payments");
        continue;
      }
    } else parts = [{ method: historyMethod(o.payment_method), amount: total, tip }];
    let gross = 0,
      lineDiscount = 0;
    const lines: HistoryLine[] = o.lines.map((l, i) => {
      const [u, d] = lineMoney[i]!;
      const g = c(u!.times(l.quantity));
      const ld = c(d!);
      gross += g;
      lineDiscount += ld;
      return { name: productName(l.name), quantity: l.quantity, amount: g - ld };
    });
    if (lines.some((l) => l.amount < 0)) {
      reject("money");
      continue;
    }
    const discount = orderDiscount + lineDiscount;
    if (gross - discount !== total) linesMismatch++;
    rounded += localRounded;
    src.total = src.total.plus(totalD!);
    src.tax = src.tax.plus(taxD!);
    src.tip = src.tip.plus(tipD!);
    src.refunds = src.refunds.plus(refundD!);
    accepted.push({
      legacyId,
      at,
      channel,
      gross,
      discount,
      subtotal,
      tax,
      total,
      tip,
      refunds,
      parts,
      lines,
    });
  }
  const converted = {
    total: accepted.reduce((a, s) => a + s.total, 0),
    tax: accepted.reduce((a, s) => a + s.tax, 0),
    tip: accepted.reduce((a, s) => a + s.tip, 0),
    refunds: accepted.reduce((a, s) => a + s.refunds, 0),
  };
  const fileSum = (k: "total" | "tax" | "tip") =>
    file.orders.reduce((a, o) => a.plus(decimalOf(o[k]) ?? 0), new Decimal(0));
  const sameDecimal = (v: unknown, d: Decimal) => {
    const x = decimalOf(v);
    return x !== null && x.equals(d);
  };
  return {
    accepted,
    rejected,
    reconciliation: {
      source: {
        total: src.total.toFixed(2),
        tax: src.tax.toFixed(2),
        tip: src.tip.toFixed(2),
        refunds: src.refunds.toFixed(2),
      },
      converted,
      matches: (["total", "tax", "tip", "refunds"] as const).every(
        (k) => src[k].times(100).equals(converted[k]),
      ),
      rounded,
      summaryOk:
        file.summary.orders === file.orders.length &&
        sameDecimal(file.summary.total ?? 0, fileSum("total")) &&
        sameDecimal(file.summary.tax ?? 0, fileSum("tax")) &&
        sameDecimal(file.summary.tip ?? 0, fileSum("tip")),
      linesMismatch,
    },
  };
}

/** Rows of 040's sales_history_days: one per business date and channel. */
export type DayAggregate = {
  date: string;
  channel: HistoryChannel;
  orders: number;
  gross: number;
  discount: number;
  subtotal: number;
  tax: number;
  total: number;
  tip: number;
  refunds: number;
};
/** Rows of sales_history_payments: one per date, channel and method (a split counts per part). */
export type PaymentAggregate = {
  date: string;
  channel: HistoryChannel;
  method: HistoryMethod;
  payments: number;
  amount: number;
  tip: number;
};
/** Rows of sales_history_products: one per date, channel and product name. */
export type ProductAggregate = {
  date: string;
  channel: HistoryChannel;
  name: string;
  quantity: number;
  amount: number;
};
export type Aggregates = {
  days: DayAggregate[];
  payments: PaymentAggregate[];
  products: ProductAggregate[];
  /** First and last business date with a sale; null when nothing was accepted. */
  coverage: { from: string; to: string } | null;
};

/** Sums the accepted sales by business date (dateOf: legacyId → YYYY-MM-DD from the server). */
export function aggregateSalesHistory(
  sales: readonly HistorySale[],
  dateOf: (legacyId: string) => string,
): Aggregates {
  const days = new Map<string, DayAggregate>();
  const payments = new Map<string, PaymentAggregate>();
  const products = new Map<string, ProductAggregate>();
  let from: string | null = null,
    to: string | null = null;
  for (const s of sales) {
    const date = dateOf(s.legacyId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError("sales_history_date");
    if (!from || date < from) from = date;
    if (!to || date > to) to = date;
    const dk = date + "|" + s.channel;
    const d =
      days.get(dk) ??
      days
        .set(dk, {
          date,
          channel: s.channel,
          orders: 0,
          gross: 0,
          discount: 0,
          subtotal: 0,
          tax: 0,
          total: 0,
          tip: 0,
          refunds: 0,
        })
        .get(dk)!;
    d.orders++;
    d.gross += s.gross;
    d.discount += s.discount;
    d.subtotal += s.subtotal;
    d.tax += s.tax;
    d.total += s.total;
    d.tip += s.tip;
    d.refunds += s.refunds;
    for (const p of s.parts) {
      const pk = dk + "|" + p.method;
      const a =
        payments.get(pk) ??
        payments.set(pk, { date, channel: s.channel, method: p.method, payments: 0, amount: 0, tip: 0 }).get(pk)!;
      a.payments++;
      a.amount += p.amount;
      a.tip += p.tip;
    }
    for (const l of s.lines) {
      const lk = dk + "|" + l.name;
      const a =
        products.get(lk) ??
        products.set(lk, { date, channel: s.channel, name: l.name, quantity: 0, amount: 0 }).get(lk)!;
      a.quantity += l.quantity;
      a.amount += l.amount;
    }
  }
  const order = <T extends { date: string; channel: string }>(a: T, b: T) =>
    a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel);
  return {
    days: [...days.values()].sort(order),
    payments: [...payments.values()].sort((a, b) => order(a, b) || a.method.localeCompare(b.method)),
    products: [...products.values()].sort((a, b) => order(a, b) || a.name.localeCompare(b.name)),
    coverage: from && to ? { from, to } : null,
  };
}

/** Totals by channel and by method, for the preview and the read view. */
export type ChannelTotals = Record<HistoryChannel, { orders: number; total: number; tip: number }>;
export type MethodTotals = Record<HistoryMethod, { payments: number; amount: number; tip: number }>;
export function channelTotals(days: readonly Pick<DayAggregate, "channel" | "orders" | "total" | "tip">[]): ChannelTotals {
  const out = Object.fromEntries(
    SALES_HISTORY_CHANNELS.map((c) => [c, { orders: 0, total: 0, tip: 0 }]),
  ) as ChannelTotals;
  for (const d of days) {
    out[d.channel].orders += d.orders;
    out[d.channel].total += d.total;
    out[d.channel].tip += d.tip;
  }
  return out;
}
export function methodTotals(rows: readonly Pick<PaymentAggregate, "method" | "payments" | "amount" | "tip">[]): MethodTotals {
  const out = Object.fromEntries(
    SALES_HISTORY_METHODS.map((m) => [m, { payments: 0, amount: 0, tip: 0 }]),
  ) as MethodTotals;
  for (const r of rows) {
    out[r.method].payments += r.payments;
    out[r.method].amount += r.amount;
    out[r.method].tip += r.tip;
  }
  return out;
}

/** What the owner confirms before Importar (POST /api/sales-history/preview). */
export type SalesHistoryPreview = {
  fileHash: string;
  sourceTenantId: string;
  sourceName: string | null;
  exportedAt: string;
  coverage: { from: string; to: string } | null;
  orders: number;
  rejected: HistoryRejection[];
  byChannel: ChannelTotals;
  byMethod: MethodTotals;
  reconciliation: Reconciliation;
  /** This exact file is already imported (Importar is a no-op). */
  alreadyImported: boolean;
  /** Days of the coverage that already hold imported history and would be replaced. */
  replacesDays: number;
  /** A newer export already covers some of these days: Importar is refused. */
  olderThanImported: boolean;
};
export type SalesHistoryImportResult = {
  batchId: string;
  replayed: boolean;
  orders: number;
  days: number;
  replacedDays: number;
};
/** GET /api/sales-history?from&to. */
export type SalesHistoryReport = {
  range: { from: string; to: string };
  days: DayAggregate[];
  payments: PaymentAggregate[];
  /** The range's products by amount, largest first (at most 100). */
  products: { name: string; quantity: number; amount: number }[];
  batches: {
    id: string;
    sourceName: string | null;
    exportedAt: string;
    coverageFrom: string;
    coverageTo: string;
    orders: number;
    importedAt: string;
  }[];
};

/** Month rows ("YYYY-MM") from day rows, for the read view's monthly totals. */
export function monthTotals(days: readonly DayAggregate[]) {
  const out = new Map<string, { month: string; orders: number; total: number; tax: number; tip: number }>();
  for (const d of days) {
    const month = d.date.slice(0, 7);
    const m = out.get(month) ?? out.set(month, { month, orders: 0, total: 0, tax: 0, tip: 0 }).get(month)!;
    m.orders += d.orders;
    m.total += d.total;
    m.tax += d.tax;
    m.tip += d.tip;
  }
  return [...out.values()].sort((a, b) => a.month.localeCompare(b.month));
}
