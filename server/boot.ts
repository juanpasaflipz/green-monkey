import type http from "node:http";
import type postgres from "postgres";
import { setTimeout as delay } from "node:timers/promises";
import { checkRole } from "./db.js";
import { log } from "./log.js";
import { requireReadySchema } from "./readiness.js";
import { DomainError } from "../shared/domain.js";

const TRANSIENT_CODES = new Set([
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now (compute starting)
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

/** Connectivity failures worth waiting out (same classes the API maps to database_unavailable). */
export function isTransientDbError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; errors?: unknown };
  const code = typeof e?.code === "string" ? e.code : "";
  if (TRANSIENT_CODES.has(code) || /^08/.test(code)) return true;
  // Node reports multi-address connect failures as an AggregateError.
  if (Array.isArray(e?.errors) && e.errors.some(isTransientDbError)) return true;
  const message = typeof e?.message === "string" ? e.message : "";
  return /compute (node|is starting)|endpoint is (starting|waking)|terminating connection due to administrator command/i.test(
    message,
  );
}

const codeOf = (error: unknown) => {
  if (error instanceof DomainError) return error.code;
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : "unknown";
};

/** 1 s · 2^attempt, capped at 30 s, ±20% jitter. */
export function bootBackoffMs(attempt: number, rand: () => number = Math.random) {
  return Math.round(Math.min(1000 * 2 ** attempt, 30_000) * (0.8 + 0.4 * rand()));
}

/**
 * Starts serving without the database (OPS-11): retries the role and schema
 * checks with backoff while the database is unreachable or the schema/grants
 * are not ready, calls onReady once both pass, and exits on misconfiguration
 * (role assertions, auth failures) so the deploy fails loudly.
 */
export async function bootDatabase(
  sql: postgres.Sql,
  o: {
    kind: "web" | "worker";
    check?: (sql: postgres.Sql) => Promise<void>;
    onReady: () => void;
    sleep?: (ms: number) => Promise<unknown>;
    exit?: (code: number) => void;
    rand?: () => number;
  },
): Promise<void> {
  const started = Date.now();
  const sleep = o.sleep ?? ((ms: number) => delay(ms));
  const exit = o.exit ?? ((code: number) => process.exit(code));
  for (let attempt = 0; ; attempt++) {
    try {
      await (o.check ?? checkRole)(sql);
      await requireReadySchema(sql, { grants: o.kind === "web" });
      o.onReady();
      log.info("boot_ready", {
        attempts: attempt + 1,
        ms: Date.now() - started,
      });
      return;
    } catch (error) {
      const retryable =
        isTransientDbError(error) ||
        (error instanceof DomainError && error.code === "schema_not_ready");
      if (!retryable) {
        log.error("boot_fatal", { code: codeOf(error) }, error);
        exit(1);
        return;
      }
      log.warn("boot_waiting_for_database", {
        attempt: attempt + 1,
        code: codeOf(error),
      });
      await sleep(bootBackoffMs(attempt, o.rand));
    }
  }
}

/**
 * Graceful shutdown on SIGTERM/SIGINT (OPS-6): mark draining (readiness turns
 * 503 and responses carry Connection: close), stop accepting, close idle
 * keep-alive sockets, wait for in-flight requests, run close(), exit 0.
 * Forces exit 1 at drainSeconds - 2 so Railway's SIGKILL never lands first.
 */
export function drainOnSignal(
  server: http.Server | null,
  state: { draining: boolean },
  close: () => Promise<void>,
  o: {
    drainSeconds?: number;
    exit?: (code: number) => void;
    signals?: NodeJS.Signals[];
    emitter?: NodeJS.EventEmitter;
  } = {},
) {
  const drainSeconds = o.drainSeconds ?? 20;
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const emitter = o.emitter ?? process;
  let started = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (started) return;
    started = true;
    state.draining = true;
    log.info("shutdown_draining", { signal, drainSeconds });
    const force = setTimeout(
      () => {
        log.error("shutdown_forced", { drainSeconds });
        exit(1);
      },
      Math.max(1, drainSeconds - 2) * 1000,
    );
    force.unref();
    const finish = async () => {
      try {
        await close();
        log.info("shutdown_complete", {});
        clearTimeout(force);
        exit(0);
      } catch (error) {
        log.error("shutdown_failed", {}, error);
        clearTimeout(force);
        exit(1);
      }
    };
    if (!server) {
      void finish();
      return;
    }
    // Keep-alive sockets that finish their last response after close() stay
    // open until the keep-alive timeout; sweep them so the drain completes as
    // soon as in-flight requests do.
    const sweep = setInterval(() => server.closeIdleConnections(), 250);
    sweep.unref();
    server.close(() => {
      clearInterval(sweep);
      void finish();
    });
    server.closeIdleConnections();
  };
  for (const signal of o.signals ?? (["SIGTERM", "SIGINT"] as const))
    emitter.on(signal, onSignal);
}
