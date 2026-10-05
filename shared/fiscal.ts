// shared/fiscal.ts — pure fiscal core (Mexico): tax extraction per order, per-line ticket
// snapshots, allocation of order-level amounts, refund tax rules, fiscal profile validation and
// folio formatting. No database access: server/fiscal.ts (next wave) loads rows and calls these.
// Every amount is an integer number of centavos; every price is tax-inclusive (LFPC art. 7 Bis).
import { z } from "zod";
import {
  allocate,
  DomainError,
  id,
  money,
  type Label,
  type PricedLine,
} from "./domain.js";
import { lineRemaining } from "./settlement.js";
import {
  extractTax,
  resolveTaxCategory,
  satTaxWithinTolerance,
  SAT_DEFAULT_PRODUCT_KEY,
  SAT_DEFAULT_UNIT_KEY,
  TAX_CATEGORIES,
  TAX_REGIONS,
  TAX_RULES,
  type FiscalContext,
  type LineTaxSnapshot,
  type TaxCategory,
  type TaxRegion,
} from "./tax.js";
import { ISSUER_REGIMES, regimeAllowedFor, validateRfc } from "./sat.js";

export * from "./tax.js";
export * from "./sat.js";

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/**
 * A persisted order line as fiscal reads it. `tax` is the immutable snapshot taken in quote()
 * once migration 027 lands (shared/domain.ts PricedLine.tax in the next wave); lines priced
 * before that have no snapshot and resolve to the restaurant default at issuance.
 */
export type TaxedLine = PricedLine & { tax?: LineTaxSnapshot | null };

export type TaxPortion = {
  lineId: string | null;
  category: TaxCategory;
  grossBeforeDiscount: number;
  discount: number;
};
export type LinePortion = TaxPortion & { quantity: number; snapshot: boolean };
export type TaxGroup = {
  category: TaxCategory;
  rateBps: number | null;
  grossBeforeDiscount: number;
  discount: number;
  gross: number;
  baseBeforeDiscount: number;
  discountBase: number;
  base: number;
  tax: number;
};
export type TaxSummaryBasis =
  "line_snapshot" | "issuance_default" | "recovery_default";
export type TaxSummary = {
  groups: TaxGroup[];
  grossBeforeDiscount: number;
  discount: number;
  unallocatedDiscount: number;
  gross: number;
  base: number;
  tax: number;
  basis: TaxSummaryBasis;
};
/** orderTaxSummary plus the per-line portions it was built from (after the surplus share). */
export type TaxBreakdown = { summary: TaxSummary; portions: LinePortion[] };
export type LineShare = {
  lineId: string | null;
  baseBeforeDiscount: number;
  discountBase: number;
  base: number;
  tax: number;
  valid: boolean;
};
/** One category's tax-inclusive amount split into base and IVA (refund rows, register rows). */
export type CategoryTax = {
  category: TaxCategory;
  rateBps: number | null;
  gross: number;
  base: number;
  tax: number;
};

// ---------------------------------------------------------------------------------------------
// Internal guards
// ---------------------------------------------------------------------------------------------

const fiscalMismatch = () => new DomainError("fiscal_total_mismatch", 409);
const refundExceeds = () => new DomainError("fiscal_refund_exceeds", 409);
const isAmount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isCategory = (c: unknown): c is TaxCategory =>
  typeof c === "string" && (TAX_CATEGORIES as readonly string[]).includes(c);
function add(a: number, b: number): number {
  const n = a + b;
  if (!Number.isSafeInteger(n)) throw new RangeError("invalid_amount");
  return n;
}
const total = (values: number[]) => values.reduce(add, 0);
function own<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}
/**
 * Exact largest-remainder (Hamilton) split of `amount` in proportion to `weights`: each part is
 * the floor or the ceiling of its exact share, leftovers go to the largest fractional remainders
 * (ties to the earlier index), and the parts always sum to `amount`. All zeros when every weight
 * is 0. When amount ≤ Σ weights no part exceeds its weight.
 *
 * Used only for the informational per-line split of a tax group. domain allocate() hands its
 * leftovers round-robin from the first line, which leaves about one realistic multi-line order in
 * five with a line outside the SAT tolerance; money allocations (units, discounts, refunds) keep
 * using allocate() so they match voids and item splits.
 */
export function allocateLargestRemainder(
  amount: number,
  weights: number[],
): number[] {
  if (!isAmount(amount) || !weights.every(isAmount))
    throw new RangeError("invalid_amount");
  const sumWeights = BigInt(total(weights));
  if (sumWeights === 0n) return weights.map(() => 0);
  const exact = weights.map((w) => BigInt(amount) * BigInt(w));
  const parts = exact.map((x) => Number(x / sumWeights));
  const order = exact
    .map((x, i) => ({ i, remainder: x % sumWeights }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.i - b.i
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
  let left = amount - total(parts);
  for (let k = 0; left > 0; k++, left--) parts[order[k].i]++;
  return parts;
}

/**
 * The line's tax snapshot when it is structurally sound (known category whose rate matches
 * TAX_RULES), else null. A malformed snapshot is treated like a legacy line without one, so
 * the ticket still reconciles and records basis "issuance_default" instead of failing a payment.
 */
export function lineSnapshot(line: { tax?: unknown }): LineTaxSnapshot | null {
  const s = line.tax as Partial<LineTaxSnapshot> | null | undefined;
  if (!s || typeof s !== "object" || s.v !== 1 || !isCategory(s.category))
    return null;
  return s.rateBps === TAX_RULES[s.category].rateBps
    ? (s as LineTaxSnapshot)
    : null;
}

// ---------------------------------------------------------------------------------------------
// Lines, groups and the order summary
// ---------------------------------------------------------------------------------------------

/** Remaining (after voids) tax-inclusive amount of one line, minus its allocated discount. */
export function lineTax(
  line: TaxedLine,
  ctx: FiscalContext,
  discount = 0,
): LinePortion {
  const remaining = lineRemaining(line);
  const snapshot = lineSnapshot(line);
  const category =
    snapshot?.category ?? resolveTaxCategory(undefined, ctx).category;
  if (!isAmount(discount) || discount > remaining.total) throw fiscalMismatch();
  return {
    lineId: line.id,
    category,
    grossBeforeDiscount: remaining.total,
    discount,
    quantity: remaining.quantity,
    snapshot: !!snapshot,
  };
}

/** Sums portions per category (canonical order) and extracts base and IVA per group. */
export function taxGroups(portions: TaxPortion[]): TaxGroup[] {
  const sums = new Map<TaxCategory, { gbd: number; discount: number }>();
  for (const p of portions) {
    if (!isCategory(p.category)) throw new RangeError("invalid_tax_category");
    if (
      !isAmount(p.grossBeforeDiscount) ||
      !isAmount(p.discount) ||
      p.discount > p.grossBeforeDiscount
    )
      throw fiscalMismatch();
    const s = sums.get(p.category) ?? { gbd: 0, discount: 0 };
    sums.set(p.category, {
      gbd: add(s.gbd, p.grossBeforeDiscount),
      discount: add(s.discount, p.discount),
    });
  }
  return TAX_CATEGORIES.flatMap((category) => {
    const s = sums.get(category);
    if (!s || (s.gbd === 0 && s.discount === 0)) return [];
    const rateBps = TAX_RULES[category].rateBps;
    const gross = s.gbd - s.discount;
    const { base, tax } = extractTax(gross, rateBps);
    const baseBeforeDiscount = extractTax(s.gbd, rateBps).base;
    return [
      {
        category,
        rateBps,
        grossBeforeDiscount: s.gbd,
        discount: s.discount,
        gross,
        baseBeforeDiscount,
        discountBase: baseBeforeDiscount - base,
        base,
        tax,
      },
    ];
  });
}

export type OrderTaxInput = {
  /** Persisted lines with voidedUnits. Empty for an offline recovery order. */
  lines: TaxedLine[];
  /** Discounts 028: tax-inclusive discount per line id (order-level ones already allocated). */
  lineDiscounts?: Readonly<Record<string, number>>;
  /** orders.total: payable after voids and discounts. */
  total: number;
  /** Used only for lines without a snapshot and for recovery orders. */
  ctx: FiscalContext;
};

/**
 * The tax summary of an order and the per-line portions behind it. Gross above the order total
 * is an unallocated discount spread over the portions; gross below it cannot happen by
 * construction and throws fiscal_total_mismatch (which rolls the payment back).
 */
export function orderTaxBreakdown(input: OrderTaxInput): TaxBreakdown {
  const { lines, lineDiscounts, ctx } = input;
  if (!money.safeParse(input.total).success)
    throw new DomainError("invalid_amount");
  if (new Set(lines.map((l) => l.id)).size !== lines.length)
    throw new DomainError("duplicate_line");
  let portions: LinePortion[];
  let basis: TaxSummaryBasis;
  if (!lines.length) {
    portions = [
      {
        lineId: null,
        category: ctx.defaultCategory,
        grossBeforeDiscount: input.total,
        discount: 0,
        quantity: 1,
        snapshot: false,
      },
    ];
    basis = "recovery_default";
  } else {
    portions = lines
      .map((l) => lineTax(l, ctx, own(lineDiscounts, l.id) ?? 0))
      .filter((p) => p.quantity > 0);
    basis = portions.every((p) => p.snapshot)
      ? "line_snapshot"
      : "issuance_default";
  }
  const nets = portions.map((p) => p.grossBeforeDiscount - p.discount);
  const net = total(nets);
  let unallocatedDiscount = 0;
  if (net > input.total) {
    unallocatedDiscount = net - input.total;
    const shares = allocate(unallocatedDiscount, nets);
    portions = portions.map((p, i) => ({
      ...p,
      discount: p.discount + shares[i],
    }));
  } else if (net < input.total) throw fiscalMismatch();
  const groups = taxGroups(portions);
  const summary: TaxSummary = {
    groups,
    grossBeforeDiscount: total(groups.map((g) => g.grossBeforeDiscount)),
    discount: total(groups.map((g) => g.discount)),
    unallocatedDiscount,
    gross: total(groups.map((g) => g.gross)),
    base: total(groups.map((g) => g.base)),
    tax: total(groups.map((g) => g.tax)),
    basis,
  };
  if (
    summary.gross !== input.total ||
    summary.base + summary.tax !== input.total ||
    summary.grossBeforeDiscount - summary.discount !== summary.gross
  )
    throw fiscalMismatch();
  return { summary, portions };
}

export function orderTaxSummary(input: OrderTaxInput): TaxSummary {
  return orderTaxBreakdown(input).summary;
}

/**
 * Splits a group across its lines for itemized CFDI concepts. Sums are exact; per-line SAT
 * validity is reported. base_i and baseBeforeDiscount_i are largest-remainder shares of the
 * group's base by line net and gross; tax_i = net_i − base_i, so no line's tax is negative.
 */
export function allocateGroupToLines(
  group: TaxGroup,
  lines: {
    lineId: string | null;
    grossBeforeDiscount: number;
    discount: number;
  }[],
): LineShare[] {
  if (
    !isAmount(group.base) ||
    !isAmount(group.tax) ||
    group.base + group.tax !== group.gross ||
    group.baseBeforeDiscount < group.base ||
    group.baseBeforeDiscount > group.grossBeforeDiscount ||
    lines.some(
      (l) =>
        !isAmount(l.grossBeforeDiscount) ||
        !isAmount(l.discount) ||
        l.discount > l.grossBeforeDiscount,
    )
  )
    throw fiscalMismatch();
  const gbds = lines.map((l) => l.grossBeforeDiscount);
  const nets = lines.map((l) => l.grossBeforeDiscount - l.discount);
  if (total(gbds) !== group.grossBeforeDiscount || total(nets) !== group.gross)
    throw fiscalMismatch();
  const bases = allocateLargestRemainder(group.base, nets);
  const before = allocateLargestRemainder(group.baseBeforeDiscount, gbds);
  return lines.map((l, i) => {
    const base = bases[i];
    const tax = nets[i] - base;
    const discountBase = before[i] - base;
    return {
      lineId: l.lineId,
      baseBeforeDiscount: before[i],
      discountBase,
      base,
      tax,
      valid:
        satTaxWithinTolerance(base, tax, group.rateBps) &&
        discountBase >= 0 &&
        base >= 0,
    };
  });
}

/** The single line snapshot of a reconciled offline sale (an order without lines). */
export const RECOVERY_LINE_NAME: Label = {
  es: "Venta sin conexión conciliada",
  en: "Reconciled offline sale",
};

export type TicketLineSnapshot = {
  lineId: string | null;
  productId: string | null;
  quantity: number;
  name: { es: string; en: string };
  optionNames: { es: string; en: string }[];
  category: TaxCategory;
  rateBps: number | null;
  satProductKey: string;
  satUnitKey: string;
  grossBeforeDiscount: number;
  discount: number;
  gross: number;
  baseBeforeDiscount: number;
  discountBase: number;
  base: number;
  tax: number;
  valid: boolean;
};

/**
 * The frozen `lines` of a ticket: every remaining line (zero-priced ones included, so quantity
 * and description are complete) with its share of its category group. Per category the line
 * amounts add up exactly to the group, so the ticket reconciles line by line.
 */
export function ticketLineSnapshots(
  lines: TaxedLine[],
  breakdown: TaxBreakdown,
): TicketLineSnapshot[] {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const shares = new Map<LinePortion, LineShare>();
  for (const group of breakdown.summary.groups) {
    const members = breakdown.portions.filter(
      (p) => p.category === group.category,
    );
    allocateGroupToLines(group, members).forEach((share, i) =>
      shares.set(members[i], share),
    );
  }
  return breakdown.portions.map((p) => {
    const line = p.lineId === null ? undefined : byId.get(p.lineId);
    if (p.lineId !== null && !line) throw fiscalMismatch();
    const snapshot = line ? lineSnapshot(line) : null;
    const share = shares.get(p) ?? {
      baseBeforeDiscount: 0,
      discountBase: 0,
      base: 0,
      tax: 0,
      valid: true,
    };
    const productKey = snapshot?.satProductKey;
    const unitKey = snapshot?.satUnitKey;
    return {
      lineId: p.lineId,
      productId: line?.productId ?? null,
      quantity: p.quantity,
      name: line?.name ?? RECOVERY_LINE_NAME,
      optionNames: line?.optionNames ?? [],
      category: p.category,
      rateBps: TAX_RULES[p.category].rateBps,
      satProductKey:
        productKey && /^\d{8}$/.test(productKey)
          ? productKey
          : SAT_DEFAULT_PRODUCT_KEY,
      satUnitKey:
        unitKey && /^[A-Z0-9]{1,3}$/.test(unitKey)
          ? unitKey
          : SAT_DEFAULT_UNIT_KEY,
      grossBeforeDiscount: p.grossBeforeDiscount,
      discount: p.discount,
      gross: p.grossBeforeDiscount - p.discount,
      baseBeforeDiscount: share.baseBeforeDiscount,
      discountBase: share.discountBase,
      base: share.base,
      tax: share.tax,
      valid: share.valid,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Order-level amounts and refunds
// ---------------------------------------------------------------------------------------------

/** Lines in the order discounts 028 uses to allocate order-level amounts: (round, id). */
export function allocationOrder<L extends { id: string; round?: number }>(
  lines: L[],
): L[] {
  return [...lines].sort(
    (a, b) =>
      (a.round ?? 0) - (b.round ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Allocates an order-level tax-inclusive amount (an order discount or comp) to lines with
 * allocate(amount, remaining net per line) in (round, id) order, and returns the merged
 * per-line discounts. No line's discount ever exceeds its remaining total.
 */
export function allocateOrderDiscount(input: {
  lines: TaxedLine[];
  amount: number;
  lineDiscounts?: Readonly<Record<string, number>>;
}): Record<string, number> {
  const ordered = allocationOrder(input.lines);
  const nets = ordered.map((l) => {
    const existing = own(input.lineDiscounts, l.id) ?? 0;
    const remaining = lineRemaining(l).total;
    if (!isAmount(existing) || existing > remaining) throw fiscalMismatch();
    return remaining - existing;
  });
  if (!isAmount(input.amount) || input.amount > total(nets))
    throw fiscalMismatch();
  const merged: Record<string, number> = { ...input.lineDiscounts };
  if (input.amount === 0) return merged;
  allocate(input.amount, nets).forEach((share, i) => {
    if (share > 0)
      merged[ordered[i].id] = (own(merged, ordered[i].id) ?? 0) + share;
  });
  return merged;
}

/**
 * The tax-inclusive category amounts of an item-scoped refund: each refunded unit's amount
 * (units from allocate(line.total, quantity), as for voids and item splits) minus its share of
 * the line discount, which is allocated over the line's remaining (non-voided) units.
 */
export function refundScopeGross(input: {
  lines: TaxedLine[];
  lineDiscounts?: Readonly<Record<string, number>>;
  scope: { lineId: string; units: number[] }[];
  ctx: FiscalContext;
}): { category: TaxCategory; gross: number }[] {
  const byId = new Map(input.lines.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const sums = new Map<TaxCategory, number>();
  for (const item of input.scope) {
    const line = byId.get(item.lineId);
    if (!line) throw new DomainError("invalid_allocation", 409);
    const discount = own(input.lineDiscounts, line.id) ?? 0;
    const { category } = lineTax(line, input.ctx, discount);
    const voided = new Set(line.voidedUnits ?? []);
    const units = allocate(line.total, Array(line.quantity).fill(1));
    const weights = units.map((amount, unit) =>
      voided.has(unit) ? 0 : amount,
    );
    const unitDiscounts =
      discount > 0 ? allocate(discount, weights) : weights.map(() => 0);
    for (const unit of item.units) {
      const key = `${line.id}:${unit}`;
      if (
        !Number.isInteger(unit) ||
        unit < 0 ||
        unit >= line.quantity ||
        voided.has(unit) ||
        seen.has(key)
      )
        throw new DomainError("invalid_allocation", 409);
      seen.add(key);
      sums.set(
        category,
        add(sums.get(category) ?? 0, units[unit] - unitDiscounts[unit]),
      );
    }
  }
  return TAX_CATEGORIES.flatMap((category) => {
    const gross = sums.get(category) ?? 0;
    return gross > 0 ? [{ category, gross }] : [];
  });
}

/** Tax split of one refund, cumulative so that refunds of a whole sale net its IVA to exactly zero. */
export function refundTaxSplit(input: {
  refundGross: number;
  /** Ticket groups, or the provisional summary's groups when the order has no ticket. */
  saleGroups: {
    category: TaxCategory;
    rateBps: number | null;
    gross: number;
  }[];
  /** Earlier adjustments of this order. */
  previous: { category: TaxCategory; gross: number; tax: number }[];
  /** Item-scoped refund (discounts 028), from refundScopeGross(). */
  scope?: { category: TaxCategory; gross: number }[];
}): CategoryTax[] {
  if (!isAmount(input.refundGross)) throw new DomainError("invalid_amount");
  const sale = new Map<TaxCategory, number>();
  for (const g of input.saleGroups) {
    if (!isCategory(g.category)) throw new RangeError("invalid_tax_category");
    if (g.rateBps !== TAX_RULES[g.category].rateBps)
      throw new RangeError("invalid_tax_rate");
    if (!isAmount(g.gross)) throw fiscalMismatch();
    sale.set(g.category, add(sale.get(g.category) ?? 0, g.gross));
  }
  const refunded = new Map<TaxCategory, number>();
  for (const p of input.previous) {
    if (!isCategory(p.category)) throw new RangeError("invalid_tax_category");
    if (!isAmount(p.gross)) throw fiscalMismatch();
    refunded.set(p.category, add(refunded.get(p.category) ?? 0, p.gross));
  }
  const remaining = TAX_CATEGORIES.map((c) =>
    Math.max(0, (sale.get(c) ?? 0) - (refunded.get(c) ?? 0)),
  );
  let split: number[];
  if (input.scope) {
    split = TAX_CATEGORIES.map(() => 0);
    for (const s of input.scope) {
      if (!isCategory(s.category)) throw new RangeError("invalid_tax_category");
      if (!isAmount(s.gross)) throw fiscalMismatch();
      const i = TAX_CATEGORIES.indexOf(s.category);
      split[i] = add(split[i], s.gross);
    }
    if (split.some((amount, i) => amount > remaining[i])) throw refundExceeds();
    if (total(split) !== input.refundGross) throw fiscalMismatch();
  } else {
    if (input.refundGross > total(remaining)) throw refundExceeds();
    split =
      input.refundGross === 0
        ? remaining.map(() => 0)
        : allocate(input.refundGross, remaining);
  }
  return TAX_CATEGORIES.flatMap((category, i) => {
    const amount = split[i];
    if (amount === 0) return [];
    const rateBps = TAX_RULES[category].rateBps;
    const before = refunded.get(category) ?? 0;
    const tax =
      extractTax(before + amount, rateBps).tax -
      extractTax(before, rateBps).tax;
    return [{ category, rateBps, gross: amount, base: amount - tax, tax }];
  });
}

// ---------------------------------------------------------------------------------------------
// Folios and self-invoice codes
// ---------------------------------------------------------------------------------------------

export const TICKET_SERIES_PATTERN = /^[A-Z0-9]{0,10}$/;

/** "A-000123" with a series, "000123" without; numbers above 999999 print in full. */
export function formatFolio(series: string, n: number): string {
  if (!TICKET_SERIES_PATTERN.test(series))
    throw new RangeError("invalid_series");
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("invalid_folio");
  const number = String(n).padStart(6, "0");
  return series ? `${series}-${number}` : number;
}

/** Parses "A-000123", "a-123" or "123" (trimmed, case-insensitive). Null when it is not a folio. */
export function parseFolio(
  text: string,
): { series: string; number: number } | null {
  const m = /^(?:([A-Z0-9]{1,10})-)?(\d{1,16})$/.exec(
    text.trim().toUpperCase(),
  );
  if (!m) return null;
  const number = Number(m[2]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { series: m[1] ?? "", number };
}

/** Crockford base32 (no I, L, O, U), the alphabet of printed self-invoice codes. */
export const SELF_INVOICE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const SELF_INVOICE_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{12}$/;

/** 12 characters (60 bits) from 12 random bytes; `byte & 31` is uniform since 256 = 8 × 32. */
export function selfInvoiceCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < 12) throw new RangeError("invalid_entropy");
  return Array.from(
    bytes.subarray(0, 12),
    (b) => SELF_INVOICE_ALPHABET[b & 31],
  ).join("");
}

/** Printed form: "XXXX-XXXX-XXXX". */
export function groupSelfInvoiceCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? "";
}

/** What a customer types back: uppercased, without "-" or spaces, O→0 and I/L→1. */
export function normalizeSelfInvoiceCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return SELF_INVOICE_CODE_PATTERN.test(code) ? code : null;
}

// ---------------------------------------------------------------------------------------------
// Fiscal profile input and validation
// ---------------------------------------------------------------------------------------------

export const fiscalAddressInput = z
  .object({
    street: z.string().trim().max(120).default(""),
    neighborhood: z.string().trim().max(80).default(""),
    municipality: z.string().trim().max(80).default(""),
    state: z.string().trim().max(60).default(""),
  })
  .strict();
export type FiscalAddress = z.infer<typeof fiscalAddressInput>;

export const fiscalProfileInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(0), // 0 = no profile row yet
    identity: z
      .object({
        rfc: z.string().trim().toUpperCase().max(13),
        legalName: z.string().trim().max(300),
        regime: z.string().trim().max(3),
        postalCode: z.string().trim().max(5),
        address: fiscalAddressInput.default({
          street: "",
          neighborhood: "",
          municipality: "",
          state: "",
        }),
      })
      .strict()
      .nullable(),
    ticketSeries: z.string().trim().toUpperCase().max(10).default(""),
    taxRegion: z.enum(TAX_REGIONS),
    defaultTaxCategory: z.enum(TAX_CATEGORIES),
    borderConfirmed: z.boolean().default(false),
  })
  .strict();
export type FiscalProfileInput = z.infer<typeof fiscalProfileInput>;
export type FiscalIdentityInput = NonNullable<FiscalProfileInput["identity"]>;
export type FiscalIssue = {
  field:
    | "rfc"
    | "legalName"
    | "regime"
    | "postalCode"
    | "ticketSeries"
    | "taxRegion"
    | "defaultTaxCategory"
    | "borderConfirmed";
  code: string;
  warning?: true;
};

/**
 * The identity to store: null when every identity field (address included) is blank, since a
 * profile with no issuer data saves as incomplete (tax settings only).
 */
export function effectiveFiscalIdentity(
  identity: FiscalIdentityInput | null,
): FiscalIdentityInput | null {
  if (!identity) return null;
  const parts = [
    identity.rfc,
    identity.legalName,
    identity.regime,
    identity.postalCode,
    ...Object.values(identity.address),
  ];
  return parts.every((v) => v.trim() === "") ? null : identity;
}

/** Every issue in field order; the server throws the first non-warning one as DomainError(code, 400). */
export function fiscalProfileIssues(p: FiscalProfileInput): FiscalIssue[] {
  const issues: FiscalIssue[] = [];
  const identity = effectiveFiscalIdentity(p.identity);
  if (identity) {
    const rfc = validateRfc(identity.rfc);
    if (!rfc.rfc)
      issues.push({ field: "rfc", code: "fiscal_identity_incomplete" });
    else if (rfc.generic)
      issues.push({ field: "rfc", code: "fiscal_generic_rfc" });
    else if (!rfc.ok) issues.push({ field: "rfc", code: "fiscal_invalid_rfc" });
    else if (!rfc.checkDigit)
      issues.push({ field: "rfc", code: "fiscalRfcCheckDigit", warning: true });
    const legalName = identity.legalName.trim();
    if (!legalName)
      issues.push({ field: "legalName", code: "fiscal_identity_incomplete" });
    else if (legalName.length > 254)
      issues.push({ field: "legalName", code: "fiscal_invalid_legal_name" });
    const regime = identity.regime.trim();
    if (!regime)
      issues.push({ field: "regime", code: "fiscal_identity_incomplete" });
    else if (!ISSUER_REGIMES.includes(regime))
      issues.push({ field: "regime", code: "fiscal_invalid_regime" });
    else if (rfc.kind && !regimeAllowedFor(regime, rfc.kind))
      issues.push({ field: "regime", code: "fiscal_regime_mismatch" });
    const postalCode = identity.postalCode.trim();
    if (!postalCode)
      issues.push({ field: "postalCode", code: "fiscal_identity_incomplete" });
    else if (!/^\d{5}$/.test(postalCode))
      issues.push({ field: "postalCode", code: "fiscal_invalid_postal_code" });
  }
  if (!TICKET_SERIES_PATTERN.test(p.ticketSeries.trim().toUpperCase()))
    issues.push({ field: "ticketSeries", code: "fiscal_invalid_series" });
  if (p.defaultTaxCategory === "iva8" && p.taxRegion === "general")
    issues.push({
      field: "defaultTaxCategory",
      code: "fiscal_border_rate_not_allowed",
    });
  if (p.taxRegion !== "general" && !p.borderConfirmed)
    issues.push({
      field: "borderConfirmed",
      code: "fiscal_border_confirmation_required",
    });
  return issues;
}

// ---------------------------------------------------------------------------------------------
// View types (JSON shapes on the wire; produced by server/fiscal.ts in the next wave)
// ---------------------------------------------------------------------------------------------

export type IssuerSnapshot = {
  tradeName: string;
  rfc: string;
  legalName: string;
  regime: string;
  regimeName: { es: string; en: string };
  postalCode: string;
  address: FiscalAddress;
  taxRegion: TaxRegion;
};
export type FiscalTicketView = {
  id: string;
  orderId: string;
  folio: string;
  series: string;
  number: number;
  issuedAt: string;
  businessDate: string;
  source: "sale" | "recovery" | "repair";
  selfInvoiceCode: string;
  issuer: IssuerSnapshot | null;
  currency: "MXN";
  grossBeforeDiscount: number;
  discount: number;
  unallocatedDiscount: number;
  gross: number;
  base: number;
  tax: number;
  tip: number;
  basis: TaxSummary["basis"];
  groups: TaxGroup[];
  lines: TicketLineSnapshot[];
  payments: {
    method: "cash" | "external";
    amount: number;
    tip: number;
    reference: string | null;
    at: string;
  }[];
};
export type RefundTaxView = {
  refundId: string;
  createdAt: string;
  businessDate: string;
  groups: CategoryTax[];
};
export type OrderFiscal = {
  ticket: FiscalTicketView | null;
  provisional: TaxSummary | null;
  refunds: RefundTaxView[];
};
export type FiscalContextView = {
  version: number;
  complete: boolean;
  currencySupported: boolean;
  issuer: Omit<IssuerSnapshot, "tradeName" | "taxRegion"> | null;
  tradeName: string;
  ticketSeries: string;
  taxRegion: TaxRegion;
  defaultTaxCategory: TaxCategory;
  borderStimulusValidUntil: string;
};
export type FiscalProfileView = FiscalContextView & {
  canEdit: boolean;
  borderConfirmedAt: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
  lastFolio: string | null;
  missingTickets: number;
  iva8Products: number;
};
export type CategoryTotals = {
  category: TaxCategory;
  rateBps: number | null;
  grossBeforeDiscount: number;
  discount: number;
  gross: number;
  base: number;
  tax: number;
};
export type FiscalSummary = {
  from: string;
  to: string;
  tickets: {
    count: number;
    series: { series: string; first: number; last: number; count: number }[];
  };
  sales: CategoryTotals[];
  refunds: CategoryTotals[];
  net: CategoryTotals[];
  totals: {
    gross: number;
    base: number;
    tax: number;
    tips: number;
    refundGross: number;
    refundTax: number;
    netGross: number;
    netBase: number;
    netTax: number;
  };
  missingTickets: number;
};
export type TicketRow = {
  id: string;
  orderId: string;
  orderNumber: number;
  folio: string;
  issuedAt: string;
  businessDate: string;
  gross: number;
  base: number;
  tax: number;
  discount: number;
  tip: number;
  groups: CategoryTax[];
  refundGross: number;
  refundTax: number;
  payments: { method: "cash" | "external"; amount: number }[];
  selfInvoiceCode: string;
  source: string;
};
/** What ticketForCfdi() (server, next wave) returns to cfdi 030. */
export type CfdiTicketPayload = {
  ticket: FiscalTicketView;
  concepts: {
    category: TaxCategory;
    satTax: "002";
    satFactor: "Tasa" | "Exento";
    satRate: string | null;
    objetoImp: "02";
    noIdentificacion: string;
    grossBeforeDiscount: number;
    discount: number;
    gross: number;
    baseBeforeDiscount: number;
    discountBase: number;
    base: number;
    tax: number;
  }[];
  itemized: TicketLineSnapshot[];
  itemizedValid: boolean;
  payments: { method: "cash" | "external"; amount: number }[];
  refunds: RefundTaxView[];
};
