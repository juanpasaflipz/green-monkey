import type { Locale } from "../../../shared/domain";
import {
  formatPercentBps,
  type DiscountReason,
  type OrderDiscount,
  type RefundReason,
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
};
/** Refund reason labels (see DISCOUNT_REASON_LABELS). */
export const REFUND_REASON_LABELS: Record<RefundReason, Key> = {
  customer_cancelled: "discountsRefundReasonCustomerCancelled",
  quality: "discountsRefundReasonQuality",
  wrong_item: "discountsRefundReasonWrongItem",
  long_wait: "discountsRefundReasonLongWait",
  charge_error: "discountsRefundReasonChargeError",
  duplicate_terminal_charge: "discountsRefundReasonDuplicateTerminal",
  other: "discountsRefundReasonOther",
};

/** A stored reason code in the given language; an unknown code reads "Otro". */
export function reasonLabel(
  kind: "discount" | "refund",
  code: string,
  locale: Locale,
): string {
  const map: Record<string, Key> =
    kind === "discount" ? DISCOUNT_REASON_LABELS : REFUND_REASON_LABELS;
  return strings[locale][
    Object.hasOwn(map, code)
      ? map[code]
      : kind === "discount"
        ? "discountsReasonOther"
        : "discountsRefundReasonOther"
  ];
}

/** "Descuento 10 %", "Descuento" or "Cortesía". */
export function discountRowLabel(
  d: Pick<OrderDiscount, "kind" | "percentBps">,
  locale: Locale,
): string {
  const t = strings[locale];
  if (d.kind === "comp") return t.discountsRowComp;
  if (d.kind === "percent" && d.percentBps)
    return fill(t.discountsRowPercent, {
      percent: formatPercentBps(d.percentBps, locale),
    });
  return t.discountsRowAmount;
}
