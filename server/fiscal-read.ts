// server/fiscal-read.ts — fiscal readers (migration 027): the fiscal context, tickets, their
// tax groups and refund adjustments, the order JSON's fiscal member, the CFDI payload and the
// ticket identity. A LEAF module: it imports only ./db.js and shared/*, so the jobs worker
// (cfdi 030) and public ordering can read tickets without loading the web sales graph
// (orders, auth, access). server/fiscal.ts re-exports everything here (LD-15, LD-16 C4).
import type { Tx } from "./db.js";
import { DomainError, type PricedLine } from "../shared/domain.js";
import {
  DEFAULT_FISCAL_CONTEXT,
  formatFolio,
  orderTaxSummary,
  REGIMEN_FISCAL,
  TAX_CATEGORIES,
  TAX_REGIONS,
  TAX_RULES,
  type CategoryTax,
  type CfdiTicketPayload,
  type FiscalContext,
  type FiscalTicketView,
  type IssuerSnapshot,
  type OrderFiscal,
  type RefundTaxView,
  type TaxCategory,
  type TaxGroup,
  type TaxSummary,
} from "../shared/fiscal.js";

/** A fiscal_tickets row as JSON (`to_jsonb(t) - 'tenant_id'`) or as a postgres.js row. */
export type TicketRecord = {
  id: string;
  order_id: string;
  series: string;
  number: number | string;
  self_invoice_code: string;
  issued_at: string | Date;
  business_date: string | Date;
  source: FiscalTicketView["source"];
  currency: "MXN";
  gross_before_discount: number;
  discount: number;
  unallocated_discount: number;
  gross: number;
  base: number;
  tax: number;
  tip: number;
  tax_basis: TaxSummary["basis"];
  issuer: IssuerSnapshot | null;
  lines: FiscalTicketView["lines"];
  payments: FiscalTicketView["payments"];
};
/** A fiscal_ticket_taxes row. */
export type TicketTaxRecord = {
  category: TaxCategory;
  rate_bps: number | null;
  gross_before_discount: number;
  discount: number;
  gross: number;
  base_before_discount: number;
  discount_base: number;
  base: number;
  tax: number;
};
/** A fiscal_adjustments row. */
export type AdjustmentRecord = {
  refund_id: string;
  category: TaxCategory;
  rate_bps: number | null;
  gross: number;
  base: number;
  tax: number;
  business_date: string | Date;
  created_at: string | Date;
};
/** A restaurant_fiscal_profiles row (the columns readers use). */
export type ProfileRecord = {
  rfc: string | null;
  legal_name: string | null;
  regime: string | null;
  postal_code: string | null;
  address: Partial<IssuerSnapshot["address"]> | null;
  ticket_series: string;
  tax_region: FiscalContext["region"];
  default_tax_category: TaxCategory;
  /** CFF art. 29-A fr. I: several premises make the branch address part of the identity. */
  multiple_branches?: boolean | null;
};

const iso = (v: string | Date) => new Date(v).toISOString();
const day = (v: string | Date) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const categoryOrder = (c: TaxCategory) => TAX_CATEGORIES.indexOf(c);
const byCategory = <T extends { category: TaxCategory }>(rows: T[]) =>
  [...rows].sort(
    (a, b) => categoryOrder(a.category) - categoryOrder(b.category),
  );

/** The profile's tax settings, or the default (general region, IVA 16%) without a profile. */
export function contextOf(
  row: Pick<ProfileRecord, "tax_region" | "default_tax_category"> | null,
): FiscalContext {
  if (
    !row ||
    !(TAX_REGIONS as readonly string[]).includes(row.tax_region) ||
    !(TAX_CATEGORIES as readonly string[]).includes(row.default_tax_category)
  )
    return DEFAULT_FISCAL_CONTEXT;
  return { region: row.tax_region, defaultCategory: row.default_tax_category };
}

/**
 * The issuer data a ticket freezes, or null while the profile is incomplete: no RFC, or an RFC
 * with several premises and no branch street, municipality and state (CFF art. 29-A fr. I).
 */
export function issuerOf(
  row: ProfileRecord | null,
  tradeName: string,
): IssuerSnapshot | null {
  if (!row?.rfc || !row.legal_name || !row.regime || !row.postal_code)
    return null;
  const address = row.address ?? {};
  if (
    row.multiple_branches &&
    !(["street", "municipality", "state"] as const).every((k) =>
      address[k]?.trim(),
    )
  )
    return null;
  return {
    tradeName,
    rfc: row.rfc,
    legalName: row.legal_name,
    regime: row.regime,
    regimeName: {
      es: REGIMEN_FISCAL[row.regime]?.es ?? "",
      en: REGIMEN_FISCAL[row.regime]?.en ?? "",
    },
    postalCode: row.postal_code,
    address: {
      street: address.street ?? "",
      neighborhood: address.neighborhood ?? "",
      municipality: address.municipality ?? "",
      state: address.state ?? "",
    },
    taxRegion: row.tax_region,
  };
}

/** fiscalContext: the restaurant's tax region and default category (one PK statement). */
export async function fiscalContext(tx: Tx): Promise<FiscalContext> {
  const [row] =
    await tx`select tax_region,default_tax_category from restaurant_fiscal_profiles`;
  return contextOf((row as ProfileRecord | undefined) ?? null);
}

export function groupView(r: TicketTaxRecord): TaxGroup {
  return {
    category: r.category,
    rateBps: r.rate_bps,
    grossBeforeDiscount: r.gross_before_discount,
    discount: r.discount,
    gross: r.gross,
    baseBeforeDiscount: r.base_before_discount,
    discountBase: r.discount_base,
    base: r.base,
    tax: r.tax,
  };
}

/** Maps a stored ticket and its category rows to the wire view (reprints never recompute). */
export function ticketView(
  t: TicketRecord,
  taxes: TicketTaxRecord[],
): FiscalTicketView {
  const number = Number(t.number);
  return {
    id: t.id,
    orderId: t.order_id,
    folio: formatFolio(t.series, number),
    series: t.series,
    number,
    issuedAt: iso(t.issued_at),
    businessDate: day(t.business_date),
    source: t.source,
    selfInvoiceCode: t.self_invoice_code,
    issuer: t.issuer ?? null,
    currency: "MXN",
    grossBeforeDiscount: t.gross_before_discount,
    discount: t.discount,
    unallocatedDiscount: t.unallocated_discount,
    gross: t.gross,
    base: t.base,
    tax: t.tax,
    tip: t.tip,
    basis: t.tax_basis,
    groups: byCategory(taxes).map(groupView),
    lines: t.lines,
    payments: t.payments,
  };
}

/** Refund adjustments grouped per refund (in their stored order), categories in canonical order. */
export function refundViews(rows: AdjustmentRecord[]): RefundTaxView[] {
  const views = new Map<string, RefundTaxView>();
  for (const a of rows) {
    let view = views.get(a.refund_id);
    if (!view) {
      view = {
        refundId: a.refund_id,
        createdAt: iso(a.created_at),
        businessDate: day(a.business_date),
        groups: [],
      };
      views.set(a.refund_id, view);
    }
    view.groups.push({
      category: a.category,
      rateBps: a.rate_bps,
      gross: a.gross,
      base: a.base,
      tax: a.tax,
    } satisfies CategoryTax);
  }
  for (const view of views.values()) view.groups = byCategory(view.groups);
  return [...views.values()];
}

/** One ticket by id with its category rows (one statement), or null. */
export async function readTicket(
  tx: Tx,
  ticketId: string,
): Promise<FiscalTicketView | null> {
  const [row] = await tx`select to_jsonb(t) - 'tenant_id' as ticket,
      coalesce((select jsonb_agg(to_jsonb(c) - 'tenant_id') from fiscal_ticket_taxes c
        where c.tenant_id=t.tenant_id and c.ticket_id=t.id),'[]') as taxes
    from fiscal_tickets t where t.id=${ticketId}`;
  return row
    ? ticketView(row.ticket as TicketRecord, row.taxes as TicketTaxRecord[])
    : null;
}

/** The refund adjustments of one order (one statement), oldest first. */
export async function orderRefundTax(
  tx: Tx,
  orderId: string,
): Promise<RefundTaxView[]> {
  const rows =
    await tx`select refund_id,category,rate_bps,gross,base,tax,business_date::text as business_date,created_at
      from fiscal_adjustments where order_id=${orderId} order by created_at,category`;
  return refundViews(rows as unknown as AdjustmentRecord[]);
}

/** What fiscalRows returns per order id: the stored ticket, its taxes and adjustments. */
export type FiscalRow = {
  ticket: TicketRecord | null;
  taxes: TicketTaxRecord[];
  adjustments: AdjustmentRecord[];
  ctx: FiscalContext;
};

/**
 * One statement for any number of orders: a member of the Promise.all in service's getOrders
 * (contract C-14). Returns an entry for every requested id. Never per order.
 */
export async function fiscalRows(
  tx: Tx,
  ids: string[],
): Promise<Map<string, FiscalRow>> {
  const rows =
    await tx`with ids as (select unnest(${tx.array(ids)}::uuid[]) as id),
      prof as (select tax_region,default_tax_category from restaurant_fiscal_profiles)
    select i.id as order_id,
      case when t.id is null then null else to_jsonb(t) - 'tenant_id' end as ticket,
      (select jsonb_agg(to_jsonb(c) - 'tenant_id') from fiscal_ticket_taxes c
         where c.tenant_id=t.tenant_id and c.ticket_id=t.id) as taxes,
      (select jsonb_agg(to_jsonb(a) - 'tenant_id' order by a.created_at,a.category)
         from fiscal_adjustments a where a.order_id=i.id) as adjustments,
      (select to_jsonb(prof) from prof) as ctx
    from ids i left join fiscal_tickets t on t.order_id=i.id`;
  const map = new Map<string, FiscalRow>();
  for (const r of rows)
    map.set(r.order_id as string, {
      ticket: (r.ticket as TicketRecord | null) ?? null,
      taxes: (r.taxes as TicketTaxRecord[] | null) ?? [],
      adjustments: (r.adjustments as AdjustmentRecord[] | null) ?? [],
      ctx: contextOf((r.ctx as ProfileRecord | null) ?? null),
    });
  return map;
}

/**
 * Order.fiscal from a fiscalRows entry. Pure: no statement. Without a ticket the provisional
 * summary of the current lines (pre-bill, partial payments) is computed with the restaurant's
 * context; an unreconcilable order (gross below its total) shows none rather than failing a read.
 */
export function composeOrderFiscal(
  row: FiscalRow | undefined,
  order: {
    total: number;
    lines: PricedLine[];
    lineDiscounts?: Readonly<Record<string, number>>;
  },
): OrderFiscal {
  const ticket = row?.ticket ? ticketView(row.ticket, row.taxes) : null;
  let provisional: TaxSummary | null = null;
  if (!ticket)
    try {
      provisional = orderTaxSummary({
        lines: order.lines,
        lineDiscounts: order.lineDiscounts,
        total: order.total,
        ctx: row?.ctx ?? DEFAULT_FISCAL_CONTEXT,
      });
    } catch (e) {
      if (
        !(e instanceof DomainError) ||
        (e.code !== "fiscal_total_mismatch" && e.code !== "invalid_amount")
      )
        throw e;
    }
  return {
    ticket,
    provisional,
    refunds: refundViews(row?.adjustments ?? []),
  };
}

/**
 * For cfdi 030: the ticket with one concept per tax group (NoIdentificacion = folio, SAT codes
 * from TAX_RULES), the itemized lines with their stored validity flags, the payments and the
 * order's refund adjustments. Reads only fiscal_* tables (two statements).
 */
export async function ticketForCfdi(
  tx: Tx,
  ticketId: string,
): Promise<CfdiTicketPayload> {
  const ticket = await readTicket(tx, ticketId);
  if (!ticket) throw new DomainError("not_found", 404);
  const refunds = await orderRefundTax(tx, ticket.orderId);
  return {
    ticket,
    concepts: ticket.groups.map((g) => {
      const rule = TAX_RULES[g.category];
      return {
        category: g.category,
        satTax: rule.satTax,
        satFactor: rule.satFactor,
        satRate: rule.satRate,
        objetoImp: rule.objetoImp,
        noIdentificacion: ticket.folio,
        grossBeforeDiscount: g.grossBeforeDiscount,
        discount: g.discount,
        gross: g.gross,
        baseBeforeDiscount: g.baseBeforeDiscount,
        discountBase: g.discountBase,
        base: g.base,
        tax: g.tax,
      };
    }),
    itemized: ticket.lines,
    itemizedValid: ticket.lines.every((l) => l.valid),
    payments: ticket.payments.map((p) => ({
      method: p.method,
      amount: p.amount,
    })),
    refunds,
  };
}

export async function hasFiscalTicket(
  tx: Tx,
  orderId: string,
): Promise<boolean> {
  const [row] =
    await tx`select exists(select 1 from fiscal_tickets where order_id=${orderId}) as issued`;
  return !!row?.issued;
}

/**
 * A ticketed check takes no more lines or discounts (D1, LD-15 fiscal Q2): late items go out
 * as a new order for the same table. One index probe.
 */
export async function assertNoFiscalTicket(
  tx: Tx,
  orderId: string,
): Promise<void> {
  if (await hasFiscalTicket(tx, orderId))
    throw new DomainError("fiscal_ticket_issued", 409);
}

/** The printed identity of an order's ticket (public ordering's status page, LD-18 LD-P3). */
export type FiscalTicketIdentity = { folio: string; selfInvoiceCode: string };

/** One statement: the order's folio and self-invoice code, or null while it has no ticket. */
export async function fiscalTicketIdentity(
  tx: Tx,
  orderId: string,
): Promise<FiscalTicketIdentity | null> {
  const [row] =
    await tx`select series, number, self_invoice_code from fiscal_tickets where order_id = ${orderId}`;
  return row
    ? {
        folio: formatFolio(row.series, Number(row.number)),
        selfInvoiceCode: row.self_invoice_code,
      }
    : null;
}
