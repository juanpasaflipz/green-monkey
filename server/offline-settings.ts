/**
 * Offline table service setting (lead decision LD-7). Offline open checks,
 * rounds and partial payments ship as a per-restaurant beta, OFF by default:
 * with it off, devices sell offline only new orders paid in full (cash or a
 * recorded external terminal) with the kitchen fallback, and never fetch the
 * open-orders snapshot.
 *
 * Sync never consults this setting: a record saved while it was on is evidence
 * of a real sale and still syncs (or goes to manager review) after it is
 * turned off.
 */
import { z } from "zod";
import type { Tx } from "./db.js";
import { DomainError, id, type Session } from "../shared/domain.js";
import { permit, managers, operators } from "./auth.js";
import { audit } from "./orders.js";
import { requireRecentAuth } from "./access.js";

export type OfflineSettings = { tableService: boolean };

/** The current tenant's setting (RLS scopes the row). */
export async function offlineTableService(tx: Tx): Promise<boolean> {
  const [row] =
    await tx`select offline_table_service from restaurants where id=current_setting('app.tenant_id')::uuid`;
  return row?.offline_table_service === true;
}

export async function readOfflineSettings(
  tx: Tx,
  s: Session,
): Promise<OfflineSettings> {
  permit(s, operators);
  return { tableService: await offlineTableService(tx) };
}

const settingsInput = z
  .object({ operationId: id, tableService: z.boolean() })
  .strict();

/**
 * Owner or manager, with recent authentication. Idempotent by state: the row
 * changes, and is audited, only when the value differs. It deliberately does
 * not run inside once(): once() holds the restaurant row FOR SHARE, and
 * upgrading that to an update would deadlock two concurrent saves.
 */
export async function saveOfflineSettings(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<OfflineSettings> {
  permit(s, managers);
  requireRecentAuth(s);
  const p = settingsInput.parse(raw);
  const [before] =
    await tx`select offline_table_service from restaurants where id=${s.tenantId} for no key update`;
  if (!before) throw new DomainError("not_found", 404);
  if (before.offline_table_service !== p.tableService) {
    await tx`update restaurants set offline_table_service=${p.tableService} where id=${s.tenantId}`;
    await audit(tx, s, "offline.settings_changed", s.tenantId, {
      operationId: p.operationId,
      before: { tableService: before.offline_table_service },
      after: { tableService: p.tableService },
    });
  }
  return { tableService: p.tableService };
}

/** Routes that exist only for offline table service refuse while it is off. */
export async function requireTableService(tx: Tx): Promise<void> {
  if (!(await offlineTableService(tx)))
    throw new DomainError("offline_table_service_off", 409);
}
