// COMPAT SHIM S3 (public ordering Phase A, LD-P2). cfdi (030) exports
// selfInvoiceOffered from server/cfdi/store.ts with exactly this signature
// (available && enabled && ready && self_invoice_enabled, at most 2
// statements). B2 switches the import and deletes this file; it never reaches
// integration/v1.
import type { Tx } from "../db.js";

/** No self-invoicing before 030: always false, 0 statements. */
export async function selfInvoiceOffered(_tx: Tx): Promise<boolean> {
  return false;
}
