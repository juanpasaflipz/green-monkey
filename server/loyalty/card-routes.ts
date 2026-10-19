import express from "express";
import { z } from "zod";
import type { PreAuthContext, RouteContext } from "../http.js";
import { tenant } from "../db.js";
import { DomainError, id } from "../../shared/domain.js";
import { CARD_HEADER, referralCode } from "../../shared/loyalty-engagement.js";
import { publicLimiter } from "../public-limits.js";
import {
  authenticateCard,
  cardClaims,
  cardView,
  digest,
  applyReferral,
  issueCard,
  revokeCard,
  scanCard,
  referMember,
  getEngagement,
  saveEngagement,
  engagementActivity,
} from "./engagement.js";

export function registerEngagement({ route }: RouteContext) {
  route("get", "/loyalty/engagement", getEngagement);
  route("post", "/loyalty/engagement", (tx, s, req) =>
    saveEngagement(tx, s, req.body),
  );
  route("post", "/loyalty/members/scan", (tx, s, req) =>
    scanCard(tx, s, req.body),
  );
  route("post", "/loyalty/referrals", (tx, s, req) =>
    referMember(tx, s, req.body),
  );
  route("post", "/loyalty/members/:id/card", (tx, s, req) =>
    issueCard(tx, s, id.parse(req.params.id)),
  );
  route("post", "/loyalty/members/:id/card/revoke", (tx, s, req) =>
    revokeCard(tx, s, id.parse(req.params.id)),
  );
  route("get", "/loyalty/members/:id/activity", (tx, s, req) =>
    engagementActivity(tx, s, id.parse(req.params.id)),
  );
}
export function registerCards({ app, sql }: PreAuthContext) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    });
    next();
  });
  router.use(publicLimiter("loyalty-card", { limit: 60 }));
  const run =
    (
      fn: (req: express.Request, res: express.Response) => Promise<void>,
    ): express.RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res);
      } catch (e) {
        next(e);
      }
    };
  router.get(
    "/card",
    run(async (req, res) => {
      const token = req.get(CARD_HEADER) ?? "",
        claims = cardClaims(token);
      res.json(await tenant(sql, claims.tenantId, (tx) => cardView(tx, token)));
    }),
  );
  router.post(
    "/card/preferences",
    run(async (req, res) => {
      const token = req.get(CARD_HEADER) ?? "",
        claims = cardClaims(token),
        p = z.object({ marketingOptIn: z.boolean() }).strict().parse(req.body);
      await tenant(sql, claims.tenantId, async (tx) => {
        await authenticateCard(tx, token);
        await tx`update loyalty_members set marketing_opt_in=${p.marketingOptIn},marketing_changed_at=clock_timestamp() where id=${claims.memberId}`;
      });
      res.json({ ok: true });
    }),
  );
  router.post(
    "/card/referral",
    run(async (req, res) => {
      const token = req.get(CARD_HEADER) ?? "",
        claims = cardClaims(token),
        p = z.object({ code: referralCode }).strict().parse(req.body);
      res.json(
        await tenant(sql, claims.tenantId, async (tx) => {
          await authenticateCard(tx, token);
          return applyReferral(tx, claims.tenantId, claims.memberId, p.code);
        }),
      );
    }),
  );
  router.get(
    "/card/wallet",
    run(async (req, res) => {
      const token = req.get(CARD_HEADER) ?? "",
        claims = cardClaims(token);
      res.json(
        await tenant(sql, claims.tenantId, async (tx) => {
          const c = await authenticateCard(tx, token),
            view = await cardView(tx, token);
          if (!view.walletEnabled) return { apple: false, google: null };
          const [p] =
            await tx`select apple_pass_secret,google_url_secret from loyalty_wallet_passes where member_id=${claims.memberId} and generation_hash=${c.access_hash}`;
          return {
            apple: Boolean(p?.apple_pass_secret),
            google: p?.google_url_secret ?? null,
          };
        }),
      );
    }),
  );
  router.get(
    "/card/apple",
    run(async (req, res) => {
      const token = req.get(CARD_HEADER) ?? "",
        claims = cardClaims(token);
      const pass = await tenant(sql, claims.tenantId, async (tx) => {
        const c = await authenticateCard(tx, token),
          view = await cardView(tx, token);
        if (!view.walletEnabled) throw new DomainError("not_found", 404);
        const [p] =
          await tx`select apple_pass_secret from loyalty_wallet_passes where member_id=${claims.memberId} and generation_hash=${c.access_hash}`;
        if (!p?.apple_pass_secret)
          throw new DomainError("loyalty_wallet_pending", 409);
        return p.apple_pass_secret as string;
      });
      res
        .type("application/vnd.apple.pkpass")
        .set("Content-Disposition", 'attachment; filename="club.pkpass"')
        .send(Buffer.from(pass, "base64"));
    }),
  );
  // Apple endpoints are scoped in webServiceURL so discovery never needs a cross-tenant login.
  const base = "/wallet/:tenant/:member/v1";
  const appleScope = (req: express.Request) => ({
    tenantId: id.parse(req.params.tenant),
    memberId: id.parse(req.params.member),
  });
  const authApple = async (tx: any, req: express.Request) => {
    const { memberId } = appleScope(req),
      secret = (req.get("Authorization") ?? "").replace(/^ApplePass /, "");
    const [p] =
      await tx`select p.* from loyalty_wallet_passes p join loyalty_member_cards c on c.tenant_id=p.tenant_id and c.member_id=p.member_id
   where p.member_id=${memberId} and p.apple_auth_hash=${digest(secret)} and p.generation_hash=c.access_hash`;
    if (
      !p ||
      p.pass_type !== req.params.type ||
      `${req.params.tenant}.${memberId}` !== req.params.serial
    )
      throw new DomainError("unauthorized", 401);
    return p;
  };
  router.post(
    `${base}/devices/:device/registrations/:type/:serial`,
    run(async (req, res) => {
      const { tenantId, memberId } = appleScope(req),
        device = z.string().min(1).max(200).parse(req.params.device),
        body = z
          .object({ pushToken: z.string().regex(/^[a-fA-F0-9]{32,200}$/) })
          .strict()
          .parse(req.body);
      const created = await tenant(sql, tenantId, async (tx) => {
        await authApple(tx, req);
        await tx`select id from loyalty_members where id=${memberId} for no key update`;
        const [prior] =
          await tx`select 1 from loyalty_wallet_devices where member_id=${memberId} and device_hash=${digest(device)} and unregistered_at is null`;
        if (!prior) {
          const [n] =
            await tx`select count(*)::int as n from loyalty_wallet_devices where member_id=${memberId} and unregistered_at is null`;
          if (n.n >= 5) throw new DomainError("rate_limited", 429);
        }
        await tx`insert into loyalty_wallet_devices(tenant_id,member_id,device_hash,push_token) values(${tenantId},${memberId},${digest(device)},${body.pushToken})
    on conflict(tenant_id,member_id,device_hash) do update set push_token=excluded.push_token,unregistered_at=null`;
        return !prior;
      });
      res.status(created ? 201 : 200).end();
    }),
  );
  router.delete(
    `${base}/devices/:device/registrations/:type/:serial`,
    run(async (req, res) => {
      const { tenantId, memberId } = appleScope(req);
      await tenant(sql, tenantId, async (tx) => {
        await authApple(tx, req);
        await tx`update loyalty_wallet_devices set push_token='',unregistered_at=clock_timestamp() where member_id=${memberId} and device_hash=${digest(String(req.params.device))}`;
      });
      res.status(200).end();
    }),
  );
  router.get(
    `${base}/devices/:device/registrations/:type`,
    run(async (req, res) => {
      const { tenantId, memberId } = appleScope(req);
      const row = await tenant(sql, tenantId, async (tx) => {
        const [p] =
          await tx`select p.updated_at from loyalty_wallet_passes p join loyalty_wallet_devices d on d.tenant_id=p.tenant_id and d.member_id=p.member_id
    where p.member_id=${memberId} and p.pass_type=${String(req.params.type)} and d.device_hash=${digest(String(req.params.device))} and d.unregistered_at is null`;
        return p;
      });
      const updated = row ? new Date(row.updated_at).getTime() : 0;
      if (!updated || updated <= Number(req.query.passesUpdatedSince ?? 0)) {
        res.status(204).end();
        return;
      }
      res.json({
        serialNumbers: [`${tenantId}.${memberId}`],
        lastUpdated: String(updated),
      });
    }),
  );
  router.get(
    `${base}/passes/:type/:serial`,
    run(async (req, res) => {
      const { tenantId } = appleScope(req),
        p = await tenant(sql, tenantId, (tx) => authApple(tx, req));
      if (!p.apple_pass_secret) throw new DomainError("not_found", 404);
      res
        .type("application/vnd.apple.pkpass")
        .set("Last-Modified", new Date(p.updated_at).toUTCString())
        .send(Buffer.from(p.apple_pass_secret, "base64"));
    }),
  );
  router.post(`${base}/log`, (_req, res) => res.status(200).end());
  app.use("/api/club", router);
}
