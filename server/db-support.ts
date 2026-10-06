/**
 * Database connection policy shared by the runtime pool (server/db.ts), the
 * billing pools and the migration runner. Library module: no config import.
 */
import type postgres from "postgres";
import { log } from "./logging.js";

const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Loopback hosts and unix sockets connect in clear text; every other host verifies TLS (OPS-14). */
export function databaseTls(url: URL): false | "verify-full" {
  const host = decodeURIComponent(url.hostname).toLowerCase();
  if (loopback.has(host) || host === "" || host.startsWith("/")) return false;
  return "verify-full";
}

/**
 * Drops every query parameter. postgres.js maps sslmode=require to an
 * unverified connection and forwards unknown parameters (channel_binding,
 * options, ...) as startup parameters; the explicit options below replace them.
 */
export function withoutParams(url: string | URL): URL {
  const u = new URL(url.toString());
  u.search = "";
  return u;
}

/** host:port/database, never credentials. */
export function databaseIdentity(url: string | URL): string {
  const u = new URL(url.toString());
  return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
}

/** Pool options for one login: verified TLS off-host, bounded pool, recycled connections. */
export function poolOptions(
  url: URL,
  o: { max?: number; applicationName: string },
): postgres.Options<Record<string, postgres.PostgresType>> {
  const envMax = Number(process.env.DB_POOL_MAX);
  return {
    max: o.max ?? (Number.isInteger(envMax) && envMax > 0 ? envMax : 20),
    connect_timeout: 5,
    idle_timeout: 20,
    max_lifetime: 1800,
    ssl: databaseTls(url),
    connection: { application_name: o.applicationName },
    onnotice: (notice) =>
      log.debug("postgres_notice", { notice: String(notice.message ?? "") }),
  };
}

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

/** Connectivity failures worth waiting out at startup (OPS-11). */
export function isTransientDbError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; errors?: unknown };
  const code = typeof e?.code === "string" ? e.code : "";
  if (TRANSIENT_CODES.has(code) || /^08/.test(code)) return true;
  // Node reports multi-address connect failures as an AggregateError.
  if (Array.isArray(e?.errors) && e.errors.some(isTransientDbError))
    return true;
  const message = typeof e?.message === "string" ? e.message : "";
  return /compute (node|is starting)|endpoint is (starting|waking)|terminating connection due to administrator command/i.test(
    message,
  );
}

/** 1 s · 2^attempt, capped at 30 s, ±20% jitter. */
export function retryBackoffMs(
  attempt: number,
  rand: () => number = Math.random,
) {
  return Math.round(
    Math.min(1000 * 2 ** attempt, 30_000) * (0.8 + 0.4 * rand()),
  );
}

/** Statement timeout for tenant transactions in ms, as text (DB_STATEMENT_TIMEOUT_MS, 1000-60000). */
export function statementTimeoutMs(value: string | undefined): string {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1000 && n <= 60_000 ? String(n) : "10000";
}
