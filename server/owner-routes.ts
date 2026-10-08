import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type postgres from "postgres";
import { cookieOptions, sign } from "./auth.js";
import { clientIp } from "./logging.js";
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
import { legalConfig, legalState, signupOpen } from "./legal.js";
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
  // account (031): new Google accounts wait for the published legal documents.
  const legal = legalConfig(process.env);
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
  // Reads (including the account console's overview, account 031) share the
  // 120/min budget; every other request shares 30/min. The account-center
  // router adds its own read and command limits behind these. Both key on the
  // real client (clientIp, IPv6 per /56), not on req.ip, which behind
  // Railway's edge is the edge hop (LD-46).
  const ownerRead = (req: Request) =>
    req.method === "GET" &&
    (["/providers", "/account", "/account/invitations"].includes(req.path) ||
      /^\/account-center(\/|$)/i.test(req.path));
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => ipKeyGenerator(clientIp(req), 56),
      skip: ownerRead,
    }),
  );
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => ipKeyGenerator(clientIp(req), 56),
      skip: (req) => !ownerRead(req),
    }),
  );
  // GAP-2: a shared terminal never starts Google sign-in or owner account
  // commands, even if its UI is bypassed. The refusal is attached with the
  // router's own matching (route middleware and prefix mounts), never by
  // comparing raw path strings, so case variants, a trailing slash and HEAD
  // (which runs GET routes) reach it exactly as they reach the handlers.
  const refuseOnTerminal =
    (mode: "redirect" | "error"): RequestHandler =>
    async (req, res, next) => {
      try {
        // Fails closed: a failed device lookup refuses instead of allowing.
        if (!(await isTerminalRequest(sql, req.cookies ?? {}, true)))
          return next();
        if (mode === "redirect")
          return res.redirect(303, "/app?auth_error=terminal");
        next(new DomainError("device_is_terminal", 403));
      } catch (error) {
        next(error);
      }
    };
  const refuseCommand = refuseOnTerminal("error");
  // Every non-GET request under /account and /account-center (wave 2, R2:
  // account mounts that router after this one, so an unmatched request runs
  // this guard first), including routes added later.
  router.use(["/account", "/account-center"], (req, res, next) =>
    req.method === "GET" || req.method === "HEAD"
      ? next()
      : refuseCommand(req, res, next),
  );
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
  router.get(
    "/google/start",
    refuseOnTerminal("redirect"),
    async (_req, res, next) => {
      if (!google) return res.status(503).json({ error: "google_unavailable" });
      try {
        const flow = await google.begin();
        res.cookie("gm_google_flow", flow.browserToken, flowCookie);
        res.redirect(303, flow.url);
      } catch (error) {
        next(error);
      }
    },
  );
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
      const cookie = await signInGoogleOwner(sql, identity, {
        allowNewAccounts: signupOpen(legal),
      });
      res.cookie("gm_account", cookie, {
        ...cookieOptions,
        maxAge: 12 * 3600_000,
      });
      // Existing restaurant sessions are not silently switched by an OAuth callback.
      res.redirect(303, "/app?account=1");
    } catch (e) {
      res.redirect(
        303,
        "/app?auth_error=" +
          (e instanceof DomainError && e.code === "signup_paused"
            ? "signup_paused"
            : "google_login_failed"),
      );
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
          // account (031): co-owned organizations carry role 'co_owner'.
          organizations:
            await tx`select o.id,o.name,'primary'::text as role from organizations o
              where o.created_by_account=${account.id}
            union all
            select o.id,o.name,'co_owner'::text as role from organization_co_owners c
              join organizations o on o.id=c.organization_id
             where c.account_id=${account.id} and c.removed_at is null`,
          restaurants:
            await tx`select r.id,r.name,r.currency,r.timezone,r.organization_id,r.activation_pending,r.free_location from restaurants r join owner_memberships m on m.tenant_id=r.id where m.account_id=${account.id} and m.revoked_at is null`,
          legal: await legalState(tx, account.id, legal),
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
      await enterRestaurant(req, res);
    } catch (error) {
      if (
        error instanceof DomainError &&
        error.code === "owner_reauth_required"
      ) {
        // This Google sign-in predates the device's revocation: end it, so the
        // browser must sign in with Google again (A6).
        try {
          await withOwner(
            sql,
            req.cookies.gm_account ?? "",
            undefined,
            (tx, a) =>
              tx`update owner_sessions set revoked=true where id=${a.sessionId}`,
          );
        } catch {
          /* Already invalid: nothing left to end. */
        }
        res.clearCookie("gm_account", cookieOptions);
      }
      next(error);
    }
  });
  async function enterRestaurant(req: Request, res: Response) {
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
      // The browser's personal device expired, or was revoked before this
      // Google sign-in: issue a fresh browser identity once.
      if (!(
        error instanceof DomainError && error.code === "owner_browser_reset"
      ))
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
  }
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
          (tx, account) => revokeInvitation(tx, account.id, req.body),
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
