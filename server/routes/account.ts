import { createHash } from "node:crypto";
import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import type { PreAuthContext, RouteContext } from "../http.js";
import { permit, type AuthRequest } from "../auth.js";
import { requireRecentAuth } from "../access.js";
import { withOwner } from "../owner-accounts.js";
import { clientIp, ipHash, log, requestIdOf, routeLabel } from "../logging.js";
import {
  legalConfig,
  legalDocumentsSummary,
  legalState,
  logLegalStartup,
  recordAcceptances,
  signupOpen,
} from "../legal.js";
import { publicSaasTax, saasTaxConfig } from "../saas-tax.js";
import {
  publicOrderingEnabled,
  restaurantPrivacy,
  saveRestaurantPrivacy,
  setFreeSelectionMode,
} from "../account-settings.js";
import {
  createCoOwnerInvitation,
  leaveCoOwnership,
  removeCoOwner,
  type AccountCtx,
} from "../co-owners.js";
import {
  acceptTransfer,
  cancelTransfer,
  generateRecoveryCodes,
  previewTransfer,
  redeemRecoveryCode,
  requestTransfer,
} from "../ownership-transfer.js";
import {
  accountOverview,
  previewInvitation,
  shellState,
} from "../account-center.js";
import { getTaxProfile, saveTaxProfile } from "../tax-profile.js";
import {
  exportBusy,
  exportGuard,
  exportHandler,
  exportTables,
  requireExportAccess,
} from "../data-export.js";
import type { Tx } from "../db.js";
import { legalVersion } from "../../shared/legal.js";
import { DomainError } from "../../shared/domain.js";

/**
 * express-rate-limit with the platform 429 body ({error:"rate_limited",
 * requestId}, C-7) and a logged ipHash; IP keys use clientIp(req) (LD-9/LD-11).
 */
function limiter(
  name: string,
  limit: number,
  windowMs: number,
  key: (req: express.Request) => string = (req) =>
    ipKeyGenerator(clientIp(req), 56),
  skip: (req: express.Request) => boolean = () => false,
) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: key,
    skip,
    handler: (req, res) => {
      log.warn("rate_limited", {
        limiter: name,
        route: routeLabel(req),
        ipHash: ipHash(clientIp(req)),
      });
      res
        .status(429)
        .json({ error: "rate_limited", requestId: requestIdOf(req) });
    },
  });
}

/** Owner data exports per tenant per hour (spec §2.8). */
const EXPORTS_PER_HOUR = 10;

/** Web configuration, read once at startup (an invalid flag fails startup). */
const legal = legalConfig(process.env);
const saasTax = saasTaxConfig(process.env, "web");
const publicOrdering = publicOrderingEnabled(process.env);

type OwnerFn<T> = (
  tx: Tx,
  account: AccountCtx & { csrf: string },
) => Promise<T>;

/** account area routes that must run before authentication. */
export function registerPreAuth({ app, sql }: PreAuthContext) {
  logLegalStartup(legal, process.env);
  app.get("/api/account-config", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json({
      legal: {
        status: legal.status,
        signupOpen: signupOpen(legal),
        // null unless published: no entity value reaches a client otherwise.
        entity: legal.entity,
        ...(process.env.NODE_ENV !== "production"
          ? { missing: [...legal.missing, ...legal.invalid] }
          : {}),
        documents: legalDocumentsSummary(),
      },
      support: legal.support,
      saasTax: publicSaasTax(saasTax),
      publicOrdering: { enabled: publicOrdering },
    });
  });

  // Mounted after ownerRoutes (server/index.ts), so every non-GET request here
  // first passes access's shared-terminal guard (403 device_is_terminal) and
  // ownerRoutes' own limiter.
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    next();
  });
  const reads = limiter("account_center_read", 60, 60_000);
  const writes = limiter("account_center_write", 30, 60_000);
  /**
   * Runs fn as the signed-in owner account (commands also check the CSRF
   * header). Every registration below passes its own handler inline, so the
   * lock-order scanner (tests/lock-scan.ts) checks each account-center request
   * as its own transaction (ACC-16).
   */
  const answer = async <T>(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
    kind: "read" | "command",
    fn: OwnerFn<T>,
  ) => {
    try {
      res.json(
        await withOwner(
          sql,
          req.cookies?.gm_account ?? "",
          kind === "command" ? (req.get("x-csrf-token") ?? "") : undefined,
          fn,
        ),
      );
    } catch (e) {
      next(e);
    }
  };

  router.get("/", reads, (req, res, next) =>
    answer(req, res, next, "read", (tx, a) =>
      accountOverview(tx, a, legal, saasTax),
    ),
  );
  const acceptInput = z
    .object({
      locale: z.enum(["es", "en"]).default("es"),
      terms: legalVersion.optional(),
      privacy: legalVersion.optional(),
      // A primary's express billing consent, when none was recorded (UX-3).
      billingConsent: legalVersion.optional(),
      dpa: z
        .array(
          z
            .object({ organizationId: z.uuid(), version: legalVersion })
            .strict(),
        )
        .max(10)
        .optional(),
    })
    .strict()
    .refine((v) =>
      Boolean(v.terms || v.privacy || v.dpa?.length || v.billingConsent),
    );
  router.post("/legal/accept", writes, (req, res, next) =>
    answer(req, res, next, "command", async (tx, a) => {
      const p = acceptInput.parse(req.body);
      await recordAcceptances(
        tx,
        a,
        {
          documents: [
            ...(p.terms
              ? [{ document: "terms" as const, version: p.terms }]
              : []),
            ...(p.privacy
              ? [{ document: "privacy" as const, version: p.privacy }]
              : []),
            ...(p.dpa ?? []).map((d) => ({
              document: "dpa" as const,
              version: d.version,
              organizationId: d.organizationId,
            })),
            ...(p.billingConsent
              ? [
                  {
                    document: "billing_consent" as const,
                    version: p.billingConsent,
                  },
                ]
              : []),
          ],
          locale: p.locale,
          context: "reacceptance",
        },
        legal,
      );
      return { legal: await legalState(tx, a.id, legal) };
    }),
  );
  router.post("/invitations/preview", writes, (req, res, next) =>
    answer(req, res, next, "command", (tx, a) =>
      previewInvitation(tx, a, req.body),
    ),
  );
  router.post("/co-owners/invite", writes, (req, res, next) =>
    answer(req, res, next, "command", (tx, a) =>
      createCoOwnerInvitation(tx, a, req.body, legal),
    ),
  );
  router.post("/co-owners/remove", writes, (req, res, next) =>
    answer(req, res, next, "command", (tx, a) =>
      removeCoOwner(tx, a, req.body),
    ),
  );
  router.post("/co-owners/leave", writes, (req, res, next) =>
    answer(req, res, next, "command", (tx, a) =>
      leaveCoOwnership(tx, a, req.body),
    ),
  );
  router.post("/transfers", writes, (req, res, next) =>
    answer(req, res, next, "command", (tx, a) =>
      requestTransfer(tx, a, req.body, legal),
    ),
  );
  router.post("/transfers/preview", writes, (req, res, next) =>
    answer(req, res, next, "command", (tx, a) =>
      previewTransfer(tx, a, req.body, legal),
    ),
  );
  router.post("/transfers/accept", writes, (req, res, next) =>
    answer(req, res, next, "command", (tx, a) =>
      acceptTransfer(tx, a, req.body, legal),
    ),
  );
  router.post("/transfers/cancel", writes, (req, res, next) =>
    answer(req, res, next, "command", (tx, a) =>
      cancelTransfer(tx, a, req.body),
    ),
  );
  router.post("/recovery-codes", writes, (req, res, next) =>
    answer(req, res, next, "command", (tx, a) => generateRecoveryCodes(tx, a)),
  );
  // Redemption: 5 per hour per IP and 5 per hour per Google sign-in, both
  // before withOwner, so a refused attempt costs no transaction.
  const signInKey = (req: express.Request) =>
    "acct:" +
    createHash("sha256")
      .update(String(req.cookies?.gm_account ?? ""))
      .digest("hex");
  router.post(
    "/recovery/redeem",
    limiter("recovery_redeem_ip", 5, 3600_000),
    limiter("recovery_redeem_account", 5, 3600_000, signInKey),
    writes,
    (req, res, next) =>
      answer(req, res, next, "command", (tx, a) =>
        redeemRecoveryCode(tx, a, req.body),
      ),
  );
  router.get("/tax-profile", reads, (req, res, next) =>
    answer(req, res, next, "read", (tx, a) =>
      getTaxProfile(tx, a, z.uuid().parse(req.query.organizationId), saasTax),
    ),
  );
  router.post("/tax-profile", writes, (req, res, next) =>
    answer(req, res, next, "command", (tx, a) =>
      saveTaxProfile(tx, a, req.body, saasTax, legal),
    ),
  );
  app.use("/api/auth/account-center", router);
}

/** account area authenticated routes; use ctx.route for tenant-scoped handlers. */
export function register({ app, sql, route }: RouteContext) {
  route("get", "/account/shell", (tx, s) => shellState(tx, s, legal));
  route("get", "/account/restaurant-privacy", (tx, s) =>
    restaurantPrivacy(tx, s),
  );
  // Privacy and configuration: no requireSelling, so they work on Free and on
  // unselected devices; a shared terminal needs a recent owner PIN.
  route("post", "/account/restaurant-privacy", async (tx, s, req) => {
    permit(s, ["owner"]);
    requireRecentAuth(s);
    return saveRestaurantPrivacy(tx, s, req.body);
  });
  route("post", "/account/free-selection/mode", async (tx, s, req) => {
    permit(s, ["owner"]);
    requireRecentAuth(s);
    return setFreeSelectionMode(tx, s, req.body);
  });

  // Owner data export: permit(owner) and the step-up run before the limiter,
  // so a step_up_required refusal is not counted (access R3); 10 per hour per
  // tenant; on Free, after a lapse and on unselected devices too. A download
  // refused as export_busy is not counted either (ACC-9).
  const exportKey = (tenantId: string) => "tenant:" + tenantId;
  const exportLimit = limiter(
    "account_export",
    EXPORTS_PER_HOUR,
    3600_000,
    (req) => exportKey((req as AuthRequest).session.tenantId),
    (req) => exportBusy((req as AuthRequest).session.tenantId),
  );
  // The client calls this first (step-up, then the download link). It also
  // refuses while an export is running or the hourly budget is spent, so the
  // browser never starts a download that would save an error body (ACC-9).
  route("get", "/account-data/tables", async (tx, s) => {
    requireExportAccess(s);
    if (exportBusy(s.tenantId)) throw new DomainError("export_busy", 429);
    const used = await exportLimit.getKey(exportKey(s.tenantId));
    if ((used?.totalHits ?? 0) >= EXPORTS_PER_HOUR)
      throw new DomainError("rate_limited", 429);
    return (await exportTables(tx)).map((t) => ({
      name: t.name,
      columns: t.columns.length,
    }));
  });
  const guard = exportGuard();
  app.get(
    "/api/account-data/export.json",
    guard,
    exportLimit,
    exportHandler(sql, "json"),
  );
  app.get(
    "/api/account-data/export/csv/:table",
    guard,
    exportLimit,
    exportHandler(sql, "csv"),
  );
}
