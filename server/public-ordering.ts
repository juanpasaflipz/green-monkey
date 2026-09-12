import express from "express";
import rateLimit from "express-rate-limit";
import type postgres from "postgres";
import { tenant } from "./db.js";
import { verify, sign } from "./auth.js";
import { catalog, createOrder, getOrder } from "./orders.js";
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
export function publicOrdering(sql: postgres.Sql) {
  const router = express.Router();
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
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
        await context(req.params.token, async (tx, s) => ({
          restaurant: s.restaurant,
          catalog: (await catalog(tx)).map(
            ({ recipe: _recipe, cost: _cost, ...p }) => p,
          ),
        })),
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
