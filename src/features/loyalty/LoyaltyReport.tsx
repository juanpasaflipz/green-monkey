/**
 * Finanzas › Club de lealtad (038 §2.16): members, stamps, rewards (with their value as
 * discounts), member sales and top customers for the business-date range, from one read-only
 * snapshot. A ledger/balance mismatch shows as an alert. Shown only to owners and managers.
 */
import { useEffect, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import type { DateRange } from "../../../shared/reports";
import type { LoyaltyReport as Report } from "../../../shared/loyalty";
import { errorNotice } from "../../i18n";
import { loyaltyApi } from "./loyaltyApi";
import { fill, money, tr } from "./format";
import "./loyalty.css";

const pctText = (bps: number | null, locale: Locale) =>
  bps === null
    ? "—"
    : new Intl.NumberFormat(locale === "es" ? "es-MX" : "en-US", {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(bps / 10000);

export function LoyaltyReport({
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
  const t = tr(locale);
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!online) return;
    let live = true;
    setError("");
    loyaltyApi
      .report(range.from, range.to)
      .then((x) => live && setR(x))
      .catch((e) => live && setError(errorNotice(e, locale)));
    return () => {
      live = false;
    };
  }, [range.from, range.to, online]);
  const currency = session.restaurant.currency;
  const tile = (label: string, value: string) => (
    <div className="loyalty-tile" key={label}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
  return (
    <section className="loyalty-report" aria-labelledby="loyalty-report-title">
      <h2 id="loyalty-report-title">{t("loyaltyReportTitle")}</h2>
      {!online && <p className="muted">{t("loyaltyOfflineHint")}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {r && (
        <>
          {r.mismatches > 0 && (
            <p role="alert" className="warning-panel">
              {fill(t("loyaltyReportMismatch"), { n: r.mismatches })}
            </p>
          )}
          <div className="loyalty-tiles">
            {tile(t("loyaltyReportMembers"), String(r.members.total))}
            {tile(t("loyaltyReportNew"), String(r.members.new))}
            {tile(t("loyaltyReportImported"), String(r.members.imported))}
            {tile(t("loyaltyReportActive"), String(r.members.active))}
            {tile(t("loyaltyReportStamps"), String(r.stamps.earned))}
            {tile(t("loyaltyReportReversed"), String(r.stamps.reversed))}
            {tile(t("loyaltyReportAdjusted"), String(r.stamps.adjusted))}
            {tile(locale === "es" ? "Sellos por recomendaciones" : "Referral stamps", String(r.referralStamps ?? 0))}
            {tile(t("loyaltyReportRewardsEarned"), String(r.rewards.earned))}
            {tile(t("loyaltyReportRewardsRedeemed"), String(r.rewards.redeemed))}
            {tile(t("loyaltyReportRate"), pctText(r.rewards.rateBps, locale))}
            {tile(t("loyaltyReportValue"), money(r.rewards.value, locale, currency))}
            {tile(
              t("loyaltyReportLinkedSales"),
              `${money(r.sales.members, locale, currency)} · ${fill(t("loyaltyReportShare"), {
                pct: pctText(r.sales.shareBps, locale),
              })}`,
            )}
          </div>
          <h3>{t("loyaltyReportTop")}</h3>
          <div className="table-scroll">
            <table className="loyalty-table">
              <thead>
                <tr>
                  <th scope="col">{t("loyaltyColName")}</th>
                  <th scope="col">{t("loyaltyColPhone")}</th>
                  <th scope="col">{t("loyaltyReportVisits")}</th>
                  <th scope="col">{t("loyaltyReportSpend")}</th>
                </tr>
              </thead>
              <tbody>
                {r.top.map((m) => (
                  <tr key={m.memberId}>
                    <td>{m.name || t("loyaltyDeleted")}</td>
                    <td>{m.maskedPhone}</td>
                    <td>{m.visits}</td>
                    <td>{money(m.spend, locale, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
