import { useState } from "react";
import { Printer } from "lucide-react";
import {
  currencyExponent,
  type Locale,
  type Order,
  type Session,
} from "../../shared/domain";
import { parseMoneyInput, type OrderSummary } from "../../shared/service";
import { api } from "../api";
import { Button, Field, Modal } from "../components/ui";
import { strings, translateError, type Key } from "../i18n";
import { printDocument, usePrintSettings } from "../print";
import { ReceiptDocument, auditPrint } from "./Receipt";
import { onlineChargeRefusal } from "./offline/useOnlineChargeBlocks";

/**
 * Grouped cash settlement of several checks, with one operation id per dialog.
 * The checks and balances are fixed when the dialog opens (SVC-R9): the list
 * behind it polls, and a retry of a lost submit must send the same amounts
 * under the same operation id so the server replays it. A check whose balance
 * changes behind the dialog is announced, and after the payment each check's
 * remaining balance is shown with its receipts ready to print (SVC-REV-3).
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
  /** The checks as the settlement left them, with the change it gave. */
  const [done, setDone] = useState<{ orders: Order[]; change: number } | null>(
    null,
  );
  const [print] = usePrintSettings();
  const received = (() => {
    try {
      return parseMoneyInput(receivedText, exponent);
    } catch {
      return null;
    }
  })();
  /** SERVICE-MONEY-4: short cash is caught here, before the server refuses it. */
  const short = received !== null && received < total;
  // SVC-REV-3: a round or payment that reached a chosen check after the dialog
  // opened changes its balance; this settlement still covers what it showed.
  const changed = checks.flatMap((c) => {
    const live = orders.find((o) => o.id === c.id);
    return live && live.balance !== c.balance
      ? [{ ...c, now: live.balance }]
      : [];
  });
  if (done)
    return (
      <Modal title={t("settleOrders")} close={close} closeLabel={t("close")}>
        <p role="status">
          {t("serviceSettleDone").replace("{change}", money(done.change))}
        </p>
        <div>
          {done.orders.map((o) => (
            <div key={o.id}>
              <p>
                {t("serviceSettleLine")
                  .replace("{n}", String(o.number))
                  .replace("{paid}", money(o.paid))
                  .replace("{balance}", money(Math.max(0, o.total - o.paid)))}
              </p>
              {o.total > o.paid && (
                <p className="warning-panel">
                  {t("serviceSettleStillOwes")
                    .replace("{n}", String(o.number))
                    .replace("{balance}", money(o.total - o.paid))}
                </p>
              )}
            </div>
          ))}
        </div>
        <div className="row wrap">
          <Button
            onClick={() => {
              for (const o of done.orders)
                void auditPrint(o.id, "receipt", false);
              void printDocument(
                done.orders.map((o) => (
                  <ReceiptDocument
                    key={o.id}
                    order={o}
                    session={session}
                    // fiscal (027): comprobantes print in Spanish (D10).
                    locale="es"
                    kind="receipt"
                  />
                )),
                print.paper,
              );
            }}
          >
            <Printer size={16} />
            {t("serviceSettlePrint").replace("{n}", String(done.orders.length))}
          </Button>
          <Button variant="primary" onClick={close}>
            {t("serviceSettleClose")}
          </Button>
        </div>
      </Modal>
    );
  return (
    <Modal title={t("settleOrders")} close={close} closeLabel={t("close")}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const amount = parseMoneyInput(receivedText, exponent);
            // OFF-R29 (offline 026): never charge a check while this device
            // holds unsynced offline rounds or payments of it. Checked on the
            // full orders right before sending, retries included.
            const full = await Promise.all(
              checks.map((c) => api<Order>("/orders/" + c.id)),
            );
            const refused = await onlineChargeRefusal(session, full, locale);
            if (refused) {
              setError(refused);
              return;
            }
            const result = await api<Order[]>("/settlements", {
              operationId,
              orders: checks.map((o) => ({ id: o.id, amount: o.balance })),
              received: amount,
            });
            setDone({
              orders: checks.flatMap(
                (c) => result.find((o) => o.id === c.id) ?? [],
              ),
              change: amount - total,
            });
            await saved();
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
        {changed.map((c) => (
          <p key={c.id} className="warning-panel" role="status">
            {t("serviceSettleBalanceChanged")
              .replace("{n}", String(c.number))
              .replace("{now}", money(c.now))
              .replace("{fixed}", money(c.balance))}
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
