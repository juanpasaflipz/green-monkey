import { businessDate, type Locale } from "../shared/domain";
import { serverNow } from "./clock";
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
  // access (023), added at service's merge (contracts 3.13)
  "access.device_paired": "accessOpDevicePaired",
  "access.device_renamed": "accessOpDeviceRenamed",
  "access.device_revoked": "accessOpDeviceRevoked",
  "access.device_session_ended": "accessOpDeviceSessionEnded",
  "access.pairing_code_created": "accessOpPairingCodeCreated",
  "access.pairing_code_cancelled": "accessOpPairingCodeCancelled",
  "access.employee_created": "accessOpEmployeeCreated",
  "access.employee_updated": "accessOpEmployeeUpdated",
  "access.employee_deactivated": "accessOpEmployeeDeactivated",
  "access.employee_reactivated": "accessOpEmployeeReactivated",
  "access.employee_pin_reset": "accessOpEmployeePinReset",
  "access.employee_unlocked": "accessOpEmployeeUnlocked",
  // menu (025), added at menu's merge (contracts 3.13)
  "menu.category.saved": "menuOpCategorySaved",
  "menu.category.reordered": "menuOpCategoryReordered",
  "menu.category.archived": "menuOpCategoryArchived",
  "menu.product.saved": "menuOpProductSaved",
  "menu.product.reordered": "menuOpProductReordered",
  "menu.product.archived": "menuOpProductArchived",
  "menu.product.availability": "menuOpProductAvailability",
  "menu.group.saved": "menuOpGroupSaved",
  "menu.group.archived": "menuOpGroupArchived",
  "menu.option.availability": "menuOpOptionAvailability",
  "floor.area.saved": "menuOpAreaSaved",
  "floor.area.reordered": "menuOpAreaReordered",
  "floor.area.archived": "menuOpAreaArchived",
  "floor.table.saved": "menuOpTableSaved",
  "floor.table.bulk": "menuOpTablesBulk",
  "floor.table.reordered": "menuOpTableReordered",
  "floor.table.archived": "menuOpTableArchived",
  "stock.item.saved": "menuOpStockItemSaved",
  "stock.item.archived": "menuOpStockItemArchived",
  "stock.policy.changed": "menuOpStockPolicyChanged",
  // offline (026), added at offline's merge (contracts 3.13)
  "offline.synced": "offlineOpSynced",
  "offline.kitchen_decision": "offlineOpKitchenDecision",
  "offline.archived": "offlineOpArchived",
  "offline.payment_reconciled": "offlineOpPaymentReconciled",
  "offline.settings_changed": "offlineOpSettingsChanged",
  "offline.payment_attempt_recorded": "offlineOpAttemptRecorded",
  "offline.payment_attempt_discarded": "offlineOpAttemptDiscarded",
  "job.requeued": "opsOpJobRequeued",
  "job.cancelled": "opsOpJobCancelled",
  // fiscal (027)
  "fiscal.ticket.issued": "fiscalOpTicketIssued",
  "fiscal.profile.saved": "fiscalOpProfileSaved",
  "fiscal.tickets.repaired": "fiscalOpTicketsRepaired",
  "fiscal.ticket.unallocated_discount": "fiscalOpUnallocatedDiscount",
  // discounts (028)
  "discount.applied": "discountsOpApplied",
  "discount.reversed": "discountsOpReversed",
  "discount.controls.saved": "discountsOpControlsSaved",
  "cash.reviewed": "discountsOpDrawerReviewed",
  // reports (029)
  "reports.corte_x.printed": "reportsOpCorteXPrinted",
  "reports.corte_z.printed": "reportsOpCorteZPrinted",
  "reports.corte_z.reprinted": "reportsOpCorteZReprinted",
  "reports.count_slip.printed": "reportsOpCountSlipPrinted",
  "reports.day_corte.printed": "reportsOpDayCortePrinted",
  // cfdi (030)
  "cfdi.activated": "cfdiOpActivated",
  "cfdi.settings.saved": "cfdiOpSettingsSaved",
  "cfdi.csd.uploaded": "cfdiOpCsdUploaded",
  "cfdi.live.requested": "cfdiOpLiveRequested",
  "cfdi.invoice.requested": "cfdiOpInvoiceRequested",
  "cfdi.cancel.requested": "cfdiOpCancelRequested",
  "cfdi.substitute.requested": "cfdiOpSubstituteRequested",
  "cfdi.globals.run": "cfdiOpGlobalsRun",
  "cfdi.document.retried": "cfdiOpRetried",
  "cfdi.email.requested": "cfdiOpEmailRequested",
  // account (031), added at account's merge (contracts 3.13)
  "account.owner_seat": "accountOpOwnerSeat",
  "account.owner_seat_revoked": "accountOpOwnerSeatRevoked",
  "account.co_owner_added": "accountOpCoOwnerAdded",
  "account.ownership_transferred": "accountOpOwnershipTransferred",
  "account.data_export": "accountOpDataExport",
  "account.restaurant_privacy": "accountOpRestaurantPrivacy",
  "account.free_selection_mode": "accountOpFreeSelectionMode",
  "plan.free_slot_auto": "accountOpFreeSlotAuto",
  // public (032)
  "public.link_created": "publicOpLinkCreated",
  "public.link_rotated": "publicOpLinkRotated",
  "public.link_revoked": "publicOpLinkRevoked",
  "public.settings_saved": "publicOpSettings",
  "public.paused": "publicOpPaused",
  "public.resumed": "publicOpResumed",
  "public.hold_accepted": "publicOpHoldAccepted",
  "public.hold_rejected": "publicOpHoldRejected",
  // payments (037)
  "payment.terminal_saved": "payOpTerminalSaved",
  "payment.terminal_archived": "payOpTerminalArchived",
  "payment.platforms_saved": "payOpPlatformsSaved",
  "payment.platform_prices_saved": "payOpPlatformPricesSaved",
  "payment.device_terminal_set": "payOpDeviceTerminalSet",
};
const stockCauses: Record<string, Key> = {
  sale: "serviceStockSale",
  void: "serviceStockVoid",
  receipt: "serviceStockReceipt",
  waste: "serviceStockWaste",
  count_adjust: "serviceStockCount",
  prep_input: "serviceStockPrepInput",
  prep_output: "serviceStockPrepOutput",
  // discounts (028)
  refund: "discountsStockCauseRefund",
};
const channels: Record<string, Key> = {
  pos: "serviceChannelPos",
  qr: "serviceChannelQr",
  kiosk: "serviceChannelKiosk",
  offline: "serviceChannelOffline",
};
const tenderMethods: Record<string, Key> = {
  cash: "serviceIntegrationCash",
  external: "serviceIntegrationExternal",
  // payments (037): "Pagado por plataforma"; tenderLabel names the platform.
  platform: "payMethodPlatform",
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
  // Unknown methods (a future integrated tender) never print as cash.
  return strings[locale][tenderMethods[method] ?? "serviceTenderOther"];
}
export function channelLabel(channel: string, locale: Locale): string {
  return strings[locale][channels[channel] ?? "serviceChannelPos"];
}
export function integrationLabel(key: string, locale: Locale): string {
  return strings[locale][integrations[key] ?? "serviceIntegrationOther"];
}

// ---- business-day labels (LD-29) -----------------------------------------

/** "5 oct" / "Oct 5": a business date (YYYY-MM-DD) as day and short month, no timezone shift. */
export function businessDayLabel(date: string, locale: Locale): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale === "es" ? "es-MX" : "en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * The restaurant's current business date with the server's own helper and settings
 * (shared/domain businessDate: the restaurant timezone and cutoff), for screens whose
 * response does not carry it. "Now" is the corrected server clock (src/clock.ts, the one
 * offline evidence uses), so a tablet whose clock is a few minutes off still agrees with
 * Órdenes and the kitchen (whose date comes from the server) around the cutoff.
 */
export function currentBusinessDate(
  restaurant: { timezone: string; cutoff: number },
  now: number = serverNow(),
): string {
  return businessDate(
    new Date(now).toISOString(),
    restaurant.timezone,
    restaurant.cutoff,
  );
}

/** U+00A0: joins a dated label so it never wraps apart (LD-48, POLISH-UX-2). */
const NBSP = "\u00a0";

/**
 * `text` as staff read it: unchanged, or followed by " · 5 oct" (" · Oct 5") when `day` is
 * another business day than `today`. The date is joined with non-breaking spaces, so a
 * narrow header (the KDS ticket at iPad portrait widths) never splits "5" from "oct"
 * or the date from the number.
 */
export function withBusinessDay(
  text: string,
  day: string | null | undefined,
  today: string | null | undefined,
  locale: Locale,
): string {
  return day && today && day !== today
    ? `${text}${NBSP}·${NBSP}${businessDayLabel(day, locale).replace(/\s/g, NBSP)}`
    : text;
}

/**
 * An order number as staff read it: "10", or "10 · 5 oct" ("10 · Oct 5") when the order
 * belongs to another business day than `today` (withBusinessDay: non-breaking spaces).
 * Numbers restart every business day, so after the cutoff an open order from the day
 * before and a new one can both be #10.
 */
export function orderNumberText(
  order: { number: number; businessDate?: string | null },
  today: string | null | undefined,
  locale: Locale,
): string {
  return withBusinessDay(
    String(order.number),
    order.businessDate,
    today,
    locale,
  );
}

/** "#10", or "#10 · 5 oct" for an order from another business day (orderNumberText). */
export function orderNumberLabel(
  order: { number: number; businessDate?: string | null },
  today: string | null | undefined,
  locale: Locale,
): string {
  return "#" + orderNumberText(order, today, locale);
}
