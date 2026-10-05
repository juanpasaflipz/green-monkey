import { requirePro } from "./entitlements.js";
import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type postgres from "postgres";
import { tenant } from "./db.js";
import { verify, sign } from "./auth.js";
import { createOrder, getOrder } from "./orders.js";
import { menuRevision, publicCatalog } from "./menu-read.js";
import { DomainError, orderInput, type Session } from "../shared/domain.js";
function publicOrder(o: any) {
  return {
    id: o.id,
    number: o.number,
    name: o.name,
    mode: o.mode,
    state: o.state,
    total: o.total,
    paid: o.paid,
    refunded: o.refunded,
    createdAt: o.createdAt,
    lines: o.lines.map(
      ({ cost: _cost, recipe: _recipe, ...line }: any) => line,
    ),
    rounds: o.rounds.map((r: any) => ({
      number: r.number,
      station: r.station,
      state: r.state,
      seen_at: r.seen_at,
    })),
  };
}
/** Catalog loads and receipt reads per client IP per minute (shared). */
export const PUBLIC_REQUESTS_PER_MINUTE = 30;
/**
 * Order submissions per client IP per minute. They have their own budget
 * (MENU-R6): the catalog refetches every open page makes after a menu change
 * can never use up what a diner needs to send an order.
 */
export const PUBLIC_ORDERS_PER_MINUTE = 30;
/**
 * Freshness polls per link per client IP per minute. A page polls about once
 * a minute plus throttled focus checks, so this leaves room for a few diners
 * sharing one table link on the venue Wi-Fi; a refused poll is only retried
 * on the next tick.
 */
export const REVISION_POLLS_PER_MINUTE = 20;
/**
 * Freshness polls per client IP per minute across every link and every token
 * (MENU-R3). This ceiling, not the per-link budget, bounds the database work
 * one client can cause: a served poll is one short transaction on the pool
 * the POS sells from. A page polls at most four times a minute (once a minute
 * plus focus checks at least 15 s apart) and usually once, so one guest Wi-Fi
 * IP still carries 60 or more open pages.
 */
export const REVISION_POLLS_PER_IP_PER_MINUTE = 240;
const isRevisionPoll = (req: express.Request) =>
  req.method === "GET" && /^\/[^/]+\/revision$/.test(req.path);
const isOrderSubmission = (req: express.Request) =>
  req.method === "POST" && /^\/[^/]+\/orders$/.test(req.path);
/**
 * The claims of a token spelled exactly as sign() writes it, or null.
 * verify() decodes leniently: it ignores anything after a second ".", and the
 * base64url decoder skips "=", "!", whitespace and the unused low bits of the
 * last character. One signed link would otherwise have endless spellings,
 * each a fresh rate-limit key (MENU-R3).
 */
export function signedClaims(token: string): Record<string, any> | null {
  const [body, signature, ...extra] = token.split(".");
  if (
    extra.length ||
    !body ||
    !signature ||
    Buffer.from(signature, "base64url").toString("base64url") !== signature
  )
    return null;
  try {
    return verify(token);
  } catch {
    return null;
  }
}
const limiter = (
  limit: number,
  options: {
    skip?: (req: express.Request) => boolean;
    keyGenerator?: (req: express.Request) => string;
  } = {},
) =>
  rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "rate_limited" },
    ...options,
  });
export function publicOrdering(sql: postgres.Sql) {
  const router = express.Router();
  // MENU-R1/R6: every open QR/kiosk page polls /:token/revision and refetches
  // the catalog after a menu change, and diners on one Wi-Fi share an IP. The
  // poll and order submissions therefore have their own budgets; everything
  // else on this router (catalog loads, receipts) shares this one.
  router.use(
    limiter(PUBLIC_REQUESTS_PER_MINUTE, {
      skip: (req) => isRevisionPoll(req) || isOrderSubmission(req),
    }),
  );
  const orderLimit = limiter(PUBLIC_ORDERS_PER_MINUTE);
  // MENU-R3: the per-IP ceiling comes first and counts every poll, whatever
  // its token, so no spelling or number of links lifts the bound.
  const revisionIpLimit = limiter(REVISION_POLLS_PER_IP_PER_MINUTE);
  const revisionLinkLimit = limiter(REVISION_POLLS_PER_MINUTE, {
    // Per link and client (IPv6 grouped by /56, the library default): one
    // busy table cannot slow another table's or the kiosk's freshness. The
    // key is the server-signed link id, so a client cannot mint new keys;
    // any other token shares one key per IP and is refused before the
    // database.
    keyGenerator: (req) => {
      const c = signedClaims(String(req.params.token));
      const link =
        c?.purpose === "ordering" && typeof c.id === "string" ? c.id : "-";
      return ipKeyGenerator(req.ip ?? "") + ":" + link;
    },
  });
  async function context(
    token: string,
    fn: (tx: any, s: Session, c: any) => Promise<unknown>,
  ) {
    const c = signedClaims(token);
    if (
      !c ||
      c.purpose !== "ordering" ||
      !["qr", "kiosk"].includes(c.channel) ||
      c.expiresAt < Date.now()
    )
      throw new DomainError("unauthorized", 401);
    return tenant(sql, c.tenantId, async (tx) => {
      const [r] =
        await tx`select r.*,e.name as employee_name from restaurants r join employees e on e.tenant_id=r.id and e.id=${c.employeeId} join devices d on d.tenant_id=r.id and d.id=${c.deviceId} where e.active and d.active`;
      if (!r) throw new DomainError("unauthorized", 401);
      const s: Session = {
        id: c.id,
        tenantId: c.tenantId,
        employeeId: c.employeeId,
        deviceId: c.deviceId,
        role: "server",
        name: c.channel,
        expiresAt: new Date(c.expiresAt).toISOString(),
        offlineUntil: "",
        csrf: "",
        restaurant: {
          name: r.name,
          currency: r.currency,
          timezone: r.timezone,
          cutoff: r.cutoff,
        },
      };
      return fn(tx, s, c);
    });
  }
  router.get("/:token/catalog", async (req, res, next) => {
    try {
      res.json(
        await context(req.params.token, async (tx, s) => {
          await requirePro(tx);
          // Revision first: a menu change committed between the two reads
          // then only causes one extra refetch, never a missed one.
          const { revision } = await menuRevision(tx);
          return {
            restaurant: s.restaurant,
            revision,
            catalog: await publicCatalog(tx),
          };
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  // QR/kiosk freshness (OWNER-2): a small poll; the catalog is refetched only
  // when the revision moves. Throttled by the per-IP ceiling and the per-link
  // budget, not the shared limit.
  router.get(
    "/:token/revision",
    revisionIpLimit,
    revisionLinkLimit,
    async (req, res, next) => {
      try {
        res.json(
          await context(String(req.params.token), async (tx) => {
            await requirePro(tx);
            return menuRevision(tx);
          }),
        );
      } catch (e) {
        next(e);
      }
    },
  );
  router.post("/:token/orders", orderLimit, async (req, res, next) => {
    try {
      res.json(
        await context(String(req.params.token), async (tx, s, c) => {
          const p = orderInput.parse(req.body);
          const order = await createOrder(tx, s, {
            ...p,
            channel: c.channel,
            tableId: c.tableId,
            mode: c.tableId ? "dine_in" : "takeaway",
          });
          return {
            order: publicOrder(order),
            receiptToken: sign({
              purpose: "public_receipt",
              tenantId: s.tenantId,
              orderId: order.id,
              expiresAt: Date.now() + 86400_000,
            }),
          };
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  router.get("/receipt/:token", async (req, res, next) => {
    try {
      const c = signedClaims(req.params.token);
      if (!c || c.purpose !== "public_receipt" || c.expiresAt < Date.now())
        throw new DomainError("unauthorized", 401);
      res.json(
        await tenant(sql, c.tenantId, async (tx) =>
          publicOrder(await getOrder(tx, c.orderId)),
        ),
      );
    } catch (e) {
      next(e);
    }
  });
  return router;
}
