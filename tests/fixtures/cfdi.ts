// Helpers for the cfdi unit and contract tests: fiscal ticket payloads built with the fiscal core
// exactly as server/fiscal.ts ticketForCfdi() will (orderTaxBreakdown → ticketLineSnapshots), so
// the builders are tested against fiscal's real figures, plus fake Facturapi keys.
import {
  orderTaxBreakdown,
  parseFolio,
  refundTaxSplit,
  TAX_RULES,
  ticketLineSnapshots,
  DEFAULT_FISCAL_CONTEXT,
  type CfdiTicketPayload,
  type FiscalContext,
  type RefundTaxView,
  type TaxCategory,
  type TaxedLine,
} from "../../shared/fiscal";
import { lineRemaining } from "../../shared/settlement";
import type { Receptor } from "../../shared/cfdi";
import type { FacturapiKey } from "../../server/cfdi/facturapi";
import { fakeId, line } from "./fiscal";

export { fakeId, line };

/** Fake Facturapi keys: right prefixes, obviously not real (and too short for secret scanners). */
export const USER_KEY: FacturapiKey = {
  kind: "user",
  secret: "sk_user_fixture",
};
export const TEST_KEY: FacturapiKey = {
  kind: "test",
  secret: "sk_test_fixture",
};
export const LIVE_KEY: FacturapiKey = {
  kind: "live",
  secret: "sk_live_fixture",
};

/** SAT CFDI 4.0 test identities (public test data; spec D22). */
export const RECEPTOR_MORAL: Receptor = {
  rfc: "URE180429TM6",
  legalName: "UNIVERSIDAD ROBOTICA ESPAÑOLA",
  regime: "601",
  postalCode: "86991",
  use: "G03",
  email: "facturas@example.com",
};
export const RECEPTOR_FISICA: Receptor = {
  rfc: "XIQB891116QE4",
  legalName: "BERENICE XIMO QUEZADA",
  regime: "612",
  postalCode: "40968",
  use: "G01",
  email: null,
};
export const ISSUER_POSTAL_CODE = "42501";

/** A line of a given category: `line()` with the product's fiscal category. */
export function taxedLine(
  total: number,
  category: TaxCategory | "default" = "default",
  extra: Partial<Parameters<typeof line>[0]> = {},
): TaxedLine {
  return line({ total, fiscal: { taxCategory: category }, ...extra });
}

/** payments (037): platform tenders and the card type of integrated card tenders. */
export type Payment = {
  method: "cash" | "external" | "platform";
  amount: number;
  cardType?: "credit" | "debit" | "prepaid";
};

/** The CfdiTicketPayload of a paid order (no tip), as fiscal's ticketForCfdi() returns it. */
export function cfdiPayload(o: {
  lines: TaxedLine[];
  /** orders.total; defaults to the sum of the lines' remaining totals. */
  total?: number;
  folio?: string;
  payments?: Payment[];
  refunds?: RefundTaxView[];
  ctx?: FiscalContext;
  issuedAt?: string;
  businessDate?: string;
}): CfdiTicketPayload {
  const ctx = o.ctx ?? DEFAULT_FISCAL_CONTEXT;
  const total =
    o.total ?? o.lines.reduce((s, l) => s + lineRemaining(l).total, 0);
  const breakdown = orderTaxBreakdown({ lines: o.lines, total, ctx });
  const s = breakdown.summary;
  const lines = ticketLineSnapshots(o.lines, breakdown);
  const folio = o.folio ?? "A-000123";
  const parsed = parseFolio(folio) ?? { series: "A", number: 123 };
  const payments = o.payments ?? [{ method: "cash", amount: total }];
  return {
    ticket: {
      id: fakeId(),
      orderId: fakeId(),
      folio,
      series: parsed.series,
      number: parsed.number,
      issuedAt: o.issuedAt ?? "2026-10-05T19:30:00.000Z",
      businessDate: o.businessDate ?? "2026-10-05",
      source: o.lines.length ? "sale" : "recovery",
      selfInvoiceCode: "7K3M9QX2PA8D",
      issuer: {
        tradeName: "La Fonda de Prueba",
        rfc: "EKU9003173C9",
        legalName: "ESCUELA KEMPER URGATE",
        regime: "601",
        regimeName: {
          es: "General de Ley Personas Morales",
          en: "General regime for legal entities",
        },
        postalCode: ISSUER_POSTAL_CODE,
        address: { street: "", neighborhood: "", municipality: "", state: "" },
        taxRegion: ctx.region,
      },
      currency: "MXN",
      grossBeforeDiscount: s.grossBeforeDiscount,
      discount: s.discount,
      unallocatedDiscount: s.unallocatedDiscount,
      gross: s.gross,
      base: s.base,
      tax: s.tax,
      tip: 0,
      basis: s.basis,
      groups: s.groups,
      lines,
      payments: payments.map((p) => ({
        ...p,
        tip: 0,
        reference: null,
        at: "2026-10-05T19:29:00.000Z",
      })),
    },
    concepts: s.groups.map((g) => ({
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
    payments,
    refunds: o.refunds ?? [],
  };
}

/**
 * Refunds recorded with fiscal's refundTaxSplit, one after the other, against the payload's ticket
 * groups (what server/fiscal.ts recordRefundTax stores in fiscal_adjustments).
 */
export function recordRefunds(
  payload: CfdiTicketPayload,
  amounts: number[],
): RefundTaxView[] {
  const views: RefundTaxView[] = [];
  for (const amount of amounts) {
    const groups = refundTaxSplit({
      refundGross: amount,
      saleGroups: payload.ticket.groups,
      previous: views.flatMap((v) => v.groups),
    });
    views.push({
      refundId: fakeId(),
      createdAt: "2026-10-05T20:00:00.000Z",
      businessDate: payload.ticket.businessDate,
      groups,
    });
  }
  return views;
}
