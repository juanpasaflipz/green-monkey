/**
 * Backup v3 of unresolved local evidence: every v1/v2/v3 record plus active and
 * parked payment attempts. Exported per tenant; no session is required, so a
 * device that cannot sign in can still hand its records to a manager.
 */
import {
  normalizePaymentAttempt,
  type PaymentAttempt,
} from "../shared/offline-recovery";
import { db, isAttemptKey, type Pending } from "./offline";

export type BackupV3 = {
  format: "green-monkey-recovery-v3";
  tenantId: string;
  exportedAt: string;
  records: { id: string; scope: string; body: Pending["body"]; receipt?: Pending["receipt"] }[];
  paymentAttempts: { key: string; attempt: PaymentAttempt }[];
};

const unresolved = (row: Pending) =>
  row.status !== "synced" && row.status !== "archived";

/** Builds backups for every tenant with unresolved evidence on this device. */
export async function buildBackups(
  filter: { tenantId?: string; include?: (row: Pending) => boolean; attempt?: (a: PaymentAttempt) => boolean } = {},
): Promise<BackupV3[]> {
  const rows = (await db.pending.toArray()).filter(
    (row) =>
      unresolved(row) &&
      (!filter.tenantId || row.scope.startsWith(filter.tenantId + ":")) &&
      (filter.include?.(row) ?? true),
  );
  const attempts = (await db.cache.filter((row) => isAttemptKey(row.id)).toArray())
    .map((row) => ({ key: row.id, attempt: normalizePaymentAttempt(row.value, row.id) }))
    .filter(
      (row): row is { key: string; attempt: PaymentAttempt } =>
        row.attempt !== null &&
        (!filter.tenantId || row.attempt.tenantId === filter.tenantId) &&
        (filter.attempt?.(row.attempt) ?? true),
    );
  const tenants = new Set([
    ...rows.map((row) => row.scope.split(":")[0]!),
    ...attempts.map((row) => row.attempt.tenantId),
  ]);
  const exportedAt = new Date().toISOString();
  return [...tenants].map((tenantId) => ({
    format: "green-monkey-recovery-v3",
    tenantId,
    exportedAt,
    records: rows
      .filter((row) => row.scope.startsWith(tenantId + ":"))
      .map(({ id, scope, body, receipt }) => ({
        id,
        scope,
        body,
        ...(receipt ? { receipt } : {}),
      })),
    paymentAttempts: attempts.filter((row) => row.attempt.tenantId === tenantId),
  }));
}

const pad = (n: number) => String(n).padStart(2, "0");
export function backupFileName(tenantId: string, at = new Date()) {
  return `green-monkey-offline-${tenantId}-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}.json`;
}

export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
