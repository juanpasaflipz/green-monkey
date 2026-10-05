import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Single-flight polling: the next run is scheduled only after the previous one
 * settles. Failures back off `intervalMs * 2^n` up to `maxBackoffMs`. While the
 * document is hidden the loop pauses and runs as soon as it becomes visible.
 */
export function usePoll(
  fn: () => Promise<unknown>,
  {
    intervalMs,
    maxBackoffMs = 30000,
    enabled = true,
  }: { intervalMs: number; maxBackoffMs?: number; enabled?: boolean },
  deps: readonly unknown[] = [],
): { lastSuccess: number | null; failing: boolean; refresh(): void } {
  const [lastSuccess, setLastSuccess] = useState<number | null>(null);
  const [failing, setFailing] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const control = useRef<{ refresh: () => void }>({ refresh: () => {} });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let queued = false;
    let failures = 0;
    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!alive || document.hidden) return;
      timer = setTimeout(() => void run(), delay);
    };
    const run = async () => {
      if (!alive) return;
      if (inFlight) {
        queued = true;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = null;
      inFlight = true;
      try {
        await fnRef.current();
        if (!alive) return;
        failures = 0;
        setLastSuccess(Date.now());
        setFailing(false);
      } catch {
        if (!alive) return;
        failures++;
        setFailing(true);
      } finally {
        inFlight = false;
      }
      if (!alive) return;
      if (queued) {
        queued = false;
        void run();
        return;
      }
      schedule(
        failures
          ? Math.min(maxBackoffMs, intervalMs * 2 ** failures)
          : intervalMs,
      );
    };
    const visibility = () => {
      if (document.hidden) {
        if (timer) clearTimeout(timer);
        timer = null;
      } else void run();
    };
    control.current.refresh = () => void run();
    document.addEventListener("visibilitychange", visibility);
    void run();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
      control.current.refresh = () => {};
    };
    // deps are the caller's: the loop restarts when they change.
  }, [enabled, intervalMs, maxBackoffMs, ...deps]);
  const refresh = useCallback(() => control.current.refresh(), []);
  return { lastSuccess, failing, refresh };
}

export function useMediaQuery(query: string): boolean {
  const get = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const change = () => setMatches(list.matches);
    change();
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, [query]);
  return matches;
}

/** localStorage-backed state for per-device preferences; storage failures are ignored. */
export function useStoredState<T>(
  key: string,
  initial: T,
  guard: (value: unknown) => value is T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => readStored(key, initial, guard));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(
          key,
          typeof next === "string" ? next : JSON.stringify(next),
        );
      } catch {
        /* Private mode or blocked storage: keep the in-memory value. */
      }
    },
    [key],
  );
  return [value, set];
}

export function readStored<T>(
  key: string,
  initial: T,
  guard: (value: unknown) => value is T,
): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return initial;
    if (guard(raw)) return raw;
    const parsed: unknown = JSON.parse(raw);
    return guard(parsed) ? parsed : initial;
  } catch {
    return initial;
  }
}

/**
 * Asks Selling to resume a check or to open a new check on a table. Selling
 * applies the request when it is shown and nothing is in flight (SVC-R10);
 * the latest request wins, so a pending request of the other kind is dropped.
 */
export function requestSellingContext(
  request: { resume: string } | { table: string },
) {
  if ("resume" in request) {
    localStorage.removeItem("gm-table");
    localStorage.setItem("gm-resume", request.resume);
  } else {
    localStorage.removeItem("gm-resume");
    localStorage.setItem("gm-table", request.table);
  }
}
