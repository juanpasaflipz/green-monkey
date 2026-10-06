/**
 * Corrected clock for offline evidence (OFF-8). Records carry the corrected
 * time, the raw device time and the offset, so the server can tell a fast
 * device clock from a sale made outside the lease.
 */
import { clockOffsetMs, serverNow as connectivityNow } from "./connectivity";

/** Date.now() corrected by the last measured server offset. */
export function serverNow(): number {
  return connectivityNow();
}

/** Corrected instant as an ISO string. */
export function correctedIso(): string {
  return new Date(serverNow()).toISOString();
}

/** Raw device instant as an ISO string (kept next to the corrected one). */
export function deviceIso(): string {
  return new Date().toISOString();
}

/** Last measured server-minus-device offset in ms, or null when unknown. */
export function clockOffset(): number | null {
  return clockOffsetMs();
}
