/**
 * Service worker registration and the user-triggered update flow (OFF-10).
 * The worker lives at a fixed /sw.js with its build id baked in. A new revision
 * waits until every tab closes, or until staff press "Actualizar ahora" while the
 * device has nothing unsynced and no payment in flight.
 */
type Listener = (ready: boolean) => void;

let registration: ServiceWorkerRegistration | null = null;
let hadController = false;
let reloading = false;
const listeners = new Set<Listener>();

function supported() {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

function waitingReady() {
  return !!(registration?.waiting && hadController);
}

function notify() {
  const ready = waitingReady();
  for (const listener of listeners) listener(ready);
}

function track(worker: ServiceWorker | null) {
  if (!worker) return;
  worker.addEventListener("statechange", () => {
    if (worker.state === "installed") notify();
  });
}

/** Registers /sw.js (replacing any older /sw.js?revision=… registration). */
export async function registerServiceWorker(): Promise<void> {
  if (!supported()) return;
  hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Only a page that was already controlled reloads; a first install must not.
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  try {
    registration = await navigator.serviceWorker.register("/sw.js");
  } catch {
    return;
  }
  track(registration.installing);
  registration.addEventListener("updatefound", () => {
    track(registration?.installing ?? null);
  });
  notify();
}

/** Subscribes to "a new revision is installed and waiting". */
export function onUpdateReady(listener: Listener): () => void {
  listeners.add(listener);
  listener(waitingReady());
  return () => {
    listeners.delete(listener);
  };
}

/** Asks the browser to look for a new worker (after a build mismatch from the ping). */
export async function checkForUpdate(): Promise<void> {
  try {
    await registration?.update();
  } catch {
    /* Offline or blocked: the next check retries. */
  }
}

/**
 * Activates the waiting revision under the exclusive session-transition lock,
 * which waits for every payment and sync in any tab. `canApply` re-checks for
 * unsynced work inside the lock.
 */
export async function applyUpdate(
  canApply: () => Promise<boolean>,
): Promise<"applied" | "blocked"> {
  const waiting = registration?.waiting;
  if (!waiting) return "blocked";
  return navigator.locks.request(
    "green-monkey-session-transition",
    { mode: "exclusive" },
    async () => {
      if (!(await canApply())) return "blocked" as const;
      waiting.postMessage({ type: "SKIP_WAITING" });
      return "applied" as const;
    },
  );
}

export function serviceWorkerSupported(): boolean {
  return supported();
}
