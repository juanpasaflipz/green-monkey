// Reports (029) DB suite against fiscal (027) and discounts (028): the statements and commands
// that read their tables (S1-S5, fiscalForRange, breakdowns, order and tender lists, exceptions,
// the drawer statement, corte X/Z/del día prints and their race, Hoy alerts, remote close and the
// legacy /report). Most fixture rows of the first part (orders, tickets, discounts, refunds,
// recoveries) are inserted by the owner connection inside the tenant scope, as
// tests/offline-recovery-db.ts does, because they need fixed instants (yesterday, the cutoff);
// drawer closes, offline archives and the report commands go through the real functions. The
// second part ("real commands") runs on the demo tenant with fiscal's and discounts' commands:
// payments that issue tickets, a whole-check comp, the remote close's precondition and in-use
// refusal, and prints that a concurrent payment cannot split (second opinion LD-27).
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { Temporal } from "@js-temporal/polyfill";
import { tenant } from "../server/db.js";
import { snapshotTenant } from "../server/reports/snapshot.js";
import * as S from "../server/reports/summary.js";
import { breakdown } from "../server/reports/breakdowns.js";
import { orderRows, tenderRows } from "../server/reports/lists.js";
import { exceptionRows } from "../server/reports/exceptions.js";
import { drawerList } from "../server/reports/drawers.js";
import * as C from "../server/reports/cortes.js";
import { todaySummary } from "../server/reports/today.js";
import { legacyDailyReport } from "../server/reports/legacy.js";
import { restaurantOf } from "../server/reports/restaurant.js";
import { reportsPorts as ports } from "../server/reports/ports.js";
import { closeDrawerRow, drawerTotals } from "../server/cash.js";
import { archiveOfflineRecord } from "../server/offline-sync.js";
import { businessDate } from "../shared/domain.js";
import {
  addDays,
  EXCEPTION_KINDS,
  exceptionSummary,
} from "../shared/reports.js";
import { isolatedTarget } from "./isolated-target.js";
import { removeTenants } from "./fixtures/reports-cleanup.js";
import { noRetries } from "./db-retries.js";
import { createOrder, getOrder, recordPayment } from "../server/orders.js";
import { catalog } from "../server/menu-read.js";
import { applyDiscount } from "../server/discounts.js";
import { approvalFor } from "../server/routes/discounts.js";
import { discountExpectation, planDiscount } from "../shared/discounts.js";

const target = isolatedTarget(process.env);
const sql = postgres(target.runtime, { max: 4 });
const admin = postgres(target.migration, { max: 4 });
type Tx = any;
const base = target.migration;

// ---- Fixture (one fictional restaurant, Mexico City, cutoff 04:00, MXN).
const T = randomUUID(),
  ORG = randomUUID();
const zone = "America/Mexico_City";
const today = businessDate(new Date().toISOString(), zone, 240);
const yesterday = addDays(today, -1);
const id = () => randomUUID();
const E = {
  owner: id(),
  manager: id(),
  cashier: id(),
  server: id(),
  kitchen: id(),
};
const D = { d1: id(), d2: id(), d3: id(), d4: id() };
const DR = {
  open1: id(),
  orphan: id(),
  closedY: id(),
  legacyY: id(),
  prevDay: id(),
  revokedToday: id(),
};
const P = { taco: id(), agua: id(), open: id() };
const restaurant = {
  name: "Fixture " + T.slice(0, 6),
  currency: "MXN",
  timezone: zone,
  cutoff: 240,
};
const session = (
  employeeId: string,
  role: string,
  deviceId: string,
  access?: any,
) => ({
  id: id(),
  tenantId: T,
  employeeId,
  name: role,
  role,
  deviceId,
  expiresAt: "",
  offlineUntil: "",
  csrf: "",
  restaurant: { ...restaurant },
  ...(access ? { access } : {}),
});
const owner = session(E.owner, "owner", D.d1),
  manager = session(E.manager, "manager", D.d1);
const cashier = session(E.cashier, "cashier", D.d1),
  server = session(E.server, "server", D.d2),
  kitchen = session(E.kitchen, "kitchen", D.d2);
/** A manager on a shared terminal whose PIN was entered at `authenticatedAt` (SEC-6 step-up). */
const onTerminal = (authenticatedAt: string | null) =>
  session(E.manager, "manager", D.d1, {
    absoluteExpiresAt: null,
    authenticatedAt,
    deviceName: "Caja mostrador",
    deviceKind: "terminal",
    idleLockSeconds: null,
    ownerAccount: false,
  });
const freshPin = () => onTerminal(new Date().toISOString());
const at = (date: string, time: string) =>
  Temporal.PlainDateTime.from(`${date}T${time}`)
    .toZonedDateTime(zone)
    .toInstant()
    .toString();
// Today's fixture instants stay inside today's business day (it starts at 04:00 local): right
// after the cutoff the 120-minute history is compressed, keeping its order.
const startedAt = Date.now();
const dayStart = Date.parse(at(today, "04:00:00"));
const scale = Math.max(
  0,
  Math.min(1, (startedAt - dayStart - 1000) / (121 * 60_000)),
);
const nowMinus = (minutes: number) =>
  new Date(startedAt - minutes * 60_000 * scale).toISOString();
async function scoped(fn: (tx: Tx) => Promise<unknown>) {
  return admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${T}, true)`;
    return fn(tx);
  });
}
let number = 0;
async function order(o: {
  date: string;
  created: string;
  lines: {
    product: string;
    qty: number;
    unit: number;
    cost: number | null;
    voided?: number[];
    open?: number;
    station?: string;
  }[];
  discount?: number;
  state?: string;
  channel?: string;
  employee?: string;
  assigned?: string;
}) {
  const oid = id();
  const gross = o.lines.reduce((a, l) => a + l.qty * l.unit, 0);
  const voided = o.lines.reduce(
    (a, l) => a + (l.voided?.length ?? 0) * l.unit,
    0,
  );
  const total = gross - voided - (o.discount ?? 0);
  const lines: { id: string; product: string }[] = [];
  await scoped(async (tx) => {
    await tx`insert into orders(tenant_id,id,number,business_date,employee_id,assigned_employee_id,mode,name,note,channel,state,total,discount,created_at)
      values(${T},${oid},${++number},${o.date},${o.employee ?? E.cashier},${o.assigned ?? null},'takeaway','F','',${o.channel ?? "pos"},${o.state ?? "completed"},${total},${o.discount ?? 0},${o.created})`;
    for (const l of o.lines) {
      const lid = id();
      lines.push({ id: lid, product: l.product });
      await tx`insert into order_lines(tenant_id,id,order_id,product_id,round,data) values(${T},${lid},${oid},${l.product},1,${tx.json(
        {
          id: lid,
          productId: l.product,
          quantity: l.qty,
          options: [],
          note: "",
          name: {
            es: "P" + l.product.slice(0, 4),
            en: "P" + l.product.slice(0, 4),
          },
          optionNames: [],
          unitPrice: l.unit,
          total: l.qty * l.unit,
          cost: l.cost,
          station: l.station ?? "kitchen",
          recipe: [],
          productVersion: 1,
          category: { es: "Comida", en: "Food" },
          categoryId: null,
          ...(l.open !== undefined ? { openAmount: l.open } : {}),
        },
      )})`;
      if (l.voided?.length)
        await tx`insert into line_voids(tenant_id,id,order_id,line_id,units,amount,reason,stock_disposition,preparation_state,actor_id,approver_id,kitchen_ack_required,created_at)
          values(${T},${id()},${oid},${lid},${l.voided},${l.voided.length * l.unit},'Error de captura','not_returned','not_started',${E.cashier},${E.manager},false,${o.created})`;
    }
  });
  return { id: oid, total, lines };
}
async function tender(
  orderId: string,
  drawer: string | null,
  method: "cash" | "external",
  amount: number,
  tip: number,
  created: string,
) {
  const tid = id();
  await scoped(
    (
      tx,
    ) => tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,tip,received,external_reference,created_at)
    values(${T},${tid},${orderId},${drawer},${method},${amount},${tip},${amount + tip},${method === "external" ? "AUT-1" : null},${created})`,
  );
  return tid;
}
async function ticket(
  orderId: string,
  date: string,
  device: string,
  groups: {
    category: string;
    rate: number | null;
    gbd: number;
    discount: number;
    gross: number;
    base: number;
    tax: number;
  }[],
  issuedAt: string,
) {
  // The admin login bypasses RLS (CI's superuser provisioner), so every counter statement names
  // this suite's tenant: other suites' tenants keep their own series A counters in this database.
  await scoped(async (tx) => {
    const [c] =
      await tx`select last_value from fiscal_folio_counters where tenant_id=${T} and series='A'`;
    if (c)
      await tx`update fiscal_folio_counters set last_value = last_value + 1 where tenant_id = ${T} and series = 'A'`;
    else
      await tx`insert into fiscal_folio_counters(tenant_id,series,last_value) values(${T},'A',1)`;
    const [{ n }] =
      await tx`select last_value::int as n from fiscal_folio_counters where tenant_id=${T} and series='A'`;
    const tid = id();
    const s = (k: "gbd" | "discount" | "gross" | "base" | "tax") =>
      groups.reduce((a, g) => a + g[k], 0);
    const code = Array.from(
      { length: 12 },
      () => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Math.floor(Math.random() * 32)],
    ).join("");
    await tx`insert into fiscal_tickets(tenant_id,id,order_id,series,number,self_invoice_code,issued_at,business_date,issued_by,device_id,source,currency,
      gross_before_discount,discount,gross,base,tax,tip,tax_basis,lines,payments)
      values(${T},${tid},${orderId},'A',${n},${code},${issuedAt},${date},${E.cashier},${device},'sale','MXN',${s("gbd")},${s("discount")},${s("gross")},${s("base")},${s("tax")},0,'line_snapshot','[]','[]')`;
    for (const g of groups)
      await tx`insert into fiscal_ticket_taxes(tenant_id,ticket_id,category,rate_bps,gross_before_discount,discount,gross,base_before_discount,discount_base,base,tax)
        values(${T},${tid},${g.category},${g.rate},${g.gbd},${g.discount},${g.gross},${g.base + g.discount},${g.discount},${g.base},${g.tax})`;
  });
}

let checks = 0;
const ok = (name: string) => {
  checks++;
  console.log("PASS", name);
};
try {
  await admin`insert into organizations(id,name) values(${ORG},'Reports fixture')`;
  await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff) values(${T},${ORG},${restaurant.name},'MXN',${zone},240)`;
  await scoped(async (tx) => {
    for (const [e, role, name] of [
      [E.owner, "owner", "Olga"],
      [E.manager, "manager", "Marisol Vega"],
      [E.cashier, "cashier", "Carlos"],
      [E.server, "server", "Sara"],
      [E.kitchen, "kitchen", "Kiko"],
    ])
      await tx`insert into employees(tenant_id,id,name,login,secret_hash,role) values(${T},${e},${name},${"pb" + id().slice(0, 10)},'x',${role})`;
    await tx`insert into devices(tenant_id,id,name,token_hash) values(${T},${D.d1},'Caja mostrador','x'),(${T},${D.d2},'Barra','x'),
      (${T},${D.d3},'Terraza','x'),(${T},${D.d4},'Patio','x')`;
    await tx`insert into restaurant_fiscal_profiles(tenant_id,updated_by) values(${T},${E.owner})`;
    for (const [pid, name] of [
      [P.taco, "Taco"],
      [P.agua, "Agua"],
      [P.open, "Precio abierto"],
    ])
      await tx`insert into catalog(tenant_id,id,data) values(${T},${pid},${tx.json({ id: pid, name: { es: name, en: name }, category: { es: "Comida", en: "Food" }, price: 0, available: true, station: "kitchen", groups: [], cost: null, recipe: [], version: 1 })})`;
    await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at) values
      (${T},${DR.open1},${D.d1},${E.cashier},100000,${nowMinus(120)}),
      (${T},${DR.closedY},${D.d2},${E.server},50000,${at(yesterday, "10:00:00")})`;
    // A drawer closed by the previous revision (no closed_by): its closer is its cash.close audit actor.
    await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at,counted,expected,reason,closed_at)
      values (${T},${DR.legacyY},${D.d1},${E.cashier},20000,${at(yesterday, "09:00:00")},20000,20500,'Legacy',${at(yesterday, "22:00:00")})`;
  });
  // Yesterday: closed drawers. closedY closes through closeDrawerRow with a cash shortage and a
  // terminal report of 1200 against no terminal sales; legacyY closed the pre-028 way.
  const oy = await order({
    date: yesterday,
    created: at(yesterday, "13:00:00"),
    lines: [{ product: P.taco, qty: 2, unit: 4500, cost: 1500 }],
  });
  await tender(oy.id, DR.closedY, "cash", 9000, 0, at(yesterday, "13:05:00"));
  await ticket(
    oy.id,
    yesterday,
    D.d2,
    [
      {
        category: "iva16",
        rate: 1600,
        gbd: 9000,
        discount: 0,
        gross: 9000,
        base: 7759,
        tax: 1241,
      },
    ],
    at(yesterday, "13:05:00"),
  );
  await tenant(sql, T, (tx: Tx) =>
    closeDrawerRow(
      tx,
      manager,
      { id: DR.closedY },
      { counted: 58000, reason: "Faltó cambio", externalReported: 1200 },
      "visible",
    ),
  );
  await scoped(async (tx) => {
    await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail,created_at) values(${T},${id()},${E.cashier},'cash.close',${DR.legacyY},'{}',${at(yesterday, "22:00:00")})`;
    await tx`insert into cash_count_reviews(tenant_id,id,drawer_id,reviewer_id,note) values(${T},${id()},${DR.legacyY},${E.manager},'Revisado con la cajera')`;
  });
  // The orphan: opened yesterday on the bar device, still open, the device revoked.
  await scoped(
    (tx) =>
      tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at) values(${T},${DR.orphan},${D.d2},${E.server},30000,${at(yesterday, "23:00:00")})`,
  );

  // Yesterday's corrections (exceptions kinds that parse audit JSON). A discount removed with a
  // manager's approval, written as discounts' reverseDiscount writes it (the order back to its
  // full total, the reversal columns, audit discount.reversed with discountId and restored).
  const oRev = await order({
    date: yesterday,
    created: at(yesterday, "19:50:00"),
    discount: 4500,
    lines: [{ product: P.taco, qty: 2, unit: 4500, cost: 1500 }],
  });
  const reversed = id(),
    reversal = id();
  await scoped(async (tx) => {
    await tx`insert into discounts(tenant_id,id,order_id,scope,line_id,kind,requested_amount,base,amount,units,reason_code,note,actor_id,approver_id,device_id,created_at)
      values(${T},${reversed},${oRev.id},'order',null,'amount',4500,9000,4500,2,'promotion','Promo de la tarde',${E.cashier},null,${D.d1},${at(yesterday, "20:00:00")})`;
    for (const unit of [0, 1])
      await tx`insert into discount_allocations(tenant_id,discount_id,order_id,line_id,unit_index,amount) values(${T},${reversed},${oRev.id},${oRev.lines[0].id},${unit},2250)`;
  });
  await scoped(async (tx) => {
    await tx`update discounts set reversed_at=${at(yesterday, "20:10:00")}, reversed_by=${E.cashier}, reversal_approver_id=${E.manager},
      reversal_note='Cliente sin cupón', reversed_amount=4500 where id=${reversed}`;
    await tx`update orders set total=total+4500, discount=discount-4500, version=version+1 where id=${oRev.id}`;
    await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail,created_at) values(${T},${reversal},${E.cashier},'discount.reversed',${oRev.id},
      ${tx.json({ discountId: reversed, restored: 4500, note: "Cliente sin cupón", approverId: E.manager })},${at(yesterday, "20:10:00")})`;
  });
  // Both offline reconcile paths (offline-sync.ts): a cash recovery whose amount is read through
  // offline_recoveries.tender_id, and a manager-reconciled payment whose audit carries amount and tip.
  const recSession = id(),
    recOrder = id(),
    recTender = id(),
    recovery = id(),
    recOperation = id(),
    reconciled = id(),
    paymentReconciled = id();
  await scoped(async (tx) => {
    await tx`insert into sessions(tenant_id,id,employee_id,device_id,token_hash,csrf,expires_at,offline_until,selling_authorized)
      values(${T},${recSession},${E.cashier},${D.d1},${"fixture-" + recSession},'fixture',now()+interval '1 hour',now()+interval '1 hour',true)`;
    await tx`insert into orders(tenant_id,id,number,business_date,employee_id,mode,name,note,channel,state,total,discount,created_at)
      values(${T},${recOrder},${++number},${yesterday},${E.cashier},'takeaway','','Offline cash reconciliation: Venta sin conexión','offline','recovery_pending',5000,0,${at(yesterday, "23:30:00")})`;
    await tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,tip,received,source,source_id,created_at)
      values(${T},${recTender},${recOrder},${DR.legacyY},'cash',5000,300,5300,'offline_recovery',${recOperation},${at(yesterday, "23:30:00")})`;
    await tx`insert into offline_recoveries(tenant_id,id,operation_id,order_operation_id,original_session_id,original_employee_id,original_device_id,
        original_drawer_id,actor_id,reason,evidence_version,evidence,order_id,tender_id,original_sold_at,recognized_at)
      values(${T},${recovery},${recOperation},${id()},${recSession},${E.cashier},${D.d1},${DR.legacyY},${E.manager},'Venta sin conexión',2,'{}',
        ${recOrder},${recTender},${at(yesterday, "21:00:00")},${at(yesterday, "23:30:00")})`;
    await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail,created_at) values(${T},${reconciled},${E.manager},'offline.reconciled',${recOrder},
      ${tx.json({ reason: "Venta sin conexión", kind: "sale", method: "cash", recoveryId: recovery })},${at(yesterday, "23:31:00")})`;
    await tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,tip,received,external_reference,source,source_id,created_at)
      values(${T},${id()},${oRev.id},${null},'external',2000,100,2100,'AUT-9','offline_recovery',${id()},${at(yesterday, "23:40:00")})`;
    await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail,created_at) values(${T},${paymentReconciled},${E.manager},'offline.payment_reconciled',${oRev.id},
      ${tx.json({ reason: "Pago con terminal sin conexión", kind: "payment", amount: 2000, tip: 100, method: "external" })},${at(yesterday, "23:40:00")})`;
  });

  // Today.
  const o1 = await order({
    date: today,
    created: nowMinus(100),
    discount: 3000,
    lines: [
      { product: P.taco, qty: 2, unit: 4500, cost: 1500 },
      { product: P.agua, qty: 1, unit: 3000, cost: null, station: "bar" },
    ],
  });
  const discount = id();
  await scoped(async (tx) => {
    await tx`insert into discounts(tenant_id,id,order_id,scope,line_id,kind,base,amount,units,reason_code,note,actor_id,approver_id,device_id,created_at)
      values(${T},${discount},${o1.id},'line',${o1.lines[1].id},'comp',3000,3000,1,'courtesy','Cliente frecuente',${E.cashier},${E.manager},${D.d1},${nowMinus(99)})`;
    await tx`insert into discount_allocations(tenant_id,discount_id,order_id,line_id,unit_index,amount) values(${T},${discount},${o1.id},${o1.lines[1].id},0,3000)`;
  });
  const t1 = await tender(o1.id, DR.open1, "cash", 9000, 1000, nowMinus(95));
  await ticket(
    o1.id,
    today,
    D.d1,
    [
      {
        category: "iva16",
        rate: 1600,
        gbd: 9000,
        discount: 0,
        gross: 9000,
        base: 7759,
        tax: 1241,
      },
      {
        category: "iva0",
        rate: 0,
        gbd: 3000,
        discount: 3000,
        gross: 0,
        base: 0,
        tax: 0,
      },
    ],
    nowMinus(95),
  );
  const o2 = await order({
    date: today,
    created: nowMinus(90),
    lines: [{ product: P.taco, qty: 1, unit: 4500, cost: 1500 }],
  });
  await tender(o2.id, DR.open1, "external", 4500, 500, nowMinus(89));
  await ticket(
    o2.id,
    today,
    D.d1,
    [
      {
        category: "iva16",
        rate: 1600,
        gbd: 4500,
        discount: 0,
        gross: 4500,
        base: 3879,
        tax: 621,
      },
    ],
    nowMinus(89),
  );
  const o3 = await order({
    date: today,
    created: nowMinus(80),
    lines: [{ product: P.taco, qty: 3, unit: 4500, cost: 1500, voided: [2] }],
  });
  await tender(o3.id, DR.open1, "cash", 9000, 0, nowMinus(79));
  await ticket(
    o3.id,
    today,
    D.d1,
    [
      {
        category: "iva16",
        rate: 1600,
        gbd: 9000,
        discount: 0,
        gross: 9000,
        base: 7759,
        tax: 1241,
      },
    ],
    nowMinus(79),
  );
  const o4 = await order({
    date: today,
    created: nowMinus(70),
    lines: [{ product: P.taco, qty: 1, unit: 4500, cost: 1500 }],
    channel: "qr",
    employee: E.manager,
  });
  const o5 = await order({
    date: today,
    created: nowMinus(60),
    state: "cancelled",
    lines: [{ product: P.taco, qty: 1, unit: 4500, cost: 1500, voided: [0] }],
  });
  const o6 = await order({
    date: today,
    created: nowMinus(50),
    lines: [{ product: P.open, qty: 1, unit: 2500, cost: null, open: 2500 }],
    assigned: E.server,
  });
  await tender(o6.id, DR.open1, "cash", 2500, 0, nowMinus(49));
  await ticket(
    o6.id,
    today,
    D.d1,
    [
      {
        category: "iva16",
        rate: 1600,
        gbd: 2500,
        discount: 0,
        gross: 2500,
        base: 2155,
        tax: 345,
      },
    ],
    nowMinus(49),
  );
  // An item refund of one taco of o1 (cash, restocked) with its fiscal adjustment on the same business date.
  const batch = id(),
    refund = id();
  await scoped(async (tx) => {
    await tx`insert into refund_batches(tenant_id,id,order_id,mode,amount,cash_amount,external_amount,reason_code,note,restock,actor_id,approver_id,device_id,business_date,created_at)
      values(${T},${batch},${o1.id},'items',4500,4500,0,'quality','Frío',true,${E.cashier},${E.manager},${D.d1},${today},${new Date().toISOString()})`;
    await tx`insert into tender_allocations(tenant_id,order_id,tender_id,line_id,unit_index,amount) values(${T},${o1.id},${t1},${o1.lines[0].id},0,4500)`;
    await tx`insert into refunds(tenant_id,id,tender_id,session_id,amount,reason,disposition,actor_id,method,batch_id,order_id,created_at)
      values(${T},${refund},${t1},${DR.open1},4500,'Frío','no_stock_return',${E.cashier},'cash',${batch},${o1.id},${new Date().toISOString()})`;
    await tx`insert into refund_lines(tenant_id,id,batch_id,order_id,line_id,units,amount,preparation_state,restocked,kitchen_ack_required)
      values(${T},${id()},${batch},${o1.id},${o1.lines[0].id},'{0}',4500,'completed',true,false)`;
    await tx`insert into refund_units(tenant_id,refund_id,tender_id,batch_id,order_id,line_id,unit_index,amount) values(${T},${refund},${t1},${batch},${o1.id},${o1.lines[0].id},0,4500)`;
    await tx`insert into fiscal_adjustments(tenant_id,id,refund_id,order_id,category,rate_bps,gross,base,tax,business_date,created_by)
      values(${T},${id()},${refund},${o1.id},'iva16',1600,4500,3879,621,${today},${E.cashier})`;
    await tx`insert into cash_movements(tenant_id,id,session_id,amount,reason,created_at) values(${T},${id()},${DR.open1},-1500,'Hielo',${nowMinus(30)})`;
    await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail,created_at) values(${T},${id()},${E.manager},'cash.paidout',${DR.open1},${tx.json({ operationId: id(), amount: 1500, reason: "Hielo" })},${nowMinus(30)})`;
    await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail,created_at) values(${T},${id()},${E.cashier},'receipt.reprinted',${o2.id},${tx.json({ document: "receipt", reprint: true })},${nowMinus(20)})`;
  });

  const read = (s: any, fn: (tx: Tx) => Promise<any>) =>
    snapshotTenant(sql, T, fn);
  const range = { from: today, to: today };

  // ---- S1-S7 and the summary.
  const { summary, drawers } = await read(owner, (tx: Tx) =>
    S.summaryWithDrawers(tx, owner, range, "req-phaseb", ports),
  );
  const sales = summary.sales;
  assert.deepEqual(
    {
      orders: sales.orders,
      cancelled: sales.cancelledOrders,
      cancelledAmount: sales.cancelledAmount,
      gross: sales.grossSales,
      discounts: sales.discounts,
      courtesies: sales.courtesies,
      total: sales.salesTotal,
      voids: sales.voids,
      ticketed: sales.ticketed,
      unticketed: sales.unticketed,
      paid: sales.paidOnSales,
      outstanding: sales.outstanding,
      openChecks: sales.openChecks,
      tips: sales.tipsOnSales,
    },
    {
      orders: 5,
      cancelled: 1,
      cancelledAmount: 4500,
      gross: 9000 + 3000 + 4500 + 9000 + 4500 + 2500,
      discounts: 3000,
      courtesies: 3000,
      total: 9000 + 4500 + 9000 + 4500 + 2500,
      voids: { amount: 9000, units: 2 },
      ticketed: { count: 4, gross: 25000 },
      unticketed: { openBalance: 4500, paidWithoutTicket: 0 },
      paid: 25000,
      outstanding: 4500,
      openChecks: 1,
      tips: 1500,
    },
  );
  assert.equal(
    sales.cogs,
    1500 * 2 + 1500 + 1500 * 2,
    "COGS of ticketed remaining units (open-price and agua have no cost)",
  );
  assert.equal(sales.wasteCost, 1500 * 2, "voided units not returned to stock");
  assert.deepEqual(summary.refunds, {
    count: 1,
    total: 4500,
    cash: 4500,
    external: 0,
    // payments (037): the refund metrics carry the platform part (none here).
    platform: 0,
    restockedCost: 1500,
  });
  const cashM = summary.collections.byMethod.find(
    (m: any) => m.method === "cash",
  );
  const extM = summary.collections.byMethod.find(
    (m: any) => m.method === "external",
  );
  assert.deepEqual(
    {
      amount: cashM.amount,
      tips: cashM.tips,
      refunds: cashM.refunds,
      net: cashM.net,
      count: cashM.count,
    },
    { amount: 20500, tips: 1000, refunds: 4500, net: 17000, count: 3 },
  );
  assert.deepEqual(
    { amount: extM.amount, tips: extM.tips, net: extM.net },
    { amount: 4500, tips: 500, net: 5000 },
  );
  assert.deepEqual(
    {
      paidOuts: summary.collections.paidOuts,
      count: summary.collections.paidOutCount,
    },
    { paidOuts: 1500, count: 1 },
  );
  assert.equal(summary.tax.totals.gross, 25000);
  assert.equal(summary.tax.totals.refundGross, 4500);
  assert.equal(summary.margin.netAfterRefundsExTax, summary.tax.totals.netBase);
  assert.deepEqual(
    summary.checks.filter((c: any) => !c.ok),
    [],
    "all checks pass",
  );
  assert.equal(summary.drawers.open, 2);
  ok(
    "S1-S7: the summary equals the hand-computed figures and every reconciliation check passes",
  );

  // ---- breakdowns: totals equal the summary.
  for (const by of [
    "product",
    "category",
    "employee",
    "hour",
    "channel",
    "mode",
    "method",
    "day",
  ]) {
    const b: any = await read(owner, (tx: Tx) =>
      breakdown(tx, owner, { ...range, by }),
    );
    if (by === "method") assert.equal(b.total, summary.collections.collected);
    else if (by === "day") assert.deepEqual(b.rows, []);
    else assert.equal(b.total + (b.recovery?.total ?? 0), sales.salesTotal, by);
    if (by === "product") {
      const taco = b.rows.find((r: any) => r.productId === P.taco);
      assert.deepEqual(
        {
          units: taco.units,
          refundedUnits: taco.refundedUnits,
          refunded: taco.refunded,
        },
        { units: 2 + 1 + 2 + 1, refundedUnits: 1, refunded: 4500 },
      );
      const agua = b.rows.find((r: any) => r.productId === P.agua);
      assert.deepEqual(
        { sales: agua.salesTotal, discounts: agua.discounts, cost: agua.cost },
        { sales: 0, discounts: 3000, cost: null },
      );
    }
    if (by === "employee")
      assert.ok(
        b.rows.some((r: any) => r.employeeId === null && r.salesTotal === 4500),
        "QR / Kiosco row",
      );
  }
  ok(
    "breakdowns: product, category, employee, hour, channel, mode equal salesTotal; method equals collected; product refunds and comps",
  );

  // ---- order rows with folios.
  const orders = await read(owner, (tx: Tx) =>
    orderRows(tx, owner, { ...range, limit: "500" }),
  );
  assert.equal(orders.rows.length, 6);
  assert.equal(orders.rows.find((r: any) => r.id === o1.id).folio, "A-000002");
  assert.equal(orders.rows.find((r: any) => r.id === o1.id).refunded, 4500);
  const open = await read(owner, (tx: Tx) =>
    orderRows(tx, owner, { ...range, state: "open" }),
  );
  assert.ok(open.rows.some((r: any) => r.id === o4.id));
  ok("order rows: folios, refunds, check-state filter");

  // ---- exceptions.
  const ex = await read(owner, (tx: Tx) =>
    exceptionRows(tx, owner, { from: yesterday, to: today, limit: "500" }),
  );
  const kinds = new Set(ex.rows.map((r: any) => r.kind));
  for (const k of [
    "void",
    "discount",
    "refund",
    "paid_out",
    "drawer_difference",
    "reprint",
    "open_price",
  ])
    assert.ok(kinds.has(k), k);
  const diff = ex.rows.find(
    (r: any) => r.kind === "drawer_difference" && r.id === DR.legacyY,
  );
  assert.deepEqual(
    { actor: diff.actorName, approver: diff.approverName, amount: diff.amount },
    { actor: "Carlos", approver: "Marisol Vega", amount: -500 },
  );
  const diff2 = ex.rows.find(
    (r: any) => r.kind === "drawer_difference" && r.id === DR.closedY,
  );
  assert.equal(diff2.actorName, "Marisol Vega");
  const disc = ex.rows.find(
    (r: any) => r.kind === "discount" && r.id === discount,
  );
  assert.deepEqual(
    {
      actor: disc.actorName,
      approver: disc.approverName,
      code: disc.reasonCode,
      amount: disc.amount,
    },
    {
      actor: "Carlos",
      approver: "Marisol Vega",
      code: "courtesy",
      amount: 3000,
    },
  );
  assert.equal(
    ex.rows.find((r: any) => r.kind === "open_price").accountName,
    "Sara",
  );
  assert.ok(ex.summary.byKind.length >= 7);
  // Keyset paging returns every row once.
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(owner, (tx: Tx) =>
      exceptionRows(tx, owner, {
        from: yesterday,
        to: today,
        limit: "2",
        ...(cursor ? { cursor } : {}),
      }),
    );
    ids.push(...page.rows.map((r: any) => r.kind + r.id));
    cursor = page.next ?? undefined;
  } while (cursor);
  assert.deepEqual(ids.sort(), ex.rows.map((r: any) => r.kind + r.id).sort());
  const byManager = await read(owner, (tx: Tx) =>
    exceptionRows(tx, owner, {
      from: yesterday,
      to: today,
      employee: E.manager,
      limit: "500",
    }),
  );
  assert.ok(
    byManager.rows.every(
      (r: any) =>
        r.actorId === E.manager ||
        r.approverId === E.manager ||
        r.accountId === E.manager,
    ),
  );
  ok(
    "exceptions: every branch, actor/approver/amount, keyset paging and the employee filter",
  );

  // ---- drawer list equals the spec'd drawerTotals.
  for (const d of drawers) {
    const totals: any = await tenant(sql, T, (tx: Tx) =>
      drawerTotals(tx, d.id),
    );
    if (d.status === "open")
      assert.equal(d.expected, totals.expectedCash, "open expected");
    assert.equal(d.cashSales, totals.cashSales);
    assert.equal(d.terminalNet, totals.externalNet);
  }
  const all: any[] = await read(owner, (tx: Tx) =>
    drawerList(tx, owner, { from: yesterday, to: today }, ports),
  );
  const zs = all
    .filter((d) => d.status === "closed")
    .map((d) => d.zNumber)
    .sort();
  assert.deepEqual(zs, [1, 2]);
  assert.equal(
    all.find((d) => d.id === DR.legacyY).closedByName,
    "Carlos",
    "legacy closer from the audit row",
  );
  assert.equal(all.find((d) => d.id === DR.orphan).orphan, true);
  ok(
    "drawer list: figures equal drawerTotals, Z numbers, legacy closer, orphan flag",
  );

  // ---- corte documents, access and prints.
  const x = await read(manager, (tx: Tx) =>
    C.drawerCorte(tx, manager, DR.open1, ports),
  );
  assert.equal(x.kind, "x");
  assert.equal(
    x.cash.expected,
    (await tenant(sql, T, (tx: Tx) => drawerTotals(tx, DR.open1))).expectedCash,
  );
  assert.deepEqual(x.controls.discounts, { count: 1, amount: 3000 });
  assert.deepEqual(x.controls.refunds, { count: 1, amount: 4500 });
  assert.deepEqual(x.folios, [
    { series: "A", first: "A-000002", last: "A-000005", count: 4 },
  ]);
  await assert.rejects(
    read(cashier, (tx: Tx) => C.drawerCorte(tx, cashier, DR.open1, ports)),
    (e: any) => e.code === "reports_corte_hidden",
  );
  await assert.rejects(
    read(server, (tx: Tx) => C.drawerCorte(tx, server, DR.closedY, ports)),
    (e: any) => e.code === "forbidden",
  );
  const z = await read(manager, (tx: Tx) =>
    C.drawerCorte(tx, manager, DR.closedY, ports),
  );
  assert.deepEqual(
    { kind: z.kind, counted: z.cash.counted, difference: z.cash.difference },
    { kind: "z", counted: 58000, difference: -1000 },
  );
  const op = id();
  const p1 = await C.printDrawerCorte(
    sql,
    manager,
    DR.closedY,
    { operationId: op, kind: "z" },
    ports,
  );
  const replay = await C.printDrawerCorte(
    sql,
    manager,
    DR.closedY,
    { operationId: op, kind: "z" },
    ports,
  );
  const p2 = await C.printDrawerCorte(
    sql,
    manager,
    DR.closedY,
    { operationId: id(), kind: "z" },
    ports,
  );
  assert.deepEqual(
    [p1.printNumber, replay.printNumber, p2.printNumber],
    [1, 1, 2],
  );
  // RPT-R21: the manager's operation id presented by the cashier on the same device is
  // operation_conflict, never the stored full corte Z with its expected cash.
  await assert.rejects(
    C.printDrawerCorte(
      sql,
      cashier,
      DR.closedY,
      { operationId: op, kind: "z" },
      ports,
    ),
    (e: any) => e.code === "operation_conflict",
  );
  await assert.rejects(
    C.printDrawerCorte(
      sql,
      manager,
      DR.closedY,
      { operationId: id(), kind: "x" },
      ports,
    ),
    (e: any) => e.code === "reports_corte_state",
  );
  const [audits] = (await scoped(
    (tx) =>
      tx`select count(*) filter (where operation='reports.corte_z.printed')::int as printed, count(*) filter (where operation='reports.corte_z.reprinted')::int as reprinted from audit where entity_id=${DR.closedY}`,
  )) as any;
  assert.deepEqual({ ...audits }, { printed: 1, reprinted: 1 });
  ok(
    "cortes: X equals drawerTotals with controls and folios; access rules; Z prints 1 then 2 (reprint audited); replay by the same viewer only (RPT-R21); state mismatch",
  );

  // ---- concurrent prints (DB test 34): two prints of the same Z with different operation ids.
  // The holder takes the commands' own key: reportPrintKey in advisory class 930 (LO-3, RPT-R17).
  const key = C.reportPrintKey(T, "corte_z", DR.legacyY);
  const holder = postgres(base, { max: 1 });
  await holder`select pg_advisory_lock(hashtextextended(${key}, ${C.REPORT_PRINT_CLASS}))`;
  const a = C.printDrawerCorte(
    sql,
    manager,
    DR.legacyY,
    { operationId: id(), kind: "z" },
    ports,
  );
  const b = C.printDrawerCorte(
    sql,
    owner,
    DR.legacyY,
    { operationId: id(), kind: "z" },
    ports,
  );
  let waiters = 0;
  for (let i = 0; i < 100; i++) {
    const [w] =
      await holder`select count(*)::int as n from pg_locks where locktype='advisory' and not granted
      and database = (select oid from pg_database where datname = current_database())`;
    waiters = w.n;
    if (waiters >= 2) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Both prints wait on the held key, so the code takes exactly this key and class.
  assert.ok(
    waiters >= 2,
    `two prints wait on the report-print key (${waiters})`,
  );
  await holder`select pg_advisory_unlock(hashtextextended(${key}, ${C.REPORT_PRINT_CLASS}))`;
  const numbers = (
    await noRetries("34. concurrent corte Z prints", () => Promise.all([a, b]))
  )
    .map((d: any) => d.printNumber)
    .sort();
  assert.deepEqual(numbers, [1, 2]);
  await holder.end();
  ok(
    "34. two concurrent prints of one corte Z get print numbers 1 and 2 (no unique or check violation)",
  );

  // ---- payments (037 P2): integrated terminal charges on yesterday's legacy drawer, as the worker
  // and the settle leave them: one approved but unapplied (review), one a manager resolved (not
  // charged, by Olga), both on oy, and one on oRev whose outcome is still unknown after more than
  // 10 minutes.
  const MP = id(),
    attemptReview = id(),
    attemptDismissed = id(),
    attemptUnknown = id();
  await scoped(async (tx) => {
    await tx`insert into payment_terminals(tenant_id,id,name,kind,provider_device_id,fee_bp,created_by,updated_by)
      values(${T},${MP},'MP Caja','mercadopago_point','NEWLAND_N950__FIXTURE01',350,${E.manager},${E.manager})`;
    const attempt = (
      attemptId: string,
      o: {
        amount: number;
        tip: number;
        state: string;
        created: string;
        orderId?: string;
        paid?: number;
        error?: string;
        resolution?: { kind: string; note: string; by: string; at: string };
      },
    ) => tx`insert into payment_attempts(tenant_id,id,operation_id,settle_operation_id,target,origin,order_id,
        terminal_id,provider,provider_device_id,terminal_label,amount,tip,currency,employee_id,device_id,session_id,
        cash_session_id,state,provider_reference,paid_amount,error_code,resolution,resolution_note,resolved_by,
        resolved_at,created_at)
      values(${T},${attemptId},${id()},${id()},'order','pos',${o.orderId ?? oy.id},${MP},'mercadopago','NEWLAND_N950__FIXTURE01',
        'MP Caja',${o.amount},${o.tip},'MXN',${E.cashier},${D.d1},${id()},${DR.legacyY},${o.state},
        ${"ORDFIXTURE" + attemptId.slice(0, 8)},${o.paid ?? null},${o.error ?? null},${o.resolution?.kind ?? null},
        ${o.resolution?.note ?? null},${o.resolution?.by ?? null},${o.resolution?.at ?? null},${o.created})`;
    await attempt(attemptReview, {
      amount: 9000,
      tip: 0,
      paid: 9000,
      state: "review",
      error: "payments_settle_order_changed",
      created: at(yesterday, "13:02:00"),
    });
    await tx`insert into payment_attempt_events(tenant_id,id,attempt_id,kind,actor,detail,created_at)
      values(${T},${id()},${attemptReview},'review','job',
        ${tx.json({ code: "payments_settle_order_changed", via: "job" })},${at(yesterday, "13:06:00")})`;
    await attempt(attemptDismissed, {
      amount: 4500,
      tip: 500,
      state: "dismissed",
      error: "payments_provider_unreachable",
      created: at(yesterday, "15:00:00"),
      resolution: {
        kind: "not_charged",
        note: "Revisado en la app del proveedor",
        by: E.owner,
        at: at(yesterday, "15:30:00"),
      },
    });
    await attempt(attemptUnknown, {
      amount: 3000,
      tip: 0,
      state: "unknown",
      error: "payments_attempt_timeout",
      created: at(yesterday, "21:00:00"),
      // One live charge per order (payment_attempts_order_live): oy's is in review.
      orderId: oRev.id,
    });
  });

  // ---- exceptions: every kind with its amount, actor, approver, order and device (spec DB test
  // 19, reports-rebase test 11), and the summary equals the listed rows (test 21). The archive
  // goes through offline-sync's real command; the corte Z reprints are the prints above.
  const record = id();
  await tenant(sql, T, (tx: Tx) =>
    archiveOfflineRecord(tx, freshPin(), {
      operationId: id(),
      record: {
        operationId: record,
        kind: "sale",
        deviceId: D.d1,
        employeeId: E.cashier,
        currency: "MXN",
        recordedAt: nowMinus(40),
        payment: { amount: 3500, tip: 200 },
      },
      localError: "offline_catalog_changed",
      reason: "Venta registrada dos veces en el dispositivo",
      confirmed: true,
    }),
  );
  // payments (037, LD-75): a platform tender to review, «Otra» recorded by Carlos yesterday on its
  // own order with no drawer (so no figure asserted above or below moves).
  const oPlatform = await order({
    date: yesterday,
    created: at(yesterday, "14:00:00"),
    lines: [{ product: P.taco, qty: 1, unit: 4500, cost: 1500 }],
  });
  const platformTender = id();
  await scoped(async (tx) => {
    await tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,tip,received,platform,platform_label,created_at)
      values(${T},${platformTender},${oPlatform.id},${null},'platform',4500,0,4500,'other','App',${at(yesterday, "14:05:00")})`;
    await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail,created_at)
      values(${T},${id()},${E.cashier},'payment.recorded',${oPlatform.id},
        ${tx.json({ method: "platform", amount: 4500, tip: 0, tenderId: platformTender, platform: "other" })},${at(yesterday, "14:05:00")})`;
  });
  const every = await read(owner, (tx: Tx) =>
    exceptionRows(tx, owner, { from: yesterday, to: today, limit: "500" }),
  );
  assert.equal(every.next, null);
  assert.deepEqual(
    [...new Set(every.rows.map((r: any) => r.kind))].sort(),
    [...EXCEPTION_KINDS].sort(),
    "all sixteen kinds",
  );
  const view = (r: any) => ({
    kind: r.kind,
    amount: r.amount,
    actor: r.actorName,
    approver: r.approverName,
    account: r.accountName,
    order: r.orderId,
    device: r.deviceName,
  });
  const only = (kind: string, pick: (r: any) => boolean = () => true) => {
    const rows = every.rows.filter((r: any) => r.kind === kind && pick(r));
    assert.equal(rows.length, 1, kind);
    return rows[0];
  };
  const row = (kind: string, pick?: (r: any) => boolean) =>
    view(only(kind, pick));
  const expected = (
    kind: string,
    amount: number,
    actor: string | null,
    approver: string | null,
    order: string | null,
    device: string | null,
    account: string | null = null,
  ) => ({ kind, amount, actor, approver, account, order, device });
  assert.deepEqual(
    { ...row("platform_tender"), reason: only("platform_tender").reasonCode },
    {
      ...expected("platform_tender", 4500, "Carlos", null, oPlatform.id, null),
      reason: "payments_platform_other",
    },
  );
  assert.deepEqual(
    every.rows
      .filter((r: any) => r.kind === "void")
      .map(view)
      .sort((a: any, b: any) => (a.order < b.order ? -1 : 1)),
    [
      expected("void", 4500, "Carlos", "Marisol Vega", o3.id, null),
      expected("void", 4500, "Carlos", "Marisol Vega", o5.id, null),
    ].sort((a, b) => (a.order! < b.order! ? -1 : 1)),
  );
  assert.deepEqual(
    row("discount", (r) => r.id === discount),
    expected(
      "discount",
      3000,
      "Carlos",
      "Marisol Vega",
      o1.id,
      "Caja mostrador",
    ),
  );
  const removed = only("discount", (r) => r.id === reversed);
  assert.deepEqual(
    { ...view(removed), reversed: removed.detail.reversed },
    {
      ...expected("discount", 4500, "Carlos", null, oRev.id, "Caja mostrador"),
      reversed: true,
    },
  );
  const reversalRow = only("discount_reversal");
  assert.deepEqual(
    {
      ...view(reversalRow),
      id: reversalRow.id,
      discountId: reversalRow.detail.discountId,
      code: reversalRow.reasonCode,
      note: reversalRow.note,
    },
    {
      ...expected(
        "discount_reversal",
        4500,
        "Carlos",
        "Marisol Vega",
        oRev.id,
        "Caja mostrador",
      ),
      id: reversal,
      discountId: reversed,
      code: "promotion",
      note: "Cliente sin cupón",
    },
  );
  assert.deepEqual(
    row("refund"),
    expected("refund", 4500, "Carlos", "Marisol Vega", o1.id, "Caja mostrador"),
  );
  assert.deepEqual(
    row("paid_out"),
    expected("paid_out", 1500, "Marisol Vega", null, null, "Caja mostrador"),
  );
  assert.deepEqual(
    row("drawer_difference", (r) => r.id === DR.legacyY),
    expected(
      "drawer_difference",
      -500,
      "Carlos",
      "Marisol Vega",
      null,
      "Caja mostrador",
    ),
  );
  assert.deepEqual(
    row("drawer_difference", (r) => r.id === DR.closedY),
    expected("drawer_difference", -1000, "Marisol Vega", null, null, "Barra"),
  );
  assert.deepEqual(
    row("terminal_difference"),
    expected("terminal_difference", 1200, "Marisol Vega", null, null, "Barra"),
  );
  assert.equal(only("terminal_difference").id, DR.closedY);
  assert.deepEqual(
    row("reprint"),
    expected("reprint", 0, "Carlos", null, o2.id, null),
  );
  const zReprint = only(
    "corte_reprint",
    (r) => r.detail.drawerId === DR.closedY,
  );
  assert.deepEqual(
    {
      ...view(zReprint),
      print: zReprint.detail.printNumber,
      z: zReprint.detail.zNumber,
    },
    {
      ...expected(
        "corte_reprint",
        0,
        "Marisol Vega",
        null,
        null,
        "Caja mostrador",
      ),
      print: 2,
      z: all.find((d) => d.id === DR.closedY).zNumber,
    },
  );
  const raceReprint = only(
    "corte_reprint",
    (r) => r.detail.drawerId === DR.legacyY,
  );
  assert.equal(raceReprint.detail.printNumber, 2);
  assert.ok(["Olga", "Marisol Vega"].includes(raceReprint.actorName));
  assert.deepEqual(
    row("open_price"),
    expected("open_price", 2500, null, null, o6.id, null, "Sara"),
  );
  const archived = only("offline_archive");
  assert.deepEqual(
    {
      ...view(archived),
      note: archived.note,
      recordKind: archived.detail.recordKind,
      localError: archived.detail.localError,
    },
    {
      ...expected(
        "offline_archive",
        3500 + 200,
        "Marisol Vega",
        null,
        null,
        "Caja mostrador",
      ),
      note: "Venta registrada dos veces en el dispositivo",
      recordKind: "sale",
      localError: "offline_catalog_changed",
    },
  );
  const recon = (path: string) =>
    only("offline_reconcile", (r) => r.detail.path === path);
  assert.deepEqual(
    {
      ...view(recon("offline.reconciled")),
      id: recon("offline.reconciled").id,
      method: recon("offline.reconciled").detail.method,
    },
    {
      ...expected(
        "offline_reconcile",
        5000 + 300,
        "Marisol Vega",
        null,
        recOrder,
        null,
      ),
      id: reconciled,
      method: "cash",
    },
  );
  assert.deepEqual(
    {
      ...view(recon("offline.payment_reconciled")),
      id: recon("offline.payment_reconciled").id,
      method: recon("offline.payment_reconciled").detail.method,
    },
    {
      ...expected(
        "offline_reconcile",
        2000 + 100,
        "Marisol Vega",
        null,
        oRev.id,
        null,
      ),
      id: paymentReconciled,
      method: "external",
    },
  );
  // payments (037 P2): the three terminal-charge kinds, with the charge's terminal and outcome.
  const attemptRow = (kind: string, attemptId: string) => {
    const r = only(kind);
    assert.equal(r.detail.attemptId, attemptId, kind);
    assert.equal(r.detail.terminal, "MP Caja", kind);
    assert.equal(r.detail.provider, "mercadopago", kind);
    return { ...view(r), code: r.reasonCode, note: r.note };
  };
  assert.deepEqual(attemptRow("terminal_attempt_review", attemptReview), {
    ...expected(
      "terminal_attempt_review",
      9000,
      "Carlos",
      null,
      oy.id,
      "Caja mostrador",
    ),
    code: "payments_settle_order_changed",
    note: "",
  });
  assert.deepEqual(attemptRow("terminal_attempt_dismissed", attemptDismissed), {
    ...expected(
      "terminal_attempt_dismissed",
      4500 + 500,
      "Carlos",
      "Olga",
      oy.id,
      "Caja mostrador",
    ),
    code: "not_charged",
    note: "Revisado en la app del proveedor",
  });
  assert.equal(
    only("terminal_attempt_dismissed").detail.resolution,
    "not_charged",
  );
  assert.deepEqual(
    attemptRow("terminal_attempt_unknown_open", attemptUnknown),
    {
      ...expected(
        "terminal_attempt_unknown_open",
        3000,
        "Carlos",
        null,
        oRev.id,
        "Caja mostrador",
      ),
      code: "payments_attempt_timeout",
      note: "",
    },
  );
  // The summary is exactly the listed rows' summary; spot-check the per-kind and per-employee figures.
  assert.deepEqual(every.summary, exceptionSummary(every.rows));
  const byKind = Object.fromEntries(
    every.summary.byKind.map((k: any) => [k.kind, k]),
  );
  for (const kind of EXCEPTION_KINDS)
    assert.equal(
      byKind[kind].count,
      every.rows.filter((r: any) => r.kind === kind).length,
      kind,
    );
  assert.deepEqual(
    {
      shortages: byKind.drawer_difference.shortages,
      overages: byKind.drawer_difference.overages,
    },
    { shortages: 1500, overages: 0 },
  );
  const carlos = every.summary.byEmployee.find(
    (e: any) => e.employeeId === E.cashier,
  );
  assert.deepEqual(carlos.acted.discount_reversal, { count: 1, amount: 4500 });
  assert.equal(carlos.shortages, 500);
  const marisol = every.summary.byEmployee.find(
    (e: any) => e.employeeId === E.manager,
  );
  assert.deepEqual(marisol.acted.offline_reconcile, { count: 2, amount: 7400 });
  assert.deepEqual(marisol.acted.terminal_difference, {
    count: 1,
    amount: 1200,
  });
  // Approved by Marisol: two voids, the comp, the refund, the reversal and the reviewed shortage.
  assert.deepEqual(marisol.approved, {
    count: 6,
    amount: 4500 + 4500 + 3000 + 4500 + 4500 + 500,
  });
  ok(
    "19/21. exceptions: all sixteen kinds (void, discount and its reversal, refund, paid-out, drawer and terminal differences, receipt and corte Z reprints, open price, offline archive, both offline reconcile paths, platform tender to review, terminal charges to review, resolved by a manager and unknown after 10 minutes) with amount, actor, approver, order and device; the summary equals the listed rows",
  );

  // ---- corte del día and its print.
  const day = await read(manager, (tx: Tx) =>
    C.dayCorte(tx, manager, today, "req", ports),
  );
  assert.equal(day.summary.sales.salesTotal, sales.salesTotal);
  assert.ok(day.exceptions.some((e: any) => e.kind === "void"));
  assert.equal(day.drawersOpen, 2);
  const dp = await C.printDayCorte(
    sql,
    manager,
    today,
    { operationId: id() },
    ports,
  );
  assert.equal(dp.printNumber, 1);
  ok(
    "corte del día: equals the single-day summary, open drawers, exception totals; print 1",
  );

  // ---- Hoy.
  const hoy = await read(manager, (tx: Tx) =>
    todaySummary(tx, manager, "req-hoy", ports),
  );
  const codes = hoy.alerts.map((x: any) => x.code);
  assert.ok(codes.includes("drawer_open_long"), JSON.stringify(codes));
  // REPORTS-UI-5: the unreviewed-difference alert counts drawers opened in the last 31 business
  // days and says from when, the range Hoy's "Cortes" button opens.
  const unreviewed = hoy.alerts.find(
    (x: any) => x.code === "drawer_unreviewed",
  );
  assert.deepEqual(
    { count: unreviewed?.count, since: unreviewed?.since },
    { count: 1, since: addDays(today, -30) },
  );
  assert.ok(hoy.topProducts.length >= 1 && hoy.openDrawers.length === 2);
  await scoped(
    (tx) =>
      tx`update devices set active=false, revoked_at=now(), revoked_by=${E.owner}, revoked_reason='revoked' where id=${D.d2}`,
  );
  const hoy2 = await read(manager, (tx: Tx) =>
    todaySummary(tx, manager, "req-hoy", ports),
  );
  assert.ok(
    hoy2.alerts.some(
      (x: any) =>
        x.code === "drawer_revoked_device" && x.deviceName === "Barra",
    ),
  );
  ok(
    "Hoy: open drawers, top products, drawer_open_long then drawer_revoked_device after revocation",
  );

  // ---- authorization (spec DB test 32, against the real 027/028 modules): cashier, server and
  // kitchen are refused by every manager report and command; kitchen gets no corte.
  const todayRange = { from: today, to: today };
  const reads: [string, (tx: Tx, s: any) => Promise<unknown>][] = [
    [
      "salesSummary",
      (tx, s) => S.salesSummary(tx, s, todayRange, "req", ports),
    ],
    [
      "breakdown",
      (tx, s) => breakdown(tx, s, { ...todayRange, by: "product" }),
    ],
    ["orderRows", (tx, s) => orderRows(tx, s, todayRange)],
    ["exceptionRows", (tx, s) => exceptionRows(tx, s, todayRange)],
    ["drawerList", (tx, s) => drawerList(tx, s, todayRange, ports)],
    ["todaySummary", (tx, s) => todaySummary(tx, s, "req", ports)],
    ["dayCorte", (tx, s) => C.dayCorte(tx, s, today, "req", ports)],
    ["legacyDailyReport", (tx, s) => legacyDailyReport(tx, s, { date: today })],
  ];
  const commands: [string, (s: any) => Promise<unknown>][] = [
    [
      "printDayCorte",
      (s) => C.printDayCorte(sql, s, today, { operationId: id() }, ports),
    ],
    [
      "closeDrawerRemotely",
      (s) =>
        C.closeDrawerRemotely(
          sql,
          s,
          DR.orphan,
          {
            operationId: id(),
            fingerprint: "0",
            counted: 30000,
            reason: "Sin permiso",
          },
          ports,
        ),
    ],
  ];
  const forbidden = (label: string, p: Promise<unknown>) =>
    assert.rejects(p, (e: any) => {
      assert.equal(e.code ?? e.message, "forbidden", `${label}: ${e.message}`);
      return true;
    });
  for (const s of [cashier, server, kitchen]) {
    for (const [label, fn] of reads)
      await forbidden(
        `${s.role} ${label}`,
        read(s, (tx: Tx) => fn(tx, s)),
      );
    for (const [label, fn] of commands)
      await forbidden(`${s.role} ${label}`, fn(s));
  }
  await forbidden(
    "kitchen drawerCorte",
    read(kitchen, (tx: Tx) => C.drawerCorte(tx, kitchen, DR.open1, ports)),
  );
  await forbidden(
    "kitchen printDrawerCorte",
    C.printDrawerCorte(
      sql,
      kitchen,
      DR.open1,
      { operationId: id(), kind: "x" },
      ports,
    ),
  );
  ok(
    "32. cashier, server and kitchen get forbidden on every manager report and command (summary, breakdowns, lists, exceptions, drawers, Hoy, corte del día and its print, legacy /report, remote close); kitchen gets no corte X",
  );

  // Two more orphans, one per reason: an active device's drawer from the previous business day,
  // and a drawer opened today on a device revoked since.
  await scoped(async (tx) => {
    await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at) values
      (${T},${DR.prevDay},${D.d3},${E.cashier},10000,${at(yesterday, "21:00:00")}),
      (${T},${DR.revokedToday},${D.d4},${E.cashier},20000,${nowMinus(30)})`;
    await tx`update devices set active=false, revoked_at=now(), revoked_by=${E.owner}, revoked_reason='revoked' where id=${D.d4}`;
  });

  // ---- remote close (manager with a recent PIN; healthy same-day drawer refused).
  // A shared terminal without a PIN, or with one entered a day ago, is refused (SEC-6).
  // The corte X the manager's dialog read: its fingerprint is the close's precondition.
  const seen = async (drawer: string) =>
    (await read(manager, (tx: Tx) => C.drawerCorte(tx, manager, drawer, ports)))
      .fingerprint as string;
  for (const stale of [null, new Date(Date.now() - 86_400_000).toISOString()])
    await assert.rejects(
      C.closeDrawerRemotely(
        sql,
        onTerminal(stale),
        DR.orphan,
        {
          operationId: id(),
          fingerprint: "0",
          counted: 30000,
          reason: "Sin PIN",
        },
        ports,
      ),
      (e: any) => e.code === "step_up_required",
    );
  await assert.rejects(
    C.closeDrawerRemotely(
      sql,
      freshPin(),
      DR.open1,
      {
        operationId: id(),
        fingerprint: await seen(DR.open1),
        counted: 1000,
        reason: "Prueba",
      },
      ports,
    ),
    (e: any) => e.code === "reports_drawer_not_orphaned",
  );
  for (const [drawer, counted] of [
    [DR.prevDay, 10000],
    [DR.revokedToday, 19000],
  ] as const) {
    const z = await C.closeDrawerRemotely(
      sql,
      freshPin(),
      drawer,
      {
        operationId: id(),
        fingerprint: await seen(drawer),
        counted,
        reason: "Cierre remoto",
        externalReported: null,
      },
      ports,
    );
    assert.deepEqual(
      { kind: z.kind, counted: z.cash.counted },
      { kind: "z", counted },
      drawer,
    );
  }
  const remote = await C.closeDrawerRemotely(
    sql,
    freshPin(),
    DR.orphan,
    {
      operationId: id(),
      fingerprint: await seen(DR.orphan),
      counted: 30000,
      reason: "Dispositivo revocado",
      externalReported: null,
    },
    ports,
  );
  assert.equal(remote.kind, "z");
  const [closed] = (await scoped(
    (tx) =>
      tx`select closed_by, count_mode from cash_sessions where id=${DR.orphan}`,
  )) as any;
  assert.deepEqual(
    { ...closed },
    { closed_by: E.manager, count_mode: "visible" },
  );
  const closes = (await scoped(
    (tx) =>
      tx`select entity_id, actor_id, detail from audit where operation='cash.close'
          and entity_id = any (${[DR.orphan, DR.prevDay, DR.revokedToday]}::text[]) order by entity_id`,
  )) as any[];
  assert.equal(closes.length, 3);
  for (const c of closes)
    assert.deepEqual(
      { actor: c.actor_id, remote: c.detail.remote, mode: c.detail.countMode },
      { actor: E.manager, remote: true, mode: "visible" },
      c.entity_id,
    );
  const [shortage] = (await scoped(
    (tx) =>
      tx`select closed_by, count_mode, counted - expected as difference from cash_sessions where id=${DR.revokedToday}`,
  )) as any;
  assert.deepEqual(
    { ...shortage },
    { closed_by: E.manager, count_mode: "visible", difference: -1000 },
  );
  await assert.rejects(
    C.closeDrawerRemotely(
      sql,
      freshPin(),
      DR.orphan,
      {
        operationId: id(),
        fingerprint: "0",
        counted: 30000,
        reason: "Otra vez",
      },
      ports,
    ),
    (e: any) => e.code === "reports_drawer_closed",
  );
  ok(
    "27. remote close: step_up_required without a recent PIN on a shared terminal; refused for a healthy same-day drawer; with a fresh PIN closes a previous-day drawer on an active device, a revoked device's drawer and the orphan with closed_by, visible count and audit remote:true; a second close is reports_drawer_closed",
  );

  // ---- RPT-R11: the blind count slip and the full corte Z are numbered apart. prevDay is now
  // the last drawer of the Terraza device, closed minutes ago; its cashier may not see expected
  // cash (028 default), so what they print is the count slip.
  const terraza = session(E.cashier, "cashier", D.d3);
  const corteZ = (s: any, drawer: string): Promise<any> =>
    C.printDrawerCorte(sql, s, drawer, { operationId: id(), kind: "z" }, ports);
  const slip1 = await corteZ(terraza, DR.prevDay);
  assert.deepEqual(
    {
      visibility: slip1.visibility,
      print: slip1.printNumber,
      cash: slip1.cash,
      counted: slip1.counted,
    },
    { visibility: "blind", print: 1, cash: null, counted: 10000 },
  );
  const firstZ = await corteZ(manager, DR.prevDay);
  assert.deepEqual(
    { visibility: firstZ.visibility, print: firstZ.printNumber },
    { visibility: "full", print: 1 },
    "the manager's first corte Z is print 1, not REIMPRESIÓN 2",
  );
  assert.equal((await corteZ(terraza, DR.prevDay)).printNumber, 2);
  // RPT-R14: an uppercase id in the URL numbers in the same sequence (no check_violation).
  assert.equal(
    (await corteZ(manager, DR.prevDay.toUpperCase())).printNumber,
    2,
  );
  const slipPrints = (await scoped(
    (tx) =>
      tx`select kind, print_number, subject from report_prints
          where lower(subject) = ${DR.prevDay} order by kind, print_number`,
  )) as any[];
  assert.deepEqual(
    slipPrints.map((p) => [p.kind, p.print_number, p.subject]),
    [
      ["corte_z", 1, DR.prevDay],
      ["corte_z", 2, DR.prevDay],
      ["count_slip", 1, DR.prevDay],
      ["count_slip", 2, DR.prevDay],
    ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
  const [slipAudits] = (await scoped(
    (tx) =>
      tx`select count(*) filter (where operation='reports.count_slip.printed')::int as slips,
          count(*) filter (where operation='reports.corte_z.printed')::int as printed,
          count(*) filter (where operation='reports.corte_z.reprinted')::int as reprinted
          from audit where entity_id=${DR.prevDay}`,
  )) as any;
  assert.deepEqual({ ...slipAudits }, { slips: 2, printed: 1, reprinted: 1 });
  const afterSlips = await read(owner, (tx: Tx) =>
    exceptionRows(tx, owner, { from: yesterday, to: today, limit: "500" }),
  );
  assert.deepEqual(
    afterSlips.rows
      .filter(
        (r: any) =>
          r.kind === "corte_reprint" && r.detail.drawerId === DR.prevDay,
      )
      .map((r: any) => [r.detail.printNumber, r.actorName]),
    [[2, "Marisol Vega"]],
    "only the manager's second full Z is a corte_reprint; count slips never are",
  );
  ok(
    "RPT-R11: a cashier's blind count slip is count_slip 1, the manager's first corte Z is still print 1 (corte_z.printed, no corte_reprint), slips and Zs keep separate sequences, and an uppercase drawer id numbers in the lowercase sequence (RPT-R14)",
  );

  // ---- legacy /report.
  const legacy: any = await read(manager, (tx: Tx) =>
    legacyDailyReport(tx, manager, { date: today }),
  );
  assert.equal(legacy.gross, sales.salesTotal);
  assert.equal(legacy.collected, summary.collections.collected);
  assert.equal(legacy.refundTotal, 4500);
  assert.equal(legacy.source, "business_date");
  assert.ok(Array.isArray(legacy.collectedByMethod));
  ok("legacy /report: old keys, business-date bucketing, collectedByMethod");

  // ---- tender rows (028 refunds by method).
  const tenders = await read(owner, (tx: Tx) => tenderRows(tx, owner, range));
  assert.equal(tenders.rows.find((r: any) => r.id === t1).refunded, 4500);
  ok("tender rows: refunded per tender with 028 refunds");

  const r = await read(owner, (tx: Tx) => restaurantOf(tx, owner));
  assert.equal(r.cutoff, 240);
  // ---- REPORTS-SQL-4: a manager's financial recovery sells at its original sale time (21:00),
  // not at the hour it was reconciled (23:30).
  const hours: any = await read(owner, (tx: Tx) =>
    breakdown(tx, owner, { from: yesterday, to: yesterday, by: "hour" }),
  );
  const hourTotal = (h: number) =>
    hours.rows.find((r: any) => r.hour === h)?.salesTotal ?? 0;
  assert.deepEqual([hourTotal(21), hourTotal(23)], [5000, 0]);
  ok(
    "SQL-4: Horas y canales places a recovery order at offline_recoveries.original_sold_at",
  );

  // ---- REPORTS-CORTES-3: a discount reversed after its drawer closed stays on that drawer's
  // corte Z, so a reprint matches the signed original.
  const late = await order({
    date: yesterday,
    created: at(yesterday, "14:00:00"),
    discount: 1000,
    lines: [{ product: P.taco, qty: 1, unit: 4500, cost: 1500 }],
  });
  const lateDiscount = id();
  await scoped(async (tx) => {
    await tx`insert into discounts(tenant_id,id,order_id,scope,line_id,kind,requested_amount,base,amount,units,reason_code,note,actor_id,approver_id,device_id,created_at)
      values(${T},${lateDiscount},${late.id},'order',null,'amount',1000,4500,1000,1,'promotion','',${E.server},null,${D.d2},${at(yesterday, "14:00:00")})`;
    await tx`insert into discount_allocations(tenant_id,discount_id,order_id,line_id,unit_index,amount) values(${T},${lateDiscount},${late.id},${late.lines[0].id},0,1000)`;
  });
  const zBefore = await read(manager, (tx: Tx) =>
    C.drawerCorte(tx, manager, DR.closedY, ports),
  );
  assert.deepEqual(zBefore.controls.discounts, { count: 1, amount: 1000 });
  await scoped(
    (tx) =>
      tx`update discounts set reversed_at=now(), reversed_by=${E.manager}, reversal_approver_id=${E.manager},
        reversal_note='Después del cierre', reversed_amount=1000 where id=${lateDiscount}`,
  );
  const zAfter = await read(manager, (tx: Tx) =>
    C.drawerCorte(tx, manager, DR.closedY, ports),
  );
  assert.deepEqual(zAfter.controls, zBefore.controls);
  ok(
    "CORTES-3: a discount reversed after the drawer closed still counts on its corte Z (a reprint equals the original)",
  );

  // ---- REPORTS-SQL-1 / CONTRACTS-1 / CORTES-4: folio runs. A ticket for an order of ten days
  // ago issued now on the counter (a repair), one on the bar, then one more on the counter.
  // Today's summary keeps fiscal's contiguous runs, and the counter's corte X lists its own runs
  // by issue time, with the bar's folio as a gap and the old order's ticket included.
  const [{ folio: lastFolio }] = (await scoped(
    (tx) =>
      tx`select last_value::int as folio from fiscal_folio_counters where tenant_id = ${T} and series = 'A'`,
  )) as any;
  const old = await order({
    date: addDays(today, -10),
    created: at(addDays(today, -10), "12:00:00"),
    lines: [{ product: P.taco, qty: 1, unit: 4500, cost: 1500 }],
  });
  const bar = await order({
    date: today,
    created: nowMinus(5),
    lines: [{ product: P.agua, qty: 1, unit: 3000, cost: null }],
  });
  const counter = await order({
    date: today,
    created: nowMinus(4),
    lines: [{ product: P.agua, qty: 1, unit: 3000, cost: null }],
  });
  const g = (gross: number) => [
    {
      category: "iva16",
      rate: 1600,
      gbd: gross,
      discount: 0,
      gross,
      base: Math.round(gross / 1.16),
      tax: gross - Math.round(gross / 1.16),
    },
  ];
  await ticket(
    old.id,
    addDays(today, -10),
    D.d1,
    g(4500),
    new Date().toISOString(),
  );
  await ticket(bar.id, today, D.d2, g(3000), new Date().toISOString());
  await ticket(counter.id, today, D.d1, g(3000), new Date().toISOString());
  const runs = (await read(owner, (tx: Tx) =>
    S.fiscalForRange(tx, owner, { from: today, to: today }, ports),
  ))!.tickets.series;
  assert.deepEqual(runs, [
    { series: "A", first: 2, last: 5, count: 4 },
    { series: "A", first: lastFolio + 2, last: lastFolio + 3, count: 2 },
  ]);
  const xRuns = await read(manager, (tx: Tx) =>
    C.drawerCorte(tx, manager, DR.open1, ports),
  );
  assert.deepEqual(xRuns.folios, [
    { series: "A", first: "A-000002", last: "A-000006", count: 5 },
    { series: "A", first: "A-000008", last: "A-000008", count: 1 },
  ]);
  ok(
    "SQL-1/CONTRACTS-1/CORTES-4: a summary keeps fiscal's folio runs (a gap is never inside a range); a corte X lists its device's runs by issue time, an old order's ticket included",
  );

  // ---- spec DB test 12: a 60-day summary reads fiscal in two chunks of at most 31 days and
  // merges them into the same figures as the chunks.
  const sixty = { from: addDays(today, -59), to: today };
  const chunks: { from: string; to: string }[] = [];
  const counting = {
    ...ports,
    fiscalSummary: (tx: Tx, s: any, r: { from: string; to: string }) => {
      chunks.push(r);
      return ports.fiscalSummary(tx, s, r);
    },
  };
  const merged = (await read(owner, (tx: Tx) =>
    S.fiscalForRange(tx, owner, sixty, counting),
  ))!;
  assert.deepEqual(chunks, [
    { from: sixty.from, to: addDays(sixty.from, 30) },
    { from: addDays(sixty.from, 31), to: today },
  ]);
  let tickets = 0,
    gross = 0,
    tax = 0;
  for (const c of chunks) {
    const part = await read(owner, (tx: Tx) =>
      ports.fiscalSummary(tx, owner, c),
    );
    tickets += part.tickets.count;
    gross += part.totals.gross;
    tax += part.totals.netTax;
  }
  assert.deepEqual(
    {
      from: merged.from,
      to: merged.to,
      tickets: merged.tickets.count,
      gross: merged.totals.gross,
      tax: merged.totals.netTax,
    },
    { from: sixty.from, to: today, tickets, gross, tax },
  );
  ok(
    "12. a 60-day summary reads fiscal in two ≤ 31-day chunks and merges them into the chunks' figures",
  );

  // ---- spec DB test 37: a batchless refund (the previous revision during a deploy overlap)
  // has no fiscal adjustment, and refunds_vs_fiscal fails for its day on purpose.
  const legacy37 = await order({
    date: addDays(today, -20),
    created: at(addDays(today, -20), "12:00:00"),
    lines: [{ product: P.agua, qty: 1, unit: 3000, cost: null }],
  });
  const t37 = await tender(
    legacy37.id,
    null,
    "cash",
    3000,
    0,
    at(addDays(today, -20), "12:05:00"),
  );
  const day37 = await read(owner, (tx: Tx) =>
    S.salesSummary(tx, owner, { from: today, to: today }, "req-37", ports),
  );
  assert.ok(day37.checks.find((c: any) => c.code === "refunds_vs_fiscal").ok);
  await scoped(
    (tx) =>
      tx`insert into refunds(tenant_id,id,tender_id,session_id,amount,reason,disposition,actor_id,method)
        values(${T},${id()},${t37},${DR.open1},1000,'Sin lote','no_stock_return',${E.cashier},'cash')`,
  );
  const after37 = await read(owner, (tx: Tx) =>
    S.salesSummary(tx, owner, { from: today, to: today }, "req-37", ports),
  );
  const check37 = after37.checks.find(
    (c: any) => c.code === "refunds_vs_fiscal",
  );
  assert.deepEqual(
    {
      ok: check37.ok,
      expected:
        check37.expected -
        day37.checks.find((c: any) => c.code === "refunds_vs_fiscal").expected,
    },
    { ok: false, expected: 1000 },
  );
  ok(
    "37. a batchless refund counts on the day it was recorded and fails refunds_vs_fiscal (no fiscal adjustment), as documented",
  );

  // =============================================================================================
  // Real commands on the demo tenant (second opinion LD-27): fiscal's and discounts' commands
  // write every row. Figures are compared as deltas, since other suites share this tenant.
  // =============================================================================================
  const DEMO = "10000000-0000-4000-8000-000000000001";
  const demoOwnerId = "20000000-0000-4000-8000-000000000001";
  const [demo] = (await admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${DEMO}, true)`;
    return tx`select name, currency, timezone, cutoff from restaurants where id = ${DEMO}`;
  })) as any;
  const demoToday = businessDate(
    new Date().toISOString(),
    demo.timezone,
    demo.cutoff,
  );
  const demoManagerId = id();
  const dev = { print: id(), late: id(), busy: id(), selling: id() };
  const asDemo = async (fn: (tx: Tx) => Promise<unknown>) =>
    admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${DEMO}, true)`;
      return fn(tx);
    });
  await asDemo(async (tx) => {
    await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
      values(${DEMO},${demoManagerId},'Gerente reportes',${"rmgr-" + demoManagerId.slice(0, 8)},'x','manager')`;
    for (const [name, deviceId] of Object.entries(dev))
      await tx`insert into devices(tenant_id,id,name,token_hash,kind,paired_at)
        values(${DEMO},${deviceId},${"Reportes " + name},${"x" + deviceId},'terminal',now())`;
  });
  const demoSession = (employeeId: string, role: string, deviceId: string) => ({
    id: id(),
    tenantId: DEMO,
    employeeId,
    name: role,
    role,
    deviceId,
    expiresAt: "",
    offlineUntil: "",
    csrf: "",
    restaurant: {
      name: demo.name,
      currency: demo.currency,
      timezone: demo.timezone,
      cutoff: Number(demo.cutoff),
    },
  });
  const demoOwner = (deviceId: string) =>
    demoSession(demoOwnerId, "owner", deviceId);
  const demoManager = demoSession(demoManagerId, "manager", dev.print);
  const demoRead = <T>(fn: (tx: Tx) => Promise<T>) =>
    snapshotTenant(sql, DEMO, fn);
  const demoRun = <T>(fn: (tx: Tx) => Promise<T>) => tenant(sql, DEMO, fn);
  const products = (await demoRun((tx) => catalog(tx))) as any[];
  const taco = products.find((x) => x.name.es === "Taco de hongos");
  assert.ok(taco && taco.cost > 0, "the demo taco has a cost");
  const openDrawer = (deviceId: string, openedAt?: string) =>
    asDemo(async (tx) => {
      const drawerId = id();
      await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at)
        values(${DEMO},${drawerId},${deviceId},${demoOwnerId},10000,${openedAt ?? new Date().toISOString()})`;
      return drawerId;
    }) as Promise<string>;
  /** A takeaway taco order paid in cash on `deviceId` (fiscal issues its ticket there). */
  const sale = async (deviceId: string) => {
    const s = demoOwner(deviceId);
    const o: any = await demoRun((tx) =>
      createOrder(tx, s, {
        operationId: id(),
        lines: [
          {
            id: id(),
            productId: taco.id,
            quantity: 1,
            options: [],
            note: "",
          },
        ],
        mode: "takeaway",
        tableId: null,
        name: "Reportes",
        note: "",
        channel: "pos",
      }),
    );
    await demoRun((tx) =>
      recordPayment(tx, s, o.id, {
        operationId: id(),
        amount: o.total,
        tip: 0,
        received: o.total,
        method: "cash",
      }),
    );
    return o.id as string;
  };
  const corteOf = (drawerId: string): Promise<any> =>
    demoRead((tx) => C.drawerCorte(tx, demoManager, drawerId, ports));
  const managerOnTerminal = () => ({
    ...demoManager,
    access: {
      absoluteExpiresAt: null,
      authenticatedAt: new Date().toISOString(),
      deviceName: "Oficina",
      deviceKind: "terminal",
      idleLockSeconds: null,
      ownerAccount: false,
    },
  });
  const remoteClose = (
    drawerId: string,
    fingerprint: string,
    counted: number,
  ) =>
    C.closeDrawerRemotely(
      sql,
      managerOnTerminal() as any,
      drawerId,
      { operationId: id(), fingerprint, counted, reason: "Cierre remoto" },
      ports,
    );
  const drawerRow = async (drawerId: string) =>
    (
      (await asDemo(
        (tx) =>
          tx`select closed_at, expected, counted from cash_sessions where id = ${drawerId}`,
      )) as any
    )[0];

  // ---- REPORTS-CORTES-1 (fingerprint): a revoked device's drawer takes one more cash tender
  // after the manager's dialog read the corte X (another manager reconciles the device's
  // offline sale in Recuperación, which records the tender into its original drawer). The close
  // with what the dialog showed is reports_drawer_changed and leaves the drawer open; a recount
  // against the live corte X closes it with no false difference.
  const lateDrawer = await openDrawer(dev.late);
  await sale(dev.late);
  await asDemo(
    (tx) =>
      tx`update devices set active=false, revoked_at=now(), revoked_by=${demoOwnerId}, revoked_reason='revoked' where id=${dev.late}`,
  );
  const shown = await corteOf(lateDrawer);
  const lateOrder: any = await demoRun((tx) =>
    createOrder(tx, demoOwner(dev.print), {
      operationId: id(),
      lines: [
        { id: id(), productId: taco.id, quantity: 1, options: [], note: "" },
      ],
      mode: "takeaway",
      tableId: null,
      name: "Venta sin conexión",
      note: "",
      channel: "pos",
    }),
  );
  await asDemo(
    (tx) =>
      tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,tip,received,source,source_id)
        values(${DEMO},${id()},${lateOrder.id},${lateDrawer},'cash',${lateOrder.total},0,${lateOrder.total},'offline_recovery',${id()})`,
  );
  await assert.rejects(
    remoteClose(lateDrawer, shown.fingerprint, shown.cash.expected),
    (e: any) => e.code === "reports_drawer_changed",
  );
  assert.equal((await drawerRow(lateDrawer)).closed_at, null);
  const live = await corteOf(lateDrawer);
  assert.equal(live.cash.expected, shown.cash.expected + taco.price);
  const closedZ: any = await remoteClose(
    lateDrawer,
    live.fingerprint,
    live.cash.expected,
  );
  const stored = await drawerRow(lateDrawer);
  assert.deepEqual(
    { kind: closedZ.kind, expected: stored.expected, counted: stored.counted },
    { kind: "z", expected: live.cash.expected, counted: live.cash.expected },
  );
  ok(
    "CORTES-1: a remote close carries the corte X fingerprint the dialog showed; a payment since is reports_drawer_changed (the drawer stays open), a recount against the live corte closes with no false difference",
  );

  // ---- REPORTS-CORTES-1 (in use): a drawer from an earlier business day on an active device is
  // refused while the device was seen in the last minutes, or while it takes payments.
  const yesterdayNoon = Temporal.PlainDateTime.from(
    `${addDays(demoToday, -1)}T12:00:00`,
  )
    .toZonedDateTime(demo.timezone)
    .toInstant()
    .toString();
  const busyDrawer = await openDrawer(dev.busy, yesterdayNoon);
  await asDemo(
    (tx) => tx`update devices set last_seen_at = now() where id = ${dev.busy}`,
  );
  await assert.rejects(
    remoteClose(busyDrawer, (await corteOf(busyDrawer)).fingerprint, 10000),
    (e: any) => e.code === "reports_drawer_in_use",
  );
  const sellingDrawer = await openDrawer(dev.selling, yesterdayNoon);
  await sale(dev.selling);
  const selling = await corteOf(sellingDrawer);
  await assert.rejects(
    remoteClose(sellingDrawer, selling.fingerprint, selling.cash.expected),
    (e: any) => e.code === "reports_drawer_in_use",
  );
  await asDemo(
    (tx) =>
      tx`update devices set last_seen_at = now() - interval '1 hour' where id = ${dev.busy}`,
  );
  await remoteClose(busyDrawer, (await corteOf(busyDrawer)).fingerprint, 10000);
  assert.notEqual((await drawerRow(busyDrawer)).closed_at, null);
  // REPORTS-CORTES-5: the closing transaction stores only the drawer id; the corte Z the
  // command answers with is read after the commit (a replay reads it again).
  const [stored5] = (await asDemo(
    (tx) =>
      tx`select result from operations where kind = 'reports.drawer_close'
          and result->>'drawerId' = ${busyDrawer}`,
  )) as any;
  assert.deepEqual(stored5.result, { drawerId: busyDrawer });
  ok(
    "CORTES-1: an earlier day's drawer on an active device is reports_drawer_in_use while the device was seen or took a payment in the last 10 minutes; once idle the remote close goes through",
  );

  // ---- REPORTS-CORTES-2: a payment that commits between the statements of a print never
  // splits the paper. The corte X's money-controls read (after the drawer statement) commits a
  // payment on the same device first; the printed corte still has one payment and one folio.
  const printDrawer = await openDrawer(dev.print);
  await sale(dev.print);
  const before = await corteOf(printDrawer);
  let committed = false;
  const interleaved = {
    ...ports,
    moneyControls: async (tx: Tx) => {
      if (!committed) {
        committed = true;
        await sale(dev.print);
      }
      return ports.moneyControls(tx);
    },
  };
  const printed: any = await C.printDrawerCorte(
    sql,
    demoSession(demoOwnerId, "owner", dev.print),
    printDrawer,
    { operationId: id(), kind: "x" },
    interleaved,
  );
  const folioCount = (doc: any) =>
    doc.folios.reduce((a: number, f: any) => a + f.count, 0);
  assert.ok(committed, "the payment committed during the print");
  assert.deepEqual(
    {
      payments: printed.payments,
      folios: folioCount(printed),
      expected: printed.cash.expected,
      print: printed.printNumber,
    },
    {
      payments: before.payments,
      folios: folioCount(before),
      expected: before.cash.expected,
      print: 1,
    },
  );
  const afterPrint = await corteOf(printDrawer);
  assert.deepEqual(
    [afterPrint.payments, folioCount(afterPrint)],
    [before.payments + 1, folioCount(before) + 1],
  );
  // The corte del día: fiscal's summary (read last) sees no ticket the sales statement missed.
  const dayBefore: any = await demoRead((tx) =>
    C.dayCorte(tx, demoManager, demoToday, "req", ports),
  );
  let dayCommitted = false;
  const dayPrinted: any = await C.printDayCorte(
    sql,
    demoManager,
    demoToday,
    { operationId: id() },
    {
      ...ports,
      fiscalSummary: async (tx: Tx, s: any, range: any) => {
        if (!dayCommitted) {
          dayCommitted = true;
          await sale(dev.print);
        }
        return ports.fiscalSummary(tx, s, range);
      },
    },
  );
  assert.ok(dayCommitted, "the payment committed during the print");
  assert.deepEqual(
    {
      ticketed: dayPrinted.summary.sales.ticketed.count,
      tickets: dayPrinted.summary.tax.tickets.count,
    },
    {
      ticketed: dayBefore.summary.sales.ticketed.count,
      tickets: dayBefore.summary.tax.tickets.count,
    },
  );
  ok(
    "CORTES-2: a payment committed between the statements of a corte X or corte del día print is in none of its figures (one REPEATABLE READ snapshot); the print number comes from the READ COMMITTED transaction",
  );

  // ---- REPORTS-CONTRACTS-2: a check comped to zero (fiscal issues no ticket for a zero total)
  // still adds its food cost to Costo de lo vendido.
  const cogsToday = async () =>
    (
      await demoRead((tx) =>
        S.salesSummary(
          tx,
          demoManager,
          { from: demoToday, to: demoToday },
          "req",
          ports,
        ),
      )
    ).sales.cogs;
  const staffMeal: any = await demoRun((tx) =>
    createOrder(tx, demoOwner(dev.print), {
      operationId: id(),
      lines: [
        { id: id(), productId: taco.id, quantity: 2, options: [], note: "" },
      ],
      mode: "takeaway",
      tableId: null,
      name: "Comida del personal",
      note: "",
      channel: "pos",
    }),
  );
  const cogsBefore = await cogsToday();
  const compBody: any = {
    operationId: id(),
    expectedVersion: staffMeal.version,
    scope: "order",
    kind: "comp",
    reasonCode: "staff_meal",
    note: "",
  };
  Object.assign(
    compBody,
    discountExpectation(staffMeal, planDiscount(staffMeal, compBody)),
  );
  const compOwner = demoOwner(dev.print);
  const approval = await approvalFor(sql, compOwner, undefined, "conditional");
  await demoRun((tx) =>
    applyDiscount(tx, compOwner, staffMeal.id, compBody, approval),
  );
  const comped: any = await demoRun((tx) => getOrder(tx, staffMeal.id));
  assert.equal(comped.total, 0);
  assert.equal(await cogsToday(), cogsBefore + 2 * taco.cost);
  ok(
    "CONTRACTS-2: a check comped to zero (no fiscal ticket) adds its units' cost to COGS",
  );

  console.log(`Reports (fiscal and discounts) DB passed (${checks} checks)`);
} finally {
  await removeTenants(admin, [T], [ORG]);
  await sql.end();
  await admin.end();
}
