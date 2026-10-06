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

/** This page's id in the activity marker, so a tab can tell other tabs' input from its own. */
const TAB = Math.random().toString(36).slice(2, 10);

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
  write(ACTIVITY_KEY, JSON.stringify({ sessionId, at: now, tab: TAB }));
}

/**
 * How long this tab's due auto-lock must still wait because another open tab
 * of the same session had input more recently (ACC-21); 0 when the session is
 * idle everywhere. Each tab's timer only hears its own input, so without this a
 * background tab would lock while the cashier sells in the foreground tab. The
 * marker is written at most every 5 s, so a background tab may lock itself up
 * to 5 s early; its idle lock never reaches other tabs (lockFromOtherTab).
 */
export function idleElsewhereWait(
  sessionId: string,
  seconds: number,
  now = Date.now(),
): number {
  const activity = parse(read(ACTIVITY_KEY));
  if (
    activity?.sessionId !== sessionId ||
    activity.tab === TAB ||
    typeof activity.at !== "number"
  )
    return 0;
  return Math.max(0, activity.at + seconds * 1000 - now);
}

/** The reason a lock marker (for example from another tab) holds for this session. */
export function lockedFor(raw: string | null, sessionId: string): string | null {
  const lock = parse(raw);
  return lock?.sessionId === sessionId && typeof lock.reason === "string"
    ? lock.reason
    : null;
}

/**
 * The lock another tab's marker puts on this tab (ACC-16): every reason except
 * "idle". Each tab decides its own idle lock from its own input and the shared
 * activity marker (ACC-21), so an idle background tab never locks the tab in use.
 */
export function lockFromOtherTab(
  raw: string | null,
  sessionId: string,
): string | null {
  const reason = lockedFor(raw, sessionId);
  return reason === "idle" ? null : reason;
}

/** Locks the client sets by itself; every other reason is a server session code. */
const CLIENT_LOCKS = new Set(["idle", "manual", "renew"]);
/**
 * The offline "Continuar como" is offered only for locks the client set
 * (contract 8.2), including a renewal the cashier started: that session is
 * still valid (ACC-FLOOR-6). Never for a lock the server imposed.
 */
export function allowsContinueOffline(reason: string) {
  return CLIENT_LOCKS.has(reason);
}
/**
 * The lock after the auto-lock fires. A renewal prompt left on screen becomes
 * an idle lock, so its "Ahora no" never outlives the auto-lock (ACC-FLOOR-6).
 */
export function idleLock(current: { reason: string } | null): {
  reason: string;
} {
  return nextLock(current, "idle");
}
/** Locks remembered across reloads and tabs; a renewal prompt is per tab and voluntary. */
export function remembered(reason: string) {
  return reason !== "renew";
}
/**
 * The lock after a request to lock with `reason` (ACC-18). A lock the server
 * imposed (a session code) is never replaced, so only a PIN unlock, a switch or
 * a sign-out ends it and no client lock can turn it into one with a soft
 * unlock. A server code replaces an idle, manual or renew lock, and any other
 * lock replaces a renewal prompt; otherwise the lock already up stays as it is.
 */
export function nextLock(
  current: { reason: string } | null,
  reason: string,
): { reason: string } {
  if (!current) return { reason };
  if (!CLIENT_LOCKS.has(current.reason)) return current;
  if (!CLIENT_LOCKS.has(reason)) return { reason };
  // A renewal prompt can be put off ("Ahora no"), so any real lock (idle,
  // manual, another tab's, a soft unlock's re-lock) replaces it (ACC-FLOOR-6).
  if (current.reason === "renew" && reason !== "renew") return { reason };
  return current;
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

/**
 * Keeps the lock the topmost dialog (ACC-FLOOR-9). A dialog opened after the
 * lock (a receipt for a payment that resolved, a background prompt) is a new
 * portal child of <body> and would stack above it in the top layer: it is
 * made inert and the lock is raised above it again. allowOverlay() names the
 * moments the lock itself asks for a dialog over it (the "Salir" warnings).
 * Returns the undo, which also releases the elements it made inert.
 */
export function keepLockOnTop(
  dialog: HTMLDialogElement,
  allowOverlay: () => boolean,
): () => void {
  const changed = new Set<HTMLElement>();
  const raise = () => {
    if (!dialog.isConnected) return;
    if (dialog.open) dialog.close();
    dialog.showModal();
  };
  const observer = new MutationObserver((records) => {
    if (allowOverlay()) return;
    let opened = false;
    for (const record of records) {
      // Only new top-level children (portals); nodes inside the lock or the
      // already-inert workspace are left alone.
      if (record.type === "childList" && record.target === document.body)
        for (const node of record.addedNodes)
          if (node instanceof HTMLElement && node !== dialog && !node.inert) {
            node.inert = true;
            changed.add(node);
            if (node instanceof HTMLDialogElement && node.open) opened = true;
          }
      if (
        record.type === "attributes" &&
        record.target !== dialog &&
        record.target instanceof HTMLDialogElement &&
        record.target.open
      )
        opened = true;
    }
    if (opened) raise();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["open"],
  });
  return () => {
    observer.disconnect();
    for (const el of changed) el.inert = false;
  };
}
