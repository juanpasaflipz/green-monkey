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
import {
  isLiveForOrder,
  type AttemptView,
  type PaymentOptions,
  type PlatformCode,
  type TenderMethod,
} from "../../shared/payments";
import { EMPTY_PAYMENT_OPTIONS } from "./payments/options";
import { TerminalPicker } from "./payments/TerminalPicker";
import { PlatformFields } from "./payments/PlatformFields";
import { TerminalWait } from "./payments/TerminalWait";
import type { AttemptAction } from "./payments/attempt-text";

/** payments (037, P2): what "Enviar a {terminal}" sends (POST /payments/terminal/charges). */
export type TerminalChargeValues = {
  terminalId: string;
  amount: number;
  tip: number;
  items?: string[];
};

/** Offline (026) fills this slot; it is used only while the device is offline. */
export type OfflinePaymentSlot = {
  allowExternal: boolean;
  /** payments (037): the platform tender follows the same offline rule as the terminal. */
  allowPlatform?: boolean;
  confirmLabel: (method: TenderMethod) => string;
  hint: (method: TenderMethod) => ReactNode;
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
  paymentOptions = EMPTY_PAYMENT_OPTIONS,
  pricePlatform = null,
  onSetDefaultTerminal,
  attempt = null,
  onSendToTerminal,
  onAttemptAction,
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
  /** payments (037): terminals and platforms (GET /payments/options, cached for offline). */
  paymentOptions?: PaymentOptions;
  /** payments (037, LD-72): the order was rung at this platform's prices. */
  pricePlatform?: PlatformCode | null;
  /** "Usar siempre en este dispositivo" (online only). */
  onSetDefaultTerminal?: (terminalId: string) => void;
  /** payments (037, P2): the integrated charge this dialog waits for (or its last outcome). */
  attempt?: AttemptView | null;
  /** "Enviar a {terminal}" on an integrated terminal (online only). */
  onSendToTerminal?: (v: TerminalChargeValues) => void;
  /** The waiting panel's actions (cancel, switch, recheck, retry, resolve…). */
  onAttemptAction?: (action: AttemptAction) => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const currency = session.restaurant.currency;
  const exponent = currencyExponent(currency);
  const money = moneyFormatter(currency, locale);
  const text = (n: number) => (n / 10 ** exponent).toFixed(exponent);
  const ids = useId();
  const [method, setMethod] = useState<TenderMethod>(
    pricePlatform ? "platform" : "cash",
  );
  // payments (037): the card record's terminal (null = "Otra terminal"), defaulting to
  // this device's terminal once the options arrive, until the cashier picks one.
  const [terminalId, setTerminalId] = useState<string | null>(
    paymentOptions.defaultTerminalId,
  );
  const [terminalPicked, setTerminalPicked] = useState(false);
  if (
    !terminalPicked &&
    terminalId === null &&
    paymentOptions.defaultTerminalId &&
    paymentOptions.terminals.some(
      (x) => x.id === paymentOptions.defaultTerminalId,
    )
  )
    setTerminalId(paymentOptions.defaultTerminalId);
  const [useAsDefault, setUseAsDefault] = useState(false);
  // P2 "Cobrar sin integración": the integrated terminal is recorded manually this time.
  const [manualFallback, setManualFallback] = useState(false);
  const offeredPlatforms = pricePlatform
    ? paymentOptions.platforms.filter((p) => p.platform === pricePlatform)
        .length
      ? paymentOptions.platforms.filter((p) => p.platform === pricePlatform)
      : [{ platform: pricePlatform }]
    : paymentOptions.platforms;
  const [platform, setPlatform] = useState<PlatformCode | null>(
    pricePlatform ??
      (paymentOptions.platforms.length === 1
        ? paymentOptions.platforms[0].platform
        : null),
  );
  const [platformLabel, setPlatformLabel] = useState("");
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
    // A platform covers the whole balance (Q6): its amount is the balance.
    amountText: method === "platform" ? text(due) : amountText,
    tipText,
    receivedText,
    method,
    reference,
    confirmed,
    due,
    exponent,
    drawerOpen,
    online,
    terminalId: method === "external" ? terminalId : null,
    platform: method === "platform" ? platform : null,
    platformLabel,
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
  const platformAllowed =
    offeredPlatforms.length > 0 &&
    !splitItems &&
    (online || !!(slot?.allowPlatform ?? slot?.allowExternal));
  const canConfirm =
    !busy &&
    !settling &&
    !blockReason &&
    (pendingPayment || (validation.ok && !waitingForItems));
  // payments (037, P2): an integrated terminal online sends the amount to the terminal instead
  // of asking for a received amount, a reference and the confirmation.
  const selectedTerminal =
    paymentOptions.terminals.find((x) => x.id === terminalId) ?? null;
  const integrated =
    online &&
    method === "external" &&
    !!selectedTerminal?.integrated &&
    !manualFallback &&
    !!onSendToTerminal;
  const attemptLive = !!attempt && isLiveForOrder(attempt.state);
  const canSend =
    integrated &&
    !attempt &&
    !busy &&
    !settling &&
    !blockReason &&
    !pendingPayment &&
    drawerOpen &&
    amount !== null &&
    amount > 0 &&
    amount <= due &&
    tip !== null &&
    !waitingForItems;
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
      close={() => {
        if (busy) return;
        // P2: the charge stays on the terminal and confirms on its own (Cobros en terminal).
        if (attemptLive && !window.confirm(t("payStillRunningClose"))) return;
        onClose();
      }}
      closeLabel={t("close")}
      footer={
        attempt ? undefined : integrated ? (
          <>
            <div className="row between">
              <span>{t("thisPayment")}</span>
              <strong>
                {amount !== null && tip !== null ? money(amount + tip) : "—"}
              </strong>
            </div>
            <Button
              variant="primary"
              className="full"
              disabled={!canSend}
              onClick={() => {
                if (
                  !canSend ||
                  !selectedTerminal ||
                  amount === null ||
                  tip === null
                )
                  return;
                if (
                  useAsDefault &&
                  selectedTerminal.id !== paymentOptions.defaultTerminalId
                )
                  onSetDefaultTerminal?.(selectedTerminal.id);
                onSendToTerminal?.({
                  terminalId: selectedTerminal.id,
                  amount,
                  tip,
                  ...(splitItems ? { items: selected } : {}),
                });
              }}
            >
              {busy
                ? t("loading")
                : t("paySendToTerminal").replace(
                    "{terminal}",
                    selectedTerminal?.name ?? "",
                  )}
              <Check size={20} />
            </Button>
          </>
        ) : (
          <>
            <div className="row between">
              <span>{t("thisPayment")}</span>
              <strong>{amount !== null ? money(amount) : "—"}</strong>
            </div>
            <Button
              variant="primary"
              className="full"
              disabled={!canConfirm}
              onClick={() => {
                if (
                  online &&
                  useAsDefault &&
                  validation.ok &&
                  validation.values.method === "external" &&
                  validation.values.terminalId &&
                  validation.values.terminalId !==
                    paymentOptions.defaultTerminalId
                )
                  onSetDefaultTerminal?.(validation.values.terminalId);
                onConfirm(
                  validation.ok ? validation.values : null,
                  splitItems ? selected : undefined,
                );
              }}
            >
              {busy ? t("loading") : confirmLabel}
              <Check size={20} />
            </Button>
          </>
        )
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
              disabled={!!attempt}
              className={method === "cash" ? "selected" : ""}
              onClick={() => setMethod("cash")}
            >
              {t("cashMethod")}
            </button>
            <button
              type="button"
              aria-pressed={method === "external"}
              disabled={!externalAllowed || !!attempt}
              className={method === "external" ? "selected" : ""}
              onClick={() => setMethod("external")}
            >
              {t("payMethodCard")}
            </button>
            {(platformAllowed || method === "platform") && (
              <button
                type="button"
                aria-pressed={method === "platform"}
                disabled={!platformAllowed || !!attempt}
                className={method === "platform" ? "selected" : ""}
                onClick={() => {
                  setMethod("platform");
                  setConfirmed(false);
                }}
              >
                {t("payMethodPlatform")}
              </button>
            )}
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
          {attempt ? (
            <TerminalWait
              attempt={attempt}
              locale={locale}
              money={money}
              online={online}
              manager={["owner", "manager"].includes(session.role)}
              busy={busy}
              onAction={(action) => {
                if (action === "manualFallback") {
                  setManualFallback(true);
                  setMethod("external");
                } else if (action === "otherMethod") setMethod("cash");
                onAttemptAction?.(action);
              }}
            />
          ) : (
            <>
              <Field label={t("amount")}>
                <input
                  inputMode="decimal"
                  value={method === "platform" ? text(due) : amountText}
                  readOnly={splitItems || method === "platform"}
                  aria-invalid={problem?.field === "amount" || undefined}
                  aria-describedby={errorId("amount")}
                  onChange={(e) => {
                    setAmountText(e.target.value);
                    setAmountFollows(false);
                  }}
                />
              </Field>
              {inline("amount")}
              {method === "platform" ? (
                <>
                  <p className="muted">
                    {t("payPlatformBalance").replace("{amount}", money(due))}
                  </p>
                  <PlatformFields
                    platforms={offeredPlatforms}
                    platform={platform}
                    onPlatform={setPlatform}
                    label={platformLabel}
                    onLabel={setPlatformLabel}
                    reference={reference}
                    onReference={setReference}
                    confirmed={confirmed}
                    onConfirmed={setConfirmed}
                    locale={locale}
                    disabled={busy}
                    problem={problem}
                    errorIdOf={errorId}
                  />
                </>
              ) : (
                <>
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
                          aria-invalid={
                            problem?.field === "received" || undefined
                          }
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
                      {!integrated && (
                        <p className="warning-panel">
                          {manualFallback
                            ? t("payManualFallbackHint")
                            : t("externalHint")}
                        </p>
                      )}
                      <TerminalPicker
                        terminals={paymentOptions.terminals}
                        value={terminalId}
                        onChange={(id) => {
                          setTerminalId(id);
                          setTerminalPicked(true);
                        }}
                        useAsDefault={useAsDefault}
                        onUseAsDefault={setUseAsDefault}
                        canSetDefault={online && !!onSetDefaultTerminal}
                        locale={locale}
                        disabled={busy}
                        online={online}
                      />
                      {!integrated && (
                        <>
                          <Field label={t("reference")}>
                            <input
                              value={reference}
                              maxLength={120}
                              autoComplete="off"
                              aria-invalid={
                                problem?.field === "reference" || undefined
                              }
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
                    </>
                  )}
                </>
              )}
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
