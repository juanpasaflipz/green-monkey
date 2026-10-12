// The pre-auth diner router of public QR/kiosk ordering (032), mounted by
// server/index.ts at /api/public. Link and status tokens travel only in the
// x-gm-link-token / x-gm-status-token headers (the page keeps them in the URL
// fragment), never in a path, so edge and access logs never see them. Nothing
// here signs or verifies anything: links are opaque database rows.
import express from "express";
import type postgres from "postgres";
import { tenant } from "./db.js";
import { clientIp, ipHash, log } from "./logging.js";
import { publicOrderingGate } from "./account-settings.js";
import {
  linkHash,
  linkRef,
  resolveAnyLink,
  resolveLink,
} from "./public-tokens.js";
import { PUBLIC_RATES, publicLimiter } from "./public-limits.js";
import {
  cancelHold,
  dinerMenu,
  dinerRevision,
  holdStatus,
  submitHold,
} from "./public-diner.js";
import { DomainError } from "../shared/domain.js";
import { kioskDinerRouter } from "./kiosk-routes.js";
import {
  LINK_HEADER,
  PUBLIC_TOKEN,
  STATUS_HEADER,
} from "../shared/public-ordering.js";

export function publicOrdering(sql: postgres.Sql) {
  const router = express.Router();
  // Account's kill switch first, before any limiter (404 public_ordering_disabled).
  router.use(publicOrderingGate(process.env));
  router.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    next();
  });
  const link = (req: express.Request) => req.get(LINK_HEADER) ?? "";
  const status = (req: express.Request) => req.get(STATUS_HEADER) ?? "";
  // Limiters are created per router instance so tests get fresh stores.
  //
  // A missing or malformed token costs nothing (no database work), so it is
  // refused first, on its own per-IP bucket, and never drains the shared
  // per-IP ceilings: a script on the restaurant's guest Wi-Fi sending
  // token-less requests cannot starve the diners behind the same address
  // (ABUSE-3). The per-IP ceilings then count every well-formed token (each
  // unknown one costs a lookup, MENU-R3); scoped budgets use a header only
  // when it is a well-formed token, so no client can mint buckets (MENU-R1,
  // MENU-R6).
  const screen =
    (hold: boolean): express.RequestHandler =>
    (req, res, next) => {
      res.locals.malformed = !PUBLIC_TOKEN.test(link(req))
        ? "public_link_invalid"
        : hold && !PUBLIC_TOKEN.test(status(req))
          ? "public_hold_not_found"
          : null;
      next();
    };
  const malformedLimit = publicLimiter("public-malformed", {
    limit: PUBLIC_RATES.malformedPerIp,
    skip: (_req, res) => !res.locals.malformed,
  });
  const refuseMalformed: express.RequestHandler = (_req, res, next) =>
    next(
      res.locals.malformed
        ? new DomainError(res.locals.malformed as string, 404)
        : undefined,
    );
  const malformed = (hold: boolean) => [
    screen(hold),
    malformedLimit,
    refuseMalformed,
  ];
  const menuLimit = publicLimiter("public-menu", {
    limit: PUBLIC_RATES.menuPerIp,
  });
  const revisionIpLimit = publicLimiter("public-revision-ip", {
    limit: PUBLIC_RATES.revisionPerIp,
  });
  const revisionLimit = publicLimiter("public-revision", {
    limit: PUBLIC_RATES.revisionPerIpLink,
    scope: link,
  });
  const submitIpLimit = publicLimiter("public-submit-ip", {
    limit: PUBLIC_RATES.submitPerIp,
  });
  const cancelIpLimit = publicLimiter("public-cancel-ip", {
    limit: PUBLIC_RATES.cancelPerIp,
  });
  const writeLimit = publicLimiter("public-write", {
    limit: PUBLIC_RATES.writePerIpLink,
    scope: link,
  });
  const statusIpLimit = publicLimiter("public-status-ip", {
    limit: PUBLIC_RATES.statusPerIp,
  });
  const statusLimit = publicLimiter("public-status", {
    limit: PUBLIC_RATES.statusPerIpKey,
    scope: status,
  });
  const run =
    (
      fn: (req: express.Request, res: express.Response) => Promise<unknown>,
    ): express.RequestHandler =>
    async (req, res, next) => {
      try {
        res.json(await fn(req, res));
      } catch (e) {
        // A durable cap hit: no personal data; the code, the link's
        // reference and kind (so staff know which code to replace) and the
        // client hash.
        if (
          e instanceof DomainError &&
          (e.code === "public_order_limit" ||
            e.code === "public_ordering_busy" ||
            e.code === "public_order_churn")
        )
          log.warn("public_order_limited", {
            code: e.code,
            ref: linkRef(linkHash(link(req))),
            kind: res.locals.linkKind ?? null,
            ipHash: ipHash(clientIp(req)),
          });
        next(e);
      }
    };
  router.get(
    "/menu",
    ...malformed(false),
    menuLimit,
    run(async (req) => {
      const l = await resolveLink(sql, link(req));
      return tenant(sql, l.tenantId, (tx) => dinerMenu(tx, l.linkId));
    }),
  );
  router.get(
    "/revision",
    ...malformed(false),
    revisionIpLimit,
    revisionLimit,
    run(async (req) => {
      const l = await resolveLink(sql, link(req));
      return tenant(sql, l.tenantId, (tx) => dinerRevision(tx, l.linkId));
    }),
  );
  router.post(
    "/orders",
    ...malformed(false),
    submitIpLimit,
    writeLimit,
    run(async (req, res) => {
      const l = await resolveLink(sql, link(req));
      res.locals.linkKind = l.kind;
      return tenant(sql, l.tenantId, (tx) =>
        submitHold(tx, l.linkId, req.body),
      );
    }),
  );
  router.get(
    "/status",
    ...malformed(true),
    statusIpLimit,
    statusLimit,
    run(async (req) => {
      const l = await resolveAnyLink(sql, link(req));
      return tenant(sql, l.tenantId, (tx) =>
        holdStatus(tx, l.linkId, status(req)),
      );
    }),
  );
  router.post(
    "/status/cancel",
    ...malformed(true),
    cancelIpLimit,
    writeLimit,
    run(async (req) => {
      const l = await resolveAnyLink(sql, link(req));
      return tenant(sql, l.tenantId, (tx) =>
        cancelHold(tx, l.linkId, status(req)),
      );
    }),
  );
  // Kiosk self-checkout (039): device binding, card charges, the checkout and the club lookup.
  router.use("/kiosk", kioskDinerRouter(sql));
  // Old signed routes (/:token/catalog, /receipt/:token, …) and anything else.
  router.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  return router;
}
