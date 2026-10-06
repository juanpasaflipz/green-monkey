import {
  requireSelling,
  freeSelection,
  saveFreeSelection,
  autoAssignFreeSlots,
  requireDrawerOpenAllowed,
} from "./free-limits.js";
import { publicOrderingEnabled } from "./account-settings.js";
import { billingRuntime } from "./billing-runtime.js";
import { entitlement, requirePro } from "./entitlements.js";
import { ownerRoutes } from "./owner-routes.js";
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
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import { Decimal } from "decimal.js";
import { connect, tenant, waitForDatabase } from "./db.js";
import {
  authentication,
  type AuthRequest,
  sign,
  permit,
  operators,
  managers,
} from "./auth.js";
import {
  catalog,
  getOrder,
  getOrders,
  createOrder,
  addRound,
  recordPayment,
  once,
  audit,
  stock,
} from "./orders.js";
import { saveProduct, saveEmployee, receive } from "./management.js";
import { activeTables } from "./floor.js";
import { previewImport } from "../shared/import.js";
import { commitImport } from "./imports.js";
import {
  cashHistory,
  cashSummary,
  closeCash,
  recordPaidOut,
  refund,
} from "./operations.js";
import {
  acknowledgeVoids,
  verifyApproval,
  voidLines,
} from "./voids.js";
import { requireReadySchema } from "./readiness.js";
import { recordSettlement } from "./checks.js";
import { makeRoute, trustProxy } from "./http.js";
import { log, logRequestError, requestIdOf, requestLog } from "./logging.js";
import { createJobRunner } from "./jobs/runner.js";
import "./jobs/handlers/index.js";
import { opsState } from "./ops/status.js";
import {
  alertTargetFromEnv,
  configureAlerts,
  sendAlert,
} from "./ops/alerts.js";
import { drainOnSignal, drainSecondsFrom } from "./boot.js";
import * as opsRoutes from "./routes/ops.js";
import * as accessRoutes from "./routes/access.js";
import * as serviceRoutes from "./routes/service.js";
import * as menuRoutes from "./routes/menu.js";
import * as offlineRoutes from "./routes/offline.js";
import * as fiscalRoutes from "./routes/fiscal.js";
import * as discountsRoutes from "./routes/discounts.js";
import * as reportsRoutes from "./routes/reports.js";
import * as cfdiRoutes from "./routes/cfdi.js";
import * as accountRoutes from "./routes/account.js";
import {
  paymentRecoveryStatus,
  retryPaymentRecovery,
} from "./payment-recovery.js";
import {
  DomainError,
  id,
  money,
  businessDate,
  boundaries,
} from "../shared/domain.js";
if (
  !process.env.DATABASE_URL ||
  !process.env.JWT_SECRET ||
  process.env.JWT_SECRET.length < 32
)
  throw Error("DATABASE_URL and JWT_SECRET (32+ characters) required");
// account (031): QR/kiosk ordering is off in production until wave 3; an invalid value fails startup.
const PUBLIC_ORDERING = publicOrderingEnabled(process.env);
const sql = connect(process.env.DATABASE_URL);
await waitForDatabase(sql);
const billing = await billingRuntime(sql, process.env);
configureAlerts(
  alertTargetFromEnv(process.env),
  process.env.APP_ENV || "development",
);
const jobs = createJobRunner(sql, {
  onDead: (job, code) =>
    void sendAlert({
      key: `jobs_dead_${job.kind}`,
      severity: "warning",
      title: "dead job",
      body: `jobs_dead kind=${job.kind} code=${code}`,
    }),
});
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", trustProxy(process.env));
app.use(
  helmet({
    contentSecurityPolicy:
      process.env.NODE_ENV === "production" ? undefined : false,
  }),
);
app.use("/api/billing/webhook", billing.webhook);
app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());
app.use(
  requestLog(
    (tenantId) => jobs.noteTenant(tenantId),
    (tenantId) => jobs.noteTenant(tenantId, "read"),
  ),
);
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/health", async (_req, res, next) => {
  try {
    // Draining instances report unhealthy so traffic moves to the new one.
    if (opsState.draining) throw new DomainError("server_draining", 503);
    await requireReadySchema(sql);
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
app.use("/api/public", publicOrdering(sql));
app.use("/api/auth", ownerRoutes(sql));
app.use("/api/billing", billing.routes);
opsRoutes.registerPreAuth({ app, sql });
accessRoutes.registerPreAuth({ app, sql });
serviceRoutes.registerPreAuth({ app, sql });
menuRoutes.registerPreAuth({ app, sql });
offlineRoutes.registerPreAuth({ app, sql });
fiscalRoutes.registerPreAuth({ app, sql });
discountsRoutes.registerPreAuth({ app, sql });
reportsRoutes.registerPreAuth({ app, sql });
cfdiRoutes.registerPreAuth({ app, sql });
accountRoutes.registerPreAuth({ app, sql });
app.use("/api", authentication(sql));
const route = makeRoute(app, sql);
route("get", "/service/options", (tx, s) => serviceOptions(tx, s));
route("post", "/orders/:id/service", (tx, s, req) =>
  assignService(tx, s, id.parse(req.params.id), req.body),
);
route("get", "/session", async (_tx, s) => s);
route("get", "/plan/selection", freeSelection);
route("post", "/plan/selection", (tx, s, req) =>
  saveFreeSelection(tx, s, req.body),
);
route("post", "/imports/preview", async (_tx, s, req) => {
  permit(s, managers);
  return previewImport(req.body);
});
route("post", "/imports/commit", async (tx, s, req) =>
  commitImport(tx, s, req.body),
);
route("get", "/catalog", async (tx) => catalog(tx));
route("get", "/tables", async (tx) => activeTables(tx));
route("get", "/orders", async (tx) => {
  // legacy: removed after one release (docs/SERVICE.md); new screens use /service/orders.
  const rows =
    await tx`select id from orders order by created_at desc limit 100`;
  return getOrders(
    tx,
    rows.map((r: any) => r.id),
  );
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
route("post", "/payments/recovery/status", (tx, s, req) =>
  paymentRecoveryStatus(tx, s, req.body),
);
route("post", "/payments/recovery/retry", (tx, s, req) =>
  retryPaymentRecovery(tx, s, req.body),
);
route("post", "/refunds", async (tx, s, req) => refund(tx, s, req.body));
app.post("/api/orders/:id/voids", async (req, res, next) => {
  try {
    const s = (req as unknown as AuthRequest).session;
    const orderId = id.parse(req.params.id);
    // Approval is checked in its own transaction so failed PINs are counted.
    // The full body lets a lost-response retry replay its recorded void.
    const approverId = await verifyApproval(
      sql,
      s,
      req.body?.approval,
      orderId,
      req.body,
    );
    res.json(
      await tenant(sql, s.tenantId, (tx) =>
        voidLines(tx, s, orderId, req.body, approverId),
      ),
    );
  } catch (e) {
    next(e);
  }
});
route("post", "/kitchen/:id/voids/ack", (tx, s, req) =>
  acknowledgeVoids(tx, s, id.parse(req.params.id), req.body),
);
route("post", "/settlements", (tx, s, req) =>
  recordSettlement(tx, s, req.body),
);
route("get", "/operations/:id", async (tx, s, req) => {
  permit(s, managers);
  const [operation] =
    await tx`select kind,result from operations where id=${id.parse(req.params.id)}`;
  return operation ?? null;
});
route("get", "/kitchen", async (tx, s) => {
  permit(s, ["owner", "manager", "kitchen", "server", "cashier"]);
  return tx`select r.*,o.number as order_number,o.name,o.mode,o.table_id,(select name from dining_tables t where t.id=o.table_id) as table_name,(select name from employees e where e.id=coalesce(o.assigned_employee_id,o.employee_id)) as waiter_name,o.service_version,(select jsonb_agg(l.data || jsonb_build_object('voidedQuantity',coalesce((select sum(cardinality(v.units)) from line_voids v where v.tenant_id=l.tenant_id and v.line_id=l.id),0)) order by l.id) from order_lines l where l.order_id=o.id and l.round=r.number and l.data->>'station'=r.station) as lines,(select jsonb_agg(jsonb_build_object('id',v.id,'lineId',v.line_id,'quantity',cardinality(v.units),'name',l.data->'name','reason',v.reason,'createdAt',v.created_at) order by v.created_at) from line_voids v join order_lines l on l.tenant_id=v.tenant_id and l.id=v.line_id where v.order_id=o.id and l.round=r.number and l.data->>'station'=r.station and v.kitchen_ack_required and v.kitchen_acknowledged_at is null) as pending_voids from rounds r join orders o on o.tenant_id=r.tenant_id and o.id=r.order_id where r.state <> 'completed' and r.state <> 'offline_review' order by r.created_at`;
});
route("post", "/kitchen/:id", (tx, s, req) =>
  progressPreparation(tx, s, id.parse(req.params.id), req.body),
);

route("get", "/cash", async (tx, s) => {
  permit(s, operators);
  return cashSummary(tx, s);
});
route("get", "/cash/history", (tx, s, req) =>
  cashHistory(
    tx,
    s,
    z.coerce
      .number()
      .int()
      .min(0)
      .max(1000000)
      .parse(req.query.offset ?? 0),
  ),
);
route("get", "/cash/history/:id", (tx, s, req) =>
  cashSummary(tx, s, id.parse(req.params.id)),
);
route("post", "/cash/open", async (tx, s, req) => {
  permit(s, operators);
  const p = z
    .object({ operationId: id, opening: money })
    .strict()
    .parse(req.body);
  return once(tx, s, p.operationId, "cash.open", p, async () => {
    await autoAssignFreeSlots(tx, s);
    await requireDrawerOpenAllowed(tx, s);
    await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${s.tenantId},${randomUUID()},${s.deviceId},${s.employeeId},${p.opening})`;
    await audit(tx, s, "cash.open", s.deviceId, p);
    return cashSummary(tx, s);
  });
});
route("post", "/cash/close", (tx, s, req) => closeCash(tx, s, req.body));
route("post", "/cash/paid-out", (tx, s, req) => recordPaidOut(tx, s, req.body));
route("get", "/inventory", async (tx, s) => {
  permit(s, managers);
  return tx`select i.*,i.on_hand::text as quantity from stock_items i where i.archived_at is null order by i.name`;
});
route("get", "/inventory/:id", async (tx, s, req) => {
  permit(s, managers);
  return tx`select * from stock_movements where stock_id=${id.parse(req.params.id)} order by created_at desc,id desc limit 500`;
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
    await requireSelling(tx, s);
    if (p.kind !== "receipt") await requirePro(tx);
    const [i] =
      await tx`select * from stock_items where id=${p.stockId} for update`;
    if (!i) throw new DomainError("not_found", 404);
    if (p.kind === "count_adjust" && i.version !== p.expectedVersion)
      throw new DomainError("count_changed", 409);
    // DB-4: the cached balance on the locked row; no SUM over the ledger.
    const qty =
      p.kind === "count_adjust"
        ? new Decimal(p.quantity).minus(i.on_hand)
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
    await requireSelling(tx, s);
    await requirePro(tx);
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
  const unallocatedRecoveries = orders.filter(
    (o: any) =>
      o.state === "recovery_pending" || o.state === "recovery_reviewed",
  );
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
    unallocatedRecoveryCount: unallocatedRecoveries.length,
    unallocatedRecoveryTotal: unallocatedRecoveries.reduce(
      (total: number, o: any) => total + o.total,
      0,
    ),
    costCoverage:
      costs.length + unallocatedRecoveries.length
        ? costs.filter((l: any) => l.data.cost !== null).length /
          (costs.length + unallocatedRecoveries.length)
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
    await requireSelling(tx, s);
    await requirePro(tx);
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
    if (p.action === "start") {
      await requireSelling(tx, s);
      await requirePro(tx);
    }
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
    await requireSelling(tx, s);
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
  if (!PUBLIC_ORDERING) throw new DomainError("public_ordering_disabled", 404);
  permit(s, managers);
  const p = z
    .object({ channel: z.enum(["qr", "kiosk"]), tableId: id.nullable() })
    .strict()
    .parse(req.body);
  if (p.tableId) {
    const rows = await tx`select id from dining_tables where id=${p.tableId}`;
    if (!rows.length) throw new DomainError("not_found", 404);
  }
  await requireSelling(tx, s);
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
opsRoutes.register({ app, sql, route });
accessRoutes.register({ app, sql, route });
serviceRoutes.register({ app, sql, route });
menuRoutes.register({ app, sql, route });
offlineRoutes.register({ app, sql, route });
fiscalRoutes.register({ app, sql, route });
discountsRoutes.register({ app, sql, route });
reportsRoutes.register({ app, sql, route });
cfdiRoutes.register({ app, sql, route });
accountRoutes.register({ app, sql, route });
app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));
if (process.env.NODE_ENV === "production") {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
}
app.use(
  (
    error: unknown,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    // The id from the request log (X-Railway-Request-Id when present), so the
    // client's support reference matches the log line.
    const requestId = requestIdOf(req);
    if (!res.headersSent) res.setHeader("X-Request-Id", requestId);
    const reply = (status: number, code: string) => {
      logRequestError(error, req, { status, code });
      return res.status(status).json({ error: code, requestId });
    };
    if (error instanceof DomainError) return reply(error.status, error.code);
    if (error instanceof ZodError) return reply(400, "invalid_input");
    // body-parser marks malformed or oversized bodies with a type and status.
    const parse = (error as { type?: string; status?: number }) ?? {};
    if (parse.type === "entity.parse.failed") return reply(400, "invalid_json");
    if (parse.type === "entity.too.large")
      return reply(413, "payload_too_large");
    // Logged with name, message, stack, route template and SQLSTATE; never
    // request bodies, cookies or the raw path (SEC-8).
    return reply(500, "internal_error");
  },
);
const port = Number(process.env.PORT ?? 3001);
const server = app.listen(port, "0.0.0.0", () => {
  opsState.ready = true;
  log.info("api_ready", { port });
});
jobs.start();
// Railway sends SIGTERM and waits RAILWAY_DEPLOYMENT_DRAINING_SECONDS before
// SIGKILL (OPS-6): finish in-flight requests and jobs, then close the pools.
drainOnSignal(
  server,
  opsState,
  async () => {
    await jobs.stop(5000);
    await billing.close();
    await sql.end({ timeout: 5 });
  },
  { drainSeconds: drainSecondsFrom(process.env) },
);
