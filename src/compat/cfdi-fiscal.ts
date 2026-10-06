/**
 * COMPAT SHIM (cfdi track only; deleted at the fiscal rebase, never merged as is).
 *
 * Fiscal 027 adds `Order.fiscal` (OrderFiscal, via service's getOrders) and, in
 * src/features/fiscal/FiscalReceipt.tsx, `setFiscalFooterExtra(slot)`: the extension point where
 * cfdi registers its printed ticket block (spec cfdi-rebase S32). Neither exists on this branch.
 * At the rebase:
 *   1. `orderTicket(order)` becomes `order.fiscal?.ticket ?? null` and `orderHasFiscal(order)`
 *      becomes `!!order.fiscal` at their call sites;
 *   2. `setFiscalFooterExtra` is imported from "../features/fiscal/FiscalReceipt" instead;
 *   3. this file is deleted.
 */
import type { Order } from "../../shared/domain";
import type { FiscalTicketView } from "../../shared/fiscal";
import type { ReceiptSlot } from "../features/Receipt";

/** The order's fiscal ticket (fiscal 027 `Order.fiscal.ticket`), or null. */
export function orderTicket(order: Order): FiscalTicketView | null {
  return (
    (order as Order & { fiscal?: { ticket?: FiscalTicketView | null } }).fiscal
      ?.ticket ?? null
  );
}

/** The order carries fiscal 027's view (with or without a ticket). False on this branch. */
export function orderHasFiscal(order: Order): boolean {
  return !!(order as Order & { fiscal?: unknown }).fiscal;
}

let extra: ReceiptSlot | null = null;
/** Fiscal's footer extension point; without fiscal's footer nothing renders it. */
export function setFiscalFooterExtra(slot: ReceiptSlot | null): void {
  extra = slot;
}
export function fiscalFooterExtra(): ReceiptSlot | null {
  return extra;
}
