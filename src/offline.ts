import Dexie, { type EntityTable } from "dexie";
import type { OrderInput, Session, Product } from "../shared/domain";
import type {
  OfflineRecord,
  OfflineRecordKind,
  PaymentAttempt,
} from "../shared/offline-recovery";
import { attachClockStore, getConnectivitySnapshot } from "./connectivity";
import { activeAttemptKey, isAttemptKey, scope } from "./offline-keys";
import {
  evidenceKey,
  normalizePaymentAttempt,
} from "../shared/offline-recovery";
export type Draft = {
  id: string;
  scope: string;
  order: OrderInput;
  updatedAt: number;
};
export type Pending = {
  id: string;
  scope: string;
  /** Immutable once written: the record the server applies exactly once. */
  body: OfflineRecord;
  receipt?: { lines: unknown[]; restaurant: Session["restaurant"] };
  status: "pending" | "syncing" | "conflict" | "synced" | "archived";
  attempts: number;
  nextAt: number;
  error?: string;
  result?: any;
  kind?: OfflineRecordKind;
  sequence?: number;
  syncedAt?: number;
  archivedAt?: number;
  lastAttemptAt?: number;
  waitReason?: "auth" | "dependency";
  /** Local display context of a cached server order (never sent). */
  context?: {
    orderNumber?: number;
    mode?: string;
    tableName?: string | null;
    name?: string;
    /** The round number the record's kitchen ticket shows until it syncs. */
    round?: number;
  };
};
export type CachedValue =
  { id: string; value: unknown } | { id: string; value: PaymentAttempt };
const db = new Dexie("green-monkey-v1") as Dexie & {
  drafts: EntityTable<Draft, "id">;
  pending: EntityTable<Pending, "id">;
  cache: EntityTable<{ id: string; value: any }, "id">;
};
// No schema version bump: new fields live in existing stores, so old tabs are
// never closed by a versionchange.
db.version(1).stores({
  drafts: "id,scope,updatedAt",
  pending: "id,scope,status",
  cache: "id",
});
attachClockStore(db.cache);
export { db };
export {
  scope,
  activeAttemptKey,
  parkedAttemptKey,
  isAttemptKey,
} from "./offline-keys";
export { syncPending, isResolved, unsyncedCount } from "./offline-queue";

export async function clearPaymentAttempt(key: string, evidence: unknown) {
  await db.transaction("rw", db.cache, async () => {
    const current = await db.cache.get(key);
    if (
      current &&
      evidenceKey(normalizePaymentAttempt(current.value, key)) ===
        evidenceKey(normalizePaymentAttempt(evidence, key))
    )
      await db.cache.delete(key);
  });
}

/**
 * Moves an unresolved attempt from the active slot to its own key, in one
 * transaction and only if the slot still holds this exact evidence. The
 * attempt is never overwritten or dropped (invariant I9).
 */
export async function parkPaymentAttempt(activeKey: string, evidence: unknown) {
  await db.transaction("rw", db.cache, async () => {
    const current = await db.cache.get(activeKey);
    const attempt = normalizePaymentAttempt(evidence, activeKey);
    if (
      !current ||
      !attempt ||
      evidenceKey(normalizePaymentAttempt(current.value, activeKey)) !==
        evidenceKey(attempt)
    )
      return;
    const parked = `${activeKey}:${attempt.payload.operationId}`;
    const existing = await db.cache.get(parked);
    if (
      existing &&
      evidenceKey(normalizePaymentAttempt(existing.value, parked)) !==
        evidenceKey(attempt)
    )
      throw Error("operation_conflict");
    await db.cache.put({ id: parked, value: attempt });
    await db.cache.delete(activeKey);
  });
}

/** Active or parked attempts recorded for one server order in this scope. */
export async function attemptsForOrder(
  s: Session,
  orderId: string,
): Promise<{ key: string; attempt: PaymentAttempt }[]> {
  const prefix = activeAttemptKey(s);
  return (
    await db.cache
      .filter((row) => row.id === prefix || row.id.startsWith(prefix + ":"))
      .toArray()
  )
    .map((row) => ({
      key: row.id,
      attempt: normalizePaymentAttempt(
        row.value,
        row.id.split(":").slice(0, 4).join(":"),
      ),
    }))
    .filter(
      (row): row is { key: string; attempt: PaymentAttempt } =>
        row.attempt?.orderId === orderId,
    );
}

export async function cacheSession(s: Session, catalog: Product[]) {
  await db.cache.put({ id: "session", value: s });
  await db.cache.put({ id: scope(s) + ":catalog", value: catalog });
}

/** Caches a renewed session without touching the offline catalog (access, D15). */
export async function cacheSessionOnly(s: Session) {
  await db.cache.put({ id: "session", value: s });
}

export async function changeRestaurant<T>(
  tenantId: string,
  command: () => Promise<T>,
) {
  if (!getConnectivitySnapshot().canUseServer)
    throw Error("switch_requires_connection");
  return navigator.locks.request(
    "green-monkey-session-transition",
    async () => {
      const pending = await db.pending.toArray();
      const attempts = await db.cache.toArray();
      if (
        pending.some(
          (p) =>
            p.status !== "synced" &&
            p.status !== "archived" &&
            !p.scope.startsWith(tenantId + ":"),
        ) ||
        attempts.some(
          (a) => isAttemptKey(a.id) && !a.id.startsWith(tenantId + ":"),
        )
      )
        throw Error("pending_before_switch");
      const result = await command();
      await db.cache.delete("session");
      localStorage.setItem("gm-session-generation", crypto.randomUUID());
      return result;
    },
  );
}
