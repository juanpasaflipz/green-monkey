// Wakes the worker after a payments enqueue (spec §4.7 "Wake"): a fire-and-forget POST
// ${WORKER_URL}/wake on the private network, 500 ms timeout, debounced to one per 250 ms; per
// attempt, a sync wakes at most once every 3 s. A no-op without WORKER_URL: the worker's 5 s
// discovery sweep alone then applies. It carries no data, so a lost wake only costs latency.
const DEBOUNCE_MS = 250;
const PER_ATTEMPT_MS = 3000;

let target: string | null = null;
let timer: NodeJS.Timeout | null = null;
const lastByAttempt = new Map<string, number>();
/** Test hook: observes wakes instead of sending them. */
let observer: (() => void) | null = null;

/** server/index.ts passes WORKER_URL once at boot (an http(s) origin, else no wake). */
export function configureWake(raw: string | null | undefined): void {
  target = null;
  if (!raw?.trim()) return;
  try {
    const url = new URL(raw.trim());
    if (/^https?:$/.test(url.protocol)) target = url.origin;
  } catch {
    target = null;
  }
}
export function onWakeForTests(fn: (() => void) | null): void {
  observer = fn;
}

export function wakeWorker(): void {
  if ((!target && !observer) || timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (observer) {
      observer();
      return;
    }
    if (!target) return;
    void fetch(`${target}/wake`, {
      method: "POST",
      signal: AbortSignal.timeout(500),
    }).catch(() => undefined);
  }, DEBOUNCE_MS);
  timer.unref();
}

/** The sync route's wake: at most once every 3 s per attempt (a dialog syncs every 1.5 s). */
export function wakeWorkerFor(attemptId: string): void {
  const now = Date.now();
  const last = lastByAttempt.get(attemptId);
  if (last !== undefined && now - last < PER_ATTEMPT_MS) return;
  lastByAttempt.delete(attemptId);
  lastByAttempt.set(attemptId, now);
  if (lastByAttempt.size > 2000)
    lastByAttempt.delete(lastByAttempt.keys().next().value!);
  wakeWorker();
}
