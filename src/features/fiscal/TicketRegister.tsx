// "Registro de tickets" (fiscal 027, docs/FISCAL.md): tickets by business date or by folio,
// the IVA summary of the range, the accountant's CSV and reprints (printed in Spanish).
import { useState } from "react";
import {
  businessDate,
  type Locale,
  type Order,
  type Session,
} from "../../../shared/domain";
import type {
  CategoryTotals,
  FiscalSummary,
  TicketRow,
} from "../../../shared/fiscal";
import { formatFolio } from "../../../shared/fiscal";
import { api } from "../../api";
import { Button } from "../../components/ui";
import { strings, translateError } from "../../i18n";
import { tenderMethodLabel } from "../../labels";
import { printDocument, readPrintSettings } from "../../print";
import { auditPrint, ReceiptDocument } from "../Receipt";
import { categoryLabel, fill, fiscalDateTime, fiscalMoney } from "./format";
import { downloadCsv, ticketsCsv, ticketsCsvName } from "./csv";

type Page = { rows: TicketRow[]; next: string | null };
const CSV_PAGE = 500;

export function TicketRegister({
  session,
  locale,
}: {
  session: Session;
  locale: Locale;
}) {
  const t = strings[locale];
  const { timezone, cutoff, currency } = session.restaurant;
  const today = businessDate(new Date().toISOString(), timezone, cutoff);
  const money = fiscalMoney(currency, locale);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [folio, setFolio] = useState("");
  const [shown, setShown] = useState<{ from: string; to: string } | null>(null);
  const [rows, setRows] = useState<TicketRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [summary, setSummary] = useState<FiscalSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  };
  const range = (r: { from: string; to: string }) =>
    `from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}`;
  const show = () =>
    run(async () => {
      if (folio.trim()) {
        const page = await api<Page>(
          `/fiscal/tickets?folio=${encodeURIComponent(folio.trim())}`,
        );
        setShown(null);
        setSummary(null);
        setRows(page.rows);
        setNext(null);
        return;
      }
      const r = { from, to };
      const [page, totals] = await Promise.all([
        api<Page>(`/fiscal/tickets?${range(r)}`),
        api<FiscalSummary>(`/fiscal/summary?${range(r)}`),
      ]);
      setShown(r);
      setRows(page.rows);
      setNext(page.next);
      setSummary(totals);
    });
  const loadMore = () =>
    run(async () => {
      if (!shown || !next) return;
      const page = await api<Page>(
        `/fiscal/tickets?${range(shown)}&after=${encodeURIComponent(next)}`,
      );
      setRows((current) => [...(current ?? []), ...page.rows]);
      setNext(page.next);
    });
  const csv = () =>
    run(async () => {
      const r = { from, to };
      const all: TicketRow[] = [];
      let after: string | null = null;
      do {
        const page: Page = await api<Page>(
          `/fiscal/tickets?${range(r)}&limit=${CSV_PAGE}` +
            (after ? `&after=${encodeURIComponent(after)}` : ""),
        );
        all.push(...page.rows);
        after = page.next;
      } while (after);
      downloadCsv(ticketsCsvName(r.from, r.to), ticketsCsv(all, timezone));
    });
  const reprint = (row: TicketRow) =>
    run(async () => {
      const order = await api<Order>(`/orders/${row.orderId}`);
      void auditPrint(row.orderId, "receipt", true);
      await printDocument(
        <ReceiptDocument
          order={order}
          session={session}
          locale="es"
          kind="receipt"
          reprint
        />,
        readPrintSettings().paper,
      );
    });
  const methods = (row: TicketRow) =>
    [...new Set(row.payments.map((p) => p.method))]
      .map((m) => tenderMethodLabel(m, undefined, locale))
      .join(", ");
  return (
    <div className="fiscal-register-body">
      <form
        className="fiscal-filters"
        onSubmit={(e) => {
          e.preventDefault();
          void show();
        }}
      >
        <label className="field">
          <span>{t.fiscalFrom}</span>
          <input
            type="date"
            value={from}
            max={today}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{t.fiscalTo}</span>
          <input
            type="date"
            value={to}
            max={today}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{t.fiscalSearchFolio}</span>
          <input
            value={folio}
            maxLength={40}
            autoCapitalize="characters"
            placeholder="A-000123"
            onChange={(e) => setFolio(e.target.value)}
          />
        </label>
        <Button type="submit" variant="primary" disabled={busy}>
          {t.fiscalShow}
        </Button>
        <Button disabled={busy} onClick={() => void csv()}>
          {t.fiscalDownloadCsv}
        </Button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {summary && (
        <SummaryTable summary={summary} locale={locale} money={money} />
      )}
      {rows &&
        (rows.length === 0 ? (
          <p role="status">{t.fiscalRegisterEmpty}</p>
        ) : (
          <div className="fiscal-table-wrap">
            <table className="fiscal-table">
              <caption className="sr-only">{t.fiscalRegister}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.fiscalColFolio}</th>
                  <th scope="col">{t.fiscalColIssued}</th>
                  <th scope="col">{t.fiscalColOrder}</th>
                  <th scope="col" className="num">
                    {t.fiscalColTotal}
                  </th>
                  <th scope="col" className="num">
                    {t.fiscalColBase}
                  </th>
                  <th scope="col" className="num">
                    {t.fiscalColTax}
                  </th>
                  <th scope="col" className="num">
                    {t.fiscalColRefunds}
                  </th>
                  <th scope="col">{t.fiscalColMethods}</th>
                  <th scope="col">{t.fiscalColActions}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.folio}</td>
                    <td>{fiscalDateTime(row.issuedAt, timezone, locale)}</td>
                    <td>#{row.orderNumber}</td>
                    <td className="num">{money(row.gross)}</td>
                    <td className="num">{money(row.base)}</td>
                    <td className="num">{money(row.tax)}</td>
                    <td className="num">
                      {row.refundGross ? "−" + money(row.refundGross) : ""}
                    </td>
                    <td>{methods(row)}</td>
                    <td>
                      <Button
                        className="small"
                        disabled={busy}
                        aria-label={fill(t.fiscalReprintFolio, {
                          folio: row.folio,
                        })}
                        onClick={() => void reprint(row)}
                      >
                        {t.fiscalReprint}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {next && (
        <Button disabled={busy} onClick={() => void loadMore()}>
          {t.fiscalLoadMore}
        </Button>
      )}
    </div>
  );
}

function SummaryTable({
  summary,
  locale,
  money,
}: {
  summary: FiscalSummary;
  locale: Locale;
  money: (n: number) => string;
}) {
  const t = strings[locale];
  const of = (rows: CategoryTotals[], category: CategoryTotals["category"]) =>
    rows.find((r) => r.category === category);
  const cell = (r: CategoryTotals | undefined, k: "base" | "tax" | "gross") =>
    money(r?.[k] ?? 0);
  return (
    <section className="fiscal-summary" aria-label={t.fiscalSummaryTitle}>
      <h3>{t.fiscalSummaryTitle}</h3>
      <div className="fiscal-table-wrap">
        <table className="fiscal-table">
          <thead>
            <tr>
              <th scope="col">{t.fiscalColCategory}</th>
              <th scope="col" className="num">
                {t.fiscalSummarySales} · {t.fiscalColBase}
              </th>
              <th scope="col" className="num">
                {t.fiscalSummarySales} · {t.fiscalColTax}
              </th>
              <th scope="col" className="num">
                {t.fiscalSummaryRefunds} · {t.fiscalColBase}
              </th>
              <th scope="col" className="num">
                {t.fiscalSummaryRefunds} · {t.fiscalColTax}
              </th>
              <th scope="col" className="num">
                {t.fiscalSummaryNet} · {t.fiscalColBase}
              </th>
              <th scope="col" className="num">
                {t.fiscalSummaryNet} · {t.fiscalColTax}
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.net.map((n) => (
              <tr key={n.category}>
                <th scope="row">{categoryLabel(n.category, locale)}</th>
                <td className="num">
                  {cell(of(summary.sales, n.category), "base")}
                </td>
                <td className="num">
                  {cell(of(summary.sales, n.category), "tax")}
                </td>
                <td className="num">
                  {cell(of(summary.refunds, n.category), "base")}
                </td>
                <td className="num">
                  {cell(of(summary.refunds, n.category), "tax")}
                </td>
                <td className="num">{cell(n, "base")}</td>
                <td className="num">{cell(n, "tax")}</td>
              </tr>
            ))}
            <tr>
              <th scope="row">{t.fiscalSummaryTotal}</th>
              <td className="num">{money(summary.totals.base)}</td>
              <td className="num">{money(summary.totals.tax)}</td>
              <td className="num">
                {money(summary.totals.refundGross - summary.totals.refundTax)}
              </td>
              <td className="num">{money(summary.totals.refundTax)}</td>
              <td className="num">{money(summary.totals.netBase)}</td>
              <td className="num">{money(summary.totals.netTax)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {summary.tickets.series.map((s) => (
        <p key={s.series}>
          {fill(t.fiscalSummaryRange, {
            first: formatFolio(s.series, s.first),
            last: formatFolio(s.series, s.last),
            n: s.count,
          })}
        </p>
      ))}
      {summary.missingTickets > 0 && (
        <p className="fiscal-warning">
          {fill(t.fiscalSummaryMissing, { n: summary.missingTickets })}
        </p>
      )}
    </section>
  );
}
