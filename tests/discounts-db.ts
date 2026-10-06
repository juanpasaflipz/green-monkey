// Discounts, refunds and drawer controls (028) against PostgreSQL: the
// commands, the triggers and the role/RLS boundaries (specs/discounts.md §7.2).
// Fixture: the two demo tenants; a manager and a server created per run with
// unique logins; three devices of this run with their own drawers. Money rows
// are left in place (the isolated test database is disposable; refunds,
// discounts and closed drawers refuse DELETE).
//
// Fiscal 027 merged first (wave2-cross-track §2): DB 7's ticket, DB 8's
// ticket case, DB 13, 21, 37 and 38 and the fiscal assertions of the balance
// and whole-check comp checks run against fiscal's real ticket and refund tax.
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { hash, password } from "../server/auth.js";
import { checkRole, connect, tenant, type Tx } from "../server/db.js";
import {
  createOrder,
  getOrder,
  getOrders,
  recordPayment,
  stock,
} from "../server/orders.js";
import { catalog } from "../server/menu-read.js";
import {
  acknowledgeVoids,
  voidLines,
  verifyApproval,
} from "../server/voids.js";
import { clearStaleRounds, kitchenFeed } from "../server/kitchen.js";
import {
  decideOfflineKitchen,
  placeRoundsInOfflineReview,
} from "../server/offline-kitchen.js";
import { closeCheck, listOrders } from "../server/checks.js";
import { assignService, progressPreparation } from "../server/service.js";
import {
  adjustmentRows,
  applyDiscount,
  discountsByLine,
  getMoneyControls,
  reverseDiscount,
  saveMoneyControls,
} from "../server/discounts.js";
import { insertRefundBatch, recordRefund, refund } from "../server/refunds.js";
import { recordPaidOut } from "../server/operations.js";
import {
  cashHistory,
  cashSummary,
  closeCash,
  drawerTotals,
  reviewDrawer,
} from "../server/cash.js";
import { approvalFor } from "../server/routes/discounts.js";
import { businessDate, type Order, type Session } from "../shared/domain.js";
import {
  discountExpectation,
  itemRefundExpectation,
  planDiscount,
  planItemRefund,
} from "../shared/discounts.js";
import { extractTax } from "../shared/tax.js";
import type { SessionAccess } from "../shared/access.js";
import { discountRemovable } from "../src/features/discounts/format.js";
import { isolatedTarget } from "./isolated-target.js";
import { noRetries } from "./db-retries.js";

const { runtime: url, migration } = isolatedTarget(process.env);
const sql = connect(url),
  admin = postgres(migration, { max: 1 });
await checkRole(sql);
// This suite creates a few hundred orders; their kitchen_dispatch jobs are
// removed at the end so a rerun of the qualification chain never meets a
// backlog that the jobs suite's drain check cannot clear in time.
const [{ started }] = await admin`select clock_timestamp() as started`;

const tenantId = "10000000-0000-4000-8000-000000000001";
const otherTenantId = "10000000-0000-4000-8000-000000000002";
const ownerId = "20000000-0000-4000-8000-000000000001";
const cashierId = "20000000-0000-4000-8001-000000000001";
const kitchenId = "20000000-0000-4000-8002-000000000001";
const otherOwnerId = "20000000-0000-4000-8000-000000000002";
const restaurant = {
  name: "Test",
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
};

// Per-run people and devices; unique logins so reruns never collide.
const managerId = randomUUID();
const serverId = randomUUID();
const managerPin = "4321";
const devices = {
  a: randomUUID(),
  b: randomUUID(),
  c: randomUUID(),
  d: randomUUID(),
};
await admin.begin(async (tx) => {
  await tx`select set_config('app.tenant_id',${tenantId},true)`;
  await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
    values(${tenantId},${managerId},'Gerente descuentos',${"dmgr-" + managerId.slice(0, 8)},${password(managerPin)},'manager'),
          (${tenantId},${serverId},'Mesero descuentos',${"dsrv-" + serverId.slice(0, 8)},${password("8642")},'server')`;
  for (const [name, deviceId] of Object.entries(devices))
    await tx`insert into devices(tenant_id,id,name,token_hash,kind,paired_at)
      values(${tenantId},${deviceId},${"Caja descuentos " + name},${hash(randomUUID())},'terminal',now())`;
});

const base = {
  expiresAt: "",
  offlineUntil: "",
  csrf: "",
  restaurant,
};
function as(
  employeeId: string,
  role: string,
  deviceId = devices.a,
  access?: Partial<SessionAccess>,
  tenant = tenantId,
): Session {
  return {
    ...base,
    id: randomUUID(),
    tenantId: tenant,
    employeeId,
    deviceId,
    role,
    name: role,
    ...(access
      ? {
          access: {
            absoluteExpiresAt: null,
            authenticatedAt: new Date().toISOString(),
            deviceName: "Caja descuentos",
            deviceKind: "terminal",
            idleLockSeconds: null,
            ownerAccount: false,
            ...access,
          } as SessionAccess,
        }
      : {}),
  };
}
const owner = as(ownerId, "owner");
const manager = as(managerId, "manager");
const cashier = as(cashierId, "cashier");
const server = as(serverId, "server");
const kitchen = as(kitchenId, "kitchen");
const otherDevice = "30000000-0000-4000-8000-000000000002";
const foreign = as(
  otherOwnerId,
  "owner",
  otherDevice,
  undefined,
  otherTenantId,
);
const foreignKitchen = as(
  "20000000-0000-4000-8002-000000000002",
  "kitchen",
  otherDevice,
  undefined,
  otherTenantId,
);
const managerApproval = { employeeId: managerId, secret: managerPin };

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
async function rejects(promise: Promise<unknown>, code: string | RegExp) {
  await assert.rejects(promise, (e: any) => {
    const got = String(e.code ?? e.message);
    if (code instanceof RegExp) assert.match(`${got} ${e.message ?? ""}`, code);
    else assert.equal(got, code, `expected ${code}, got ${got} (${e.message})`);
    return true;
  });
}
const run = <T>(s: Session, fn: (tx: Tx) => Promise<T>) =>
  tenant(sql, s.tenantId, fn);
/** The id of an order's line for a product (lines come back in (round, id) order). */
const lineOf = (o: Order, product: { id: string }) =>
  o.lines.find((l) => l.productId === product.id)!.id;
/** Plain JSON, as once() stores and replays a result. */
const json = (x: unknown) => JSON.parse(JSON.stringify(x));
const orderOf = (id: string, s: Session = owner) =>
  run(s, (tx) => getOrder(tx, id));

// Catalog: a kitchen product with a recipe, a kitchen product without one and a bar drink.
const products = await run(owner, catalog);
const find = (es: string) => {
  const p = products.find((x) => x.name.es === es);
  assert(p, `fixture product ${es}`);
  return p;
};
const taco = find("Taco de hongos"); // 4500, recipe: 1 tortilla preparada
const bowl = find("Bowl de la casa"); // 12500
const agua = find("Agua de jamaica"); // 3500, bar
assert.equal(taco.price, 4500);
assert(taco.recipe?.length, "the taco has a recipe");
const tables = await run(
  owner,
  (tx) =>
    tx`select id from dining_tables where archived_at is null order by name`,
);

type LineSpec = { product: typeof taco; quantity: number };
async function newOrder(
  lines: LineSpec[],
  o: { s?: Session; mode?: string; tableId?: string | null } = {},
): Promise<Order> {
  const s = o.s ?? owner;
  return run(s, (tx) =>
    createOrder(tx, s, {
      operationId: randomUUID(),
      lines: lines.map((l) => ({
        id: randomUUID(),
        productId: l.product.id,
        quantity: l.quantity,
        options: [],
        note: "",
      })),
      mode: o.mode ?? (o.tableId ? "dine_in" : "takeaway"),
      tableId: o.tableId ?? null,
      name: "Descuentos",
      note: "",
      channel: "pos",
    }),
  );
}
async function pay(
  orderId: string,
  amount: number,
  o: {
    s?: Session;
    method?: "cash" | "external";
    tip?: number;
    items?: string[];
    reference?: string;
  } = {},
) {
  const s = o.s ?? owner;
  const method = o.method ?? "cash";
  return run(s, (tx) =>
    recordPayment(tx, s, orderId, {
      operationId: randomUUID(),
      amount,
      tip: o.tip ?? 0,
      received: method === "cash" ? amount + (o.tip ?? 0) : 0,
      method,
      externalConfirmed: method === "external",
      reference: method === "external" ? (o.reference ?? "T-482913") : "",
      ...(o.items ? { items: o.items } : {}),
    }),
  );
}
async function openDrawer(deviceId: string, opening = 0) {
  return run(owner, async (tx) => {
    const [d] =
      await tx`select id from cash_sessions where device_id=${deviceId} and closed_at is null`;
    if (d) return d.id as string;
    const id = randomUUID();
    await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${tenantId},${id},${deviceId},${ownerId},${opening})`;
    return id;
  });
}
/**
 * The discount preview a client shows (DSC-R13), as DiscountDialog sends it.
 * When the client's own planning refuses the request, placeholders let the
 * server's planning (or an earlier check) answer first.
 */
function discountPreviewOf(order: Order, body: any) {
  try {
    return discountExpectation(order, planDiscount(order, body));
  } catch {
    return {
      expectedAmount: 1,
      expectedBase: 1,
      expectedAllocations: [
        {
          lineId: body.lineId ?? order.lines[0]?.id ?? randomUUID(),
          units: [0],
          amounts: [1],
        },
      ],
      expectedDue: 0,
      expectedCloses: false,
    };
  }
}
/**
 * The route's two steps: the approval, then the command in its own
 * transaction. Like a client that just loaded the order, a body without the
 * preview fields gets them from the current order, written into the body so
 * replaying the same body object sends the same request (same once()
 * fingerprint). Stale-preview tests pass their own.
 */
async function discount(s: Session, orderId: string, body: any) {
  if (body.expectedAmount === undefined)
    Object.assign(body, discountPreviewOf(await orderOf(orderId, s), body));
  const a = await approvalFor(sql, s, body.approval, "conditional");
  return run(s, (tx) => applyDiscount(tx, s, orderId, body, a));
}
async function reverse(
  s: Session,
  orderId: string,
  discountId: string,
  body: any,
) {
  const a = await approvalFor(sql, s, body.approval, "required");
  return run(s, (tx) => reverseDiscount(tx, s, orderId, discountId, body, a));
}
/**
 * The refund state a client previewed (DSC-R9), as RefundDialog sends it:
 * the order's refunded total and, for item refunds, the planned units.
 */
function previewOf(order: Order, body: any) {
  const out: any = { expectedRefunded: order.refunded };
  if (body.mode === "items")
    try {
      const plan = planItemRefund(order, body.lines);
      out.expectedUnits = itemRefundExpectation(plan).expectedUnits;
    } catch {
      // The server's own planning refuses this request first.
      out.expectedUnits = body.lines.map((l: { lineId: string }) => ({
        lineId: l.lineId,
        units: [0],
      }));
    }
  return out;
}
/**
 * Like a client that just loaded the order, a body without the preview fields
 * gets them from the current order. They are written into the body, so
 * replaying the same body object sends the same request (same once()
 * fingerprint). Stale-preview tests pass their own.
 */
async function refundOrder(s: Session, orderId: string, body: any) {
  if (
    body.expectedRefunded === undefined ||
    (body.mode === "items" && body.expectedUnits === undefined)
  ) {
    const preview = previewOf(await orderOf(orderId, s), body);
    body.expectedRefunded ??= preview.expectedRefunded;
    if (body.mode === "items") body.expectedUnits ??= preview.expectedUnits;
  }
  const a = await approvalFor(sql, s, body.approval, "required");
  return run(s, (tx) => recordRefund(tx, s, orderId, body, a));
}
const percentBody = (o: Order, bps: number, extra: object = {}) => ({
  operationId: randomUUID(),
  expectedVersion: o.version,
  scope: "order",
  kind: "percent",
  percentBps: bps,
  reasonCode: "senior_inapam",
  ...extra,
});
const itemsBody = (
  lines: { lineId: string; quantity: number }[],
  expectedAmount: number,
  extra: object = {},
) => ({
  mode: "items",
  operationId: randomUUID(),
  lines,
  expectedAmount,
  restock: false,
  reasonCode: "quality",
  note: "frío",
  ...extra,
});
async function setControls(patch: Partial<Record<string, unknown>> = {}) {
  const current = await run(owner, (tx) => getMoneyControls(tx, owner));
  return run(owner, (tx) =>
    saveMoneyControls(tx, owner, {
      operationId: randomUUID(),
      expectedVersion: current.version,
      limits: {
        cashier: { maxPercentBps: 0, maxAmount: 0 },
        server: { maxPercentBps: 0, maxAmount: 0 },
      },
      blindClose: true,
      expectedRoles: ["manager"],
      closeRoles: [],
      ...patch,
    }),
  );
}
async function resetManagerPin() {
  await admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id',${tenantId},true)`;
    await tx`update employees set failed_attempts=0,locked_until=null where id=${managerId}`;
    await tx`delete from pin_throttles where employee_id=${managerId}`;
  });
}
const counts = async (orderId: string) => {
  const [r] = await run(
    owner,
    (tx) => tx`select
      (select count(*)::int from discounts where order_id=${orderId}) as discounts,
      (select count(*)::int from refund_batches where order_id=${orderId}) as batches,
      (select count(*)::int from refunds r join tenders t on t.tenant_id=r.tenant_id and t.id=r.tender_id
         where t.order_id=${orderId}) as refunds`,
  );
  return r as { discounts: number; batches: number; refunds: number };
};

try {
  // Device A sells; B and C open their drawers in the drawer tests with a known float.
  await openDrawer(devices.a);
  await setControls();

  await test("FIT-8: a 10% order discount stores immutable unit allocations, lowers orders.total and sets orders.discount", async () => {
    const o = await newOrder([
      { product: taco, quantity: 2 },
      { product: bowl, quantity: 1 },
    ]);
    assert.equal(o.total, 21500);
    const after = await discount(manager, o.id, percentBody(o, 1000));
    assert.equal(after.total, 19350);
    assert.equal(after.discount, 2150);
    assert.equal(after.version, o.version + 1);
    const [d] = after.discounts!;
    assert.equal(d.scope, "order");
    assert.equal(d.base, 21500);
    assert.equal(d.amount, 2150);
    assert.equal(d.activeAmount, 2150);
    assert.equal(
      d.approverName,
      "Gerente descuentos",
      "L3: the approver is stored even when it is the actor",
    );
    assert.equal(d.actorName, "Gerente descuentos");
    assert.deepEqual(
      d.allocations
        .map((a) => [
          a.lineId === lineOf(o, taco) ? "taco" : "bowl",
          a.unit,
          a.amount,
        ])
        .sort(),
      [
        ["bowl", 0, 1250],
        ["taco", 0, 450],
        ["taco", 1, 450],
      ],
    );
    for (const u of after.paymentUnits!)
      assert.equal(u.due, u.total - u.discount);
    assert.deepEqual(after.lineDiscounts, {
      [lineOf(o, taco)]: 900,
      [lineOf(o, bowl)]: 1250,
    });
    assert.deepEqual(
      await run(owner, (tx) => discountsByLine(tx, o.id)),
      after.lineDiscounts,
    );
  });

  await test("FIT-8: a cashier's discount over the limit without approval fails with approval_required and stores nothing; with a manager PIN it succeeds and records the approver", async () => {
    const o = await newOrder([{ product: taco, quantity: 2 }], { s: cashier });
    await rejects(
      discount(cashier, o.id, percentBody(o, 1000)),
      "approval_required",
    );
    assert.equal((await counts(o.id)).discounts, 0);
    assert.equal((await orderOf(o.id)).total, 9000);
    await rejects(
      discount(
        cashier,
        o.id,
        percentBody(o, 1000, {
          approval: { employeeId: managerId, secret: "0000" },
        }),
      ),
      "approval_denied",
    );
    await resetManagerPin();
    const after = await discount(
      cashier,
      o.id,
      percentBody(o, 1000, { approval: managerApproval }),
    );
    assert.equal(after.total, 8100);
    const [row] = await run(
      owner,
      (tx) =>
        tx`select actor_id,approver_id,device_id from discounts where order_id=${o.id}`,
    );
    assert.equal(row.actor_id, cashierId);
    assert.equal(row.approver_id, managerId);
    assert.equal(row.device_id, devices.a);
    assert.equal(after.discounts![0].approverName, "Gerente descuentos");
  });

  await test("FIT-8: a discount within the configured cashier limit needs no approval and records approver null", async () => {
    await setControls({
      limits: {
        cashier: { maxPercentBps: 1000, maxAmount: 1000 },
        server: { maxPercentBps: 0, maxAmount: 0 },
      },
    });
    try {
      const o = await newOrder([{ product: taco, quantity: 2 }], {
        s: cashier,
      });
      // 10 % of 9000 = 900 ≤ 1000 and ≤ 10 %.
      const after = await discount(cashier, o.id, percentBody(o, 1000));
      assert.equal(after.total, 8100);
      assert.equal(after.discounts![0].approverName, null);
      // 15 % exceeds the percentage limit.
      const second = await newOrder([{ product: taco, quantity: 2 }], {
        s: cashier,
      });
      await rejects(
        discount(cashier, second.id, percentBody(second, 1500)),
        "approval_required",
      );
      // A server keeps the default 0 % limit.
      const third = await newOrder([{ product: taco, quantity: 1 }], {
        s: server,
      });
      await rejects(
        discount(server, third.id, percentBody(third, 500)),
        "approval_required",
      );
    } finally {
      await setControls();
    }
  });

  await test("FIT-8: comp of one unit; item-split payment of the rest charges only the discounted due", async () => {
    const o = await newOrder([{ product: taco, quantity: 3 }]);
    const line = o.lines[0].id;
    const comped = await discount(manager, o.id, {
      operationId: randomUUID(),
      expectedVersion: o.version,
      scope: "line",
      lineId: line,
      quantity: 1,
      kind: "comp",
      reasonCode: "courtesy",
    });
    assert.equal(comped.total, 9000);
    assert.deepEqual(
      comped.paymentUnits!.map((u) => [u.unit, u.due, u.discount]),
      [
        [0, 0, 4500],
        [1, 4500, 0],
        [2, 4500, 0],
      ],
    );
    await rejects(pay(o.id, 4500, { items: [`${line}:0`] }), "items_changed");
    const paid = await pay(o.id, 9000, { items: [`${line}:1`, `${line}:2`] });
    assert.equal(paid.paid, 9000);
    assert.equal(paid.checkState, "closed");
    const allocations = await run(
      owner,
      (tx) =>
        tx`select unit_index,amount from tender_allocations where order_id=${o.id} order by unit_index`,
    );
    assert.deepEqual(
      allocations.map((a) => [a.unit_index, a.amount]),
      [
        [1, 4500],
        [2, 4500],
      ],
    );
  });

  await test("discount replay with the same operationId returns the same order; a different body conflicts", async () => {
    const o = await newOrder([{ product: bowl, quantity: 1 }]);
    const body = percentBody(o, 1500);
    const first = await discount(manager, o.id, body);
    const again = await discount(manager, o.id, body);
    assert.deepEqual(json(again), json(first));
    assert.equal((await counts(o.id)).discounts, 1);
    await rejects(
      discount(manager, o.id, { ...body, percentBps: 2000 }),
      "operation_conflict",
    );
  });

  await test("discount after a partial payment touches only unpaid units; the trigger rejects an allocation above a unit due", async () => {
    const o = await newOrder([{ product: taco, quantity: 2 }]);
    await pay(o.id, 4500);
    const after = await discount(manager, o.id, {
      operationId: randomUUID(),
      expectedVersion: o.version,
      scope: "order",
      kind: "comp",
      reasonCode: "complaint",
    });
    assert.equal(after.discounts![0].base, 4500);
    assert.deepEqual(
      after.discounts![0].allocations.map((a) => a.unit),
      [1],
    );
    assert.equal(after.total, 4500);
    assert.equal(after.checkState, "closed", "comped to a zero balance closes");
    // Raw writes as the runtime role: an allocation on the paid unit 0.
    await rejects(
      run(owner, async (tx) => {
        const id = randomUUID();
        await tx`insert into discounts(tenant_id,id,order_id,scope,line_id,kind,requested_amount,base,amount,units,reason_code,actor_id,device_id)
          values(${tenantId},${id},${o.id},'line',${o.lines[0].id},'amount',1,1,1,1,'courtesy',${ownerId},${devices.a})`;
        await tx`insert into discount_allocations(tenant_id,discount_id,order_id,line_id,unit_index,amount)
          values(${tenantId},${id},${o.id},${o.lines[0].id},0,1)`;
      }),
      /discount exceeds the unit due/,
    );
  });

  await test("a discount that brings the balance to zero settles the check (fiscal: and issues the ticket in the same transaction)", async () => {
    const o = await newOrder([{ product: bowl, quantity: 1 }]);
    await pay(o.id, 10000);
    const after = await discount(manager, o.id, {
      operationId: randomUUID(),
      expectedVersion: (await orderOf(o.id)).version,
      scope: "order",
      kind: "amount",
      amount: 2500,
      reasonCode: "regular_customer",
    });
    assert.equal(after.total, 10000);
    assert.equal(after.checkState, "closed");
    assert.equal(after.closeReason, "settled");
    const [t] = await run(
      owner,
      (tx) =>
        tx`select gross,discount from fiscal_tickets where order_id=${o.id}`,
    );
    assert.equal(
      t.gross,
      10000,
      "fiscal: the ticket is issued for the net total",
    );
  });

  await test("fiscal: a discount on a ticketed check fails with fiscal_ticket_issued", async () => {
    const table = tables[2].id as string;
    const o = await newOrder([{ product: taco, quantity: 2 }], {
      tableId: table,
    });
    await pay(o.id, 9000);
    const paid = await orderOf(o.id);
    assert.equal(paid.checkState, "paid");
    await rejects(
      discount(manager, o.id, percentBody(paid, 1000)),
      "fiscal_ticket_issued",
    );
    await run(owner, (tx) =>
      closeCheck(tx, owner, o.id, { operationId: randomUUID() }),
    );
  });

  await test("a discount on a closed check fails with check_closed; a stale version with stale_order", async () => {
    const o = await newOrder([{ product: taco, quantity: 1 }]);
    await pay(o.id, 4500);
    const closed = await orderOf(o.id);
    assert.equal(closed.checkState, "closed");
    await rejects(
      discount(manager, o.id, percentBody(closed, 1000)),
      "check_closed",
    );
    const open = await newOrder([{ product: taco, quantity: 1 }]);
    await rejects(
      discount(
        manager,
        open.id,
        percentBody(open, 1000, { expectedVersion: 99 }),
      ),
      "stale_order",
    );
  });

  await test("DSC-R13: a whole-check comp previewed before another device charged one taco answers discount_changed, stores nothing and keeps the version; confirmed again with the same operation id on the current check it comps only what is due; a replay after that success still replays", async () => {
    const o = await newOrder([{ product: taco, quantity: 4 }]);
    const line = o.lines[0].id;
    const request = {
      operationId: randomUUID(),
      expectedVersion: o.version,
      scope: "order",
      kind: "comp",
      reasonCode: "complaint",
    };
    // The dialog's preview: −$180.00 on four tacos, balance $0.00.
    const preview = discountPreviewOf(o, request);
    assert.equal(preview.expectedAmount, 18000);
    assert.equal(preview.expectedCloses, true);
    // Another terminal charges one taco by item split: orders.version stays.
    const paid = await pay(o.id, 4500, { items: [`${line}:0`] });
    assert.equal(paid.version, o.version, "payments do not bump the version");
    await rejects(
      discount(manager, o.id, { ...request, ...preview }),
      "discount_changed",
    );
    const after = await orderOf(o.id);
    assert.equal((await counts(o.id)).discounts, 0, "nothing is stored");
    assert.equal(after.version, o.version);
    assert.equal(after.total, 18000);
    assert.equal(after.discount, 0);
    assert.equal(after.checkState, "open");
    // The dialog reloads, keeps its inputs and operation id, and the next
    // confirm records exactly the new preview: −$135.00 on the three unpaid tacos.
    const retry = { ...request, ...discountPreviewOf(after, request) };
    assert.equal(retry.expectedAmount, 13500);
    const comped = await discount(manager, o.id, retry);
    assert.equal(comped.discounts![0].amount, 13500);
    assert.deepEqual(
      comped.discounts![0].allocations.map((a) => a.unit),
      [1, 2, 3],
    );
    assert.equal(comped.total, 4500);
    assert.equal(comped.checkState, "closed");
    // A lost response retried with the same body replays the stored result.
    assert.deepEqual(json(await discount(manager, o.id, retry)), json(comped));
    assert.equal((await counts(o.id)).discounts, 1);
  });

  await test("DSC-R13: a 10% check discount previewed at −$18.00 answers discount_changed after another device collects $45.00 by amount; the current preview (−$13.50) succeeds", async () => {
    const o = await newOrder([{ product: taco, quantity: 4 }]);
    const request = percentBody(o, 1000);
    const preview = discountPreviewOf(o, request);
    assert.equal(preview.expectedAmount, 1800);
    await pay(o.id, 4500);
    await rejects(
      discount(manager, o.id, { ...request, ...preview }),
      "discount_changed",
    );
    assert.equal((await counts(o.id)).discounts, 0);
    const current = await orderOf(o.id);
    const done = await discount(manager, o.id, {
      ...request,
      ...discountPreviewOf(current, request),
    });
    assert.equal(done.discount, 1350);
    assert.equal(done.total, 18000 - 1350);
  });

  await test("DSC-R13: a fixed-amount line discount previewed with no closing warning is refused when a payment of the other line in between would make it close the takeaway check (same plan, different outcome)", async () => {
    const o = await newOrder([
      { product: taco, quantity: 1 },
      { product: bowl, quantity: 1 },
    ]);
    const tacoLine = lineOf(o, taco);
    const bowlLine = lineOf(o, bowl);
    const request = {
      operationId: randomUUID(),
      expectedVersion: o.version,
      scope: "line",
      lineId: tacoLine,
      quantity: 1,
      kind: "amount",
      amount: 4500,
      reasonCode: "regular_customer",
    };
    const preview = discountPreviewOf(o, request);
    assert.equal(preview.expectedCloses, false, "the dialog shows no warning");
    assert.equal(preview.expectedDue, 17000);
    await pay(o.id, 12500, { items: [`${bowlLine}:0`] });
    const now = await orderOf(o.id);
    // The server's plan alone is unchanged: only the outcome moved.
    assert.deepEqual(
      discountPreviewOf(now, request).expectedAllocations,
      preview.expectedAllocations,
    );
    assert.equal(discountPreviewOf(now, request).expectedCloses, true);
    await rejects(
      discount(manager, o.id, { ...request, ...preview }),
      "discount_changed",
    );
    const after = await orderOf(o.id);
    assert.equal((await counts(o.id)).discounts, 0);
    assert.equal(after.checkState, "open", "the check did not close");
    assert.equal(after.total, 17000);
  });

  await test("DSC-R13: a comp previewed on a table check (no closing warning) is refused after the check was moved to takeaway, which does not bump orders.version", async () => {
    const table = tables[6].id as string;
    const o = await newOrder([{ product: taco, quantity: 1 }], {
      tableId: table,
    });
    const request = {
      operationId: randomUUID(),
      expectedVersion: o.version,
      scope: "order",
      kind: "comp",
      reasonCode: "courtesy",
    };
    const preview = discountPreviewOf(o, request);
    assert.equal(preview.expectedCloses, false);
    const moved = await run(owner, (tx) =>
      assignService(tx, owner, o.id, {
        operationId: randomUUID(),
        expectedVersion: o.serviceVersion,
        tableId: null,
        employeeId: ownerId,
        mode: "takeaway",
        reason: "Se lo lleva",
      }),
    );
    assert.equal((moved as Order).version, o.version);
    await rejects(
      discount(manager, o.id, { ...request, ...preview }),
      "discount_changed",
    );
    assert.equal((await counts(o.id)).discounts, 0);
    // Confirmed on the current check (with its closing warning), it closes.
    const current = await orderOf(o.id);
    const closed = await discount(manager, o.id, {
      ...request,
      ...discountPreviewOf(current, request),
    });
    assert.equal(closed.checkState, "closed");
  });

  await test("reversal restores total and discount, is LIFO, and is refused once a unit was paid", async () => {
    const o = await newOrder([{ product: taco, quantity: 2 }]);
    const line = o.lines[0].id;
    const d1 = await discount(manager, o.id, percentBody(o, 1000));
    const d2 = await discount(manager, o.id, {
      operationId: randomUUID(),
      expectedVersion: d1.version,
      scope: "line",
      lineId: line,
      quantity: 1,
      kind: "comp",
      reasonCode: "courtesy",
    });
    assert.equal(d2.total, 4050);
    const [first, second] = d2.discounts!;
    const reason = { note: "Se aplicó por error" };
    await rejects(
      reverse(manager, o.id, first.id, {
        operationId: randomUUID(),
        expectedVersion: d2.version,
        ...reason,
      }),
      "discount_not_reversible",
    );
    const r2 = await reverse(manager, o.id, second.id, {
      operationId: randomUUID(),
      expectedVersion: d2.version,
      ...reason,
    });
    assert.equal(r2.total, 8100);
    assert.equal(r2.discount, 900);
    const reversed = r2.discounts!.find((d) => d.id === second.id)!;
    assert.equal(reversed.activeAmount, 0);
    assert.equal(reversed.reversal!.amount, 4050);
    assert.equal(reversed.reversal!.byName, "Gerente descuentos");
    const r1 = await reverse(manager, o.id, first.id, {
      operationId: randomUUID(),
      expectedVersion: r2.version,
      ...reason,
    });
    assert.equal(r1.total, 9000);
    assert.equal(r1.discount, 0);
    // A second reversal of the same discount is refused.
    await rejects(
      reverse(manager, o.id, first.id, {
        operationId: randomUUID(),
        expectedVersion: r1.version,
        ...reason,
      }),
      "discount_not_reversible",
    );
    // Once any of its units is paid, a discount stays.
    const d3 = await discount(manager, o.id, percentBody(r1, 1000));
    await pay(o.id, 1000, { items: undefined });
    await rejects(
      reverse(manager, o.id, d3.discounts!.at(-1)!.id, {
        operationId: randomUUID(),
        expectedVersion: (await orderOf(o.id)).version,
        ...reason,
      }),
      "discount_not_reversible",
    );
    // Staff need a manager approval to remove a discount.
    await rejects(
      reverse(cashier, o.id, d3.discounts!.at(-1)!.id, {
        operationId: randomUUID(),
        expectedVersion: (await orderOf(o.id)).version,
        ...reason,
      }),
      "approval_required",
    );
  });

  // Shared by later tests: an order with one discount, a refund batch and a review.
  const sample = await newOrder([{ product: taco, quantity: 2 }]);
  const sampleDiscounted = await discount(
    manager,
    sample.id,
    percentBody(sample, 1000),
  );
  await pay(sample.id, sampleDiscounted.total);
  const sampleRefund = await refundOrder(
    manager,
    sample.id,
    itemsBody([{ lineId: sample.lines[0].id, quantity: 1 }], 4050),
  );

  await test("immutability: gm_app cannot update or delete discount_allocations, refund_batches, refund_units, refunds or reviews; discounts allow only one reversal; even a superuser/owner connection is stopped by the triggers", async () => {
    const batchId = sampleRefund.batch.id;
    const discountId = sampleDiscounted.discounts![0].id;
    for (const statement of [
      (tx: Tx) =>
        tx`update discount_allocations set amount=amount where discount_id=${discountId}`,
      (tx: Tx) =>
        tx`delete from discount_allocations where discount_id=${discountId}`,
      (tx: Tx) => tx`update refund_batches set note='x' where id=${batchId}`,
      (tx: Tx) => tx`delete from refund_batches where id=${batchId}`,
      (tx: Tx) =>
        tx`update refund_units set amount=1 where batch_id=${batchId}`,
      (tx: Tx) => tx`update refunds set amount=1 where batch_id=${batchId}`,
      (tx: Tx) => tx`delete from refunds where batch_id=${batchId}`,
      (tx: Tx) => tx`update discounts set amount=1 where id=${discountId}`,
      (tx: Tx) => tx`delete from discounts where id=${discountId}`,
      (tx: Tx) => tx`delete from cash_count_reviews`,
      (tx: Tx) => tx`delete from cash_sessions where device_id=${devices.a}`,
    ])
      await rejects(run(owner, statement), /42501|permission denied/);
    // The reversal columns are granted, but only one reversal is ever accepted.
    await rejects(
      run(
        owner,
        (tx) =>
          tx`update discounts set reversed_at=now(),reversed_by=${ownerId},reversal_note='otra vez',reversed_amount=0,note='x' where id=${discountId}`,
      ),
      /42501|permission denied/,
    );
    await rejects(
      run(
        owner,
        (tx) =>
          tx`update discounts set reversed_at=null where id=${discountId}`,
      ),
      /immutable except for a single reversal|reversed_at/,
    );
    // Even the table owner / a superuser connection is stopped by the triggers.
    const asAdmin = (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      admin.begin(async (tx) => {
        await tx`select set_config('app.tenant_id',${tenantId},true)`;
        await fn(tx);
      });
    for (const statement of [
      (tx: postgres.TransactionSql) =>
        tx`update discount_allocations set amount=amount where discount_id=${discountId}`,
      (tx: postgres.TransactionSql) =>
        tx`delete from refund_batches where id=${batchId}`,
      (tx: postgres.TransactionSql) =>
        tx`delete from refund_units where batch_id=${batchId}`,
      (tx: postgres.TransactionSql) =>
        tx`update refunds set reason='x' where batch_id=${batchId}`,
      (tx: postgres.TransactionSql) =>
        tx`delete from refunds where batch_id=${batchId}`,
      (tx: postgres.TransactionSql) =>
        tx`delete from discounts where id=${discountId}`,
      (tx: postgres.TransactionSql) =>
        tx`update discounts set note='x' where id=${discountId}`,
      (tx: postgres.TransactionSql) =>
        tx`delete from refund_lines where batch_id=${batchId}`,
      (tx: postgres.TransactionSql) => tx`truncate refund_units`,
      (tx: postgres.TransactionSql) => tx`truncate discount_allocations`,
    ])
      await rejects(asAdmin(statement), /immutable/);
    // Money records are never deleted (LD-15 Q4 (A)): refunds and cash_sessions
    // carry row DELETE and statement TRUNCATE triggers, like every 028 table.
    const guards = await admin`select c.relname as table,
        bool_or((t.tgtype & 8) <> 0) as on_delete, bool_or((t.tgtype & 32) <> 0) as on_truncate
      from pg_trigger t join pg_class c on c.oid=t.tgrelid
      where not t.tgisinternal and c.relname in ('refunds','cash_sessions','refund_batches',
        'refund_units','refund_lines','discounts','discount_allocations','cash_count_reviews')
      group by c.relname order by c.relname`;
    assert.deepEqual(
      guards.map((g) => [g.table, g.on_delete, g.on_truncate]),
      [
        ["cash_count_reviews", true, true],
        ["cash_sessions", true, true],
        ["discount_allocations", true, true],
        ["discounts", true, true],
        ["refund_batches", true, true],
        ["refund_lines", true, true],
        ["refund_units", true, true],
        ["refunds", true, true],
      ],
    );
    // A refund line takes exactly one kitchen acknowledgement, nothing else.
    await rejects(
      asAdmin(
        (tx) =>
          tx`update refund_lines set amount=amount+1 where batch_id=${batchId}`,
      ),
      /immutable except for a single kitchen acknowledgement/,
    );
  });

  await test("void of a discounted unit prefers undiscounted units, lowers the total by the net and releases the discount; line_voids.amount stays gross", async () => {
    const o = await newOrder([{ product: taco, quantity: 3 }]);
    const line = o.lines[0].id;
    const comped = await discount(manager, o.id, {
      operationId: randomUUID(),
      expectedVersion: o.version,
      scope: "line",
      lineId: line,
      quantity: 1,
      kind: "comp",
      reasonCode: "courtesy",
    });
    const voidAs = async (s: Session, order: Order, quantity: number) => {
      const body = {
        operationId: randomUUID(),
        expectedVersion: order.version,
        lines: [{ lineId: line, quantity }],
        reason: "Cliente cambió de opinión",
        stockDisposition: "no_return",
      };
      const approverId = await verifyApproval(
        sql,
        s,
        undefined,
        order.id,
        body,
      );
      return run(s, (tx) => voidLines(tx, s, order.id, body, approverId));
    };
    const one = await voidAs(manager, comped, 1);
    // Unit 2 (undiscounted, highest) goes first; the comped unit 0 stays.
    assert.deepEqual(one.lines[0].voidedUnits, [2]);
    assert.equal(one.total, 4500);
    assert.equal(one.discount, 4500);
    assert.equal(one.voids![0].amount, 4500);
    // Partial payment on unit 1, then the only unpaid unit is the comped one.
    await pay(o.id, 2000);
    const two = await voidAs(manager, await orderOf(o.id), 1);
    assert.deepEqual(two.lines[0].voidedUnits, [0, 2]);
    assert.equal(two.total, 4500, "voiding a comped unit removes no money");
    assert.equal(two.discount, 0, "its discount is released");
    assert.equal(
      two.voids!.at(-1)!.amount,
      4500,
      "line_voids.amount stays gross",
    );
    const d = two.discounts![0];
    assert.equal(d.activeAmount, 0);
    assert.equal(d.releasedAmount, 4500);
  });

  await test("deploy overlap: a raw old-style void (total −= gross) on a discounted order fails at commit; an over-allocating raw tender_allocations insert fails", async () => {
    const o = await newOrder([{ product: taco, quantity: 2 }]);
    const discounted = await discount(manager, o.id, percentBody(o, 1000));
    const line = o.lines[0].id;
    await rejects(
      run(owner, async (tx) => {
        await tx`insert into line_voids(tenant_id,id,order_id,line_id,units,amount,reason,stock_disposition,preparation_state,actor_id,approver_id,kitchen_ack_required)
          values(${tenantId},${randomUUID()},${o.id},${line},${[1]},4500,'versión anterior','not_returned','not_started',${ownerId},${ownerId},true)`;
        await tx`update orders set total=total-4500,version=version+1 where id=${o.id}`;
      }),
      /does not reconcile/,
    );
    await rejects(
      run(owner, async (tx) => {
        const tenderId = randomUUID();
        const [d] =
          await tx`select id from cash_sessions where device_id=${devices.a} and closed_at is null`;
        await tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,tip,received) values(${tenantId},${tenderId},${o.id},${d.id},'cash',4500,0,4500)`;
        await tx`insert into tender_allocations(tenant_id,order_id,tender_id,line_id,unit_index,amount) values(${tenantId},${o.id},${tenderId},${line},0,4500)`;
      }),
      /exceeds the discounted unit due/,
    );
    // The order is untouched and a correct payment of the discounted due works.
    const now = await orderOf(o.id);
    assert.equal(now.total, discounted.total);
    await pay(o.id, 4050, { items: [`${line}:0`] });
  });

  await test("fiscal: a discounted order's ticket taxes equal per-category netting and unallocated_discount is 0", async () => {
    const o = await newOrder([
      { product: taco, quantity: 2 },
      { product: bowl, quantity: 1 },
    ]);
    const d = await discount(manager, o.id, percentBody(o, 1000));
    await pay(o.id, d.total);
    const [t] = await run(
      owner,
      (tx) =>
        tx`select gross,discount,unallocated_discount,base,tax from fiscal_tickets where order_id=${o.id}`,
    );
    assert.equal(t.gross, d.total);
    assert.equal(t.discount, 2150);
    assert.equal(t.unallocated_discount, 0);
    const iva = extractTax(d.total, 1600);
    assert.equal(t.tax, iva.tax);
    assert.equal(t.base, iva.base);
  });

  await test("MON-4: card refund recorded against the original external tender with reference and confirmation; drawer cash expected unchanged; terminal net decreases", async () => {
    const drawer = await openDrawer(devices.a);
    const o = await newOrder([{ product: taco, quantity: 1 }]);
    await pay(o.id, 4500, { method: "external", reference: "T-1001" });
    const tenderId = (await orderOf(o.id)).tenders[0].id;
    const before = await run(owner, (tx) => drawerTotals(tx, drawer));
    const r = await refundOrder(
      manager,
      o.id,
      itemsBody([{ lineId: o.lines[0].id, quantity: 1 }], 4500, {
        external: [{ tenderId, reference: "R-778812", confirmed: true }],
      }),
    );
    assert.equal(r.batch.externalAmount, 4500);
    assert.equal(r.batch.cashAmount, 0);
    assert.deepEqual(r.batch.rows, [
      {
        refundId: r.batch.rows[0].refundId,
        tenderId,
        method: "external",
        amount: 4500,
        reference: "R-778812",
      },
    ]);
    const after = await run(owner, (tx) => drawerTotals(tx, drawer));
    assert.equal(after.expectedCash, before.expectedCash);
    assert.equal(after.externalRefunds, before.externalRefunds + 4500);
    assert.equal(after.externalNet, before.externalNet - 4500);
    assert.equal(r.order.refunded, 4500);
    assert.equal(r.order.total, 4500, "refunds never change the order total");
  });

  await test("MON-4: terminal refund without a reference fails with refund_external_confirmation", async () => {
    const o = await newOrder([{ product: taco, quantity: 1 }]);
    await pay(o.id, 4500, { method: "external" });
    await rejects(
      refundOrder(
        manager,
        o.id,
        itemsBody([{ lineId: o.lines[0].id, quantity: 1 }], 4500),
      ),
      "refund_external_confirmation",
    );
    await rejects(
      refundOrder(manager, o.id, {
        mode: "amount",
        operationId: randomUUID(),
        tenderId: (await orderOf(o.id)).tenders[0].id,
        amount: 1000,
        reasonCode: "charge_error",
      }),
      "refund_external_confirmation",
    );
    assert.equal((await counts(o.id)).refunds, 0);
  });

  await test("MON-4: item refund of a unit paid by cash and card creates two money rows and unit rows that sum to the allocations", async () => {
    const o = await newOrder([{ product: taco, quantity: 2 }]);
    await pay(o.id, 6000); // unit 0: 4500, unit 1: 1500
    await pay(o.id, 3000, { method: "external", reference: "T-2" }); // unit 1: 3000
    const order = await orderOf(o.id);
    const [cash, card] = order.tenders;
    const r = await refundOrder(
      manager,
      o.id,
      itemsBody([{ lineId: o.lines[0].id, quantity: 1 }], 4500, {
        external: [{ tenderId: card.id, reference: "R-2", confirmed: true }],
      }),
    );
    assert.deepEqual(
      r.batch.rows.map((x) => [x.tenderId, x.method, x.amount]),
      [
        [cash.id, "cash", 1500],
        [card.id, "external", 3000],
      ],
    );
    const units = await run(
      owner,
      (tx) => tx`select u.tender_id,u.unit_index,u.amount,a.amount as allocated
        from refund_units u join tender_allocations a on a.tenant_id=u.tenant_id and a.tender_id=u.tender_id
          and a.line_id=u.line_id and a.unit_index=u.unit_index
        where u.batch_id=${r.batch.id} order by u.amount`,
    );
    assert.deepEqual(
      units.map((u) => [u.tender_id, u.unit_index, u.amount, u.allocated]),
      [
        [cash.id, 1, 1500, 1500],
        [card.id, 1, 3000, 3000],
      ],
    );
    assert.deepEqual(
      r.batch.lines.map((l) => [l.units, l.amount]),
      [[[1], 4500]],
    );
  });

  await test("MON-4: item refund of an unserved unit appears on the KDS as cancelled, the station acknowledgement clears it and completes the round", async () => {
    // On the second demo tenant: its KDS feed (oldest 200 open rounds) is not
    // crowded by the open rounds this suite leaves on the first one.
    const s2 = foreign;
    await run(s2, async (tx) => {
      const [d] =
        await tx`select id from cash_sessions where device_id=${otherDevice} and closed_at is null`;
      if (!d)
        await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${otherTenantId},${randomUUID()},${otherDevice},${otherOwnerId},0)`;
    });
    const taco2 = (await run(s2, catalog)).find(
      (p) => p.name.es === "Taco de hongos",
    )!;
    const o = await newOrder([{ product: taco2, quantity: 1 }], { s: s2 });
    await pay(o.id, 4500, { s: s2 });
    const r = await refundOrder(
      s2,
      o.id,
      itemsBody([{ lineId: o.lines[0].id, quantity: 1 }], 4500),
    );
    assert.equal(r.batch.lines[0].preparationState, "not_started");
    assert.equal(r.batch.lines[0].kitchenPending, true);
    assert.equal(
      r.batch.approverName,
      "Alex Demo",
      "an owner acting alone approves",
    );
    const feed = await run(foreignKitchen, (tx) =>
      kitchenFeed(tx, foreignKitchen, {}),
    );
    assert(!feed.unchanged && !feed.truncated);
    const round = feed.rounds.find((x) => x.orderId === o.id)!;
    assert(round, "the round stays on the KDS with its cancellation");
    assert.equal(round.lines[0].voidedQuantity, 1);
    assert.deepEqual(
      round.pendingVoids.map((v) => [v.kind, v.quantity]),
      [["refund", 1]],
    );
    // SVC-K6: it cannot be served before the kitchen confirms the cancellation.
    await rejects(
      run(foreignKitchen, (tx) =>
        progressPreparation(tx, foreignKitchen, round.id, {
          operationId: randomUUID(),
          state: "completed",
        }),
      ),
      "void_ack_required",
    );
    const listed = await run(s2, (tx) => listOrders(tx, s2, { status: "all" }));
    const summary = listed.items.find((x) => x.id === o.id)!;
    assert.equal(summary.voidAckPending, true);
    assert.equal(summary.refundable, 0);
    await run(foreignKitchen, (tx) =>
      acknowledgeVoids(tx, foreignKitchen, round.id, {
        operationId: randomUUID(),
      }),
    );
    const again = await run(foreignKitchen, (tx) =>
      kitchenFeed(tx, foreignKitchen, {}),
    );
    assert(!again.unchanged);
    assert(!again.rounds.some((x) => x.orderId === o.id));
    const [rl] = await run(
      s2,
      (tx) =>
        tx`select kitchen_acknowledged_by from refund_lines where batch_id=${r.batch.id}`,
    );
    assert.equal(rl.kitchen_acknowledged_by, foreignKitchen.employeeId);
    const done = await orderOf(o.id, s2);
    assert.equal(done.rounds[0].state, "completed");
    assert.equal(done.total, 4500, "the sale stands");
  });

  await test("MON-4: item refund with restock returns recipe stock exactly once (replay and duplicate causal key)", async () => {
    const stockId = taco.recipe![0].stockId;
    const onHand = async () => {
      const [r] = await run(
        owner,
        (tx) =>
          tx`select on_hand::text as q from stock_items where id=${stockId}`,
      );
      return Number(r.q);
    };
    const o = await newOrder([{ product: taco, quantity: 2 }]);
    await pay(o.id, 9000);
    const before = await onHand();
    const body = itemsBody([{ lineId: o.lines[0].id, quantity: 2 }], 9000, {
      restock: true,
    });
    const r = await refundOrder(manager, o.id, body);
    assert.equal(await onHand(), before + 2);
    const again = await refundOrder(manager, o.id, body);
    assert.equal(
      again.batch.id,
      r.batch.id,
      "replay returns the stored result",
    );
    assert.equal(await onHand(), before + 2);
    const lineId = r.batch.lines[0].id;
    // The same causal key again (a retried movement) is a no-op.
    await run(owner, (tx) =>
      stock(
        tx,
        owner,
        stockId,
        "2.000000",
        "refund",
        lineId,
        "refund_return",
        "allow",
      ),
    );
    assert.equal(await onHand(), before + 2);
    const movements = await run(
      owner,
      (tx) =>
        tx`select quantity::text as q from stock_movements where cause='refund' and cause_id=${lineId}`,
    );
    assert.deepEqual(
      movements.map((m) => Number(m.q)),
      [2],
    );
    assert.equal(r.batch.lines[0].restocked, true);
  });

  await test("refund caps: 20 concurrent refunds on one tender never exceed it (code and trigger); unit refunds never exceed the allocation", async () => {
    const o = await newOrder([{ product: bowl, quantity: 1 }]);
    await pay(o.id, 12500);
    const tenderId = (await orderOf(o.id)).tenders[0].id;
    // Twenty devices refund 1000 each at once. A preview that another device's
    // refund made stale answers refund_changed (DSC-R9); like RefundDialog,
    // that device reloads and confirms again with the same operation id, until
    // it is refunded or the tender has no room left (at most one retry per
    // other device's success, so 40 attempts always suffice).
    const device = async () => {
      const operationId = randomUUID();
      for (let attempt = 0; attempt < 40; attempt++)
        try {
          return await refundOrder(manager, o.id, {
            mode: "amount",
            operationId,
            tenderId,
            amount: 1000,
            reasonCode: "charge_error",
          });
        } catch (e: any) {
          if (e.code !== "refund_changed") throw e;
        }
      throw new Error("refund_changed 40 times in a row");
    };
    // LO-R9: no burst may deadlock, even once, behind tenant()'s retry.
    const results = await noRetries("refund caps burst", () =>
      Promise.allSettled(Array.from({ length: 20 }, device)),
    );
    const ok = results.filter((x) => x.status === "fulfilled").length;
    for (const x of results)
      if (x.status === "rejected")
        assert.match(String(x.reason.code), /^refund_(exceeds|changed)$/);
    assert.equal(ok, 12);
    const [sum] = await run(
      owner,
      (tx) =>
        tx`select coalesce(sum(amount),0)::int as total from refunds where tender_id=${tenderId}`,
    );
    assert.equal(sum.total, 12000);
    // The trigger stops a raw insert past the tender (old revision without the order lock).
    const drawer = await openDrawer(devices.a);
    await rejects(
      run(
        owner,
        (
          tx,
        ) => tx`insert into refunds(tenant_id,id,tender_id,session_id,amount,reason,disposition,actor_id)
        values(${tenantId},${randomUUID()},${tenderId},${drawer},501,'old revision','discard',${ownerId})`,
      ),
      /refund exceeds its tender/,
    );
    // A unit refund past what the tender paid for that unit (the money row fits the tender).
    const unit = await newOrder([{ product: taco, quantity: 2 }]);
    await pay(unit.id, 9000);
    const unitTender = (await orderOf(unit.id)).tenders[0].id;
    await rejects(
      run(owner, (tx) =>
        insertRefundBatch(tx, manager, {
          orderId: unit.id,
          mode: "items",
          reasonCode: "quality",
          note: "",
          restock: false,
          approverId: managerId,
          businessDate: "2026-10-05",
          drawerId: drawer,
          portions: [
            {
              tenderId: unitTender,
              method: "cash",
              amount: 4501,
              reference: null,
              units: [{ lineId: unit.lines[0].id, unit: 0, amount: 4501 }],
            },
          ],
          lines: [
            {
              lineId: unit.lines[0].id,
              units: [0],
              amount: 4501,
              preparationState: "not_started",
              kitchenAck: false,
            },
          ],
        }),
      ),
      /unit refund exceeds its payment/,
    );
  });

  await test("refund method must match the tender (trigger); refund_changed when expectedAmount is stale", async () => {
    const o = await newOrder([{ product: taco, quantity: 2 }]);
    await pay(o.id, 9000);
    const tenderId = (await orderOf(o.id)).tenders[0].id;
    await rejects(
      run(
        owner,
        (
          tx,
        ) => tx`insert into refunds(tenant_id,id,tender_id,amount,reason,disposition,actor_id,method,external_reference)
        values(${tenantId},${randomUUID()},${tenderId},100,'wrong method','discard',${ownerId},'external','R-1')`,
      ),
      /refund method must match its tender/,
    );
    await rejects(
      refundOrder(
        manager,
        o.id,
        itemsBody([{ lineId: o.lines[0].id, quantity: 1 }], 4400),
      ),
      "refund_changed",
    );
    assert.equal((await counts(o.id)).batches, 0);
  });

  await test("DSC-R9: two item refunds of one identical unit built from the same stale check: the first succeeds, the second answers refund_changed and stores nothing", async () => {
    // Two staff refund the customer's one cold taco on two devices.
    const o = await newOrder([{ product: taco, quantity: 2 }]);
    await pay(o.id, 9000);
    const line = o.lines[0].id;
    const stale = await orderOf(o.id);
    const request = [{ lineId: line, quantity: 1 }];
    const first = itemsBody(
      request,
      4500,
      previewOf(stale, { mode: "items", lines: request }),
    );
    const second = itemsBody(
      request,
      4500,
      previewOf(stale, { mode: "items", lines: request }),
    );
    assert.deepEqual(first.expectedUnits, [{ lineId: line, units: [1] }]);
    const done = await refundOrder(manager, o.id, first);
    assert.equal(done.batch.amount, 4500);
    // The server would now refund unit 0 for the same 4500: the total alone
    // cannot tell the second preview is stale.
    const fresh = await orderOf(o.id);
    const next = planItemRefund(fresh, request);
    assert.equal(next.total, 4500);
    assert.deepEqual(next.lines[0].units, [0]);
    await rejects(refundOrder(manager, o.id, second), "refund_changed");
    // The units alone also tell: the refunded total is current, the units are not.
    await rejects(
      refundOrder(
        manager,
        o.id,
        itemsBody(request, 4500, {
          expectedRefunded: fresh.refunded,
          expectedUnits: [{ lineId: line, units: [1] }],
        }),
      ),
      "refund_changed",
    );
    let after = await orderOf(o.id);
    assert.equal((await counts(o.id)).batches, 1);
    assert.equal(after.refunded, 4500);
    assert.deepEqual(
      after.refundedUnits!.map((u) => u.unit),
      [1],
      "only the first refund's unit",
    );
    // After the reload the person confirms again on the current check.
    await refundOrder(manager, o.id, itemsBody(request, 4500));
    after = await orderOf(o.id);
    assert.equal(after.refunded, 9000);
    assert.equal((await counts(o.id)).batches, 2);
  });

  await test("DSC-R9: a payment in between makes a later identical unit refundable: the stale preview's units differ and the server answers refund_changed", async () => {
    const o = await newOrder([{ product: taco, quantity: 2 }]);
    const line = o.lines[0].id;
    await pay(o.id, 4500, { items: [`${line}:0`] });
    const request = [{ lineId: line, quantity: 1 }];
    const stale = await orderOf(o.id);
    const body = itemsBody(
      request,
      4500,
      previewOf(stale, { mode: "items", lines: request }),
    );
    assert.deepEqual(body.expectedUnits, [{ lineId: line, units: [0] }]);
    // Another device pays the second taco (by card): same price, same refunded total.
    await pay(o.id, 4500, { method: "external", items: [`${line}:1`] });
    const fresh = await orderOf(o.id);
    assert.equal(fresh.refunded, stale.refunded);
    assert.deepEqual(planItemRefund(fresh, request).lines[0].units, [1]);
    await rejects(refundOrder(manager, o.id, body), "refund_changed");
    assert.equal((await counts(o.id)).batches, 0);
  });

  await test("DSC-R9: amount refunds built from a stale check answer refund_changed while the tender still has capacity, after an amount or an item refund", async () => {
    const o = await newOrder([{ product: taco, quantity: 2 }]);
    await pay(o.id, 9000);
    const stale = await orderOf(o.id);
    const tenderId = stale.tenders[0].id;
    const amountBody = (expectedRefunded: number) => ({
      mode: "amount",
      operationId: randomUUID(),
      tenderId,
      amount: 1000,
      expectedRefunded,
      reasonCode: "charge_error",
      note: "",
    });
    await refundOrder(manager, o.id, amountBody(stale.refunded));
    // Same request from the same stale check: 8000 of capacity is left.
    await rejects(
      refundOrder(manager, o.id, amountBody(stale.refunded)),
      "refund_changed",
    );
    assert.equal((await orderOf(o.id)).refunded, 1000);
    // An item refund in between makes an amount preview stale too.
    const beforeItem = await orderOf(o.id);
    await refundOrder(
      manager,
      o.id,
      itemsBody([{ lineId: o.lines[0].id, quantity: 1 }], 4500),
    );
    await rejects(
      refundOrder(manager, o.id, amountBody(beforeItem.refunded)),
      "refund_changed",
    );
    const after = await orderOf(o.id);
    assert.equal(after.refunded, 5500);
    assert.equal((await counts(o.id)).batches, 2);
    // Confirmed again on the current check, it goes through.
    await refundOrder(manager, o.id, amountBody(after.refunded));
    assert.equal((await orderOf(o.id)).refunded, 6500);
  });

  await test("fiscal: each refund money row writes fiscal_adjustments with the item scope gross; a full refund nets the category IVA to zero", async () => {
    // §4.3 worked example on the iva16 taco line: a 10 % line discount on units {0,1}.
    const o = await newOrder([{ product: taco, quantity: 3 }]);
    const line = o.lines[0].id;
    const d = await discount(manager, o.id, {
      operationId: randomUUID(),
      expectedVersion: o.version,
      scope: "line",
      lineId: line,
      quantity: 2,
      kind: "percent",
      percentBps: 1000,
      reasonCode: "promotion",
    });
    assert.equal(d.total, 12600);
    await pay(o.id, 6075);
    await pay(o.id, 6525, { method: "external", reference: "T-21" });
    const card = (await orderOf(o.id)).tenders[1].id;
    const r = await refundOrder(
      manager,
      o.id,
      itemsBody([{ lineId: line, quantity: 2 }], 8550, {
        external: [{ tenderId: card, reference: "R-21", confirmed: true }],
      }),
    );
    const adjustments = await run(
      owner,
      (
        tx,
      ) => tx`select a.refund_id,a.category,a.gross,a.tax from fiscal_adjustments a
        where a.refund_id = any(${tx.array(r.batch.rows.map((x) => x.refundId))}::uuid[]) order by a.gross`,
    );
    assert.deepEqual(
      adjustments.map((a) => [a.category, a.gross, a.tax]),
      [
        ["iva16", 2025, 279],
        ["iva16", 6525, 900],
      ],
    );
    const last = await refundOrder(
      manager,
      o.id,
      itemsBody([{ lineId: line, quantity: 1 }], 4050),
    );
    const [net] = await run(
      owner,
      (
        tx,
      ) => tx`select t.tax - coalesce((select sum(a.tax) from fiscal_adjustments a where a.order_id=t.order_id),0) as tax
        from fiscal_tickets t where t.order_id=${o.id}`,
    );
    assert.equal(
      Number(net.tax),
      0,
      "refunding everything nets the IVA to zero",
    );
    assert(last.batch.rows.length === 1);
  });

  await test("lock order (binding global order): repeated 50 times concurrently, offline-style sync, a void that settles, an item refund with a kitchen cancellation and a cash portion, and plain payments on one device all commit and tenant() catches no deadlock (LO-R9: zero db_retry)", async () => {
    await openDrawer(devices.d);
    const s = as(ownerId, "owner", devices.d);
    const m = as(managerId, "manager", devices.d);
    for (let i = 0; i < 50; i++) {
      const toVoid = await newOrder(
        [
          { product: taco, quantity: 1 },
          { product: agua, quantity: 1 },
        ],
        { s },
      );
      await pay(toVoid.id, 4500, {
        s,
        items: [`${lineOf(toVoid, taco)}:0`],
      });
      const toRefund = await newOrder([{ product: taco, quantity: 2 }], { s });
      await pay(toRefund.id, 9000, { s });
      const toPay = await newOrder([{ product: bowl, quantity: 1 }], { s });
      const voidBody = {
        operationId: randomUUID(),
        expectedVersion: (await orderOf(toVoid.id)).version,
        lines: [{ lineId: lineOf(toVoid, agua), quantity: 1 }],
        reason: "Concurrencia",
        stockDisposition: "no_return",
      };
      const results = await noRetries(`lock order iteration ${i}`, () =>
        Promise.allSettled([
          // Offline-style sync: create and pay in one transaction (settles).
          run(s, async (tx) => {
            const created = await createOrder(tx, s, {
              operationId: randomUUID(),
              lines: [
                {
                  id: randomUUID(),
                  productId: taco.id,
                  quantity: 1,
                  options: [],
                  note: "",
                },
              ],
              mode: "takeaway",
              tableId: null,
              name: "sync",
              note: "",
              channel: "pos",
            });
            return recordPayment(tx, s, created.id, {
              operationId: randomUUID(),
              amount: 4500,
              tip: 0,
              received: 4500,
              method: "cash",
            });
          }),
          // A void that settles its check (the bar drink is the last unpaid unit).
          run(s, (tx) => voidLines(tx, s, toVoid.id, voidBody, ownerId)),
          refundOrder(
            m,
            toRefund.id,
            itemsBody([{ lineId: toRefund.lines[0].id, quantity: 1 }], 4500),
          ),
          pay(toPay.id, 5000, { s }),
          pay(toPay.id, 7500, { s }),
        ]),
      );
      const failed = results.filter((x) => x.status === "rejected");
      assert.deepEqual(
        failed.map(
          (x) =>
            (x as PromiseRejectedResult).reason?.code ??
            (x as PromiseRejectedResult).reason?.message,
        ),
        [],
        `iteration ${i}`,
      );
    }
  });

  await test("legacy POST /refunds: a cash refund keeps its once() fingerprint, creates a legacy batch and stays cash-only", async () => {
    const o = await newOrder([{ product: taco, quantity: 1 }]);
    await pay(o.id, 4500);
    const tenderId = (await orderOf(o.id)).tenders[0].id;
    const body = {
      operationId: randomUUID(),
      tenderId,
      amount: 1000,
      reason: "Cobro de más",
      disposition: "discard",
    };
    const first = await run(owner, (tx) => refund(tx, owner, body));
    const again = await run(owner, (tx) => refund(tx, owner, body));
    assert.deepEqual(json(again), json(first));
    assert.equal(first.refunded, 1000);
    const [op] = await run(
      owner,
      (tx) => tx`select kind,hash from operations where id=${body.operationId}`,
    );
    assert.equal(op.kind, "refund");
    assert.equal(op.hash, hash(JSON.stringify(body)), "fingerprint unchanged");
    const batches = first.refundBatches!;
    assert.equal(batches.length, 1);
    assert.equal(batches[0].legacy, false);
    assert.equal(batches[0].mode, "amount");
    assert.equal(batches[0].reasonCode, "other");
    assert.equal(batches[0].note, "Cobro de más");
    assert.equal(batches[0].approverName, "Alex Demo");
    const [row] = await run(
      owner,
      (tx) =>
        tx`select method,disposition,batch_id is not null as batched from refunds where tender_id=${tenderId}`,
    );
    assert.deepEqual(
      { ...row },
      { method: "cash", disposition: "discard", batched: true },
    );
    const card = await newOrder([{ product: taco, quantity: 1 }]);
    await pay(card.id, 4500, { method: "external" });
    const cardTender = (await orderOf(card.id)).tenders[0].id;
    await rejects(
      run(owner, (tx) =>
        refund(tx, owner, {
          ...body,
          operationId: randomUUID(),
          tenderId: cardTender,
        }),
      ),
      "external_refund_unverified",
    );
    await rejects(
      run(cashier, (tx) =>
        refund(tx, cashier, { ...body, operationId: randomUUID() }),
      ),
      "forbidden",
    );
  });

  await test("MON-9/FIT-10: GET /cash for a cashier omits expected cash, cash tenders, refunds and movements; managers see them", async () => {
    const drawerId = await openDrawer(devices.b, 50000);
    const sb = as(ownerId, "owner", devices.b);
    const o = await newOrder([{ product: taco, quantity: 2 }], { s: sb });
    await pay(o.id, 4500, { s: sb });
    await pay(o.id, 4500, {
      s: sb,
      method: "external",
      tip: 500,
      reference: "T-24",
    });
    const managerB = as(managerId, "manager", devices.b);
    const cashTender = (await orderOf(o.id)).tenders.find(
      (t: { method: string }) => t.method === "cash",
    ).id;
    await refundOrder(managerB, o.id, {
      mode: "amount",
      operationId: randomUUID(),
      tenderId: cashTender,
      amount: 500,
      reasonCode: "charge_error",
    });
    await run(sb, (tx) =>
      recordPaidOut(tx, sb, {
        operationId: randomUUID(),
        amount: 1000,
        reason: "Compra de hielo",
      }),
    );
    const cashierB = as(cashierId, "cashier", devices.b);
    const blind = (await run(cashierB, (tx) => cashSummary(tx, cashierB)))!;
    assert.equal(blind.id, drawerId);
    assert.equal(blind.visibility, "blind");
    assert.equal(blind.expected, null);
    assert.equal(blind.closedExpected, null);
    assert.equal(blind.cash, null);
    assert.deepEqual(blind.movements, []);
    assert(blind.tenders.every((t: any) => t.method === "external"));
    assert.equal(blind.tenders.length, 1);
    assert.equal(blind.external.sales, 4500);
    assert.equal(blind.external.tips, 500);
    assert.equal(blind.canClose, false);
    assert.deepEqual(blind.refunds, []);
    const full = (await run(managerB, (tx) => cashSummary(tx, managerB)))!;
    assert.equal(full.visibility, "full");
    assert.equal(full.expected, 50000 + 4500 - 500 - 1000);
    assert.deepEqual(full.cash, {
      sales: 4500,
      tips: 0,
      refunds: 500,
      movements: -1000,
      expected: 53000,
    });
    assert.equal(full.tenders.length, 2);
    assert.equal(full.refunds.length, 1);
    assert.equal(full.movements.length, 1);
    assert.equal(full.canClose, true);
    assert.equal(full.openedByName, "Alex Demo");
  });

  await test("MON-9: blind close accepts a mismatched count without reason_required, stores count_mode blind and closed_by; a cashier close is refused unless enabled", async () => {
    const cashierB = as(cashierId, "cashier", devices.b);
    await rejects(
      run(cashierB, (tx) =>
        closeCash(tx, cashierB, {
          operationId: randomUUID(),
          counted: 1,
          reason: "",
        }),
      ),
      "cash_close_not_allowed",
    );
    await setControls({ closeRoles: ["cashier"] });
    try {
      const view = (await run(cashierB, (tx) =>
        closeCash(tx, cashierB, {
          operationId: randomUUID(),
          counted: 54000,
          reason: "",
          externalReported: 5000,
        }),
      ))!;
      assert.equal(view.visibility, "blind");
      assert.equal(view.expected, null);
      assert.equal(view.discrepancy, null);
      const [row] = await run(
        owner,
        (
          tx,
        ) => tx`select count_mode,closed_by,counted,expected,external_expected,external_reported
          from cash_sessions where id=${view.id}`,
      );
      assert.deepEqual(
        { ...row },
        {
          count_mode: "blind",
          closed_by: cashierId,
          counted: 54000,
          expected: 53000,
          external_expected: 5000,
          external_reported: 5000,
        },
      );
    } finally {
      await setControls();
    }
  });

  await test("visible mode keeps reason_required for a mismatched count", async () => {
    await openDrawer(devices.c, 10000);
    await setControls({ blindClose: false });
    try {
      const mc = as(managerId, "manager", devices.c);
      await rejects(
        run(mc, (tx) =>
          closeCash(tx, mc, {
            operationId: randomUUID(),
            counted: 9000,
            reason: "",
          }),
        ),
        "reason_required",
      );
      const view = (await run(mc, (tx) =>
        closeCash(tx, mc, {
          operationId: randomUUID(),
          counted: 9000,
          reason: "Faltan billetes",
        }),
      ))!;
      assert.equal(view.countMode, "visible");
      assert.equal(view.discrepancy, -1000);
      assert.equal(view.closedByName, "Gerente descuentos");
    } finally {
      await setControls();
    }
  });

  await test("FIT-10: an external payment with a tip and no cash received succeeds; expected cash excludes it; terminal tips are reported separately", async () => {
    const drawer = await openDrawer(devices.a);
    const before = await run(owner, (tx) => drawerTotals(tx, drawer));
    const o = await newOrder([{ product: taco, quantity: 1 }]);
    const paid = await run(owner, (tx) =>
      recordPayment(tx, owner, o.id, {
        operationId: randomUUID(),
        amount: 4500,
        tip: 700,
        received: 0,
        method: "external",
        externalConfirmed: true,
        reference: "T-27",
      }),
    );
    assert.equal(paid.checkState, "closed");
    const after = await run(owner, (tx) => drawerTotals(tx, drawer));
    assert.equal(after.expectedCash, before.expectedCash);
    assert.equal(after.externalTips, before.externalTips + 700);
    assert.equal(after.externalSales, before.externalSales + 4500);
    assert.equal(after.cashTips, before.cashTips);
  });

  await test("FIT-10: drawer expected subtracts only cash refunds; external_expected snapshot equals terminal net at close", async () => {
    const drawer = await openDrawer(devices.c, 20000);
    const sc = as(ownerId, "owner", devices.c);
    const cashOrder = await newOrder([{ product: taco, quantity: 1 }], {
      s: sc,
    });
    await pay(cashOrder.id, 4500, { s: sc });
    const cardOrder = await newOrder([{ product: bowl, quantity: 1 }], {
      s: sc,
    });
    await pay(cardOrder.id, 12500, { s: sc, method: "external", tip: 1000 });
    const mc = as(managerId, "manager", devices.c);
    await refundOrder(mc, cardOrder.id, {
      mode: "amount",
      operationId: randomUUID(),
      tenderId: (await orderOf(cardOrder.id)).tenders[0].id,
      amount: 12500,
      reasonCode: "duplicate_terminal_charge",
      external: [
        {
          tenderId: (await orderOf(cardOrder.id)).tenders[0].id,
          reference: "R-28",
          confirmed: true,
        },
      ],
    });
    await refundOrder(mc, cashOrder.id, {
      mode: "amount",
      operationId: randomUUID(),
      tenderId: (await orderOf(cashOrder.id)).tenders[0].id,
      amount: 1000,
      reasonCode: "charge_error",
    });
    const totals = await run(owner, (tx) => drawerTotals(tx, drawer));
    assert.equal(totals.expectedCash, 20000 + 4500 - 1000);
    assert.equal(totals.cashRefunds, 1000);
    assert.equal(totals.externalRefunds, 12500);
    assert.equal(totals.externalNet, 12500 + 1000 - 12500);
    const view = (await run(mc, (tx) =>
      closeCash(tx, mc, {
        operationId: randomUUID(),
        counted: 23000,
        reason: "",
      }),
    ))!;
    const [row] = await run(
      owner,
      (tx) =>
        tx`select expected,external_expected from cash_sessions where id=${view.id}`,
    );
    assert.equal(row.expected, 23500);
    assert.equal(row.external_expected, 1000);
  });

  await test("closed drawers are immutable (trigger) and accept one review; a second review fails with cash_review_exists", async () => {
    const [closed] = await run(
      owner,
      (
        tx,
      ) => tx`select id from cash_sessions where device_id=${devices.c} and closed_at is not null and counted<>expected
        order by closed_at desc limit 1`,
    );
    await rejects(
      run(
        owner,
        (tx) =>
          tx`update cash_sessions set counted=counted+1 where id=${closed.id}`,
      ),
      /closed cash sessions are immutable/,
    );
    await rejects(
      admin.begin(async (tx) => {
        await tx`update cash_sessions set reason='editado' where id=${closed.id}`;
      }),
      /closed cash sessions are immutable/,
    );
    await rejects(
      admin.begin(async (tx) => {
        await tx`delete from cash_sessions where id=${closed.id}`;
      }),
      /closed cash sessions are immutable/,
    );
    const view = (await run(manager, (tx) =>
      reviewDrawer(tx, manager, closed.id, {
        operationId: randomUUID(),
        note: "Se contó dos veces el fondo",
      }),
    ))!;
    assert.equal(view.review!.reviewerName, "Gerente descuentos");
    await rejects(
      run(manager, (tx) =>
        reviewDrawer(tx, manager, closed.id, {
          operationId: randomUUID(),
          note: "Otra revisión",
        }),
      ),
      "cash_review_exists",
    );
    const open = await openDrawer(devices.a);
    await rejects(
      run(manager, (tx) =>
        reviewDrawer(tx, manager, open, {
          operationId: randomUUID(),
          note: "Abierta",
        }),
      ),
      "cash_review_not_needed",
    );
    await rejects(
      run(cashier, (tx) =>
        reviewDrawer(tx, cashier, closed.id, {
          operationId: randomUUID(),
          note: "Cajero",
        }),
      ),
      "forbidden",
    );
    const history = await run(manager, (tx) => cashHistory(tx, manager, 0));
    const reviewed = history.find((h) => h.id === closed.id)!;
    assert.equal(reviewed.needs_review, false);
    assert.equal(reviewed.reviewer_name, "Gerente descuentos");
    assert.equal(reviewed.closed_by_name, "Gerente descuentos");
  });

  await test("controls: owner-only with step-up; version conflict; defaults when absent; saving does not change restaurants.config_version", async () => {
    const version = async () =>
      (
        await admin`select config_version from restaurants where id=${tenantId}`
      )[0].config_version as number;
    const before = await version();
    const current = await run(owner, (tx) => getMoneyControls(tx, owner));
    const body = {
      operationId: randomUUID(),
      expectedVersion: current.version,
      limits: {
        cashier: { maxPercentBps: 500, maxAmount: 2000 },
        server: { maxPercentBps: 0, maxAmount: 0 },
      },
      blindClose: true,
      expectedRoles: ["manager", "manager"],
      closeRoles: [],
    };
    await rejects(
      run(manager, (tx) => saveMoneyControls(tx, manager, body)),
      "forbidden",
    );
    const stale = as(ownerId, "owner", devices.a, {
      authenticatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    await rejects(
      run(stale, (tx) => saveMoneyControls(tx, stale, body)),
      "step_up_required",
    );
    await rejects(
      run(owner, (tx) =>
        saveMoneyControls(tx, owner, {
          ...body,
          limits: {
            ...body.limits,
            cashier: { maxPercentBps: 10001, maxAmount: 0 },
          },
        }),
      ),
      "money_controls_invalid",
    );
    const saved = await run(owner, (tx) => saveMoneyControls(tx, owner, body));
    assert.equal(saved.version, current.version + 1);
    assert.deepEqual(
      saved.expectedRoles,
      ["manager"],
      "roles are deduplicated",
    );
    assert.equal(saved.updatedByName, "Alex Demo");
    await rejects(
      run(owner, (tx) =>
        saveMoneyControls(tx, owner, { ...body, operationId: randomUUID() }),
      ),
      "money_controls_changed",
    );
    assert.equal(await version(), before);
    const cashierView = await run(cashier, (tx) =>
      getMoneyControls(tx, cashier),
    );
    assert.equal(cashierView.canEdit, false);
    assert.deepEqual(cashierView.you.limit, {
      maxPercentBps: 500,
      maxAmount: 2000,
    });
    assert.equal(cashierView.you.canSeeExpected, false);
    const [audit] = await run(
      owner,
      (tx) =>
        tx`select detail from audit where operation='discount.controls.saved' order by created_at desc limit 1`,
    );
    assert.equal(audit.detail.after.limits.cashier.maxPercentBps, 500);
    // Defaults when a restaurant never saved controls.
    const defaults = await run(foreign, (tx) => getMoneyControls(tx, foreign));
    assert.equal(defaults.version, 0);
    assert.equal(defaults.blindClose, true);
    assert.deepEqual(defaults.expectedRoles, ["manager"]);
    await rejects(
      run(kitchen, (tx) => getMoneyControls(tx, kitchen)),
      "forbidden",
    );
    await setControls();
  });

  await test("tenant isolation: tenant B cannot read tenant A's discounts, allocations, refund batches, units, lines, reviews or controls, nor through kitchen_removals", async () => {
    // Tenant A has rows in every table (earlier tests); tenant B sees none of them.
    const mine = await run(
      owner,
      (tx) => tx`select
        (select count(*)::int from discounts) > 0 as discounts,
        (select count(*)::int from cash_count_reviews) > 0 as reviews,
        (select count(*)::int from money_controls) > 0 as controls`,
    );
    assert.deepEqual(
      { ...mine[0] },
      { discounts: true, reviews: true, controls: true },
    );
    const theirs = await run(
      foreign,
      (tx) => tx`select
        (select count(*)::int from discounts where tenant_id=${tenantId}) as discounts,
        (select count(*)::int from discount_allocations where tenant_id=${tenantId}) as allocations,
        (select count(*)::int from refund_batches where tenant_id=${tenantId}) as batches,
        (select count(*)::int from refund_units where tenant_id=${tenantId}) as units,
        (select count(*)::int from refund_lines where tenant_id=${tenantId}) as lines,
        (select count(*)::int from cash_count_reviews where tenant_id=${tenantId}) as reviews,
        (select count(*)::int from money_controls where tenant_id=${tenantId}) as controls,
        (select count(*)::int from kitchen_removals where tenant_id=${tenantId}) as removals`,
    );
    assert.deepEqual(
      { ...theirs[0] },
      {
        discounts: 0,
        allocations: 0,
        batches: 0,
        units: 0,
        lines: 0,
        reviews: 0,
        controls: 0,
        removals: 0,
      },
    );
    const map = await run(foreign, (tx) => adjustmentRows(tx, [sample.id]));
    const row = map.get(sample.id)!;
    assert.deepEqual(
      [row.discounts, row.batches, row.refundUnits, row.refundLines],
      [[], [], [], []],
    );
    // A tenant-B session cannot apply a discount to tenant A's order.
    await rejects(
      run(foreign, (tx) =>
        applyDiscount(
          tx,
          foreign,
          sample.id,
          percentBody(
            sample,
            1000,
            discountPreviewOf(sample, percentBody(sample, 1000)),
          ),
          { approverId: otherOwnerId },
        ),
      ),
      "not_found",
    );
    // Nor write a row for tenant A while scoped to B.
    await rejects(
      run(
        foreign,
        (
          tx,
        ) => tx`insert into cash_count_reviews(tenant_id,id,drawer_id,reviewer_id,note)
        values(${tenantId},${randomUUID()},${randomUUID()},${ownerId},'cruzado')`,
      ),
      /row-level security|42501|23503/,
    );
  });

  await test("getOrders statement count is equal for 1 and 10 ids and ≤ 10 with discounts and refunds present", async () => {
    let n = 0;
    const counted = postgres(url, {
      max: 1,
      debug: (_c, query) => {
        if (
          !/^\s*(begin|commit|rollback)\b/i.test(query) &&
          !query.includes("set_config") &&
          !query.includes("pg_catalog.pg_type")
        )
          n++;
      },
    });
    try {
      const count = async (fn: (tx: Tx) => Promise<unknown>) => {
        n = 0;
        await tenant(counted, tenantId, fn);
        return n;
      };
      const ids: string[] = [sample.id];
      for (let i = 0; i < 9; i++) {
        const o = await newOrder([{ product: taco, quantity: 2 }]);
        const d = await discount(manager, o.id, percentBody(o, 500));
        await pay(o.id, d.total);
        await refundOrder(
          manager,
          o.id,
          itemsBody(
            [{ lineId: o.lines[0].id, quantity: 1 }],
            d.paymentUnits![1].total - d.paymentUnits![1].discount,
          ),
        );
        ids.push(o.id);
      }
      const one = await count((tx) => getOrders(tx, [ids[0]]));
      const ten = await count((tx) => getOrders(tx, ids));
      assert.equal(one, ten);
      assert.ok(one <= 10, `getOrders used ${one} statements`);
      const orders = await run(owner, (tx) => getOrders(tx, ids));
      assert.equal(orders.length, 10);
      assert(
        orders.every(
          (o) => o.discounts!.length === 1 && o.refundBatches!.length === 1,
        ),
      );
    } finally {
      await counted.end();
    }
  });

  await test("MONEY-1 (LD-25, LD-26): no refund, by amount or by item, on an unticketed check with a balance due (refund_balance_due on POST /orders/:id/refunds in both modes and on legacy POST /refunds, nothing stored, not even the kitchen cancellation); after the unpaid agua is voided the check is paid and ticketed, and the item refund then nets the ticket's IVA", async () => {
    const table = tables[3].id as string;
    const o = await newOrder(
      [
        { product: taco, quantity: 2 },
        { product: agua, quantity: 1 },
      ],
      { tableId: table },
    );
    const tacoLine = lineOf(o, taco);
    const taco0 = `${tacoLine}:0`,
      taco1 = `${tacoLine}:1`;
    await pay(o.id, 9000, { items: [taco0, taco1] });
    const tenderId = (await orderOf(o.id)).tenders[0].id;
    await rejects(
      refundOrder(manager, o.id, {
        mode: "amount",
        operationId: randomUUID(),
        tenderId,
        amount: 1000,
        reasonCode: "charge_error",
      }),
      "refund_balance_due",
    );
    await rejects(
      run(owner, (tx) =>
        refund(tx, owner, {
          operationId: randomUUID(),
          tenderId,
          amount: 1000,
          reason: "Cobro de más",
          disposition: "discard",
        }),
      ),
      "refund_balance_due",
    );
    // FISCAL-1 / MONEY-1: the paid taco cannot be refunded by item either
    // while the agua is unpaid; the round's kitchen cancellation is not written.
    const feed = async () => {
      const [f] = await run(
        owner,
        (tx) =>
          tx`select coalesce((select version from kitchen_feed_versions where tenant_id=${tenantId}),0)::int as v`,
      );
      return f.v as number;
    };
    const feedBefore = await feed();
    await rejects(
      refundOrder(
        manager,
        o.id,
        itemsBody([{ lineId: tacoLine, quantity: 1 }], 4500),
      ),
      "refund_balance_due",
    );
    assert.equal((await counts(o.id)).batches, 0);
    assert.equal((await counts(o.id)).refunds, 0);
    assert.equal(await feed(), feedBefore, "no kitchen cancellation");
    const open = await orderOf(o.id);
    assert.equal(open.checkState, "open");
    assert.equal(open.fiscal!.ticket, null);
    // Staff void the unpaid agua instead: the check is paid and ticketed.
    const voided = await run(owner, (tx) =>
      voidLines(
        tx,
        owner,
        o.id,
        {
          operationId: randomUUID(),
          expectedVersion: open.version,
          lines: [{ lineId: lineOf(o, agua), quantity: 1 }],
          reason: "Ya no la quiere",
          stockDisposition: "no_return",
        },
        ownerId,
      ),
    );
    assert.equal(voided.checkState, "paid");
    assert.equal(voided.total, 9000);
    assert.equal(voided.fiscal!.ticket!.gross, 9000);
    const r = await refundOrder(
      manager,
      o.id,
      itemsBody([{ lineId: tacoLine, quantity: 1 }], 4500),
    );
    assert.equal(r.order.checkState, "paid");
    const [t] = await run(
      owner,
      (
        tx,
      ) => tx`select t.tax - coalesce((select sum(a.tax) from fiscal_adjustments a where a.order_id=t.order_id),0) as remaining
        from fiscal_tickets t where t.order_id=${o.id}`,
    );
    assert.equal(Number(t.remaining), extractTax(4500, 1600).tax);
    await run(owner, (tx) =>
      closeCheck(tx, owner, o.id, { operationId: randomUUID() }),
    );
  });

  await test("DSC-R6: a later discount's overlap on a unit voided since does not block the reversal (server and client agree)", async () => {
    // Two one-taco lines: the check discount covers both units, a later comp
    // covers line B's unit, then that unit is voided.
    const o = await newOrder([
      { product: taco, quantity: 1 },
      { product: taco, quantity: 1 },
    ]);
    const b = o.lines[1].id;
    const d1 = await discount(manager, o.id, percentBody(o, 1000));
    const d2 = await discount(manager, o.id, {
      operationId: randomUUID(),
      expectedVersion: d1.version,
      scope: "line",
      lineId: b,
      quantity: 1,
      kind: "comp",
      reasonCode: "courtesy",
    });
    assert.equal(d2.total, 4050);
    const first = d2.discounts!.find((d) => d.scope === "order")!;
    // Before the void the overlap is live: LIFO refuses on both sides.
    assert.equal(discountRemovable(d2, first), false);
    await rejects(
      reverse(manager, o.id, first.id, {
        operationId: randomUUID(),
        expectedVersion: d2.version,
        note: "Se aplicó por error",
      }),
      "discount_not_reversible",
    );
    const voided = await run(owner, (tx) =>
      voidLines(
        tx,
        owner,
        o.id,
        {
          operationId: randomUUID(),
          expectedVersion: d2.version,
          lines: [{ lineId: b, quantity: 1 }],
          reason: "Ya no lo quiere",
          stockDisposition: "no_return",
        },
        ownerId,
      ),
    );
    assert.equal(voided.total, 4050);
    assert.equal(voided.discount, 450);
    const live = voided.discounts!.find((d) => d.id === first.id)!;
    assert.equal(discountRemovable(voided, live), true, "client offers it");
    const r = await reverse(manager, o.id, first.id, {
      operationId: randomUUID(),
      expectedVersion: voided.version,
      note: "Se aplicó por error",
    });
    assert.equal(r.total, 4500);
    assert.equal(r.discount, 0);
    assert.equal(
      r.discounts!.find((d) => d.id === first.id)!.reversal!.amount,
      450,
    );
  });

  await test("whole-check comp: a takeaway check comped to zero closes at once and its reversal fails with discount_not_reversible; a dine-in table check comped to zero becomes paid, its reversal returns it to open; after Cerrar cuenta the table comp is final too", async () => {
    const comp = (o: Order) => ({
      operationId: randomUUID(),
      expectedVersion: o.version,
      scope: "order",
      kind: "comp",
      reasonCode: "courtesy",
    });
    const reason = { note: "Error de captura" };
    const takeaway = await newOrder([{ product: taco, quantity: 1 }]);
    const closed = await discount(manager, takeaway.id, comp(takeaway));
    assert.equal(closed.total, 0);
    assert.equal(closed.checkState, "closed");
    assert.equal(closed.closeReason, "settled");
    const [n] = await run(
      owner,
      (tx) =>
        tx`select count(*)::int as n from fiscal_tickets where order_id=${takeaway.id}`,
    );
    assert.equal(n.n, 0, "a zero total issues no ticket");
    await rejects(
      reverse(manager, takeaway.id, closed.discounts![0].id, {
        operationId: randomUUID(),
        expectedVersion: closed.version,
        ...reason,
      }),
      "discount_not_reversible",
    );
    const table = tables[4].id as string;
    const dine = await newOrder([{ product: taco, quantity: 1 }], {
      tableId: table,
    });
    const paid = await discount(manager, dine.id, comp(dine));
    assert.equal(paid.checkState, "paid");
    const reopened = await reverse(manager, dine.id, paid.discounts![0].id, {
      operationId: randomUUID(),
      expectedVersion: paid.version,
      ...reason,
    });
    assert.equal(reopened.checkState, "open");
    assert.equal(reopened.total, 4500);
    const again = await discount(manager, dine.id, comp(reopened));
    assert.equal(again.checkState, "paid");
    await run(owner, (tx) =>
      closeCheck(tx, owner, dine.id, { operationId: randomUUID() }),
    );
    const final = await orderOf(dine.id);
    assert.equal(final.checkState, "closed");
    await rejects(
      reverse(manager, dine.id, final.discounts!.at(-1)!.id, {
        operationId: randomUUID(),
        expectedVersion: final.version,
        ...reason,
      }),
      "discount_not_reversible",
    );
  });

  await test("LD-2: with the cashier's PIN aged one hour on a terminal, a discount over the limit, a reversal and a refund approved with a manager PIN all succeed without step_up_required; an unapproved within-limit discount fails with step_up_required; over the limit without approval answers approval_required", async () => {
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const staleCashier = as(cashierId, "cashier", devices.a, {
      authenticatedAt: hourAgo,
    });
    await resetManagerPin();
    const o = await newOrder([{ product: taco, quantity: 2 }], { s: cashier });
    await rejects(
      discount(staleCashier, o.id, percentBody(o, 1000)),
      "approval_required",
    );
    const approved = await discount(
      staleCashier,
      o.id,
      percentBody(o, 1000, { approval: managerApproval }),
    );
    assert.equal(approved.total, 8100);
    const reversed = await reverse(
      staleCashier,
      o.id,
      approved.discounts![0].id,
      {
        operationId: randomUUID(),
        expectedVersion: approved.version,
        note: "No aplicaba",
        approval: managerApproval,
      },
    );
    assert.equal(reversed.total, 9000);
    await pay(o.id, 9000);
    const refunded = await refundOrder(
      staleCashier,
      o.id,
      itemsBody([{ lineId: o.lines[0].id, quantity: 1 }], 4500, {
        approval: managerApproval,
      }),
    );
    assert.equal(refunded.batch.approverName, "Gerente descuentos");
    assert.equal(refunded.batch.actorName, "Dani Demo");
    // Within the limit, no approver: the cashier's own recent PIN is required.
    await setControls({
      limits: {
        cashier: { maxPercentBps: 1000, maxAmount: 100000 },
        server: { maxPercentBps: 0, maxAmount: 0 },
      },
    });
    try {
      const w = await newOrder([{ product: taco, quantity: 1 }], {
        s: cashier,
      });
      await rejects(
        discount(staleCashier, w.id, percentBody(w, 500)),
        "step_up_required",
      );
      const fresh = as(cashierId, "cashier", devices.a, {});
      const ok = await discount(fresh, w.id, percentBody(w, 500));
      assert.equal(ok.discounts![0].approverName, null);
    } finally {
      await setControls();
    }
    // LD-15 Q2: a manager acting alone gets the step-up and is the approver.
    const staleManager = as(managerId, "manager", devices.a, {
      authenticatedAt: hourAgo,
    });
    const m = await newOrder([{ product: taco, quantity: 1 }]);
    await rejects(
      discount(staleManager, m.id, percentBody(m, 1000)),
      "step_up_required",
    );
    const freshManager = as(managerId, "manager", devices.a, {});
    const mine = await discount(freshManager, m.id, percentBody(m, 1000));
    assert.equal(mine.discounts![0].approverName, "Gerente descuentos");
    // Staff with no approval cannot refund at all.
    await rejects(
      refundOrder(
        cashier,
        o.id,
        itemsBody([{ lineId: o.lines[0].id, quantity: 1 }], 4500),
      ),
      "approval_required",
    );
  });

  await test("refund dates: fiscal adjustments copy refund_batches.business_date (D−1 through insertRefundBatch); every batched refund's adjustments carry the batch date; the legacy route also creates a batch", async () => {
    const o = await newOrder([{ product: taco, quantity: 2 }]);
    await pay(o.id, 9000);
    const tenderId = (await orderOf(o.id)).tenders[0].id;
    const today = businessDate(
      new Date().toISOString(),
      restaurant.timezone,
      restaurant.cutoff,
    );
    const yesterday = new Date(Date.parse(today + "T12:00:00Z") - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const drawer = await openDrawer(devices.a);
    const written = await run(owner, (tx) =>
      insertRefundBatch(tx, owner, {
        orderId: o.id,
        mode: "amount",
        reasonCode: "charge_error",
        note: "",
        restock: false,
        approverId: ownerId,
        businessDate: yesterday,
        drawerId: drawer,
        portions: [
          {
            tenderId,
            method: "cash",
            amount: 1000,
            reference: null,
            units: [],
          },
        ],
        lines: [],
      }),
    );
    const [adj] = await run(
      owner,
      (tx) =>
        tx`select business_date::text as d from fiscal_adjustments where refund_id=${written.refundIds[0]}`,
    );
    assert.equal(adj.d, yesterday);
    const mismatched = await run(
      owner,
      (tx) => tx`select count(*)::int as n from fiscal_adjustments a
        join refunds r on r.tenant_id=a.tenant_id and r.id=a.refund_id
        join refund_batches b on b.tenant_id=r.tenant_id and b.id=r.batch_id
        where a.business_date <> b.business_date`,
    );
    assert.equal(mismatched[0].n, 0);
  });

  await test("complement extraction: after a partial post-ticket item refund and a later amount refund, ticket tax − Σ adjustment tax = extractTax(G − R).tax; 0 ≤ adj.tax ≤ adj.gross; refunding everything nets IVA to 0", async () => {
    const o = await newOrder([{ product: taco, quantity: 3 }]);
    await pay(o.id, 13500);
    const tenderId = (await orderOf(o.id)).tenders[0].id;
    await refundOrder(
      manager,
      o.id,
      itemsBody([{ lineId: o.lines[0].id, quantity: 1 }], 4500),
    );
    await refundOrder(manager, o.id, {
      mode: "amount",
      operationId: randomUUID(),
      tenderId,
      amount: 3333,
      reasonCode: "charge_error",
    });
    const remaining = async () => {
      const [t] = await run(
        owner,
        (tx) => tx`select t.gross,t.tax,
          coalesce((select sum(a.gross) from fiscal_adjustments a where a.order_id=t.order_id),0)::int as refunded,
          coalesce((select sum(a.tax) from fiscal_adjustments a where a.order_id=t.order_id),0)::int as refunded_tax,
          coalesce((select bool_and(a.tax >= 0 and a.tax <= a.gross) from fiscal_adjustments a where a.order_id=t.order_id),true) as bounded
          from fiscal_tickets t where t.order_id=${o.id}`,
      );
      return t;
    };
    const t = await remaining();
    assert.equal(t.bounded, true);
    assert.equal(
      t.tax - t.refunded_tax,
      extractTax(t.gross - t.refunded, 1600).tax,
    );
    await refundOrder(manager, o.id, {
      mode: "amount",
      operationId: randomUUID(),
      tenderId,
      amount: 13500 - 4500 - 3333,
      reasonCode: "charge_error",
    });
    const all = await remaining();
    assert.equal(all.tax - all.refunded_tax, 0);
  });

  await test("Q5: an item refund of an offline_review round asks the kitchen to cancel (it may still be prepared); a served round asks nothing", async () => {
    const o = await newOrder([{ product: taco, quantity: 2 }]);
    await pay(o.id, 9000);
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${tenantId},true)`;
      await tx`update rounds set state='offline_review' where order_id=${o.id}`;
    });
    const r = await refundOrder(
      manager,
      o.id,
      itemsBody([{ lineId: o.lines[0].id, quantity: 1 }], 4500),
    );
    assert.equal(r.batch.lines[0].preparationState, "offline_review");
    assert.equal(r.batch.lines[0].kitchenPending, true);
    const served = await newOrder([{ product: taco, quantity: 1 }]);
    await pay(served.id, 4500);
    const round = (await orderOf(served.id)).rounds[0];
    for (const state of ["ready", "completed"])
      await run(kitchen, (tx) =>
        progressPreparation(tx, kitchen, round.id, {
          operationId: randomUUID(),
          state,
        }),
      );
    const done = await refundOrder(
      manager,
      served.id,
      itemsBody([{ lineId: served.lines[0].id, quantity: 1 }], 4500),
    );
    assert.equal(done.batch.lines[0].preparationState, "completed");
    assert.equal(done.batch.lines[0].kitchenPending, false);
  });

  // Q5 / T-14 on the second demo tenant (its KDS feed is not crowded by the
  // open rounds this suite leaves on the first one): the two kitchen
  // decisions with a refund line present, and clear-stale acknowledging one.
  const s2 = foreign;
  const kitchen2 = foreignKitchen;
  const taco2 = (await run(s2, catalog)).find(
    (p) => p.name.es === "Taco de hongos",
  )!;
  await run(s2, async (tx) => {
    const [d] =
      await tx`select id from cash_sessions where device_id=${otherDevice} and closed_at is null`;
    if (!d)
      await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${otherTenantId},${randomUUID()},${otherDevice},${otherOwnerId},0)`;
  });
  /** A paid taco order whose round 1 sits in the offline review lane (offline 026). */
  async function offlineReviewOrder(quantity: number) {
    const o = await newOrder([{ product: taco2, quantity }], { s: s2 });
    await pay(o.id, 4500 * quantity, { s: s2 });
    const operationId = randomUUID();
    await run(s2, async (tx) => {
      await tx`insert into offline_sync_records(tenant_id,operation_id,kind,format_version,path,
          device_id,employee_id,session_id,order_id,round_number,recorded_at,sold_at,business_date,
          kitchen_delivery,actor_id)
        values(${otherTenantId},${operationId},'order',3,'automatic',${otherDevice},${otherOwnerId},
          ${randomUUID()},${o.id},1,now(),now(),current_date,'device_list',${otherOwnerId})`;
      await placeRoundsInOfflineReview(tx, s2, {
        orderId: o.id,
        roundNumber: 1,
        operationId,
      });
    });
    const round = (await orderOf(o.id, s2)).rounds[0];
    assert.equal(round.state, "offline_review");
    return { o, roundId: round.id as string };
  }
  const feedRound = async (orderId: string) => {
    const feed = await run(kitchen2, (tx) => kitchenFeed(tx, kitchen2, {}));
    assert(!feed.unchanged && !feed.truncated);
    return feed.rounds.find((x) => x.orderId === orderId);
  };
  const pendingOf = async (orderId: string) =>
    (await run(s2, (tx) => listOrders(tx, s2, { status: "all" }))).items.find(
      (x) => x.id === orderId,
    )!.voidAckPending;

  await test("Q5 / T-14: 'Preparar ahora' on an offline_review round with a refund puts the cancellation on the KDS; the station acknowledgement clears it and completes the fully removed round", async () => {
    const { o, roundId } = await offlineReviewOrder(2);
    const first = await refundOrder(
      s2,
      o.id,
      itemsBody([{ lineId: o.lines[0].id, quantity: 1 }], 4500),
    );
    assert.equal(first.batch.lines[0].preparationState, "offline_review");
    assert.equal(first.batch.lines[0].kitchenPending, true);
    assert.equal(await feedRound(o.id), undefined, "held for review");
    await run(kitchen2, (tx) =>
      decideOfflineKitchen(tx, kitchen2, roundId, {
        operationId: randomUUID(),
        decision: "prepare",
      }),
    );
    const prepared = await feedRound(o.id);
    assert(prepared, "the round reaches the KDS with its cancellation");
    assert.equal(prepared.state, "active");
    assert.equal(prepared.lines[0].voidedQuantity, 1);
    assert.deepEqual(
      prepared.pendingVoids.map((v) => [v.kind, v.quantity]),
      [["refund", 1]],
    );
    assert.equal(await pendingOf(o.id), true);
    // The second unit is refunded once the round is live (the decision marked
    // it seen): a regular notice.
    const second = await refundOrder(
      s2,
      o.id,
      itemsBody([{ lineId: o.lines[0].id, quantity: 1 }], 4500),
    );
    assert.equal(second.batch.lines[0].preparationState, "active");
    assert.equal(second.batch.lines[0].kitchenPending, true);
    const both = await feedRound(o.id);
    assert.deepEqual(
      both!.pendingVoids.map((v) => [v.kind, v.quantity]),
      [
        ["refund", 1],
        ["refund", 1],
      ],
    );
    const ack = await run(kitchen2, (tx) =>
      acknowledgeVoids(tx, kitchen2, roundId, { operationId: randomUUID() }),
    );
    assert.equal(ack.acknowledged, 2);
    assert.equal(await feedRound(o.id), undefined, "nothing left to cook");
    const done = await orderOf(o.id, s2);
    assert.equal(done.rounds[0].state, "completed");
    assert.ok(
      done.refundBatches!.every((b) => b.lines.every((l) => !l.kitchenPending)),
    );
    assert.equal(await pendingOf(o.id), false);
  });

  await test("Q5 / T-14: 'Ya servido' on an offline_review round acknowledges its refund cancellation; the round completes and nothing stays pending", async () => {
    const { o, roundId } = await offlineReviewOrder(2);
    const r = await refundOrder(
      s2,
      o.id,
      itemsBody([{ lineId: o.lines[0].id, quantity: 1 }], 4500),
    );
    assert.equal(r.batch.lines[0].kitchenPending, true);
    assert.equal(await pendingOf(o.id), true);
    await run(kitchen2, (tx) =>
      decideOfflineKitchen(tx, kitchen2, roundId, {
        operationId: randomUUID(),
        decision: "already_served",
      }),
    );
    const [rl] = await run(
      s2,
      (tx) =>
        tx`select kitchen_acknowledged_at,kitchen_acknowledged_by from refund_lines where batch_id=${r.batch.id}`,
    );
    assert.ok(rl.kitchen_acknowledged_at);
    assert.equal(rl.kitchen_acknowledged_by, kitchen2.employeeId);
    const after = await orderOf(o.id, s2);
    assert.equal(after.rounds[0].state, "completed");
    assert.equal(after.refundBatches![0].lines[0].kitchenPending, false);
    assert.equal(await pendingOf(o.id), false);
    assert.equal(await feedRound(o.id), undefined);
  });

  await test("clear stale acknowledges a pending refund cancellation of a previous day's round", async () => {
    // A dine-in table check paid in full: it is ticketed and "paid" but not
    // closed (a closed check keeps its business date), and since MONEY-1
    // (LD-25/LD-26) only a check without a balance due takes refunds.
    const [table2] = await run(
      s2,
      (tx) =>
        tx`select id from dining_tables where archived_at is null order by name desc limit 1`,
    );
    const o = await newOrder([{ product: taco2, quantity: 2 }], {
      s: s2,
      tableId: table2.id,
    });
    const paid = await pay(o.id, 9000, { s: s2 });
    assert.equal(paid.checkState, "paid");
    assert.ok(paid.fiscal!.ticket);
    const r = await refundOrder(
      s2,
      o.id,
      itemsBody([{ lineId: o.lines[0].id, quantity: 1 }], 4500),
    );
    assert.equal(r.batch.lines[0].kitchenPending, true);
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${otherTenantId},true)`;
      await tx`update orders set business_date=business_date-1,number=${700000 + Math.floor(Math.random() * 90000)}
        where tenant_id=${otherTenantId} and id=${o.id}`;
    });
    const cleared = await run(s2, (tx) =>
      clearStaleRounds(tx, s2, { operationId: randomUUID(), station: "all" }),
    );
    assert.ok(cleared.cleared >= 1);
    const [rl] = await run(
      s2,
      (tx) =>
        tx`select kitchen_acknowledged_by from refund_lines where batch_id=${r.batch.id}`,
    );
    assert.equal(rl.kitchen_acknowledged_by, s2.employeeId);
    const after = await orderOf(o.id, s2);
    assert.equal(after.rounds[0].state, "completed");
    assert.equal(after.refundBatches![0].lines[0].kitchenPending, false);
    // Not listed today any more (yesterday's check): read the removals view.
    const [left] = await run(
      s2,
      (tx) =>
        tx`select count(*)::int as n from kitchen_removals where order_id=${o.id}
          and kitchen_ack_required and kitchen_acknowledged_at is null`,
    );
    assert.equal(left.n, 0);
    // Release the table.
    await run(s2, (tx) =>
      closeCheck(tx, s2, o.id, { operationId: randomUUID() }),
    );
  });

  console.log(`${checks} discounts checks passed`);
} finally {
  for (const id of [tenantId, otherTenantId])
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${id},true)`;
      await tx`delete from jobs where tenant_id=${id} and kind='kitchen_dispatch' and created_at>=${started}`;
    });
  await sql.end();
  await admin.end();
}
