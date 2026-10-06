import type { Locale, Order, PricedLine } from "../../../shared/domain";
import { lineRemaining } from "../../../shared/settlement";
import { formatPercentBps } from "../../../shared/discounts";
import { strings } from "../../i18n";
import { discountRowLabel, fill, reasonLabel } from "./format";
import "./discounts.css";

/**
 * Discount and refund rows that make a receipt, pre-bill or order detail add
 * up once a check has discounts: the lines print their gross after voids and
 * the Total prints orders.total (net). Pure renders in the locale they are
 * given (customer copies are printed in Spanish by the print call sites). They
 * render nothing for an order without discounts or item refunds.
 */
type Money = (n: number) => string;

/** Line-level discounts under one line: "Descuento 10 % (1 de 3) −$4.50". */
export function LineDiscountRows({
  order,
  line,
  locale,
  money,
}: {
  order: Order;
  line: PricedLine;
  locale: Locale;
  money: Money;
}) {
  const t = strings[locale];
  const rows = (order.discounts ?? []).filter(
    (d) => d.scope === "line" && d.lineId === line.id && d.activeAmount > 0,
  );
  if (!rows.length) return null;
  const quantity = lineRemaining(line).quantity;
  return (
    <>
      {rows.map((d) => {
        const units = d.allocations.filter(
          (a) => a.lineId === line.id && !a.voided,
        ).length;
        return (
          <div className="row between doc-discount muted" key={d.id}>
            <span>
              {discountRowLabel(d, locale)}
              {units < quantity &&
                " " + fill(t.discountsRowUnits, { n: units, q: quantity })}
            </span>
            <span>−{money(d.activeAmount)}</span>
          </div>
        );
      })}
    </>
  );
}

/**
 * Before the Total: the subtotal before discounts, the line discounts already
 * shown under their lines, and the check discount ("Descuento en la cuenta ·
 * Adulto mayor (INAPAM) 10 %"). A cached (offline) copy has only the total
 * discount and shows one row.
 */
export function OrderDiscountRows({
  order,
  locale,
  money,
}: {
  order: Order;
  locale: Locale;
  money: Money;
}) {
  const t = strings[locale];
  const discount = order.discount ?? 0;
  if (discount <= 0) return null;
  const active = (order.discounts ?? []).filter((d) => d.activeAmount > 0);
  const lineTotal = active
    .filter((d) => d.scope === "line")
    .reduce((n, d) => n + d.activeAmount, 0);
  const check = active.filter((d) => d.scope === "order");
  return (
    <div className="doc-discounts">
      <div className="row between">
        <span>{t.discountsSubtotal}</span>
        <span>{money(order.total + discount)}</span>
      </div>
      {!order.discounts ? (
        <div className="row between">
          <span>{t.discountsReceiptDiscounts}</span>
          <span>−{money(discount)}</span>
        </div>
      ) : (
        <>
          {lineTotal > 0 && (
            <div className="row between">
              <span>{t.discountsReceiptDiscounts}</span>
              <span>−{money(lineTotal)}</span>
            </div>
          )}
          {check.map((d) => (
            <div className="row between" key={d.id}>
              <span>
                {d.kind === "comp"
                  ? `${t.discountsRowOrder} · ${t.discountsRowComp}`
                  : `${t.discountsRowOrder} · ${reasonLabel("discount", d.reasonCode, locale)}${
                      d.kind === "percent" && d.percentBps
                        ? " " + formatPercentBps(d.percentBps, locale)
                        : ""
                    }`}
              </span>
              <span>−{money(d.activeAmount)}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/** After "Reembolso −X": what each item refund returned, and terminal references. */
export function RefundDetailRows({
  order,
  locale,
  money,
}: {
  order: Order;
  locale: Locale;
  money: Money;
}) {
  const t = strings[locale];
  const batches = (order.refundBatches ?? []).filter((b) => !b.legacy);
  if (!batches.length) return null;
  return (
    <div className="doc-refunds muted">
      {batches.flatMap((b) => [
        ...b.lines.map((l) => {
          const line = order.lines.find((x) => x.id === l.lineId);
          return (
            <div className="row between" key={l.id}>
              <span>
                {fill(t.discountsRefundUnits, {
                  n: l.units.length,
                  name: line?.name[locale] ?? "",
                })}
              </span>
              <span>−{money(l.amount)}</span>
            </div>
          );
        }),
        ...b.rows
          .filter((r) => r.method === "external" && r.reference)
          .map((r) => (
            <div className="row between" key={r.refundId}>
              <span>
                {fill(t.discountsSlipTerminalRef, { ref: r.reference! })}
              </span>
              <span>−{money(r.amount)}</span>
            </div>
          )),
      ])}
    </div>
  );
}
