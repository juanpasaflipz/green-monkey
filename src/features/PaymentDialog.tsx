import { useEffect, useId, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import {
  currencyExponent,
  type Locale,
  type Order,
  type Session,
} from "../../shared/domain";
import {
  cashSuggestions,
  changeDue,
  parseMoneyInput,
  tipFromPercent,
  validatePayment,
  type PaymentValues,
} from "../../shared/service";
import { strings, errorNotice, type Key } from "../i18n";
import { Button, Field, Modal } from "../components/ui";
import { moneyFormatter } from "./Receipt";
import { currentBusinessDate, orderNumberLabel } from "../labels";

/** Offline (026) fills this slot; it is used only while the device is offline. */
export type OfflinePaymentSlot = {
  allowExternal: boolean;
  confirmLabel: (method: "cash" | "external") => string;
  hint: (method: "cash" | "external") => ReactNode;
  /** Translated reason that disables Confirm. */
  blockReason: string | null;
};

/** How long Confirm ignores taps after the connection changes under the open dialog (LD-45). */
export const CONFIRM_SETTLE_MS = 700;

/**
 * The payment form. It mounts fresh for every payment, so method, reference
 * and confirmation never carry over between sales (FOH-3). Change is computed
 * from this payment's own amount (FOH-12), and every rule is checked before
 * anything is sent to the kitchen (MON-8). `busy` stays true for the whole
 * payment request, so Confirm can never submit twice (SVC-R2).
 */
export function PaymentDialog({
  due,
  current,
  hasDraftLines,
  session,
  locale,
  online,
  busy,
  pendingPayment,
  drawerOpen,
  error,
  notice = "",
  onConfirm,
  onSplitItems,
  onClose,
  onGoToCash,
  offline,
}: {
  due: number;
  current: Order | null;
  hasDraftLines: boolean;
  session: Session;
  locale: Locale;
  online: boolean;
  busy: boolean;
  pendingPayment: boolean;
  drawerOpen: boolean;
  error: string;
  /** Selling's notice (stale order, recovered send), shown inside the dialog. */
  notice?: string;
  /** Values are null only when a pending earlier payment is being recovered. */
  onConfirm: (v: PaymentValues | null, items?: string[]) => void;
  onSplitItems: () => Promise<Order | null>;
  onClose: () => void;
  onGoToCash: () => void;
  offline?: OfflinePaymentSlot;
}) {
  const t = (k: Key) => strings[locale][k];
  const currency = session.restaurant.currency;
  const exponent = currencyExponent(currency);
  const money = moneyFormatter(currency, locale);
  const text = (n: number) => (n / 10 ** exponent).toFixed(exponent);
  const ids = useId();
  const [method, setMethod] = useState<"cash" | "external">("cash");
  const [amountText, setAmountText] = useState(() => text(due));
  /** Importe follows the balance due until the cashier types an amount. */
  const [amountFollows, setAmountFollows] = useState(true);
  const [shownDue, setShownDue] = useState(due);
  const [dueChanged, setDueChanged] = useState(false);
  const [tipText, setTipText] = useState("");
  const [receivedInput, setReceivedInput] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [splitItems, setSplitItems] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [splitOrder, setSplitOrder] = useState<Order | null>(null);
  const [localError, setLocalError] = useState("");
  if (!busy && due !== shownDue) {
    // SVC-R4: the balance changed under the open dialog (a round from another
    // device, a recovered send). A prefilled Importe moves to the new balance
    // and the change is announced; a typed amount stays as the cashier set it.
    // SVC-R8: compared only once the collect settles, so a step inside it
    // (Cobrar sending the cart first) never announces a change by itself.
    setShownDue(due);
    setDueChanged(true);
    if (amountFollows && !splitItems) setAmountText(text(due));
  }
  // LD-45: the connection changing relabels Confirm in place ("Confirmar
  // cobro" and "Guardar cobro en este dispositivo" are different actions on
  // the same button). A tap already on its way as it changes must not run
  // the other one, so Confirm ignores taps for CONFIRM_SETTLE_MS after each
  // change. Opening the dialog is not a change.
  const [shownOnline, setShownOnline] = useState(online);
  const [settling, setSettling] = useState(0);
  if (online !== shownOnline) {
    setShownOnline(online);
    setSettling((n) => n + 1);
  }
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => setSettling(0), CONFIRM_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settling]);
  const parse = (s: string, emptyAsZero = false) => {
    try {
      return parseMoneyInput(s, exponent, { emptyAsZero });
    } catch {
      return null;
    }
  };
  const amount = parse(amountText);
  const tip = parse(tipText, true);
  // Received follows amount plus tip until the cashier types or taps a quick amount.
  const followed = amount !== null && tip !== null ? text(amount + tip) : "";
  const receivedText = receivedInput ?? followed;
  const received = parse(receivedText);
  const validation = validatePayment({
    amountText,
    tipText,
    receivedText,
    method,
    reference,
    confirmed,
    due,
    exponent,
    drawerOpen,
    online,
  });
  const waitingForItems = splitItems && !selected.length;
  const problem =
    !validation.ok &&
    !(waitingForItems && validation.problem.field === "amount")
      ? validation.problem
      : null;
  const units = (splitOrder ?? current)?.paymentUnits ?? [];
  const errorId = (field: string) =>
    problem?.field === field ? `${ids}-${field}-error` : undefined;
  const inline = (field: string) =>
    problem?.field === field ? (
      <p className="error field-error" id={`${ids}-${field}-error`}>
        {t(problem.key as Key)}
      </p>
    ) : null;
  const total = amount !== null && tip !== null ? amount + tip : null;
  const suggestions =
    total !== null && total > 0
      ? cashSuggestions(total, currency, exponent)
      : [];
  const slot = online ? undefined : offline;
  const blockReason = slot?.blockReason ?? null;
  const externalAllowed = online || !!slot?.allowExternal;
  const canConfirm =
    !busy &&
    !settling &&
    !blockReason &&
    (pendingPayment || (validation.ok && !waitingForItems));
  const confirmLabel = online
    ? t("confirmPay")
    : slot
      ? slot.confirmLabel(method)
      : t("saveOffline");
  // LD-29: collecting an order from another business day names it, with its date.
  const today = currentBusinessDate(session.restaurant);
  const title =
    current?.businessDate && current.number && current.businessDate !== today
      ? t("servicePayOrderTitle").replace(
          "{order}",
          orderNumberLabel(current, today, locale),
        )
      : t("pay");
  return (
    <Modal
      title={title}
      close={() => !busy && onClose()}
      closeLabel={t("close")}
      footer={
        <>
          <div className="row between">
            <span>{t("thisPayment")}</span>
            <strong>{amount !== null ? money(amount) : "—"}</strong>
          </div>
          <Button
            variant="primary"
            className="full"
            disabled={!canConfirm}
            onClick={() =>
              onConfirm(
                validation.ok ? validation.values : null,
                splitItems ? selected : undefined,
              )
            }
          >
            {busy ? t("loading") : confirmLabel}
            <Check size={20} />
          </Button>
        </>
      }
    >
      {/* Two columns on a short tablet (styles.css, FOH-10): what is owed and
          how it is split on the left, the amounts and the method's fields on
          the right, so a 1024×768 cashier never scrolls to collect. */}
      <div className="pay-columns">
        <div className="pay-summary">
          <span className="muted">{t("remaining")}</span>
          <div className="large-money">{money(due)}</div>
          {hasDraftLines && <p className="muted">{t("serviceSendsOnPay")}</p>}
          <p>{t("paymentHint")}</p>
          {notice && (
            <p className="notice" role="alert">
              {notice}
            </p>
          )}
          {dueChanged && (
            <p className="warning-panel" role="alert">
              {t("servicePayDueChanged").replace("{due}", money(due))}
            </p>
          )}
          {pendingPayment && !busy && (
            <p className="warning-panel" role="status">
              {t("pendingPaymentRecovery")}
            </p>
          )}
          {!online && (
            <div className="warning-panel" role="status">
              {slot ? slot.hint(method) : <p>{t("offlineHint")}</p>}
            </div>
          )}
          {blockReason && (
            <p className="error" role="alert">
              {blockReason}
            </p>
          )}
          {problem?.field === "drawer" && (
            <div className="warning-panel" id={`${ids}-drawer-error`}>
              <p role="alert">{t("servicePayDrawer")}</p>
              <Button onClick={onGoToCash}>{t("serviceGoToCash")}</Button>
            </div>
          )}
          <div
            className="service-tabs"
            role="group"
            aria-label={t("servicePayMethod")}
          >
            <button
              type="button"
              aria-pressed={method === "cash"}
              className={method === "cash" ? "selected" : ""}
              onClick={() => setMethod("cash")}
            >
              {t("cashMethod")}
            </button>
            <button
              type="button"
              aria-pressed={method === "external"}
              disabled={!externalAllowed}
              className={method === "external" ? "selected" : ""}
              onClick={() => setMethod("external")}
            >
              {t("external")}
            </button>
          </div>
          <div className="row wrap">
            <Button
              disabled={busy}
              onClick={() => {
                setSplitItems(false);
                setSelected([]);
                setAmountText(text(due));
                setAmountFollows(true);
                setReceivedInput(null);
              }}
            >
              {t("splitAmount")}
            </Button>
            <Button
              // SVC-R8: "Enviar y dividir" sends to the kitchen, so it needs the
              // same open drawer as Confirmar cobro.
              disabled={busy || !online || pendingPayment || !drawerOpen}
              onClick={async () => {
                setLocalError("");
                try {
                  const order = await onSplitItems();
                  if (!order) return;
                  setSplitOrder(order);
                  if (!order.itemSplitAvailable) {
                    setLocalError(t("unallocatedHistory"));
                    return;
                  }
                  setSplitItems(true);
                  setSelected([]);
                  setAmountText(text(0));
                  setAmountFollows(false);
                  setReceivedInput(null);
                } catch (e) {
                  setLocalError(errorNotice(e, locale));
                }
              }}
            >
              {t(hasDraftLines ? "sendAndSplit" : "splitItems")}
            </Button>
          </div>
          {splitItems && (
            <fieldset>
              <legend>{t("selectItems")}</legend>
              <p className="muted">{t("itemSplitHint")}</p>
              {units.map((unit) => (
                <label className="option" key={unit.key}>
                  <input
                    type="checkbox"
                    disabled={busy || unit.due === 0}
                    checked={selected.includes(unit.key)}
                    onChange={() => {
                      const next = selected.includes(unit.key)
                        ? selected.filter((key) => key !== unit.key)
                        : [...selected, unit.key];
                      setSelected(next);
                      setAmountText(
                        text(
                          units
                            .filter((u) => next.includes(u.key))
                            .reduce((n, u) => n + u.due, 0),
                        ),
                      );
                      setReceivedInput(null);
                    }}
                  />
                  <span>
                    {unit.name[locale]} · {unit.unit + 1}
                    <small>
                      {unit.paid ? `${t("paid")}: ${money(unit.paid)}` : ""}
                    </small>
                  </span>
                  <strong>
                    {unit.due
                      ? money(unit.due)
                      : unit.paid
                        ? t("paid")
                        : t("discountsRowComp")}
                  </strong>
                </label>
              ))}
            </fieldset>
          )}
        </div>
        <div className="pay-entry">
          <Field label={t("amount")}>
            <input
              inputMode="decimal"
              value={amountText}
              readOnly={splitItems}
              aria-invalid={problem?.field === "amount" || undefined}
              aria-describedby={errorId("amount")}
              onChange={(e) => {
                setAmountText(e.target.value);
                setAmountFollows(false);
              }}
            />
          </Field>
          {inline("amount")}
          <Field label={t("tip")}>
            <input
              inputMode="decimal"
              value={tipText}
              placeholder="0"
              aria-invalid={problem?.field === "tip" || undefined}
              aria-describedby={[errorId("tip"), `${ids}-tip-hint`]
                .filter(Boolean)
                .join(" ")}
              onChange={(e) => setTipText(e.target.value)}
            />
          </Field>
          <div className="row wrap chips">
            <Button onClick={() => setTipText("")}>
              {t("serviceTipNone")}
            </Button>
            {([10, 15] as const).map((p) => (
              <Button
                key={p}
                disabled={amount === null}
                onClick={() =>
                  amount !== null &&
                  setTipText(text(tipFromPercent(amount, p, exponent)))
                }
              >
                {t("serviceTipPercent").replace("{p}", String(p))}
              </Button>
            ))}
          </div>
          <p className="muted tiny" id={`${ids}-tip-hint`}>
            {t("serviceTipVoluntary")}
          </p>
          {inline("tip")}
          {method === "cash" ? (
            <>
              <Field label={t("received")}>
                <input
                  inputMode="decimal"
                  value={receivedText}
                  aria-invalid={problem?.field === "received" || undefined}
                  aria-describedby={errorId("received")}
                  onChange={(e) => setReceivedInput(e.target.value)}
                />
              </Field>
              {suggestions.length > 0 && (
                <div
                  className="row wrap chips"
                  role="group"
                  aria-label={t("serviceQuickCash")}
                >
                  {suggestions.map((value, i) => (
                    <Button
                      key={value}
                      onClick={() => setReceivedInput(text(value))}
                    >
                      {i === 0 ? t("serviceExact") : money(value)}
                    </Button>
                  ))}
                </div>
              )}
              {inline("received")}
              <div className="row between">
                <span>{t("change")}</span>
                <strong>
                  {validation.ok && received !== null
                    ? money(
                        changeDue(
                          validation.values.received,
                          validation.values.amount,
                          validation.values.tip,
                        ),
                      )
                    : "—"}
                </strong>
              </div>
            </>
          ) : (
            <>
              <p className="muted">{t("servicePayExternalNoCash")}</p>
              <p className="warning-panel">{t("externalHint")}</p>
              <Field label={t("reference")}>
                <input
                  value={reference}
                  maxLength={120}
                  autoComplete="off"
                  aria-invalid={problem?.field === "reference" || undefined}
                  aria-describedby={errorId("reference")}
                  onChange={(e) => setReference(e.target.value)}
                />
              </Field>
              {inline("reference")}
              <label className="option">
                <input
                  type="checkbox"
                  checked={confirmed}
                  aria-describedby={errorId("confirmed")}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {t("confirmExternal")}
              </label>
              {inline("confirmed")}
            </>
          )}
          {(error || localError) && (
            <p className="error" role="alert">
              {error || localError}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
