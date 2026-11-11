/**
 * Guest marketing routes (047, docs/MARKETING.md).
 *
 * Pre-auth: /api/club/marketing/confirm, the double opt-in link. The token travels only in
 * the x-gm-marketing-token header (the page keeps it in the URL fragment), is screened by
 * shape before any database work and is rate limited per IP. Replies are no-store.
 *
 * Authenticated: /api/marketing/*, managers and owners only, each through route().
 */
import { createHash } from "node:crypto";
import express from "express";
import type { PreAuthContext, RouteContext } from "../http.js";
import { tenant } from "../db.js";
import { DomainError } from "../../shared/domain.js";
import { publicLimiter } from "../public-limits.js";
import { CONFIRM_HEADER, CONFIRM_TOKEN } from "../../shared/marketing.js";
import {
  cancelCampaign,
  confirmMarketing,
  getMarketing,
  launchCampaign,
  listAutomations,
  listCampaigns,
  performance,
  previewAudience,
  saveAutomation,
  saveCampaign,
  saveMarketing,
} from "../marketing/core.js";

export function registerPreAuth({ app, sql }: PreAuthContext) {
  const router = express.Router();
  router.post(
    "/confirm",
    publicLimiter("club-marketing-confirm", { limit: 20 }),
    async (req, res, next) => {
      try {
        res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
        const token = req.get(CONFIRM_HEADER) ?? "";
        if (!CONFIRM_TOKEN.test(token))
          throw new DomainError("unauthorized", 401);
        const [tenantId, memberId] = token.split(".");
        res.json(
          await tenant(sql, tenantId, (tx) =>
            confirmMarketing(
              tx,
              memberId,
              createHash("sha256").update(token).digest("hex"),
            ),
          ),
        );
      } catch (e) {
        next(e);
      }
    },
  );
  app.use("/api/club/marketing", router);
}

export function register({ route }: RouteContext) {
  route("get", "/marketing", (tx, s) => getMarketing(tx, s, process.env));
  route("post", "/marketing/settings", (tx, s, req) =>
    saveMarketing(tx, s, req.body),
  );
  route("post", "/marketing/audience", (tx, s, req) =>
    previewAudience(tx, s, req.body),
  );
  route("get", "/marketing/campaigns", (tx, s) => listCampaigns(tx, s));
  route("post", "/marketing/campaigns", (tx, s, req) =>
    saveCampaign(tx, s, req.body),
  );
  route("post", "/marketing/campaigns/launch", (tx, s, req) =>
    launchCampaign(tx, s, req.body, process.env),
  );
  route("post", "/marketing/campaigns/cancel", (tx, s, req) =>
    cancelCampaign(tx, s, req.body),
  );
  route("get", "/marketing/automations", (tx, s) => listAutomations(tx, s));
  route("post", "/marketing/automations", (tx, s, req) =>
    saveAutomation(tx, s, req.body),
  );
  route("get", "/marketing/performance", (tx, s, req) =>
    performance(tx, s, req.query),
  );
}
