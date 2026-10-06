// shared/reports.ts — pure reports core (area 029): business-date ranges and quick ranges, the SQL
// business-day formula mirrored in JS, query schemas, keyset cursors, the metric contract's
// arithmetic (sales, refunds, collections, margin, per-day rows, reconciliation checks), the hour
// and exception helpers, and the corte X/Z/del día document model.
// No database access: server/reports/* loads aggregates and calls these.
// Every amount is an integer number of minor units (centavos); every price is tax-inclusive
// (LFPC art. 7 Bis). IVA is never computed here: it comes only from fiscal's fiscalSummary
// (SalesSummary.tax), merged over ≤ 31-day chunks by mergeFiscalSummaries.
import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import {
  boundaries,
  businessDate,
  DomainError,
  id,
  money,
  type Label,
} from "./domain.js";
import {
  formatFolio,
  type CategoryTotals,
  type FiscalSummary,
} from "./fiscal.js";
import { TAX_CATEGORIES } from "./tax.js";

// ---------------------------------------------------------------------------------------------
// Limits, business dates and ranges
// ---------------------------------------------------------------------------------------------

export const LIMITS = {
  aggregateDays: 92,
  listDays: 31,
  pageMax: 500,
  exportRows: 20000,
} as const;
export type DateRange = { from: string; to: string };
/** The restaurant settings that place an instant on a business date. */
export type BusinessDaySettings = { timezone: string; cutoff: number };

/**
 * Business dates the reports accept. Temporal parses "0000-01-01" but PostgreSQL has no year 0,
 * and wideWindow() reaches 3 days past each end, so dates are bounded well inside both ranges:
 * a forged range is a 400 (reports_range_invalid), never a SQL error.
 */
export const DATE_BOUNDS = { min: "2000-01-01", max: "2999-12-31" } as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MIN_DATE = Temporal.PlainDate.from(DATE_BOUNDS.min);
const MAX_DATE = Temporal.PlainDate.from(DATE_BOUNDS.max);
const rangeInvalid = () => new DomainError("reports_range_invalid", 400);
const invalidInput = () => new DomainError("invalid_input", 400);

function toPlainDate(value: unknown): Temporal.PlainDate | null {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return null;
  let date: Temporal.PlainDate;
  try {
    date = Temporal.PlainDate.from(value, { overflow: "reject" });
  } catch {
    return null;
  }
  return Temporal.PlainDate.compare(date, MIN_DATE) < 0 ||
    Temporal.PlainDate.compare(date, MAX_DATE) > 0
    ? null
    : date;
}

/** True for a real calendar date "AAAA-MM-DD" within DATE_BOUNDS. */
export function isBusinessDate(value: unknown): value is string {
  return toPlainDate(value) !== null;
}

/** Parses and validates a business-date range. Throws DomainError("reports_range_invalid", 400). */
export function parseRange(
  raw: { from?: unknown; to?: unknown },
  maxDays: number,
): DateRange {
  if (!Number.isSafeInteger(maxDays) || maxDays < 1)
    throw new RangeError("invalid_max_days");
  const from = toPlainDate(raw?.from);
  const to = toPlainDate(raw?.to);
  if (!from || !to || Temporal.PlainDate.compare(from, to) > 0)
    throw rangeInvalid();
  if (from.until(to, { largestUnit: "days" }).days + 1 > maxDays)
    throw rangeInvalid();
  return { from: from.toString(), to: to.toString() };
}

/** `date` plus `days` calendar days (negative to go back). */
export function addDays(date: string, days: number): string {
  const d = toPlainDate(date);
  if (!d || !Number.isSafeInteger(days)) throw new RangeError("invalid_date");
  return d.add({ days }).toString();
}

/** Number of business dates in a range (both ends included). */
export function rangeLength(range: DateRange): number {
  const { from, to } = parseRange(range, Number.MAX_SAFE_INTEGER);
  return (
    Temporal.PlainDate.from(from).until(to, { largestUnit: "days" }).days + 1
  );
}

/** Every business date of a range, oldest first. */
export function rangeDates(range: DateRange): string[] {
  const first = Temporal.PlainDate.from(
    parseRange(range, Number.MAX_SAFE_INTEGER).from,
  );
  return Array.from({ length: rangeLength(range) }, (_, i) =>
    first.add({ days: i }).toString(),
  );
}

export const QUICK_RANGES = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
] as const;
export type QuickRange = (typeof QUICK_RANGES)[number];

/**
 * Business-date ranges relative to `today` (a business date). Weeks start Monday. "This week"
 * and "this month" end today: a range never reaches into business dates that have not started.
 */
export function quickRange(kind: QuickRange, today: string): DateRange {
  const d = toPlainDate(today);
  if (!d) throw rangeInvalid();
  const range = (from: Temporal.PlainDate, to: Temporal.PlainDate) => ({
    from: from.toString(),
    to: to.toString(),
  });
  const monday = d.subtract({ days: d.dayOfWeek - 1 });
  switch (kind) {
    case "today":
      return range(d, d);
    case "yesterday":
      return range(d.subtract({ days: 1 }), d.subtract({ days: 1 }));
    case "this_week":
      return range(monday, d);
    case "last_week":
      return range(monday.subtract({ days: 7 }), monday.subtract({ days: 1 }));
    case "this_month":
      return range(d.with({ day: 1 }), d);
    case "last_month": {
      const first = d.with({ day: 1 }).subtract({ months: 1 });
      return range(first, first.with({ day: first.daysInMonth }));
    }
    default:
      throw rangeInvalid();
  }
}

function assertCutoff(cutoff: number) {
  if (!Number.isInteger(cutoff) || cutoff < 0 || cutoff > 1439)
    throw new RangeError("invalid_cutoff");
}

/**
 * The SQL day formula `((at AT TIME ZONE zone) − make_interval(mins => cutoff))::date` evaluated
 * in JS: the local wall clock of the instant (DST-aware), minus the cutoff as wall-clock minutes.
 * Migration 029's business_date_at() and every bucketed report query use this formula; unit test 3
 * proves it equals shared/domain.ts businessDate() (the rule orders are stamped with).
 */
export function wallClockBusinessDate(
  instant: string,
  zone: string,
  cutoff: number,
): string {
  assertCutoff(cutoff);
  return Temporal.Instant.from(instant)
    .toZonedDateTimeISO(zone)
    .toPlainDateTime()
    .subtract({ minutes: cutoff })
    .toPlainDate()
    .toString();
}

/** `extract(hour from (at AT TIME ZONE zone))`: the local wall-clock hour (0–23) of an instant. */
export function wallClockHour(instant: string, zone: string): number {
  return Temporal.Instant.from(instant).toZonedDateTimeISO(zone).hour;
}

/** The business date in force now under the restaurant's current settings. */
export function currentBusinessDate(
  settings: BusinessDaySettings,
  now: Date = new Date(),
): string {
  assertCutoff(settings.cutoff);
  return businessDate(now.toISOString(), settings.timezone, settings.cutoff);
}

/**
 * Index-friendly instant window that surely contains every event of the business-date range under
 * any historical settings: [start of (from − 3 days), end of (to + 3 days)) with the current
 * settings. Two IANA zones differ by ≤ 26 h and cutoffs by < 24 h, so 72 h covers any setting.
 */
export function wideWindow(
  range: DateRange,
  settings: BusinessDaySettings,
): { start: string; end: string } {
  const { from, to } = parseRange(range, Number.MAX_SAFE_INTEGER);
  assertCutoff(settings.cutoff);
  return {
    start: boundaries(addDays(from, -3), settings.timezone, settings.cutoff)
      .start,
    end: boundaries(addDays(to, 3), settings.timezone, settings.cutoff).end,
  };
}

// ---------------------------------------------------------------------------------------------
// Catalogs: breakdowns, exception kinds, audit groups
// ---------------------------------------------------------------------------------------------

export const BREAKDOWNS = [
  "product",
  "category",
  "employee",
  "hour",
  "channel",
  "mode",
  "method",
  "day",
] as const;
export type Breakdown = (typeof BREAKDOWNS)[number];
export const EXCEPTION_KINDS = [
  "void",
  "discount",
  "discount_reversal",
  "refund",
  "paid_out",
  "drawer_difference",
  "terminal_difference",
  "reprint",
  "corte_reprint",
  "open_price",
  "offline_archive",
  "offline_reconcile",
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];
/**
 * Bitácora activity groups: prefixes of `audit.operation`. Every operation src/labels.ts names
 * belongs to at least one group (unit test). Some prefixes are forward entries for areas that
 * merge later, so their labels need no edit here: `cfdi.` (030) under Fiscal, `account.` (031)
 * under Accesos (LD-16 L7), and public ordering's `public.hold_` under Ventas and
 * `public.link_` / `public.settings` / `public.paused` / `public.resumed` under Configuración
 * (LD-18 LD-P4), and the platform's `job.` operator commands (job.cancelled, job.requeued,
 * labelled on integration) under Configuración (LD-21). A prefix may sit in two groups (`fiscal.profile` is fiscal and a setting).
 */
export const AUDIT_GROUPS = {
  sales: [
    "order.created",
    "order.round",
    "order.note",
    "payment.",
    "settlement.",
    "check.",
    "receipt.",
    "service.",
    "offline.synced",
    "offline.payment_attempt_",
    "public.hold_",
  ],
  kitchen: ["kitchen.", "offline.kitchen"],
  cash: ["cash."],
  corrections: [
    "order.void",
    "refund.",
    "discount.applied",
    "discount.reversed",
    "offline.reconciled",
    "offline.payment_reconciled",
    "offline.archived",
  ],
  menu: [
    "catalog.",
    "menu.",
    "stock.",
    "prep",
    "import.",
    "expense",
    "floor.",
    "offline.stock_reviewed",
  ],
  access: ["access.", "employee.", "invitation.", "shift.", "account."],
  settings: [
    "restaurant.",
    "plan.",
    "discount.controls",
    "fiscal.profile",
    "offline.settings_changed",
    "public.link_",
    "public.settings",
    "public.paused",
    "public.resumed",
    "job.",
  ],
  fiscal: ["fiscal.", "cfdi."],
  reports: ["reports."],
} as const;
export type AuditGroup = keyof typeof AUDIT_GROUPS;
export const AUDIT_GROUP_KEYS = Object.keys(AUDIT_GROUPS) as [
  AuditGroup,
  ...AuditGroup[],
];

/** Escapes LIKE's wildcards (`_`, `%`) and its default escape character (`\`). */
export function escapeLike(text: string): string {
  return text.replace(/[\\_%]/g, (c) => "\\" + c);
}

/** The activity groups whose prefixes match `operation` (none for an unknown operation). */
export function auditGroupsOf(operation: string): AuditGroup[] {
  return AUDIT_GROUP_KEYS.filter((g) =>
    AUDIT_GROUPS[g].some((p) => operation.startsWith(p)),
  );
}

/** LIKE patterns: each prefix escaped for _ and % and suffixed with %. */
export function auditGroupPrefixes(group: AuditGroup): string[] {
  const prefixes = Object.hasOwn(AUDIT_GROUPS, group)
    ? AUDIT_GROUPS[group]
    : undefined;
  if (!prefixes) throw invalidInput();
  return prefixes.map((p) => escapeLike(p) + "%");
}

/**
 * The exceptions query's `kinds` filter: a comma list of EXCEPTION_KINDS (deduplicated, in
 * catalog order). Absent or empty means every kind; any unknown kind is invalid_input.
 */
export function parseExceptionKinds(raw: string | undefined): ExceptionKind[] {
  if (raw === undefined || raw === "") return [...EXCEPTION_KINDS];
  const wanted = raw.split(",").map((k) => k.trim());
  if (wanted.some((k) => !(EXCEPTION_KINDS as readonly string[]).includes(k)))
    throw invalidInput();
  return EXCEPTION_KINDS.filter((k) => wanted.includes(k));
}

// ---------------------------------------------------------------------------------------------
// Query and command schemas (query values arrive as strings)
// ---------------------------------------------------------------------------------------------

const q = z.string().max(40);
export const summaryQuery = z.object({ from: q, to: q }).strict();
export const breakdownQuery = z
  .object({ from: q, to: q, by: z.enum(BREAKDOWNS) })
  .strict();
const cursor = z.string().max(400).optional();
const limit = (max: number, dflt: number) =>
  z.coerce.number().int().min(1).max(max).default(dflt);
export const orderListQuery = z
  .object({
    from: q,
    to: q,
    state: z.enum(["open", "paid", "closed"]).optional(),
    employee: id.optional(),
    channel: z.enum(["pos", "qr", "kiosk", "offline"]).optional(),
    cursor,
    limit: limit(LIMITS.pageMax, 200),
  })
  .strict();
export const tenderListQuery = z
  .object({
    from: q,
    to: q,
    method: z.enum(["cash", "external"]).optional(),
    drawer: id.optional(),
    cursor,
    limit: limit(LIMITS.pageMax, 200),
  })
  .strict();
export const exceptionQuery = z
  .object({
    from: q,
    to: q,
    kinds: z.string().max(400).optional(), // comma list, parseExceptionKinds()
    employee: id.optional(),
    cursor,
    limit: limit(LIMITS.pageMax, 100),
  })
  .strict();
export const auditQuery = z
  .object({
    from: q,
    to: q,
    employee: id.optional(),
    group: z.enum(AUDIT_GROUP_KEYS).optional(),
    order: z.coerce.number().int().min(1).max(999999).optional(),
    cursor,
    limit: limit(LIMITS.pageMax, 100),
  })
  .strict();
export const drawerListQuery = summaryQuery;
export const cortePrintInput = z
  .object({ operationId: id, kind: z.enum(["x", "z"]) })
  .strict();
export const dayCortePrintInput = z.object({ operationId: id }).strict();
export const remoteCloseInput = z
  .object({
    operationId: id,
    counted: money,
    reason: z.string().trim().min(3).max(300),
    externalReported: money.nullable().optional(),
  })
  .strict();
export type OrderListQuery = z.infer<typeof orderListQuery>;
export type TenderListQuery = z.infer<typeof tenderListQuery>;
export type ExceptionQuery = z.infer<typeof exceptionQuery>;
export type AuditQuery = z.infer<typeof auditQuery>;
export type CortePrintInput = z.infer<typeof cortePrintInput>;
export type RemoteCloseInput = z.infer<typeof remoteCloseInput>;

// ---------------------------------------------------------------------------------------------
// Keyset cursors
// ---------------------------------------------------------------------------------------------

/**
 * PostgreSQL `timestamptz::text` (DateStyle ISO: "2026-10-05 15:40:12.123456+00") or the same
 * instant in ISO form. The cursor carries the text, so rows that share a millisecond are never
 * skipped: SQL compares `(at, id) < (cursor.t::timestamptz, cursor.i::uuid)` at full precision.
 */
const CURSOR_TIME =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2}){0,2})$/;
const cursorShape = z
  .object({
    t: z
      .string()
      .max(40)
      .regex(CURSOR_TIME)
      .refine((t) => {
        try {
          Temporal.Instant.from(t);
          return true;
        } catch {
          return false;
        }
      }),
    i: id,
    k: z.enum(EXCEPTION_KINDS).optional(),
  })
  .strict();
export type ReportCursor = { t: string; i: string; k?: ExceptionKind };

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function fromBase64Url(text: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1)
    throw invalidInput();
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (c) => c.charCodeAt(0)),
  );
}

/** Keyset cursor: base64url(JSON {t: timestamptz text with microseconds, i: uuid, k?: kind}). */
export function encodeReportCursor(c: ReportCursor): string {
  const parsed = cursorShape.safeParse(c);
  if (!parsed.success) throw new RangeError("invalid_cursor");
  const { t, i, k } = parsed.data;
  return toBase64Url(JSON.stringify(k === undefined ? { t, i } : { t, i, k }));
}

/** Decodes a client-supplied cursor; anything malformed is DomainError("invalid_input"). */
export function decodeReportCursor(s: string): ReportCursor {
  if (typeof s !== "string" || s.length > 400) throw invalidInput();
  let value: unknown;
  try {
    value = JSON.parse(fromBase64Url(s));
  } catch {
    throw invalidInput();
  }
  const parsed = cursorShape.safeParse(value);
  if (!parsed.success) throw invalidInput();
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Integer arithmetic
// ---------------------------------------------------------------------------------------------

function int(n: number, what = "amount"): bigint {
  if (!Number.isSafeInteger(n)) throw new RangeError(`invalid_${what}`);
  return BigInt(n);
}
/** Floor division (toward −∞) on BigInt, which itself truncates toward 0. */
function floorDiv(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
}
function safe(n: bigint): number {
  const value = Number(n);
  if (!Number.isSafeInteger(value)) throw new RangeError("invalid_amount");
  return value;
}

/** round_half_up(total / orders), exact for any safe integers; 0 when there are no orders. */
export const averageTicket = (total: number, orders: number): number => {
  const t = int(total);
  const n = int(orders, "count");
  return n > 0n ? safe(floorDiv(2n * t + n, 2n * n)) : 0;
};

/** floor(10000 × part / whole) in basis points; 0 for an empty whole. */
export const bps = (part: number, whole: number): number => {
  const p = int(part);
  const w = int(whole);
  return w > 0n ? safe(floorDiv(p * 10000n, w)) : 0;
};

function add(a: number, b: number): number {
  const n = a + b;
  if (!Number.isSafeInteger(n)) throw new RangeError("invalid_amount");
  return n;
}
function sumBy<T>(rows: readonly T[], pick: (row: T) => number): number {
  let total = 0;
  for (const row of rows) {
    const value = pick(row);
    if (!Number.isSafeInteger(value)) throw new RangeError("invalid_amount");
    total = add(total, value);
  }
  return total;
}

const DECIMAL_INTEGER = /^-?\d{1,16}$/;
/**
 * One SQL aggregate as a safe integer. postgres.js returns `int8` and `numeric` columns as
 * strings (and as `bigint` when the BigInt type is registered), and the S1–S5 sums are `::int8`,
 * so the server maps every aggregate through this before calling the core. Anything that is not
 * an integer within ±(2^53 − 1) is RangeError("invalid_amount"): never a silent rounding.
 */
export function aggregateInt(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "bigint"
        ? Number(value)
        : typeof value === "string" && DECIMAL_INTEGER.test(value)
          ? Number(value)
          : Number.NaN;
  // A string or bigint beyond ±(2^53 − 1) converts to a number of magnitude ≥ 2^53, never safe.
  if (!Number.isSafeInteger(n)) throw new RangeError("invalid_amount");
  return n === 0 ? 0 : n; // never −0
}

// ---------------------------------------------------------------------------------------------
// Wire types (JSON; every amount is an integer in minor units)
// ---------------------------------------------------------------------------------------------

export type TenderMethod = "cash" | "external";
export const TENDER_METHODS: readonly TenderMethod[] = ["cash", "external"];
export type MethodTotals = {
  method: TenderMethod;
  count: number;
  amount: number;
  tips: number;
  refunds: number;
  refundCount: number;
  net: number;
};
export type SalesMetrics = {
  orders: number;
  cancelledOrders: number;
  cancelledAmount: number;
  grossSales: number;
  discounts: number;
  courtesies: number;
  salesTotal: number;
  averageTicket: number;
  offlineSales: { count: number; total: number; tips: number };
  voids: { amount: number; units: number };
  ticketed: { count: number; gross: number };
  unticketed: { openBalance: number; paidWithoutTicket: number };
  paidOnSales: number;
  outstanding: number;
  openChecks: number;
  tipsOnSales: number;
  cogs: number;
  cogsAllOrders: number;
  costCoverageBps: number;
  wasteCost: number;
  recovery: { count: number; total: number };
};
export type RefundMetrics = {
  count: number;
  total: number;
  cash: number;
  external: number;
  restockedCost: number;
};
export type CollectionMetrics = {
  byMethod: MethodTotals[];
  collected: number;
  tips: number;
  refunds: number;
  paidOuts: number;
  paidOutCount: number;
  late: { count: number; amount: number };
};
export type MarginMetrics = {
  netSalesExTax: number | null;
  netAfterRefundsExTax: number | null;
  /** tax.totals.netGross (IVA included). */
  salesAfterRefunds: number | null;
  cogs: number;
  restockedCost: number;
  estimatedMargin: number | null;
};
export const CHECK_CODES = [
  "lines_vs_orders",
  "discounts_vs_allocations",
  "tickets_vs_orders",
  "paid_identity",
  "methods_sum",
  "refunds_vs_fiscal",
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];
export type ReconciliationCheck = {
  code: CheckCode;
  ok: boolean;
  expected: number;
  actual: number;
};
export type DayRow = {
  date: string;
  orders: number;
  grossSales: number;
  discounts: number;
  salesTotal: number;
  refunds: number;
  cash: number;
  external: number;
  tips: number;
  paidOuts: number;
};
/** Differences are amounts: shortages and overages are positive sums of each sign. */
export type DrawerSummary = {
  open: number;
  closed: number;
  differenceNet: number;
  shortages: number;
  overages: number;
  unreviewed: number;
  openFromEarlierDays: number;
};
/**
 * The summary of a business-date range. `tax` is fiscal's fiscalSummary for the range (merged over
 * ≤ 31-day chunks by mergeFiscalSummaries), or null when the restaurant issues no fiscal tickets
 * (non-MXN); the margin and the fiscal checks read its totals.
 */
export type SalesSummary = {
  range: DateRange;
  currency: string;
  generatedAt: string;
  currentBusinessDate: string;
  /** ops requestIdOf(req); "" when built outside a request. */
  requestId: string;
  sales: SalesMetrics;
  refunds: RefundMetrics;
  collections: CollectionMetrics;
  tax: FiscalSummary | null;
  margin: MarginMetrics;
  drawers: DrawerSummary;
  /** One row per business date of the range; [] when from === to. */
  days: DayRow[];
  checks: ReconciliationCheck[];
};

export type ProductRow = {
  productId: string;
  name: Label;
  categoryId: string | null;
  category: Label | null;
  categorySnapshot: boolean;
  units: number;
  grossSales: number;
  discounts: number;
  salesTotal: number;
  shareBps: number;
  cost: number | null;
  margin: number | null;
  refundedUnits: number;
  refunded: number;
};
export type CategoryRow = {
  key: string;
  categoryId: string | null;
  name: Label | null;
  snapshot: boolean;
  units: number;
  grossSales: number;
  discounts: number;
  salesTotal: number;
  shareBps: number;
  cost: number | null;
  margin: number | null;
};
/**
 * One Personal row: sales attributed to the check's assigned server, else to whoever opened it.
 * QR and kiosk orders run under the link creator's session, so an unassigned QR/kiosk order is
 * not that employee's sale: those orders form one pseudo-row with `employeeId: null` ("QR /
 * Kiosco", LD-15 reports Q4); an assigned one goes to the assignee.
 */
export type EmployeeRow = {
  employeeId: string | null;
  name: string;
  role: string;
  active: boolean;
  orders: number;
  salesTotal: number;
  averageTicket: number;
  tips: number;
  discounts: number;
};
export type HourRow = {
  hour: number;
  orders: number;
  salesTotal: number;
  averageTicket: number;
};
export type ChannelRow = {
  key: string;
  orders: number;
  salesTotal: number;
  shareBps: number;
};
export type BreakdownResponse =
  | {
      by: "product";
      rows: ProductRow[];
      recovery: { count: number; total: number };
      total: number;
    }
  | {
      by: "category";
      rows: CategoryRow[];
      recovery: { count: number; total: number };
      total: number;
    }
  | { by: "employee"; rows: EmployeeRow[]; total: number }
  | { by: "hour"; rows: HourRow[]; cutoffHour: number; total: number }
  | { by: "channel" | "mode"; rows: ChannelRow[]; total: number }
  | { by: "method"; rows: MethodTotals[]; total: number }
  | { by: "day"; rows: DayRow[]; total: number };

export type OrderReportRow = {
  id: string;
  number: number;
  businessDate: string;
  createdAt: string;
  channel: string;
  mode: string;
  tableName: string | null;
  waiterName: string | null;
  state: string;
  checkState: string;
  grossSales: number;
  discount: number;
  total: number;
  paid: number;
  outstanding: number;
  tips: number;
  refunded: number;
  folio: string | null;
};
export type TenderReportRow = {
  id: string;
  at: string;
  collectionDate: string;
  orderId: string;
  orderNumber: number;
  orderDate: string;
  method: TenderMethod;
  amount: number;
  tip: number;
  reference: string | null;
  drawerId: string | null;
  deviceName: string | null;
  refunded: number;
  offline: boolean;
  /**
   * tenders.source: "normal" or "offline_recovery" (a manager-reconciled offline payment), so
   * the Pagos list labels it with tenderMethodLabel(method, source) ("Recuperado").
   */
  source: string;
};
/**
 * One loss-prevention row. `accountId`/`accountName` are the check's server (assigned waiter,
 * else the creator): open-price lines have no per-line actor, so they are attributed there.
 */
export type ExceptionRow = {
  id: string;
  kind: ExceptionKind;
  at: string;
  businessDate: string;
  actorId: string | null;
  actorName: string | null;
  approverId: string | null;
  approverName: string | null;
  accountId: string | null;
  accountName: string | null;
  amount: number;
  orderId: string | null;
  orderNumber: number | null;
  orderDate: string | null;
  reasonCode: string | null;
  note: string;
  deviceName: string | null;
  detail: Record<string, unknown>;
};
/**
 * One Excepciones tile. For the difference kinds (`drawer_difference`, `terminal_difference`)
 * `amount` is Σ|amount|, so a shortage and an overage never cancel out, and `shortages` /
 * `overages` carry the positive sum of each sign; the other kinds have neither field.
 */
export type ExceptionTotals = {
  kind: ExceptionKind;
  count: number;
  amount: number;
  shortages?: number;
  overages?: number;
};
export type ExceptionSummary = {
  byKind: ExceptionTotals[];
  byEmployee: {
    employeeId: string;
    name: string;
    acted: Partial<Record<ExceptionKind, { count: number; amount: number }>>;
    shortages: number;
    overages: number;
    approved: { count: number; amount: number };
  }[];
};
export type AuditRow = {
  id: string;
  at: string;
  businessDate: string;
  operation: string;
  actorId: string;
  actorName: string | null;
  actorRole: string | null;
  entityId: string;
  orderNumber: number | null;
  orderDate: string | null;
  summary: { amount: number | null; reason: string | null };
  detail: unknown;
};
export type Page<T> = { rows: T[]; next: string | null };
/** `summary` is present on the first page only. */
export type ExceptionPage = Page<ExceptionRow> & {
  summary: ExceptionSummary | null;
};

export type DrawerReview = { reviewerName: string; note: string; at: string };
export type CountMode = "blind" | "visible";
/**
 * One Cortes table row. Its sales, tips and payment figures cover every tender of the drawer,
 * late ones included (the day's collections reconcile against them); lateCash / lateTerminal
 * disclose the part recorded after the close, which the corte Z leaves out. `expected`,
 * `counted` and `terminalDifference` of a closed drawer are the stored figures as of close.
 */
export type DrawerRow = {
  id: string;
  businessDate: string;
  zNumber: number | null;
  deviceId: string;
  deviceName: string;
  deviceActive: boolean;
  openedAt: string;
  openedByName: string;
  closedAt: string | null;
  closedByName: string | null;
  status: "open" | "closed";
  opening: number;
  cashSales: number;
  cashTips: number;
  cashRefunds: number;
  paidOuts: number;
  /**
   * Σ positive cash_movements. No command records one today (always 0), but expected cash adds
   * it, so the row carries it and opening + cashSales + cashTips − cashRefunds − paidOuts + payIns
   * equals the live expected cash of an open drawer.
   */
  payIns: number;
  expected: number | null;
  counted: number | null;
  difference: number | null;
  countMode: CountMode | null;
  terminalSales: number;
  terminalTips: number;
  terminalRefunds: number;
  terminalNet: number;
  terminalReported: number | null;
  terminalDifference: number | null;
  payments: number;
  /** Cash amount + tips recorded after the close (included in cashSales and cashTips). */
  lateCash: number;
  /** External amount + tips recorded after the close (included in the terminal figures). */
  lateTerminal: number;
  review: DrawerReview | null;
  needsReview: boolean;
  zPrints: number;
  orphan: boolean;
  openSinceEarlierDay: boolean;
};

export type RestaurantHeader = {
  name: string;
  currency: string;
  timezone: string;
};
export type FolioRange = {
  series: string;
  first: string;
  last: string;
  count: number;
};
export type CountAmount = { count: number; amount: number };
export type CorteControls = {
  discounts: CountAmount;
  refunds: CountAmount;
  paidOuts: CountAmount;
};
export type CorteDocument = {
  kind: "x" | "z";
  visibility: "full" | "blind";
  zNumber: number | null;
  /** Set by POST; null on the GET preview. */
  printNumber: number | null;
  restaurant: RestaurantHeader;
  drawer: {
    id: string;
    deviceName: string;
    openedAt: string;
    openedByName: string;
    closedAt: string | null;
    closedByName: string | null;
    businessDate: string;
    countMode: CountMode | null;
  };
  printedAt: string;
  printedByName: string;
  cash: null | {
    opening: number;
    sales: number;
    tips: number;
    refunds: number;
    paidOuts: number;
    /**
     * Pay-ins (Σ positive cash movements; 0 until a pay-in command exists). The printed corte shows
     * it only when ≠ 0, so opening + sales + tips − refunds − paidOuts + payIns = expected on paper.
     */
    payIns: number;
    expected: number;
    counted: number | null;
    difference: number | null;
    reason: string | null;
  };
  /** Also present in the blind variant. */
  counted: number | null;
  terminal: {
    sales: number;
    count: number;
    tips: number;
    refunds: number;
    net: number;
    reported: number | null;
    difference: number | null;
  };
  /** Cobros registrados; a corte Z counts only the tenders recorded by the close. */
  payments: number;
  controls: CorteControls | null;
  folios: FolioRange[];
  /** Cash amount + tips recorded after the close (corte Z, full variant only). */
  lateCash: number;
  /**
   * External amount + tips recorded after the close (corte Z only; also in the blind variant,
   * since every operator sees terminal figures). The terminal section excludes it.
   */
  lateTerminal: number;
  review: DrawerReview | null;
};
export type DayCorteDocument = {
  date: string;
  restaurant: RestaurantHeader;
  printedAt: string;
  printedByName: string;
  printNumber: number | null;
  /** Single-day summary (days = []). */
  summary: SalesSummary;
  drawers: DrawerRow[];
  drawersOpen: number;
  otherDayDrawerCollections: number;
  exceptions: ExceptionTotals[];
  /** cfdi (030) slot, e.g. { cfdi: CfdiCoverage }. */
  extra: Record<string, unknown>;
};
export type ReportAlert = {
  code:
    | "checks_mismatch"
    | "drawer_revoked_device"
    | "drawer_open_long"
    | "missing_tickets"
    | "drawer_unreviewed"
    | "offline_review_pending"
    | (string & {});
  count: number;
  amount?: number;
  deviceName?: string;
  since?: string;
};
export type TodaySummary = {
  businessDate: string;
  cutoff: number;
  generatedAt: string;
  summary: SalesSummary;
  lastWeek: { date: string; salesTotalUntilNow: number } | null;
  openDrawers: (Pick<
    DrawerRow,
    "id" | "deviceName" | "openedAt" | "openedByName" | "payments"
  > & { expected: number | null })[];
  /** 5, by units. */
  topProducts: ProductRow[];
  exceptions: ExceptionTotals[];
  alerts: ReportAlert[];
};

// ---------------------------------------------------------------------------------------------
// Reconciliation checks (§2.2)
// ---------------------------------------------------------------------------------------------

export type ReconciliationInput = {
  /** Σ orders.total of the sales lens. */
  salesTotal: number;
  /** Σ orders.discount of the sales lens. */
  discounts: number;
  /** Σ over lines of (remaining gross − active line discounts). */
  lineNet: number;
  /** Σ total of recovery orders (no lines). */
  recoveryTotal: number;
  /** Σ active discount allocations on non-voided units. */
  allocatedDiscounts: number;
  /** Σ orders.total of orders that have a fiscal ticket. */
  ticketedOrderTotal: number;
  /** Σ fiscal_tickets.gross of those orders. */
  ticketedGross: number;
  paidOnSales: number;
  outstanding: number;
  /** Orders whose tenders exceed their total (service invariant: none). */
  overpaidOrders: number;
  byMethod: readonly { amount: number; tips: number }[];
  collected: number;
  tips: number;
  /** Σ refunds.amount in the refund lens with created_at ≥ fiscal_epoch(). */
  fiscalRefunds: number;
  /** fiscalSummary totals; null when fiscal issues no tickets (non-MXN). */
  fiscal: { gross: number; refundGross: number } | null;
};

/**
 * The six checks of §2.2 from the aggregated numbers, in CHECK_CODES order. `expected` is the
 * record side (orders, tenders, refunds) and `actual` the derived side. The fiscal codes are
 * skipped (absent) when `fiscal` is null.
 */
export function reconciliationChecks(
  i: ReconciliationInput,
): ReconciliationCheck[] {
  const checks: ReconciliationCheck[] = [];
  const push = (
    code: CheckCode,
    expected: number,
    actual: number,
    ok = expected === actual,
  ) => checks.push({ code, ok, expected, actual });
  push("lines_vs_orders", i.salesTotal, add(i.lineNet, i.recoveryTotal));
  push("discounts_vs_allocations", i.discounts, i.allocatedDiscounts);
  if (i.fiscal)
    push(
      "tickets_vs_orders",
      i.ticketedOrderTotal,
      i.ticketedGross !== i.ticketedOrderTotal
        ? i.ticketedGross
        : i.fiscal.gross,
      i.ticketedGross === i.ticketedOrderTotal &&
        i.fiscal.gross === i.ticketedOrderTotal,
    );
  const paid = add(i.paidOnSales, i.outstanding);
  push(
    "paid_identity",
    i.salesTotal,
    paid,
    paid === i.salesTotal && i.overpaidOrders === 0 && i.outstanding >= 0,
  );
  const methodAmounts = sumBy(i.byMethod, (m) => m.amount);
  const methodTips = sumBy(i.byMethod, (m) => m.tips);
  if (methodAmounts !== i.collected)
    push("methods_sum", i.collected, methodAmounts);
  else push("methods_sum", i.tips, methodTips);
  if (i.fiscal)
    push("refunds_vs_fiscal", i.fiscalRefunds, i.fiscal.refundGross);
  return checks;
}

/** Codes of the failed checks, for the log line, the Hoy alert and the UI. */
export function failedCheckCodes(checks: readonly ReconciliationCheck[]) {
  return checks.filter((c) => !c.ok).map((c) => c.code);
}

// ---------------------------------------------------------------------------------------------
// Metric composition: aggregates per business date → SalesSummary (§2.2, §4.5 S1–S5)
// ---------------------------------------------------------------------------------------------

/** S1: the sales lens of one order business date. */
export type SalesDayAggregate = {
  date: string;
  /** count(*) filter (where total > 0) */
  orders: number;
  /** count(*) filter (where state = 'cancelled') */
  cancelled: number;
  recoveryCount: number;
  recoveryTotal: number;
  /** Σ(total + discount) of ticketed recovery orders: part of the coverage denominator. */
  ticketedRecoveryGross: number;
  /**
   * Σ orders.discount and Σ orders.total. Ventas brutas is not an input: composeSalesSummary
   * derives it as `total + discounts` (§2.2 `grossSales = Σ(total + discount)`), per day and for
   * the range, so `grossSales − discounts = salesTotal` holds by construction. The S1 `gross`
   * column is therefore not read.
   */
  discounts: number;
  total: number;
  /** Σ tenders.amount of these orders, any collection date. */
  paid: number;
  /** Σ tenders.tip of these orders. */
  tips: number;
  openChecks: number;
  overpaid: number;
  ticketed: number;
  ticketedGross: number;
  ticketedOrderTotal: number;
  unticketedOpen: number;
  unticketedPaid: number;
  offlineCount: number;
  offlineTotal: number;
  offlineTips: number;
};
/** S2: line facts of one order business date. */
export type LineDayAggregate = {
  date: string;
  /** Σ(line total − voided amount − active discount allocations). */
  lineNet: number;
  voided: number;
  voidedUnits: number;
  cancelledAmount: number;
  lineDiscounts: number;
  courtesies: number;
  /** Σ unit cost × remaining units, ticketed orders, lines with a cost. */
  cogs: number;
  /** The same over all orders. */
  cogsAll: number;
  /** Σ remaining gross of ticketed lines with a cost. */
  coveredGross: number;
  /** Σ remaining gross of ticketed lines. */
  ticketedLineGross: number;
  /** Σ unit cost × voided units not returned to stock. */
  wasteCost: number;
};
/** S3: tenders of one collection date and method. */
export type CollectionDayAggregate = {
  date: string;
  method: TenderMethod;
  count: number;
  amount: number;
  tips: number;
  /** Tenders whose sale-day collection date precedes the day they were recorded. */
  lateCount: number;
  lateAmount: number;
};
/** S4: refunds of one refund date and method. */
export type RefundDayAggregate = {
  date: string;
  method: TenderMethod;
  count: number;
  amount: number;
  /** The part created at or after fiscal_epoch(). */
  fiscalAmount: number;
};
/** S4b: cost returned to stock by item refunds of one refund date. */
export type RestockDayAggregate = { date: string; restockedCost: number };
/** S5: paid-outs of one movement date; `amount` is positive. */
export type PaidOutDayAggregate = {
  date: string;
  count: number;
  amount: number;
};
/** The fiscalSummary totals the margin and the fiscal checks read. */
export type FiscalTotals = Pick<
  FiscalSummary["totals"],
  "gross" | "base" | "refundGross" | "netGross" | "netBase"
>;
export type SummaryInput = {
  range: DateRange;
  currency: string;
  generatedAt: string;
  currentBusinessDate: string;
  requestId?: string;
  sales: readonly SalesDayAggregate[];
  lines: readonly LineDayAggregate[];
  collections: readonly CollectionDayAggregate[];
  refunds: readonly RefundDayAggregate[];
  restocks: readonly RestockDayAggregate[];
  paidOuts: readonly PaidOutDayAggregate[];
  drawers: readonly DrawerRow[];
  /**
   * fiscalSummary for the range (null: no fiscal tickets, non-MXN). It becomes SalesSummary.tax,
   * and its totals drive the margin and the fiscal checks.
   */
  tax?: FiscalSummary | null;
  /**
   * Only the totals, for callers that have no full FiscalSummary (unit fixtures). When `tax` is
   * given too, both must agree (RangeError("fiscal_totals_mismatch")).
   */
  fiscal?: FiscalTotals | null;
};

/** The fiscalSummary totals the margin and the fiscal checks read. */
export function fiscalTotals(tax: FiscalSummary): FiscalTotals {
  const t = tax.totals;
  return {
    gross: t.gross,
    base: t.base,
    refundGross: t.refundGross,
    netGross: t.netGross,
    netBase: t.netBase,
  };
}
function summaryFiscal(input: SummaryInput): FiscalTotals | null {
  const fromTax = input.tax ? fiscalTotals(input.tax) : null;
  if (input.fiscal === undefined) return fromTax;
  if (input.tax === undefined) return input.fiscal;
  const same =
    fromTax === null || input.fiscal === null
      ? fromTax === input.fiscal
      : (Object.keys(fromTax) as (keyof FiscalTotals)[]).every(
          (k) => fromTax[k] === input.fiscal![k],
        );
  if (!same) throw new RangeError("fiscal_totals_mismatch");
  return fromTax;
}

function assertInRange(range: DateRange, rows: readonly { date: string }[]) {
  for (const row of rows)
    if (
      !isBusinessDate(row.date) ||
      row.date < range.from ||
      row.date > range.to
    )
      throw new RangeError("aggregate_outside_range");
}

/** One summary with one implementation per metric; see the §2.2 metric contract. */
export function composeSalesSummary(input: SummaryInput): SalesSummary {
  const range = parseRange(input.range, Number.MAX_SAFE_INTEGER);
  const { sales: s, lines: l, collections: c, refunds: r } = input;
  for (const rows of [s, l, c, r, input.restocks, input.paidOuts])
    assertInRange(range, rows);

  const salesTotal = sumBy(s, (x) => x.total);
  const discounts = sumBy(s, (x) => x.discounts);
  const orders = sumBy(s, (x) => x.orders);
  const paidOnSales = sumBy(s, (x) => x.paid);
  const sales: SalesMetrics = {
    orders,
    cancelledOrders: sumBy(s, (x) => x.cancelled),
    cancelledAmount: sumBy(l, (x) => x.cancelledAmount),
    // §2.2: Ventas brutas − Descuentos = Ventas totales, by construction.
    grossSales: add(salesTotal, discounts),
    discounts,
    courtesies: sumBy(l, (x) => x.courtesies),
    salesTotal,
    averageTicket: averageTicket(salesTotal, orders),
    offlineSales: {
      count: sumBy(s, (x) => x.offlineCount),
      total: sumBy(s, (x) => x.offlineTotal),
      tips: sumBy(s, (x) => x.offlineTips),
    },
    voids: {
      amount: sumBy(l, (x) => x.voided),
      units: sumBy(l, (x) => x.voidedUnits),
    },
    ticketed: {
      count: sumBy(s, (x) => x.ticketed),
      gross: sumBy(s, (x) => x.ticketedGross),
    },
    unticketed: {
      openBalance: sumBy(s, (x) => x.unticketedOpen),
      paidWithoutTicket: sumBy(s, (x) => x.unticketedPaid),
    },
    paidOnSales,
    outstanding: salesTotal - paidOnSales,
    openChecks: sumBy(s, (x) => x.openChecks),
    tipsOnSales: sumBy(s, (x) => x.tips),
    cogs: sumBy(l, (x) => x.cogs),
    cogsAllOrders: sumBy(l, (x) => x.cogsAll),
    costCoverageBps: bps(
      sumBy(l, (x) => x.coveredGross),
      add(
        sumBy(l, (x) => x.ticketedLineGross),
        sumBy(s, (x) => x.ticketedRecoveryGross),
      ),
    ),
    wasteCost: sumBy(l, (x) => x.wasteCost),
    recovery: {
      count: sumBy(s, (x) => x.recoveryCount),
      total: sumBy(s, (x) => x.recoveryTotal),
    },
  };

  const restockedCost = sumBy(input.restocks, (x) => x.restockedCost);
  const refundsOf = (m: TenderMethod) => r.filter((x) => x.method === m);
  const refunds: RefundMetrics = {
    count: sumBy(r, (x) => x.count),
    total: sumBy(r, (x) => x.amount),
    cash: sumBy(refundsOf("cash"), (x) => x.amount),
    external: sumBy(refundsOf("external"), (x) => x.amount),
    restockedCost,
  };

  const byMethod: MethodTotals[] = TENDER_METHODS.map((method) => {
    const rows = c.filter((x) => x.method === method);
    const amount = sumBy(rows, (x) => x.amount);
    const tips = sumBy(rows, (x) => x.tips);
    const refunded = sumBy(refundsOf(method), (x) => x.amount);
    return {
      method,
      count: sumBy(rows, (x) => x.count),
      amount,
      tips,
      refunds: refunded,
      refundCount: sumBy(refundsOf(method), (x) => x.count),
      net: add(amount, tips) - refunded,
    };
  });
  const collections: CollectionMetrics = {
    byMethod,
    collected: sumBy(c, (x) => x.amount),
    tips: sumBy(c, (x) => x.tips),
    refunds: refunds.total,
    paidOuts: sumBy(input.paidOuts, (x) => x.amount),
    paidOutCount: sumBy(input.paidOuts, (x) => x.count),
    late: {
      count: sumBy(c, (x) => x.lateCount),
      amount: sumBy(c, (x) => x.lateAmount),
    },
  };

  const f = summaryFiscal(input);
  const margin: MarginMetrics = {
    netSalesExTax: f ? f.base : null,
    netAfterRefundsExTax: f ? f.netBase : null,
    salesAfterRefunds: f ? f.netGross : null,
    cogs: sales.cogs,
    restockedCost,
    estimatedMargin: f ? add(f.netBase - sales.cogs, restockedCost) : null,
  };

  const on = <T extends { date: string }>(rows: readonly T[], date: string) =>
    rows.filter((x) => x.date === date);
  const days: DayRow[] =
    range.from === range.to
      ? []
      : rangeDates(range).map((date) => {
          const day = on(s, date);
          const collected = on(c, date);
          const dayTotal = sumBy(day, (x) => x.total);
          const dayDiscounts = sumBy(day, (x) => x.discounts);
          return {
            date,
            orders: sumBy(day, (x) => x.orders),
            grossSales: add(dayTotal, dayDiscounts),
            discounts: dayDiscounts,
            salesTotal: dayTotal,
            refunds: sumBy(on(r, date), (x) => x.amount),
            cash: sumBy(
              collected.filter((x) => x.method === "cash"),
              (x) => x.amount,
            ),
            external: sumBy(
              collected.filter((x) => x.method === "external"),
              (x) => x.amount,
            ),
            tips: sumBy(collected, (x) => x.tips),
            paidOuts: sumBy(on(input.paidOuts, date), (x) => x.amount),
          };
        });

  const checks = reconciliationChecks({
    salesTotal,
    discounts: sales.discounts,
    lineNet: sumBy(l, (x) => x.lineNet),
    recoveryTotal: sales.recovery.total,
    allocatedDiscounts: sumBy(l, (x) => x.lineDiscounts),
    ticketedOrderTotal: sumBy(s, (x) => x.ticketedOrderTotal),
    ticketedGross: sales.ticketed.gross,
    paidOnSales,
    outstanding: sales.outstanding,
    overpaidOrders: sumBy(s, (x) => x.overpaid),
    byMethod,
    collected: collections.collected,
    tips: collections.tips,
    fiscalRefunds: sumBy(r, (x) => x.fiscalAmount),
    fiscal: f ? { gross: f.gross, refundGross: f.refundGross } : null,
  });

  return {
    range,
    currency: input.currency,
    generatedAt: input.generatedAt,
    currentBusinessDate: input.currentBusinessDate,
    requestId: input.requestId ?? "",
    sales,
    refunds,
    collections,
    tax: input.tax ?? null,
    margin,
    drawers: drawerSummary(drawersUpTo(input.drawers, range.to)),
    days,
    checks,
  };
}

// ---------------------------------------------------------------------------------------------
// Fiscal figures over long ranges (§4.5 fiscalForRange)
// ---------------------------------------------------------------------------------------------

/** fiscalSummary accepts ranges of at most 31 days; reports reads longer ranges in chunks. */
export const FISCAL_CHUNK_DAYS = 31;

/** Consecutive, non-overlapping sub-ranges of at most `days` days that cover `range` in order. */
export function rangeChunks(
  range: DateRange,
  days: number = FISCAL_CHUNK_DAYS,
): DateRange[] {
  if (!Number.isSafeInteger(days) || days < 1)
    throw new RangeError("invalid_chunk_days");
  const { from, to } = parseRange(range, Number.MAX_SAFE_INTEGER);
  const chunks: DateRange[] = [];
  for (let start = from; start <= to; start = addDays(start, days)) {
    const end = addDays(start, days - 1);
    chunks.push({ from: start, to: end < to ? end : to });
  }
  return chunks;
}

function mergeCategories(lists: readonly (readonly CategoryTotals[])[]) {
  return TAX_CATEGORIES.flatMap((category): CategoryTotals[] => {
    const rows = lists.flatMap((list) =>
      list.filter((c) => c.category === category),
    );
    if (!rows.length) return [];
    const rates = new Set(rows.map((r) => r.rateBps));
    if (rates.size !== 1) throw new RangeError("fiscal_rate_mismatch");
    return [
      {
        category,
        rateBps: rows[0].rateBps,
        grossBeforeDiscount: sumBy(rows, (r) => r.grossBeforeDiscount),
        discount: sumBy(rows, (r) => r.discount),
        gross: sumBy(rows, (r) => r.gross),
        base: sumBy(rows, (r) => r.base),
        tax: sumBy(rows, (r) => r.tax),
      },
    ];
  });
}

/**
 * One FiscalSummary from the summaries of consecutive chunks (fiscalForRange calls fiscalSummary
 * per ≤ 31-day chunk). Categories sum per category in fiscal order (iva16, iva8, iva0, exempt);
 * folio series merge per series (first = min, last = max, count = Σ); totals, ticket counts and
 * missing tickets sum (the chunks' dates are disjoint); from/to are the outer bounds. The parts
 * must be in date order, each starting the day after the previous one ends.
 */
export function mergeFiscalSummaries(
  parts: readonly FiscalSummary[],
): FiscalSummary {
  if (!parts.length) throw new RangeError("no_fiscal_parts");
  for (let i = 0; i < parts.length; i++) {
    parseRange(parts[i], Number.MAX_SAFE_INTEGER);
    if (i > 0 && parts[i].from !== addDays(parts[i - 1].to, 1))
      throw new RangeError("fiscal_parts_not_consecutive");
  }
  const seriesNames = [
    ...new Set(parts.flatMap((p) => p.tickets.series.map((x) => x.series))),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const series = seriesNames.map((name) => {
    const runs = parts.flatMap((p) =>
      p.tickets.series.filter((x) => x.series === name),
    );
    for (const r of runs)
      if (
        !Number.isSafeInteger(r.first) ||
        !Number.isSafeInteger(r.last) ||
        r.first > r.last
      )
        throw new RangeError("invalid_folio_run");
    return {
      series: name,
      first: Math.min(...runs.map((r) => r.first)),
      last: Math.max(...runs.map((r) => r.last)),
      count: sumBy(runs, (r) => r.count),
    };
  });
  const total = (k: keyof FiscalSummary["totals"]) =>
    sumBy(parts, (p) => p.totals[k]);
  return {
    from: parts[0].from,
    to: parts[parts.length - 1].to,
    tickets: { count: sumBy(parts, (p) => p.tickets.count), series },
    sales: mergeCategories(parts.map((p) => p.sales)),
    refunds: mergeCategories(parts.map((p) => p.refunds)),
    net: mergeCategories(parts.map((p) => p.net)),
    totals: {
      gross: total("gross"),
      base: total("base"),
      tax: total("tax"),
      tips: total("tips"),
      refundGross: total("refundGross"),
      refundTax: total("refundTax"),
      netGross: total("netGross"),
      netBase: total("netBase"),
      netTax: total("netTax"),
    },
    missingTickets: sumBy(parts, (p) => p.missingTickets),
  };
}

// ---------------------------------------------------------------------------------------------
// Breakdown and exception helpers
// ---------------------------------------------------------------------------------------------

/**
 * Hour rows in business-day order: from the cutoff hour (04, 05, … 03), with zero rows filled
 * between the first and the last active hour. Duplicate hours (none from SQL) are merged.
 */
export function hourRows(
  rows: readonly { hour: number; orders: number; salesTotal: number }[],
  cutoff: number,
): HourRow[] {
  assertCutoff(cutoff);
  const start = Math.floor(cutoff / 60);
  const byHour = new Map<number, { orders: number; salesTotal: number }>();
  for (const row of rows) {
    if (!Number.isInteger(row.hour) || row.hour < 0 || row.hour > 23)
      throw new RangeError("invalid_hour");
    const seen = byHour.get(row.hour) ?? { orders: 0, salesTotal: 0 };
    byHour.set(row.hour, {
      orders: add(seen.orders, row.orders),
      salesTotal: add(seen.salesTotal, row.salesTotal),
    });
  }
  const position = (hour: number) => (hour - start + 24) % 24;
  const active = [...byHour]
    .filter(([, r]) => r.orders > 0 || r.salesTotal !== 0)
    .map(([hour]) => position(hour));
  if (!active.length) return [];
  const out: HourRow[] = [];
  for (let k = Math.min(...active); k <= Math.max(...active); k++) {
    const hour = (start + k) % 24;
    const r = byHour.get(hour) ?? { orders: 0, salesTotal: 0 };
    out.push({
      hour,
      orders: r.orders,
      salesTotal: r.salesTotal,
      averageTicket: averageTicket(r.salesTotal, r.orders),
    });
  }
  return out;
}

/** The signed difference kinds: their amounts are summed by magnitude (see ExceptionTotals). */
export const DIFFERENCE_KINDS: readonly ExceptionKind[] = [
  "drawer_difference",
  "terminal_difference",
];
const isDifferenceKind = (kind: ExceptionKind) =>
  DIFFERENCE_KINDS.includes(kind);
/** What one row adds to a total of its kind: its magnitude for a difference kind. */
const exceptionMagnitude = (row: Pick<ExceptionRow, "kind" | "amount">) =>
  isDifferenceKind(row.kind) ? Math.abs(row.amount) : row.amount;

/** Totals per exception kind, only kinds with rows, in EXCEPTION_KINDS order. */
export function exceptionTotals(
  rows: readonly Pick<ExceptionRow, "kind" | "amount">[],
): ExceptionTotals[] {
  return EXCEPTION_KINDS.flatMap((kind): ExceptionTotals[] => {
    const of = rows.filter((r) => r.kind === kind);
    if (!of.length) return [];
    const total = {
      kind,
      count: of.length,
      amount: sumBy(of, exceptionMagnitude),
    };
    if (!isDifferenceKind(kind)) return [total];
    return [
      {
        ...total,
        shortages: sumBy(
          of.filter((r) => r.amount < 0),
          (r) => -r.amount,
        ),
        overages: sumBy(
          of.filter((r) => r.amount > 0),
          (r) => r.amount,
        ),
      },
    ];
  });
}

/**
 * The Excepciones summary. `acted` groups by the actor, or, for open-price lines (no per-line
 * actor), by the check's server; its amounts follow exceptionTotals (difference kinds by
 * magnitude), and drawer differences also split into shortage and overage amounts. `approved`
 * groups by the approver (a drawer difference's approver is its reviewer) and sums absolute
 * amounts, so a reviewed shortage and overage never cancel out. A self-approval (approver = the
 * row's actor, e.g. a manager voiding on their own recent PIN) keeps its approver on the row but
 * is not counted as an approval given (LD-16 L3).
 */
export function exceptionSummary(
  rows: readonly ExceptionRow[],
): ExceptionSummary {
  type Entry = ExceptionSummary["byEmployee"][number];
  const entries = new Map<string, Entry>();
  const entry = (employeeId: string, name: string | null) => {
    let e = entries.get(employeeId);
    if (!e) {
      e = {
        employeeId,
        name: name ?? "",
        acted: {},
        shortages: 0,
        overages: 0,
        approved: { count: 0, amount: 0 },
      };
      entries.set(employeeId, e);
    } else if (!e.name && name) e.name = name;
    return e;
  };
  for (const row of rows) {
    if (!Number.isSafeInteger(row.amount))
      throw new RangeError("invalid_amount");
    const openPrice = row.kind === "open_price";
    const actorId = openPrice ? row.accountId : row.actorId;
    if (actorId) {
      const e = entry(actorId, openPrice ? row.accountName : row.actorName);
      const acted = e.acted[row.kind] ?? { count: 0, amount: 0 };
      e.acted[row.kind] = {
        count: acted.count + 1,
        amount: add(acted.amount, exceptionMagnitude(row)),
      };
      if (row.kind === "drawer_difference") {
        if (row.amount < 0) e.shortages = add(e.shortages, -row.amount);
        else e.overages = add(e.overages, row.amount);
      }
    }
    // LD-16 L3: a self-approved row (a manager acting alone) shows the approver's name, but only
    // cross-person approvals count in the per-approver "Autorizó" summary.
    if (row.approverId && row.approverId !== actorId) {
      const e = entry(row.approverId, row.approverName);
      e.approved = {
        count: e.approved.count + 1,
        amount: add(e.approved.amount, Math.abs(row.amount)),
      };
    }
  }
  return {
    byKind: exceptionTotals(rows),
    byEmployee: [...entries.values()].sort(
      (a, b) =>
        a.name.localeCompare(b.name, "es") ||
        (a.employeeId < b.employeeId
          ? -1
          : a.employeeId > b.employeeId
            ? 1
            : 0),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Drawers and cortes (§2.6, §4.5 cortes.ts, §4.7)
// ---------------------------------------------------------------------------------------------

/** "short" (faltante) below zero, "over" (sobrante) above, "exact" (cuadra) at zero. */
export function differenceKind(n: number): "short" | "over" | "exact" {
  if (!Number.isSafeInteger(n)) throw new RangeError("invalid_amount");
  return n < 0 ? "short" : n > 0 ? "over" : "exact";
}

/**
 * Everything the drawer statement (§4.5 drawerList) and the corte loader read about one drawer.
 * Sums are over the drawer's own tenders, refunds and movements.
 */
export type DrawerFacts = {
  id: string;
  businessDate: string;
  zNumber: number | null;
  deviceId: string;
  deviceName: string;
  deviceActive: boolean;
  deviceRevoked: boolean;
  openedAt: string;
  openedByName: string;
  closedAt: string | null;
  closedByName: string | null;
  opening: number;
  /**
   * Sums over every tender of the drawer; the `late*` parts are the tenders with
   * `created_at > closed_at` (always 0 while open), which a corte Z leaves out of its "as of
   * close" figures and discloses as "Registrado después del cierre".
   */
  cash: {
    count: number;
    amount: number;
    tips: number;
    refunds: number;
    /** Cash tenders recorded after the close (offline late recovery). */
    lateCount: number;
    lateAmount: number;
    lateTips: number;
  };
  external: {
    count: number;
    amount: number;
    tips: number;
    refunds: number;
    /** External tenders recorded after the close (offline terminal sales synced late, LD-7). */
    lateCount: number;
    lateAmount: number;
    lateTips: number;
  };
  /** −Σ negative cash_movements (positive amount). */
  paidOuts: CountAmount;
  /** Σ positive cash_movements (no command records one today). */
  payIns: number;
  /** cash_sessions columns written at the close; all null while open. */
  stored: {
    expected: number | null;
    counted: number | null;
    reason: string | null;
    countMode: CountMode | null;
    externalExpected: number | null;
    externalReported: number | null;
  };
  review: DrawerReview | null;
  zPrints: number;
};

/** The live expected cash of a drawer (discounts' drawerTotals formula). */
export function liveExpectedCash(f: DrawerFacts): number {
  return add(
    add(f.opening, add(f.cash.amount, f.cash.tips)) -
      add(f.cash.refunds, f.paidOuts.amount),
    f.payIns,
  );
}
function terminalNet(f: DrawerFacts): number {
  return add(f.external.amount, f.external.tips) - f.external.refunds;
}
/** External amount + tips recorded after the close; 0 while the drawer is open. */
function lateTerminal(f: DrawerFacts): number {
  return f.closedAt === null
    ? 0
    : add(f.external.lateAmount, f.external.lateTips);
}
/** The terminal net as of close (the whole net while the drawer is open). */
function terminalNetAsOfClose(f: DrawerFacts): number {
  return terminalNet(f) - lateTerminal(f);
}
function terminalDifference(f: DrawerFacts): number | null {
  const reported = f.stored.externalReported;
  return f.closedAt === null || reported === null
    ? null
    : reported - (f.stored.externalExpected ?? terminalNetAsOfClose(f));
}
function storedDifference(f: DrawerFacts): number | null {
  return f.closedAt === null ||
    f.stored.counted === null ||
    f.stored.expected === null
    ? null
    : f.stored.counted - f.stored.expected;
}

/** One Cortes table row. Expected cash of an open drawer is null for viewers who may not see it. */
export function drawerRow(
  f: DrawerFacts,
  ctx: { canSeeExpected: boolean; currentBusinessDate: string },
): DrawerRow {
  const closed = f.closedAt !== null;
  const difference = storedDifference(f);
  const earlier = !closed && f.businessDate < ctx.currentBusinessDate;
  return {
    id: f.id,
    businessDate: f.businessDate,
    zNumber: closed ? f.zNumber : null,
    deviceId: f.deviceId,
    deviceName: f.deviceName,
    deviceActive: f.deviceActive,
    openedAt: f.openedAt,
    openedByName: f.openedByName,
    closedAt: f.closedAt,
    closedByName: f.closedByName,
    status: closed ? "closed" : "open",
    opening: f.opening,
    cashSales: f.cash.amount,
    cashTips: f.cash.tips,
    cashRefunds: f.cash.refunds,
    paidOuts: f.paidOuts.amount,
    payIns: f.payIns,
    expected: closed
      ? f.stored.expected
      : ctx.canSeeExpected
        ? liveExpectedCash(f)
        : null,
    counted: closed ? f.stored.counted : null,
    difference,
    countMode: f.stored.countMode,
    terminalSales: f.external.amount,
    terminalTips: f.external.tips,
    terminalRefunds: f.external.refunds,
    terminalNet: terminalNet(f),
    terminalReported: closed ? f.stored.externalReported : null,
    terminalDifference: terminalDifference(f),
    payments: f.cash.count + f.external.count,
    lateCash: closed ? add(f.cash.lateAmount, f.cash.lateTips) : 0,
    lateTerminal: lateTerminal(f),
    review: f.review,
    needsReview: difference !== null && difference !== 0 && !f.review,
    zPrints: f.zPrints,
    orphan: !closed && (!f.deviceActive || f.deviceRevoked || earlier),
    openSinceEarlierDay: earlier,
  };
}

/**
 * The drawers that belong to a report ending on `to`. The §4.5 drawerList filter (`day between
 * from and to or closed_at is null`) also returns drawers opened after `to` that are still open:
 * they hold no collection of the range, so a past range's Cajas card and a past day's corte del
 * día must not count or list them. Drawers opened before `from` and still open stay (they may
 * hold the range's collections).
 */
export function drawersUpTo<T extends Pick<DrawerRow, "businessDate">>(
  rows: readonly T[],
  to: string,
): T[] {
  if (!isBusinessDate(to)) throw new RangeError("invalid_date");
  return rows.filter((r) => r.businessDate <= to);
}

/** The Cajas card of Resumen (pass the rows through drawersUpTo first; composeSalesSummary does). */
export function drawerSummary(rows: readonly DrawerRow[]): DrawerSummary {
  const differences = rows.flatMap((r) =>
    r.status === "closed" && r.difference !== null ? [r.difference] : [],
  );
  return {
    open: rows.filter((r) => r.status === "open").length,
    closed: rows.filter((r) => r.status === "closed").length,
    differenceNet: sumBy(differences, (d) => d),
    shortages: sumBy(
      differences.filter((d) => d < 0),
      (d) => -d,
    ),
    overages: sumBy(
      differences.filter((d) => d > 0),
      (d) => d,
    ),
    unreviewed: rows.filter((r) => r.needsReview).length,
    openFromEarlierDays: rows.filter((r) => r.openSinceEarlierDay).length,
  };
}

export const CORTE_BLIND_WINDOW_HOURS = 12;

/**
 * §4.7 assertCorteAccess with the §2.12 "own device's last drawer" condition. Kitchen (and any
 * unknown role) is forbidden. Owners and managers read every closed drawer in full, and an open
 * drawer (corte X) only when they may see expected cash during the shift. Cashiers and servers
 * read only their own device's drawer: a corte X when they may see expected cash; a corte Z (blind
 * unless they may see expected) only of the device's last drawer, within 12 h of its close. So on a
 * shared device the next shift cannot print the previous shift's count slip. The owner always
 * passes canSeeExpected.
 */
export function corteAccess(i: {
  role: string;
  deviceId: string;
  canSeeExpected: boolean;
  drawer: {
    deviceId: string;
    closedAt: string | null;
    /**
     * No other drawer of the same device was opened after this one (by `(opened_at, id)`). The
     * server computes it: `not exists (select 1 from cash_sessions n where n.device_id =
     * d.device_id and (n.opened_at, n.id) > (d.opened_at, d.id))`.
     */
    latestOnDevice: boolean;
  };
  now: string;
}): { kind: "x" | "z"; visibility: "full" | "blind" } {
  const forbidden = () => new DomainError("forbidden", 403);
  const hidden = () => new DomainError("reports_corte_hidden", 403);
  const seesExpected = i.role === "owner" || i.canSeeExpected;
  const open = i.drawer.closedAt === null;
  if (i.role === "owner" || i.role === "manager") {
    if (open && !seesExpected) throw hidden();
    return { kind: open ? "x" : "z", visibility: "full" };
  }
  if (i.role !== "cashier" && i.role !== "server") throw forbidden();
  if (i.drawer.deviceId !== i.deviceId) throw forbidden();
  if (open) {
    if (!seesExpected) throw hidden();
    return { kind: "x", visibility: "full" };
  }
  if (!i.drawer.latestOnDevice) throw forbidden();
  const since = Temporal.Instant.from(i.now).subtract({
    hours: CORTE_BLIND_WINDOW_HOURS,
  });
  if (
    Temporal.Instant.compare(
      Temporal.Instant.from(i.drawer.closedAt as string),
      since,
    ) < 0
  )
    throw forbidden();
  return { kind: "z", visibility: seesExpected ? "full" : "blind" };
}

/** The documents a `report_prints` row numbers (the 029 kind CHECK). */
export type ReportPrintKind =
  "corte_x" | "corte_z" | "count_slip" | "day_corte";

/**
 * The printed document a drawer corte is, which owns its print sequence: the corte X, the full
 * corte Z, or the blind count slip ("COMPROBANTE DE CONTEO"). The slip and the Z of one drawer
 * are different documents, so a cashier's slip never makes the manager's first Z a reprint, and
 * only reprints of the full Z are corte_reprint exceptions.
 */
export function cortePrintKind(
  doc: Pick<CorteDocument, "kind" | "visibility">,
): Exclude<ReportPrintKind, "day_corte"> {
  if (doc.kind === "x") return "corte_x";
  return doc.visibility === "blind" ? "count_slip" : "corte_z";
}

/** Folio runs of fiscal_tickets per series, formatted with fiscal's formatFolio. */
export function folioRanges(
  runs: readonly {
    series: string;
    first: number;
    last: number;
    count: number;
  }[],
): FolioRange[] {
  return [...runs]
    .sort((a, b) => (a.series < b.series ? -1 : a.series > b.series ? 1 : 0))
    .map((r) => ({
      series: r.series,
      first: formatFolio(r.series, r.first),
      last: formatFolio(r.series, r.last),
      count: r.count,
    }));
}

/**
 * The corte X (open drawer) or Z (closed drawer) document. A corte Z states every figure "as of
 * close": cash and external tenders recorded after the close are excluded from sales, tips, the
 * terminal net and the payment count, and shown as lateCash / lateTerminal; expected cash is the
 * stored figure and the terminal difference uses the stored external expected. The blind variant
 * (count slip) carries no expected cash, cash sales, refunds, paid-outs, difference, controls,
 * folios, late cash or review: the server never sends them. A blind corte X does not exist
 * (corteAccess answers reports_corte_hidden).
 */
export function buildCorteDocument(
  f: DrawerFacts,
  ctx: {
    visibility: "full" | "blind";
    restaurant: RestaurantHeader;
    printedAt: string;
    printedByName: string;
    printNumber?: number | null;
    controls: CorteControls;
    folios: readonly {
      series: string;
      first: number;
      last: number;
      count: number;
    }[];
  },
): CorteDocument {
  const closed = f.closedAt !== null;
  const blind = ctx.visibility === "blind";
  if (!closed && blind) throw new RangeError("blind_corte_x");
  const lateCount = closed ? add(f.cash.lateCount, f.external.lateCount) : 0;
  const cash: CorteDocument["cash"] = blind
    ? null
    : closed
      ? {
          opening: f.opening,
          sales: f.cash.amount - f.cash.lateAmount,
          tips: f.cash.tips - f.cash.lateTips,
          refunds: f.cash.refunds,
          paidOuts: f.paidOuts.amount,
          payIns: f.payIns,
          expected:
            f.stored.expected ??
            liveExpectedCash(f) - add(f.cash.lateAmount, f.cash.lateTips),
          counted: f.stored.counted,
          difference: storedDifference(f),
          reason: f.stored.reason?.trim() ? f.stored.reason.trim() : null,
        }
      : {
          opening: f.opening,
          sales: f.cash.amount,
          tips: f.cash.tips,
          refunds: f.cash.refunds,
          paidOuts: f.paidOuts.amount,
          payIns: f.payIns,
          expected: liveExpectedCash(f),
          counted: null,
          difference: null,
          reason: null,
        };
  return {
    kind: closed ? "z" : "x",
    visibility: ctx.visibility,
    zNumber: closed ? f.zNumber : null,
    printNumber: ctx.printNumber ?? null,
    restaurant: ctx.restaurant,
    drawer: {
      id: f.id,
      deviceName: f.deviceName,
      openedAt: f.openedAt,
      openedByName: f.openedByName,
      closedAt: f.closedAt,
      closedByName: f.closedByName,
      businessDate: f.businessDate,
      countMode: f.stored.countMode,
    },
    printedAt: ctx.printedAt,
    printedByName: ctx.printedByName,
    cash,
    counted: closed ? f.stored.counted : null,
    terminal: {
      sales: f.external.amount - (closed ? f.external.lateAmount : 0),
      count: f.external.count - (closed ? f.external.lateCount : 0),
      tips: f.external.tips - (closed ? f.external.lateTips : 0),
      refunds: f.external.refunds,
      net: terminalNetAsOfClose(f),
      reported: closed ? f.stored.externalReported : null,
      difference: terminalDifference(f),
    },
    payments: add(f.cash.count, f.external.count) - lateCount,
    controls: blind ? null : ctx.controls,
    folios: blind ? [] : folioRanges(ctx.folios),
    lateCash: blind || !closed ? 0 : add(f.cash.lateAmount, f.cash.lateTips),
    lateTerminal: lateTerminal(f),
    review: blind ? null : f.review,
  };
}

/**
 * Collections of the day that no drawer opened that day holds: `collected − Σ (cash sales +
 * terminal sales)` of the drawers opened on `date`. The corte del día prints it only when ≠ 0.
 */
export function otherDayDrawerCollections(
  collected: number,
  drawers: readonly Pick<
    DrawerRow,
    "businessDate" | "cashSales" | "terminalSales"
  >[],
  date: string,
): number {
  const sameDay = drawers.filter((d) => d.businessDate === date);
  return collected - sumBy(sameDay, (d) => add(d.cashSales, d.terminalSales));
}

/** The corte del día document: one business date's summary, drawers and exception totals. */
export function buildDayCorteDocument(input: {
  date: string;
  restaurant: RestaurantHeader;
  printedAt: string;
  printedByName: string;
  printNumber?: number | null;
  summary: SalesSummary;
  drawers: readonly DrawerRow[];
  exceptions: readonly ExceptionTotals[];
  extra?: Record<string, unknown>;
}): DayCorteDocument {
  const { from, to } = input.summary.range;
  if (!isBusinessDate(input.date) || from !== input.date || to !== input.date)
    throw new RangeError("day_corte_range");
  const order = (k: ExceptionKind) => EXCEPTION_KINDS.indexOf(k);
  // A drawer opened after the date is not part of that day's corte (see drawersUpTo).
  const drawers = drawersUpTo(input.drawers, input.date);
  return {
    date: input.date,
    restaurant: input.restaurant,
    printedAt: input.printedAt,
    printedByName: input.printedByName,
    printNumber: input.printNumber ?? null,
    summary: input.summary,
    drawers,
    drawersOpen: drawers.filter((d) => d.status === "open").length,
    otherDayDrawerCollections: otherDayDrawerCollections(
      input.summary.collections.collected,
      drawers,
      input.date,
    ),
    exceptions: input.exceptions
      .filter((e) => e.count > 0)
      .sort((a, b) => order(a.kind) - order(b.kind)),
    extra: { ...(input.extra ?? {}) },
  };
}
