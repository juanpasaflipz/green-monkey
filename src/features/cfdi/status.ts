/**
 * The CFDI status store (spec §5.2): what buttons and the printed ticket block need, read
 * synchronously so receipts print offline from the cached value. Prefetched after sign-in
 * (App.tsx load()), hydrated from Dexie when the device starts offline (restoreCached()), and
 * cleared on every employee change. Kitchen sessions never call it (GET /cfdi/status is for
 * operators).
 *
 * Kept fresh while signed in (CFDIFIX-3): the printed self-invoicing deadline depends on settings
 * that can change mid-month (a periodicity that applies at once, the policy, the reissue switch),
 * so a terminal signed in for the whole shift refreshes the status when the window regains focus
 * or visibility, when the connection returns, and every STATUS_REFRESH_MS while online and
 * visible. The refresh stops by itself once the device's session is no longer the employee it
 * started for (sign-out deletes it, an employee change replaces it; App starts a new one) and
 * skips while api() holds calls after a session 401.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Session } from "../../../shared/domain";
import {
  STATUS_REFRESH_MS,
  type CfdiStatusView,
  type CfdiTicketView,
} from "../../../shared/cfdi";
import { api, requestsBlocked } from "../../api";
import { db, scope } from "../../offline";

let current: CfdiStatusView | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function getCfdiStatus(): CfdiStatusView | null {
  return current;
}
export function setCfdiStatus(v: CfdiStatusView | null): void {
  current = v;
  emit();
}
/** Clears the store and stops its refresh (every employee change, before the next prefetch). */
export function clearCfdiStatus(): void {
  stopRefresh?.();
  stopRefresh = null;
  setCfdiStatus(null);
}
export function useCfdiStatus(): CfdiStatusView | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getCfdiStatus,
    getCfdiStatus,
  );
}

const cacheKey = (s: Session) => scope(s) + ":cfdi-status";

/**
 * How often a signed-in device refreshes the cached status while online and visible (shared: the
 * tick waits this long, plus a margin, before it rebuilds a month after a shortening change).
 */
export { STATUS_REFRESH_MS };

/** What the refresh needs from the browser (injected so it is tested without one). */
export type StatusRefreshEnv = {
  on(
    event: "focus" | "online" | "visibilitychange",
    fn: () => void,
  ): () => void;
  visible(): boolean;
  online(): boolean;
  every(ms: number, fn: () => void): () => void;
};

/**
 * Refreshes on focus, visibility, the connection's return and every STATUS_REFRESH_MS, one
 * request at a time, never while offline, hidden or `paused()`. Stops for good (as does the
 * returned stop()) the first time `signedIn()` answers false or fails. Never throws.
 */
export function startStatusRefresh(o: {
  env: StatusRefreshEnv;
  signedIn: () => Promise<boolean>;
  paused: () => boolean;
  refresh: () => Promise<unknown>;
}): () => void {
  let stopped = false;
  let inFlight = false;
  const offs: (() => void)[] = [];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const off of offs) off();
  };
  const tick = async () => {
    if (stopped || inFlight || o.paused()) return;
    if (!o.env.online() || !o.env.visible()) return;
    inFlight = true;
    try {
      if (!(await o.signedIn().catch(() => false))) return stop();
      if (!stopped) await o.refresh();
    } catch {
      // A failed refresh keeps the cached status; the next trigger tries again.
    } finally {
      inFlight = false;
    }
  };
  const run = () => void tick();
  offs.push(o.env.on("focus", run));
  offs.push(o.env.on("online", run));
  offs.push(o.env.on("visibilitychange", run));
  offs.push(o.env.every(STATUS_REFRESH_MS, run));
  return stop;
}

let stopRefresh: (() => void) | null = null;

function browserEnv(): StatusRefreshEnv | null {
  if (typeof window === "undefined" || typeof document === "undefined")
    return null;
  return {
    on(event, fn) {
      const target: EventTarget =
        event === "visibilitychange" ? document : window;
      target.addEventListener(event, fn);
      return () => target.removeEventListener(event, fn);
    },
    visible: () => document.visibilityState !== "hidden",
    online: () => typeof navigator === "undefined" || navigator.onLine,
    every(ms, fn) {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    },
  };
}

/**
 * Starts (or restarts) the refresh for the signed-in session `s`. It runs while the device's
 * session (Dexie "session": deleted at sign-out, replaced by an employee change, rewritten by a
 * renewal) is the same employee of the same restaurant.
 */
function keepFresh(s: Session): void {
  stopRefresh?.();
  stopRefresh = null;
  const env = browserEnv();
  if (!env) return;
  stopRefresh = startStatusRefresh({
    env,
    signedIn: async () => {
      const cached = (await db.cache.get("session"))?.value as
        Session | undefined;
      return (
        cached?.tenantId === s.tenantId && cached?.employeeId === s.employeeId
      );
    },
    paused: requestsBlocked,
    refresh: () => fetchStatus(s),
  });
}

/** GET /cfdi/status → store → Dexie cache; throws when the request fails. */
async function fetchStatus(s: Session): Promise<CfdiStatusView> {
  const v = await api<CfdiStatusView>("/cfdi/status");
  setCfdiStatus(v);
  try {
    await db.cache.put({ id: cacheKey(s), value: v });
  } catch {
    // A full or blocked IndexedDB only loses the offline copy.
  }
  return v;
}

/**
 * GET /cfdi/status → store → Dexie cache; on any failure the cached value (if any). `cacheOnly`
 * reads only the cache (a device started in manual offline mode). An online prefetch also keeps
 * the status fresh while this session stays signed in (CFDIFIX-3).
 */
export async function prefetchCfdiStatus(
  s: Session,
  o: { cacheOnly?: boolean } = {},
): Promise<CfdiStatusView | null> {
  if (s.role === "kitchen") return null;
  if (!o.cacheOnly) {
    keepFresh(s);
    try {
      return await fetchStatus(s);
    } catch {
      // Fall back to the cache below.
    }
  }
  try {
    const cached = (await db.cache.get(cacheKey(s)))?.value as
      CfdiStatusView | undefined;
    if (cached) setCfdiStatus(cached);
    return cached ?? null;
  } catch {
    return null;
  }
}

/** True when the ticket's covering document (an invoice or a global) is valid. */
export function cfdiTicketCovered(v: CfdiTicketView | null): boolean {
  return v?.covering?.status === "valid";
}

/**
 * Whether useCfdiTicketStatus asks the server at all: an id, CFDI available, and CFDI activated
 * at some point (a mode). A restaurant that never activated it has no invoice to report, and the
 * server answers cfdi_disabled (409), which the browser logs on every refund dialog. A paused
 * restaurant keeps its mode and its invoices, so it is still asked.
 */
export function ticketStatusWanted(
  ticketId: string | null,
  status: CfdiStatusView | null,
): ticketId is string {
  return !!ticketId && !!status?.available && status.mode !== null;
}

/** GET /cfdi/tickets/:id, or null on any failure (never throws). */
export async function loadCfdiTicketStatus(
  ticketId: string,
  signal?: AbortSignal,
): Promise<CfdiTicketView | null> {
  try {
    return await api<CfdiTicketView>(
      "/cfdi/tickets/" + encodeURIComponent(ticketId),
      undefined,
      { signal },
    );
  } catch {
    return null;
  }
}

/**
 * The CFDI view of one ticket, for discounts' RefundDialog notice (spec §6.1): one request per id,
 * no polling, null immediately without an id or when CFDI is unavailable, and null on any error
 * (forbidden roles, cfdi_unavailable, not found, offline). Never throws, never shows an error.
 */
export function useCfdiTicketStatus(
  ticketId: string | null,
): CfdiTicketView | null {
  const status = useCfdiStatus();
  const wanted = ticketStatusWanted(ticketId, status);
  const [view, setView] = useState<{
    id: string;
    v: CfdiTicketView | null;
  } | null>(null);
  useEffect(() => {
    if (!wanted || !ticketId) return;
    const abort = new AbortController();
    void loadCfdiTicketStatus(ticketId, abort.signal).then((v) => {
      if (!abort.signal.aborted) setView({ id: ticketId, v });
    });
    return () => abort.abort();
  }, [wanted, ticketId]);
  return wanted && view?.id === ticketId ? view.v : null;
}
