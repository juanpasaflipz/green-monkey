// COMPAT SHIM S2 (public ordering Phase A, LD-P2/LD-P3). Fiscal (027) exports
// fiscalTicketIdentity from server/fiscal-read.ts with exactly this signature
// (one statement on fiscal_tickets by order_id, folio via formatFolio). B1
// switches the imports and deletes this file; it never reaches integration/v1.
import type { Tx } from "../db.js";

export type FiscalTicketIdentity = { folio: string; selfInvoiceCode: string };

/** No fiscal tickets exist before 027: always null, 0 statements. */
export async function fiscalTicketIdentity(
  _tx: Tx,
  _orderId: string,
): Promise<FiscalTicketIdentity | null> {
  return null;
}
