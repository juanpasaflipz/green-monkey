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
import { waitForDatabase } from "./db.js";
import { poolOptions, withoutParams } from "./db-support.js";
import { log } from "./logging.js";
import { legalConfig, requireCurrentLegal } from "./legal.js";
import { saasTaxConfig } from "./saas-tax.js";

/** The billing capability login on the same database as the runtime role. */
function billingPool(env: NodeJS.ProcessEnv, applicationName: string) {
  if (!env.BILLING_DATABASE_URL)
    throw Error("billing_worker_and_webhook_configuration_required");
  const billingTarget = new URL(env.BILLING_DATABASE_URL);
  if (env.DATABASE_URL) {
    const appTarget = new URL(env.DATABASE_URL);
    if (
      appTarget.host !== billingTarget.host ||
      appTarget.pathname !== billingTarget.pathname ||
      appTarget.username === billingTarget.username
    )
      throw Error("separate_billing_login_on_same_target_required");
  }
  return postgres(
    withoutParams(billingTarget).href,
    poolOptions(billingTarget, { max: 4, applicationName }),
  );
}

/**
 * Web half of billing (DB-1 credential split): owner routes and the Stripe
 * webhook record requests and event pointers through the billing capability
 * login. Provider calls, and the Stripe secret key, live only in the worker
 * (billingWorker), which polls for pending operations. `options` is accepted
 * for compatibility; the provider loop never runs in the web process.
 */
export async function billingRuntime(
  appSql: postgres.Sql,
  env: NodeJS.ProcessEnv,
  _options: { runWorker?: boolean } = {},
) {
  const enabled = env.BILLING_SANDBOX_ENABLED === "true";
  const routes = Router(),
    webhook = Router();
  if (!enabled) {
    routes.get("/status", (_req, res) => res.json({ enabled: false }));
    return { routes, webhook, close: async () => {} };
  }
  if (!env.STRIPE_WEBHOOK_SECRET?.match(/^whsec_[A-Za-z0-9]+$/))
    throw Error("billing_worker_and_webhook_configuration_required");
  const sql = billingPool(env, "gm-web-billing");
  await waitForDatabase(sql, { check: checkBillingRole });
  const store = billingStore(sql);
  // account (031): billing requests need the current terms, privacy notice and DPA.
  const legal = legalConfig(env);
  // Pending operations and events are picked up by the worker's next tick
  // (every 2 s), so routes no longer trigger provider work in-process.
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
        async (tx, a) => {
          await requireCurrentLegal(tx, a.id, legal);
          return a.id;
        },
      );
      res
        .status(202)
        .json(await store.request(account, p.tenantId, p.kind, p.interval));
    } catch (error) {
      next(error);
    }
  });
  routes.post("/locations/quote", async (req, res, next) => {
    try {
      const p = z.object({ tenantId: z.uuid() }).strict().parse(req.body);
      const account = await withOwner(
        appSql,
        req.cookies.gm_account ?? "",
        req.get("x-csrf-token") ?? "",
        async (tx, a) => {
          await requireCurrentLegal(tx, a.id, legal);
          return a.id;
        },
      );
      res.status(202).json(await store.quoteLocation(account, p.tenantId));
    } catch (error) {
      next(error);
    }
  });
  routes.post("/locations/confirm", async (req, res, next) => {
    try {
      const p = z
        .object({ quoteId: z.uuid(), consent: z.literal(true) })
        .strict()
        .parse(req.body);
      const account = await withOwner(
        appSql,
        req.cookies.gm_account ?? "",
        req.get("x-csrf-token") ?? "",
        async (tx, a) => {
          await requireCurrentLegal(tx, a.id, legal);
          return a.id;
        },
      );
      res.status(202).json(await store.confirmLocation(account, p.quoteId));
    } catch (error) {
      next(error);
    }
  });
  return {
    routes,
    webhook,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/** SAAS_TAX_MODE for the worker's Stripe provider (account 031, GAP-6). */
function providerTax(env: NodeJS.ProcessEnv) {
  const c = saasTaxConfig(env, "worker");
  return { mode: c.mode, taxRateId: c.taxRateId, collectTaxId: c.collectTaxId };
}

/**
 * Worker half of billing: the Stripe provider and the operation loop
 * (signup intents, reconcile scheduling, claim and complete). Holds the
 * Stripe secret key; never runs in the web process.
 */
export async function billingWorker(
  env: NodeJS.ProcessEnv,
  o: { intervalMs?: number; runLoop?: boolean } = {},
) {
  if (!env.STRIPE_PORTAL_CONFIG_ID)
    throw Error("billing_worker_and_webhook_configuration_required");
  const provider = stripeSandboxBilling({
    secretKey: env.STRIPE_SECRET_KEY!,
    accountId: env.STRIPE_EXPECTED_ACCOUNT_ID!,
    monthlyPriceId: env.STRIPE_PRICE_PRO_MONTHLY!,
    annualPriceId: env.STRIPE_PRICE_PRO_ANNUAL!,
    appUrl: env.APP_URL!,
    portalConfigurationId: env.STRIPE_PORTAL_CONFIG_ID,
    tax: providerTax(env),
  });
  const sql = billingPool(env, "gm-worker-billing");
  await waitForDatabase(sql, { check: checkBillingRole });
  const store = billingStore(sql);
  let stopped = o.runLoop === false,
    running: Promise<void> | null = null,
    lastTickAt: number | null = null;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      try {
        for (let n = 0; n < 10 && !stopped; n++)
          if (!(await billingTick(store, provider))) break;
        lastTickAt = Date.now();
      } catch (error) {
        // Provider error bodies and hosted URLs never reach the logs.
        log.warn("billing_worker_retry_pending", {
          code: (error as { code?: unknown })?.code,
        });
      } finally {
        running = null;
      }
    })();
  };
  const timer = setInterval(tick, o.intervalMs ?? 2000);
  timer.unref();
  tick();
  return {
    sql,
    tick,
    lastTickAt: () => lastTickAt,
    close: async () => {
      stopped = true;
      clearInterval(timer);
      await running;
      await sql.end({ timeout: 5 });
    },
  };
}
