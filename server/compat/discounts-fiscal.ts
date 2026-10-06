/**
 * Discounts (028) compat shim for fiscal 027 (lead extension of wave rule 0.6,
 * specs/wave2-cross-track.md §2). It exports exactly the signatures discounts
 * consumes from fiscal while fiscal's server code is not on this branch:
 * no-op ticket guard and refund tax hook, and a local RefundTaxScope.
 *
 * At discounts' merge (after fiscal) the integrator switches the imports to
 * ../fiscal.js (RefundTaxScope to ../../shared/fiscal.js), makes the
 * server/fiscal.ts edits of the spec (§4.6) and deletes this file. No compat
 * file of discounts' reaches integration/v1.
 */
import type { Tx } from "../db.js";
import type { Session } from "../../shared/domain.js";

/** Fiscal's binding refund scope (fiscal §4.3–§4.4): gross is used verbatim. */
export type RefundTaxScope = { lineId: string; units: number[]; gross: number };

/** Fiscal: refuses a discount once the check has a fiscal ticket (no-op here). */
export async function assertNoFiscalTicket(
  _tx: Tx,
  _orderId: string,
): Promise<void> {}

/** Fiscal: records the refund's IVA adjustment (no-op here). */
export async function recordRefundTax(
  _tx: Tx,
  _s: Session,
  _refundId: string,
  _scope?: RefundTaxScope[],
): Promise<unknown> {
  return null;
}
