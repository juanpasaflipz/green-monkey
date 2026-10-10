// payments (037, spec §4.7): the web job that records the tender of an approved terminal charge.
// The worker queues it (keyed by the attempt) when a provider read approves the charge; the sync
// route races onto the same settle key, so exactly one tender is written (settleAttemptWith). A
// review outcome is done: a person resolves it.
import { registerJobHandler } from "../../jobs.js";
import { settleAttemptWith } from "../../payments/terminal.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

registerJobHandler(
  "payments_settle",
  async (ctx) => {
    const attemptId = (ctx.job.payload as { attemptId?: unknown })?.attemptId;
    if (typeof attemptId !== "string" || !uuid.test(attemptId))
      return { status: "dead", code: "invalid_payload" };
    await settleAttemptWith(ctx.tenant, attemptId, "job");
    return { status: "done" };
  },
  { concurrency: 2, leaseSeconds: 60, maxAttempts: 8 },
);
