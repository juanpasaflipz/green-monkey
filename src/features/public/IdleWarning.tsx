import { useEffect, useState } from "react";
import type { Locale } from "../../../shared/domain";
import { strings } from "../../i18n";
import { fill } from "../menu/format";
import { Button, Modal } from "../../components/ui";

/**
 * "¿Sigues ahí?" (§2.12, WCAG 2.2.1): shown `seconds` before the kiosk clears the order, on the
 * menu with a cart and on the checkout screens that reset on their own (KIOSK-UX-05). Any touch
 * or key re-arms the idle timers; «Sigo aquí» closes it.
 */
export function IdleWarning({
  locale,
  seconds: total,
  onContinue,
}: {
  locale: Locale;
  seconds: number;
  onContinue: () => void;
}) {
  const t = strings[locale];
  const [seconds, setSeconds] = useState(total);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(
      () =>
        setSeconds(
          Math.max(0, total - Math.floor((Date.now() - started) / 1000)),
        ),
      1000,
    );
    return () => clearInterval(timer);
  }, [total]);
  return (
    <Modal
      title={t.publicIdleTitle}
      close={onContinue}
      closeLabel={t.publicIdleContinue}
      footer={
        <Button variant="primary" onClick={onContinue}>
          {t.publicIdleContinue}
        </Button>
      }
    >
      <p>{fill(t.publicIdleBody, { seconds })}</p>
    </Modal>
  );
}
