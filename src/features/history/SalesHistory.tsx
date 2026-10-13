/**
 * Finanzas › Histórico POS Lite (040, docs/SALES_HISTORY.md): Juanberto's past pos-lite kiosk and
 * POS-terminal sales as report history only, with its own business-date range (pos-lite history is
 * older than Finanzas' 92-day picker allows), totals by month and day, by channel and payment
 * method, the top products and CSV exports. Owners and managers also import an export file here:
 * the server previews it (source restaurant to confirm, coverage, counts and totals, rejected rows,
 * the pesos → centavos reconciliation) and Importar commits it (step-up). A note on every view says
 * these figures are not Green Monkey's sales, IVA or cortes.
 */
import { useEffect, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { addDays, currentBusinessDate, rangeLength, type DateRange } from "../../../shared/reports";
import {
  channelTotals,
  methodTotals,
  monthTotals,
  SALES_HISTORY_CHANNELS,
  SALES_HISTORY_MAX_DAYS,
  SALES_HISTORY_METHODS,
  type DayAggregate,
  type HistoryChannel,
  type HistoryMethod,
  type PaymentAggregate,
  type RejectReason,
  type SalesHistoryImportResult,
  type SalesHistoryPreview,
  type SalesHistoryReport,
} from "../../../shared/sales-history";
import type { CsvColumn } from "../../../shared/csv";
import { api } from "../../api";
import { errorNotice, strings, type Key } from "../../i18n";
import { Button, Field } from "../../components/ui";
import { moneyFormatter } from "../menu/format";
import { fill } from "../reports/format";
import { DataTable, type Column } from "../reports/DataTable";
import { exportCsv } from "../reports/csv";
import "./history.css";

export const CHANNEL_KEY: Record<HistoryChannel, Key> = {
  kiosk: "historyChannelKiosk",
  pos: "historyChannelPos",
};
export const METHOD_KEY: Record<HistoryMethod, Key> = {
  cash: "historyMethodCash",
  card: "historyMethodCard",
  transfer: "historyMethodTransfer",
  other: "historyMethodOther",
};
export const REASON_KEY: Record<RejectReason, Key> = {
  channel: "historyReasonChannel",
  instant: "historyReasonInstant",
  money: "historyReasonMoney",
  totals: "historyReasonTotals",
  payments: "historyReasonPayments",
  refund: "historyReasonRefund",
  duplicate: "historyReasonDuplicate",
};
export const FILE_HASH_HEADER = "x-gm-file-hash";

/** CSV columns of the three datasets (money in minor units, headers in both languages). */
const h = (key: Key) => ({ es: strings.es[key], en: strings.en[key] });
export function dayCsvColumns(locale: Locale): CsvColumn<DayAggregate>[] {
  const t = strings[locale];
  return [
    { header: h("historyDate"), type: "d", value: (r) => r.date },
    { header: h("historyChannel"), type: "t", value: (r) => t[CHANNEL_KEY[r.channel]] },
    { header: h("historyOrders"), type: "i", value: (r) => r.orders },
    { header: h("historyGross"), type: "m", value: (r) => r.gross },
    { header: h("historyDiscounts"), type: "m", value: (r) => r.discount },
    { header: h("historySubtotal"), type: "m", value: (r) => r.subtotal },
    { header: h("historyTax"), type: "m", value: (r) => r.tax },
    { header: h("historyTotal"), type: "m", value: (r) => r.total },
    { header: h("historyTips"), type: "m", value: (r) => r.tip },
    { header: h("historyRefunds"), type: "m", value: (r) => r.refunds },
  ];
}
export function paymentCsvColumns(locale: Locale): CsvColumn<PaymentAggregate>[] {
  const t = strings[locale];
  return [
    { header: h("historyDate"), type: "d", value: (r) => r.date },
    { header: h("historyChannel"), type: "t", value: (r) => t[CHANNEL_KEY[r.channel]] },
    { header: h("historyMethod"), type: "t", value: (r) => t[METHOD_KEY[r.method]] },
    { header: h("historyPayments"), type: "i", value: (r) => r.payments },
    { header: h("historyAmount"), type: "m", value: (r) => r.amount },
    { header: h("historyTips"), type: "m", value: (r) => r.tip },
  ];
}
type ProductRow = SalesHistoryReport["products"][number];
export const productCsvColumns: CsvColumn<ProductRow>[] = [
  { header: h("historyProduct"), type: "t", value: (r) => r.name },
  { header: h("historyQuantity"), type: "i", value: (r) => r.quantity },
  { header: h("historyAmount"), type: "m", value: (r) => r.amount },
];

export function SalesHistory({
  session,
  locale,
  online = true,
}: {
  session: Session;
  locale: Locale;
  online?: boolean;
}) {
  const t = (k: Key) => strings[locale][k];
  const currency = session.restaurant.currency;
  const money = moneyFormatter(locale, currency);
  const today = currentBusinessDate(session.restaurant);
  const [range, setRange] = useState<DateRange>({ from: addDays(today, -364), to: today });
  const [report, setReport] = useState<SalesHistoryReport | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const valid =
    !!range.from &&
    !!range.to &&
    range.from <= range.to &&
    rangeLength(range) <= SALES_HISTORY_MAX_DAYS;
  const manager = session.role === "owner" || session.role === "manager";
  useEffect(() => {
    if (!online || !valid) return;
    let live = true;
    setError("");
    api<SalesHistoryReport>(`/sales-history?from=${range.from}&to=${range.to}`)
      .then((r) => live && setReport(r))
      .catch((e) => live && setError(errorNotice(e, locale)));
    return () => {
      live = false;
    };
  }, [range.from, range.to, online, valid, reload]);
  const ctx = { locale, currency, timezone: session.restaurant.timezone };
  const byChannel = report ? channelTotals(report.days) : null;
  const byMethod = report ? methodTotals(report.payments) : null;
  const months = report ? monthTotals(report.days) : [];
  const total = report?.days.reduce(
    (a, d) => ({
      orders: a.orders + d.orders,
      total: a.total + d.total,
      tax: a.tax + d.tax,
      tip: a.tip + d.tip,
    }),
    { orders: 0, total: 0, tax: 0, tip: 0 },
  );
  // One row per business date: both channels side by side.
  const dates = report
    ? [...new Set(report.days.map((d) => d.date))].map((date) => {
        const of = (c: HistoryChannel) => report.days.find((d) => d.date === date && d.channel === c);
        const rows = report.days.filter((d) => d.date === date);
        return {
          date,
          kiosk: of("kiosk")?.total ?? 0,
          pos: of("pos")?.total ?? 0,
          orders: rows.reduce((a, d) => a + d.orders, 0),
          total: rows.reduce((a, d) => a + d.total, 0),
          tip: rows.reduce((a, d) => a + d.tip, 0),
        };
      })
    : [];
  type DateRow = (typeof dates)[number];
  const dayColumns: Column<DateRow>[] = [
    { key: "date", header: t("historyDate"), render: (r) => r.date, sortValue: (r) => r.date },
    { key: "kiosk", header: t("historyChannelKiosk"), numeric: true, render: (r) => money(r.kiosk) },
    { key: "pos", header: t("historyChannelPos"), numeric: true, render: (r) => money(r.pos) },
    { key: "orders", header: t("historyOrders"), numeric: true, render: (r) => r.orders },
    { key: "total", header: t("historyTotal"), numeric: true, render: (r) => money(r.total), sortValue: (r) => r.total },
    { key: "tip", header: t("historyTips"), numeric: true, render: (r) => money(r.tip) },
  ];
  type MonthRow = (typeof months)[number];
  const monthColumns: Column<MonthRow>[] = [
    { key: "month", header: t("historyMonth"), render: (r) => r.month },
    { key: "orders", header: t("historyOrders"), numeric: true, render: (r) => r.orders },
    { key: "total", header: t("historyTotal"), numeric: true, render: (r) => money(r.total) },
    { key: "tax", header: t("historyTax"), numeric: true, render: (r) => money(r.tax) },
    { key: "tip", header: t("historyTips"), numeric: true, render: (r) => money(r.tip) },
  ];
  const productColumns: Column<ProductRow>[] = [
    { key: "name", header: t("historyProduct"), render: (r) => r.name, wrap: true },
    { key: "quantity", header: t("historyQuantity"), numeric: true, render: (r) => r.quantity },
    { key: "amount", header: t("historyAmount"), numeric: true, render: (r) => money(r.amount) },
  ];
  return (
    <section className="sales-history" aria-labelledby="sales-history-title">
      <h2 id="sales-history-title">{t("historyTitle")}</h2>
      <p className="warning-panel" role="note">
        {t("historyNote")}
      </p>
      <div className="row wrap history-range">
        <Field label={t("historyFrom")}>
          <input
            type="date"
            value={range.from}
            max={today}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          />
        </Field>
        <Field label={t("historyTo")}>
          <input
            type="date"
            value={range.to}
            max={today}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          />
        </Field>
      </div>
      {!valid && (
        <p role="alert" className="error">
          {fill(t("historyRangeInvalid"), { days: SALES_HISTORY_MAX_DAYS })}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!report && !error && online && valid && <p role="status">{t("loading")}</p>}
      {report && total && byChannel && byMethod && (
        <>
          {report.days.length === 0 ? (
            <p className="muted">{t("historyEmpty")}</p>
          ) : (
            <>
              <div className="history-tiles">
                {(
                  [
                    [t("historyOrders"), String(total.orders)],
                    [t("historyTotal"), money(total.total)],
                    [t("historyTax"), money(total.tax)],
                    [t("historyTips"), money(total.tip)],
                  ] as const
                ).map(([label, value]) => (
                  <div className="history-tile" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              <div className="history-split">
                <div>
                  <h3>{t("historyByChannel")}</h3>
                  <ul className="history-list">
                    {SALES_HISTORY_CHANNELS.map((c) => (
                      <li key={c}>
                        <span>{t(CHANNEL_KEY[c])}</span>
                        <span>
                          {byChannel[c].orders} · {money(byChannel[c].total)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3>{t("historyByMethod")}</h3>
                  <ul className="history-list">
                    {SALES_HISTORY_METHODS.filter((m) => byMethod[m].payments > 0).map((m) => (
                      <li key={m}>
                        <span>{t(METHOD_KEY[m])}</span>
                        <span>
                          {byMethod[m].payments} · {money(byMethod[m].amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <div className="row wrap report-actions">
                <Button onClick={() => exportCsv("historyCsvDaysName", report.range, dayCsvColumns(locale), report.days, ctx)}>
                  {t("historyCsvDays")}
                </Button>
                <Button
                  onClick={() =>
                    exportCsv("historyCsvPaymentsName", report.range, paymentCsvColumns(locale), report.payments, ctx)
                  }
                >
                  {t("historyCsvPayments")}
                </Button>
                <Button
                  onClick={() => exportCsv("historyCsvProductsName", report.range, productCsvColumns, report.products, ctx)}
                >
                  {t("historyCsvProducts")}
                </Button>
              </div>
              <h3>{t("historyByMonth")}</h3>
              <DataTable
                caption={t("historyByMonth")}
                columns={monthColumns}
                rows={months}
                rowKey={(r) => r.month}
                locale={locale}
              />
              <h3>{t("historyByDay")}</h3>
              <DataTable
                caption={t("historyByDay")}
                columns={dayColumns}
                rows={dates}
                rowKey={(r) => r.date}
                locale={locale}
              />
              <h3>{t("historyProducts")}</h3>
              <DataTable
                caption={t("historyProducts")}
                columns={productColumns}
                rows={report.products}
                rowKey={(r) => r.name}
                locale={locale}
              />
            </>
          )}
          {report.batches.length > 0 && (
            <details className="history-batches">
              <summary>{t("historyBatches")}</summary>
              <ul>
                {report.batches.map((b) => (
                  <li key={b.id}>
                    {fill(t("historyBatchLine"), {
                      name: b.sourceName ?? t("historyImportSourceUnknown"),
                      from: b.coverageFrom,
                      to: b.coverageTo,
                      orders: b.orders,
                      exported: b.exportedAt.slice(0, 10),
                      imported: b.importedAt.slice(0, 10),
                    })}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {manager && (
        <HistoryImport
          locale={locale}
          online={online}
          money={money}
          onImported={(r) => {
            setReload((n) => n + 1);
            if (r.days > 0 && report) setRange(report.range);
          }}
        />
      )}
    </section>
  );
}

/** The owner's import: upload → server preview → confirm the restaurant → Importar. */
function HistoryImport({
  locale,
  online,
  money,
  onImported,
}: {
  locale: Locale;
  online: boolean;
  money: (minor: number) => string;
  onImported: (r: SalesHistoryImportResult) => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const [file, setFile] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<SalesHistoryPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  async function read(f: File) {
    setError("");
    setDone("");
    setPreview(null);
    setConfirmed(false);
    setFile(f);
    setBusy(true);
    try {
      setPreview(
        await api<SalesHistoryPreview>(
          "/sales-history/preview",
          {},
          { raw: { body: f, type: "application/octet-stream" }, timeoutMs: 60_000 },
        ),
      );
    } catch (e) {
      setFile(null);
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!file || !preview) return;
    setError("");
    setBusy(true);
    try {
      const r = await api<SalesHistoryImportResult>(
        "/sales-history/import",
        {},
        {
          raw: { body: file, type: "application/octet-stream" },
          headers: { [FILE_HASH_HEADER]: preview.fileHash },
          timeoutMs: 60_000,
        },
      );
      setDone(
        r.replayed
          ? t("historyImportReplayed")
          : fill(t("historyImportDone"), { orders: r.orders, days: r.days }),
      );
      setPreview(null);
      setFile(null);
      onImported(r);
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }
  const p = preview;
  const rec = p?.reconciliation;
  const channelLine = (c: HistoryChannel) =>
    p ? `${t(CHANNEL_KEY[c])}: ${p.byChannel[c].orders} · ${money(p.byChannel[c].total)}` : "";
  return (
    <details className="history-import">
      <summary>{t("historyImportTitle")}</summary>
      <p className="muted">{t("historyImportHelp")}</p>
      <Field label={t("historyImportFile")}>
        <input
          type="file"
          accept="application/json,.json"
          disabled={!online || busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void read(f);
          }}
        />
      </Field>
      {busy && !p && <p role="status">{t("historyImportReading")}</p>}
      {p && rec && (
        <div className="history-preview">
          <p>
            <strong>
              {fill(t("historyImportSource"), {
                name: p.sourceName ?? t("historyImportSourceUnknown"),
              })}
            </strong>
          </p>
          <label className="check">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            {t("historyImportConfirmSource")}
          </label>
          {p.coverage && <p>{fill(t("historyImportCoverage"), p.coverage)}</p>}
          <p role="status">
            {fill(t("historyImportCounts"), {
              orders: p.orders,
              total: money(rec.converted.total),
              tips: money(rec.converted.tip),
            })}
          </p>
          <ul className="history-list">
            {SALES_HISTORY_CHANNELS.map((c) => (
              <li key={c}>{channelLine(c)}</li>
            ))}
            {SALES_HISTORY_METHODS.filter((m) => p.byMethod[m].payments > 0).map((m) => (
              <li key={m}>
                {t(METHOD_KEY[m])}: {p.byMethod[m].payments} · {money(p.byMethod[m].amount)}
              </li>
            ))}
          </ul>
          {rec.matches ? (
            <p className="success">{fill(t("historyImportReconciled"), { total: money(rec.converted.total) })}</p>
          ) : (
            <p role="alert" className="error">
              {fill(t("historyImportNotReconciled"), {
                source: rec.source.total,
                converted: money(rec.converted.total),
              })}
            </p>
          )}
          {rec.rounded > 0 && <p className="muted">{fill(t("historyImportRounded"), { n: rec.rounded })}</p>}
          {!rec.summaryOk && (
            <p role="alert" className="error">
              {t("historyImportSummaryBad")}
            </p>
          )}
          {rec.linesMismatch > 0 && (
            <p className="muted">{fill(t("historyImportLinesMismatch"), { n: rec.linesMismatch })}</p>
          )}
          {p.rejected.length > 0 && (
            <details>
              <summary>{fill(t("historyImportRejected"), { n: p.rejected.length })}</summary>
              <ul>
                {p.rejected.map((r, i) => (
                  <li key={r.legacyId + ":" + i}>
                    {r.legacyId} · {t(REASON_KEY[r.reason])}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {p.alreadyImported && <p className="muted">{t("historyImportAlready")}</p>}
          {p.replacesDays > 0 && (
            <p className="warning-panel" role="note">
              {fill(t("historyImportReplaces"), { n: p.replacesDays })}
            </p>
          )}
          {p.olderThanImported && (
            <p role="alert" className="error">
              {t("historyImportOlder")}
            </p>
          )}
          <Button
            variant="primary"
            disabled={
              !online ||
              busy ||
              !confirmed ||
              !p.orders ||
              p.olderThanImported ||
              !rec.summaryOk ||
              !rec.matches
            }
            onClick={() => void commit()}
          >
            {t("historyImportCommit")}
          </Button>
        </div>
      )}
      {done && (
        <p role="status" className="success">
          {done}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </details>
  );
}
