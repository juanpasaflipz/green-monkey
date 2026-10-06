import { useId, useState } from "react";
import { Percent } from "lucide-react";
import type { Locale, Order, Session } from "../../../shared/domain";
import { balanceDue } from "../../../shared/discounts";
import { api } from "../../api";
import { Button, Modal } from "../../components/ui";
import { strings, errorNotice, type Key } from "../../i18n";
import { DiscountDialog } from "./DiscountDialog";
import "./discounts.css";

/**
 * Vender's "Descuento" text button (§2.2 entry 1). With unsent lines in the
 * cart it first asks to send them ("Enviar productos primero"): only sent
 * items are discounted. Online and server orders only; Selling's `send`
 * resolves to the sent server order, or null when it did not open one.
 * Offline it is disabled with the visible hint "Los descuentos requieren
 * conexión."; a cart blocked by an 86'd item disables it too, and Selling's
 * own warning gives that reason (`blocked`).
 */
export function DiscountButton({
  order,
  hasDraftLines,
  send,
  session,
  locale,
  online,
  blocked = false,
  money,
  onApplied,
}: {
  order: Order | null;
  hasDraftLines: boolean;
  send: () => Promise<Order | null>;
  session: Session;
  locale: Locale;
  online: boolean;
  blocked?: boolean;
  money: (n: number) => string;
  onApplied: (o: Order) => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sendError, setSendError] = useState("");
  const hintId = useId();
  const sendErrorId = useId();
  const enabled =
    online && !blocked && (hasDraftLines || (!!order && balanceDue(order) > 0));
  async function open(o: Order | null) {
    if (!o) return;
    setBusy(true);
    setError("");
    try {
      // The freshest copy: units, payments and discounts of this order.
      setTarget(await api<Order>("/orders/" + o.id));
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <span className="discounts-entry">
        <button
          type="button"
          className="text-button"
          disabled={!enabled || busy}
          aria-describedby={online ? undefined : hintId}
          onClick={() => {
            setSendError("");
            if (hasDraftLines) setConfirming(true);
            else void open(order);
          }}
        >
          <Percent size={14} />
          {t("discountsAction")}
        </button>
        {!online && (
          <small id={hintId} className="tiny muted">
            {t("discountsOffline")}
          </small>
        )}
      </span>
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
          {sendError && (
            <p className="error" role="alert" id={sendErrorId}>
              {sendError}
            </p>
          )}
          <div className="row wrap">
            <Button onClick={() => setConfirming(false)}>
              {t("discountsCancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              aria-describedby={sendError ? sendErrorId : undefined}
              onClick={async () => {
                setBusy(true);
                setSendError("");
                let sent: Order | null;
                try {
                  sent = await send();
                } catch (e) {
                  // Selling did not handle it: say so here and keep the
                  // confirmation open for a retry (DSC-R8).
                  setSendError(errorNotice(e, locale));
                  setBusy(false);
                  return;
                }
                setConfirming(false);
                setBusy(false);
                await open(sent);
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
