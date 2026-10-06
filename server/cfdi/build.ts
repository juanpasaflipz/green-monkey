/**
 * Pure CFDI 4.0 request builders for Facturapi (cfdi 030, spec §4.8.3). No I/O.
 *
 * Money: every amount is integer centavos. Fiscal (027) is the system of record: the builders never
 * recompute a ticket's IVA from orders; they take fiscal's per-category figures (ticket groups minus
 * refund adjustments, `netGroups`) and send each concept as a TAX-INCLUSIVE price with quantity 1,
 * so Facturapi derives Base and Importe from the same gross fiscal used (proof in spec §4.3:
 * round2(G/(1+r)) + round2(G·r/(1+r)) = G with no rounding ties at 16 % and 8 %, and
 * round2(G·r/(1+r)) = extractTax(G).tax). `canonicalTax` is what the provider must stamp under
 * that rounding assumption; the deliver job compares it with the stamped XML (amount_check).
 *
 * Concepts:
 *  - invoices default to ONE CONCEPT PER TAX CATEGORY ("grouped", decision D10). Fiscal's itemized
 *    lines are exact per category but a tiny line can fall outside SAT's per-concept tolerance
 *    (docs/FISCAL.md "Itemized lines on a ticket"); "itemized" is used only when every line is
 *    valid, no refund is netted and the per-line extraction adds up to the group's IVA, else it
 *    falls back to grouped and says why (`itemizedFallback`, an `itemized_fallback` event);
 *  - globals: one concept per ticket per category, NoIdentificacion (sku) = folio (SAT global guide);
 *  - credit notes (egresos): one concept per refunded category, related 01 to the parent CFDI.
 *
 * Every body is checked against the strict request schema before it is returned.
 */
import { DomainError } from "../../shared/domain.js";
import {
  extractTax,
  GENERIC_RFCS,
  parseFolio,
  SAT_DEFAULT_PRODUCT_KEY,
  SAT_DEFAULT_UNIT_KEY,
  SAT_GLOBAL_PRODUCT_KEY,
  SAT_GLOBAL_UNIT_KEY,
  TAX_CATEGORIES,
  TAX_RULES,
  type CfdiTicketPayload,
  type RefundTaxView,
  type TaxCategory,
} from "../../shared/fiscal.js";
import {
  paymentFormFor,
  resicoWithholds,
  RESICO_ISR_RATE_BPS,
  usoCfdiAllowed,
  type CardForm,
  type Receptor,
} from "../../shared/cfdi.js";
import {
  invoiceInput,
  type FCustomerInput,
  type FInvoiceInput,
  type FItemInput,
  type FIvaTaxInput,
  type FTaxInput,
} from "./facturapi-schema.js";

export type NetGroup = { category: TaxCategory; gross: number; tax: number };
/** The cfdi_settings fields the invoice builder reads. */
export type BuildSettings = {
  conceptMode: "grouped" | "itemized";
  conceptDescription: string;
};
/** InformacionGlobal: Periodicidad, Meses, Año (shared/cfdi.ts GlobalPeriod has these fields). */
export type GlobalInfo = {
  periodicity: "day" | "week" | "fortnight" | "month";
  months: string;
  year: number;
};

/** c_ClaveProdServ for credit notes: "Servicios de facturación" (Facturapi's egreso default). */
export const EGRESO_PRODUCT_KEY = "84111506";
export const SERIES = { invoice: "F", global: "FG", egreso: "NC" } as const;
/** Concepts per global CFDI part (Facturapi's limit is 5,000 items). */
export const GLOBAL_MAX_CONCEPTS = 4000;
export const PUBLICO_EN_GENERAL = {
  legalName: "PUBLICO EN GENERAL",
  rfc: "XAXX010101000",
  regime: "616",
} as const;
const UNIT_NAMES: Record<string, string> = {
  E48: "Unidad de servicio",
  H87: "Pieza",
  ACT: "Actividad",
};

const nothingToInvoice = () => new DomainError("cfdi_nothing_to_invoice", 409);
const mismatch = () => new DomainError("fiscal_total_mismatch", 409);
const isAmount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isCategory = (c: unknown): c is TaxCategory =>
  typeof c === "string" && (TAX_CATEGORIES as readonly string[]).includes(c);

/** Pesos with 2 decimals for a centavo amount: 10776 → 107.76. */
export function pesos(centavos: number): number {
  if (!Number.isSafeInteger(centavos)) throw new RangeError("invalid_amount");
  return Number((centavos / 100).toFixed(2));
}

/** IVA traslado for a fiscal category (TAX_RULES in shared/tax.ts). */
export function taxFor(category: TaxCategory): FIvaTaxInput {
  const rule = TAX_RULES[category];
  if (rule.rateBps === null)
    return { type: "IVA", rate: 0, factor: "Exento", withholding: false };
  return {
    type: "IVA",
    rate: (rule.rateBps / 10000) as FIvaTaxInput["rate"],
    factor: "Tasa",
    withholding: false,
  };
}

/** Description suffix that keeps 0 % and exempt concepts distinguishable on the PDF. */
export function categorySuffix(category: TaxCategory): string {
  return category === "iva0"
    ? " (tasa 0%)"
    : category === "exempt"
      ? " (exento)"
      : "";
}

/** The RESICO ISR retention (LISR 113-J): 1.25 % of the concept base. */
export const ISR_WITHHOLDING: FTaxInput = {
  type: "ISR",
  rate: 0.0125, // RESICO_ISR_RATE_BPS / 10000
  factor: "Tasa",
  withholding: true,
};

function rateBpsOf(tax: FTaxInput): number | null {
  return tax.factor === "Exento" ? null : Math.round(tax.rate * 10000);
}

/** centavos × bps / 10000, rounded half up (exact integers). */
function bpsOf(centavos: number, bps: number | null): number {
  if (!bps) return 0;
  return Math.floor((centavos * bps * 2 + 10000) / 20000);
}

function micros(n: number): bigint {
  const m = Math.round(n * 1_000_000);
  if (!Number.isSafeInteger(m) || m < 0) throw new RangeError("invalid_amount");
  return BigInt(m);
}

/** A concept's tax-inclusive amount in centavos: quantity × price, rounded half up. */
export function conceptCentavos(
  item: Pick<FItemInput, "quantity"> & {
    product: Pick<FItemInput["product"], "price">;
  },
): number {
  const scaled = micros(item.quantity) * micros(item.product.price); // 1e-12 pesos
  const unit = 10_000_000_000n; // 1e-12 pesos per centavo
  return Number((2n * scaled + unit) / (2n * unit));
}

/**
 * What the provider must stamp for one concept, in centavos, assuming it rounds each concept half
 * up to 2 decimals (spec §4.3; verified by the opt-in sandbox run, decision D18):
 *   - tax-inclusive (`tax_included: true`): gross = quantity × price, IVA = extractTax(gross);
 *   - base price (`tax_included: false`, concepts with the RESICO retention): base = quantity ×
 *     price, IVA = base × rate, ISR retained = base × 1.25 %.
 * `total` is before the retention (SubTotal + traslados of the concept).
 */
export function conceptAmounts(item: FItemInput): {
  base: number;
  tax: number;
  withheld: number;
  total: number;
} {
  const iva = item.product.taxes[0];
  const isr = item.product.taxes[1];
  if (!iva || iva.type !== "IVA") throw new RangeError("invalid_tax");
  const amount = conceptCentavos(item);
  if (item.product.tax_included) {
    const { tax } = extractTax(amount, rateBpsOf(iva));
    return { base: amount - tax, tax, withheld: 0, total: amount };
  }
  const tax = bpsOf(amount, rateBpsOf(iva));
  const withheld = isr ? bpsOf(amount, RESICO_ISR_RATE_BPS) : 0;
  return { base: amount, tax, withheld, total: amount + tax };
}

/** Σ of conceptAmounts over a request: the canonical totals the stamped XML is checked against. */
export function canonicalAmounts(body: Pick<FInvoiceInput, "items">): {
  total: number;
  tax: number;
  withheld: number;
} {
  let total = 0,
    tax = 0,
    withheld = 0;
  for (const item of body.items) {
    const a = conceptAmounts(item);
    total += a.total;
    tax += a.tax;
    withheld += a.withheld;
  }
  return { total, tax, withheld };
}

/**
 * Σ concept IVA over the request: the IVA Facturapi must stamp when it rounds each concept half-up
 * to 2 decimals (spec §4.3). Tax-inclusive concepts give Σ extractTax(gross) (= fiscal's figure,
 * no ties at 16 % and 8 %); base-priced concepts (RESICO retention) give Σ base × rate.
 */
export function canonicalTax(body: Pick<FInvoiceInput, "items">): number {
  return canonicalAmounts(body).tax;
}

/** One category figure from fiscal: a known category, integer centavos, IVA ≤ gross, no IVA at 0 % or exempt. */
function checkFigure(category: unknown, gross: unknown, tax: unknown) {
  if (!isCategory(category)) throw new RangeError("invalid_tax_category");
  if (!isAmount(gross) || !isAmount(tax) || tax > gross) throw mismatch();
  const rate = TAX_RULES[category].rateBps;
  if ((rate === null || rate === 0) && tax !== 0) throw mismatch();
  return category;
}

/**
 * Fiscal's figures, never recomputed (lead resolution): per category
 *   gross = ticketGroup.gross − Σ adj.gross,  tax = ticketGroup.tax − Σ adj.tax
 * (adj = fiscal_adjustments of the netted refunds).
 *
 * Inconsistent data is refused (fiscal_total_mismatch), never dropped: a refund in a category the
 * ticket does not have, a category netted below zero (gross or IVA), IVA above the net gross, or IVA
 * left on a category whose gross netted to zero. Only a category netted to exactly 0 / 0 is left
 * out. So when this returns, Σ gross = ticket gross − Σ netted refund gross and Σ tax = ticket tax −
 * Σ netted refund tax: every listed refund really reduced the invoice.
 *
 * IVA: fiscal's refundTaxSplit (shared/fiscal.ts) is CUMULATIVE on this branch:
 *   adj.tax = extract(before + amount).tax − extract(before).tax  (before = earlier refunds of the
 *   category), so a netted group's tax is ticketGroup.tax − extract(Σ refunds).tax, which can differ
 *   from extractTax(net gross).tax (= canonicalTax of the concept, what Facturapi stamps) by up to
 *   1 centavo per category, for refunds recorded before or after the ticket alike. The deliver step's
 *   amount check must not read that difference as provider rounding (docs/CFDI.md, open items).
 */
export function netGroups(
  groups: readonly { category: TaxCategory; gross: number; tax: number }[],
  netted: readonly {
    refundId: string;
    groups: readonly { category: TaxCategory; gross: number; tax: number }[];
  }[],
): NetGroup[] {
  const sums = new Map<TaxCategory, { gross: number; tax: number }>();
  const add = (
    category: TaxCategory,
    gross: number,
    tax: number,
    sign: 1 | -1,
  ) => {
    const s = sums.get(category) ?? { gross: 0, tax: 0 };
    sums.set(category, {
      gross: s.gross + sign * gross,
      tax: s.tax + sign * tax,
    });
  };
  const ticketCategories = new Set<TaxCategory>();
  for (const g of groups) {
    const category = checkFigure(g.category, g.gross, g.tax);
    ticketCategories.add(category);
    add(category, g.gross, g.tax, 1);
  }
  const seen = new Set<string>();
  for (const refund of netted) {
    if (seen.has(refund.refundId))
      throw new DomainError("cfdi_refund_netted_twice", 409);
    seen.add(refund.refundId);
    for (const a of refund.groups) {
      const category = checkFigure(a.category, a.gross, a.tax);
      // A refund of a category the ticket never sold cannot reduce this invoice.
      if (!ticketCategories.has(category)) throw mismatch();
      add(category, a.gross, a.tax, -1);
    }
  }
  return TAX_CATEGORIES.flatMap((category) => {
    const s = sums.get(category);
    if (!s) return [];
    if (s.gross < 0 || s.tax < 0 || s.tax > s.gross) throw mismatch();
    // checkFigure's rule on the net: no IVA left at 0 % or exempt, nor on a zero gross.
    checkFigure(category, s.gross, s.tax);
    if (s.gross === 0) return [];
    return [{ category, gross: s.gross, tax: s.tax }];
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** dd/MM/yyyy of the ticket in the restaurant timezone; the business date if the zone is unknown. */
function ticketDate(
  issuedAt: string,
  businessDate: string,
  timezone: string,
): string {
  try {
    const at = new Date(issuedAt);
    if (Number.isNaN(at.getTime())) throw new RangeError("invalid_date");
    return new Intl.DateTimeFormat("es-MX", {
      timeZone: timezone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(at);
  } catch {
    const [y, m, d] = businessDate.split("-");
    return `${d}/${m}/${y}`;
  }
}

function customerFor(r: Receptor): FCustomerInput {
  return {
    legal_name: r.legalName,
    tax_id: r.rfc,
    tax_system: r.regime,
    ...(r.email ? { email: r.email } : {}),
    address: { zip: r.postalCode },
  };
}

function publicoEnGeneral(issuerPostalCode: string): FCustomerInput {
  // SAT global guide: DomicilioFiscalReceptor = LugarExpedicion.
  return {
    legal_name: PUBLICO_EN_GENERAL.legalName,
    tax_id: PUBLICO_EN_GENERAL.rfc,
    tax_system: PUBLICO_EN_GENERAL.regime,
    address: { zip: issuerPostalCode },
  };
}

/** Parses with the strict request schema; errors carry field paths only (no personal data). */
function finalize(body: FInvoiceInput): FInvoiceInput {
  const parsed = invoiceInput.safeParse(body);
  if (parsed.success) return parsed.data;
  const where = parsed.error.issues
    .slice(0, 5)
    .map((i) => i.path.join("."))
    .join(", ");
  throw Object.assign(new DomainError("cfdi_request_invalid", 400), {
    detail: where,
  });
}

function requireReceptor(r: Receptor) {
  if ((GENERIC_RFCS as readonly string[]).includes(r.rfc))
    throw new DomainError("cfdi_generic_rfc", 400);
  if (!usoCfdiAllowed(r.regime, r.use))
    throw new DomainError("cfdi_use_not_allowed", 400);
}

function groupItem(
  g: NetGroup,
  product: { description: string; key: string; unit: string; unitName: string },
  sku: string | null,
  withhold = false,
): FItemInput {
  return {
    quantity: 1,
    product: {
      description: product.description,
      product_key: product.key,
      unit_key: product.unit,
      unit_name: product.unitName,
      // With the RESICO retention the price is fiscal's base (gross − IVA), see productInput.
      price: pesos(withhold ? g.gross - g.tax : g.gross),
      tax_included: !withhold,
      taxability: "02",
      taxes: withhold
        ? [taxFor(g.category), ISR_WITHHOLDING]
        : [taxFor(g.category)],
      ...(sku ? { sku } : {}),
    },
  };
}

export type ItemizedFallback =
  | "refunds"
  | "lines_invalid"
  | "tax_mismatch"
  | "too_many_lines"
  | "withholding";

/** Per-line concepts, or why the ticket must be invoiced grouped. */
function itemizedItems(
  payload: CfdiTicketPayload,
  groups: NetGroup[],
  netted: number,
  fallbackDescription: string,
): FItemInput[] | ItemizedFallback {
  if (netted > 0) return "refunds";
  if (!payload.itemizedValid) return "lines_invalid";
  const lines = payload.itemized.filter((l) => l.gross > 0);
  if (lines.length > 5000) return "too_many_lines";
  for (const g of groups) {
    const members = lines.filter((l) => l.category === g.category);
    const rate = TAX_RULES[g.category].rateBps;
    const gross = members.reduce((s, l) => s + l.gross, 0);
    const tax = members.reduce((s, l) => s + extractTax(l.gross, rate).tax, 0);
    if (gross !== g.gross || tax !== g.tax) return "tax_mismatch";
  }
  if (lines.some((l) => !groups.some((g) => g.category === l.category)))
    return "tax_mismatch";
  const sku = payload.ticket.folio;
  return lines.map((l) => {
    const base =
      (l.name?.es?.trim() || fallbackDescription) +
      (l.optionNames.length
        ? " + " + l.optionNames.map((o) => o.es).join(", ")
        : "");
    const key = /^\d{8}$/.test(l.satProductKey)
      ? l.satProductKey
      : SAT_DEFAULT_PRODUCT_KEY;
    const unit = /^[A-Z0-9]{1,3}$/.test(l.satUnitKey)
      ? l.satUnitKey
      : SAT_DEFAULT_UNIT_KEY;
    // quantity × unit price must equal the line gross exactly: keep the quantity only when the unit
    // price is representable with 6 decimals; otherwise one concept "{qty} × …" at the line gross.
    const exact =
      Number.isSafeInteger(l.quantity) &&
      l.quantity >= 1 &&
      (l.gross * 10000) % l.quantity === 0;
    const quantity = exact ? l.quantity : 1;
    const description = (
      exact || l.quantity === 1 ? base : `${l.quantity} × ${base}`
    ).slice(0, 1000);
    const price = exact
      ? Number((l.gross / l.quantity / 100).toFixed(6))
      : pesos(l.gross);
    return {
      quantity,
      product: {
        description,
        product_key: key,
        unit_key: unit,
        unit_name: UNIT_NAMES[unit] ?? unit,
        price,
        tax_included: true,
        taxability: "02",
        taxes: [taxFor(l.category)],
        sku,
      },
    };
  });
}

export type InvoiceBuildInput = {
  /** cfdi_documents.id: Facturapi idempotency_key and external_id. */
  docId: string;
  payload: CfdiTicketPayload;
  receptor: Receptor;
  settings: BuildSettings;
  /** LugarExpedicion: the location's postal code (fiscal profile), even if the org's differs. */
  issuerPostalCode: string;
  /** Credit or debit for external-terminal tenders (asked at invoicing; restaurant default). */
  cardForm: CardForm;
  /** Restaurant timezone, for the ticket date in the PDF section. */
  timezone: string;
  /** Refunds to net; default every refund in the payload (all were recorded before the freeze). */
  nettedRefunds?: readonly RefundTaxView[];
  /** Substitution (cancellation motive 01): the UUID this invoice replaces, related with 04. */
  replacesUuid?: string | null;
  /**
   * The issuer's current régimen and RFC (fiscal profile): a persona física in RESICO (626)
   * invoicing a persona moral adds the 1.25 % ISR retention per concept (LD-16 L9).
   */
  issuer?: { regime: string | null; rfc: string | null };
};
export type InvoiceBuild = {
  body: FInvoiceInput;
  /** Before any retention: fiscal's net gross. */
  expectedTotal: number;
  expectedTax: number;
  /** ISR retained (RESICO), canonical: Σ round(base × 1.25 %); 0 without retention. */
  expectedWithholding: number;
  conceptCount: number;
  nettedRefundIds: string[];
  /** Concepts actually used, and why itemized was not possible when it was asked for. */
  conceptMode: "grouped" | "itemized";
  itemizedFallback: ItemizedFallback | null;
};

/** The nominative invoice (type I, series F) for one paid ticket, net of refunds so far. */
export function buildInvoiceRequest(i: InvoiceBuildInput): InvoiceBuild {
  const { payload, receptor, settings } = i;
  if (payload.ticket.currency !== "MXN")
    throw new DomainError("cfdi_currency_unsupported", 409);
  requireReceptor(receptor);
  const refunds = i.nettedRefunds ?? payload.refunds;
  const groups = netGroups(
    payload.ticket.groups,
    refunds.map((r) => ({ refundId: r.refundId, groups: r.groups })),
  );
  // The invoice is exactly the ticket minus the netted refunds, in fiscal's figures: a ticket whose
  // groups do not add up to its totals, or a listed refund that reduced nothing, is refused.
  const total = (rows: readonly { gross: number; tax: number }[]) =>
    rows.reduce((s, r) => ({ gross: s.gross + r.gross, tax: s.tax + r.tax }), {
      gross: 0,
      tax: 0,
    });
  const ticket = total(payload.ticket.groups);
  const refunded = total(refunds.flatMap((r) => r.groups));
  const net = total(groups);
  if (
    ticket.gross !== payload.ticket.gross ||
    ticket.tax !== payload.ticket.tax ||
    net.gross !== ticket.gross - refunded.gross ||
    net.tax !== ticket.tax - refunded.tax
  )
    throw mismatch();
  if (!groups.length) throw nothingToInvoice();
  const folio = payload.ticket.folio;
  const description =
    settings.conceptDescription.trim() || "Consumo de alimentos y bebidas";
  const withhold = i.issuer ? resicoWithholds(i.issuer, receptor.rfc) : false;

  let items: FItemInput[] | null = null;
  let itemizedFallback: ItemizedFallback | null = null;
  // Itemized concepts are tax-inclusive per line; with a retention every concept is priced at
  // fiscal's base, which only the grouped figures carry.
  if (settings.conceptMode === "itemized" && withhold)
    itemizedFallback = "withholding";
  else if (settings.conceptMode === "itemized") {
    const itemized = itemizedItems(
      payload,
      groups,
      refunds.length,
      description,
    );
    if (typeof itemized === "string") itemizedFallback = itemized;
    else items = itemized;
  }
  const conceptMode = items ? "itemized" : "grouped";
  items ??= groups.map((g) =>
    groupItem(
      g,
      {
        description: description + categorySuffix(g.category),
        key: SAT_DEFAULT_PRODUCT_KEY,
        unit: SAT_DEFAULT_UNIT_KEY,
        unitName: UNIT_NAMES[SAT_DEFAULT_UNIT_KEY],
      },
      folio,
      withhold,
    ),
  );

  const body = finalize({
    type: "I",
    customer: customerFor(receptor),
    items,
    payment_form: paymentFormFor(payload.payments, i.cardForm),
    payment_method: "PUE",
    use: receptor.use,
    currency: "MXN",
    series: SERIES.invoice,
    address: { zip: i.issuerPostalCode },
    ...(i.replacesUuid
      ? {
          related_documents: [
            { relationship: "04" as const, documents: [i.replacesUuid] },
          ],
        }
      : {}),
    external_id: i.docId,
    idempotency_key: i.docId,
    pdf_custom_section: `<p>Ticket ${escapeHtml(folio)} · ${ticketDate(
      payload.ticket.issuedAt,
      payload.ticket.businessDate,
      i.timezone,
    )}</p>`,
  });
  return {
    body,
    expectedTotal: net.gross,
    expectedTax: net.tax,
    expectedWithholding: canonicalAmounts(body).withheld,
    conceptCount: body.items.length,
    nettedRefundIds: refunds.map((r) => r.refundId),
    conceptMode,
    itemizedFallback,
  };
}

export type GlobalTicket = {
  id: string;
  folio: string;
  /** netGroups() of the ticket: fiscal's figures net of its refunds. */
  groups: readonly NetGroup[];
  payments: readonly { method: string; amount: number }[];
};
export type GlobalPart = {
  docId: string;
  body: FInvoiceInput;
  ticketIds: string[];
  expectedTotal: number;
  expectedTax: number;
};

function folioOrder(a: GlobalTicket, b: GlobalTicket): number {
  const pa = parseFolio(a.folio);
  const pb = parseFolio(b.folio);
  if (pa && pb)
    return pa.series === pb.series
      ? pa.number - pb.number
      : pa.series < pb.series
        ? -1
        : 1;
  if (pa || pb) return pa ? -1 : 1;
  return a.folio < b.folio ? -1 : a.folio > b.folio ? 1 : 0;
}

/**
 * The global invoice parts of a period (SAT global guide): PUBLICO EN GENERAL / XAXX010101000 /
 * 616 / S01, InformacionGlobal, one concept per ticket per category (01010101, ACT, "Venta",
 * quantity 1, NoIdentificacion = folio), tickets in folio order. A ticket is never split across
 * parts; a part closes before it would exceed `maxConcepts`. FormaPago of each part = the form of
 * its ticket with the largest net amount (ties: lowest folio). Tickets with nothing left (fully
 * refunded) are left out; the caller releases their claims ('not_included').
 *
 * Deterministic: the scheduler and the stamping job produce identical concepts from the same claims.
 */
export function buildGlobalRequests(i: {
  docIds: () => string;
  tickets: readonly GlobalTicket[];
  period: GlobalInfo;
  issuerPostalCode: string;
  cardForm: CardForm;
  maxConcepts?: number;
}): GlobalPart[] {
  const max = i.maxConcepts ?? GLOBAL_MAX_CONCEPTS;
  if (!(max === Infinity || (Number.isInteger(max) && max >= 4 && max <= 5000)))
    throw new RangeError("invalid_max_concepts");
  const ids = new Set<string>();
  for (const t of i.tickets) {
    if (ids.has(t.id)) throw new DomainError("cfdi_duplicate_ticket", 409);
    ids.add(t.id);
  }
  for (const t of i.tickets) {
    const categories = new Set<TaxCategory>();
    for (const g of t.groups) {
      // netGroups output: one row per category, fiscal's rules on each figure.
      const category = checkFigure(g.category, g.gross, g.tax);
      if (categories.has(category)) throw mismatch();
      categories.add(category);
    }
  }
  const tickets = [...i.tickets]
    .map((t) => ({ ...t, groups: t.groups.filter((g) => g.gross > 0) }))
    .filter((t) => t.groups.length > 0)
    .sort(folioOrder);

  type Draft = { tickets: GlobalTicket[]; items: FItemInput[] };
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  for (const t of tickets) {
    const ordered = TAX_CATEGORIES.flatMap((c) =>
      t.groups.filter((g) => g.category === c),
    );
    const items = ordered.map((g) =>
      groupItem(
        g,
        {
          description: "Venta",
          key: SAT_GLOBAL_PRODUCT_KEY,
          unit: SAT_GLOBAL_UNIT_KEY,
          unitName: UNIT_NAMES[SAT_GLOBAL_UNIT_KEY],
        },
        t.folio,
      ),
    );
    if (!current || current.items.length + items.length > max) {
      current = { tickets: [], items: [] };
      drafts.push(current);
    }
    current.tickets.push(t);
    current.items.push(...items);
  }

  return drafts.map((d) => {
    let largest = d.tickets[0];
    let largestGross = -1;
    for (const t of d.tickets) {
      const gross = t.groups.reduce((s, g) => s + g.gross, 0);
      if (gross > largestGross) {
        largest = t;
        largestGross = gross;
      }
    }
    const docId = i.docIds();
    const body = finalize({
      type: "I",
      customer: publicoEnGeneral(i.issuerPostalCode),
      items: d.items,
      payment_form: paymentFormFor(largest.payments, i.cardForm),
      payment_method: "PUE",
      use: "S01",
      currency: "MXN",
      series: SERIES.global,
      address: { zip: i.issuerPostalCode },
      global: {
        periodicity: i.period.periodicity,
        months: i.period.months,
        year: i.period.year,
      },
      external_id: docId,
      idempotency_key: docId,
    });
    const groups = d.tickets.flatMap((t) => t.groups);
    return {
      docId,
      body,
      ticketIds: d.tickets.map((t) => t.id),
      expectedTotal: groups.reduce((s, g) => s + g.gross, 0),
      expectedTax: groups.reduce((s, g) => s + g.tax, 0),
    };
  });
}

export type EgresoBuildInput = {
  docId: string;
  /** Folio of the refunded ticket. */
  folio: string;
  /** The covering CFDI (valid): a nominative invoice (with its receptor) or a global. */
  parent: {
    kind: "invoice" | "global";
    uuid: string;
    receptor: Receptor | null;
    paymentForm: string | null;
    /** The parent carried the RESICO ISR retention: the credit note reverses it too. */
    withholding?: boolean;
  };
  /** The refund's fiscal_adjustments rows and its tender method. */
  refund: {
    method: string;
    groups: readonly { category: TaxCategory; gross: number; tax: number }[];
  };
  issuerPostalCode: string;
  /** cfdi_settings.card_payment_form, when the parent's form is not a card form. */
  cardForm: CardForm;
  /**
   * A substitute credit note (CFDI-SAT-2): the UUID of the credit note it replaces (relation 04,
   * next to the 01 relation to the parent) and the FormaPago the manager chose.
   */
  replaces?: { uuid: string; paymentForm: "01" | CardForm } | null;
  /**
   * What the note credits: a refund (default), or a ticket's whole net amount in a global before
   * its nominative invoice (route III, CFDI-SAT-3), with the ticket's own FormaPago.
   */
  credit?: { purpose: "invoiced"; paymentForm: "01" | CardForm } | null;
};
export type EgresoBuild = {
  body: FInvoiceInput;
  /** Before any retention. */
  expectedTotal: number;
  /**
   * Canonical: what Facturapi stamps. Σ extractTax(adj.gross) per category for tax-inclusive
   * concepts; Σ base × rate when the parent carried the RESICO retention (base-priced concepts).
   */
  expectedTax: number;
  /** ISR retained (RESICO), canonical; 0 without retention. */
  expectedWithholding: number;
  /**
   * Σ adj.tax as fiscal recorded it. fiscal's refundTaxSplit is cumulative
   * (extract(before + amount) − extract(before)), so this may differ from expectedTax by ≤ 1
   * centavo per category; the difference is expected, recorded, never alerted.
   */
  fiscalTax: number;
  conceptCount: number;
};

/**
 * The credit note (CFDI de egreso, series NC) for a refund after a valid CFDI (SAT global guide,
 * Apéndice 2 route I): related 01 to the parent's UUID, one concept per refunded category
 * (84111506, ACT, "Devolución del ticket {folio}"), receptor = the parent's (G02 when the régimen
 * allows it, else S01) or PUBLICO EN GENERAL with S01 for a global parent.
 *
 * Open item (sandbox): Anexo 20 requires InformacionGlobal when the receptor is XAXX010101000 with
 * the name PUBLICO EN GENERAL, but Facturapi's InvoiceEgresoInput has no `global` field. The egreso
 * of a global parent is built as the spec says and must be verified in the sandbox (docs/CFDI.md).
 */
export function buildEgresoRequest(i: EgresoBuildInput): EgresoBuild {
  const { parent, refund } = i;
  if (parent.kind === "invoice" && !parent.receptor)
    throw new DomainError("cfdi_parent_receptor_missing", 409);
  const sums = new Map<TaxCategory, { gross: number; tax: number }>();
  for (const a of refund.groups) {
    const category = checkFigure(a.category, a.gross, a.tax);
    const s = sums.get(category) ?? { gross: 0, tax: 0 };
    sums.set(category, { gross: s.gross + a.gross, tax: s.tax + a.tax });
  }
  const groups = TAX_CATEGORIES.flatMap((category) => {
    const s = sums.get(category);
    return s && s.gross > 0 ? [{ category, ...s }] : [];
  });
  if (!groups.length) throw nothingToInvoice();

  const receptor = parent.kind === "invoice" ? parent.receptor : null;
  // Only a nominative parent can carry the retention (globals go to PUBLICO EN GENERAL).
  const withhold = !!receptor && !!parent.withholding;
  const use =
    receptor && usoCfdiAllowed(receptor.regime, "G02") ? "G02" : "S01";
  const cardForms = ["04", "28"];
  const paymentForm =
    i.replaces?.paymentForm ??
    i.credit?.paymentForm ??
    (refund.method === "external"
      ? parent.paymentForm && cardForms.includes(parent.paymentForm)
        ? parent.paymentForm
        : i.cardForm
      : "01");
  const body = finalize({
    type: "E",
    customer: receptor
      ? customerFor(receptor)
      : publicoEnGeneral(i.issuerPostalCode),
    items: groups.map((g) =>
      groupItem(
        g,
        {
          description: `${i.credit ? "Factura nominativa del ticket" : "Devolución del ticket"} ${i.folio}${categorySuffix(g.category)}`,
          key: EGRESO_PRODUCT_KEY,
          unit: SAT_GLOBAL_UNIT_KEY,
          unitName: UNIT_NAMES[SAT_GLOBAL_UNIT_KEY],
        },
        // InvoiceEgresoInput products have no sku: the folio is in the description.
        null,
        withhold,
      ),
    ),
    payment_form: paymentForm,
    payment_method: "PUE",
    use,
    currency: "MXN",
    series: SERIES.egreso,
    address: { zip: i.issuerPostalCode },
    related_documents: [
      { relationship: "01", documents: [parent.uuid] },
      ...(i.replaces
        ? [{ relationship: "04" as const, documents: [i.replaces.uuid] }]
        : []),
    ],
    external_id: i.docId,
    idempotency_key: i.docId,
  });
  const canonical = canonicalAmounts(body);
  return {
    body,
    expectedTotal: groups.reduce((s, g) => s + g.gross, 0),
    expectedTax: withhold
      ? canonical.tax
      : groups.reduce(
          (s, g) => s + extractTax(g.gross, TAX_RULES[g.category].rateBps).tax,
          0,
        ),
    expectedWithholding: canonical.withheld,
    fiscalTax: groups.reduce((s, g) => s + g.tax, 0),
    conceptCount: body.items.length,
  };
}
