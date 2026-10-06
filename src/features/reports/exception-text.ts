import type { Label, Locale } from "../../../shared/domain";
import type { AuditRow, ExceptionRow } from "../../../shared/reports";
import { strings, type Key } from "../../i18n";
import { fill, pct } from "./format";

/**
 * The label of a discount or refund reason code. Discounts (028) exports the discount-reason and
 * refund-reason label maps (wave2-cross-track C18: "quality" reads "Producto con defecto" for a
 * discount and "Producto con defecto o queja" for a refund); reports' merge returns them here.
 * Until then a coded reason shows no label, never the raw code.
 */
export function reasonLabel(
  _kind: "discount" | "refund",
  _code: string,
  _locale: Locale,
): string | null {
  return null;
}

const PREPARATION: Record<string, Key> = {
  not_started: "reportsKitchenNotStarted",
  active: "serviceKitchenPreparing",
  ready: "serviceKitchenReady",
  completed: "serviceKitchenServed",
};
const label = (v: unknown, locale: Locale) =>
  v && typeof v === "object" && locale in v ? String((v as Label)[locale]) : "";
const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** Motivo: the reason code's label and the free-text note. */
export function exceptionReason(row: ExceptionRow, locale: Locale): string {
  const coded =
    row.reasonCode && (row.kind === "discount" || row.kind === "refund")
      ? reasonLabel(row.kind, row.reasonCode, locale)
      : null;
  return [coded, row.note.trim()].filter(Boolean).join(" · ");
}

/** Detalle of an exception row (spec §2.7), in the UI language, never a raw code. */
export function exceptionDetail(
  row: ExceptionRow,
  locale: Locale,
  m: (n: number) => string,
): string {
  const t = strings[locale];
  const d = row.detail;
  switch (row.kind) {
    case "void": {
      const state = PREPARATION[String(d.preparationState)];
      return [
        `${num(d.units)} × ${label(d.name, locale)}`,
        state ? fill(t.reportsExKitchenState, { state: t[state] }) : "",
        d.stockDisposition === "returned"
          ? t.reportsExStockReturned
          : t.reportsExStockNotReturned,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "discount": {
      const kind =
        d.discountKind === "percent"
          ? fill(t.reportsDiscountPercent, {
              pct: pct(num(d.percentBps), locale),
            })
          : d.discountKind === "comp"
            ? t.reportsDiscountComp
            : t.reportsDiscountFixed;
      const scope =
        d.scope === "line" && label(d.lineName, locale)
          ? label(d.lineName, locale)
          : d.scope === "line"
            ? t.reportsDiscountOnItem
            : t.reportsDiscountOnCheck;
      return [kind, scope, d.reversed === true ? t.reportsExReversed : ""]
        .filter(Boolean)
        .join(" · ");
    }
    case "discount_reversal":
      return d.discountKind === "comp" ? t.reportsDiscountComp : "";
    case "refund":
      return [
        fill(t.reportsRefundsSplit, {
          cash: m(num(d.cash)),
          external: m(num(d.external)),
        }),
        d.mode === "items"
          ? t.reportsRefundModeItems
          : d.mode === "amount"
            ? t.reportsRefundModeAmount
            : t.reportsRefundModeLegacy,
        d.restock === true ? t.reportsExStockReturned : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "drawer_difference":
      return [
        d.countMode === "blind"
          ? t.reportsDocCountBlind
          : d.countMode === "visible"
            ? t.reportsDocCountVisible
            : "",
        typeof d.reviewNote === "string" && d.reviewNote
          ? `${t.reportsColReview}: ${d.reviewNote}`
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "corte_reprint":
      return fill(t.reportsExCorteReprintDetail, {
        z: num(d.zNumber),
        n: num(d.printNumber),
      });
    case "open_price":
      return fill(t.reportsExOpenPriceDetail, {
        n: num(d.quantity),
        name: label(d.name, locale),
        amount: m(num(d.unitPrice)),
      });
    case "offline_reconcile":
      return d.path === "offline.payment_reconciled"
        ? t.reportsOfflinePaymentReconciled
        : t.reportsOfflineSaleRecovered;
    default:
      return "";
  }
}

/** Referencia of an activity row: #order, or the entity id shortened to 8 characters. */
export function auditReference(row: AuditRow): string {
  return row.orderNumber !== null
    ? "#" + row.orderNumber
    : row.entityId.slice(0, 8);
}
