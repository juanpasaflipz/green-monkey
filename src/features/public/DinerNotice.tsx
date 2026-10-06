import type { Locale } from "../../../shared/domain";
import { strings } from "../../i18n";
import { Button } from "../../components/ui";
import "./diner.css";

/**
 * Full-page notices with no menu: an invalid, replaced or deactivated code
 * (also every legacy signed link, shown without calling the API) and
 * ordering that is not available (plan or kill switch; DinerApp clears it
 * at the next successful call, PUBLIC-UX-1). A phone that ordered with a
 * replaced code gets back to its orders from here.
 */
export function DinerNotice({
  kind,
  locale = "es",
  onShowOrders,
}: {
  kind: "invalid" | "unavailable";
  locale?: Locale;
  onShowOrders?: () => void;
}) {
  const t = strings[locale];
  return (
    <main className="diner diner-notice" lang={locale}>
      {kind === "invalid" ? (
        <>
          <h1>{t.publicInvalidTitle}</h1>
          <p>{t.publicInvalidBody}</p>
          {onShowOrders && (
            <Button variant="primary" onClick={onShowOrders}>
              {t.publicShowMyOrders}
            </Button>
          )}
        </>
      ) : (
        <h1>{t.accountGuestOrderingUnavailable}</h1>
      )}
    </main>
  );
}
