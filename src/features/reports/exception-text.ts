import type { Label, Locale } from "../../../shared/domain";
import type { AuditRow, ExceptionRow } from "../../../shared/reports";
import { strings, type Key } from "../../i18n";
import { reasonLabel } from "../discounts/format";
import { platformLabel } from "../../../shared/payments";
import { differenceLabel, fill, pct } from "./format";

/**
 * The label of a discount or refund reason code: discounts' own labels by (kind, code)
 * (wave2-cross-track C18: "quality" reads "Producto con defecto" for a discount and "Producto
 * con defecto o queja" for a refund; an unknown code reads "Otro"), never the raw code.
 */
export { reasonLabel };

/** Empleado of an exception row: the actor, or "Cuenta de {mesero}" for an open-price line. */
export function exceptionEmployee(row: ExceptionRow, locale: Locale): string {
  return (
    row.actorName ??
    (row.accountName
      ? fill(strings[locale].reportsExAccountOf, { name: row.accountName })
      : "")
  );
}

/** Autorizó of an exception row; a discount without an approver was within the staff limit. */
export function exceptionApprover(row: ExceptionRow, locale: Locale): string {
  return (
    row.approverName ??
    (row.kind === "discount" ? strings[locale].reportsExWithinLimit : "")
  );
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
        // payments (037): the platform part of a refund, when there is one.
        num(d.platform) ? `${t.payRefundPlatform} ${m(num(d.platform))}` : "",
        d.mode === "items"
          ? t.reportsRefundModeItems
          : d.mode === "amount"
            ? t.reportsRefundModeAmount
            : t.reportsRefundModeLegacy,
        d.restock === true ? t.reportsExStockReturned : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "terminal_difference":
      // REPORTS-UI-4: the signed amount alone reads like a loss; the word says which.
      // payments (037): a batch total typed per terminal names its terminal.
      return d.terminalId !== undefined
        ? `${typeof d.terminal === "string" && d.terminal ? d.terminal : t.payOtherTerminal} · ${differenceLabel(row.amount, locale)}`
        : differenceLabel(row.amount, locale);
    case "drawer_difference":
      return [
        differenceLabel(row.amount, locale),
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
    case "platform_tender": {
      // LD-75: which platform (an «Otra» shows its typed name), why it is listed, the order's
      // price list and the platform's order number.
      const why =
        row.reasonCode === "payments_platform_rule_skipped"
          ? t.payExPlatformRuleSkipped
          : row.reasonCode === "payments_platform_other"
            ? t.payExPlatformOther
            : t.payExPlatformNoPriceList;
      const list =
        typeof d.priceList === "string"
          ? fill(t.payExPlatformPriceList, {
              list: platformLabel(d.priceList, null, locale),
            })
          : t.payExPlatformCounterPrices;
      return [
        platformLabel(
          typeof d.platform === "string" ? d.platform : null,
          typeof d.label === "string" ? d.label : null,
          locale,
        ),
        why,
        list,
        typeof d.reference === "string" && d.reference ? "#" + d.reference : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
    default:
      return "";
  }
}

/**
 * Motivo of an activity row: a discount's or refund's reason code with discounts' label, then
 * the free text. A code of any other operation is not shown (never a raw code).
 */
export function auditReason(row: AuditRow, locale: Locale): string {
  const code = row.summary.reasonCode;
  const kind = row.operation.startsWith("discount.")
    ? "discount"
    : row.operation.startsWith("refund")
      ? "refund"
      : null;
  return [
    code && kind ? reasonLabel(kind, code, locale) : null,
    row.summary.reason?.trim(),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Referencia of an activity row: #order, or the entity id shortened to 8 characters. */
export function auditReference(row: AuditRow): string {
  return row.orderNumber !== null
    ? "#" + row.orderNumber
    : row.entityId.slice(0, 8);
}
