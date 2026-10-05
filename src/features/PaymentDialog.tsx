import { useId, useState, type ReactNode } from "react";
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
import { strings, translateError, type Key } from "../i18n";
import { Button, Field, Modal } from "../components/ui";
import { moneyFormatter } from "./Receipt";

/** Offline (026) fills this slot; it is used only while the device is offline. */
export type OfflinePaymentSlot = {
  allowExternal: boolean;
  confirmLabel: (method: "cash" | "external") => string;
  hint: (method: "cash" | "external") => ReactNode;
  /** Translated reason that disables Confirm. */
  blockReason: string | null;
};

/**
 * The payment form. It mounts fresh for every payment, so method, reference
 * and confirmation never carry over between sales (FOH-3). Change is computed
 * from this payment's own amount (FOH-12), and every rule is checked before
 * anything is sent to the kitchen (MON-8).
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
  const [tipText, setTipText] = useState("");
  const [receivedInput, setReceivedInput] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [splitItems, setSplitItems] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [splitOrder, setSplitOrder] = useState<Order | null>(null);
  const [localError, setLocalError] = useState("");
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
    !validation.ok && !(waitingForItems && validation.problem.field === "amount")
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
    total !== null && total > 0 ? cashSuggestions(total, currency, exponent) : [];
  const slot = online ? undefined : offline;
  const blockReason = slot?.blockReason ?? null;
  const externalAllowed = online || !!slot?.allowExternal;
  const canConfirm =
    !busy &&
    !blockReason &&
    (pendingPayment || (validation.ok && !waitingForItems));
  const confirmLabel = online
    ? t("confirmPay")
    : slot
      ? slot.confirmLabel(method)
      : t("saveOffline");
  return (
    <Modal
      title={t("pay")}
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
      <span className="muted">{t("remaining")}</span>
      <div className="large-money">{money(due)}</div>
      {hasDraftLines && <p className="muted">{t("serviceSendsOnPay")}</p>}
      <p>{t("paymentHint")}</p>
      {pendingPayment && (
        <p className="warning-panel" role="status">
          {t("pendingPaymentRecovery")}
        </p>
      )}
      {!online && (
        <div className="warning-panel">
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
            setReceivedInput(null);
          }}
        >
          {t("splitAmount")}
        </Button>
        <Button
          disabled={busy || !online || pendingPayment}
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
              setReceivedInput(null);
            } catch (e) {
              setLocalError(translateError((e as Error).message, locale));
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
              <strong>{unit.due ? money(unit.due) : t("paid")}</strong>
            </label>
          ))}
        </fieldset>
      )}
      <Field label={t("amount")}>
        <input
          inputMode="decimal"
          value={amountText}
          readOnly={splitItems}
          aria-invalid={problem?.field === "amount" || undefined}
          aria-describedby={errorId("amount")}
          onChange={(e) => setAmountText(e.target.value)}
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
        <Button onClick={() => setTipText("")}>{t("serviceTipNone")}</Button>
        {([10, 15] as const).map((p) => (
          <Button
            key={p}
            disabled={amount === null}
            onClick={() =>
              amount !== null && setTipText(text(tipFromPercent(amount, p, exponent)))
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
    </Modal>
  );
}
