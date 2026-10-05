/**
 * Browser capability gate and storage persistence (OFF-11). The POS needs
 * IndexedDB, Web Locks, AbortController, AbortSignal.timeout and
 * crypto.randomUUID; these match Vite 8's default build target (Chrome/Edge 111,
 * Safari/iOS 16.4, Firefox 114). A missing service worker is only a warning.
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

const PERSIST_KEY = "device:persist";
const PERSIST_INTERVAL_MS = 86_400_000;

/**
 * Requests persistent storage after a successful online load: at most once per
 * 24 h while not granted. Firefox shows a permission prompt; Chromium and Safari
 * decide automatically. Returns null when the API is unavailable.
 */
export async function requestPersistence(): Promise<boolean | null> {
  const storage = typeof navigator !== "undefined" ? navigator.storage : null;
  if (!storage?.persist || !storage.persisted) return null;
  try {
    if (await storage.persisted()) {
      await remember(true);
      return true;
    }
    const { db } = await import("./offline");
    const last = (await db.cache.get(PERSIST_KEY))?.value as
      { requestedAt: number; granted: boolean } | undefined;
    if (last && Date.now() - last.requestedAt < PERSIST_INTERVAL_MS)
      return last.granted;
    const granted = await storage.persist();
    await remember(granted);
    return granted;
  } catch {
    return null;
  }
}

async function remember(granted: boolean) {
  try {
    const { db } = await import("./offline");
    await db.cache.put({
      id: PERSIST_KEY,
      value: { requestedAt: Date.now(), granted },
    });
  } catch {
    /* Persistence status is advisory. */
  }
}

/** Last automatic persistence result recorded on this device, if any. */
export async function persistenceStatus(): Promise<{
  requestedAt: number;
  granted: boolean;
} | null> {
  try {
    const { db } = await import("./offline");
    return ((await db.cache.get(PERSIST_KEY))?.value as never) ?? null;
  } catch {
    return null;
  }
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
