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

export function rememberLock(sessionId: string, reason: string) {
  write(LOCK_KEY, JSON.stringify({ sessionId, reason }));
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

/**
 * The lock a restored session starts with: the remembered lock of this session,
 * or "idle" when its last recorded input is older than its auto-lock. Null
 * means the session may open unlocked.
 */
export function restoredLock(s: Session, now = Date.now()): string | null {
  const lock = parse(read(LOCK_KEY));
  if (lock?.sessionId === s.id && typeof lock.reason === "string")
    return lock.reason;
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
