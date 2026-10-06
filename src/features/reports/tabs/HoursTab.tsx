import type { Locale, Session } from "../../../../shared/domain";
import type {
  ChannelRow,
  DateRange,
  HourRow,
} from "../../../../shared/reports";
import { strings, type Key } from "../../../i18n";
import { channelLabel } from "../../../labels";
import { Button } from "../../../components/ui";
import { fetchBreakdown } from "../api";
import { channelColumns, exportCsv, hourColumns } from "../csv";
import { DataTable } from "../DataTable";
import { hourLabel, money, pct } from "../format";
import { ReportStatus, ReportToolbar } from "../parts";
import { useReport } from "../useReport";

/**
 * A single-series bar: decorative (aria-hidden), one hue, a 4 px rounded end; the value is always
 * printed beside it and the table is the data view, so there is no legend.
 */
function Bar({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? Math.max(0, Math.round((value / max) * 100)) : 0;
  return (
    <span className="report-bar" aria-hidden="true">
      <span style={{ width: width + "%" }} />
    </span>
  );
}

/** Finanzas → Horas y canales: by hour (from the cutoff hour), channel and service type. */
export function HoursTab({
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
  const report = useReport(
    async () => {
      const [hours, channels, modes] = await Promise.all([
        fetchBreakdown(range, "hour"),
        fetchBreakdown(range, "channel"),
        fetchBreakdown(range, "mode"),
      ]);
      return { hours, channels, modes };
    },
    [range.from, range.to],
    { online, locale },
  );
  const data = report.data;
  const ctx = {
    locale,
    currency: session.restaurant.currency,
    timezone: session.restaurant.timezone,
  };
  const max = data
    ? Math.max(0, ...data.hours.rows.map((r) => r.salesTotal))
    : 0;
  const groupTable = (
    rows: ChannelRow[],
    caption: string,
    label: (k: string) => string,
  ) => (
    <DataTable<ChannelRow>
      caption={caption}
      locale={locale}
      rows={rows}
      rowKey={(r) => r.key}
      empty={t.reportsEmpty}
      columns={[
        { key: "key", header: caption, render: (r) => label(r.key) },
        {
          key: "orders",
          header: t.reportsColOrders,
          numeric: true,
          render: (r) => r.orders,
        },
        {
          key: "sales",
          header: t.reportsColSalesTotal,
          numeric: true,
          render: (r) => m(r.salesTotal),
        },
        {
          key: "share",
          header: "%",
          numeric: true,
          render: (r) => pct(r.shareBps, locale),
        },
      ]}
    />
  );
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
                  "reportsCsvHours",
                  range,
                  hourColumns,
                  data.hours.rows,
                  ctx,
                )
            : undefined
        }
      />
      <ReportStatus state={report} online={online} locale={locale} />
      {data && (
        <>
          <section className="panel" aria-labelledby="report-hours">
            <h2 id="report-hours">{t.reportsByHour}</h2>
            <DataTable<HourRow>
              caption={t.reportsByHour}
              locale={locale}
              rows={data.hours.rows}
              rowKey={(r) => String(r.hour)}
              empty={t.reportsEmpty}
              columns={[
                {
                  key: "hour",
                  header: t.reportsColHour,
                  render: (r) => hourLabel(r.hour),
                },
                {
                  key: "orders",
                  header: t.reportsColOrders,
                  numeric: true,
                  render: (r) => r.orders,
                },
                {
                  key: "sales",
                  header: t.reportsColSalesTotal,
                  render: (r) => (
                    <span className="report-bar-cell">
                      <Bar value={r.salesTotal} max={max} />
                      <span className="num">{m(r.salesTotal)}</span>
                    </span>
                  ),
                },
                {
                  key: "ticket",
                  header: t.reportsColAverageTicket,
                  numeric: true,
                  render: (r) => m(r.averageTicket),
                },
              ]}
            />
          </section>
          <section className="panel" aria-labelledby="report-channels">
            <div className="row between wrap">
              <h2 id="report-channels">{t.reportsByChannel}</h2>
              <Button
                onClick={() =>
                  exportCsv(
                    "reportsCsvChannels",
                    range,
                    channelColumns(locale),
                    [
                      ...data.channels.rows.map((r) => ({
                        ...r,
                        group: "channel" as const,
                      })),
                      ...data.modes.rows.map((r) => ({
                        ...r,
                        group: "mode" as const,
                      })),
                    ],
                    ctx,
                  )
                }
              >
                {t.reportsDownloadCsv}
              </Button>
            </div>
            {groupTable(data.channels.rows, t.reportsColChannel, (k) =>
              channelLabel(k, locale),
            )}
          </section>
          <section className="panel" aria-labelledby="report-modes">
            <h2 id="report-modes">{t.reportsByMode}</h2>
            {groupTable(
              data.modes.rows,
              t.reportsColMode,
              (k) => strings[locale][k as Key] ?? k,
            )}
          </section>
        </>
      )}
    </div>
  );
}
