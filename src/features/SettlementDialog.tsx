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

/** Grouped cash settlement of several checks, with one operation id per dialog. */
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const total = orders.reduce((a, o) => a + o.balance, 0);
  return (
    <Modal title={t("settleOrders")} close={close} closeLabel={t("close")}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          try {
            await api("/settlements", {
              operationId,
              orders: orders.map((o) => ({ id: o.id, amount: o.balance })),
              received: parseMoneyInput(
                String(f.get("amount") ?? ""),
                exponent,
              ),
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
        {orders.map((o) => (
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
            defaultValue={(total / 10 ** exponent).toFixed(exponent)}
          />
        </Field>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Button
          variant="primary"
          className="full"
          type="submit"
          disabled={busy}
        >
          {t("save")}
        </Button>
      </form>
    </Modal>
  );
}
