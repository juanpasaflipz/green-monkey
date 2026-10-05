import { currencyExponent, type Locale } from "../../../shared/domain";
import type { LocalReceipt } from "../../offline-records";
import { strings } from "../../i18n";
import { moneyFormatter, translator } from "./format";

/**
 * Printable local receipt for an offline sale. In-wave stand-in for service's
 * ReceiptDocument kind="local" (§3.8), which replaces it at merge.
 */
export function LocalReceiptDocument({
  receipt,
  locale,
}: {
  receipt: LocalReceipt;
  locale: Locale;
}) {
  const t = translator(locale);
  const restaurant = receipt.restaurantSnapshot;
  const currency = restaurant?.currency ?? "MXN";
  const money = moneyFormatter(locale, currency, currencyExponent(currency));
  return (
    <div className="print-ticket">
      <p className="print-ticket-banner">{restaurant?.name}</p>
      <p>{strings[locale].localReceipt}</p>
      {receipt.offline.provisionalNumber && (
        <p className="print-ticket-label">
          {t("offlineProvisional", { n: receipt.offline.provisionalNumber })}
        </p>
      )}
      <p>{t("offlineProvisionalHint")}</p>
      <p>
        {new Date(receipt.createdAt).toLocaleString(
          locale === "es" ? "es-MX" : "en-US",
          { timeZone: restaurant?.timezone },
        )}
      </p>
      <ul>
        {receipt.lines.map((line) => (
          <li key={line.id}>
            {line.quantity} × {line.name[locale]} · {money(line.total)}
          </li>
        ))}
      </ul>
      <p>
        {strings[locale].total}: {money(receipt.total)}
      </p>
      <p>
        {strings[locale].paid}: {money(receipt.paid)}
        {receipt.offline.method === "external"
          ? ` · ${strings[locale].external} ${receipt.offline.reference}`
          : ""}
      </p>
    </div>
  );
}
