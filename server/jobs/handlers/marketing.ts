// Marketing (047, docs/MARKETING.md): the daily automation pass and scheduled campaign
// starts. Both only write outbox rows and jobs for the worker; neither calls a provider.
// Each is idempotent: the daily pass is fenced by marketing_runs, a launch by the
// campaign's state under its row lock.
import { registerJobHandler } from "../../jobs.js";
import {
  launchScheduled,
  MARKETING_DAILY,
  MARKETING_LAUNCH,
  runDaily,
} from "../../marketing/core.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
registerJobHandler(
  MARKETING_DAILY,
  async (ctx) => {
    await ctx.tenant((tx) => runDaily(tx, ctx.job.tenantId, process.env));
  },
  { concurrency: 1, leaseSeconds: 120, maxAttempts: 8 },
);
registerJobHandler(
  MARKETING_LAUNCH,
  async (ctx) => {
    const campaignId = (ctx.job.payload as { campaignId?: unknown } | null)
      ?.campaignId;
    if (typeof campaignId !== "string" || !UUID.test(campaignId))
      return { status: "dead", code: "marketing_payload_invalid" };
    await ctx.tenant((tx) =>
      launchScheduled(tx, ctx.job.tenantId, campaignId, process.env),
    );
  },
  { concurrency: 1, leaseSeconds: 120, maxAttempts: 8 },
);
