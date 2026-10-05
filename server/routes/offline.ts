import type postgres from "postgres";
import { z } from "zod";
import type { PreAuthContext, RouteContext } from "../http.js";
import { id } from "../../shared/domain.js";
import {
  archiveOfflineRecord,
  listOfflineArchives,
  listOfflineRecoveries,
  listOfflineRecoveriesPage,
  reconcileOffline,
  reconcileOfflineRecord,
  resolveOfflineRecoveryTask,
  reviewOfflineRecord,
  synchronizeOffline,
  syncOfflineRecord,
} from "../offline-sync.js";
import {
  decideOfflineKitchen,
  listOfflineKitchen,
} from "../offline-kitchen.js";
import { offlineDevicePrefix } from "../offline-device.js";
import { openOrdersSnapshot } from "../offline-tables.js";

/**
 * Single-flight database reachability, cached for `ttlMs`: at most one
 * `select 1` is in flight per registration, however many devices ping.
 */
export function databaseProbe(
  sql: postgres.Sql,
  ttlMs = 2000,
  timeoutMs = 2000,
): () => Promise<boolean> {
  let cache = { at: 0, ok: false };
  let inflight: Promise<boolean> | null = null;
  return () => {
    if (cache.at && Date.now() - cache.at < ttlMs)
      return Promise.resolve(cache.ok);
    inflight ??= Promise.race([
      Promise.resolve(sql`select 1`).then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ])
      .catch(() => false)
      .then((ok) => {
        cache = { at: Date.now(), ok };
        inflight = null;
        return ok;
      });
    return inflight;
  };
}

/**
 * offline area routes that must run before authentication.
 *
 * GET /api/offline/ping is the device heartbeat (OFF-1). It needs no session,
 * reads no tenant data and is not a Railway healthcheck (/health and
 * /api/health are unchanged). It is deliberately not rate limited: devices back
 * off on their own and the database check is shared and cached.
 */
export function registerPreAuth({ app, sql }: PreAuthContext) {
  const reachable = databaseProbe(sql);
  app.get("/api/offline/ping", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    const ok = await reachable();
    const body = {
      now: Date.now(),
      build: process.env.RAILWAY_GIT_COMMIT_SHA ?? "local",
    };
    if (ok) res.json({ ok: true, ...body });
    else
      res
        .status(503)
        .json({ ok: false, error: "database_unavailable", ...body });
  });
}

const page = (query: Record<string, unknown>) => ({
  ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  ...(query.limit === undefined ? {} : { limit: query.limit }),
});

/** offline area authenticated routes; use ctx.route for tenant-scoped handlers. */
export function register({ route }: RouteContext) {
  route("post", "/offline/device", (tx, s, req) => {
    z.object({}).strict().parse(req.body);
    return offlineDevicePrefix(tx, s);
  });
  route("get", "/offline/open-orders", (tx, s) => openOrdersSnapshot(tx, s));
  route("post", "/offline/sync", (tx, s, req) =>
    syncOfflineRecord(tx, s, req.body),
  );
  route("post", "/offline/review", (tx, s, req) =>
    reviewOfflineRecord(tx, s, req.body),
  );
  route("post", "/offline/reconcile", (tx, s, req) =>
    reconcileOfflineRecord(tx, s, req.body),
  );
  route("post", "/offline/archive", (tx, s, req) =>
    archiveOfflineRecord(tx, s, req.body),
  );
  route("get", "/offline/recoveries", (tx, s, req) =>
    listOfflineRecoveriesPage(tx, s, page(req.query)),
  );
  route("get", "/offline/archives", (tx, s, req) =>
    listOfflineArchives(tx, s, page(req.query)),
  );
  route("get", "/offline/kitchen", (tx, s) => listOfflineKitchen(tx, s));
  route("post", "/offline/kitchen/:roundId/decision", (tx, s, req) =>
    decideOfflineKitchen(tx, s, id.parse(req.params.roundId), req.body),
  );
  // Legacy routes (same paths as before; older clients keep working).
  route("post", "/sync", (tx, s, req) => synchronizeOffline(tx, s, req.body));
  route("post", "/sync/review", (tx, s, req) =>
    reviewOfflineRecord(tx, s, req.body),
  );
  route("post", "/sync/reconcile", (tx, s, req) =>
    reconcileOffline(tx, s, req.body),
  );
  route("get", "/sync/recoveries", (tx, s) => listOfflineRecoveries(tx, s));
  route("post", "/sync/recoveries/resolve", (tx, s, req) =>
    resolveOfflineRecoveryTask(tx, s, req.body),
  );
}
