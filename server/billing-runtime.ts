import postgres from "postgres";
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { withOwner } from "./owner-accounts.js";
import { billingStore, checkBillingRole } from "./billing-store.js";
import { stripeSandboxBilling } from "./stripe-billing.js";
import { billingTick } from "./billing-worker.js";
import {
  verifyStripeSandboxEvent,
  subscriptionEventReference,
} from "./stripe-webhook.js";

export async function billingRuntime(
  appSql: postgres.Sql,
  env: NodeJS.ProcessEnv,
  options: { runWorker?: boolean } = {},
) {
  const enabled = env.BILLING_SANDBOX_ENABLED === "true";
  const routes = Router(),
    webhook = Router();
  if (!enabled) {
    routes.get("/status", (_req, res) => res.json({ enabled: false }));
    return { routes, webhook, close: async () => {} };
  }
  if (
    !env.BILLING_DATABASE_URL ||
    !env.STRIPE_PORTAL_CONFIG_ID ||
    !env.STRIPE_WEBHOOK_SECRET?.match(/^whsec_[A-Za-z0-9]+$/)
  )
    throw Error("billing_worker_and_webhook_configuration_required");
  const appTarget = new URL(env.DATABASE_URL!);
  const billingTarget = new URL(env.BILLING_DATABASE_URL);
  if (
    appTarget.host !== billingTarget.host ||
    appTarget.pathname !== billingTarget.pathname ||
    appTarget.username === billingTarget.username
  )
    throw Error("separate_billing_login_on_same_target_required");
  const provider = stripeSandboxBilling({
    secretKey: env.STRIPE_SECRET_KEY!,
    accountId: env.STRIPE_EXPECTED_ACCOUNT_ID!,
    monthlyPriceId: env.STRIPE_PRICE_PRO_MONTHLY!,
    annualPriceId: env.STRIPE_PRICE_PRO_ANNUAL!,
    appUrl: env.APP_URL!,
    portalConfigurationId: env.STRIPE_PORTAL_CONFIG_ID,
  });
  const sql = postgres(env.BILLING_DATABASE_URL, {
    max: 4,
    connect_timeout: 5,
    idle_timeout: 20,
    connection: { statement_timeout: 10000 },
  });
  await checkBillingRole(sql);
  const store = billingStore(sql);
  let stopped = options.runWorker === false,
    running: Promise<void> | null = null;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      try {
        for (let n = 0; n < 10 && !stopped; n++)
          if (!(await billingTick(store, provider))) break;
      } catch {
        console.error({ code: "billing_worker_retry_pending" });
      } finally {
        running = null;
      }
    })();
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  webhook.post(
    "/",
    express.raw({ type: "application/json", limit: "256kb" }),
    async (req, res, next) => {
      let subscription: string | null, eventId: string;
      try {
        const event = verifyStripeSandboxEvent(
          req.body,
          req.get("stripe-signature") ?? "",
          env.STRIPE_WEBHOOK_SECRET!,
        );
        eventId = event.id;
        subscription = subscriptionEventReference(event);
      } catch {
        return res.status(400).json({ error: "stripe_webhook_invalid" });
      }
      try {
        if (subscription) await store.event(eventId, subscription);
        res.json({ received: true });
        tick();
      } catch (error) {
        next(error);
      }
    },
  );
  routes.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    next();
  });
  routes.use(
    rateLimit({
      windowMs: 60000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  routes.get("/status", async (req, res, next) => {
    try {
      const tenantId = z.uuid().parse(req.query.tenantId);
      const account = await withOwner(
        appSql,
        req.cookies.gm_account ?? "",
        undefined,
        async (_tx, a) => a.id,
      );
      res.json({ enabled: true, ...(await store.status(account, tenantId)) });
    } catch (error) {
      next(error);
    }
  });
  routes.post("/request", async (req, res, next) => {
    try {
      const p = z
        .object({
          tenantId: z.uuid(),
          kind: z.enum(["trial", "checkout", "portal"]),
          interval: z.enum(["month", "year"]),
          consent: z.literal(true),
        })
        .strict()
        .parse(req.body);
      const account = await withOwner(
        appSql,
        req.cookies.gm_account ?? "",
        req.get("x-csrf-token") ?? "",
        async (_tx, a) => a.id,
      );
      res
        .status(202)
        .json(await store.request(account, p.tenantId, p.kind, p.interval));
      tick();
    } catch (error) {
      next(error);
    }
  });
  return {
    routes,
    webhook,
    close: async () => {
      stopped = true;
      clearInterval(timer);
      await running;
      await sql.end();
    },
  };
}
