import { useEffect, useState } from "react";
import {
  currencyExponent,
  type Locale,
  type Order,
  type Session,
} from "../../../shared/domain";
import { parseMoneyInput } from "../../../shared/service";
import {
  balanceDue,
  DISCOUNT_REASONS,
  discountClosesCheck,
  discountLimitCheck,
  formatPercentBps,
  PERCENT_CHIPS_BPS,
  percentToBps,
  planDiscount,
  type DiscountKind,
  type DiscountPlan,
  type DiscountReason,
  type DiscountScope,
} from "../../../shared/discounts";
import { api } from "../../api";
import { Button, Field, Modal } from "../../components/ui";
import {
  ManagerApproval,
  type ApprovalValue,
} from "../../components/ManagerApproval";
import { strings, translateError, type Key } from "../../i18n";
import { DISCOUNT_REASON_LABELS, fill } from "./format";
import { loadMoneyControls, useMoneyControls } from "./useMoneyControls";
import "./discounts.css";

/**
 * "Descuento · Orden #N" (§2.2): a line or check discount, or a comp, on the
 * unpaid money of sent items. The preview runs the server's planDiscount, so
 * what it shows is what is recorded. Staff over their limit approve with a
 * manager's PIN (the only PIN asked, LD-2); within it, or for a manager or
 * owner acting alone, the server may ask for the actor's own step-up PIN.
 */
export function DiscountDialog({
  order: initial,
  session,
  locale,
  money,
  online,
  initialLineId,
  close,
  applied,
}: {
  order: Order;
  session: Session;
  locale: Locale;
  money: (n: number) => string;
  online: boolean;
  initialLineId?: string;
  close: () => void;
  applied: (o: Order) => void | Promise<void>;
}) {
  const t = (k: Key) => strings[locale][k];
  const exponent = currencyExponent(session.restaurant.currency);
  const staff = !["owner", "manager"].includes(session.role);
  const controls = useMoneyControls(session);
  const [order, setOrder] = useState(initial);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const hasOrderDiscount = (order.discounts ?? []).some(
    (d) => d.scope === "order" && !d.reversal,
  );
  const [scope, setScope] = useState<DiscountScope>(
    initialLineId || hasOrderDiscount ? "line" : "order",
  );
  const [lineId, setLineId] = useState(initialLineId ?? "");
  const [quantityText, setQuantityText] = useState("");
  const [kind, setKind] = useState<DiscountKind>("percent");
  const [percentText, setPercentText] = useState("10");
  const [amountText, setAmountText] = useState("");
  const [reasonCode, setReasonCode] = useState<DiscountReason | "">("");
  const [note, setNote] = useState("");
  const [approval, setApproval] = useState<ApprovalValue>({
    employeeId: "",
    secret: "",
  });
  const [askApproval, setAskApproval] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadMoneyControls(session).catch(() => {});
  }, [session.id]);

  const units = order.paymentUnits ?? [];
  const lines = order.lines
    .map((line) => {
      const eligible = units.filter(
        (u) => u.lineId === line.id && u.due > 0 && !u.lineDiscounted,
      );
      return {
        line,
        eligible: eligible.length,
        due: eligible.reduce((n, u) => n + u.due, 0),
      };
    })
    .filter((l) => l.eligible > 0);
  const chosenLine =
    scope === "line"
      ? (lines.find((l) => l.line.id === lineId) ?? lines[0])
      : undefined;
  const quantity =
    scope === "line" && quantityText.trim()
      ? Number(quantityText)
      : chosenLine?.eligible;

  let plan: DiscountPlan | null = null;
  let inputError = "";
  let percentBps: number | undefined;
  let amount: number | undefined;
  if (kind === "percent") {
    percentBps = percentToBps(percentText) ?? undefined;
    if (percentBps === undefined) inputError = t("discountsPercentInvalid");
  } else if (kind === "amount" && amountText.trim()) {
    try {
      amount = parseMoneyInput(amountText, exponent);
      if (amount <= 0) inputError = translateError("discount_invalid", locale);
    } catch {
      inputError = translateError("invalid_amount", locale);
    }
  }
  if (
    !inputError &&
    (kind !== "amount" || amount !== undefined) &&
    (scope === "order" || chosenLine)
  )
    try {
      plan = planDiscount(order, {
        scope,
        lineId: chosenLine?.line.id,
        quantity: scope === "line" ? quantity : undefined,
        kind,
        percentBps,
        amount,
      });
    } catch (e) {
      inputError = translateError((e as Error).message, locale);
    }
  const check =
    plan && controls ? discountLimitCheck(session.role, plan, controls) : null;
  const overLimit = staff && (check === "exceeds" || askApproval);
  const closes = plan ? discountClosesCheck(order, plan) : false;
  const somePaid = units.some((u) => u.paid > 0);
  const noteRequired = reasonCode === "other";

  async function submit() {
    if (!plan || !reasonCode) return;
    setBusy(true);
    setError("");
    const body = {
      operationId,
      expectedVersion: order.version,
      scope,
      ...(scope === "line" ? { lineId: chosenLine!.line.id, quantity } : {}),
      kind,
      ...(kind === "percent" ? { percentBps } : {}),
      ...(kind === "amount" ? { amount } : {}),
      reasonCode,
      note: note.trim(),
      ...(overLimit
        ? {
            approval: {
              employeeId: approval.employeeId,
              secret: approval.secret,
            },
          }
        : {}),
    };
    try {
      const o = await api<Order>(`/orders/${order.id}/discounts`, body);
      setOperationId(crypto.randomUUID());
      await applied(o);
      close();
    } catch (e) {
      const code = (e as Error).message;
      if (code === "approval_required") setAskApproval(true);
      setError(
        code === "stale_order"
          ? t("discountsStaleOrder")
          : translateError(code, locale),
      );
      if (code === "stale_order")
        try {
          setOrder(await api<Order>("/orders/" + order.id));
        } catch {
          /* keep the message */
        }
      setApproval((a) => ({ ...a, secret: "" }));
    } finally {
      setBusy(false);
    }
  }

  const due = balanceDue(order);
  return (
    <Modal
      title={fill(t("discountsDialogTitle"), { n: order.number })}
      close={close}
      closeLabel={t("close")}
      wide
    >
      {!online && (
        <p className="warning-panel" role="status">
          {t("discountsOffline")}
        </p>
      )}
      <form
        className="discounts-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="field">
          <legend>{t("discountsScope")}</legend>
          <label className="choice">
            <input
              type="radio"
              name="scope"
              checked={scope === "order"}
              disabled={hasOrderDiscount}
              onChange={() => setScope("order")}
            />
            {t("discountsScopeOrder")}
          </label>
          {hasOrderDiscount && (
            <small className="muted">{t("discountsOrderDiscountExists")}</small>
          )}
          <label className="choice">
            <input
              type="radio"
              name="scope"
              checked={scope === "line"}
              disabled={!lines.length}
              onChange={() => setScope("line")}
            />
            {t("discountsScopeLine")}
          </label>
        </fieldset>
        {scope === "line" && chosenLine && (
          <div className="form-grid">
            <Field label={t("discountsLine")}>
              <select
                value={chosenLine.line.id}
                onChange={(e) => {
                  setLineId(e.target.value);
                  setQuantityText("");
                }}
              >
                {lines.map((l) => (
                  <option key={l.line.id} value={l.line.id}>
                    {fill(t("discountsLineOption"), {
                      q: l.eligible,
                      name:
                        l.line.name[locale] +
                        (l.line.optionNames.length
                          ? ` (${l.line.optionNames.map((o) => o[locale]).join(", ")})`
                          : ""),
                      due: money(l.due),
                    })}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("discountsQuantity")}>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={chosenLine.eligible}
                value={quantityText || String(chosenLine.eligible)}
                onChange={(e) => setQuantityText(e.target.value)}
              />
            </Field>
            <small className="muted">
              {fill(t("discountsEligibleUnits"), { n: chosenLine.eligible })}
            </small>
          </div>
        )}
        <div
          className="service-tabs"
          role="group"
          aria-label={t("discountsKind")}
        >
          {(
            [
              ["percent", "discountsKindPercent"],
              ["amount", "discountsKindAmount"],
              ["comp", "discountsKindComp"],
            ] as const
          ).map(([value, key]) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              className={kind === value ? "selected" : ""}
              onClick={() => setKind(value)}
            >
              {t(key)}
            </button>
          ))}
        </div>
        {kind === "percent" && (
          <>
            <div className="row wrap chips">
              {PERCENT_CHIPS_BPS.map((bps) => (
                <Button
                  key={bps}
                  className="small"
                  aria-pressed={percentToBps(percentText) === bps}
                  onClick={() => setPercentText(String(bps / 100))}
                >
                  {formatPercentBps(bps, locale)}
                </Button>
              ))}
            </div>
            <Field label={t("discountsPercent")}>
              <input
                inputMode="decimal"
                value={percentText}
                aria-describedby="discount-percent-hint"
                onChange={(e) => setPercentText(e.target.value)}
              />
            </Field>
            <small className="muted" id="discount-percent-hint">
              {t("discountsPercentHint")}
            </small>
          </>
        )}
        {kind === "amount" && (
          <Field label={t("discountsAmount")}>
            <input
              inputMode="decimal"
              required
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
            />
          </Field>
        )}
        <Field label={t("discountsReason")}>
          <select
            required
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value as DiscountReason)}
          >
            <option value="">—</option>
            {DISCOUNT_REASONS.map((code) => (
              <option key={code} value={code}>
                {t(DISCOUNT_REASON_LABELS[code])}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("discountsNote")}>
          <input
            value={note}
            maxLength={300}
            required={noteRequired}
            minLength={noteRequired ? 3 : undefined}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        {somePaid && (
          <p className="muted tiny" role="note">
            {t("discountsPaidNotDiscounted")}
          </p>
        )}
        <div className="discount-preview" role="status">
          {plan ? (
            <>
              <strong>
                {fill(t("discountsPreview"), {
                  amount: money(plan.amount),
                  balance: money(due - plan.amount),
                })}
              </strong>
              {kind === "percent" && percentBps && (
                <small className="muted">
                  {fill(t("discountsPreviewBase"), {
                    percent: formatPercentBps(percentBps, locale),
                    base: money(plan.base),
                  })}
                </small>
              )}
            </>
          ) : (
            inputError && <span className="error">{inputError}</span>
          )}
        </div>
        {closes && (
          <p className="warning-panel" role="note">
            {t(
              kind === "comp"
                ? "discountsCompClosesWarning"
                : "discountsClosesWarning",
            )}
          </p>
        )}
        {overLimit && (
          <>
            <p className="muted">{t("discountsApprovalNeeded")}</p>
            <ManagerApproval
              session={session}
              locale={locale}
              value={approval}
              onChange={setApproval}
            />
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row wrap">
          <Button onClick={close}>{t("discountsCancel")}</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={busy || !online || !plan}
          >
            {fill(t("discountsApply"), { amount: money(plan?.amount ?? 0) })}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
