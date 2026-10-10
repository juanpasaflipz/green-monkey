/**
 * Lease, concurrency and claims of each payments worker kind (register.ts), side-effect free so
 * the lanes unit test drives the real limits.
 *
 * Every payments kind shares the worker's payments lane (server/jobs/worker-lanes.ts,
 * WORKER_LANES.payments = 8 slots across every restaurant). Reads are capped below it
 * (P2V-JOBS-2): payments_poll at 4 and payments_webhook (notifications, «Volver a consultar»,
 * recoveries) at 2, so at least 2 slots stay free for payments_push and payments_cancel, the steps
 * a cashier waits on (spec §4.7: tap-to-terminal p95 ≤ 3 s), even while one provider's slow
 * reads (15 s timeouts) hold every read slot.
 */
export const PAYMENTS_JOB_OPTIONS = {
  // A push that goes dead with the attempt still `sending` leaves it `unknown` (pushDead).
  payments_push: { leaseSeconds: 30, concurrency: 4, maxAttempts: 3 },
  payments_poll: { leaseSeconds: 30, concurrency: 4, maxAttempts: 100 },
  // 15 claims: a cancel waits (2 s apart) while the push is still recording the provider's answer.
  payments_cancel: { leaseSeconds: 30, concurrency: 4, maxAttempts: 15 },
  payments_webhook: { leaseSeconds: 20, concurrency: 2, maxAttempts: 3 },
  // A credentials job that goes dead wipes its upload and fails a still-verifying account.
  payments_credentials: { leaseSeconds: 60, concurrency: 2, maxAttempts: 3 },
  payments_devices: { leaseSeconds: 30, concurrency: 2, maxAttempts: 2 },
  payments_device_mode: { leaseSeconds: 30, concurrency: 1, maxAttempts: 2 },
  payments_wipe: { leaseSeconds: 20, concurrency: 1, maxAttempts: 3 },
} as const;
