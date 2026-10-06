import { useState } from "react";
import type { Locale, Session } from "../../../../shared/domain";
import type { DateRange, DrawerRow } from "../../../../shared/reports";
import { strings } from "../../../i18n";
import { Badge, Button } from "../../../components/ui";
import { fetchDrawers } from "../api";
import { drawerColumns, exportCsv } from "../csv";
import { CortePreview, type CorteTarget } from "../CortePreview";
import { DataTable } from "../DataTable";
import { dateLabel, differenceLabel, fill, money, timeLabel } from "../format";
import { ReportStatus, ReportToolbar } from "../parts";
import { RemoteCloseDialog } from "../RemoteCloseDialog";
import { useReport } from "../useReport";

/**
 * Finanzas → Cortes: the drawers of the range plus every drawer still open, with corte X / Z
 * actions, the remote close of an orphaned drawer and, for one day, the corte del día.
 */
export function CortesTab({
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
  const zone = session.restaurant.timezone;
  const report = useReport(() => fetchDrawers(range), [range.from, range.to], {
    online,
    locale,
  });
  const [preview, setPreview] = useState<CorteTarget | null>(null);
  const [closing, setClosing] = useState<DrawerRow | null>(null);
  const rows = report.data ?? [];
  const status = (d: DrawerRow) =>
    d.status === "closed"
      ? t.reportsClosed
      : d.openSinceEarlierDay
        ? fill(t.reportsOpenSince, { date: dateLabel(d.businessDate, locale) })
        : t.reportsOpen;
  const difference = (d: DrawerRow) =>
    d.difference === null
      ? ""
      : `${differenceLabel(d.difference, locale)} ${d.difference === 0 ? "" : m(d.difference)}`.trim();
  return (
    <div className="report-tab" aria-busy={report.loading}>
      <ReportToolbar
        locale={locale}
        online={online}
        busy={report.loading}
        onRefresh={report.reload}
        onCsv={
          report.data
            ? () =>
                exportCsv(
                  "reportsCsvDrawers",
                  range,
                  drawerColumns(locale),
                  rows,
                  {
                    locale,
                    currency: session.restaurant.currency,
                    timezone: zone,
                  },
                )
            : undefined
        }
      >
        {range.from === range.to && (
          <Button
            variant="primary"
            disabled={!online}
            onClick={() => setPreview({ kind: "day", date: range.from })}
          >
            {t.reportsDayCorte}
          </Button>
        )}
      </ReportToolbar>
      <ReportStatus state={report} online={online} locale={locale} />
      <DataTable<DrawerRow>
        caption={t.reportsCortesTitle}
        locale={locale}
        rows={rows}
        rowKey={(d) => d.id}
        empty={report.data ? t.reportsNoDrawers : undefined}
        columns={[
          {
            key: "day",
            header: t.reportsColDate,
            render: (d) => dateLabel(d.businessDate, locale),
          },
          {
            key: "z",
            header: t.reportsColZNumber,
            numeric: true,
            render: (d) => d.zNumber ?? "",
          },
          {
            key: "drawer",
            header: t.reportsColDrawer,
            render: (d) => (
              <>
                {d.deviceName}{" "}
                {!d.deviceActive && (
                  <Badge tone="amber">{t.reportsInactive}</Badge>
                )}
              </>
            ),
          },
          {
            key: "opened",
            header: t.reportsColOpenedBy,
            render: (d) => `${d.openedByName} · ${timeLabel(d.openedAt, zone)}`,
          },
          {
            key: "closed",
            header: t.reportsColClosedBy,
            render: (d) =>
              d.closedAt
                ? `${d.closedByName ?? "—"} · ${timeLabel(d.closedAt, zone)}`
                : "",
          },
          { key: "status", header: t.reportsColStatus, render: status },
          {
            key: "expected",
            header: t.reportsColExpected,
            numeric: true,
            render: (d) =>
              d.expected === null ? t.reportsNotShown : m(d.expected),
          },
          {
            key: "counted",
            header: t.reportsColCounted,
            numeric: true,
            render: (d) => (d.counted === null ? "" : m(d.counted)),
          },
          {
            key: "difference",
            header: t.reportsColDifference,
            numeric: true,
            render: difference,
          },
          {
            key: "terminal",
            header: t.reportsColTerminalNet,
            numeric: true,
            render: (d) => m(d.terminalNet),
          },
          {
            key: "reported",
            header: t.reportsColTerminalReported,
            numeric: true,
            render: (d) =>
              d.terminalReported === null ? "" : m(d.terminalReported),
          },
          {
            key: "review",
            header: t.reportsColReview,
            render: (d) =>
              d.review
                ? fill(t.reportsReviewedBy, { name: d.review.reviewerName })
                : d.needsReview
                  ? t.reportsToReview
                  : "",
          },
          {
            key: "actions",
            header: t.reportsColActions,
            sticky: true,
            render: (d) => (
              <div className="row wrap report-actions">
                {d.status === "open" && d.expected !== null && (
                  <Button
                    disabled={!online}
                    onClick={() =>
                      setPreview({ kind: "drawer", drawerId: d.id })
                    }
                  >
                    {t.reportsCorteX}
                  </Button>
                )}
                {d.status === "closed" && (
                  <Button
                    disabled={!online}
                    onClick={() =>
                      setPreview({ kind: "drawer", drawerId: d.id })
                    }
                  >
                    {d.zPrints > 0
                      ? t.reportsReprintCorteZ
                      : t.reportsPrintCorteZ}
                  </Button>
                )}
                {d.orphan && (
                  <Button
                    variant="danger"
                    disabled={!online}
                    onClick={() => setClosing(d)}
                  >
                    {t.reportsRemoteClose}
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />
      {preview && (
        <CortePreview
          session={session}
          locale={locale}
          target={preview}
          online={online}
          close={() => {
            setPreview(null);
            report.reload();
          }}
        />
      )}
      {closing && (
        <RemoteCloseDialog
          session={session}
          locale={locale}
          drawer={closing}
          close={() => setClosing(null)}
          closed={report.reload}
        />
      )}
    </div>
  );
}
