/**
 * Pure offline policy: connectivity state machine, sync error classification,
 * retry backoff, clock offset estimation and provisional numbering. No DOM or
 * Dexie imports, so every rule here is unit-tested directly.
 */

/** Consecutive failed probes/requests before the device counts as offline. */
export const FAIL_THRESHOLD = 2;
/** Consecutive successful probes/requests before an offline device recovers. */
export const RECOVER_THRESHOLD = 2;
/** A request slower than this counts toward the "slow connection" warning. */
export const SLOW_MS = 4000;

export type ApiErrorKind = "domain" | "auth" | "network" | "timeout" | "server";

export type ConnectivityState = {
  mode: "online" | "offline";
  manual: boolean;
  browserOffline: boolean;
  failures: number;
  successes: number;
  lastContactAt: number | null;
  lastFailureCode: string | null;
  /** Latencies of the last 3 requests; a timeout is recorded as Infinity. */
  latencies: number[];
};

export type ConnectivityEvent =
  | { type: "probe_ok" | "request_ok"; at: number; latencyMs: number }
  | { type: "probe_fail" | "request_fail"; at: number; code: string }
  | { type: "browser_online" }
  | { type: "browser_offline" }
  | { type: "manual"; value: boolean };

export const initialConnectivity = (
  browserOffline = false,
  manual = false,
): ConnectivityState => ({
  mode: browserOffline ? "offline" : "online",
  manual,
  browserOffline,
  failures: 0,
  successes: 0,
  lastContactAt: null,
  lastFailureCode: null,
  latencies: [],
});

const lastThree = (values: number[], next: number) =>
  [...values, next].slice(-3);

export function reduceConnectivity(
  s: ConnectivityState,
  e: ConnectivityEvent,
): ConnectivityState {
  switch (e.type) {
    case "browser_offline":
      return { ...s, browserOffline: true, mode: "offline", successes: 0 };
    case "browser_online":
      // The browser saying "online" proves nothing about the server; only
      // probes and requests move the mode back.
      return { ...s, browserOffline: false };
    case "manual":
      return { ...s, manual: e.value };
    case "probe_fail":
    case "request_fail": {
      const failures = s.failures + 1;
      const timedOut = e.code === "request_timeout";
      return {
        ...s,
        failures,
        successes: 0,
        lastFailureCode: e.code,
        latencies:
          e.type === "request_fail" && timedOut
            ? lastThree(s.latencies, Infinity)
            : s.latencies,
        mode:
          failures >= FAIL_THRESHOLD || s.browserOffline ? "offline" : s.mode,
      };
    }
    case "probe_ok":
    case "request_ok": {
      const successes = s.successes + 1;
      return {
        ...s,
        failures: 0,
        successes,
        lastContactAt: e.at,
        lastFailureCode: null,
        latencies:
          e.type === "request_ok"
            ? lastThree(s.latencies, e.latencyMs)
            : s.latencies,
        mode:
          s.mode === "offline" &&
          successes >= RECOVER_THRESHOLD &&
          !s.browserOffline
            ? "online"
            : s.mode,
      };
    }
  }
}

export function deriveConnectivity(s: ConnectivityState): {
  serverReachable: boolean;
  canUseServer: boolean;
  slow: boolean;
} {
  const serverReachable = s.mode === "online" && !s.browserOffline;
  return {
    serverReachable,
    canUseServer: serverReachable && !s.manual,
    slow:
      serverReachable && s.latencies.filter((ms) => ms > SLOW_MS).length >= 2,
  };
}

/**
 * Next heartbeat delay. Online: every 30 s (120 s while the page is hidden).
 * Offline or manually offline while unreachable: 2 s, 4 s, 8 s, capped at 15 s.
 */
export function nextProbeDelay(
  s: ConnectivityState,
  hidden: boolean,
  offlineProbeCount: number,
): number {
  if (deriveConnectivity(s).serverReachable) return hidden ? 120_000 : 30_000;
  return Math.min(15_000, 2_000 * 2 ** Math.max(0, offlineProbeCount - 1));
}

export type SyncClass =
  "transient" | "auth" | "conflict" | "archived" | "synced";

const TRANSIENT_CODES = new Set([
  "network_unavailable",
  "request_timeout",
  "server_unavailable",
  "invalid_response",
  "rate_limited",
  "internal_error",
  "schema_not_ready",
  "database_unavailable",
  "offline_recorded_in_future",
  "offline_dependency_pending",
]);
const AUTH_CODES = new Set([
  "unauthorized",
  "session_changed",
  "missing_tenant",
]);

/**
 * Only explicit domain codes become conflicts. Anything that might succeed on
 * a later attempt (transport failures, 5xx, a device clock slightly ahead, a
 * dependency still queued) is retried forever.
 */
export function classifySyncError(
  code: string,
  kind: ApiErrorKind | undefined,
): SyncClass {
  if (kind === "network" || kind === "timeout" || kind === "server")
    return "transient";
  if (TRANSIENT_CODES.has(code)) return "transient";
  if (AUTH_CODES.has(code) || kind === "auth") return "auth";
  if (code === "offline_archived") return "archived";
  if (code === "offline_already_synced") return "synced";
  return "conflict";
}

/** Jittered exponential backoff: 2 s doubling, capped at 60 s, ±20 %. */
export function retryDelay(attempts: number, random = Math.random): number {
  return Math.round(
    Math.min(60_000, 2_000 * 2 ** Math.min(Math.max(0, attempts), 5)) *
      (0.8 + 0.4 * random()),
  );
}

/** Clock offset from one ping: the server stamped `serverNow` near the RTT midpoint. */
export function offsetFromSample(
  t0: number,
  t1: number,
  serverNow: number,
): { offsetMs: number; rttMs: number } {
  const rttMs = Math.max(0, t1 - t0);
  return { offsetMs: Math.round(serverNow - (t0 + rttMs / 2)), rttMs };
}

export function medianOffset(samples: number[]): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** "B" + 7 -> "B-07"; numbers above 99 keep their digits (up to 4). */
export function formatProvisional(prefix: string, n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 9999)
    throw Error("provisional_number_out_of_range");
  return `${prefix}-${String(n).padStart(2, "0")}`;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Reserved "Z" family for devices that never fetched a server prefix. */
export function fallbackPrefix(deviceId: string): string {
  const hex = deviceId.replace(/[^0-9a-f]/gi, "");
  let n = 0;
  for (const ch of hex.slice(0, 8)) n = (n * 16 + parseInt(ch, 16)) % 1024;
  return "Z" + BASE32[(n >> 5) & 31] + BASE32[n & 31];
}

export function offlineWindow(
  offlineUntil: string,
  serverNowMs: number,
): { expired: boolean; minutesLeft: number } {
  const left = Date.parse(offlineUntil) - serverNowMs;
  return {
    expired: !(left > 0),
    minutesLeft: left > 0 ? Math.floor(left / 60_000) : 0,
  };
}

/** Fiscal warning threshold: unsynced sales older than this may miss the global CFDI. */
export const FISCAL_LATE_MS = 20 * 3600_000;
/** Clock skew that triggers the "turn on automatic time" warning. */
export const CLOCK_WARNING_MS = 120_000;
/** Resolved rows (synced or archived) stay on the device this long. */
export const RESOLVED_RETENTION_MS = 7 * 86_400_000;
