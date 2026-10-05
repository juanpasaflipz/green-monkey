import type { Locale } from "../shared/domain";
import { strings, type Key } from "./i18n";

/**
 * Operator-facing labels for codes stored in the database. Views must never
 * print raw codes: other areas add their operations here, and anything
 * unknown falls back to a neutral label.
 */
const operations: Record<string, Key> = {
  "order.created": "serviceOpOrderCreated",
  "order.round": "serviceOpOrderRound",
  "order.void": "serviceOpOrderVoid",
  "order.note": "serviceOpOrderNote",
  "payment.recorded": "serviceOpPayment",
  "refund.recorded": "serviceOpRefund",
  "settlement.recorded": "serviceOpSettlement",
  "service.assigned": "serviceOpAssigned",
  "kitchen.seen": "serviceOpKitchenSeen",
  "kitchen.ready": "serviceOpKitchenReady",
  "kitchen.completed": "serviceOpKitchenCompleted",
  "kitchen.void_ack": "serviceOpKitchenVoidAck",
  "kitchen.recall": "serviceOpKitchenRecall",
  "kitchen.cleared": "serviceOpKitchenCleared",
  "check.closed": "serviceOpCheckClosed",
  "receipt.printed": "serviceOpReceiptPrinted",
  "receipt.reprinted": "serviceOpReceiptReprinted",
  "check.printed": "serviceOpCheckPrinted",
  "cash.open": "serviceOpCashOpen",
  "cash.close": "serviceOpCashClose",
  "cash.paidout": "serviceOpCashPaidout",
  "stock.receipt": "serviceOpStockReceipt",
  "stock.waste": "serviceOpStockWaste",
  "stock.count_adjust": "serviceOpStockCount",
  "stock.received": "serviceOpStockReceived",
  prep: "serviceOpPrep",
  expense: "serviceOpExpense",
  "shift.start": "serviceOpShiftStart",
  "shift.end": "serviceOpShiftEnd",
  "offline.reconciled": "serviceOpOfflineReconciled",
  "offline.kitchen_reviewed": "serviceOpOfflineKitchen",
  "offline.stock_reviewed": "serviceOpOfflineStock",
  "catalog.saved": "serviceOpCatalogSaved",
  "employee.saved": "serviceOpEmployeeSaved",
  "import.catalog": "serviceOpImport",
  "restaurant.settings": "serviceOpSettings",
  "restaurant.location_created": "serviceOpLocationCreated",
  "invitation.accepted": "serviceOpInvitationAccepted",
  "plan.free_location": "serviceOpFreeLocation",
  "plan.free_selection": "serviceOpFreeSelection",
  "restaurant.signup": "serviceOpSignup",
};
const stockCauses: Record<string, Key> = {
  sale: "serviceStockSale",
  void: "serviceStockVoid",
  receipt: "serviceStockReceipt",
  waste: "serviceStockWaste",
  count_adjust: "serviceStockCount",
  prep_input: "serviceStockPrepInput",
  prep_output: "serviceStockPrepOutput",
};
const channels: Record<string, Key> = {
  pos: "serviceChannelPos",
  qr: "serviceChannelQr",
  kiosk: "serviceChannelKiosk",
  offline: "serviceChannelOffline",
};
const integrations: Record<string, Key> = {
  cash: "serviceIntegrationCash",
  external: "serviceIntegrationExternal",
  clip: "serviceIntegrationClip",
  stripe: "serviceIntegrationStripe",
  facturapi: "serviceIntegrationFacturapi",
  printer: "serviceIntegrationPrinter",
  resend: "serviceIntegrationResend",
};

/** Operations known to the label map (used by the CI coverage test). */
export const labelledOperations = Object.keys(operations);

export function operationLabel(op: string, locale: Locale): string {
  return strings[locale][operations[op] ?? "serviceOpOther"];
}
export function stockCauseLabel(cause: string, locale: Locale): string {
  return strings[locale][stockCauses[cause] ?? "serviceStockOther"];
}
export function tenderMethodLabel(
  method: string,
  source: string | undefined,
  locale: Locale,
): string {
  if (source === "offline_recovery")
    return strings[locale].serviceTenderRecovered;
  return strings[locale][
    method === "external"
      ? "serviceIntegrationExternal"
      : "serviceIntegrationCash"
  ];
}
export function channelLabel(channel: string, locale: Locale): string {
  return strings[locale][channels[channel] ?? "serviceChannelPos"];
}
export function integrationLabel(key: string, locale: Locale): string {
  return strings[locale][integrations[key] ?? "serviceIntegrationOther"];
}
