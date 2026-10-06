/**
 * cfdi advisory keys (docs/ARCHITECTURE.md global lock order LO-3, row 29): per-ticket keys, then
 * per-document keys, never the reverse; the per-(mode, period) key of the global builder is taken
 * alone or after a document key (cfdi_reissue), never before one. Shared by the web (invoice
 * requests, cancellations, substitutions) and the worker (cfdi_global's builder, cfdi_reissue's
 * cancel-and-replace transitions), so a late invoice request and the reissue of the global that
 * holds its ticket serialize on the SAME document key (review CFDI-R1), and a reissue's replacement
 * part and the builder's parts on the same period key (CFDI-R2-5).
 *
 * Each key has its own non-zero class (926 ticket, 927 document, 928 period), so the lock-order
 * ratchet (tests/lock-scan.ts) reads them as LO-3 area keys; a class-0 key is an LO-1 operation
 * key there (CFDI-R2-3; public uses 924/925 the same way, LD-24). Imports only the db type: loaded
 * by both processes.
 */
import type { Tx } from "../db.js";

/** Takes the per-ticket advisory key (LO-3, class 926). */
export async function lockTicket(
  tx: Tx,
  tenantId: string,
  ticketId: string,
): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${tenantId + ":cfdi-ticket:" + ticketId}, 926))`;
}

/** Takes a document's advisory key (LO-3, class 927, after any ticket key). */
export async function lockDocument(
  tx: Tx,
  tenantId: string,
  documentId: string,
): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${tenantId + ":cfdi-doc:" + documentId}, 927))`;
}

/**
 * Takes a global period's advisory key (LO-3, class 928): the builder's parts and a reissue's
 * replacement part number the period's documents under it. Never followed by a ticket or document
 * key.
 */
export async function lockPeriod(
  tx: Tx,
  tenantId: string,
  mode: string,
  periodKey: string,
): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${tenantId + ":cfdi-global:" + mode + ":" + periodKey}, 928))`;
}
