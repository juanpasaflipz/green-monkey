import type { Session } from "../../shared/domain";
import { ApiError, api } from "../api";
import { db, scope, syncPending } from "../offline";

/** Set when a logout could not reach the server; finished before anything else. */
export const LOGOUT_PENDING_KEY = "gm-logout-pending";

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* Storage can be unavailable (private mode); the server end still applies. */
  }
}

export function logoutPending() {
  return Boolean(read(LOGOUT_PENDING_KEY));
}

/** Statuses that still hold unsent evidence (a positive list, so archived rows never count). */
const UNSENT = ["pending", "syncing", "conflict"];

/**
 * Unsent offline sales of this employee on this device, plus any payment
 * attempt (active or parked) still waiting for confirmation.
 */
export async function unsyncedFor(
  s: Session,
): Promise<{ sales: number; payment: boolean }> {
  const rows = await db.pending.where("scope").equals(scope(s)).toArray();
  const attempts = await db.cache
    .where("id")
    .startsWith(scope(s) + ":payment")
    .count();
  return {
    sales: rows.filter((r) => UNSENT.includes(r.status)).length,
    payment: attempts > 0,
  };
}

/** Forces one sync pass when online, then recounts what is still unsent (OFF-7). */
export async function drainBeforeLeaving(
  s: Session,
  online: boolean,
): Promise<{ sales: number; payment: boolean }> {
  const before = await unsyncedFor(s);
  if (online && before.sales > 0) {
    try {
      await syncPending(s, true);
    } catch {
      /* Rows stay queued; the recount below reports them. */
    }
  }
  return unsyncedFor(s);
}

async function postLogout() {
  const response = await fetch("/api/access/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: "{}",
  });
  if (!response.ok) throw new ApiError("logout_failed", response.status);
}

/**
 * Ends the server session. The endpoint never fails on an invalid session; on a
 * network failure the logout is remembered and finished on the next load or
 * `online` event, so signing out always works locally (SEC-6).
 */
export async function serverSignOut(
  sessionId: string | null,
): Promise<"server" | "local"> {
  try {
    await postLogout();
    write(LOGOUT_PENDING_KEY, null);
    return "server";
  } catch {
    write(LOGOUT_PENDING_KEY, sessionId ?? "unknown");
    return "local";
  }
}

/**
 * A PIN sign-in on this device already ended (switch/replace) or deliberately
 * resumed the session a remembered logout pointed at, so the logout must not
 * run afterwards and end the new session.
 */
export function clearPendingLogout() {
  write(LOGOUT_PENDING_KEY, null);
}

/**
 * Completes a remembered logout. Resolves true when nothing remains pending;
 * without a connection the request fails and the flag stays set.
 */
export async function finishPendingLogout(): Promise<boolean> {
  if (!logoutPending()) return true;
  try {
    await postLogout();
    write(LOGOUT_PENDING_KEY, null);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the session for the current cookies without the previous session's
 * scope headers (used right after a PIN sign-in or unlock).
 */
export async function fetchCurrentSession(): Promise<Session> {
  const response = await fetch("/api/session", { credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error ?? "error", response.status);
  return data as Session;
}

/**
 * Refreshes the session every 5 minutes and when the tab becomes visible, so
 * the sliding expiry and renewed offline window reach the device (OFF-3).
 */
export function startHeartbeat(
  onSession: (s: Session) => void,
  isOnline: () => boolean,
): () => void {
  let stopped = false;
  const beat = async () => {
    if (stopped || !isOnline()) return;
    try {
      const s = await api<Session>("/session");
      if (!stopped) onSession(s);
    } catch {
      /* A session 401 is handled globally by the gm-unauthorized event. */
    }
  };
  const timer = setInterval(() => void beat(), 300_000);
  const visible = () => {
    if (document.visibilityState === "visible") void beat();
  };
  document.addEventListener("visibilitychange", visible);
  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", visible);
  };
}
