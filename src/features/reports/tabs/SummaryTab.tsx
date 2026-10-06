import { useState } from "react";
import type { Locale, Session } from "../../../../shared/domain";
import type { DateRange, SalesSummary } from "../../../../shared/reports";
import { strings } from "../../../i18n";
import { tenderMethodLabel } from "../../../labels";
import { Button } from "../../../components/ui";
import { fetchSummary } from "../api";
import { dayColumns, exportCsv, summaryColumns, summaryCsvRows } from "../csv";
import { CortePreview } from "../CortePreview";
import { DataTable } from "../DataTable";
import { dateLabel, fill, money } from "../format";
import { ChecksBadge, ReportStatus, ReportToolbar, Tiles } from "../parts";
import { printSheet } from "../ReportSheet";
import { summarySections, type SummaryLine } from "../summary-rows";
import { useReport } from "../useReport";

/** A deduction shown with a leading minus; other amounts plain. */
export function lineValue(line: SummaryLine, m: (n: number) => string) {
  if (line.amount === null) return line.display ?? "";
  if (line.display !== undefined && line.id !== "orders") return line.display;
  return line.amount < 0 ? "−" + m(-line.amount) : m(line.amount);
}

function SectionRows({
  lines,
  m,
}: {
  lines: SummaryLine[];
  m: (n: number) => string;
}) {
  return (
    <div className="report-rows">
      {lines.map((line) =>
        line.amount === null && !line.display ? (
          <p className="report-line" key={line.id}>
            {line.label}
          </p>
        ) : (
          <div
            className={
              "doc-row report-row-line" +
              (line.strong ? " strong" : "") +
              (line.indent ? " indent" : "")
            }
            key={line.id}
          >
            <span className="doc-label">{line.label}</span>
            <span className="doc-amount">{lineValue(line, m)}</span>
          </div>
        ),
      )}
    </div>
  );
}

/** Finanzas → Resumen (spec §2.5). */
export function SummaryTab({
  session,
  locale,
  range,
  online,
  navigate,
  setRange,
  openTab,
}: {
  session: Session;
  locale: Locale;
  range: DateRange;
  online: boolean;
  navigate: (view: string) => void;
  setRange: (range: DateRange) => void;
  openTab: (tab: "cortes") => void;
}) {
  const t = strings[locale];
  const m = money(session.restaurant.currency, locale);
  const report = useReport(() => fetchSummary(range), [range.from, range.to], {
    online,
    locale,
  });
  const [dayCorte, setDayCorte] = useState(false);
  const s = report.data;
  const ctx = {
    locale,
    currency: session.restaurant.currency,
    timezone: session.restaurant.timezone,
  };
  return (
    <div className="report-tab" aria-busy={report.loading}>
      <ReportToolbar
        locale={locale}
        online={online}
        busy={report.loading}
        onRefresh={report.reload}
        onCsv={
          s
            ? () =>
                exportCsv(
                  "reportsCsvSummary",
                  range,
                  summaryColumns,
                  summaryCsvRows(s, locale),
                  ctx,
                )
            : undefined
        }
        onPrint={
          s
            ? () =>
                void printSheet(
                  t.reportsTabSummary,
                  `${session.restaurant.name} · ${dateLabel(range.from, locale)} – ${dateLabel(range.to, locale)}`,
                  <SummarySheet summary={s} locale={locale} />,
                  t.reportsDocNotFiscal,
                )
            : undefined
        }
      >
        {range.from === range.to && (
          <Button
            variant="primary"
            disabled={!online}
            onClick={() => setDayCorte(true)}
          >
            {t.reportsDayCorte}
          </Button>
        )}
      </ReportToolbar>
      <ReportStatus state={report} online={online} locale={locale} />
      {s && (
        <SummaryView
          summary={s}
          locale={locale}
          m={m}
          setRange={setRange}
          openTicketRegister={() => navigate("settings")}
          openCortes={() => openTab("cortes")}
          downloadDays={() =>
            exportCsv("reportsCsvDays", range, dayColumns, s.days, ctx)
          }
        />
      )}
      {dayCorte && (
        <CortePreview
          session={session}
          locale={locale}
          target={{ kind: "day", date: range.from }}
          close={() => setDayCorte(false)}
          online={online}
        />
      )}
    </div>
  );
}

function SummaryView({
  summary: s,
  locale,
  m,
  setRange,
  openTicketRegister,
  openCortes,
  downloadDays,
}: {
  summary: SalesSummary;
  locale: Locale;
  m: (n: number) => string;
  setRange: (range: DateRange) => void;
  openTicketRegister: () => void;
  openCortes: () => void;
  downloadDays: () => void;
}) {
  const t = strings[locale];
  const sections = summarySections(s, locale);
  const section = (id: string) => sections.find((x) => x.id === id)!;
  const c = s.collections;
  return (
    <>
      <Tiles
        items={[
          { label: t.reportsSalesTotal, value: m(s.sales.salesTotal) },
          { label: t.reportsOrders, value: String(s.sales.orders) },
          { label: t.reportsAverageTicket, value: m(s.sales.averageTicket) },
          { label: t.reportsCollected, value: m(c.collected) },
          { label: t.reportsTips, value: m(c.tips), note: t.reportsTipsHint },
          { label: t.reportsOutstanding, value: m(s.sales.outstanding) },
        ]}
      />
      <ChecksBadge checks={s.checks} requestId={s.requestId} locale={locale} />
      <div className="report-cards">
        <section className="panel report-card" aria-labelledby="report-sales">
          <h2 id="report-sales">{t.reportsSalesTitle}</h2>
          <SectionRows lines={section("sales").lines} m={m} />
        </section>
        <section className="panel report-card" aria-labelledby="report-tax">
          <h2 id="report-tax">{t.reportsTaxTitle}</h2>
          <SectionRows lines={section("tax").lines} m={m} />
          {s.tax && (
            <Button variant="ghost" onClick={openTicketRegister}>
              {t.reportsOpenTicketRegister}
            </Button>
          )}
        </section>
        <section
          className="panel report-card wide"
          aria-labelledby="report-methods"
        >
          <h2 id="report-methods">{t.reportsCollectionsTitle}</h2>
          <DataTable
            caption={t.reportsCollectionsTitle}
            locale={locale}
            rows={c.byMethod}
            rowKey={(r) => r.method}
            columns={[
              {
                key: "method",
                header: t.reportsColMethod,
                render: (r) => tenderMethodLabel(r.method, undefined, locale),
              },
              {
                key: "count",
                header: t.reportsColCount,
                numeric: true,
                render: (r) => r.count,
              },
              {
                key: "amount",
                header: t.reportsColAmount,
                numeric: true,
                render: (r) => m(r.amount),
              },
              {
                key: "tips",
                header: t.reportsColTips,
                numeric: true,
                render: (r) => m(r.tips),
              },
              {
                key: "refunds",
                header: t.reportsColRefunds,
                numeric: true,
                render: (r) => m(r.refunds),
              },
              {
                key: "net",
                header: t.reportsColNet,
                numeric: true,
                render: (r) => m(r.net),
              },
            ]}
            totals={[
              t.reportsTotal,
              String(c.byMethod.reduce((a, r) => a + r.count, 0)),
              m(c.collected),
              m(c.tips),
              m(c.refunds),
              m(c.byMethod.reduce((a, r) => a + r.net, 0)),
            ]}
          />
          <p className="report-line">
            {t.reportsPaidOuts} {c.paidOuts ? "−" + m(c.paidOuts) : m(0)} (
            {c.paidOutCount})
          </p>
          <p className="muted tiny">{t.reportsCollectionsHint}</p>
          {c.late.count > 0 && (
            <p className="muted">
              {fill(t.reportsLateSynced, {
                n: c.late.count,
                amount: m(c.late.amount),
              })}
            </p>
          )}
        </section>
        <section className="panel report-card" aria-labelledby="report-cost">
          <h2 id="report-cost">{t.reportsCostTitle}</h2>
          <SectionRows lines={section("cost").lines} m={m} />
          <p className="muted tiny">{t.reportsMarginHint}</p>
          {s.sales.costCoverageBps < 10_000 && (
            <p className="warning-panel">{t.reportsCostIncomplete}</p>
          )}
        </section>
        <section className="panel report-card" aria-labelledby="report-drawers">
          <h2 id="report-drawers">{t.reportsDrawersTitle}</h2>
          <SectionRows lines={section("drawers").lines} m={m} />
          {s.drawers.unreviewed > 0 && (
            <Button variant="ghost" onClick={openCortes}>
              {t.reportsTabCortes}
            </Button>
          )}
        </section>
      </div>
      {s.days.length > 0 && (
        <section className="panel" aria-labelledby="report-days">
          <div className="row between wrap">
            <h2 id="report-days">{t.reportsByDay}</h2>
            <Button onClick={downloadDays}>{t.reportsDownloadCsv}</Button>
          </div>
          <DataTable
            caption={t.reportsByDay}
            locale={locale}
            rows={s.days}
            rowKey={(r) => r.date}
            columns={[
              {
                key: "date",
                header: t.reportsColDate,
                render: (r) => (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setRange({ from: r.date, to: r.date })}
                  >
                    {dateLabel(r.date, locale)}
                  </button>
                ),
              },
              {
                key: "orders",
                header: t.reportsColOrders,
                numeric: true,
                render: (r) => r.orders,
              },
              {
                key: "gross",
                header: t.reportsColGross,
                numeric: true,
                render: (r) => m(r.grossSales),
              },
              {
                key: "discounts",
                header: t.reportsColDiscounts,
                numeric: true,
                render: (r) => m(r.discounts),
              },
              {
                key: "sales",
                header: t.reportsColSalesTotal,
                numeric: true,
                render: (r) => m(r.salesTotal),
              },
              {
                key: "refunds",
                header: t.reportsColRefunds,
                numeric: true,
                render: (r) => m(r.refunds),
              },
              {
                key: "cash",
                header: t.reportsColCash,
                numeric: true,
                render: (r) => m(r.cash),
              },
              {
                key: "terminal",
                header: t.reportsColTerminal,
                numeric: true,
                render: (r) => m(r.external),
              },
              {
                key: "tips",
                header: t.reportsColTips,
                numeric: true,
                render: (r) => m(r.tips),
              },
              {
                key: "paidOuts",
                header: t.reportsColPaidOuts,
                numeric: true,
                render: (r) => m(r.paidOuts),
              },
            ]}
            totals={[
              t.reportsTotal,
              String(s.sales.orders),
              m(s.sales.grossSales),
              m(s.sales.discounts),
              m(s.sales.salesTotal),
              m(s.refunds.total),
              m(s.days.reduce((a, r) => a + r.cash, 0)),
              m(s.days.reduce((a, r) => a + r.external, 0)),
              m(c.tips),
              m(c.paidOuts),
            ]}
          />
        </section>
      )}
    </>
  );
}

/** The Resumen on a letter/A4 sheet: every section as a two-column table. */
function SummarySheet({
  summary,
  locale,
}: {
  summary: SalesSummary;
  locale: Locale;
}) {
  const m = money(summary.currency, locale);
  const t = strings[locale];
  const failed = summary.checks.filter((c) => !c.ok).map((c) => c.code);
  return (
    <>
      {/* The Comprobaciones result, as on screen (UI-13). */}
      <p>
        {failed.length === 0
          ? t.reportsChecksOk
          : fill(t.reportsChecksFailed, {
              codes: failed.join(", "),
              id: summary.requestId,
            })}
      </p>
      {summarySections(summary, locale).map((section) => (
        <table key={section.id}>
          <caption>{section.title}</caption>
          <tbody>
            {section.lines.map((line) => (
              <tr key={line.id}>
                <td>{line.label}</td>
                <td className="num">{lineValue(line, m)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </>
  );
}
