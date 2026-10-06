import type { Locale } from "../../../shared/domain";
import { formatFolio } from "../../../shared/fiscal";
import type { SalesSummary } from "../../../shared/reports";
import { strings } from "../../i18n";
import { tenderMethodLabel } from "../../labels";
import { fill, money, pct } from "./format";

/**
 * One Resumen row: a label with an amount (minor units, signed: deductions are negative) and/or
 * a quantity, or a text line. The Resumen cards, the summary CSV (spec §5.6 "summary") and the
 * corte del día all read these, so a label bound for one binds for all (§5.8).
 */
export type SummaryLine = {
  id: string;
  label: string;
  amount: number | null;
  quantity: number | null;
  /** The figure as shown when it is not a plain amount (counts, percents, "—"). */
  display?: string;
  strong?: boolean;
  indent?: boolean;
};
export type SummarySection = {
  id: "sales" | "tax" | "methods" | "cost" | "drawers";
  title: string;
  lines: SummaryLine[];
};

const RATE: Record<string, string> = { iva16: "16%", iva8: "8%" };

/** Every Resumen row of a summary, in screen order. */
export function summarySections(
  summary: SalesSummary,
  locale: Locale,
): SummarySection[] {
  const t = strings[locale];
  const m = money(summary.currency, locale);
  const s = summary.sales;
  const line = (
    id: string,
    label: string,
    amount: number | null,
    extra: Partial<SummaryLine> = {},
  ): SummaryLine => ({ id, label, amount, quantity: null, ...extra });
  const sales: SummaryLine[] = [
    line("grossSales", t.reportsGrossSales, s.grossSales),
    line("discounts", t.reportsDiscounts, -s.discounts),
    line("courtesies", t.reportsCourtesies, -s.courtesies, { indent: true }),
    line("salesTotal", t.reportsSalesTotal, s.salesTotal, { strong: true }),
    line("orders", t.reportsOrders, null, {
      quantity: s.orders,
      display: String(s.orders),
    }),
    line("averageTicket", t.reportsAverageTicket, s.averageTicket),
    line("refunds", t.reportsRefunds, -summary.refunds.total, {
      display:
        (summary.refunds.total ? "−" : "") +
        m(summary.refunds.total) +
        " · " +
        fill(t.reportsRefundsSplit, {
          cash: m(summary.refunds.cash),
          external: m(summary.refunds.external),
        }),
    }),
    line("voids", t.reportsVoids, s.voids.amount, {
      quantity: s.voids.units,
      display:
        m(s.voids.amount) +
        " · " +
        fill(t.reportsVoidUnits, { n: s.voids.units }),
    }),
  ];
  if (s.offlineSales.count > 0)
    sales.push(
      line(
        "offlineSales",
        fill(t.reportsOfflineSales, {
          n: s.offlineSales.count,
          amount: m(s.offlineSales.total),
          tips: m(s.offlineSales.tips),
        }),
        s.offlineSales.total,
        { quantity: s.offlineSales.count },
      ),
    );
  if (s.recovery.count > 0)
    sales.push(
      line("recovery", t.reportsRecoveredSales, s.recovery.total, {
        quantity: s.recovery.count,
      }),
    );
  if (s.cancelledOrders > 0)
    sales.push(
      line(
        "cancelledOrders",
        fill(t.reportsCancelledOrders, {
          n: s.cancelledOrders,
          amount: m(s.cancelledAmount),
        }),
        s.cancelledAmount,
        { quantity: s.cancelledOrders },
      ),
    );

  const tax: SummaryLine[] = [];
  if (summary.tax) {
    const x = summary.tax;
    for (const c of x.sales) {
      const rate = RATE[c.category];
      if (rate) {
        tax.push(
          line(
            `taxSales.${c.category}`,
            fill(t.reportsTaxSales, { rate }),
            c.gross,
          ),
          line(
            `taxBase.${c.category}`,
            fill(t.reportsTaxBase, { rate }),
            c.base,
          ),
          line(
            `taxAmount.${c.category}`,
            fill(t.reportsTaxAmount, { rate }),
            c.tax,
          ),
        );
      } else
        tax.push(
          line(
            `taxSales.${c.category}`,
            c.category === "iva0" ? t.reportsTaxZero : t.reportsTaxExempt,
            c.gross,
          ),
        );
    }
    tax.push(
      line(
        "taxRefundedBase",
        t.reportsTaxRefundedBase,
        -(x.totals.refundGross - x.totals.refundTax),
      ),
      line("taxRefunded", t.reportsTaxRefunded, -x.totals.refundTax),
      line("taxNet", t.reportsTaxNet, x.totals.netTax, { strong: true }),
      line("netSalesExTax", t.reportsNetSalesExTax, x.totals.base),
      line("salesAfterRefunds", t.reportsSalesAfterRefunds, x.totals.netGross),
      line("netAfterRefunds", t.reportsNetAfterRefunds, x.totals.netBase),
    );
    for (const run of summary.tax.tickets.series)
      tax.push(
        line(
          `folios.${run.series}`,
          fill(t.reportsFolios, {
            first: formatFolio(run.series, run.first),
            last: formatFolio(run.series, run.last),
            n: run.count,
          }),
          null,
          { quantity: run.count, display: "" },
        ),
      );
    tax.push(
      line(
        "ticketedSplit",
        fill(t.reportsTicketedSplit, {
          ticketed: m(s.ticketed.gross),
          unticketed: m(
            s.unticketed.openBalance + s.unticketed.paidWithoutTicket,
          ),
        }),
        null,
        { display: "" },
      ),
      line(
        "unticketedDetail",
        fill(t.reportsUnticketedDetail, {
          open: m(s.unticketed.openBalance),
          paid: m(s.unticketed.paidWithoutTicket),
        }),
        null,
        { display: "" },
      ),
    );
  } else
    tax.push(
      line("taxUnavailable", t.reportsTaxUnavailable, null, { display: "" }),
    );

  const c = summary.collections;
  const methods: SummaryLine[] = c.byMethod.flatMap((row) => {
    const name = tenderMethodLabel(row.method, undefined, locale);
    const id = `method.${row.method}`;
    return [
      line(`${id}.count`, `${name} · ${t.reportsColCount}`, null, {
        quantity: row.count,
        display: String(row.count),
      }),
      line(`${id}.amount`, `${name} · ${t.reportsColAmount}`, row.amount),
      line(`${id}.tips`, `${name} · ${t.reportsColTips}`, row.tips),
      line(`${id}.refunds`, `${name} · ${t.reportsColRefunds}`, -row.refunds),
      line(`${id}.net`, `${name} · ${t.reportsColNet}`, row.net, {
        strong: true,
      }),
    ];
  });
  methods.push(
    line("collected", t.reportsCollected, c.collected, { strong: true }),
    line("paidOuts", t.reportsPaidOuts, -c.paidOuts, {
      quantity: c.paidOutCount,
    }),
  );
  if (c.late.count > 0)
    methods.push(
      line(
        "late",
        fill(t.reportsLateSynced, {
          n: c.late.count,
          amount: m(c.late.amount),
        }),
        c.late.amount,
        { quantity: c.late.count },
      ),
    );

  const margin = summary.margin;
  const cost: SummaryLine[] = [
    line("cogs", t.reportsCogs, s.cogs),
    line(
      "costCoverage",
      fill(t.reportsCostCoverage, { pct: pct(s.costCoverageBps, locale) }),
      null,
      { display: pct(s.costCoverageBps, locale) },
    ),
    line("restockedCost", t.reportsRestockedCost, margin.restockedCost),
    line("margin", t.reportsMargin, margin.estimatedMargin, {
      strong: true,
      ...(margin.estimatedMargin === null
        ? { display: t.reportsNotShown }
        : {}),
    }),
    line("wasteCost", t.reportsWasteCost, s.wasteCost),
  ];

  const d = summary.drawers;
  const drawers: SummaryLine[] = [
    line(
      "drawersCount",
      fill(t.reportsDrawersCount, { open: d.open, closed: d.closed }),
      null,
      { display: "" },
    ),
    line(
      "drawerDifferences",
      fill(t.reportsDrawerDifferences, { amount: m(d.differenceNet) }),
      d.differenceNet,
    ),
    line("unreviewed", fill(t.reportsUnreviewed, { n: d.unreviewed }), null, {
      quantity: d.unreviewed,
      display: String(d.unreviewed),
    }),
  ];
  return [
    { id: "sales", title: t.reportsSalesTitle, lines: sales },
    { id: "tax", title: t.reportsTaxTitle, lines: tax },
    { id: "methods", title: t.reportsCollectionsTitle, lines: methods },
    { id: "cost", title: t.reportsCostTitle, lines: cost },
    { id: "drawers", title: t.reportsDrawersTitle, lines: drawers },
  ];
}
