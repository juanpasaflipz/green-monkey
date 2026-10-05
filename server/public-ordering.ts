import { requirePro } from "./entitlements.js";
import { createHash } from "node:crypto";
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
/** Catalog loads and order submissions per client IP per minute (shared). */
export const PUBLIC_REQUESTS_PER_MINUTE = 30;
/**
 * Freshness polls per link per client IP per minute. A page polls about once
 * a minute plus throttled focus checks, so this leaves room for a few diners
 * sharing one table link on the venue Wi-Fi; a refused poll is only retried
 * on the next tick.
 */
export const REVISION_POLLS_PER_MINUTE = 20;
const isRevisionPoll = (req: express.Request) =>
  req.method === "GET" && /^\/[^/]+\/revision$/.test(req.path);
export function publicOrdering(sql: postgres.Sql) {
  const router = express.Router();
  // MENU-R1: every open QR/kiosk page polls /:token/revision, and diners on
  // one Wi-Fi share an IP. The poll therefore has its own budget, so it can
  // never use up the one that catalog loads and order submissions share.
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: PUBLIC_REQUESTS_PER_MINUTE,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "rate_limited" },
      skip: isRevisionPoll,
    }),
  );
  const revisionLimit = rateLimit({
    windowMs: 60_000,
    limit: REVISION_POLLS_PER_MINUTE,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "rate_limited" },
    // Per link and client (IPv6 grouped by /56, the library default): one
    // busy table cannot slow another table's or the kiosk's freshness.
    keyGenerator: (req) =>
      ipKeyGenerator(req.ip ?? "") +
      ":" +
      createHash("sha256")
        .update(String(req.params.token))
        .digest("base64url")
        .slice(0, 22),
  });
  async function context(
    token: string,
    fn: (tx: any, s: Session, c: any) => Promise<unknown>,
  ) {
    const c = verify(token);
    if (
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
  // when the revision moves. Throttled by revisionLimit, not the shared limit.
  router.get("/:token/revision", revisionLimit, async (req, res, next) => {
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
  });
  router.post("/:token/orders", async (req, res, next) => {
    try {
      res.json(
        await context(req.params.token, async (tx, s, c) => {
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
      const c = verify(req.params.token);
      if (c.purpose !== "public_receipt" || c.expiresAt < Date.now())
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
