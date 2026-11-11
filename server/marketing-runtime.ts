import postgres from "postgres";
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { tenant } from "./db.js";
import { verify } from "./auth.js";
import { setConsent } from "./guests.js";
import { channelStatus } from "./marketing.js";
import {
  checkMarketingRole,
  marketingTick,
  providersFromEnv,
} from "./marketing-delivery.js";
import { DomainError } from "../shared/domain.js";
import { marketingChannels } from "../shared/marketing.js";

/** Public, token-scoped guest endpoints: unsubscribe only. */
export function guestRoutes(appSql: postgres.Sql) {
  const routes = Router();
  routes.use(
    rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  const claim = (token: string) => {
    const c = verify(token);
    if (
      c.purpose !== "unsubscribe" ||
      !(marketingChannels as readonly string[]).includes(c.channel)
    )
      throw new DomainError("unauthorized", 401);
    return c as {
      tenantId: string;
      guestId: string;
      channel: (typeof marketingChannels)[number];
    };
  };
  const column = {
    email: "email_opt_in",
    sms: "sms_opt_in",
    whatsapp: "whatsapp_opt_in",
  } as const;
  routes.get("/unsubscribe/:token", async (req, res, next) => {
    try {
      const c = claim(req.params.token);
      res.json(
        await tenant(appSql, c.tenantId, async (tx) => {
          const [row] =
            await tx`select r.name,g.email_opt_in,g.sms_opt_in,g.whatsapp_opt_in from guests g join restaurants r on r.id=g.tenant_id where g.id=${c.guestId}`;
          if (!row) throw new DomainError("not_found", 404);
          return {
            restaurant: row.name,
            channel: c.channel,
            subscribed: row[column[c.channel]],
          };
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  // Also the RFC 8058 one-click target, which posts a form body.
  routes.post(
    "/unsubscribe/:token",
    express.urlencoded({ extended: false, limit: "1kb" }),
    async (req, res, next) => {
      try {
        const c = claim(req.params.token);
        await tenant(appSql, c.tenantId, (tx) =>
          setConsent(
            tx,
            c.tenantId,
            c.guestId,
            c.channel,
            false,
            "unsubscribe_link",
            null,
          ),
        );
        res.json({ channel: c.channel, subscribed: false });
      } catch (e) {
        next(e);
      }
    },
  );
  return routes;
}

export async function marketingRuntime(
  env: NodeJS.ProcessEnv,
  options: { runWorker?: boolean } = {},
) {
  const status = channelStatus(env);
  const appUrl = (env.APP_URL ?? "").replace(/\/+$/, "");
  if (!env.MARKETING_DATABASE_URL)
    return { status, appUrl, close: async () => {} };
  const appTarget = new URL(env.DATABASE_URL!);
  const workerTarget = new URL(env.MARKETING_DATABASE_URL);
  if (
    appTarget.host !== workerTarget.host ||
    appTarget.pathname !== workerTarget.pathname ||
    appTarget.username === workerTarget.username
  )
    throw Error("separate_marketing_login_on_same_target_required");
  const sql = postgres(env.MARKETING_DATABASE_URL, {
    max: 2,
    connect_timeout: 5,
    idle_timeout: 20,
    connection: { statement_timeout: 20000 },
  });
  await checkMarketingRole(sql);
  const providers = providersFromEnv(env, status);
  let stopped = options.runWorker === false,
    running: Promise<void> | null = null;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      try {
        await marketingTick(sql, providers, status, appUrl);
      } catch {
        console.error({ code: "marketing_worker_retry_pending" });
      } finally {
        running = null;
      }
    })();
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  tick();
  return {
    status,
    appUrl,
    close: async () => {
      stopped = true;
      clearInterval(timer);
      await running;
      await sql.end();
    },
  };
}
