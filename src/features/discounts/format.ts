import type { Label, Locale, Order } from "../../../shared/domain";
import {
  formatPercentBps,
  type DiscountReason,
  type OrderDiscount,
  type RefundReason,
  RESERVED_DISCOUNT_REASON,
} from "../../../shared/discounts";
import { strings, type Key } from "../../i18n";

/** Fills "{name}" placeholders; unknown placeholders stay as written. */
export function fill(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : all,
  );
}

/**
 * A count with its singular form (DSC-R14): `one` when n is 1 ("1 pieza sin
 * cobrar"), otherwise `many` filled with {n} ("2 piezas sin cobrar").
 */
export function countText(
  t: (k: Key) => string,
  many: Key,
  one: Key,
  n: number,
): string {
  return n === 1 ? t(one) : fill(t(many), { n });
}

/**
 * Discount reason labels. Reports (029) looks labels up by (kind, code): the
 * code `quality` reads "Producto con defecto" for a discount and "Producto con
 * defecto o queja" for a refund; `other` is shared (C18).
 */
export const DISCOUNT_REASON_LABELS: Record<DiscountReason, Key> = {
  courtesy: "discountsReasonCourtesy",
  complaint: "discountsReasonComplaint",
  quality: "discountsReasonQuality",
  staff_meal: "discountsReasonStaffMeal",
  senior_inapam: "discountsReasonSeniorInapam",
  promotion: "discountsReasonPromotion",
  regular_customer: "discountsReasonRegularCustomer",
  other: "discountsReasonOther",
  // loyalty (038 §2.6): recorded by "Canjear premio" only; prints "Recompensa del club".
  loyalty_reward: "discountsReasonLoyaltyReward",
};
/** Refund reason labels (see DISCOUNT_REASON_LABELS). */
export const REFUND_REASON_LABELS: Record<RefundReason, Key> = {
  customer_cancelled: "discountsRefundReasonCustomerCancelled",
  quality: "discountsRefundReasonQuality",
  wrong_item: "discountsRefundReasonWrongItem",
  long_wait: "discountsRefundReasonLongWait",
  charge_error: "discountsRefundReasonChargeError",
  other: "discountsRefundReasonOther",
};

/**
 * A stored reason code as printed and listed (receipts, the refund slip,
 * Detalle de orden, reports): "Otro" for `other` and for an unknown code. The
 * option text "Otro (explica en la nota)" is an instruction and stays in the
 * dialogs' selects only (UI-8).
 */
export function reasonLabel(
  kind: "discount" | "refund",
  code: string,
  locale: Locale,
): string {
  const map: Record<string, Key> =
    kind === "discount" ? DISCOUNT_REASON_LABELS : REFUND_REASON_LABELS;
  return strings[locale][
    code !== "other" && Object.hasOwn(map, code)
      ? map[code]
      : "discountsReasonOtherShort"
  ];
}

/** "Descuento 10 %", "Descuento" or "Cortesía". */
export function discountRowLabel(
  d: Pick<OrderDiscount, "kind" | "percentBps"> & { reasonCode?: string },
  locale: Locale,
): string {
  const t = strings[locale];
  // loyalty (038 §2.6): a club reward reads "Recompensa del club", never "Cortesía".
  if (d.reasonCode === RESERVED_DISCOUNT_REASON)
    return t[DISCOUNT_REASON_LABELS.loyalty_reward];
  if (d.kind === "comp") return t.discountsRowComp;
  if (d.kind === "percent" && d.percentBps)
    return fill(t.discountsRowPercent, {
      percent: formatPercentBps(d.percentBps, locale),
    });
  return t.discountsRowAmount;
}

/**
 * A line's name with its option names, "Taco (con queso, 2× salsa)": two lines
 * of one product can differ only by options (rebase I-08), so every place that
 * names a line in a discount or refund uses this.
 */
export function lineLabel(
  line: { name: Label; optionNames?: Label[] } | undefined,
  locale: Locale,
): string {
  if (!line) return "";
  const options = (line.optionNames ?? []).map((o) => o[locale]).join(", ");
  return line.name[locale] + (options ? ` (${options})` : "");
}

/**
 * Whether "Quitar descuento" is offered: the check is not closed and has no
 * fiscal ticket (FISCAL-2: a ticketed check's discounts are final, the server
 * answers fiscal_ticket_issued), the discount is active, none of its
 * non-voided units is paid and no later active discount covers one of them
 * (the server re-checks all of it: discount_not_reversible). Voided units no
 * longer matter on either side (DSC-R6). A check discount whose units were all
 * voided (active 0) can still be removed, which frees the check's single
 * check-discount slot (MONEY-4); a line discount at 0 has nothing to remove.
 */
export function discountRemovable(order: Order, d: OrderDiscount): boolean {
  if (order.checkState === "closed" || order.fiscal?.ticket || d.reversal)
    return false;
  if (d.activeAmount <= 0 && d.scope !== "order") return false;
  const units = new Set(
    d.allocations.filter((a) => !a.voided).map((a) => `${a.lineId}:${a.unit}`),
  );
  if (
    (order.paymentUnits ?? []).some(
      (u) => units.has(`${u.lineId}:${u.unit}`) && u.paid > 0,
    )
  )
    return false;
  const later = (order.discounts ?? []).filter(
    (x) =>
      x.id !== d.id &&
      !x.reversal &&
      (x.createdAt > d.createdAt ||
        (x.createdAt === d.createdAt && x.id > d.id)),
  );
  return !later.some((x) =>
    x.allocations.some((a) => !a.voided && units.has(`${a.lineId}:${a.unit}`)),
  );
}

/**
 * The discount "Quitar descuento" acts on (DSC-R10): the one the screen chose
 * until the dialog reloads the check; after a reload, that discount as the
 * fresh check shows it (with its current amount), or null once it can no
 * longer be removed. Object identity cannot tell whether a reload happened:
 * Vender hands the reloaded order straight back as the dialog's `order` prop.
 */
export function removableAfterReload(
  order: Order,
  chosen: OrderDiscount,
  reloaded: boolean,
): OrderDiscount | null {
  if (!reloaded) return chosen;
  const d = (order.discounts ?? []).find((x) => x.id === chosen.id);
  return d && discountRemovable(order, d) ? d : null;
}
