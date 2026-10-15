/**
 * Finanzas › Histórico de plataformas (041, docs/DELIVERY_HISTORY.md): the restaurant's Uber Eats,
 * Rappi and DiDi Food sales as report history only, with its own calendar-date range (the
 * platforms' history is older than Finanzas' 92-day picker allows), tiles (orders, gross sales,
 * commissions, net), totals by platform and store, by month and day, and a CSV export of the days.
 * Days with orders whose payout the platform has not settled yet say «pago pendiente». Owners and
 * managers also import a gm-delivery-sales file here: the server previews it (source restaurant to
 * confirm, coverage per platform, counts and totals, rejected rows, the pesos → centavos
 * reconciliation) and Importar commits it (step-up). A note on every view says these figures are
 * not Green Monkey's sales, IVA or cortes. Same shape as 040's SalesHistory.tsx.
 */
import { useEffect, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { addDays, currentBusinessDate, rangeLength, type DateRange } from "../../../shared/reports";
import {
  DELIVERY_HISTORY_MAX_DAYS,
  DELIVERY_PLATFORMS,
  deliveryMonthTotals,
  deliveryTotals,
  storeTotals,
  type DeliveryCoverage,
  type DeliveryDay,
  type DeliveryHistoryImportResult,
  type DeliveryHistoryPreview,
  type DeliveryHistoryReport,
  type DeliveryPlatform,
  type DeliveryRejectReason,
  type DeliveryTotals,
} from "../../../shared/delivery-history";
import type { CsvColumn } from "../../../shared/csv";
import { api } from "../../api";
import { errorNotice, strings, type Key } from "../../i18n";
import { Button, Field } from "../../components/ui";
import { moneyFormatter } from "../menu/format";
import { fill } from "../reports/format";
import { DataTable, type Column } from "../reports/DataTable";
import { exportCsv } from "../reports/csv";
import { FILE_HASH_HEADER } from "./SalesHistory";
import "./history.css";

export const PLATFORM_KEY: Record<DeliveryPlatform, Key> = {
  uber_eats: "deliveryPlatformUberEats",
  rappi: "deliveryPlatformRappi",
  didi_food: "deliveryPlatformDidiFood",
};
export const DELIVERY_REASON_KEY: Record<DeliveryRejectReason, Key> = {
  platform: "deliveryReasonPlatform",
  date: "deliveryReasonDate",
  store: "deliveryReasonStore",
  money: "deliveryReasonMoney",
  orders: "deliveryReasonOrders",
  commission: "deliveryReasonCommission",
  net: "deliveryReasonNet",
  duplicate: "deliveryReasonDuplicate",
};

/** CSV columns of the days (money in minor units, an unknown amount empty, headers in both languages). */
const h = (key: Key) => ({ es: strings.es[key], en: strings.en[key] });
export function deliveryDayCsvColumns(locale: Locale): CsvColumn<DeliveryDay>[] {
  const t = strings[locale];
  return [
    { header: h("deliveryDate"), type: "d", value: (r) => r.date },
    { header: h("deliveryPlatform"), type: "t", value: (r) => t[PLATFORM_KEY[r.platform]] },
    { header: h("deliveryStore"), type: "t", value: (r) => r.store },
    { header: h("deliveryOrders"), type: "i", value: (r) => r.orders },
    { header: h("deliveryGross"), type: "m", value: (r) => r.gross },
    { header: h("deliveryCommission"), type: "m", value: (r) => r.commission },
    { header: h("deliveryNet"), type: "m", value: (r) => r.net },
    { header: h("deliveryUnsettled"), type: "i", value: (r) => r.unsettledOrders },
    { header: h("deliveryCancelled"), type: "i", value: (r) => r.cancelled },
    { header: h("deliveryChargebacks"), type: "m", value: (r) => r.chargebacks },
  ];
}

/** "Uber Eats: 2026-01-01 a 2026-03-31; Rappi: …" in the platforms' order. */
function coverageText(coverage: DeliveryCoverage, locale: Locale) {
  const t = strings[locale];
  return DELIVERY_PLATFORMS.filter((p) => coverage[p])
    .map((p) => fill(t.deliveryImportCoverage, { platform: t[PLATFORM_KEY[p]], ...coverage[p]! }))
    .join("; ");
}

export function DeliveryHistory({
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
  const [report, setReport] = useState<DeliveryHistoryReport | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const valid =
    !!range.from &&
    !!range.to &&
    range.from <= range.to &&
    rangeLength(range) <= DELIVERY_HISTORY_MAX_DAYS;
  const manager = session.role === "owner" || session.role === "manager";
  useEffect(() => {
    if (!online || !valid) return;
    let live = true;
    setError("");
    api<DeliveryHistoryReport>(`/delivery-history?from=${range.from}&to=${range.to}`)
      .then((r) => live && setReport(r))
      .catch((e) => live && setError(errorNotice(e, locale)));
    return () => {
      live = false;
    };
  }, [range.from, range.to, online, valid, reload]);
  const ctx = { locale, currency, timezone: session.restaurant.timezone };
  /** A sum that leaves out rows without the figure: "sin dato" when none had it. */
  const known = (sum: number, unknown: number, rows: number) =>
    unknown === rows && rows > 0 ? t("deliveryUnknown") : money(sum);
  const total = report ? deliveryTotals(report.days) : null;
  const stores = report ? storeTotals(report.days) : [];
  const months = report ? deliveryMonthTotals(report.days) : [];
  // One row per date: every platform's gross side by side.
  const dates = report
    ? [...new Set(report.days.map((d) => d.date))].map((date) => {
        const rows = report.days.filter((d) => d.date === date);
        const byPlatform = Object.fromEntries(
          DELIVERY_PLATFORMS.map((p) => [p, rows.filter((d) => d.platform === p).reduce((a, d) => a + d.gross, 0)]),
        ) as Record<DeliveryPlatform, number>;
        return { date, byPlatform, totals: deliveryTotals(rows) };
      })
    : [];
  type DateRow = (typeof dates)[number];
  const pending = (n: number) =>
    n > 0 ? (
      <span className="history-pending">
        {" "}
        · {t("deliveryPending")} ({n})
      </span>
    ) : null;
  const dayColumns: Column<DateRow>[] = [
    {
      key: "date",
      header: t("deliveryDate"),
      render: (r) => (
        <>
          {r.date}
          {pending(r.totals.unsettledOrders)}
        </>
      ),
      sortValue: (r) => r.date,
    },
    ...DELIVERY_PLATFORMS.map(
      (p): Column<DateRow> => ({
        key: p,
        header: t(PLATFORM_KEY[p]),
        numeric: true,
        render: (r) => money(r.byPlatform[p]),
      }),
    ),
    { key: "orders", header: t("deliveryOrders"), numeric: true, render: (r) => r.totals.orders },
    {
      key: "gross",
      header: t("deliveryGross"),
      numeric: true,
      render: (r) => money(r.totals.gross),
      sortValue: (r) => r.totals.gross,
    },
    {
      key: "commission",
      header: t("deliveryCommission"),
      numeric: true,
      render: (r) => known(r.totals.commission, r.totals.commissionUnknown, r.totals.days),
    },
    {
      key: "net",
      header: t("deliveryNet"),
      numeric: true,
      render: (r) => known(r.totals.net, r.totals.netUnknown, r.totals.days),
    },
  ];
  type MonthRow = (typeof months)[number];
  const monthColumns: Column<MonthRow>[] = [
    { key: "month", header: t("deliveryMonth"), render: (r) => r.month },
    { key: "orders", header: t("deliveryOrders"), numeric: true, render: (r) => r.orders },
    { key: "gross", header: t("deliveryGross"), numeric: true, render: (r) => money(r.gross) },
    {
      key: "commission",
      header: t("deliveryCommission"),
      numeric: true,
      render: (r) => known(r.commission, r.commissionUnknown, r.days),
    },
    { key: "net", header: t("deliveryNet"), numeric: true, render: (r) => known(r.net, r.netUnknown, r.days) },
  ];
  type StoreRow = (typeof stores)[number];
  const storeColumns: Column<StoreRow>[] = [
    { key: "platform", header: t("deliveryPlatform"), render: (r) => t(PLATFORM_KEY[r.platform]) },
    { key: "store", header: t("deliveryStore"), render: (r) => r.store, wrap: true },
    { key: "orders", header: t("deliveryOrders"), numeric: true, render: (r) => r.totals.orders },
    { key: "gross", header: t("deliveryGross"), numeric: true, render: (r) => money(r.totals.gross) },
    {
      key: "commission",
      header: t("deliveryCommission"),
      numeric: true,
      render: (r) => known(r.totals.commission, r.totals.commissionUnknown, r.totals.days),
    },
    {
      key: "net",
      header: t("deliveryNet"),
      numeric: true,
      render: (r) => known(r.totals.net, r.totals.netUnknown, r.totals.days),
    },
    { key: "unsettled", header: t("deliveryUnsettled"), numeric: true, render: (r) => r.totals.unsettledOrders },
  ];
  const tile = (sum: number, unknown: number, tt: DeliveryTotals) =>
    unknown > 0 && unknown < tt.days
      ? `${money(sum)} (${fill(t("deliveryPartial"), { n: unknown })})`
      : known(sum, unknown, tt.days);
  return (
    <section className="delivery-history" aria-labelledby="delivery-history-title">
      <h2 id="delivery-history-title">{t("deliveryTitle")}</h2>
      <p className="warning-panel" role="note">
        {t("deliveryNote")}
      </p>
      <p className="muted">{t("deliveryDatesNote")}</p>
      <div className="row wrap history-range">
        <Field label={t("deliveryFrom")}>
          <input
            type="date"
            value={range.from}
            max={today}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          />
        </Field>
        <Field label={t("deliveryTo")}>
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
          {fill(t("deliveryRangeInvalid"), { days: DELIVERY_HISTORY_MAX_DAYS })}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!report && !error && online && valid && <p role="status">{t("loading")}</p>}
      {report && total && (
        <>
          {report.days.length === 0 ? (
            <p className="muted">{t("deliveryEmpty")}</p>
          ) : (
            <>
              <div className="history-tiles">
                {(
                  [
                    [t("deliveryOrders"), String(total.orders)],
                    [t("deliveryGross"), money(total.gross)],
                    [t("deliveryCommission"), tile(total.commission, total.commissionUnknown, total)],
                    [t("deliveryNet"), tile(total.net, total.netUnknown, total)],
                  ] as const
                ).map(([label, value]) => (
                  <div className="history-tile" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              {total.unsettledOrders > 0 && (
                <p className="muted">
                  {t("deliveryUnsettled")}: {total.unsettledOrders}
                </p>
              )}
              <div className="row wrap report-actions">
                <Button
                  onClick={() =>
                    exportCsv("deliveryCsvDaysName", report.range, deliveryDayCsvColumns(locale), report.days, ctx)
                  }
                >
                  {t("deliveryCsvDays")}
                </Button>
              </div>
              <h3>{t("deliveryByPlatform")}</h3>
              <DataTable
                caption={t("deliveryByPlatform")}
                columns={storeColumns}
                rows={stores}
                rowKey={(r) => r.platform + "|" + r.store}
                locale={locale}
              />
              <h3>{t("deliveryByMonth")}</h3>
              <DataTable
                caption={t("deliveryByMonth")}
                columns={monthColumns}
                rows={months}
                rowKey={(r) => r.month}
                locale={locale}
              />
              <h3>{t("deliveryByDay")}</h3>
              <DataTable
                caption={t("deliveryByDay")}
                columns={dayColumns}
                rows={dates}
                rowKey={(r) => r.date}
                locale={locale}
              />
            </>
          )}
          {report.batches.length > 0 && (
            <details className="history-batches">
              <summary>{t("deliveryBatches")}</summary>
              <ul>
                {report.batches.map((b) => (
                  <li key={b.id}>
                    {fill(t("deliveryBatchLine"), {
                      name: b.sourceName ?? t("deliveryImportSourceUnknown"),
                      coverage: coverageText(b.coverage, locale),
                      days: b.days,
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
        <DeliveryImport
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
function DeliveryImport({
  locale,
  online,
  money,
  onImported,
}: {
  locale: Locale;
  online: boolean;
  money: (minor: number) => string;
  onImported: (r: DeliveryHistoryImportResult) => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const [file, setFile] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<DeliveryHistoryPreview | null>(null);
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
        await api<DeliveryHistoryPreview>(
          "/delivery-history/preview",
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
      const r = await api<DeliveryHistoryImportResult>(
        "/delivery-history/import",
        {},
        {
          raw: { body: file, type: "application/octet-stream" },
          headers: { [FILE_HASH_HEADER]: preview.fileHash },
          timeoutMs: 60_000,
        },
      );
      setDone(
        r.replayed
          ? t("deliveryImportReplayed")
          : fill(t("deliveryImportDone"), { orders: r.orders, days: r.days }),
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
  return (
    <details className="history-import">
      <summary>{t("deliveryImportTitle")}</summary>
      <p className="muted">{t("deliveryImportHelp")}</p>
      <Field label={t("deliveryImportFile")}>
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
      {busy && !p && <p role="status">{t("deliveryImportReading")}</p>}
      {p && rec && (
        <div className="history-preview">
          <p>
            <strong>
              {fill(t("deliveryImportSource"), {
                name: p.sourceName ?? t("deliveryImportSourceUnknown"),
              })}
            </strong>
          </p>
          <label className="check">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            {t("deliveryImportConfirmSource")}
          </label>
          <p role="status">
            {fill(t("deliveryImportCounts"), {
              days: p.days,
              orders: p.orders,
              gross: money(rec.converted.gross),
            })}
          </p>
          <ul className="history-list">
            {DELIVERY_PLATFORMS.filter((pl) => p.coverage[pl]).map((pl) => (
              <li key={pl}>
                <span>{fill(t("deliveryImportCoverage"), { platform: t(PLATFORM_KEY[pl]), ...p.coverage[pl]! })}</span>
                <span>
                  {p.byPlatform[pl].orders} · {money(p.byPlatform[pl].gross)}
                </span>
              </li>
            ))}
          </ul>
          {rec.matches ? (
            <p className="success">{fill(t("deliveryImportReconciled"), { gross: money(rec.converted.gross) })}</p>
          ) : (
            <p role="alert" className="error">
              {fill(t("deliveryImportNotReconciled"), {
                source: rec.source.gross,
                converted: money(rec.converted.gross),
              })}
            </p>
          )}
          {rec.rounded > 0 && <p className="muted">{fill(t("deliveryImportRounded"), { n: rec.rounded })}</p>}
          {!rec.summaryOk && (
            <p role="alert" className="error">
              {t("deliveryImportSummaryBad")}
            </p>
          )}
          {p.rejected.length > 0 && (
            <details>
              <summary>{fill(t("deliveryImportRejected"), { n: p.rejected.length })}</summary>
              <ul>
                {p.rejected.map((r) => (
                  <li key={r.row}>
                    #{r.row} · {r.date} · {r.platform} · {r.store} · {t(DELIVERY_REASON_KEY[r.reason])}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {p.alreadyImported && <p className="muted">{t("deliveryImportAlready")}</p>}
          {p.replacesDays > 0 && (
            <p className="warning-panel" role="note">
              {fill(t("deliveryImportReplaces"), { n: p.replacesDays })}
            </p>
          )}
          {p.olderThanImported && (
            <p role="alert" className="error">
              {t("deliveryImportOlder")}
            </p>
          )}
          <Button
            variant="primary"
            disabled={
              !online ||
              busy ||
              !confirmed ||
              !p.days ||
              p.olderThanImported ||
              !rec.summaryOk ||
              !rec.matches
            }
            onClick={() => void commit()}
          >
            {t("deliveryImportCommit")}
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
