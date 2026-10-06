/**
 * COMPAT SHIM (cfdi track only; deleted at the fiscal rebase, never merged as is).
 *
 * cfdi steps 7-17 code against fiscal 027's read contract (LD-15 cfdi Q1, LD-16 L4,
 * wave2-cross-track C4): `ticketForCfdi(tx, ticketId): Promise<CfdiTicketPayload>` exported by the
 * leaf module server/fiscal-read.ts (imports db/shared only, re-exported by server/fiscal.ts). That
 * module does not exist on this branch yet, so this file provides the same signature, reading the
 * 027 tables exactly as specified (fiscal.md §3 and §4.4), with the same leaf import rule.
 *
 * At the fiscal rebase:
 *   1. replace every `from "../compat/cfdi-fiscal.js"` / `"../../compat/cfdi-fiscal.js"` import of
 *      ticketForCfdi with `from "../fiscal-read.js"` (fiscal's implementation);
 *   2. delete fiscalTablesPresent() and its call sites (027 is then always present), and this file;
 *   3. reset the track databases (the 030 guarded FK and lookup policy then apply).
 */
import { DomainError } from "../../shared/domain.js";
import {
  formatFolio,
  TAX_CATEGORIES,
  TAX_RULES,
  type CfdiTicketPayload,
  type FiscalTicketView,
  type RefundTaxView,
  type TaxCategory,
  type TicketLineSnapshot,
} from "../../shared/fiscal.js";
import type { Tx } from "../db.js";

/** Pre-027 branch databases only: whether fiscal's tables exist. Always true after the rebase. */
export async function fiscalTablesPresent(tx: Tx): Promise<boolean> {
  const [r] = await tx<{ present: boolean }[]>`
    select to_regclass('public.fiscal_tickets') is not null as present`;
  return !!r?.present;
}

type TicketRow = {
  id: string;
  order_id: string;
  series: string;
  number: string | number;
  issued_at: Date;
  business_date: string;
  source: FiscalTicketView["source"];
  self_invoice_code: string;
  issuer: FiscalTicketView["issuer"];
  currency: string;
  gross_before_discount: number;
  discount: number;
  unallocated_discount: number;
  gross: number;
  base: number;
  tax: number;
  tip: number;
  tax_basis: FiscalTicketView["basis"];
  lines: TicketLineSnapshot[];
  payments: FiscalTicketView["payments"];
  taxes: {
    category: TaxCategory;
    rate_bps: number | null;
    gross_before_discount: number;
    discount: number;
    gross: number;
    base_before_discount: number;
    discount_base: number;
    base: number;
    tax: number;
  }[];
  adjustments: {
    refund_id: string;
    category: TaxCategory;
    rate_bps: number | null;
    gross: number;
    base: number;
    tax: number;
    business_date: string;
    created_at: string;
  }[];
};

/**
 * The CFDI payload of one fiscal ticket (fiscal contract): the ticket, one concept per tax group
 * (NoIdentificacion = folio), the itemized line snapshots with their `valid` flags, the payments in
 * created_at order and the order's refund adjustments grouped by refund. Throws
 * DomainError("cfdi_ticket_not_found", 404) when the ticket does not exist in this tenant.
 */
export async function ticketForCfdi(
  tx: Tx,
  ticketId: string,
): Promise<CfdiTicketPayload> {
  const [row] = await tx<TicketRow[]>`
    select t.id, t.order_id, t.series, t.number, t.issued_at, t.business_date::text as business_date,
      t.source, t.self_invoice_code, t.issuer, t.currency, t.gross_before_discount, t.discount,
      t.unallocated_discount, t.gross, t.base, t.tax, t.tip, t.tax_basis, t.lines, t.payments,
      coalesce((select jsonb_agg(to_jsonb(c) - 'tenant_id' - 'ticket_id' order by c.category)
         from fiscal_ticket_taxes c where c.tenant_id = t.tenant_id and c.ticket_id = t.id), '[]') as taxes,
      coalesce((select jsonb_agg(jsonb_build_object('refund_id', a.refund_id, 'category', a.category,
           'rate_bps', a.rate_bps, 'gross', a.gross, 'base', a.base, 'tax', a.tax,
           'business_date', a.business_date::text, 'created_at', a.created_at)
         order by a.created_at, a.refund_id, a.category)
         from fiscal_adjustments a where a.tenant_id = t.tenant_id and a.order_id = t.order_id), '[]') as adjustments
    from fiscal_tickets t where t.id = ${ticketId}`;
  if (!row) throw new DomainError("cfdi_ticket_not_found", 404);
  const folio = formatFolio(row.series, Number(row.number));
  const order = (c: TaxCategory) => TAX_CATEGORIES.indexOf(c);
  const groups = [...row.taxes]
    .sort((a, b) => order(a.category) - order(b.category))
    .map((g) => ({
      category: g.category,
      rateBps: g.rate_bps,
      grossBeforeDiscount: g.gross_before_discount,
      discount: g.discount,
      gross: g.gross,
      baseBeforeDiscount: g.base_before_discount,
      discountBase: g.discount_base,
      base: g.base,
      tax: g.tax,
    }));
  const refunds = new Map<string, RefundTaxView>();
  for (const a of row.adjustments) {
    const view = refunds.get(a.refund_id) ?? {
      refundId: a.refund_id,
      createdAt: new Date(a.created_at).toISOString(),
      businessDate: a.business_date,
      groups: [],
    };
    view.groups.push({
      category: a.category,
      rateBps: a.rate_bps,
      gross: a.gross,
      base: a.base,
      tax: a.tax,
    });
    refunds.set(a.refund_id, view);
  }
  const lines = row.lines ?? [];
  const payments = [...(row.payments ?? [])].sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
  );
  const ticket: FiscalTicketView = {
    id: row.id,
    orderId: row.order_id,
    folio,
    series: row.series,
    number: Number(row.number),
    issuedAt: new Date(row.issued_at).toISOString(),
    businessDate: row.business_date,
    source: row.source,
    selfInvoiceCode: row.self_invoice_code,
    issuer: row.issuer,
    currency: "MXN",
    grossBeforeDiscount: row.gross_before_discount,
    discount: row.discount,
    unallocatedDiscount: row.unallocated_discount,
    gross: row.gross,
    base: row.base,
    tax: row.tax,
    tip: row.tip,
    basis: row.tax_basis,
    groups,
    lines,
    payments,
  };
  return {
    ticket,
    concepts: groups.map((g) => ({
      category: g.category,
      satTax: "002" as const,
      satFactor: TAX_RULES[g.category].satFactor,
      satRate: TAX_RULES[g.category].satRate,
      objetoImp: "02" as const,
      noIdentificacion: folio,
      grossBeforeDiscount: g.grossBeforeDiscount,
      discount: g.discount,
      gross: g.gross,
      baseBeforeDiscount: g.baseBeforeDiscount,
      discountBase: g.discountBase,
      base: g.base,
      tax: g.tax,
    })),
    itemized: lines,
    itemizedValid: lines.every((l) => l.valid),
    payments: payments.map((p) => ({ method: p.method, amount: p.amount })),
    refunds: [...refunds.values()],
  };
}

/**
 * The tender method of a refund: discounts 028's `refunds.method` ('cash' | 'external',
 * wave2-cross-track C26). Before 028 the column does not exist and every refund is the legacy cash
 * refund of a tender, so the tender's method is read instead. At the discounts/fiscal rebase this
 * becomes `select method from refunds where id = $1` in server/cfdi/worker/freeze.ts.
 */
export async function refundMethod(
  tx: Tx,
  refundId: string,
): Promise<"cash" | "external" | null> {
  const [col] = await tx<{ present: boolean }[]>`
    select exists(select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'refunds' and column_name = 'method') as present`;
  const [r] = col?.present
    ? await tx`select method from refunds where id = ${refundId}`
    : await tx`
        select t.method from refunds r join tenders t on t.tenant_id = r.tenant_id and t.id = r.tender_id
        where r.id = ${refundId}`;
  return (r?.method as "cash" | "external" | undefined) ?? null;
}
