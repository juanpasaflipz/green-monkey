import { useState } from "react";
import type { Locale, Session } from "../../../../shared/domain";
import type {
  BreakdownResponse,
  CategoryRow,
  DateRange,
  ProductRow,
} from "../../../../shared/reports";
import { strings } from "../../../i18n";
import { fetchBreakdown } from "../api";
import { categoryColumns, exportCsv, productColumns } from "../csv";
import { DataTable, type SortState } from "../DataTable";
import { fill, money, pct } from "../format";
import { ReportStatus, ReportToolbar } from "../parts";
import { useReport } from "../useReport";

/** Finanzas → Productos: by product or by category (spec §2.5). */
export function ProductsTab({
  session,
  locale,
  range,
  online,
}: {
  session: Session;
  locale: Locale;
  range: DateRange;
  online: boolean;
}) {
  const t = strings[locale];
  const m = money(session.restaurant.currency, locale);
  const [by, setBy] = useState<"product" | "category">("product");
  const [sort, setSort] = useState<SortState>({ key: "sales", dir: "desc" });
  const report = useReport<BreakdownResponse>(
    () =>
      by === "product"
        ? fetchBreakdown(range, "product")
        : fetchBreakdown(range, "category"),
    [range.from, range.to, by],
    { online, locale },
  );
  const ctx = {
    locale,
    currency: session.restaurant.currency,
    timezone: session.restaurant.timezone,
  };
  const data = report.data && report.data.by === by ? report.data : null;
  const cost = (r: { cost: number | null; margin: number | null }) =>
    r.cost === null ? t.reportsNoCost : m(r.cost);
  const margin = (r: { margin: number | null }) =>
    r.margin === null ? t.reportsNotShown : m(r.margin);
  const categoryName = (r: CategoryRow) =>
    r.name === null
      ? t.reportsNoCategory
      : r.snapshot
        ? r.name[locale]
        : fill(t.reportsCurrentCategory, { name: r.name[locale] });
  return (
    <div className="report-tab" aria-busy={report.loading}>
      <ReportToolbar
        locale={locale}
        online={online}
        busy={report.loading}
        onRefresh={report.reload}
        onCsv={
          data?.by === "product"
            ? () =>
                exportCsv(
                  "reportsCsvProducts",
                  range,
                  productColumns(locale),
                  data.rows,
                  ctx,
                )
            : data?.by === "category"
              ? () =>
                  exportCsv(
                    "reportsCsvCategories",
                    range,
                    categoryColumns(locale),
                    data.rows,
                    ctx,
                  )
              : undefined
        }
      >
        <div className="report-segmented" role="group">
          {(["product", "category"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={by === key}
              className={by === key ? "selected" : ""}
              onClick={() => setBy(key)}
            >
              {key === "product" ? t.reportsByProduct : t.reportsByCategory}
            </button>
          ))}
        </div>
      </ReportToolbar>
      <ReportStatus state={report} online={online} locale={locale} />
      {data?.by === "product" && (
        <DataTable<ProductRow>
          caption={t.reportsByProduct}
          locale={locale}
          rows={data.rows}
          rowKey={(r) => r.productId}
          sort={sort}
          onSort={setSort}
          empty={t.reportsEmpty}
          columns={[
            {
              key: "name",
              header: t.reportsColProduct,
              render: (r) => r.name[locale],
              sortValue: (r) => r.name[locale],
            },
            {
              key: "category",
              header: t.reportsColCategory,
              render: (r) =>
                r.category === null
                  ? t.reportsNoCategory
                  : r.categorySnapshot
                    ? r.category[locale]
                    : fill(t.reportsCurrentCategory, {
                        name: r.category[locale],
                      }),
            },
            {
              key: "units",
              header: t.reportsColUnits,
              numeric: true,
              render: (r) => r.units,
              sortValue: (r) => r.units,
            },
            {
              key: "gross",
              header: t.reportsColGross,
              numeric: true,
              render: (r) => m(r.grossSales),
              sortValue: (r) => r.grossSales,
            },
            {
              key: "discounts",
              header: t.reportsColDiscounts,
              numeric: true,
              render: (r) => m(r.discounts),
              sortValue: (r) => r.discounts,
            },
            {
              key: "sales",
              header: t.reportsColSalesTotal,
              numeric: true,
              render: (r) => m(r.salesTotal),
              sortValue: (r) => r.salesTotal,
            },
            {
              key: "share",
              header: t.reportsColShare,
              numeric: true,
              render: (r) => pct(r.shareBps, locale),
              sortValue: (r) => r.shareBps,
            },
            {
              key: "cost",
              header: t.reportsColCost,
              numeric: true,
              render: cost,
              sortValue: (r) => r.cost ?? -1,
            },
            {
              key: "margin",
              header: t.reportsColMargin,
              numeric: true,
              render: margin,
              sortValue: (r) => r.margin ?? -Infinity,
            },
            {
              key: "refunded",
              header: t.reportsColRefunded,
              numeric: true,
              render: (r) =>
                r.refundedUnits
                  ? `${r.refundedUnits} · ${m(r.refunded)}`
                  : m(r.refunded),
              sortValue: (r) => r.refunded,
            },
          ]}
          totals={[
            t.reportsTotal,
            "",
            String(data.rows.reduce((a, r) => a + r.units, 0)),
            m(data.rows.reduce((a, r) => a + r.grossSales, 0)),
            m(data.rows.reduce((a, r) => a + r.discounts, 0)),
            m(data.total),
            "",
            "",
            "",
            m(data.rows.reduce((a, r) => a + r.refunded, 0)),
          ]}
        />
      )}
      {data?.by === "category" && (
        <DataTable<CategoryRow>
          caption={t.reportsByCategory}
          locale={locale}
          rows={data.rows}
          rowKey={(r) => r.key}
          sort={sort}
          onSort={setSort}
          empty={t.reportsEmpty}
          columns={[
            {
              key: "name",
              header: t.reportsColCategory,
              render: categoryName,
              sortValue: categoryName,
            },
            {
              key: "units",
              header: t.reportsColUnits,
              numeric: true,
              render: (r) => r.units,
              sortValue: (r) => r.units,
            },
            {
              key: "gross",
              header: t.reportsColGross,
              numeric: true,
              render: (r) => m(r.grossSales),
              sortValue: (r) => r.grossSales,
            },
            {
              key: "discounts",
              header: t.reportsColDiscounts,
              numeric: true,
              render: (r) => m(r.discounts),
              sortValue: (r) => r.discounts,
            },
            {
              key: "sales",
              header: t.reportsColSalesTotal,
              numeric: true,
              render: (r) => m(r.salesTotal),
              sortValue: (r) => r.salesTotal,
            },
            {
              key: "share",
              header: t.reportsColShare,
              numeric: true,
              render: (r) => pct(r.shareBps, locale),
              sortValue: (r) => r.shareBps,
            },
            {
              key: "cost",
              header: t.reportsColCost,
              numeric: true,
              render: cost,
              sortValue: (r) => r.cost ?? -1,
            },
            {
              key: "margin",
              header: t.reportsColMargin,
              numeric: true,
              render: margin,
              sortValue: (r) => r.margin ?? -Infinity,
            },
          ]}
          totals={[
            t.reportsTotal,
            String(data.rows.reduce((a, r) => a + r.units, 0)),
            m(data.rows.reduce((a, r) => a + r.grossSales, 0)),
            m(data.rows.reduce((a, r) => a + r.discounts, 0)),
            m(data.total),
            "",
            "",
            "",
          ]}
        />
      )}
      {(data?.by === "product" || data?.by === "category") &&
        data.recovery.count > 0 && (
          <p className="report-line">
            {t.reportsRecoveredSales}: {data.recovery.count} ·{" "}
            {m(data.recovery.total)}
          </p>
        )}
      <p className="muted tiny">{t.reportsProductsNote}</p>
    </div>
  );
}
