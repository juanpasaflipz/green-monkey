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

export type KioskReportData = {
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

/**
 * The report's tiles in order, as [label, value]. Charges approved without an order show as open,
 * resolved and, of those, refunded at the provider with the amount that went back to guests
 * (039 §6.3, KIOSK-OPS-4).
 */
export function kioskReportTiles(
  r: KioskReportData,
  locale: Locale,
  money: (cents: number) => string,
): Array<[string, string]> {
  const t = (k: Key) => strings[locale][k];
  return [
    [t("kioskReportOrders"), String(r.orders)],
    [t("kioskReportPaidKiosk"), String(r.paidAtKiosk)],
    [t("kioskReportPaidCounter"), String(r.paidAtCounter)],
    [t("kioskReportReview"), String(r.review.open)],
    [t("kioskReportResolved"), String(r.review.resolved)],
    [t("kioskReportRefunded"), String(r.review.refunded)],
    [t("kioskReportRefundedAmount"), money(r.review.refundedAmount)],
    [t("kioskReportSuggestions"), String(r.suggestions.lines)],
    [t("kioskReportSuggestionsAmount"), money(r.suggestions.amount)],
  ];
}

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
  const [r, setR] = useState<KioskReportData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!online) return;
    let live = true;
    setError("");
    api<KioskReportData>(`/kiosk/report?from=${range.from}&to=${range.to}`)
      .then((x) => live && setR(x))
      .catch((e) => live && setError(errorNotice(e, locale)));
    return () => {
      live = false;
    };
  }, [range.from, range.to, online]);
  return (
    <section className="loyalty-report" aria-labelledby="kiosk-report-title">
      <h2 id="kiosk-report-title">{t("kioskReportTitle")}</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!r && !error && online && <p role="status">{t("loading")}</p>}
      {r && (
        <div className="loyalty-tiles">
          {kioskReportTiles(r, locale, money).map(([label, value]) => (
            <div className="loyalty-tile" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
