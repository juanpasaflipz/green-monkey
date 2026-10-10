/**
 * Finanzas › Kiosco (039 §6.3, critic R27): kiosk orders and where they were paid, card charges
 * approved without an order and how they ended, and the suggestion lines guests accepted, for the
 * business-date range. Owners and managers.
 */
import { useEffect, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import type { DateRange } from "../../../shared/reports";
import { api } from "../../api";
import { errorNotice, strings, type Key } from "../../i18n";
import { moneyFormatter } from "../menu/format";

type Report = {
  orders: number;
  paidAtKiosk: number;
  paidAtCounter: number;
  review: {
    open: number;
    resolved: number;
    refunded: number;
    refundedAmount: number;
  };
  suggestions: { lines: number; amount: number };
};

export function KioskReport({
  session,
  locale,
  range,
  online = true,
}: {
  session: Session;
  locale: Locale;
  range: DateRange;
  online?: boolean;
}) {
  const t = (k: Key) => strings[locale][k];
  const money = moneyFormatter(locale, session.restaurant.currency);
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!online) return;
    let live = true;
    setError("");
    api<Report>(`/kiosk/report?from=${range.from}&to=${range.to}`)
      .then((x) => live && setR(x))
      .catch((e) => live && setError(errorNotice(e, locale)));
    return () => {
      live = false;
    };
  }, [range.from, range.to, online]);
  const tile = (label: string, value: string) => (
    <div className="loyalty-tile" key={label}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
  return (
    <section className="loyalty-report" aria-labelledby="kiosk-report-title">
      <h2 id="kiosk-report-title">{t("kioskReportTitle")}</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {r && (
        <div className="loyalty-tiles">
          {tile(t("kioskReportOrders"), String(r.orders))}
          {tile(t("kioskReportPaidKiosk"), String(r.paidAtKiosk))}
          {tile(t("kioskReportPaidCounter"), String(r.paidAtCounter))}
          {tile(t("kioskReportReview"), String(r.review.open))}
          {tile(t("kioskReportResolved"), String(r.review.resolved))}
          {tile(t("kioskReportSuggestions"), String(r.suggestions.lines))}
          {tile(t("kioskReportSuggestionsAmount"), money(r.suggestions.amount))}
        </div>
      )}
    </section>
  );
}
