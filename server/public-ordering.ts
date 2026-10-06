// The pre-auth diner router of public QR/kiosk ordering (032), mounted by
// server/index.ts at /api/public. Link and status tokens travel only in the
// x-gm-link-token / x-gm-status-token headers (the page keeps them in the URL
// fragment), never in a path, so edge and access logs never see them. Nothing
// here signs or verifies anything: links are opaque database rows.
import express from "express";
import type postgres from "postgres";
import { tenant } from "./db.js";
import { clientIp, ipHash, log } from "./logging.js";
import { publicOrderingGate } from "./compat/public-account.js";
import { resolveAnyLink, resolveLink } from "./public-tokens.js";
import { PUBLIC_RATES, publicLimiter } from "./public-limits.js";
import {
  cancelHold,
  dinerMenu,
  dinerRevision,
  holdStatus,
  submitHold,
} from "./public-diner.js";
import { DomainError } from "../shared/domain.js";
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
  // Limiters are created per router instance so tests get fresh stores. The
  // per-IP ceilings come first and count every request whatever its token;
  // the scoped budgets use a header only when it is a well-formed token, so
  // no client can mint buckets (MENU-R1, MENU-R3, MENU-R6).
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
  /** Malformed headers are refused here, before any database work. */
  const holdKey = (req: express.Request) => {
    if (!PUBLIC_TOKEN.test(link(req)))
      throw new DomainError("public_link_invalid", 404);
    const key = status(req);
    if (!PUBLIC_TOKEN.test(key))
      throw new DomainError("public_hold_not_found", 404);
    return key;
  };
  const run =
    (fn: (req: express.Request) => Promise<unknown>): express.RequestHandler =>
    async (req, res, next) => {
      try {
        res.json(await fn(req));
      } catch (e) {
        // A durable cap hit: no personal data, only the code and the client hash.
        if (
          e instanceof DomainError &&
          (e.code === "public_order_limit" || e.code === "public_ordering_busy")
        )
          log.warn("public_order_limited", {
            code: e.code,
            ipHash: ipHash(clientIp(req)),
          });
        next(e);
      }
    };
  router.get(
    "/menu",
    menuLimit,
    run(async (req) => {
      const l = await resolveLink(sql, link(req));
      return tenant(sql, l.tenantId, (tx) => dinerMenu(tx, l.linkId));
    }),
  );
  router.get(
    "/revision",
    revisionIpLimit,
    revisionLimit,
    run(async (req) => {
      const l = await resolveLink(sql, link(req));
      return tenant(sql, l.tenantId, (tx) => dinerRevision(tx, l.linkId));
    }),
  );
  router.post(
    "/orders",
    submitIpLimit,
    writeLimit,
    run(async (req) => {
      const l = await resolveLink(sql, link(req));
      return tenant(sql, l.tenantId, (tx) =>
        submitHold(tx, l.linkId, req.body),
      );
    }),
  );
  router.get(
    "/status",
    statusIpLimit,
    statusLimit,
    run(async (req) => {
      const key = holdKey(req);
      const l = await resolveAnyLink(sql, link(req));
      return tenant(sql, l.tenantId, (tx) => holdStatus(tx, l.linkId, key));
    }),
  );
  router.post(
    "/status/cancel",
    cancelIpLimit,
    writeLimit,
    run(async (req) => {
      const key = holdKey(req);
      const l = await resolveAnyLink(sql, link(req));
      return tenant(sql, l.tenantId, (tx) => cancelHold(tx, l.linkId, key));
    }),
  );
  // Old signed routes (/:token/catalog, /receipt/:token, …) and anything else.
  router.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  return router;
}
