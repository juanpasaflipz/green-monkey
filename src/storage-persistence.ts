/**
 * Storage persistence (OFF-11): asks the browser not to evict the offline queue
 * under storage pressure, and remembers the answer on the device.
 */
import { db } from "./offline";

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
    return ((await db.cache.get(PERSIST_KEY))?.value as never) ?? null;
  } catch {
    return null;
  }
}
