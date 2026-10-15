/**
 * Histórico de plataformas (041, docs/DELIVERY_HISTORY.md): the restaurant's Uber Eats, Rappi and
 * DiDi Food sales as report history only. Pure: the gm-delivery-sales file's schema (the operator's
 * scripts/history/delivery-sales-build.ts writes it), the pesos → centavos conversion with its
 * reconciliation, the per-row normalisation with rejection reasons, and the totals the preview and
 * the read view show. Nothing here is a Green Monkey sale.
 *
 * Rows are already daily aggregates per platform calendar date and store: platforms report
 * calendar days, and per-order instants are not available for every source, so a row's `date` is
 * the platform's local date and is NOT re-bucketed by the restaurant's cutoff (unlike 040).
 *
 * Money: the file's decimal strings in pesos → integer centavos with 040's Decimal conversion
 * (shared/sales-history.ts: decimalOf, toCentavos; ROUND_HALF_UP at 2 decimals). Any value with
 * more decimals is rounded and counted in `reconciliation.rounded`. `gross` is what customers paid
 * for food (IVA included, before platform fees); `commission` the platform's fees (null when the
 * source does not say); `net` what the platform pays the restaurant (null when unknown; any sign:
 * chargebacks can make a day negative, never above gross).
 */
import { Decimal } from "decimal.js";
import { z } from "zod";
import { decimalOf, toCentavos } from "./sales-history.js";

export const DELIVERY_HISTORY_FORMAT = "gm-delivery-sales";
/** The batches' `source` and the import's advisory key suffix (class 0). */
export const DELIVERY_HISTORY_SOURCE = "delivery-platforms";
/** The upload's size limit: years of daily rows are a few hundred KB. */
export const DELIVERY_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
export const DELIVERY_HISTORY_MAX_ROWS = 50_000;
/** The read view's widest range (calendar dates). */
export const DELIVERY_HISTORY_MAX_DAYS = 400;
export const DELIVERY_PLATFORMS = ["uber_eats", "rappi", "didi_food"] as const;
export type DeliveryPlatform = (typeof DELIVERY_PLATFORMS)[number];
export const DELIVERY_ORIGINS = ["portal", "pos-lite"] as const;
export const DELIVERY_REJECT_REASONS = [
  "platform",
  "date",
  "store",
  "money",
  "orders",
  "commission",
  "net",
  "duplicate",
] as const;
export type DeliveryRejectReason = (typeof DELIVERY_REJECT_REASONS)[number];
export const isDeliveryPlatform = (v: unknown): v is DeliveryPlatform =>
  (DELIVERY_PLATFORMS as readonly unknown[]).includes(v);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date written YYYY-MM-DD (2026-02-30 is not). */
export function isCalendarDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE.test(v)) return false;
  const d = new Date(v + "T00:00:00.000Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const pesos = z.union([z.number(), z.string().max(32)]).nullable().optional();
const count = z.number().finite();
const deliveryRow = z
  .object({
    date: z.string().max(20),
    platform: z.string().max(40),
    store: z.string().max(200),
    orders: count,
    gross: pesos,
    commission: pesos,
    net: pesos,
    unsettledOrders: count.optional().default(0),
    cancelled: count.optional().default(0),
    chargebacks: pesos,
  })
  .strip();
const deliverySource = z
  .object({
    platform: z.enum(DELIVERY_PLATFORMS),
    origin: z.enum(DELIVERY_ORIGINS),
    from: z.string().refine(isCalendarDate),
    to: z.string().refine(isCalendarDate),
    note: z.string().max(300).nullable().optional(),
  })
  .strip();
/** The gm-delivery-sales file (one JSON document). Unknown keys are dropped. */
export const deliveryHistoryFile = z
  .object({
    format: z.literal(DELIVERY_HISTORY_FORMAT),
    version: z.literal(1),
    exportedAt: z.string().min(10).max(40).refine((v) => !Number.isNaN(Date.parse(v))),
    currency: z.string().regex(/^[A-Z]{3}$/),
    targetTenantId: z.string().uuid(),
    sourceName: z.string().max(200).nullable().optional(),
    sources: z.array(deliverySource).max(30).default([]),
    days: z.array(deliveryRow).max(DELIVERY_HISTORY_MAX_ROWS),
    summary: z
      .object({
        days: z.number().int().min(0),
        orders: z.number().int().min(0),
        gross: pesos,
        commission: pesos,
        net: pesos,
      })
      .strip(),
  })
  .strip();
export type DeliveryHistoryFile = z.infer<typeof deliveryHistoryFile>;
export type DeliveryFileRow = DeliveryHistoryFile["days"][number];
export type DeliverySource = DeliveryHistoryFile["sources"][number];

/** One accepted row in centavos: the shape of a delivery_history_days row. */
export type DeliveryDay = {
  date: string;
  platform: DeliveryPlatform;
  store: string;
  orders: number;
  gross: number;
  commission: number | null;
  net: number | null;
  unsettledOrders: number;
  cancelled: number;
  chargebacks: number;
};
export type DeliveryRejection = {
  /** The row's position in the file's `days` (1-based). */
  row: number;
  date: string;
  platform: string;
  store: string;
  reason: DeliveryRejectReason;
};
export type DeliveryReconciliation = {
  /** Exact sums of the accepted rows' pesos as written in the file ("1234.50"). */
  source: { gross: string; commission: string; net: string; chargebacks: string };
  /** Sums of the converted centavos (null commission or net count as 0). */
  converted: { gross: number; commission: number; net: number; chargebacks: number };
  /** True when every converted sum equals its exact source sum × 100. */
  matches: boolean;
  /** Money values that had more than 2 decimals and were rounded. */
  rounded: number;
  /** The file's own summary (every row) agrees with its rows. */
  summaryOk: boolean;
};
/** Per platform: its first and last date with a row (the dates an import takes over). */
export type DeliveryCoverage = Partial<Record<DeliveryPlatform, { from: string; to: string }>>;
export type DeliveryNormalized = {
  accepted: DeliveryDay[];
  rejected: DeliveryRejection[];
  coverage: DeliveryCoverage;
  reconciliation: DeliveryReconciliation;
};

const nullable = (v: unknown) => (v === null || v === undefined ? null : decimalOf(v));
const hasSubCentavo = (v: Decimal) => !v.times(100).isInteger();
/** A store label as stored: inner whitespace collapsed, trimmed; "" when nothing is left. */
export const storeLabel = (v: string) => v.replace(/\s+/g, " ").trim();

/**
 * Every row of the file as an accepted day or a rejection. Rejected: an unknown platform; a date
 * that is not a calendar date; a store that is empty or longer than 80 characters; a money value
 * that is not a number, or a negative gross, commission or chargebacks; orders, unsettled or
 * cancelled that are not whole numbers ≥ 0, or no orders; a commission above the gross; a net above
 * the gross; a repeated (date, platform, store).
 */
export function normalizeDeliveryHistory(file: DeliveryHistoryFile): DeliveryNormalized {
  const accepted: DeliveryDay[] = [];
  const rejected: DeliveryRejection[] = [];
  const seen = new Set<string>();
  const coverage: DeliveryCoverage = {};
  let rounded = 0;
  const src = {
    gross: new Decimal(0),
    commission: new Decimal(0),
    net: new Decimal(0),
    chargebacks: new Decimal(0),
  };
  file.days.forEach((r, i) => {
    const store = storeLabel(r.store);
    const reject = (reason: DeliveryRejectReason) =>
      rejected.push({
        row: i + 1,
        date: r.date.slice(0, 20),
        platform: r.platform.slice(0, 40),
        store: store.slice(0, 80),
        reason,
      });
    if (!isDeliveryPlatform(r.platform)) return reject("platform");
    if (!isCalendarDate(r.date)) return reject("date");
    if (!store || store.length > 80) return reject("store");
    const gross = r.gross === null || r.gross === undefined ? null : decimalOf(r.gross);
    const commission = nullable(r.commission);
    const net = nullable(r.net);
    const chargebacks = decimalOf(r.chargebacks);
    if (
      gross === null ||
      gross.isNegative() ||
      (r.commission != null && (commission === null || commission.isNegative())) ||
      (r.net != null && net === null) ||
      chargebacks === null ||
      chargebacks.isNegative()
    )
      return reject("money");
    const whole = (n: number) => Number.isInteger(n) && n >= 0 && n <= 1_000_000;
    if (!whole(r.orders) || r.orders === 0 || !whole(r.unsettledOrders) || !whole(r.cancelled))
      return reject("orders");
    let localRounded = 0;
    const c = (d: Decimal) => {
      if (hasSubCentavo(d)) localRounded++;
      return toCentavos(d);
    };
    const day: DeliveryDay = {
      date: r.date,
      platform: r.platform,
      store,
      orders: r.orders,
      gross: c(gross),
      commission: commission === null ? null : c(commission),
      net: net === null ? null : c(net),
      unsettledOrders: r.unsettledOrders,
      cancelled: r.cancelled,
      chargebacks: c(chargebacks),
    };
    if (day.commission !== null && day.commission > day.gross) return reject("commission");
    if (day.net !== null && day.net > day.gross) return reject("net");
    const key = `${r.date}|${r.platform}|${store}`;
    if (seen.has(key)) return reject("duplicate");
    seen.add(key);
    rounded += localRounded;
    src.gross = src.gross.plus(gross);
    if (commission) src.commission = src.commission.plus(commission);
    if (net) src.net = src.net.plus(net);
    src.chargebacks = src.chargebacks.plus(chargebacks);
    const cov = coverage[r.platform];
    if (!cov) coverage[r.platform] = { from: r.date, to: r.date };
    else {
      if (r.date < cov.from) cov.from = r.date;
      if (r.date > cov.to) cov.to = r.date;
    }
    accepted.push(day);
  });
  accepted.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.platform.localeCompare(b.platform) ||
      a.store.localeCompare(b.store),
  );
  const converted = {
    gross: accepted.reduce((a, d) => a + d.gross, 0),
    commission: accepted.reduce((a, d) => a + (d.commission ?? 0), 0),
    net: accepted.reduce((a, d) => a + (d.net ?? 0), 0),
    chargebacks: accepted.reduce((a, d) => a + d.chargebacks, 0),
  };
  // The summary covers every row of the file, rejected ones included (040's rule).
  const fileSum = (k: "gross" | "commission" | "net") =>
    file.days.reduce((a, r) => a.plus(nullable(r[k]) ?? 0), new Decimal(0));
  const sameDecimal = (v: unknown, d: Decimal) => {
    const x = nullable(v) ?? new Decimal(0);
    return x.equals(d);
  };
  return {
    accepted,
    rejected,
    coverage,
    reconciliation: {
      source: {
        gross: src.gross.toFixed(2),
        commission: src.commission.toFixed(2),
        net: src.net.toFixed(2),
        chargebacks: src.chargebacks.toFixed(2),
      },
      converted,
      matches: (["gross", "commission", "net", "chargebacks"] as const).every((k) =>
        src[k].times(100).equals(converted[k]),
      ),
      rounded,
      summaryOk:
        file.summary.days === file.days.length &&
        file.summary.orders === file.days.reduce((a, r) => a + r.orders, 0) &&
        sameDecimal(file.summary.gross, fileSum("gross")) &&
        sameDecimal(file.summary.commission, fileSum("commission")) &&
        sameDecimal(file.summary.net, fileSum("net")),
    },
  };
}

/** Sums of day rows; commission and net count only the rows that know them. */
export type DeliveryTotals = {
  days: number;
  orders: number;
  gross: number;
  commission: number;
  net: number;
  unsettledOrders: number;
  cancelled: number;
  chargebacks: number;
  /** Rows whose commission (net) the source did not give: the sum leaves them out. */
  commissionUnknown: number;
  netUnknown: number;
};
const zero = (): DeliveryTotals => ({
  days: 0,
  orders: 0,
  gross: 0,
  commission: 0,
  net: 0,
  unsettledOrders: 0,
  cancelled: 0,
  chargebacks: 0,
  commissionUnknown: 0,
  netUnknown: 0,
});
function add(t: DeliveryTotals, d: DeliveryDay) {
  t.days++;
  t.orders += d.orders;
  t.gross += d.gross;
  t.unsettledOrders += d.unsettledOrders;
  t.cancelled += d.cancelled;
  t.chargebacks += d.chargebacks;
  if (d.commission === null) t.commissionUnknown++;
  else t.commission += d.commission;
  if (d.net === null) t.netUnknown++;
  else t.net += d.net;
  return t;
}
export const deliveryTotals = (days: readonly DeliveryDay[]) => days.reduce(add, zero());
export type PlatformTotals = Record<DeliveryPlatform, DeliveryTotals>;
export function platformTotals(days: readonly DeliveryDay[]): PlatformTotals {
  const out = Object.fromEntries(DELIVERY_PLATFORMS.map((p) => [p, zero()])) as PlatformTotals;
  for (const d of days) add(out[d.platform], d);
  return out;
}
/** Per platform and store, in platform order then store name. */
export function storeTotals(days: readonly DeliveryDay[]) {
  const out = new Map<string, { platform: DeliveryPlatform; store: string; totals: DeliveryTotals }>();
  for (const d of days) {
    const k = d.platform + "|" + d.store;
    const row = out.get(k) ?? out.set(k, { platform: d.platform, store: d.store, totals: zero() }).get(k)!;
    add(row.totals, d);
  }
  return [...out.values()].sort(
    (a, b) =>
      DELIVERY_PLATFORMS.indexOf(a.platform) - DELIVERY_PLATFORMS.indexOf(b.platform) ||
      a.store.localeCompare(b.store),
  );
}
/** Month rows ("YYYY-MM") from day rows, for the read view's monthly totals. */
export function deliveryMonthTotals(days: readonly DeliveryDay[]) {
  const out = new Map<string, DeliveryTotals & { month: string }>();
  for (const d of days) {
    const month = d.date.slice(0, 7);
    add(out.get(month) ?? out.set(month, { month, ...zero() }).get(month)!, d);
  }
  return [...out.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/** What the owner confirms before Importar (POST /api/delivery-history/preview). */
export type DeliveryHistoryPreview = {
  fileHash: string;
  sourceName: string | null;
  exportedAt: string;
  sources: DeliverySource[];
  coverage: DeliveryCoverage;
  /** Accepted rows (date, platform, store). */
  days: number;
  orders: number;
  rejected: DeliveryRejection[];
  byPlatform: PlatformTotals;
  reconciliation: DeliveryReconciliation;
  /** This exact file is already imported (Importar is a no-op). */
  alreadyImported: boolean;
  /** (platform, date) pairs of the coverage that already hold imported history and would be replaced. */
  replacesDays: number;
  /** A newer file already covers some of these (platform, date) pairs: Importar is refused. */
  olderThanImported: boolean;
};
export type DeliveryHistoryImportResult = {
  batchId: string;
  replayed: boolean;
  /** Accepted rows imported. */
  days: number;
  orders: number;
  replacedDays: number;
};
/** GET /api/delivery-history?from&to. */
export type DeliveryHistoryReport = {
  range: { from: string; to: string };
  days: DeliveryDay[];
  batches: {
    id: string;
    sourceName: string | null;
    exportedAt: string;
    coverage: DeliveryCoverage;
    days: number;
    orders: number;
    importedAt: string;
  }[];
};
