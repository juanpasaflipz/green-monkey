/**
 * Offline sync loop (OFF-6/OFF-12). Every queued record is sent to
 * /api/offline/sync, whose server-side idempotency key is the record's
 * operationId, so a retry after a lost response can never apply it twice.
 * Transient failures retry forever with capped backoff; only explicit domain
 * codes become conflicts, and a human can resolve every conflict (reconcile or
 * archive). Nothing is deleted until it has been resolved for 7 days.
 */
import { liveQuery } from "dexie";
import { useEffect, useState } from "react";
import type { Order, Session } from "../shared/domain";
import { api, ApiError } from "./api";
import { getConnectivitySnapshot, useConnectivity } from "./connectivity";
import { db, type Pending } from "./offline";
import { scope } from "./offline-keys";
import {
  assertNoUnsyncedRecords,
  OfflineSaveError,
  rememberSyncedOrder,
  SYNC_TO_CHARGE_CODES,
} from "./offline-records";
import {
  classifySyncError,
  RESOLVED_RETENTION_MS,
  retryDelay,
} from "./offline-policy";

export type SyncOptions = {
  force?: boolean;
  reason?: "poll" | "reconnect" | "manual";
};

/**
 * Synced and archived rows are resolved: they never block close or updates. A
 * row once archived stays resolved even if a tab still running a pre-026
 * revision rewrote its status (it treats anything but "synced" as unsynced).
 */
export function isResolved(
  row: Pick<Pending, "status"> & { archivedAt?: number },
): boolean {
  return (
    row.status === "synced" || row.status === "archived" || !!row.archivedAt
  );
}

/** The local order a round or payment waits for, if any (invariant I5). */
export function dependencyOf(body: Pending["body"]): string | null {
  return "target" in body && "localOrderOperationId" in body.target
    ? body.target.localOrderOperationId
    : null;
}

const order = (row: Pending) =>
  (row.body as { sequence?: number }).sequence ??
  Date.parse(row.body.recordedAt);

/**
 * The orders a record writes to, as keys shared by every record of the same
 * order: its own local order ("local:"), the local order it targets, and the
 * server order behind either once known ("server:"). A sale opens a new order
 * of its own, so it shares nothing.
 */
export function orderKeys(
  row: Pending,
  rowsById: Map<string, Pending>,
): string[] {
  const body = row.body as {
    kind?: string;
    operationId: string;
    target?: { orderId?: string; localOrderOperationId?: string };
  };
  if (body.kind === "order") return [`local:${body.operationId}`];
  const target = body.target;
  if (!target) return [];
  if (target.orderId) return [`server:${target.orderId}`];
  if (!target.localOrderOperationId) return [];
  const keys = [`local:${target.localOrderOperationId}`];
  const parent = rowsById.get(target.localOrderOperationId);
  const orderId = (parent?.result as { orderId?: string } | null | undefined)
    ?.orderId;
  if (parent?.status === "synced" && orderId) keys.push(`server:${orderId}`);
  return keys;
}

/**
 * Before an online charge: refuses while this device has an unresolved
 * offline payment (OFF-R5) or round (OFF-R26) for the same order, so the guest
 * is never charged twice and never leaves without paying the items saved
 * offline. The refusal syncs this employee's records now, without waiting for
 * the retry backoff (a conflict is retried too; it stays for a manager if the
 * server refuses it again).
 */
export async function guardOnlineCharge(
  s: Session,
  order: Order | null,
): Promise<void> {
  try {
    await assertNoUnsyncedRecords(s, order);
  } catch (e) {
    if (
      e instanceof OfflineSaveError &&
      SYNC_TO_CHARGE_CODES.includes(e.message)
    )
      void syncPending(s, { force: true, reason: "manual" }).catch(() => {});
    throw e;
  }
}

/**
 * Sends every due record in this session's scope, oldest first. Accepts the
 * legacy boolean `force` argument used by older callers.
 */
export async function syncPending(
  s: Session,
  options: SyncOptions | boolean = {},
): Promise<void> {
  const opts = typeof options === "boolean" ? { force: options } : options;
  return navigator.locks.request(
    "green-monkey-session-transition",
    { mode: "shared" },
    () => syncScoped(s, opts),
  );
}

async function syncScoped(
  s: Session,
  { force = false, reason = "poll" }: SyncOptions,
) {
  return navigator.locks.request(
    "green-monkey-sync:" + scope(s),
    { ifAvailable: !force },
    async (lock) => {
      if (!lock) return;
      const stored = await db.pending.where("scope").equals(scope(s)).toArray();
      // OFF-R7: put back archived rows an older tab marked pending or conflict.
      for (const row of stored)
        if (row.archivedAt && row.status !== "archived")
          await db.pending.update(row.id, { status: "archived" });
      const rows = stored
        .filter((row) => !isResolved(row))
        .sort((a, b) => order(a) - order(b));
      const byId = new Map(stored.map((row) => [row.id, row]));
      // I10: orders with an earlier record still waiting on a transient answer.
      // A later record of the same order (a payment that includes a round's
      // amount) is never sent ahead of it, or the server would refuse it as a
      // conflict that only the order of arrival caused.
      const held = new Set<string>();
      const hold = (row: Pending) => {
        for (const key of orderKeys(row, byId)) held.add(key);
      };
      for (const row of rows) {
        const now = Date.now();
        if (row.status === "conflict" && !force) continue;
        if (orderKeys(row, byId).some((key) => held.has(key))) {
          // Waiting behind an earlier record of its order is not an attempt.
          hold(row);
          continue;
        }
        if (row.nextAt > now && !force && reason !== "reconnect") {
          hold(row);
          continue;
        }
        const dependency = dependencyOf(row.body);
        if (dependency) {
          const parent = await db.pending.get(dependency);
          if (parent && !isResolved(parent)) {
            // Waiting for a queued parent is not an attempt.
            if (row.waitReason !== "dependency" || row.status !== "pending")
              await db.pending.update(row.id, {
                status: "pending",
                waitReason: "dependency",
              });
            hold(row);
            continue;
          }
        }
        const reachable = getConnectivitySnapshot().serverReachable;
        await db.pending.update(row.id, {
          status: "syncing",
          lastAttemptAt: now,
        });
        let result: unknown;
        try {
          result = await api("/offline/sync", row.body, {
            idempotent: true,
            timeoutMs: 20_000,
          });
        } catch (e) {
          const code = (e as Error).message;
          const kind = e instanceof ApiError ? e.kind : "network";
          switch (classifySyncError(code, kind)) {
            case "transient":
              await db.pending.update(row.id, {
                status: "pending",
                error: code,
                waitReason: undefined,
                // Attempts count only while the server looked reachable.
                attempts: reachable ? row.attempts + 1 : row.attempts,
                nextAt: Date.now() + retryDelay(row.attempts),
              });
              hold(row);
              if (kind === "network" || kind === "timeout")
                return finish(s, reason);
              break;
            case "auth":
              await db.pending.update(row.id, {
                status: "pending",
                error: code,
                waitReason: "auth",
              });
              return finish(s, reason);
            case "archived":
              await db.pending.update(row.id, {
                status: "archived",
                archivedAt: Date.now(),
                error: code,
                waitReason: undefined,
              });
              break;
            case "synced":
              await db.pending.update(row.id, {
                status: "synced",
                result: null,
                syncedAt: Date.now(),
                error: undefined,
                waitReason: undefined,
              });
              break;
            case "conflict":
              await db.pending.update(row.id, {
                status: "conflict",
                error: code,
                waitReason: undefined,
              });
          }
          continue;
        }
        // Only the request is guarded: if this local write failed, the row stays
        // "syncing" and the next pass replays the same operationId (idempotent).
        await db.pending.update(row.id, {
          status: "synced",
          result,
          syncedAt: Date.now(),
          error: undefined,
          waitReason: undefined,
          nextAt: 0,
        });
        byId.set(row.id, { ...row, status: "synced", result });
        // OFF-R12: the server order a table record produced is the freshest
        // copy there is; from now on the order is served only through it.
        await rememberSyncedOrder(s, row, result).catch(() => {});
      }
      await finish(s, reason);
    },
  );
}

/**
 * Marks a row the server says it already applied (archive answered
 * offline_already_synced). Replaying the same record returns the stored result
 * (same idempotency key), so offline balances can tell exactly which tender or
 * round it was; if that fails the row is still resolved, without a result.
 */
export async function settleAlreadySynced(row: Pending): Promise<void> {
  const result = await api("/offline/sync", row.body, {
    idempotent: true,
    timeoutMs: 20_000,
  }).catch(() => null);
  await db.pending.update(row.id, {
    status: "synced",
    syncedAt: Date.now(),
    result,
    error: undefined,
    waitReason: undefined,
  });
}

/** Background passes prune at most this often; reconnect and manual passes always do. */
export const PRUNE_EVERY_MS = 3_600_000;
const prunedAt = new Map<string, number>();

/**
 * Retention after a pass (OFF-12), without storage churn on cheap tablets
 * (OFF-R11): the 10 s background passes prune at most once an hour, and
 * pruning walks indexes and keys only, so it never reads the cached catalog
 * or open-orders values.
 */
async function finish(s: Session, reason: SyncOptions["reason"] = "poll") {
  const now = Date.now();
  const key = scope(s);
  if (reason === "poll" && now - (prunedAt.get(key) ?? 0) < PRUNE_EVERY_MS)
    return;
  prunedAt.set(key, now);
  // Legacy synced rows have no syncedAt; start their retention clock now.
  await db.pending
    .where("status")
    .equals("synced")
    .filter((row) => row.scope === key && !row.syncedAt)
    .modify({ syncedAt: now });
  await pruneResolved(now);
  await pruneScopedCache(s, now);
}

/** Deletes rows resolved more than 7 days ago. Unresolved rows are never pruned. */
export async function pruneResolved(now = Date.now()): Promise<number> {
  return db.pending
    .where("status")
    .anyOf(["synced", "archived"])
    .filter((row) => {
      if (row.status === "synced")
        return !!row.syncedAt && now - row.syncedAt > RESOLVED_RETENTION_MS;
      return !!row.archivedAt && now - row.archivedAt > RESOLVED_RETENTION_MS;
    })
    .delete();
}

const DAY = 86_400_000;
async function pruneScopedCache(s: Session, now: number) {
  // Ticket status chips are small values; only their own key range is read.
  await db.cache
    .where("id")
    .startsWith(scope(s) + ":ticket:")
    .filter((row) => now - Number(row.value?.updatedAt ?? 0) > 2 * DAY)
    .delete();
  // Provisional-number counters carry their business day in the key.
  const sequencePrefix = `${s.tenantId}:${s.deviceId}:offline-seq:`;
  const stale = (
    await db.cache.where("id").startsWith(sequencePrefix).primaryKeys()
  ).filter((id) => {
    const day = Date.parse(String(id).slice(sequencePrefix.length));
    return Number.isFinite(day) && now - day > 3 * DAY;
  });
  if (stale.length) await db.cache.bulkDelete(stale);
}

/** Unresolved records for this employee on this device ("self") or for the whole device. */
export async function unsyncedCount(
  s: Session,
  scopeMode: "self" | "device" = "self",
): Promise<number> {
  const devicePrefix = `${s.tenantId}:${s.deviceId}:`;
  return db.pending
    .filter(
      (row) =>
        (scopeMode === "self"
          ? row.scope === scope(s)
          : row.scope.startsWith(devicePrefix)) && !isResolved(row),
    )
    .count();
}

/**
 * Live count of unresolved rows (Dexie liveQuery, no polling of local storage)
 * plus background sync: immediately when the server becomes reachable, then
 * every 10 s while it stays reachable, including in manual offline mode.
 */
export function useOfflineQueue(session: Session | null): {
  queued: number;
  oldestUnresolvedAt: number | null;
} {
  const [state, setState] = useState<{
    queued: number;
    oldestUnresolvedAt: number | null;
  }>({ queued: 0, oldestUnresolvedAt: null });
  const key = session ? scope(session) : null;
  useEffect(() => {
    if (!key) {
      setState({ queued: 0, oldestUnresolvedAt: null });
      return;
    }
    const subscription = liveQuery(async () => {
      const open = (
        await db.pending.where("scope").equals(key).toArray()
      ).filter((row) => !isResolved(row));
      return {
        queued: open.length,
        oldestUnresolvedAt: open.length
          ? Math.min(...open.map((row) => Date.parse(row.body.recordedAt)))
          : null,
      };
    }).subscribe({ next: setState, error: () => {} });
    return () => subscription.unsubscribe();
  }, [key]);
  const { serverReachable } = useConnectivity();
  useEffect(() => {
    if (!session || !serverReachable) return;
    const run = (reason: SyncOptions["reason"]) =>
      void syncPending(session, { reason }).catch(() => {});
    run("reconnect");
    const timer = setInterval(() => run("poll"), 10_000);
    return () => clearInterval(timer);
  }, [session, serverReachable]);
  return state;
}
