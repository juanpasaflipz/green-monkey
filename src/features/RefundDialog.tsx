import { useEffect, useMemo, useRef, useState } from "react";
import {
  currencyExponent,
  type Locale,
  type Order,
  type Session,
} from "../../shared/domain";
import { parseMoneyInput } from "../../shared/service";
import {
  amountRefundAllowed,
  planItemRefund,
  refundableQuantities,
  REFUND_REASONS,
  type ItemRefundPlan,
  type RefundBatchView,
  type RefundReason,
} from "../../shared/discounts";
import { api } from "../api";
import { Button, Field, Modal } from "../components/ui";
import {
  ManagerApproval,
  type ApprovalValue,
} from "../components/ManagerApproval";
import { strings, translateError, type Key } from "../i18n";
import { tenderMethodLabel } from "../labels";
import { printDocument, readPrintSettings } from "../print";
import { RefundSlip } from "./discounts/RefundSlip";
import { REFUND_REASON_LABELS, fill, lineLabel } from "./discounts/format";
import "./discounts/discounts.css";

type Tender = {
  id: string;
  method: "cash" | "external";
  amount: number;
  refunded: number;
  external_reference: string | null;
  source?: string;
};
/** Codes after which the dialog reloads the order and keeps the inputs. */
const RELOAD_CODES = ["refund_changed", "refund_balance_due", "stale_order"];

/**
 * Refunds (discounts 028): by item (fully paid units, returned to the tenders
 * that paid them, in any check state) or by amount (one tender, only once the
 * check has no balance due). Cash leaves this device's drawer; a terminal
 * (card) portion is only recorded, after the terminal approved it, with its
 * reference. Staff need a manager's PIN (the only PIN asked, LD-2); a manager
 * or owner acting alone confirms with the standard "Confirma con tu PIN"
 * step-up when the server asks for it (LD-15 Q2). One operation id per opened
 * dialog, kept across retries until it succeeds (MON-3).
 */
export function RefundDialog({
  order: initial,
  session,
  locale,
  money,
  close,
  saved,
  online = true,
}: {
  order: Order;
  session: Session;
  locale: Locale;
  money: (n: number) => string;
  close: () => void;
  saved: () => Promise<void> | void;
  online?: boolean;
}) {
  const t = (k: Key) => strings[locale][k];
  const exponent = currencyExponent(session.restaurant.currency);
  const staff = !["owner", "manager"].includes(session.role);
  const [order, setOrder] = useState(initial);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [mode, setMode] = useState<"items" | "amount" | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [restock, setRestock] = useState(false);
  const [tenderId, setTenderId] = useState("");
  const [amountText, setAmountText] = useState("");
  const [reasonCode, setReasonCode] = useState<RefundReason | "">("");
  const [note, setNote] = useState("");
  const [externals, setExternals] = useState<
    Record<string, { reference: string; confirmed: boolean }>
  >({});
  const [approval, setApproval] = useState<ApprovalValue>({
    employeeId: "",
    secret: "",
  });
  const [drawerOpen, setDrawerOpen] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const finished = useRef(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    order: Order;
    batch: RefundBatchView;
  } | null>(null);

  useEffect(() => {
    let live = true;
    void api<{ closed_at: string | null } | null>("/cash")
      .then((d) => {
        if (live) setDrawerOpen(!!d && !d.closed_at);
      })
      .catch(() => {
        if (live) setDrawerOpen(null);
      });
    return () => {
      live = false;
    };
  }, []);

  const tenders = (order.tenders ?? []) as Tender[];
  const refundable = useMemo(
    () => (order.itemSplitAvailable ? refundableQuantities(order) : {}),
    [order],
  );
  const itemLines = order.lines.filter((l) => (refundable[l.id] ?? 0) > 0);
  const amountTenders = tenders.filter((x) => x.amount > x.refunded);
  const paidCheck = amountRefundAllowed(order);
  const amountAllowed = paidCheck && amountTenders.length > 0;
  const tab: "items" | "amount" | null =
    mode === "amount" && amountAllowed
      ? "amount"
      : itemLines.length
        ? "items"
        : amountAllowed
          ? "amount"
          : null;

  // Preview with the same planning code the server runs.
  const entries = Object.entries(quantities)
    .filter(([lineId, q]) => q > 0 && (refundable[lineId] ?? 0) > 0)
    .map(([lineId, quantity]) => ({ lineId, quantity }));
  let plan: ItemRefundPlan | null = null;
  let planError = "";
  if (tab === "items" && entries.length)
    try {
      plan = planItemRefund(order, entries);
    } catch (e) {
      planError = translateError((e as Error).message, locale);
    }
  const tender =
    tab === "amount"
      ? (amountTenders.find((x) => x.id === tenderId) ?? amountTenders[0])
      : undefined;
  let amount = 0;
  let amountError = "";
  if (tab === "amount" && amountText.trim())
    try {
      amount = parseMoneyInput(amountText, exponent);
      if (tender && amount > tender.amount - tender.refunded)
        amountError = translateError("refund_exceeds", locale);
    } catch {
      amountError = translateError("invalid_amount", locale);
    }
  const portions: { tenderId: string; method: string; amount: number }[] =
    tab === "items"
      ? (plan?.byTender ?? [])
      : tender && amount > 0
        ? [{ tenderId: tender.id, method: tender.method, amount }]
        : [];
  const total = portions.reduce((n, p) => n + p.amount, 0);
  const cashPart = portions
    .filter((p) => p.method === "cash")
    .reduce((n, p) => n + p.amount, 0);
  const externalPortions = portions.filter((p) => p.method === "external");
  const externalPart = externalPortions.reduce((n, p) => n + p.amount, 0);

  // Kitchen: units of rounds the kitchen has not served are cancelled there.
  const roundOf = (lineId: string) => {
    const line = order.lines.find((l) => l.id === lineId);
    return order.rounds.find(
      (r: { number: number; station: string }) =>
        r.number === line?.round && r.station === line?.station,
    );
  };
  const kitchenUnits = (plan?.lines ?? [])
    .filter((l) => {
      const r = roundOf(l.lineId);
      return r && r.state !== "completed";
    })
    .reduce((n, l) => n + l.units.length, 0);
  const kitchenSaw = (plan?.lines ?? []).some((l) => {
    const r = roundOf(l.lineId);
    return !r || r.state !== "active" || !!r.seen_at;
  });

  const noteRequired = reasonCode === "other";
  const cashBlocked = cashPart > 0 && drawerOpen === false;
  const ready =
    online && !!tab && total > 0 && !planError && !amountError && !cashBlocked;

  async function reload() {
    try {
      setOrder(await api<Order>("/orders/" + order.id));
    } catch {
      /* the error already shown says what to do */
    }
  }
  async function submit() {
    if (!tab || !ready || !reasonCode) return;
    setBusy(true);
    setError("");
    const external = externalPortions.map((p) => ({
      tenderId: p.tenderId,
      reference: (externals[p.tenderId]?.reference ?? "").trim(),
      confirmed: true as const,
    }));
    const body =
      tab === "items"
        ? {
            mode: "items",
            operationId,
            lines: entries,
            expectedAmount: total,
            restock,
            reasonCode,
            note: note.trim(),
            external,
          }
        : {
            mode: "amount",
            operationId,
            tenderId: tender!.id,
            amount,
            reasonCode,
            note: note.trim(),
            external,
          };
    try {
      const r = await api<{ order: Order; batch: RefundBatchView }>(
        `/orders/${order.id}/refunds`,
        staff
          ? {
              ...body,
              approval: {
                employeeId: approval.employeeId,
                secret: approval.secret,
              },
            }
          : body,
      );
      setOperationId(crypto.randomUUID());
      setResult(r);
    } catch (e) {
      const code = (e as Error).message;
      setError(translateError(code, locale));
      if (RELOAD_CODES.includes(code)) await reload();
      if (staff) setApproval((a) => ({ ...a, secret: "" }));
    } finally {
      setBusy(false);
    }
  }

  const title = fill(t("discountsRefundTitle"), { n: order.number });
  /**
   * Leaving the result view (Listo, the X button or Escape) always refreshes
   * the screen behind it: the money has already moved, so the parent must not
   * keep showing the pre-refund check (DSC-R1).
   */
  async function finish() {
    if (finished.current) return;
    finished.current = true;
    setFinishing(true);
    try {
      await saved();
    } finally {
      close();
    }
  }
  if (result)
    return (
      <Modal title={title} close={() => void finish()} closeLabel={t("close")}>
        <p className="notice" role="status">
          {fill(t("discountsRefundDone"), {
            amount: money(result.batch.amount),
          })}
        </p>
        <div className="row wrap">
          <Button
            onClick={() =>
              // A customer-facing comprobante: always printed in Spanish.
              void printDocument(
                <RefundSlip
                  order={result.order}
                  batch={result.batch}
                  session={session}
                  locale="es"
                />,
                readPrintSettings().paper,
              )
            }
          >
            {t("discountsRefundPrint")}
          </Button>
          <Button
            variant="primary"
            disabled={finishing}
            onClick={() => void finish()}
          >
            {t("discountsRefundDoneClose")}
          </Button>
        </div>
      </Modal>
    );

  // cfdi (030): cfdiTicketCovered(useCfdiTicketStatus(order.fiscal?.ticket?.id ?? null))
  const cfdiCovered = false as boolean;
  return (
    <Modal title={title} close={close} closeLabel={t("close")} wide>
      <p>
        #{order.number} · {order.name || t("order")}
      </p>
      {!online && (
        <p className="warning-panel" role="status">
          {t("discountsRefundOffline")}
        </p>
      )}
      {!tab ? (
        <>
          <p className="muted" role="note">
            {paidCheck
              ? t("discountsRefundNothing")
              : t("discountsRefundAmountNeedsPaid")}
          </p>
          <div className="row">
            <Button onClick={close}>{t("discountsCancel")}</Button>
          </div>
        </>
      ) : (
        <form
          className="discounts-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div
            className="service-tabs"
            role="group"
            aria-label={t("discountsRefundMode")}
          >
            {itemLines.length > 0 && (
              <button
                type="button"
                aria-pressed={tab === "items"}
                className={tab === "items" ? "selected" : ""}
                onClick={() => setMode("items")}
              >
                {t("discountsRefundModeItems")}
              </button>
            )}
            {amountAllowed && (
              <button
                type="button"
                aria-pressed={tab === "amount"}
                className={tab === "amount" ? "selected" : ""}
                onClick={() => setMode("amount")}
              >
                {t("discountsRefundModeAmount")}
              </button>
            )}
          </div>
          {!paidCheck && (
            <p className="muted tiny" role="note">
              {t("discountsRefundAmountNeedsPaid")}
            </p>
          )}
          {tab === "items" ? (
            <section className="refund-items">
              <p className="muted">{t("discountsRefundItemsHint")}</p>
              {itemLines.map((line) => {
                const max = refundable[line.id]!;
                const one = planItemRefund(order, [
                  { lineId: line.id, quantity: 1 },
                ]).total;
                return (
                  <div className="refund-line" key={line.id}>
                    <Field
                      label={fill(t("discountsRefundLine"), {
                        name: lineLabel(line, locale),
                        amount: money(one),
                      })}
                    >
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={max}
                        value={quantities[line.id] ?? 0}
                        onChange={(e) =>
                          setQuantities((q) => ({
                            ...q,
                            [line.id]: Math.max(
                              0,
                              Math.min(max, Number(e.target.value) || 0),
                            ),
                          }))
                        }
                      />
                    </Field>
                    <small className="muted">
                      {fill(t("discountsRefundAvailable"), { n: max })}
                    </small>
                  </div>
                );
              })}
              {planError && (
                <p className="error" role="alert">
                  {planError}
                </p>
              )}
              {kitchenUnits > 0 && (
                <p className="warning-panel" role="note">
                  {fill(t("discountsRefundKitchen"), { n: kitchenUnits })}
                </p>
              )}
              <fieldset className="field">
                <legend>{t("discountsRefundStock")}</legend>
                <label className="choice">
                  <input
                    type="radio"
                    name="restock"
                    checked={!restock}
                    onChange={() => setRestock(false)}
                  />
                  {t("discountsRefundNoRestock")}
                </label>
                <label className="choice">
                  <input
                    type="radio"
                    name="restock"
                    checked={restock}
                    onChange={() => setRestock(true)}
                  />
                  {t("discountsRefundRestock")}
                </label>
              </fieldset>
              {restock && kitchenSaw && (
                <p className="warning-panel" role="note">
                  {t("discountsRefundRestockWarning")}
                </p>
              )}
            </section>
          ) : (
            <section className="refund-amount">
              <Field label={t("discountsRefundTender")}>
                <select
                  value={tender?.id ?? ""}
                  onChange={(e) => setTenderId(e.target.value)}
                >
                  {amountTenders.map((x) => (
                    <option key={x.id} value={x.id}>
                      {fill(t("discountsRefundTenderOption"), {
                        method: tenderMethodLabel(x.method, x.source, locale),
                        paid: money(x.amount),
                        available: money(x.amount - x.refunded),
                      })}
                      {x.method === "external" && x.external_reference
                        ? ` · Ref. ${x.external_reference}`
                        : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("amount")}>
                <input
                  inputMode="decimal"
                  required
                  value={amountText}
                  aria-invalid={!!amountError || undefined}
                  onChange={(e) => setAmountText(e.target.value)}
                />
              </Field>
              <p className="muted tiny">{t("discountsRefundTipNote")}</p>
              {amountError && (
                <p className="error" role="alert">
                  {amountError}
                </p>
              )}
            </section>
          )}
          {portions.length > 0 && (
            <section className="refund-breakdown" aria-live="polite">
              <h3>{t("discountsRefundBreakdown")}</h3>
              {cashPart > 0 && (
                <p className={cashBlocked ? "error" : ""}>
                  {cashBlocked
                    ? t("discountsRefundDrawerNeeded")
                    : fill(t("discountsRefundCashPart"), {
                        amount: money(cashPart),
                      })}
                </p>
              )}
              {externalPart > 0 && (
                <>
                  <p>
                    <strong>
                      {fill(t("discountsRefundCardPart"), {
                        amount: money(externalPart),
                      })}
                    </strong>
                  </p>
                  <p className="muted tiny">{t("discountsRefundCardHint")}</p>
                  {externalPortions.map((p) => {
                    const original = tenders.find((x) => x.id === p.tenderId);
                    const value = externals[p.tenderId] ?? {
                      reference: "",
                      confirmed: false,
                    };
                    const update = (patch: Partial<typeof value>) =>
                      setExternals((x) => ({
                        ...x,
                        [p.tenderId]: { ...value, ...patch },
                      }));
                    return (
                      <div className="refund-terminal" key={p.tenderId}>
                        <p>
                          {fill(t("discountsRefundOriginalRef"), {
                            ref: original?.external_reference ?? "—",
                            amount: money(p.amount),
                          })}
                        </p>
                        <Field label={t("discountsRefundReference")}>
                          <input
                            value={value.reference}
                            maxLength={120}
                            required
                            onChange={(e) =>
                              update({ reference: e.target.value })
                            }
                          />
                        </Field>
                        <label className="choice-row">
                          <input
                            type="checkbox"
                            required
                            checked={value.confirmed}
                            onChange={(e) =>
                              update({ confirmed: e.target.checked })
                            }
                          />
                          {fill(t("discountsRefundConfirm"), {
                            amount: money(p.amount),
                          })}
                        </label>
                      </div>
                    );
                  })}
                </>
              )}
            </section>
          )}
          <Field label={t("discountsRefundReason")}>
            <select
              value={reasonCode}
              required
              onChange={(e) => setReasonCode(e.target.value as RefundReason)}
            >
              <option value="">—</option>
              {REFUND_REASONS.map((code) => (
                <option key={code} value={code}>
                  {t(REFUND_REASON_LABELS[code])}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("reason")}>
            <textarea
              value={note}
              maxLength={300}
              required={noteRequired}
              minLength={noteRequired ? 3 : undefined}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          {cfdiCovered && <p role="note">{t("discountsRefundCfdiNotice")}</p>}
          {staff && (
            <ManagerApproval
              session={session}
              locale={locale}
              value={approval}
              onChange={setApproval}
            />
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row wrap">
            <Button onClick={close}>{t("discountsCancel")}</Button>
            <Button variant="primary" type="submit" disabled={busy || !ready}>
              {fill(t("discountsRefundSubmit"), { amount: money(total) })}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
