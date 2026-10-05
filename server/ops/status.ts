import type postgres from "postgres";
import { buildInfo } from "../build-info.js";
import { requireReadySchema } from "../readiness.js";

/** Shared web process state: set at startup (ready) and by the SIGTERM handler (draining). */
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

const CACHE_MS = 10_000;

/**
 * Probes the worker's /healthz over Railway private networking (WORKER_URL).
 * "unknown" when no worker URL is configured, "stale" when it does not answer
 * healthy within 2 s.
 */
export async function workerStatus(
  workerUrl: string | null,
  doFetch: typeof fetch = fetch,
): Promise<OpsStatus["worker"]> {
  if (!workerUrl) return { status: "unknown", lastBeatAt: null };
  try {
    const response = await doFetch(`${workerUrl}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: unknown;
      lastTickAt?: unknown;
    } | null;
    const lastBeatAt =
      typeof body?.lastTickAt === "string" &&
      !Number.isNaN(Date.parse(body.lastTickAt))
        ? new Date(body.lastTickAt).toISOString()
        : null;
    return {
      status: response.ok && body?.ok === true ? "ok" : "stale",
      lastBeatAt,
    };
  } catch {
    return { status: "stale", lastBeatAt: null };
  }
}

/** Computes the public, tenant-free status document (/api/ops/status). */
export async function computeStatus(
  sql: postgres.Sql,
  o: { workerUrl?: string | null; fetch?: typeof fetch } = {},
): Promise<OpsStatus> {
  const { version, commit } = buildInfo();
  let db: OpsStatus["db"] = "ok";
  let schema: OpsStatus["schema"] = "not_ready";
  const worker = workerStatus(o.workerUrl ?? null, o.fetch);
  try {
    await sql`select 1`;
    try {
      await requireReadySchema(sql);
      schema = "ready";
    } catch {
      schema = "not_ready";
    }
  } catch {
    db = "down";
  }
  const ok = db === "ok" && schema === "ready";
  const w = await worker;
  return {
    ok,
    version,
    commit,
    db,
    schema,
    worker: w,
    degraded: !ok || w.status !== "ok",
  };
}

let cached: { at: number; value: Promise<OpsStatus> } | null = null;

/** 10 s cache so the public endpoint cannot be used to load the database. */
export function opsStatus(
  sql: postgres.Sql,
  o: {
    workerUrl?: string | null;
    fetch?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<OpsStatus> {
  const now = o.now ?? Date.now;
  if (cached && now() - cached.at < CACHE_MS) return cached.value;
  const value = computeStatus(sql, o);
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
