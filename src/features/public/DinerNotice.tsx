import type { Locale } from "../../../shared/domain";
import { strings } from "../../i18n";
import { guestCopy } from "../../compat/public-account";
import "./diner.css";

/**
 * Full-page notices with no menu: an invalid, replaced or deactivated code
 * (also every legacy signed link, shown without calling the API) and
 * ordering that is not available (plan or kill switch).
 */
export function DinerNotice({
  kind,
  locale = "es",
}: {
  kind: "invalid" | "unavailable";
  locale?: Locale;
}) {
  const t = strings[locale];
  return (
    <main className="diner diner-notice" lang={locale}>
      {kind === "invalid" ? (
        <>
          <h1>{t.publicInvalidTitle}</h1>
          <p>{t.publicInvalidBody}</p>
        </>
      ) : (
        <h1>{guestCopy(locale).orderingUnavailable}</h1>
      )}
    </main>
  );
}
