// Loyalty (038, specs/loyalty-w4.md §4.7): loyalty_reconcile, enqueued by the hooks inside money
// transactions (settle, void, refund, reward discount reversal) with the order id only. The body
// is state-reconciling (replay-safe, wave-contracts §0.7): it posts only the difference between
// the order's target and its ledger, so redelivery never double-stamps. loyalty_retry (the link
// changed under it) and serialization or deadlock errors retry; a dead job alerts
// jobs_dead_loyalty_reconcile and owners requeue it from the jobs screen (RUNBOOK "Jobs").
import { registerJobHandler } from "../../jobs.js";
import { reconcileOrder } from "../../loyalty/ledger.js";
import { LOYALTY_RECONCILE } from "../../loyalty/hooks.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

registerJobHandler(
  LOYALTY_RECONCILE,
  async (ctx) => {
    const orderId = (ctx.job.payload as { orderId?: unknown } | null)?.orderId;
    if (typeof orderId !== "string" || !UUID.test(orderId))
      return { status: "dead", code: "loyalty_payload_invalid" };
    await ctx.tenant((tx) => reconcileOrder(tx, ctx.job.tenantId, orderId));
  },
  { concurrency: 4, leaseSeconds: 60, maxAttempts: 8 },
);
