/**
 * Singleton reachability driver (OFF-1/FOH-6). The device is "online" only while
 * the server answers: a heartbeat to /api/offline/ping plus the outcome of every
 * api() request feed a hysteresis state machine (src/offline-policy.ts).
 * navigator.onLine === false is trusted immediately; true proves nothing.
 */
import { useSyncExternalStore } from "react";
import { setRetryGate, setTransportObserver } from "./api";
import {
  deriveConnectivity,
  initialConnectivity,
  medianOffset,
  nextProbeDelay,
  offsetFromSample,
  reduceConnectivity,
  type ConnectivityEvent,
  type ConnectivityState,
} from "./offline-policy";
import { checkForUpdate } from "./service-worker";

declare const __BUILD_ID__: string;

export const WORK_OFFLINE_KEY = "gm-work-offline";
const CLOCK_KEY = "device:clock";

export type ConnectivitySnapshot = {
  serverReachable: boolean;
  canUseServer: boolean;
  slow: boolean;
  manual: boolean;
  browserOffline: boolean;
  offsetMs: number | null;
  lastContactAt: number | null;
  lastFailureCode: string | null;
};

function readManual(): boolean {
  try {
    return localStorage.getItem(WORK_OFFLINE_KEY) === "1";
  } catch {
    return false;
  }
}

let state: ConnectivityState = initialConnectivity(
  typeof navigator !== "undefined" && navigator.onLine === false,
  typeof localStorage !== "undefined" && readManual(),
);
let offset: number | null = null;
let persistedOffset: number | null = null;
const samples: number[] = [];
let snapshot = compute();
const listeners = new Set<() => void>();
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let probing: Promise<void> | null = null;
let offlineProbes = 0;
let failureProbe: ReturnType<typeof setTimeout> | null = null;
let lastUpdateCheck = 0;

function compute(): ConnectivitySnapshot {
  return {
    ...deriveConnectivity(state),
    manual: state.manual,
    browserOffline: state.browserOffline,
    offsetMs: offset,
    lastContactAt: state.lastContactAt,
    lastFailureCode: state.lastFailureCode,
  };
}

function emit() {
  const next = compute();
  const changed = (Object.keys(next) as (keyof ConnectivitySnapshot)[]).some(
    (key) => next[key] !== snapshot[key],
  );
  if (!changed) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function dispatch(event: ConnectivityEvent) {
  const wasReachable = snapshot.serverReachable;
  state = reduceConnectivity(state, event);
  emit();
  if (wasReachable !== snapshot.serverReachable) reschedule();
}

/** The device cache (Dexie `cache` store) where the measured offset survives reloads. */
export type ClockStore = {
  get(id: string): PromiseLike<{ value: unknown } | undefined>;
  put(row: { id: string; value: unknown }): PromiseLike<unknown>;
};
let clockStore: ClockStore | null = null;

/**
 * src/offline.ts attaches its device cache here when it loads. Injecting it,
 * rather than importing it, keeps this module out of an import cycle with the
 * offline store.
 */
export function attachClockStore(store: ClockStore) {
  if (clockStore) return;
  clockStore = store;
  if (started) void loadClock();
}

async function loadClock() {
  if (!clockStore) return;
  try {
    const saved = (await clockStore.get(CLOCK_KEY))?.value as
      { offsetMs: number } | undefined;
    if (offset === null && typeof saved?.offsetMs === "number") {
      offset = saved.offsetMs;
      persistedOffset = saved.offsetMs;
      emit();
    }
  } catch {
    /* Storage may be unavailable (private window); the offset stays unknown. */
  }
}

function addSample(offsetMs: number, rttMs: number) {
  samples.push(offsetMs);
  if (samples.length > 5) samples.shift();
  offset = medianOffset(samples);
  if (
    clockStore &&
    (persistedOffset === null || Math.abs(offset - persistedOffset) > 1000)
  ) {
    persistedOffset = offset;
    const value = { offsetMs: offset, rttMs, measuredAt: Date.now() };
    Promise.resolve(clockStore.put({ id: CLOCK_KEY, value })).catch(() => {});
  }
}

function maybeUpdate(build: unknown) {
  if (
    typeof build !== "string" ||
    build === "local" ||
    typeof __BUILD_ID__ === "undefined" ||
    build === __BUILD_ID__ ||
    Date.now() - lastUpdateCheck < 600_000
  )
    return;
  lastUpdateCheck = Date.now();
  void checkForUpdate();
}

/** One heartbeat. Concurrent callers share the in-flight probe. */
export function probeNow(): Promise<void> {
  probing ??= (async () => {
    const t0 = Date.now();
    try {
      const response = await fetch("/api/offline/ping", {
        cache: "no-store",
        credentials: "same-origin",
        signal: AbortSignal.timeout(4000),
      });
      const t1 = Date.now();
      const json = (response.headers.get("content-type") ?? "").includes(
        "application/json",
      )
        ? await response.json().catch(() => null)
        : null;
      if (response.ok && json?.ok === true && typeof json.now === "number") {
        const sample = offsetFromSample(t0, t1, json.now);
        addSample(sample.offsetMs, sample.rttMs);
        offlineProbes = 0;
        dispatch({ type: "probe_ok", at: Date.now(), latencyMs: t1 - t0 });
        maybeUpdate(json.build);
      } else {
        dispatch({
          type: "probe_fail",
          at: Date.now(),
          code:
            typeof json?.error === "string"
              ? json.error
              : response.status >= 500
                ? "server_unavailable"
                : "invalid_response",
        });
      }
    } catch (e) {
      dispatch({
        type: "probe_fail",
        at: Date.now(),
        code:
          (e as Error)?.name === "TimeoutError"
            ? "request_timeout"
            : "network_unavailable",
      });
    } finally {
      if (!snapshot.serverReachable) offlineProbes++;
      probing = null;
      reschedule();
    }
  })();
  return probing;
}

function reschedule() {
  if (!started) return;
  if (timer) clearTimeout(timer);
  const hidden =
    typeof document !== "undefined" && document.visibilityState === "hidden";
  timer = setTimeout(
    () => void probeNow(),
    nextProbeDelay(state, hidden, Math.max(1, offlineProbes)),
  );
}

/** Starts the heartbeat, browser listeners and the api() observer once. */
export function startConnectivity() {
  if (started || typeof window === "undefined") return;
  started = true;
  setRetryGate(() => snapshot.serverReachable);
  setTransportObserver((outcome) => {
    if (outcome.path.startsWith("/offline/ping")) return;
    // A domain or auth answer still proves the server is reachable.
    if (outcome.ok || outcome.kind === "domain" || outcome.kind === "auth") {
      dispatch({
        type: "request_ok",
        at: Date.now(),
        latencyMs: outcome.latencyMs,
      });
      return;
    }
    dispatch({
      type: "request_fail",
      at: Date.now(),
      code:
        outcome.kind === "timeout"
          ? "request_timeout"
          : outcome.kind === "network"
            ? "network_unavailable"
            : "server_unavailable",
    });
    if (failureProbe) clearTimeout(failureProbe);
    failureProbe = setTimeout(() => void probeNow(), 1000);
  });
  window.addEventListener("online", () => {
    dispatch({ type: "browser_online" });
    void probeNow();
  });
  window.addEventListener("offline", () =>
    dispatch({ type: "browser_offline" }),
  );
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void probeNow();
    else reschedule();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === WORK_OFFLINE_KEY)
      dispatch({ type: "manual", value: event.newValue === "1" });
  });
  void loadClock();
  void probeNow();
}

export function subscribe(listener: () => void) {
  startConnectivity();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getConnectivitySnapshot(): ConnectivitySnapshot {
  return snapshot;
}

export function useConnectivity(): ConnectivitySnapshot {
  return useSyncExternalStore(subscribe, getConnectivitySnapshot);
}

/** Device-local "Trabajar sin conexión" switch, shared with other tabs. */
export function setWorkOffline(value: boolean) {
  try {
    if (value) localStorage.setItem(WORK_OFFLINE_KEY, "1");
    else localStorage.removeItem(WORK_OFFLINE_KEY);
  } catch {
    /* The mode still applies to this tab. */
  }
  dispatch({ type: "manual", value });
  if (!value) void probeNow();
}

/** Last measured server-minus-device clock offset, or null if never measured. */
export function clockOffsetMs(): number | null {
  return offset;
}

/** Best estimate of the server clock. */
export function serverNow(): number {
  return Date.now() + (offset ?? 0);
}

/** Test seam: reset the singleton to a known state. */
export function resetConnectivityForTests(
  next: Partial<ConnectivityState> = {},
  offsetMs: number | null = null,
) {
  state = { ...initialConnectivity(), ...next };
  offset = offsetMs;
  persistedOffset = offsetMs;
  samples.length = 0;
  snapshot = compute();
}
