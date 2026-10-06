import { useEffect, useState, type ReactNode } from "react";
import type { Locale } from "../../shared/domain";
import { currencyExponent } from "../../shared/domain";
import { api } from "../api";
import { strings, translateError } from "../i18n";
import { tenderMethodLabel } from "../labels";
import { Badge, Button } from "../components/ui";
import { fill } from "./discounts/format";
import "./cash/cash.css";

/** One closed drawer as GET /cash/history lists it (discounts 028 columns included). */
export type CashHistoryRow = {
  id: string;
  opened_at: string;
  closed_at: string;
  device_name: string;
  expected: number;
  counted: number;
  reason: string | null;
  late_recovery: number;
  late_external: number;
  currencies: string[] | null;
  opened_by_name: string;
  closed_by_name: string | null;
  count_mode: "blind" | "visible" | null;
  external_expected: number | null;
  external_reported: number | null;
  review_note: string | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
  needs_review: boolean;
};

export function CashHistory({
  locale,
  currency,
  rowActions,
}: {
  locale: Locale;
  /** Restaurant currency, used when a drawer has no tender currency evidence. */
  currency: string;
  /**
   * Actions per closed drawer, rendered after "Ver movimientos": discounts'
   * "Revisar diferencia" (028); reports adds its corte print in the same
   * Operations-side function (LD-16 L6).
   */
  rowActions?: (row: CashHistoryRow) => ReactNode;
}) {
  const es = locale === "es";
  const t = strings[locale];
  const [rows, setRows] = useState<CashHistoryRow[]>([]),
    [offset, setOffset] = useState(0),
    [detail, setDetail] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void api(`/cash/history?offset=${offset}`)
      .then((data) => {
        if (live) setRows(data);
      })
      .catch((e: Error) => {
        if (live) setError(translateError(e.message, locale));
      });
    return () => {
      live = false;
    };
  }, [offset, locale]);
  const format = (value: number, row: Pick<CashHistoryRow, "currencies">) => {
    const code =
      row.currencies?.length === 1 && row.currencies[0]
        ? row.currencies[0]
        : currency;
    return new Intl.NumberFormat(es ? "es-MX" : "en-US", {
      style: "currency",
      currency: code,
    }).format(value / 10 ** currencyExponent(code));
  };
  return (
    <details className="panel">
      <summary>{es ? "Historial de cajas" : "Drawer history"}</summary>
      {error && <p role="alert">{error}</p>}
      {rows.map((row) => (
        <article className="panel" key={row.id}>
          <h3>
            {row.device_name} · {new Date(row.closed_at).toLocaleString(locale)}
          </h3>
          <div className="cash-history-meta">
            {row.closed_by_name && (
              <span>
                {fill(t.discountsHistoryClosedBy, { name: row.closed_by_name })}
              </span>
            )}
            {row.count_mode === "blind" && (
              <Badge>{t.discountsHistoryBlind}</Badge>
            )}
            {row.needs_review && (
              <Badge tone="amber">{t.discountsReviewPending}</Badge>
            )}
          </div>
          <p>
            {es ? "Esperado al cerrar" : "Expected at close"}:{" "}
            {format(row.expected, row)}
          </p>
          <p>
            {es ? "Conteo original" : "Original count"}:{" "}
            {format(row.counted, row)}
          </p>
          <p>
            {es ? "Diferencia original" : "Original discrepancy"}:{" "}
            {format(row.counted - row.expected, row)}
          </p>
          <p>
            {es ? "Recuperaciones posteriores" : "Late recoveries"}:{" "}
            {format(row.late_recovery, row)}
          </p>
          <p>
            {es ? "Esperado ajustado" : "Adjusted expected"}:{" "}
            {format(row.expected + row.late_recovery, row)}
          </p>
          {row.external_expected !== null && (
            <p>
              {row.external_reported !== null
                ? fill(t.discountsHistoryTerminal, {
                    net: format(row.external_expected, row),
                    reported: format(row.external_reported, row),
                    difference: format(
                      row.external_reported - row.external_expected,
                      row,
                    ),
                  })
                : fill(t.discountsHistoryTerminalNet, {
                    net: format(row.external_expected, row),
                  })}
            </p>
          )}
          {row.late_external > 0 && (
            <p className="muted">
              {fill(t.discountsHistoryLateTerminal, {
                amount: format(row.late_external, row),
              })}
            </p>
          )}
          {row.reason && <p>{row.reason}</p>}
          {row.review_note && row.reviewer_name && (
            <p className="muted">
              {fill(t.discountsReviewDone, {
                name: row.reviewer_name,
                note: row.review_note,
              })}
            </p>
          )}
          <div className="row wrap">
            <Button
              onClick={() =>
                void api(`/cash/history/${row.id}`)
                  .then(setDetail)
                  .catch((e: Error) =>
                    setError(translateError(e.message, locale)),
                  )
              }
            >
              {es ? "Ver movimientos" : "View movements"}
            </Button>
            {rowActions?.(row)}
          </div>
          {detail?.id === row.id && (
            <ul>
              {detail.tenders.map((x: any) => (
                <li key={x.id}>
                  {tenderMethodLabel(x.method, x.source, locale)} ·{" "}
                  {format(x.amount + x.tip, row)} ·{" "}
                  {new Date(x.created_at).toLocaleTimeString(locale)}
                </li>
              ))}
              {(detail.refunds ?? []).map((x: any) => (
                <li key={x.id}>
                  {t.discountsHistoryRefunds} ·{" "}
                  {tenderMethodLabel(x.method ?? "cash", undefined, locale)} · −
                  {format(x.amount, row)} ·{" "}
                  {new Date(x.created_at).toLocaleTimeString(locale)}
                </li>
              ))}
              {(detail.movements ?? []).map((x: any) => (
                <li key={x.id}>
                  {t.discountsHistoryPaidOuts} · {format(x.amount, row)}
                  {x.reason ? ` · ${x.reason}` : ""} ·{" "}
                  {new Date(x.created_at).toLocaleTimeString(locale)}
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
      <div className="row">
        <Button
          disabled={offset === 0}
          onClick={() => setOffset((n) => Math.max(0, n - 50))}
        >
          {es ? "Anterior" : "Previous"}
        </Button>
        <Button
          disabled={rows.length < 50}
          onClick={() => setOffset((n) => n + 50)}
        >
          {es ? "Siguiente" : "Next"}
        </Button>
      </div>
    </details>
  );
}
