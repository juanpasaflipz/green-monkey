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
  /**
   * The worker's /healthz as the web sees it. `commit` is the worker's build (the CD smoke
   * requires the deployed SHA, PLATFORM-OPS-2) and `jobs` whether its jobs runner is on
   * (PLATFORM-OPS-4); both null when it did not answer.
   */
  worker: {
    status: "ok" | "stale" | "unknown";
    lastBeatAt: string | null;
    commit: string | null;
    jobs: boolean | null;
  };
  /** Not fully healthy: db, schema or worker, or (deployed) a worker without jobs. */
  degraded: boolean;
}

const CACHE_MS = 10_000;
const COMMIT = /^(?:[0-9a-f]{7,40}|local)$/;

/**
 * Probes the worker's /healthz over Railway private networking (WORKER_URL).
 * "unknown" when no worker URL is configured, "stale" when it does not answer
 * healthy within 2 s. Passes the worker's commit and jobs flag through
 * (validated, never echoed raw).
 */
export async function workerStatus(
  workerUrl: string | null,
  doFetch: typeof fetch = fetch,
): Promise<OpsStatus["worker"]> {
  const none = { lastBeatAt: null, commit: null, jobs: null };
  if (!workerUrl) return { status: "unknown", ...none };
  try {
    const response = await doFetch(`${workerUrl}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: unknown;
      lastTickAt?: unknown;
      commit?: unknown;
      jobs?: unknown;
    } | null;
    const lastBeatAt =
      typeof body?.lastTickAt === "string" &&
      !Number.isNaN(Date.parse(body.lastTickAt))
        ? new Date(body.lastTickAt).toISOString()
        : null;
    return {
      status: response.ok && body?.ok === true ? "ok" : "stale",
      lastBeatAt,
      commit:
        typeof body?.commit === "string" && COMMIT.test(body.commit)
          ? body.commit
          : null,
      jobs: typeof body?.jobs === "boolean" ? body.jobs : null,
    };
  } catch {
    return { status: "stale", ...none };
  }
}

/** APP_ENV staging or production (server/config-rules.ts "deployed"), read at call time. */
export function deployedEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const appEnv = env.APP_ENV?.trim().toLowerCase();
  return appEnv === "staging" || appEnv === "production";
}

/**
 * Computes the public, tenant-free status document (/api/ops/status). `requireJobs`
 * (default: deployed) counts a worker whose jobs runner is off as degraded, so the hourly
 * uptime check alerts (PLATFORM-OPS-4).
 */
export async function computeStatus(
  sql: postgres.Sql,
  o: {
    workerUrl?: string | null;
    fetch?: typeof fetch;
    requireJobs?: boolean;
  } = {},
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
  const requireJobs = o.requireJobs ?? deployedEnv();
  return {
    ok,
    version,
    commit,
    db,
    schema,
    worker: w,
    degraded: !ok || w.status !== "ok" || (requireJobs && w.jobs !== true),
  };
}

let cached: { at: number; value: Promise<OpsStatus> } | null = null;

/** 10 s cache so the public endpoint cannot be used to load the database. */
export function opsStatus(
  sql: postgres.Sql,
  o: {
    workerUrl?: string | null;
    fetch?: typeof fetch;
    requireJobs?: boolean;
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
