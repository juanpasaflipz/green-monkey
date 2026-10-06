import { useState } from "react";
import { Percent } from "lucide-react";
import type { Locale, Order, Session } from "../../../shared/domain";
import { balanceDue } from "../../../shared/discounts";
import { api } from "../../api";
import { Button, Modal } from "../../components/ui";
import { strings, translateError, type Key } from "../../i18n";
import { DiscountDialog } from "./DiscountDialog";

/**
 * Vender's "Descuento" text button (§2.2 entry 1). With unsent lines in the
 * cart it first asks to send them ("Enviar productos primero"): only sent
 * items are discounted. Online and server orders only; Selling's `send`
 * resolves to the sent server order, or null when it did not open one.
 */
export function DiscountButton({
  order,
  hasDraftLines,
  send,
  session,
  locale,
  online,
  money,
  onApplied,
}: {
  order: Order | null;
  hasDraftLines: boolean;
  send: () => Promise<Order | null>;
  session: Session;
  locale: Locale;
  online: boolean;
  money: (n: number) => string;
  onApplied: (o: Order) => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const enabled =
    online && (hasDraftLines || (!!order && balanceDue(order) > 0));
  async function open(o: Order | null) {
    if (!o) return;
    setBusy(true);
    setError("");
    try {
      // The freshest copy: units, payments and discounts of this order.
      setTarget(await api<Order>("/orders/" + o.id));
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="text-button"
        disabled={!enabled || busy}
        title={online ? undefined : t("discountsOffline")}
        onClick={() => (hasDraftLines ? setConfirming(true) : void open(order))}
      >
        <Percent size={14} />
        {t("discountsAction")}
      </button>
      {!online && <span className="sr-only">{t("discountsOffline")}</span>}
      {error && (
        <p className="error tiny" role="alert">
          {error}
        </p>
      )}
      {confirming && (
        <Modal
          title={t("discountsSendFirstTitle")}
          close={() => setConfirming(false)}
          closeLabel={t("close")}
        >
          <p>{t("discountsSendFirst")}</p>
          <div className="row wrap">
            <Button onClick={() => setConfirming(false)}>
              {t("discountsCancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const sent = await send();
                  setConfirming(false);
                  setBusy(false);
                  await open(sent);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("discountsSendAndContinue")}
            </Button>
          </div>
        </Modal>
      )}
      {target && (
        <DiscountDialog
          order={target}
          session={session}
          locale={locale}
          money={money}
          online={online}
          close={() => setTarget(null)}
          applied={(o) => onApplied(o)}
        />
      )}
    </>
  );
}
