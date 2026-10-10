// The kiosk's diner routes (039; specs/kiosk-w4.md §4.2), mounted by publicOrdering(sql) at
// /api/public/kiosk, after account's kill switch and the no-store headers. Like the rest of the
// public router: tokens only in headers, a malformed link token refused before any database work
// on its own per-IP bucket, then per-IP and per-(IP, scope) limiters keyed by clientIp (/56).
// The device binding is the HttpOnly gm_kiosk cookie, scoped to this path.
import express from "express";
import type postgres from "postgres";
import { tenant } from "./db.js";
import { clientIp, ipHash, log } from "./logging.js";
import {
  resolveAnyLink,
  resolveLink,
  type ResolvedLink,
} from "./public-tokens.js";
import { publicLimiter, scopeKey } from "./public-limits.js";
import { cookieOptions } from "./auth.js";
import { kioskMemberLimiter } from "./routes/loyalty.js";
import { afterAttemptWrite } from "./payments/terminal.js";
import {
  claimPairing,
  kioskCheckout,
  kioskCounter,
  kioskHeartbeat,
  kioskMember,
  kioskMenuBlock,
  kioskSubmit,
  wellFormedSecret,
} from "./kiosk-diner.js";
import { kioskAccept } from "./kiosk-accept.js";
import {
  kioskCancelCharge,
  kioskStartCharge,
  kioskSync,
} from "./kiosk-charge.js";
import { cancelHold } from "./public-diner.js";
import { DomainError } from "../shared/domain.js";
import {
  LINK_HEADER,
  PUBLIC_TOKEN,
  STATUS_HEADER,
} from "../shared/public-ordering.js";
import {
  KIOSK_COOKIE,
  KIOSK_COOKIE_MAX_AGE_SECONDS,
  KIOSK_COOKIE_PATH,
  KIOSK_LIMITS,
  KIOSK_RATES,
  kioskStatusInput,
} from "../shared/kiosk.js";

const link = (req: express.Request) => req.get(LINK_HEADER) ?? "";
const status = (req: express.Request) => req.get(STATUS_HEADER) ?? "";
const secretOf = (req: express.Request): string | null => {
  const v = (req.cookies as Record<string, unknown> | undefined)?.[
    KIOSK_COOKIE
  ];
  return wellFormedSecret(v) ? v : null;
};

/** The device binding cookie (pairing, and the heartbeat's refresh): HttpOnly, Strict, 400 days. */
function setDeviceCookie(res: express.Response, secret: string) {
  res.cookie(KIOSK_COOKIE, secret, {
    ...cookieOptions,
    path: KIOSK_COOKIE_PATH,
    maxAge: KIOSK_COOKIE_MAX_AGE_SECONDS * 1000,
  });
}

async function kioskLink(sql: postgres.Sql, req: express.Request, any = false) {
  const l: ResolvedLink = any
    ? await resolveAnyLink(sql, link(req))
    : await resolveLink(sql, link(req));
  if (l.kind !== "kiosk") throw new DomainError("public_link_invalid", 404);
  return l;
}

export function kioskDinerRouter(sql: postgres.Sql) {
  const router = express.Router();
  const malformedLimit = publicLimiter("kiosk-malformed", {
    limit: 30,
    skip: (req) => PUBLIC_TOKEN.test(link(req)),
  });
  const refuseMalformed: express.RequestHandler = (req, _res, next) =>
    next(
      PUBLIC_TOKEN.test(link(req))
        ? undefined
        : new DomainError("public_link_invalid", 404),
    );
  const malformed = [malformedLimit, refuseMalformed];
  const stateLimit = publicLimiter("kiosk-state", { limit: 60 });
  const submitIp = publicLimiter("kiosk-submit-ip", { limit: 30 });
  const writeLink = publicLimiter("kiosk-write", { limit: 10, scope: link });
  const chargeIp = publicLimiter("kiosk-charge-ip", {
    limit: KIOSK_RATES.chargePerIp,
  });
  const chargeLink = publicLimiter("kiosk-charge", {
    limit: KIOSK_RATES.chargePerIpLink,
    scope: link,
  });
  const counterIp = publicLimiter("kiosk-counter-ip", {
    limit: KIOSK_RATES.counterPerIp,
  });
  const counterLink = publicLimiter("kiosk-counter", {
    limit: KIOSK_RATES.counterPerIpLink,
    scope: link,
  });
  const checkoutIp = publicLimiter("kiosk-checkout-ip", {
    limit: KIOSK_RATES.checkoutPerIp,
  });
  const checkoutKey = publicLimiter("kiosk-checkout", {
    limit: KIOSK_RATES.checkoutPerIpKey,
    scope: (req) =>
      status(req) ||
      String((req.body as { statusKey?: unknown })?.statusKey ?? ""),
  });
  const pairIp = publicLimiter("kiosk-pair", {
    limit: KIOSK_RATES.pairPerIp,
    windowMs: KIOSK_RATES.pairWindowMs,
  });
  const heartbeatIp = publicLimiter("kiosk-heartbeat", {
    limit: KIOSK_RATES.heartbeatPerIp,
  });
  // R20: 5 lookups per device per 5 minutes, plus loyalty's per-IP limiter. The device's bucket
  // has no network part, so a copied cookie replayed from other networks shares it
  // (KIOSK-SECURITY-1); a request without a well-formed cookie (refused as kiosk_device_required)
  // is keyed by its network.
  const memberDevice = publicLimiter("kiosk-member", {
    limit: KIOSK_LIMITS.memberLookups,
    windowMs: KIOSK_LIMITS.memberWindowMs,
    key: (req) => {
      const secret = secretOf(req);
      return secret === null ? undefined : "kiosk-device:" + scopeKey(secret);
    },
  });
  const memberIp = kioskMemberLimiter();

  const run =
    (
      fn: (req: express.Request, res: express.Response) => Promise<unknown>,
    ): express.RequestHandler =>
    async (req, res, next) => {
      try {
        const out = await fn(req, res);
        if (out === undefined) res.status(204).end();
        else res.json(out);
      } catch (e) {
        next(e);
      }
    };

  router.get(
    "/state",
    ...malformed,
    stateLimit,
    run(async (req) => {
      const l = await kioskLink(sql, req);
      return tenant(sql, l.tenantId, (tx) =>
        kioskMenuBlock(tx, l.linkId, secretOf(req)),
      );
    }),
  );
  router.post(
    "/orders",
    ...malformed,
    submitIp,
    writeLink,
    run(async (req) => {
      const l = await kioskLink(sql, req);
      const r = await tenant(sql, l.tenantId, (tx) =>
        kioskSubmit(tx, l.linkId, req.body, secretOf(req)),
      );
      // A zero total with self-checkout available: the kiosk accepts it itself (§2.15), in its
      // own transaction; a domain error leaves the hold for the counter.
      if (r.zeroTotal) {
        try {
          await tenant(sql, l.tenantId, async (tx) => {
            const [c] =
              await tx`select c.station_id,c.device_id,s.register_device_id
              from kiosk_checkouts c join kiosk_stations s on s.tenant_id=c.tenant_id and s.id=c.station_id
              where c.hold_id=${r.holdId}`;
            return kioskAccept(
              tx,
              r.holdId,
              {
                id: c.station_id as string,
                register_device_id: c.register_device_id as string | null,
              },
              c.device_id as string,
            );
          });
        } catch (e) {
          if (!(e instanceof DomainError)) throw e;
        }
        const statusKey = (req.body as { statusKey: string }).statusKey;
        const checkout = await tenant(sql, l.tenantId, (tx) =>
          kioskCheckout(tx, l.linkId, statusKey),
        );
        return {
          hold: r.hold,
          checkout,
          counterOnly: r.counterOnly,
          member: r.member,
        };
      }
      return {
        hold: r.hold,
        checkout: r.checkout,
        counterOnly: r.counterOnly,
        member: r.member,
      };
    }),
  );
  router.post(
    "/charge",
    ...malformed,
    chargeIp,
    chargeLink,
    run(async (req) => {
      const l = await kioskLink(sql, req);
      const out = await tenant(sql, l.tenantId, (tx) =>
        kioskStartCharge(tx, l.linkId, req.body, secretOf(req)),
      );
      afterAttemptWrite();
      return out;
    }),
  );
  router.post(
    "/charge/cancel",
    ...malformed,
    chargeIp,
    chargeLink,
    run(async (req) => {
      const l = await kioskLink(sql, req, true);
      const out = await tenant(sql, l.tenantId, (tx) =>
        kioskCancelCharge(tx, l.linkId, req.body, secretOf(req)),
      );
      afterAttemptWrite();
      return out;
    }),
  );
  router.post(
    "/counter",
    ...malformed,
    counterIp,
    counterLink,
    run(async (req) => {
      const l = await kioskLink(sql, req, true);
      const p = kioskStatusInput.parse(req.body);
      return tenant(sql, l.tenantId, (tx) =>
        kioskCounter(tx, l.linkId, p.statusKey),
      );
    }),
  );
  router.post(
    "/cancel",
    ...malformed,
    counterIp,
    counterLink,
    run(async (req) => {
      const l = await kioskLink(sql, req, true);
      const p = kioskStatusInput.parse(req.body);
      await tenant(sql, l.tenantId, (tx) =>
        cancelHold(tx, l.linkId, p.statusKey),
      );
      return tenant(sql, l.tenantId, (tx) =>
        kioskCheckout(tx, l.linkId, p.statusKey),
      );
    }),
  );
  router.get(
    "/checkout",
    ...malformed,
    checkoutIp,
    checkoutKey,
    run(async (req) => {
      if (!PUBLIC_TOKEN.test(status(req)))
        throw new DomainError("public_hold_not_found", 404);
      const l = await kioskLink(sql, req, true);
      return tenant(sql, l.tenantId, (tx) =>
        kioskCheckout(tx, l.linkId, status(req)),
      );
    }),
  );
  router.post(
    "/checkout/sync",
    ...malformed,
    checkoutIp,
    checkoutKey,
    run(async (req) => {
      const l = await kioskLink(sql, req, true);
      return kioskSync(sql, l.tenantId, l.linkId, req.body, secretOf(req));
    }),
  );
  router.post(
    "/member",
    ...malformed,
    memberIp,
    memberDevice,
    run(async (req) => {
      const l = await kioskLink(sql, req);
      return tenant(sql, l.tenantId, (tx) =>
        kioskMember(tx, l.linkId, req.body, secretOf(req)),
      );
    }),
  );
  router.post(
    "/pair",
    ...malformed,
    pairIp,
    run(async (req, res) => {
      const l = await kioskLink(sql, req);
      const r = await tenant(sql, l.tenantId, (tx) =>
        claimPairing(tx, l.linkId, req.body),
      );
      if (!r.ok) {
        log.warn("kiosk_pairing_refused", { ipHash: ipHash(clientIp(req)) });
        throw new DomainError("kiosk_pairing_invalid", 404);
      }
      setDeviceCookie(res, r.secret);
      return { stationLabel: r.stationLabel };
    }),
  );
  router.post(
    "/heartbeat",
    ...malformed,
    heartbeatIp,
    run(async (req, res) => {
      const l = await kioskLink(sql, req);
      const secret = secretOf(req);
      const r = await tenant(sql, l.tenantId, (tx) =>
        kioskHeartbeat(tx, l.linkId, req.body, secret),
      );
      // KIOSK-SECURITY-3: a binding past 30 days gets its cookie again (a fresh 400 days), so
      // Chrome's cap never unbinds a tablet in service.
      if (r.refreshCookie && secret) setDeviceCookie(res, secret);
      return undefined;
    }),
  );
  return router;
}
