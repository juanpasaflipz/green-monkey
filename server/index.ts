import { billingRuntime } from "./billing-runtime.js";
import { entitlement, requirePro } from "./entitlements.js";
import { ownerRoutes } from "./owner-routes.js";
import { withOwner } from "./owner-accounts.js";
import {
  serviceOptions,
  assignService,
  progressPreparation,
} from "./service.js";
import { getSettings, saveSettings } from "./restaurant.js";
import { publicOrdering } from "./public-ordering.js";
import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { randomUUID, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import { Decimal } from "decimal.js";
import { connect, tenant, checkRole } from "./db.js";
import {
  authentication,
  type AuthRequest,
  hash,
  matches,
  sign,
  verify,
  cookieOptions,
  permit,
  operators,
  managers,
} from "./auth.js";
import {
  catalog,
  getOrder,
  createOrder,
  addRound,
  recordPayment,
  once,
  audit,
  stock,
  drawer,
} from "./orders.js";
import { saveProduct, saveEmployee, receive } from "./management.js";
import { previewImport } from "../shared/import.js";
import { commitImport } from "./imports.js";
import { cashSummary, refund } from "./operations.js";
import {
  DomainError,
  id,
  money,
  quote,
  orderInput,
  businessDate,
  boundaries,
  type Session,
} from "../shared/domain.js";
if (
  !process.env.DATABASE_URL ||
  !process.env.JWT_SECRET ||
  process.env.JWT_SECRET.length < 32
)
  throw Error("DATABASE_URL and JWT_SECRET (32+ characters) required");
const sql = connect(process.env.DATABASE_URL);
await checkRole(sql);
const billing = await billingRuntime(sql, process.env);
const app = express();
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy:
      process.env.NODE_ENV === "production" ? undefined : false,
  }),
);
app.use("/api/billing/webhook", billing.webhook);
app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/health", async (_req, res, next) => {
  try {
    const ready =
      await sql`select name from schema_migrations where name='015_location_billing_operations.sql'`;
    if (!ready.length) throw new DomainError("schema_not_ready", 503);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
app.get("/api/version", (_req, res) =>
  res.json({
    version: "0.1.0",
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? "local",
  }),
);
app.post(
  "/api/login",
  rateLimit({
    windowMs: 60_000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  async (req, res, next) => {
    try {
      const p = z
        .object({
          tenantId: id,
          login: z.string().min(1).max(100),
          secret: z.string().min(4).max(200),
        })
        .strict()
        .parse(req.body);
      const result = await tenant(sql, p.tenantId, async (tx) => {
        const [e] =
          await tx`select * from employees where login=${p.login} and active`;
        if (!e || !matches(p.secret, e.secret_hash))
          throw new DomainError("invalid_login", 401);
        let device;
        try {
          device = verify(req.cookies.gm_device ?? "");
        } catch {
          device = null;
        }
        if (device?.tenantId !== p.tenantId) device = null;
        if (!device) {
          if (e.role !== "owner") throw new DomainError("pair_device", 403);
          const token = randomBytes(32).toString("hex");
          device = { id: randomUUID(), tenantId: p.tenantId, token };
          await tx`insert into devices(tenant_id,id,name,token_hash) values(${p.tenantId},${device.id},'POS',${hash(token)})`;
        } else {
          const [d] =
            await tx`select id from devices where id=${device.id} and token_hash=${hash(device.token)} and active`;
          if (!d) throw new DomainError("pair_device", 403);
        }
        const token = randomBytes(32).toString("hex"),
          sessionId = randomUUID(),
          csrf = randomBytes(24).toString("hex");
        await tx`insert into sessions(tenant_id,id,employee_id,device_id,token_hash,csrf,expires_at,offline_until) values(${p.tenantId},${sessionId},${e.id},${device.id},${hash(token)},${csrf},now()+interval '12 hours',now()+interval '4 hours')`;
        return {
          device,
          session: { id: sessionId, tenantId: p.tenantId, token },
        };
      });
      res.cookie("gm_device", sign(result.device), {
        ...cookieOptions,
        maxAge: 30 * 86400_000,
      });
      res.cookie("gm_session", sign(result.session), {
        ...cookieOptions,
        maxAge: 12 * 3600_000,
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);
app.use("/api/public", publicOrdering(sql));
app.use("/api/auth", ownerRoutes(sql));
app.use("/api/billing", billing.routes);
app.use("/api", authentication(sql));
const route = (
  method: "get" | "post",
  path: string,
  fn: (tx: any, s: Session, req: express.Request) => Promise<unknown>,
) =>
  app[method]("/api" + path, async (req, res, next) => {
    try {
      res.json(
        await tenant(sql, (req as AuthRequest).session.tenantId, (tx) =>
          fn(tx, (req as AuthRequest).session, req),
        ),
      );
    } catch (e) {
      next(e);
    }
  });
route("get", "/service/options", (tx, s) => serviceOptions(tx, s));
route("post", "/orders/:id/service", (tx, s, req) =>
  assignService(tx, s, id.parse(req.params.id), req.body),
);
route("get", "/session", async (_tx, s) => s);
app.post("/api/logout", async (req, res, next) => {
  try {
    const s = (req as AuthRequest).session;
    await tenant(
      sql,
      s.tenantId,
      (tx) => tx`update sessions set revoked=true where id=${s.id}`,
    );
    res.clearCookie("gm_session", cookieOptions);
    if (req.cookies.gm_account) {
      try {
        await withOwner(
          sql,
          req.cookies.gm_account,
          undefined,
          async (tx, account) => {
            await tx`update owner_sessions set revoked=true where id=${account.sessionId}`;
          },
        );
      } catch (error) {
        /* An absent or expired account must not prevent POS logout. */
        if (!(error instanceof DomainError && error.status === 401))
          throw error;
      }
      res.clearCookie("gm_account", cookieOptions);
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
route("post", "/imports/preview", async (_tx, s, req) => {
  permit(s, managers);
  return previewImport(req.body);
});
route("post", "/imports/commit", async (tx, s, req) =>
  commitImport(tx, s, req.body),
);
route("get", "/catalog", async (tx) => catalog(tx));
route(
  "get",
  "/tables",
  async (tx) => tx`select * from dining_tables order by name`,
);
route("get", "/orders", async (tx) => {
  const rows =
    await tx`select id from orders order by created_at desc limit 100`;
  return Promise.all(rows.map((r: any) => getOrder(tx, r.id)));
});
route("get", "/orders/:id", async (tx, _s, req) =>
  getOrder(tx, id.parse(req.params.id)),
);
route("post", "/orders", async (tx, s, req) => createOrder(tx, s, req.body));
route("post", "/orders/:id/rounds", async (tx, s, req) =>
  addRound(tx, s, id.parse(req.params.id), req.body),
);
route("post", "/orders/:id/payments", async (tx, s, req) =>
  recordPayment(tx, s, id.parse(req.params.id), req.body),
);
route("post", "/refunds", async (tx, s, req) => refund(tx, s, req.body));
route("post", "/settlements", async (tx, s, req) => {
  permit(s, operators);
  const p = z
    .object({
      operationId: id,
      orders: z
        .array(z.object({ id, amount: money.refine((n) => n > 0) }))
        .min(2)
        .max(20),
      received: money,
    })
    .strict()
    .parse(req.body);
  return once(tx, s, p.operationId, "settlement", p, async () => {
    if (new Set(p.orders.map((o) => o.id)).size !== p.orders.length)
      throw new DomainError("invalid_split");
    const total = p.orders.reduce((a, o) => a + o.amount, 0);
    if (total > p.received) throw new DomainError("insufficient_cash");
    const result = [];
    for (const o of [...p.orders].sort((a, b) => a.id.localeCompare(b.id)))
      result.push(
        await recordPayment(
          tx,
          s,
          o.id,
          {
            operationId: randomUUID(),
            amount: o.amount,
            tip: 0,
            received: o.amount,
            method: "cash",
          },
          p.operationId,
        ),
      );
    await audit(tx, s, "settlement.recorded", p.operationId, {
      orders: p.orders,
      received: p.received,
      total,
      change: p.received - total,
    });
    return result;
  });
});
route("post", "/sync", async (tx, s, req) => {
  const p = z
    .object({
      operationId: id,
      order: orderInput,
      expectedTotal: money,
      received: money,
      tip: money,
      recordedAt: z.string().datetime(),
      sessionId: id,
      cashSessionId: id,
    })
    .strict()
    .parse(req.body);
  permit(s, operators);
  return once(tx, s, p.operationId, "offline_sync", p, async () => {
    const [lease] =
      await tx`select * from sessions where id=${p.sessionId} and employee_id=${s.employeeId} and device_id=${s.deviceId}`;
    if (
      !lease ||
      lease.revoked ||
      new Date(p.recordedAt) > lease.offline_until ||
      new Date(p.recordedAt) > new Date()
    )
      throw new DomainError("offline_conflict", 409);
    const activeDrawer = await drawer(tx, s);
    if (activeDrawer.id !== p.cashSessionId)
      throw new DomainError("offline_drawer_conflict", 409);
    const priced = quote(p.order.lines, await catalog(tx), false);
    if (priced.reduce((a, l) => a + l.total, 0) !== p.expectedTotal)
      throw new DomainError("price_conflict", 409);
    const o = await createOrder(tx, s, { ...p.order, channel: "offline" });
    return recordPayment(tx, s, o.id, {
      operationId: randomUUID(),
      method: "cash",
      amount: p.expectedTotal,
      tip: p.tip,
      received: p.received,
    });
  });
});
route("get", "/kitchen", async (tx, s) => {
  permit(s, ["owner", "manager", "kitchen", "server", "cashier"]);
  return tx`select r.*,o.number as order_number,o.name,o.mode,o.table_id,(select name from dining_tables t where t.id=o.table_id) as table_name,(select name from employees e where e.id=coalesce(o.assigned_employee_id,o.employee_id)) as waiter_name,o.service_version,(select jsonb_agg(l.data) from order_lines l where l.order_id=o.id and l.round=r.number and l.data->>'station'=r.station) as lines from rounds r join orders o on o.tenant_id=r.tenant_id and o.id=r.order_id where r.state<>'completed' order by r.created_at`;
});
route("post", "/kitchen/:id", (tx, s, req) =>
  progressPreparation(tx, s, id.parse(req.params.id), req.body),
);

route("get", "/cash", async (tx, s) => {
  permit(s, operators);
  return cashSummary(tx, s);
});
route("post", "/cash/open", async (tx, s, req) => {
  permit(s, operators);
  const p = z
    .object({ operationId: id, opening: money })
    .strict()
    .parse(req.body);
  return once(tx, s, p.operationId, "cash.open", p, async () => {
    await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${s.tenantId},${randomUUID()},${s.deviceId},${s.employeeId},${p.opening})`;
    await audit(tx, s, "cash.open", s.deviceId, p);
    return cashSummary(tx, s);
  });
});
route("post", "/cash/close", async (tx, s, req) => {
  permit(s, managers);
  const p = z
    .object({ operationId: id, counted: money, reason: z.string().max(300) })
    .strict()
    .parse(req.body);
  return once(tx, s, p.operationId, "cash.close", p, async () => {
    const d = await drawer(tx, s);
    const summary = await cashSummary(tx, s);
    if (summary!.expected !== p.counted && p.reason.trim().length < 3)
      throw new DomainError("reason_required");
    await tx`update cash_sessions set counted=${p.counted},expected=${summary!.expected},reason=${p.reason},closed_at=now() where id=${d.id}`;
    await audit(tx, s, "cash.close", d.id, p);
    return cashSummary(tx, s);
  });
});
route("post", "/cash/paid-out", async (tx, s, req) => {
  permit(s, managers);
  const p = z
    .object({
      operationId: id,
      amount: money.refine((n) => n > 0),
      reason: z.string().min(3).max(300),
    })
    .strict()
    .parse(req.body);
  return once(tx, s, p.operationId, "cash.paidout", p, async () => {
    const d = await drawer(tx, s);
    await tx`insert into cash_movements(tenant_id,id,session_id,amount,reason) values(${s.tenantId},${randomUUID()},${d.id},${-p.amount},${p.reason})`;
    await audit(tx, s, "cash.paidout", d.id, p);
    return cashSummary(tx, s);
  });
});
route("get", "/inventory", async (tx, s) => {
  permit(s, managers);
  return tx`select i.*,coalesce(sum(m.quantity),0)::text as quantity from stock_items i left join stock_movements m on m.tenant_id=i.tenant_id and m.stock_id=i.id group by i.tenant_id,i.id order by i.name`;
});
route("get", "/inventory/:id", async (tx, s, req) => {
  permit(s, managers);
  return tx`select * from stock_movements where stock_id=${id.parse(req.params.id)} order by created_at desc`;
});
route("post", "/inventory/movement", async (tx, s, req) => {
  permit(s, managers);
  const p = z
    .object({
      operationId: id,
      stockId: id,
      quantity: z.string().regex(/^\d+(\.\d{1,6})?$/),
      kind: z.enum(["receipt", "waste", "count_adjust"]),
      reason: z.string().min(3).max(300),
      expectedVersion: z.number().int(),
    })
    .strict()
    .parse(req.body);
  return once(tx, s, p.operationId, "stock", p, async () => {
    const [i] =
      await tx`select * from stock_items where id=${p.stockId} for update`;
    if (!i) throw new DomainError("not_found", 404);
    if (p.kind === "count_adjust" && i.version !== p.expectedVersion)
      throw new DomainError("count_changed", 409);
    const [b] =
      await tx`select coalesce(sum(quantity),0)::text as qty from stock_movements where stock_id=${p.stockId}`;
    const qty =
      p.kind === "count_adjust"
        ? new Decimal(p.quantity).minus(b.qty)
        : new Decimal(p.quantity).mul(p.kind === "waste" ? -1 : 1);
    await stock(
      tx,
      s,
      p.stockId,
      qty.toFixed(6),
      p.kind,
      p.operationId,
      p.reason,
    );
    await audit(tx, s, "stock." + p.kind, p.stockId, p);
    return { ok: true };
  });
});
route("post", "/inventory/prep", async (tx, s, req) => {
  permit(s, managers);
  const p = z
    .object({
      operationId: id,
      inputId: id,
      inputQuantity: z.string().regex(/^\d+(\.\d{1,6})?$/),
      outputId: id,
      outputQuantity: z.string().regex(/^\d+(\.\d{1,6})?$/),
      reason: z.string().min(3),
    })
    .strict()
    .parse(req.body);
  return once(tx, s, p.operationId, "prep", p, async () => {
    if (
      p.inputId === p.outputId ||
      new Decimal(p.inputQuantity).lte(0) ||
      new Decimal(p.outputQuantity).lte(0)
    )
      throw new DomainError("invalid_quantity");
    await tx`select id from stock_items where id in (${p.inputId},${p.outputId}) order by id for update`;
    await stock(
      tx,
      s,
      p.inputId,
      new Decimal(p.inputQuantity).negated().toString(),
      "prep_input",
      p.operationId,
      p.reason,
    );
    await stock(
      tx,
      s,
      p.outputId,
      p.outputQuantity,
      "prep_output",
      p.operationId,
      p.reason,
    );
    await audit(tx, s, "prep", p.operationId, p);
    return { ok: true };
  });
});
route("get", "/report", async (tx, s, req) => {
  permit(s, managers);
  const date = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .parse(
      req.query.date ??
        businessDate(
          new Date().toISOString(),
          s.restaurant.timezone,
          s.restaurant.cutoff,
        ),
    );
  const period = boundaries(date, s.restaurant.timezone, s.restaurant.cutoff);
  const orders =
    await tx`select o.*,(select coalesce(sum(t.amount),0)::int from tenders t where t.order_id=o.id) as paid from orders o where o.created_at>=${period.start} and o.created_at<${period.end}`;
  const tenders =
    await tx`select * from tenders where created_at>=${period.start} and created_at<${period.end}`;
  const refunds =
    await tx`select * from refunds where created_at>=${period.start} and created_at<${period.end}`;
  const costs =
    await tx`select l.data from order_lines l join orders o on o.tenant_id=l.tenant_id and o.id=l.order_id where o.created_at>=${period.start} and o.created_at<${period.end}`;
  const cash =
    await tx`select * from cash_sessions where closed_at>=${period.start} and closed_at<${period.end}`;
  return {
    date,
    period,
    source: "orders/tenders/refunds",
    refreshedAt: new Date().toISOString(),
    orders,
    tenders,
    refunds,
    cash,
    gross: orders.reduce((a: number, o: any) => a + o.total, 0),
    collected: tenders.reduce((a: number, t: any) => a + t.amount, 0),
    tips: tenders.reduce((a: number, t: any) => a + t.tip, 0),
    refundTotal: refunds.reduce((a: number, r: any) => a + r.amount, 0),
    cogs: costs.reduce(
      (a: number, l: any) => a + (l.data.cost ?? 0) * l.data.quantity,
      0,
    ),
    costCoverage: costs.length
      ? costs.filter((l: any) => l.data.cost !== null).length / costs.length
      : 0,
  };
});
route("get", "/restaurant", (tx, s) => getSettings(tx, s));
route("post", "/restaurant", (tx, s, req) => saveSettings(tx, s, req.body));
route("post", "/catalog/save", async (tx, s, req) =>
  saveProduct(tx, s, req.body),
);
route("post", "/team/save", async (tx, s, req) =>
  saveEmployee(tx, s, req.body),
);
route("post", "/receiving", async (tx, s, req) => receive(tx, s, req.body));
route("get", "/suppliers", async (tx, s) => {
  permit(s, managers);
  return tx`select * from suppliers order by name`;
});
route("post", "/suppliers", async (tx, s, req) => {
  permit(s, managers);
  const p = z
    .object({ operationId: id, name: z.string().min(1).max(100) })
    .strict()
    .parse(req.body);
  return once(tx, s, p.operationId, "supplier", p, async () => {
    await tx`insert into suppliers(tenant_id,id,name) values(${s.tenantId},${p.operationId},${p.name})`;
    return { ok: true };
  });
});
route("get", "/shifts", async (tx, s) => {
  permit(s, managers);
  return tx`select sh.*,e.name,round(extract(epoch from (coalesce(ended_at,now())-started_at))/3600*hourly_rate)::int as estimated_pay from shifts sh join employees e on e.tenant_id=sh.tenant_id and e.id=sh.employee_id order by started_at desc`;
});
route("post", "/shifts", async (tx, s, req) => {
  permit(s, managers);
  const p = z
    .object({
      operationId: id,
      employeeId: id,
      hourlyRate: money,
      action: z.enum(["start", "end"]),
    })
    .strict()
    .parse(req.body);
  return once(tx, s, p.operationId, "shift", p, async () => {
    if (p.action === "start")
      await tx`insert into shifts(tenant_id,id,employee_id,hourly_rate) values(${s.tenantId},${p.operationId},${p.employeeId},${p.hourlyRate})`;
    else {
      const rows =
        await tx`update shifts set ended_at=now() where employee_id=${p.employeeId} and ended_at is null returning id`;
      if (!rows.length) throw new DomainError("not_found", 404);
    }
    await audit(tx, s, "shift." + p.action, p.employeeId);
    return { ok: true };
  });
});
route("get", "/expenses", async (tx, s) => {
  permit(s, managers);
  return tx`select * from expenses order by created_at desc`;
});
route("post", "/expenses", async (tx, s, req) => {
  permit(s, managers);
  const p = z
    .object({
      operationId: id,
      amount: money,
      kind: z.enum(["fixed", "variable"]),
      reason: z.string().min(3).max(200),
    })
    .strict()
    .parse(req.body);
  return once(tx, s, p.operationId, "expense", p, async () => {
    await tx`insert into expenses(tenant_id,id,amount,kind,reason) values(${s.tenantId},${p.operationId},${p.amount},${p.kind},${p.reason})`;
    await audit(tx, s, "expense", p.operationId, p);
    return { ok: true };
  });
});
route("get", "/team", async (tx, s) => {
  permit(s, managers);
  return tx`select id,name,login,role,active from employees order by name`;
});
route("get", "/audit", async (tx, s) => {
  permit(s, managers);
  return tx`select * from audit order by created_at desc limit 100`;
});
route("get", "/jobs", async (tx, s) => {
  permit(s, managers);
  return tx`select * from jobs order by created_at desc limit 100`;
});
route("post", "/ordering-links", async (tx, s, req) => {
  permit(s, managers);
  const p = z
    .object({ channel: z.enum(["qr", "kiosk"]), tableId: id.nullable() })
    .strict()
    .parse(req.body);
  if (p.tableId) {
    const rows = await tx`select id from dining_tables where id=${p.tableId}`;
    if (!rows.length) throw new DomainError("not_found", 404);
  }
  await requirePro(tx);
  const token = sign({
    purpose: "ordering",
    id: randomUUID(),
    tenantId: s.tenantId,
    employeeId: s.employeeId,
    deviceId: s.deviceId,
    tableId: p.tableId,
    channel: p.channel,
    expiresAt: Date.now() + 86400_000,
  });
  return {
    path: "/" + p.channel + "/" + token,
    expiresAt: new Date(Date.now() + 86400_000).toISOString(),
  };
});
route("get", "/plan", async (tx) => entitlement(tx));
route("get", "/capabilities", async () => ({
  cash: { enabled: true },
  external: { enabled: true },
  clip: { enabled: false, reason: "provider_contract_and_hardware_unverified" },
  stripe: { enabled: false, reason: "sandbox_and_merchant_required" },
  facturapi: { enabled: false, reason: "sandbox_required" },
  printer: { enabled: false, reason: "device_not_paired" },
  resend: { enabled: false, reason: "sender_and_sandbox_required" },
}));
app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));
if (process.env.NODE_ENV === "production") {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
}
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const requestId = randomUUID();
    if (error instanceof DomainError)
      return res.status(error.status).json({ error: error.code, requestId });
    if (error instanceof ZodError)
      return res.status(400).json({ error: "invalid_input", requestId });
    console.error({
      requestId,
      code: (error as any)?.code ?? "internal_error",
    });
    return res.status(500).json({ error: "internal_error", requestId });
  },
);
const server = app.listen(Number(process.env.PORT ?? 3001), "0.0.0.0", () =>
  console.log("Green Monkey API ready"),
);
process.on("SIGTERM", () => {
  server.close(() => {
    void billing
      .close()
      .then(() => sql.end())
      .then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10000).unref();
});
