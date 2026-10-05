import type postgres from "postgres";
import { buildInfo } from "../build-info.js";
import { requireReadySchema } from "../readiness.js";

/** Shared web process state: set by boot (ready) and the SIGTERM handler (draining). */
export const opsState = { ready: false, draining: false };

export interface OpsStatus {
  ok: boolean;
  version: string;
  commit: string;
  db: "ok" | "down";
  schema: "ready" | "not_ready";
  worker: { status: "ok" | "stale" | "unknown"; lastBeatAt: string | null };
  degraded: boolean;
}

export const WORKER_STALE_MS = 120_000;
const CACHE_MS = 10_000;

/** Computes the public, tenant-free status document. */
export async function computeStatus(sql: postgres.Sql): Promise<OpsStatus> {
  const { version, commit } = buildInfo();
  let db: OpsStatus["db"] = "ok";
  let schema: OpsStatus["schema"] = "not_ready";
  let worker: OpsStatus["worker"] = { status: "unknown", lastBeatAt: null };
  try {
    const [probe] = await sql`
      select to_regclass('public.ops_heartbeats') is not null as has_heartbeats, now() as now`;
    try {
      await requireReadySchema(sql, { grants: true });
      schema = "ready";
    } catch {
      schema = "not_ready";
    }
    if (probe.has_heartbeats) {
      const [beat] =
        await sql`select beat_at from ops_heartbeats where process='worker'`;
      if (beat) {
        const age =
          new Date(probe.now).getTime() - new Date(beat.beat_at).getTime();
        worker = {
          status: age > WORKER_STALE_MS ? "stale" : "ok",
          lastBeatAt: new Date(beat.beat_at).toISOString(),
        };
      }
    }
  } catch {
    db = "down";
  }
  const ok = db === "ok" && schema === "ready";
  return {
    ok,
    version,
    commit,
    db,
    schema,
    worker,
    degraded: !ok || worker.status !== "ok",
  };
}

let cached: { at: number; value: Promise<OpsStatus> } | null = null;

/** /api/ops/status with a 10 s cache so the public endpoint cannot load the DB. */
export function opsStatus(
  sql: postgres.Sql,
  now: () => number = Date.now,
): Promise<OpsStatus> {
  if (cached && now() - cached.at < CACHE_MS) return cached.value;
  const value = computeStatus(sql);
  cached = { at: now(), value };
  value.catch(() => {
    cached = null;
  });
  return value;
}

/** Test hook. */
export function resetStatusCache() {
  cached = null;
}
