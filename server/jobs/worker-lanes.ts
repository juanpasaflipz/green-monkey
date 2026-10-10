/**
 * The worker's job lanes (P2-CONCURRENCY-3): one runner per lane, each with its own global
 * concurrency and its own discovery, so a backlog of one area never holds the other's slots.
 * - `payments`: every payments_* kind. A cashier waits at the terminal for payments_push,
 *   payments_poll and payments_cancel (spec §4.7: tap-to-terminal p95 ≤ 3 s), and their calls are
 *   short (15 s timeout).
 * - `general`: every other worker kind (cfdi's Facturapi calls run up to 15-30 s, and a stamp or
 *   delivery backlog drains for minutes after an outage).
 * One runner with a global limit of 4 let four slow cfdi calls (registered first, so claimed
 * first on every pass) delay every restaurant's charges by tens of seconds.
 */
import type postgres from "postgres";
import type { ClaimedJob, RegisteredHandler } from "../jobs.js";
import type { Logger } from "../logging.js";
import { createJobRunner, type JobRunner } from "./runner.js";

export const WORKER_LANES = { general: 4, payments: 8 } as const;
const PAYMENTS = /^payments_/;

export function createWorkerRunners(
  sql: postgres.Sql,
  o: {
    handlers: () => ReadonlyMap<string, RegisteredHandler>;
    /** Tenants with claimable jobs of these kinds (an empty list still proves the login works). */
    discover: (kinds: string[]) => Promise<string[]>;
    onDead?: (job: ClaimedJob, code: string) => void;
    log?: Logger;
    sweepMs?: number;
    concurrency?: { general: number; payments: number };
  },
): JobRunner {
  const limits = o.concurrency ?? WORKER_LANES;
  const lane = (payments: boolean) => {
    const handlers = () =>
      new Map(
        [...o.handlers()].filter(([kind]) => PAYMENTS.test(kind) === payments),
      );
    return createJobRunner(sql, {
      handlers,
      concurrency: payments ? limits.payments : limits.general,
      sweepMs: o.sweepMs,
      log: o.log?.child({ lane: payments ? "payments" : "general" }),
      onDead: o.onDead,
      discover: () => o.discover([...handlers().keys()]),
    });
  };
  const lanes = [lane(false), lane(true)];
  return {
    start: () => lanes.forEach((l) => l.start()),
    poke: () => lanes.forEach((l) => l.poke()),
    noteTenant: (tenantId, activity) =>
      lanes.forEach((l) => l.noteTenant(tenantId, activity)),
    drainTenant: async (tenantId) =>
      (await Promise.all(lanes.map((l) => l.drainTenant(tenantId)))).reduce(
        (a, b) => a + b,
        0,
      ),
    stop: async (timeoutMs) => {
      await Promise.all(lanes.map((l) => l.stop(timeoutMs)));
    },
    running: () => lanes.reduce((n, l) => n + l.running(), 0),
  };
}
