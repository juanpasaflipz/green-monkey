import type { Session } from "../../shared/domain";

/**
 * The screen lock is client-side, so it must survive a reload, a reopened tab
 * and an offline restore of the cached session (SEC-6). The marker is keyed by
 * session id and cleared only by a PIN unlock, a new sign-in or a sign-out.
 */
export const LOCK_KEY = "gm-lock";
/** Last input on this device for a session, so a restore after a long pause starts locked. */
export const ACTIVITY_KEY = "gm-activity";
const ACTIVITY_WRITE_MS = 5_000;

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
    /* Storage can be unavailable (private mode); the in-memory lock still applies. */
  }
}
function parse(raw: string | null): Record<string, unknown> | null {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Remembers the lock of a session. Each write carries its own time, so other
 * tabs always receive a storage event, even for the same reason again.
 */
export function rememberLock(sessionId: string, reason: string, now = Date.now()) {
  write(LOCK_KEY, JSON.stringify({ sessionId, reason, at: now }));
}
export function forgetLock() {
  write(LOCK_KEY, null);
}

let lastWrite = { sessionId: "", at: 0 };
/** Records input for the idle check on restore (at most every 5 s unless forced). */
export function noteActivity(sessionId: string, force = false, now = Date.now()) {
  if (
    !force &&
    lastWrite.sessionId === sessionId &&
    now - lastWrite.at < ACTIVITY_WRITE_MS
  )
    return;
  lastWrite = { sessionId, at: now };
  write(ACTIVITY_KEY, JSON.stringify({ sessionId, at: now }));
}

/** The reason a lock marker (for example from another tab) holds for this session. */
export function lockedFor(raw: string | null, sessionId: string): string | null {
  const lock = parse(raw);
  return lock?.sessionId === sessionId && typeof lock.reason === "string"
    ? lock.reason
    : null;
}

/** A revoked session or device: the cached session is removed. */
const FORGET_CODES = new Set([
  "session_revoked",
  "device_revoked",
  "device_not_paired",
]);
/** Ended elsewhere, expired or unknown: the cached session stays, locked. */
const LOCK_CODES = new Set(["unauthorized", "session_expired", "session_ended"]);
/**
 * What a session 401 does to the offline cache (FOH-7/SEC-6): "forget" deletes
 * the cached session, "lock" remembers a lock with that code, so an offline
 * restore opens behind the lock with no soft unlock; anything else is ignored.
 */
export function cacheRuleFor(code: string): "forget" | "lock" | null {
  return FORGET_CODES.has(code) ? "forget" : LOCK_CODES.has(code) ? "lock" : null;
}

/**
 * The lock a restored session starts with: the remembered lock of this session,
 * or "idle" when its last recorded input is older than its auto-lock. Null
 * means the session may open unlocked.
 */
export function restoredLock(s: Session, now = Date.now()): string | null {
  const remembered = lockedFor(read(LOCK_KEY), s.id);
  if (remembered) return remembered;
  const idle = s.access?.idleLockSeconds;
  const activity = parse(read(ACTIVITY_KEY));
  if (
    idle &&
    activity?.sessionId === s.id &&
    typeof activity.at === "number" &&
    now - activity.at > idle * 1000
  )
    return "idle";
  return null;
}

/**
 * Makes every other top-level element inert while the lock is up, so nothing
 * behind it (the workspace, or a dialog opened before the lock) can be used
 * even if the lock dialog were closed. Returns the undo.
 */
export function inertOutside(keep: Element): () => void {
  const changed = [...document.body.children].filter(
    (el): el is HTMLElement =>
      el !== keep && el instanceof HTMLElement && !el.inert,
  );
  for (const el of changed) el.inert = true;
  return () => {
    for (const el of changed) el.inert = false;
  };
}
