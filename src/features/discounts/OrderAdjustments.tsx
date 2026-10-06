import { useState, type ReactNode } from "react";
import type { Locale, Order, Session } from "../../../shared/domain";
import type { OrderDiscount } from "../../../shared/discounts";
import { Button } from "../../components/ui";
import { strings, type Key } from "../../i18n";
import { tenderMethodLabel } from "../../labels";
import {
  discountRemovable,
  discountRowLabel,
  fill,
  lineLabel,
  reasonLabel,
} from "./format";
import { RemoveDiscountDialog } from "./RemoveDiscountDialog";
import "./discounts.css";

/** Re-exported: the rule lives in format.ts so the dialogs share it. */
export { discountRemovable };

/** One discount: "Descuento 10 % · −$13.50 · Adulto mayor (INAPAM)" plus who and when. */
function DiscountItem({
  order,
  d,
  locale,
  money,
  removable,
  onRemove,
}: {
  order: Order;
  d: OrderDiscount;
  locale: Locale;
  money: (n: number) => string;
  removable: boolean;
  onRemove: () => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const zone = order.restaurantSnapshot?.timezone;
  const time = (v: string) =>
    new Date(v).toLocaleTimeString(locale, {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
    });
  const line =
    d.scope === "line"
      ? lineLabel(
          order.lines.find((l) => l.id === d.lineId),
          locale,
        )
      : t("discountsRowOrder");
  const label = `${discountRowLabel(d, locale)} · ${line}`;
  return (
    <li className={d.reversal ? "discount-item reversed" : "discount-item"}>
      <div className="row between">
        <span>{d.reversal ? <s>{label}</s> : label}</span>
        <strong>
          {d.reversal ? <s>−{money(d.amount)}</s> : `−${money(d.activeAmount)}`}
        </strong>
      </div>
      <small className="muted">
        {reasonLabel("discount", d.reasonCode, locale)}
        {d.note && ` · ${d.note}`}
        <br />
        {d.approverName
          ? fill(t("discountsBy"), {
              actor: d.actorName,
              approver: d.approverName,
            })
          : fill(t("discountsByWithinLimit"), { actor: d.actorName })}{" "}
        · {time(d.createdAt)}
        {d.releasedAmount > 0 && !d.reversal && (
          <>
            <br />
            {fill(t("discountsReleased"), { amount: money(d.releasedAmount) })}
          </>
        )}
        {d.reversal && (
          <>
            <br />
            {fill(t("discountsReversedBy"), {
              actor: d.reversal.byName,
              note: d.reversal.note,
            })}
          </>
        )}
      </small>
      {removable && (
        <Button variant="ghost" className="small" onClick={onRemove}>
          {t("discountsRemove")}
        </Button>
      )}
    </li>
  );
}

/**
 * Detalle de orden: "Descuentos" (with Quitar descuento) and "Reembolsos"
 * (batches with their lines, methods, terminal references, the kitchen
 * cancellation and restock). Renders nothing for an order without either.
 */
export function OrderAdjustments({
  order,
  session,
  locale,
  money,
  online,
  changed,
}: {
  order: Order;
  session: Session;
  locale: Locale;
  money: (n: number) => string;
  online: boolean;
  changed: (o: Order) => void | Promise<void>;
}) {
  const t = (k: Key) => strings[locale][k];
  const [removing, setRemoving] = useState<OrderDiscount | null>(null);
  const discounts = order.discounts ?? [];
  const batches = order.refundBatches ?? [];
  return (
    <>
      {discounts.length > 0 && (
        <section className="order-adjustments">
          <h3>{t("discountsSection")}</h3>
          <ul className="plain-list">
            {discounts.map((d) => (
              <DiscountItem
                key={d.id}
                order={order}
                d={d}
                locale={locale}
                money={money}
                removable={online && discountRemovable(order, d)}
                onRemove={() => setRemoving(d)}
              />
            ))}
          </ul>
        </section>
      )}
      {batches.length > 0 && (
        <section className="order-adjustments">
          <h3>{t("discountsRefundsSection")}</h3>
          <ul className="plain-list">
            {batches.map((b) => (
              <li key={b.id}>
                <div className="row between">
                  <span>
                    {b.legacy
                      ? t("discountsRefundLegacy")
                      : t(
                          b.mode === "items"
                            ? "discountsRefundModeItems"
                            : "discountsRefundModeAmount",
                        )}{" "}
                    · {reasonLabel("refund", b.reasonCode, locale)}
                  </span>
                  <strong>−{money(b.amount)}</strong>
                </div>
                <small className="muted">
                  {b.lines.map((l) => {
                    const line = order.lines.find((x) => x.id === l.lineId);
                    return (
                      <span key={l.id} className="block">
                        {fill(t("discountsRefundUnits"), {
                          n: l.units.length,
                          name: lineLabel(line, locale),
                        })}{" "}
                        · {money(l.amount)}
                        {l.kitchenPending &&
                          ` · ${t("discountsRefundKitchenPending")}`}
                        {l.restocked && ` · ${t("discountsRefundRestocked")}`}
                      </span>
                    );
                  })}
                  {b.rows.map((r) => (
                    <span key={r.refundId} className="block">
                      {tenderMethodLabel(r.method, undefined, locale)} ·{" "}
                      {money(r.amount)}
                      {r.reference &&
                        ` · ${fill(t("discountsSlipTerminalRef"), { ref: r.reference })}`}
                    </span>
                  ))}
                  {b.note && <span className="block">{b.note}</span>}
                  <span className="block">
                    {fill(t("discountsRefundBy"), {
                      actor: b.actorName,
                      approver: b.approverName,
                    })}
                  </span>
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {removing && (
        <RemoveDiscountDialog
          order={order}
          discount={removing}
          session={session}
          locale={locale}
          money={money}
          close={() => setRemoving(null)}
          removed={changed}
          refreshed={changed}
        />
      )}
    </>
  );
}

/**
 * Vender's existing-check block: the active discounts in compact rows, with
 * "Quitar descuento" while removable. A cached (offline) copy shows only its
 * total discount, read-only.
 */
export function CheckDiscountSummary({
  order,
  session,
  locale,
  money,
  online,
  changed,
}: {
  order: Order;
  session: Session;
  locale: Locale;
  money: (n: number) => string;
  online: boolean;
  changed: (o: Order) => void | Promise<void>;
}) {
  const t = (k: Key) => strings[locale][k];
  const [removing, setRemoving] = useState<OrderDiscount | null>(null);
  const active = (order.discounts ?? []).filter(
    (d) => !d.reversal && d.activeAmount > 0,
  );
  // The dialog stays mounted (same tree position) while open, even when a
  // refresh leaves no active discount to list (DSC-R2).
  const dialog = removing && (
    <RemoveDiscountDialog
      order={order}
      discount={removing}
      session={session}
      locale={locale}
      money={money}
      close={() => setRemoving(null)}
      removed={changed}
      refreshed={changed}
    />
  );
  let rows: ReactNode = null;
  if (!order.discounts) {
    if (order.discount)
      rows = (
        <p className="check-discounts tiny">
          {t("discountsCachedRow")} · −{money(order.discount)}
        </p>
      );
  } else if (active.length)
    rows = (
      <div className="check-discounts" aria-label={t("discountsCheckSummary")}>
        {active.map((d) => {
          const line =
            d.scope === "line"
              ? lineLabel(
                  order.lines.find((l) => l.id === d.lineId),
                  locale,
                )
              : t("discountsRowOrder");
          return (
            <div className="row between tiny" key={d.id}>
              <span>
                {discountRowLabel(d, locale)} · {line}
              </span>
              <span className="row">
                −{money(d.activeAmount)}
                {online && discountRemovable(order, d) && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setRemoving(d)}
                  >
                    {t("discountsRemove")}
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    );
  return (
    <>
      {rows}
      {dialog}
    </>
  );
}
