/**
 * Database URL and TLS policy shared by the web/worker pool (server/db.ts) and
 * the migration runner (server/ops/schema.ts). Library module: no env reads.
 */
const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Loopback hosts and unix sockets connect in clear text; every other host verifies TLS. */
export function databaseTls(url: URL): false | "verify-full" {
  const host = decodeURIComponent(url.hostname).toLowerCase();
  if (loopback.has(host) || host === "" || host.startsWith("/")) return false;
  return "verify-full";
}

/**
 * Drops every query parameter. postgres.js forwards unknown parameters
 * (channel_binding, options, ...) as startup parameters and maps
 * sslmode=require to an unverified connection; the explicit `ssl` option and
 * code-level settings replace them (OPS-14).
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
