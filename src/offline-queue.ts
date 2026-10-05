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
import type { Session } from "../shared/domain";
import { api, ApiError } from "./api";
import { getConnectivitySnapshot, useConnectivity } from "./connectivity";
import { db, scope, type Pending } from "./offline";
import {
  classifySyncError,
  RESOLVED_RETENTION_MS,
  retryDelay,
} from "./offline-policy";

export type SyncOptions = {
  force?: boolean;
  reason?: "poll" | "reconnect" | "manual";
};

/** Synced and archived rows are resolved: they never block close or updates. */
export function isResolved(row: Pick<Pending, "status">): boolean {
  return row.status === "synced" || row.status === "archived";
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
      const rows = (await db.pending.where("scope").equals(scope(s)).toArray())
        .filter((row) => !isResolved(row))
        .sort((a, b) => order(a) - order(b));
      for (const row of rows) {
        const now = Date.now();
        if (row.status === "conflict" && !force) continue;
        if (row.nextAt > now && !force && reason !== "reconnect") continue;
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
              if (kind === "network" || kind === "timeout") return finish(s);
              break;
            case "auth":
              await db.pending.update(row.id, {
                status: "pending",
                error: code,
                waitReason: "auth",
              });
              return finish(s);
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
      }
      await finish(s);
    },
  );
}

async function finish(s: Session) {
  const now = Date.now();
  // Legacy synced rows have no syncedAt; start their retention clock now.
  await db.pending
    .where("scope")
    .equals(scope(s))
    .filter((row) => row.status === "synced" && !row.syncedAt)
    .modify({ syncedAt: now });
  await pruneResolved(now);
  await pruneScopedCache(s, now);
}

/** Deletes rows resolved more than 7 days ago. Unresolved rows are never pruned. */
export async function pruneResolved(now = Date.now()): Promise<number> {
  return db.pending
    .filter((row) => {
      if (row.status === "synced")
        return !!row.syncedAt && now - row.syncedAt > RESOLVED_RETENTION_MS;
      if (row.status === "archived")
        return !!row.archivedAt && now - row.archivedAt > RESOLVED_RETENTION_MS;
      return false;
    })
    .delete();
}

const TWO_DAYS = 2 * 86_400_000;
async function pruneScopedCache(s: Session, now: number) {
  const prefix = scope(s) + ":ticket:";
  const sequencePrefix = `${s.tenantId}:${s.deviceId}:offline-seq:`;
  await db.cache
    .filter((row) => {
      if (row.id.startsWith(prefix))
        return now - Number(row.value?.updatedAt ?? 0) > TWO_DAYS;
      if (row.id.startsWith(sequencePrefix)) {
        const day = Date.parse(row.id.slice(sequencePrefix.length));
        return Number.isFinite(day) && now - day > TWO_DAYS + 86_400_000;
      }
      return false;
    })
    .delete();
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
