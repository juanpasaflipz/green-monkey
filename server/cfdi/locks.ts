/**
 * cfdi advisory keys (docs/ARCHITECTURE.md global lock order LO-3, row 29): a per-ticket key, then a
 * per-document key, never the reverse. Shared by the web (invoice requests, cancellations,
 * substitutions) and the worker (cfdi_reissue's cancel-and-replace transitions), so a late invoice
 * request and the reissue of the global that holds its ticket serialize on the SAME document key
 * (review CFDI-R1). Imports only the db type: loaded by both processes.
 */
import type { Tx } from "../db.js";

/** Takes the per-ticket advisory key (LO-3). */
export async function lockTicket(
  tx: Tx,
  tenantId: string,
  ticketId: string,
): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${tenantId + ":cfdi-ticket:" + ticketId}, 0))`;
}

/** Takes a document's advisory key (LO-3, after any ticket key). */
export async function lockDocument(
  tx: Tx,
  tenantId: string,
  documentId: string,
): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${tenantId + ":cfdi-doc:" + documentId}, 0))`;
}
