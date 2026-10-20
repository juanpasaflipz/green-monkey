/**
 * Loyalty club routes (038, specs/loyalty-w4.md §4.8, §4.9).
 *
 * Pre-auth (registerPreAuth, before authentication): the diner's /club page at /api/club. The
 * join token travels only in the x-gm-join-token header (the page keeps it in the URL fragment),
 * never in a path; it is screened by shape before any database work, on its own per-IP bucket;
 * then per-IP and per-(IP, token) limiters keyed by clientIp (LD-46/49). Every reply is no-store.
 * The kiosk's member route is kiosk's (039, R20); loyalty exports its functions (loyalty/kiosk.ts).
 *
 * Authenticated (register): /api/loyalty/*, each through route() (one tenant transaction). Every
 * command runs permit first (kitchen: forbidden before any work), then Pro and the club check.
 * Writes are POST (route() registers GET and POST; the spec's PUT and PATCH are POST paths here),
 * and so are the lookups by phone or name (members/lookup, members/search, members/list).
 * The report reads one REPEATABLE READ snapshot (reports' snapshotTenant).
 */
import { registerCards, registerEngagement } from "../loyalty/card-routes.js";
import { createHash } from "node:crypto";
import express from "express";
import type { PreAuthContext, RouteContext } from "../http.js";
import type { AuthRequest } from "../auth.js";
import { DomainError, id } from "../../shared/domain.js";
import { publicLimiter } from "../public-limits.js";
import { JOIN_HEADER, SEALED_TOKEN } from "../../shared/loyalty.js";
import { snapshotTenant } from "../reports/snapshot.js";
import { joinOrder, joinView } from "../loyalty/join.js";
import {
  getLoyaltySettings,
  saveLoyaltySettings,
} from "../loyalty/settings.js";
import {
  adjustMember,
  deleteMember,
  enrollMember,
  listMembers,
  lookupByPhone,
  memberDataSheet,
  memberDetail,
  searchByName,
  updateMember,
} from "../loyalty/members.js";
import {
  changeOrderMember,
  getOrderLoyalty,
  linkOrderMember,
  receiptLoyalty,
  reconcileOrderRoute,
} from "../loyalty/links.js";
import { redeemReward } from "../loyalty/rewards.js";
import {
  commitLoyaltyImportPage,
  importStatus,
} from "../loyalty/import.js";
import { loyaltyReport } from "../loyalty/reports.js";

/** Requests per minute (§4.8; kioskLookupPerIp: critic R20, binding). */
export const CLUB_RATES = {
  viewPerIp: 60,
  malformedPerIp: 30,
  joinPerIp: 10,
  joinPerIpToken: 5,
  kioskLookupPerIp: 20,
} as const;

/**
 * Kiosk (039, R20): the per-IP limiter (clientIp) its member-lookup route mounts in front of
 * lookupMemberForKiosk, beside its own 5-per-device-per-5-minutes bucket. A copied binding cookie
 * behind rotating devices is still held to 20 lookups a minute per IP (LOYALTY-PRIVACY-10).
 */
export const kioskMemberLimiter = () =>
  publicLimiter("club-kiosk", { limit: CLUB_RATES.kioskLookupPerIp });

/** A 22-character digest of a well-formed join token: public-limits keys it per (IP, token). */
const tokenScope = (v: string) =>
  SEALED_TOKEN.test(v)
    ? createHash("sha256").update(v).digest("base64url").slice(0, 22)
    : "-";

/** The /api/club router (created per call so tests get fresh limiter stores). */
export function clubRouter(sql: PreAuthContext["sql"]) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    next();
  });
  const token = (req: express.Request) => req.get(JOIN_HEADER) ?? "";
  const screen: express.RequestHandler = (req, res, next) => {
    res.locals.malformed = !SEALED_TOKEN.test(token(req));
    next();
  };
  const malformedLimit = publicLimiter("club-malformed", {
    limit: CLUB_RATES.malformedPerIp,
    skip: (_req, res) => !res.locals.malformed,
  });
  const refuseMalformed: express.RequestHandler = (_req, res, next) =>
    next(
      res.locals.malformed
        ? new DomainError("unauthorized", 401)
        : undefined,
    );
  const viewLimit = publicLimiter("club-view", {
    limit: CLUB_RATES.viewPerIp,
  });
  const joinIpLimit = publicLimiter("club-join-ip", {
    limit: CLUB_RATES.joinPerIp,
  });
  const joinTokenLimit = publicLimiter("club-join", {
    limit: CLUB_RATES.joinPerIpToken,
    scope: (req) => tokenScope(token(req)),
  });
  const run =
    (fn: (req: express.Request) => Promise<unknown>): express.RequestHandler =>
    async (req, res, next) => {
      try {
        res.json(await fn(req));
      } catch (e) {
        next(e);
      }
    };
  router.get(
    "/join",
    screen,
    malformedLimit,
    refuseMalformed,
    viewLimit,
    run((req) => joinView(sql, token(req))),
  );
  router.post(
    "/join",
    screen,
    malformedLimit,
    refuseMalformed,
    joinIpLimit,
    joinTokenLimit,
    run((req) => joinOrder(sql, token(req), req.body)),
  );
  router.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  return router;
}

export function registerPreAuth({ app, sql }: PreAuthContext) {
  registerCards({ app, sql });
  app.use("/api/club", clubRouter(sql));
}

export function register({ app, sql, route }: RouteContext) {
  registerEngagement({ app, sql, route });
  route("get", "/loyalty/settings", (tx, s) => getLoyaltySettings(tx, s));
  route("post", "/loyalty/settings", (tx, s, req) =>
    saveLoyaltySettings(tx, s, req.body),
  );
  // Lookups carry a phone or a name: always in a POST body, never in a URL, so no edge or
  // access log ever holds one (LFPDPPP, §2.11). They write nothing.
  route("post", "/loyalty/members/lookup", (tx, s, req) =>
    lookupByPhone(tx, s, req.body),
  );
  route("post", "/loyalty/members/search", (tx, s, req) =>
    searchByName(tx, s, req.body),
  );
  route("post", "/loyalty/members/list", (tx, s, req) =>
    listMembers(tx, s, req.body),
  );
  route("post", "/loyalty/members", (tx, s, req) =>
    enrollMember(tx, s, req.body),
  );
  route("get", "/loyalty/members/:id", (tx, s, req) =>
    memberDetail(tx, s, id.parse(req.params.id)),
  );
  route("get", "/loyalty/members/:id/sheet", (tx, s, req) =>
    memberDataSheet(tx, s, id.parse(req.params.id)),
  );
  route("post", "/loyalty/members/:id/update", (tx, s, req) =>
    updateMember(tx, s, id.parse(req.params.id), req.body),
  );
  route("post", "/loyalty/members/:id/adjust", (tx, s, req) =>
    adjustMember(tx, s, id.parse(req.params.id), req.body),
  );
  route("post", "/loyalty/members/:id/delete", (tx, s, req) =>
    deleteMember(tx, s, id.parse(req.params.id), req.body),
  );
  route("get", "/loyalty/orders/:orderId", (tx, s, req) =>
    getOrderLoyalty(tx, s, id.parse(req.params.orderId)),
  );
  route("post", "/loyalty/orders/:orderId/member", (tx, s, req) =>
    linkOrderMember(tx, s, id.parse(req.params.orderId), req.body),
  );
  route("post", "/loyalty/orders/:orderId/member/change", (tx, s, req) =>
    changeOrderMember(tx, s, id.parse(req.params.orderId), req.body),
  );
  route("post", "/loyalty/orders/:orderId/reconcile", (tx, s, req) =>
    reconcileOrderRoute(tx, s, id.parse(req.params.orderId)),
  );
  route("post", "/loyalty/orders/:orderId/reward", (tx, s, req) =>
    redeemReward(tx, s, id.parse(req.params.orderId), req.body),
  );
  route("get", "/loyalty/orders/:orderId/receipt", (tx, s, req) =>
    receiptLoyalty(tx, s, id.parse(req.params.orderId)),
  );
  route("post", "/loyalty/import/commit", (tx, s, req) =>
    commitLoyaltyImportPage(tx, s, req.body),
  );
  route("get", "/loyalty/import/:batchId", (tx, s, req) =>
    importStatus(tx, s, id.parse(req.params.batchId)),
  );
  // The report: one read-only snapshot (no tenant() retry needed), never cached.
  app.get("/api/loyalty/report", async (req, res, next) => {
    try {
      const s = (req as AuthRequest).session;
      const out = await snapshotTenant(sql, s.tenantId, (tx) =>
        loyaltyReport(tx, s, req.query as { from?: unknown; to?: unknown }),
      );
      res.set("Cache-Control", "no-store");
      res.json(out);
    } catch (e) {
      next(e);
    }
  });
}
