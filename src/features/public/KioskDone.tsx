import { useEffect, useState } from "react";
import type { Locale } from "../../../shared/domain";
import {
  KIOSK_TIMING,
  type DinerHoldView,
} from "../../../shared/public-ordering";
import { strings } from "../../i18n";
import { Button } from "../../components/ui";
import { fill, moneyFormatter } from "../menu/format";
import { createIdleController } from "./kioskIdle";

/**
 * The kiosk's confirmation: the code in very large type, the total, where to
 * pay, and a 20 s countdown back to the menu. The countdown is not
 * announced each second; the code is announced by the page's persistent
 * live region when the order is sent (UX-6), so the heading stays a plain
 * heading.
 */
export function KioskDone({
  hold,
  locale,
  currency,
  member = false,
  onReset,
}: {
  hold: DinerHoldView;
  locale: Locale;
  currency: string;
  /** The order carries a club member (KIOSK-UX-01): the stamp is added when it is paid. */
  member?: boolean;
  onReset: () => void;
}) {
  const t = strings[locale];
  const money = moneyFormatter(locale, currency);
  const total = KIOSK_TIMING.doneResetMs / 1000;
  const [seconds, setSeconds] = useState(total);
  useEffect(() => {
    const started = Date.now();
    const c = createIdleController({
      resetAfterMs: KIOSK_TIMING.doneResetMs,
      onReset,
    });
    const tick = setInterval(
      () =>
        setSeconds(
          Math.max(0, total - Math.floor((Date.now() - started) / 1000)),
        ),
      1000,
    );
    return () => {
      c.dispose();
      clearInterval(tick);
    };
  }, []);
  return (
    <section className="kiosk-done">
      <p className="muted">{t.publicCode}</p>
      <h2 className="kiosk-code">{hold.label}</h2>
      <p className="kiosk-total">{money(hold.total)}</p>
      <p className="kiosk-instructions">
        {hold.policy === "pay_first"
          ? t.publicKioskPayAtCounter
          : t.publicKioskGoToCounter}
      </p>
      {member && <p className="kiosk-instructions">{t.kioskStampAtCounter}</p>}
      <Button variant="primary" className="kiosk-new" onClick={onReset}>
        {t.publicKioskNewOrder}
      </Button>
      <p className="muted" aria-hidden="true">
        {fill(t.publicKioskResetIn, { seconds })}
      </p>
    </section>
  );
}
