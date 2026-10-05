import { Router } from "express";
import rateLimit from "express-rate-limit";
import type postgres from "postgres";
import { cookieOptions, sign } from "./auth.js";
import { isTerminalRequest } from "./access.js";
import { DomainError } from "../shared/domain.js";
import { googleConfig, googleIdentityService } from "./google-identity.js";
import { googleAttemptStore } from "./google-attempt-store.js";
import {
  createOwnerRestaurant,
  enterOwnerRestaurant,
  signInGoogleOwner,
  withOwner,
  ownerBrowserCookie,
} from "./owner-accounts.js";
import {
  selectFreeLocation,
  createAdditionalLocation,
  createInvitation,
  listInvitations,
  revokeInvitation,
  acceptInvitation,
} from "./owner-management.js";

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
      skip: (req) =>
        req.method === "GET" &&
        ["/providers", "/account", "/account/invitations"].includes(req.path),
    }),
  );
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) =>
        req.method !== "GET" ||
        !["/providers", "/account", "/account/invitations"].includes(req.path),
    }),
  );
  // GAP-2: a shared terminal never starts Google sign-in or owner account
  // commands, even if its UI is bypassed (covers future /account/* routes too).
  router.use(async (req, res, next) => {
    const guarded =
      (req.method === "GET" && req.path === "/google/start") ||
      (req.method === "POST" && req.path.startsWith("/account/"));
    if (!guarded) return next();
    try {
      if (!(await isTerminalRequest(sql, req.cookies ?? {}))) return next();
      if (req.path === "/google/start")
        return res.redirect(303, "/app?auth_error=terminal");
      next(new DomainError("device_is_terminal", 403));
    } catch (error) {
      next(error);
    }
  });
  router.get("/providers", async (req, res, next) => {
    try {
      const terminal = await isTerminalRequest(sql, req.cookies ?? {});
      res.json({
        google: Boolean(google) && !terminal,
        terminal,
        apple: false,
        billingSandbox: process.env.BILLING_SANDBOX_ENABLED === "true",
      });
    } catch (error) {
      next(error);
    }
  });
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
          organizations:
            await tx`select id,name from organizations where created_by_account=${account.id}`,
          restaurants:
            await tx`select r.id,r.name,r.currency,r.timezone,r.organization_id,r.activation_pending,r.free_location from restaurants r join owner_memberships m on m.tenant_id=r.id where m.account_id=${account.id}`,
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
      let browser = ownerBrowserCookie(req.cookies.gm_owner_browser);
      const enter = () =>
        withOwner(
          sql,
          req.cookies.gm_account ?? "",
          req.get("x-csrf-token") ?? "",
          (tx, account) =>
            enterOwnerRestaurant(
              tx,
              account.id,
              req.body.tenantId,
              account.sessionId,
              browser,
            ),
        );
      let result;
      try {
        result = await enter();
      } catch (error) {
        // The browser's personal device was revoked or expired: Google identity
        // is re-verified by gm_account, so issue a fresh browser identity once.
        if (!(error instanceof DomainError && error.code === "owner_browser_reset"))
          throw error;
        browser = ownerBrowserCookie(undefined);
        result = await enter();
      }
      res.cookie("gm_owner_browser", sign(browser), {
        ...cookieOptions,
        maxAge: 30 * 86400_000,
      });
      res.cookie("gm_device", sign(result.device), {
        ...cookieOptions,
        maxAge: 30 * 86400_000,
      });
      res.cookie("gm_session", sign(result.session), {
        ...cookieOptions,
        maxAge: Math.max(0, result.absoluteExpiresAt.getTime() - Date.now()),
      });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  router.post("/account/free-location", async (req, res, next) => {
    try {
      res.json(
        await withOwner(
          sql,
          req.cookies.gm_account ?? "",
          req.get("x-csrf-token") ?? "",
          (tx, a) => selectFreeLocation(tx, a.id, req.body.tenantId),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post("/account/locations", async (req, res, next) => {
    try {
      res.json(
        await withOwner(
          sql,
          req.cookies.gm_account ?? "",
          req.get("x-csrf-token") ?? "",
          (tx, account) => createAdditionalLocation(tx, account, req.body),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post("/account/invitations", async (req, res, next) => {
    try {
      res.json(
        await withOwner(
          sql,
          req.cookies.gm_account ?? "",
          req.get("x-csrf-token") ?? "",
          (tx, account) => createInvitation(tx, account.id, req.body),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  router.get("/account/invitations", async (req, res, next) => {
    try {
      res.json(
        await withOwner(
          sql,
          req.cookies.gm_account ?? "",
          undefined,
          (tx, account) =>
            listInvitations(tx, account.id, String(req.query.tenantId ?? "")),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post("/account/invitations/revoke", async (req, res, next) => {
    try {
      res.json(
        await withOwner(
          sql,
          req.cookies.gm_account ?? "",
          req.get("x-csrf-token") ?? "",
          (tx, account) => revokeInvitation(tx, account.id, req.body.id),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post("/account/invitations/accept", async (req, res, next) => {
    try {
      res.json(
        await withOwner(
          sql,
          req.cookies.gm_account ?? "",
          req.get("x-csrf-token") ?? "",
          (tx, account) => acceptInvitation(tx, account, req.body),
        ),
      );
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
      res.clearCookie("gm_session", cookieOptions);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
