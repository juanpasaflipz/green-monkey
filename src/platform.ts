/**
 * Browser capability gate and Web Locks helper (OFF-11). The POS needs
 * IndexedDB, Web Locks, AbortController, AbortSignal.timeout and
 * crypto.randomUUID; these match Vite 8's default build target (Chrome/Edge 111,
 * Safari/iOS 16.4, Firefox 114). A missing service worker is only a warning.
 * This module loads before the app chunk, so it must not import the offline
 * store; storage persistence lives in src/storage-persistence.ts.
 */
export type PlatformSupport = {
  ok: boolean;
  missing: string[];
  serviceWorker: boolean;
};

export function platformSupport(
  scope: {
    indexedDB?: unknown;
    navigator?: Partial<Navigator> & { locks?: unknown };
    AbortController?: unknown;
    AbortSignal?: { timeout?: unknown };
    crypto?: { randomUUID?: unknown };
  } = globalThis as never,
): PlatformSupport {
  const missing: string[] = [];
  if (!scope.indexedDB) missing.push("indexedDB");
  if (!scope.navigator?.locks) missing.push("navigator.locks");
  if (typeof scope.AbortController !== "function")
    missing.push("AbortController");
  if (typeof scope.AbortSignal?.timeout !== "function")
    missing.push("AbortSignal.timeout");
  if (typeof scope.crypto?.randomUUID !== "function")
    missing.push("crypto.randomUUID");
  return {
    ok: missing.length === 0,
    missing,
    serviceWorker: !!scope.navigator && "serviceWorker" in scope.navigator,
  };
}

/**
 * Shared session-transition lock, then a named exclusive lock. Payments and sync
 * use this so a session switch or app update waits for them. The platform gate
 * guarantees navigator.locks exists.
 */
export function withLocks<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return navigator.locks.request(
    "green-monkey-session-transition",
    { mode: "shared" },
    () => navigator.locks.request(name, fn),
  );
}
