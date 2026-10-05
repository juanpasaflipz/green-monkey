import { useState } from "react";
import {
  currencyExponent,
  type Locale,
  type Order,
  type Session,
} from "../../shared/domain";
import { parseMoneyInput } from "../../shared/service";
import { api } from "../api";
import { Button, Field, Modal } from "../components/ui";
import { strings, translateError, type Key } from "../i18n";

/**
 * Cash refund of a tender. One operation id per opened dialog, kept across
 * retries, so a lost response never records a second refund (MON-3).
 */
export function RefundDialog({
  order,
  session,
  locale,
  money,
  close,
  saved,
}: {
  order: Order;
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
  const refundable = order.tenders.filter(
    (x: any) => x.method === "cash" && x.amount > x.refunded,
  );
  return (
    <Modal title={t("refund")} close={close} closeLabel={t("close")}>
      <p>
        #{order.number} · {order.name || t("order")}
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          try {
            await api("/refunds", {
              operationId,
              tenderId: f.get("tenderId"),
              amount: parseMoneyInput(String(f.get("amount") ?? ""), exponent),
              reason: f.get("reason"),
              disposition: f.get("disposition"),
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
        <Field label={t("method")}>
          <select name="tenderId">
            {refundable.map((p: any) => (
              <option key={p.id} value={p.id}>
                {t("cashMethod")} · {money(p.amount - p.refunded)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("refundReason")}>
          <select name="disposition">
            <option value="discard">{t("discard")}</option>
            <option value="no_stock_return">{t("noReturn")}</option>
          </select>
        </Field>
        <Field label={t("amount")}>
          <input name="amount" inputMode="decimal" required />
        </Field>
        <Field label={t("reason")}>
          <textarea name="reason" required minLength={3} maxLength={300} />
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
          disabled={busy || !refundable.length}
        >
          {t("save")}
        </Button>
      </form>
    </Modal>
  );
}
