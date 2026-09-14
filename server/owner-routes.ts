import { Router } from "express";
import rateLimit from "express-rate-limit";
import type postgres from "postgres";
import { cookieOptions, sign } from "./auth.js";
import { googleConfig, googleIdentityService } from "./google-identity.js";
import { googleAttemptStore } from "./google-attempt-store.js";
import {
  createOwnerRestaurant,
  enterOwnerRestaurant,
  signInGoogleOwner,
  withOwner,
} from "./owner-accounts.js";

export function ownerRoutes(sql: postgres.Sql) {
  const router = Router();
  const config = googleConfig(process.env);
  const google = config
    ? googleIdentityService(config, googleAttemptStore(sql))
    : null;
  const flowCookie = {
    ...cookieOptions,
    sameSite: "lax" as const,
    path: "/api/auth/google/callback",
    maxAge: 600_000,
  };
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    next();
  });
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  router.get("/providers", (_req, res) =>
    res.json({
      google: Boolean(google),
      apple: false,
      billingSandbox: process.env.BILLING_SANDBOX_ENABLED === "true",
    }),
  );
  router.get("/google/start", async (_req, res, next) => {
    if (!google) return res.status(503).json({ error: "google_unavailable" });
    try {
      const flow = await google.begin();
      res.cookie("gm_google_flow", flow.browserToken, flowCookie);
      res.redirect(303, flow.url);
    } catch (error) {
      next(error);
    }
  });
  router.get("/google/callback", async (req, res) => {
    res.clearCookie("gm_google_flow", { ...flowCookie, maxAge: undefined });
    try {
      if (
        !google ||
        typeof req.query.state !== "string" ||
        typeof req.query.code !== "string" ||
        req.query.error
      )
        throw Error();
      const identity = await google.complete({
        state: req.query.state,
        code: req.query.code,
        browserToken: req.cookies.gm_google_flow ?? "",
      });
      const cookie = await signInGoogleOwner(sql, identity);
      res.cookie("gm_account", cookie, {
        ...cookieOptions,
        maxAge: 12 * 3600_000,
      });
      // Existing restaurant sessions are not silently switched by an OAuth callback.
      res.redirect(303, "/app?account=1");
    } catch {
      res.redirect(303, "/app?auth_error=google_login_failed");
    }
  });
  router.get("/account", async (req, res, next) => {
    try {
      const result = await withOwner(
        sql,
        req.cookies.gm_account ?? "",
        undefined,
        async (tx, account) => ({
          name: account.name,
          email: account.email,
          csrf: account.csrf,
          restaurants:
            await tx`select r.id,r.name,r.currency,r.timezone from restaurants r join owner_memberships m on m.tenant_id=r.id where m.account_id=${account.id}`,
        }),
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  });
  router.post("/account/signup", async (req, res, next) => {
    try {
      res.json(
        await withOwner(
          sql,
          req.cookies.gm_account ?? "",
          req.get("x-csrf-token") ?? "",
          (tx, account) => createOwnerRestaurant(tx, account, req.body),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post("/account/enter", async (req, res, next) => {
    try {
      const result = await withOwner(
        sql,
        req.cookies.gm_account ?? "",
        req.get("x-csrf-token") ?? "",
        (tx, account) =>
          enterOwnerRestaurant(
            tx,
            account.id,
            req.body.tenantId,
            account.sessionId,
          ),
      );
      res.cookie("gm_device", sign(result.device), {
        ...cookieOptions,
        maxAge: 30 * 86400_000,
      });
      res.cookie("gm_session", sign(result.session), {
        ...cookieOptions,
        maxAge: 12 * 3600_000,
      });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  router.post("/account/logout", async (req, res, next) => {
    try {
      await withOwner(
        sql,
        req.cookies.gm_account ?? "",
        req.get("x-csrf-token") ?? "",
        async (tx, account) => {
          await tx`update owner_sessions set revoked=true where id=${account.sessionId}`;
        },
      );
      res.clearCookie("gm_account", cookieOptions);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
