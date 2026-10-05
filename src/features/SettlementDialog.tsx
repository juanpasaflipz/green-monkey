import { useState } from "react";
import {
  currencyExponent,
  type Locale,
  type Session,
} from "../../shared/domain";
import { parseMoneyInput, type OrderSummary } from "../../shared/service";
import { api } from "../api";
import { Button, Field, Modal } from "../components/ui";
import { strings, translateError, type Key } from "../i18n";

/**
 * Grouped cash settlement of several checks, with one operation id per dialog.
 * The checks and balances are fixed when the dialog opens (SVC-R9): the list
 * behind it polls, and a retry of a lost submit must send the same amounts
 * under the same operation id so the server replays it.
 */
export function SettlementDialog({
  orders,
  session,
  locale,
  money,
  close,
  saved,
}: {
  orders: OrderSummary[];
  session: Session;
  locale: Locale;
  money: (n: number) => string;
  close: () => void;
  saved: () => Promise<void> | void;
}) {
  const t = (k: Key) => strings[locale][k];
  const exponent = currencyExponent(session.restaurant.currency);
  const [operationId] = useState(() => crypto.randomUUID());
  const [checks] = useState(() =>
    orders.map((o) => ({ id: o.id, number: o.number, balance: o.balance })),
  );
  const total = checks.reduce((a, o) => a + o.balance, 0);
  const [receivedText, setReceivedText] = useState(() =>
    (total / 10 ** exponent).toFixed(exponent),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const received = (() => {
    try {
      return parseMoneyInput(receivedText, exponent);
    } catch {
      return null;
    }
  })();
  /** SERVICE-MONEY-4: short cash is caught here, before the server refuses it. */
  const short = received !== null && received < total;
  return (
    <Modal title={t("settleOrders")} close={close} closeLabel={t("close")}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api("/settlements", {
              operationId,
              orders: checks.map((o) => ({ id: o.id, amount: o.balance })),
              received: parseMoneyInput(receivedText, exponent),
            });
            await saved();
            close();
          } catch (err) {
            setError(translateError((err as Error).message, locale));
          } finally {
            setBusy(false);
          }
        }}
      >
        {checks.map((o) => (
          <p key={o.id}>
            #{o.number} · {money(o.balance)}
          </p>
        ))}
        <p>
          {t("cashMethod")} · {t("total")}: {money(total)}
        </p>
        <Field label={t("received")}>
          <input
            name="amount"
            inputMode="decimal"
            required
            value={receivedText}
            onChange={(e) => setReceivedText(e.target.value)}
          />
        </Field>
        <div className="row between">
          <span>{t("change")}</span>
          <strong>
            {received !== null && received >= total
              ? money(received - total)
              : "—"}
          </strong>
        </div>
        {short && (
          <p className="error field-error" role="alert">
            {translateError("insufficient_cash", locale)}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Button
          variant="primary"
          className="full"
          type="submit"
          disabled={busy || received === null || short}
        >
          {t("save")}
        </Button>
      </form>
    </Modal>
  );
}
