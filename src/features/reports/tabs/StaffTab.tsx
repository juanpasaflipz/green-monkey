import { useState } from "react";
import type { Locale, Session } from "../../../../shared/domain";
import type { DateRange, EmployeeRow } from "../../../../shared/reports";
import { strings, type Key } from "../../../i18n";
import { Badge } from "../../../components/ui";
import { fetchBreakdown } from "../api";
import { exportCsv, staffColumns } from "../csv";
import { DataTable, type SortState } from "../DataTable";
import { money } from "../format";
import { ReportStatus, ReportToolbar } from "../parts";
import { useReport } from "../useReport";

/** Finanzas → Personal: sales and tips per server (spec §2.5; QR / Kiosco, LD-15 Q4). */
export function StaffTab({
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
  const [sort, setSort] = useState<SortState>({ key: "sales", dir: "desc" });
  const report = useReport(
    () => fetchBreakdown(range, "employee"),
    [range.from, range.to],
    { online, locale },
  );
  const data = report.data;
  const name = (r: EmployeeRow) =>
    r.employeeId === null ? t.reportsQrKiosk : r.name;
  return (
    <div className="report-tab" aria-busy={report.loading}>
      <ReportToolbar
        locale={locale}
        online={online}
        busy={report.loading}
        onRefresh={report.reload}
        onCsv={
          data
            ? () =>
                exportCsv(
                  "reportsCsvStaff",
                  range,
                  staffColumns(locale),
                  data.rows,
                  {
                    locale,
                    currency: session.restaurant.currency,
                    timezone: session.restaurant.timezone,
                  },
                )
            : undefined
        }
      />
      <ReportStatus state={report} online={online} locale={locale} />
      <p className="muted tiny">{t.reportsStaffHint}</p>
      {data && (
        <DataTable<EmployeeRow>
          caption={t.reportsTabStaff}
          locale={locale}
          rows={data.rows}
          rowKey={(r) => r.employeeId ?? "qr-kiosk"}
          sort={sort}
          onSort={setSort}
          empty={t.reportsEmpty}
          columns={[
            {
              key: "name",
              header: t.reportsColWaiter,
              render: (r) => (
                <>
                  {name(r)} {!r.active && <Badge>{t.reportsInactive}</Badge>}
                </>
              ),
              sortValue: name,
            },
            {
              key: "role",
              header: t.reportsColRole,
              render: (r) =>
                r.employeeId === null
                  ? ""
                  : (strings[locale][r.role as Key] ?? ""),
            },
            {
              key: "orders",
              header: t.reportsColOrders,
              numeric: true,
              render: (r) => r.orders,
              sortValue: (r) => r.orders,
            },
            {
              key: "sales",
              header: t.reportsColSalesTotal,
              numeric: true,
              render: (r) => m(r.salesTotal),
              sortValue: (r) => r.salesTotal,
            },
            {
              key: "ticket",
              header: t.reportsColAverageTicket,
              numeric: true,
              render: (r) => m(r.averageTicket),
              sortValue: (r) => r.averageTicket,
            },
            {
              key: "tips",
              header: t.reportsColTips,
              numeric: true,
              render: (r) => m(r.tips),
              sortValue: (r) => r.tips,
            },
            {
              key: "discounts",
              header: t.reportsColDiscounts,
              numeric: true,
              render: (r) => m(r.discounts),
              sortValue: (r) => r.discounts,
            },
          ]}
          totals={[
            t.reportsTotal,
            "",
            String(data.rows.reduce((a, r) => a + r.orders, 0)),
            m(data.total),
            "",
            m(data.rows.reduce((a, r) => a + r.tips, 0)),
            m(data.rows.reduce((a, r) => a + r.discounts, 0)),
          ]}
        />
      )}
    </div>
  );
}
