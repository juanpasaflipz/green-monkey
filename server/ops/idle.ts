/**
 * Idle pacing for the worker's database loops. Neon suspends a compute after 5 minutes
 * without queries; a loop that polls every few seconds keeps it running (and billed) around
 * the clock. Loops therefore poll fast only while work is pending and otherwise sleep until
 * the next item is due, capped by WORKER_IDLE_MS.
 */

/** Clamps "due in" milliseconds (null: nothing pending) to [busyMs, idleMs]. */
export function nextDelay(
  dueInMs: number | null,
  busyMs: number,
  idleMs: number,
) {
  if (dueInMs === null || !Number.isFinite(dueInMs)) return idleMs;
  return Math.min(idleMs, Math.max(busyMs, Math.ceil(dueInMs)));
}

/**
 * How long a loop may go without ticking before the worker's /healthz calls it stale: one
 * idle period plus two minutes of slack, never less than the historical 120 s.
 */
export function staleAfterMs(idleMs: number) {
  return Math.max(120_000, idleMs + 120_000);
}
