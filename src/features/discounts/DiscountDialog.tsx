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
  discountExpectation,
  discountIssuesTicket,
  discountLimitCheck,
  formatPercentBps,
  PERCENT_CHIPS_BPS,
  percentToBps,
  planDiscount,
  type DiscountKind,
  type DiscountPlan,
  type DiscountReason,
  type DiscountScope,
  unapprovedDiscounts,
} from "../../../shared/discounts";
import { api } from "../../api";
import { currentBusinessDate, orderNumberText } from "../../labels";
import { Button, Field, Modal } from "../../components/ui";
import {
  ManagerApproval,
  type ApprovalValue,
} from "../../components/ManagerApproval";
import { strings, errorNotice, translateError, type Key } from "../../i18n";
import { countText, DISCOUNT_REASON_LABELS, fill, lineLabel } from "./format";
import { loadMoneyControls, useMoneyControls } from "./useMoneyControls";
import "./discounts.css";

/** Codes after which the dialog reloads the check and keeps its inputs. */
const RELOAD_CODES = [
  "stale_order",
  "discount_changed",
  "fiscal_ticket_issued",
  "operation_conflict",
];

/**
 * "Descuento · Orden #N" (§2.2): a line or check discount, or a comp, on the
 * unpaid money of sent items. The preview runs the server's planDiscount and
 * the request carries what it showed (discountExpectation): when another
 * device paid or changed the check in between, the server answers
 * discount_changed (or stale_order) instead of recording something else, and
 * the dialog reloads the check. Staff over their limit approve with a
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
  // null until staff edit the field: it then shows exactly what they typed,
  // even empty (UI-3), instead of snapping back to the eligible count.
  const [quantityText, setQuantityText] = useState<string | null>(null);
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
  // Once a line is chosen it is never swapped for another one (UI-5): after a
  // reload that left it without eligible units, staff pick again.
  const chosenLine =
    scope === "line"
      ? lineId
        ? lines.find((l) => l.line.id === lineId)
        : lines[0]
      : undefined;
  const lineGone = scope === "line" && !!lineId && !chosenLine;
  const quantity =
    scope !== "line" || !chosenLine
      ? undefined
      : quantityText === null
        ? chosenLine.eligible
        : /^\d{1,2}$/.test(quantityText.trim()) &&
            Number(quantityText) >= 1 &&
            Number(quantityText) <= chosenLine.eligible
          ? Number(quantityText)
          : null;

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
  if (lineGone) inputError = t("discountsLineGone");
  else if (quantity === null && chosenLine)
    inputError = fill(t("discountsQuantityRequired"), {
      n: chosenLine.eligible,
    });
  if (
    !inputError &&
    (kind !== "amount" || amount !== undefined) &&
    (scope === "order" || chosenLine)
  )
    try {
      plan = planDiscount(order, {
        scope,
        lineId: chosenLine?.line.id,
        quantity: scope === "line" ? (quantity ?? undefined) : undefined,
        kind,
        percentBps,
        amount,
      });
    } catch (e) {
      inputError = errorNotice(e, locale);
    }
  // The server's figure (MONEY-2/MONEY-3): the request's kind rule and, per
  // check, the staff discounts already recorded without an approver.
  const check =
    plan && controls
      ? discountLimitCheck(
          session.role,
          { kind, percentBps },
          plan,
          controls,
          order,
        )
      : null;
  const overLimit = staff && (check === "exceeds" || askApproval);
  const staffLimit =
    staff && controls && controls.limits[session.role as "cashier" | "server"];
  const closes = plan ? discountClosesCheck(order, plan) : false;
  // FISCAL-2: a table check settled by the discount gets its ticket.
  const tickets = plan ? discountIssuesTicket(order, plan) : false;
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
      ...discountExpectation(order, plan),
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
          : code === "fiscal_ticket_issued"
            ? t("discountsTicketIssued")
            : code === "operation_conflict"
              ? t("discountsOperationRecorded")
              : errorNotice(e, locale),
      );
      // An earlier attempt with this id was recorded (CONCURRENCY-4): the
      // reloaded check shows it, and a new confirm is a new operation.
      if (code === "operation_conflict") setOperationId(crypto.randomUUID());
      if (RELOAD_CODES.includes(code))
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
      title={fill(t("discountsDialogTitle"), {
        // LD-29 (POL-R2-2): yesterday's open #10 names its date.
        n: orderNumberText(
          order,
          currentBusinessDate(session.restaurant),
          locale,
        ),
      })}
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
              aria-describedby={
                hasOrderDiscount ? "discount-order-exists" : undefined
              }
              onChange={() => setScope("order")}
            />
            {t("discountsScopeOrder")}
          </label>
          {hasOrderDiscount && (
            <small className="muted" id="discount-order-exists">
              {t("discountsOrderDiscountExists")}
            </small>
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
        {scope === "line" && (chosenLine || lineGone) && (
          <div className="form-grid">
            <Field label={t("discountsLine")}>
              <select
                value={chosenLine?.line.id ?? ""}
                aria-invalid={lineGone || undefined}
                aria-describedby={lineGone ? "discount-input-error" : undefined}
                onChange={(e) => {
                  setLineId(e.target.value);
                  setQuantityText(null);
                }}
              >
                {lineGone && (
                  <option value="" disabled>
                    —
                  </option>
                )}
                {lines.map((l) => (
                  <option key={l.line.id} value={l.line.id}>
                    {fill(t("discountsLineOption"), {
                      q: l.eligible,
                      name: lineLabel(l.line, locale),
                      due: money(l.due),
                    })}
                  </option>
                ))}
              </select>
            </Field>
            {chosenLine && (
              <>
                <Field label={t("discountsQuantity")}>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="off"
                    value={quantityText ?? String(chosenLine.eligible)}
                    aria-invalid={quantity === null || undefined}
                    aria-describedby={
                      quantity === null
                        ? "discount-input-error discount-eligible"
                        : "discount-eligible"
                    }
                    onChange={(e) => setQuantityText(e.target.value)}
                  />
                </Field>
                <small className="muted" id="discount-eligible">
                  {countText(
                    t,
                    "discountsEligibleUnits",
                    "discountsEligibleUnitsOne",
                    chosenLine.eligible,
                  )}
                </small>
              </>
            )}
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
              aria-invalid={(!plan && !!inputError) || undefined}
              aria-describedby={
                !plan && inputError ? "discount-input-error" : undefined
              }
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
            inputError && (
              <span className="error" id="discount-input-error">
                {inputError}
              </span>
            )
          )}
        </div>
        {plan && staffLimit && staffLimit.maxAmount > 0 && (
          <p className="muted tiny">
            {fill(t("discountsLimitUsed"), {
              used: money(unapprovedDiscounts(order).amount + plan.amount),
              max: money(staffLimit.maxAmount),
            })}
          </p>
        )}
        {closes && (
          <p className="warning-panel" role="note">
            {t(
              kind === "comp"
                ? "discountsCompClosesWarning"
                : "discountsClosesWarning",
            )}
          </p>
        )}
        {tickets && (
          <p className="warning-panel" role="note">
            {t("discountsTicketWarning")}
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
