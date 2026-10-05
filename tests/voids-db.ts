import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { password } from "../server/auth.js";
import { checkRole, connect, tenant } from "../server/db.js";
import {
  addRound,
  catalog,
  createOrder,
  getOrder,
  recordPayment,
} from "../server/orders.js";
import { progressPreparation } from "../server/service.js";
import {
  acknowledgeVoids,
  checkEmployeeSecret,
  LOCK_MINUTES,
  MAX_FAILED_ATTEMPTS,
  verifyApproval,
  voidLines,
} from "../server/voids.js";
import { deviceScope } from "../server/access.js";
import type { Order, Session } from "../shared/domain.js";
import { isolatedTarget } from "./isolated-target.js";

const { runtime: url, migration } = isolatedTarget(process.env);
const sql = connect(url),
  admin = postgres(migration, { max: 1 });
await checkRole(sql);

const tenantId = "10000000-0000-4000-8000-000000000001";
const otherTenantId = "10000000-0000-4000-8000-000000000002";
const base = {
  expiresAt: "",
  offlineUntil: "",
  csrf: "",
  deviceId: "30000000-0000-4000-8000-000000000001",
  restaurant: {
    name: "Test",
    currency: "MXN",
    timezone: "America/Mexico_City",
    cutoff: 240,
  },
};
const owner: Session = {
  ...base,
  id: randomUUID(),
  tenantId,
  employeeId: "20000000-0000-4000-8000-000000000001",
  name: "Owner",
  role: "owner",
};
const cashier: Session = {
  ...owner,
  id: randomUUID(),
  employeeId: "20000000-0000-4000-8001-000000000001",
  name: "Cashier",
  role: "cashier",
};
const kitchen: Session = {
  ...owner,
  id: randomUUID(),
  employeeId: "20000000-0000-4000-8002-000000000001",
  name: "Kitchen",
  role: "kitchen",
};
const foreignCashier: Session = {
  ...cashier,
  id: randomUUID(),
  tenantId: otherTenantId,
  employeeId: "20000000-0000-4000-8001-000000000002",
  deviceId: "30000000-0000-4000-8000-000000000002",
};

// A manager created for this run; login is unique so reruns do not collide.
const managerId = randomUUID();
const managerLogin = `mgr-${managerId.slice(0, 8)}`;
const managerPin = "4321";
await admin.begin(async (tx) => {
  await tx`select set_config('app.tenant_id',${tenantId},true)`;
  await tx`insert into employees(tenant_id,id,name,login,secret_hash,role) values(${tenantId},${managerId},'Gerente prueba',${managerLogin},${password(managerPin)},'manager')`;
});
const approval = { login: managerLogin, secret: managerPin };

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (e: any) => {
    assert.equal(e.code ?? e.message, code);
    return true;
  });
}
const run = <T>(s: Session, fn: (tx: any) => Promise<T>) =>
  tenant(sql, s.tenantId, fn);

const products = await run(owner, catalog);
const product = products.find(
  (p) => p.groups.length === 0 && p.recipe?.length && p.station === "kitchen",
)!;
assert(product, "fixture needs a kitchen product with a recipe");
const stockId = product.recipe![0].stockId;
const stockBalance = async () =>
  (
    await run(
      owner,
      (tx) =>
        tx`select coalesce(sum(quantity),0)::text as q from stock_movements where stock_id=${stockId}`,
    )
  )[0].q as string;

async function newOrder(quantity = 3): Promise<Order> {
  return run(owner, (tx) =>
    createOrder(tx, owner, {
      operationId: randomUUID(),
      lines: [
        {
          id: randomUUID(),
          productId: product.id,
          quantity,
          options: [],
          note: "",
        },
      ],
      mode: "takeaway",
      tableId: null,
      name: "Voids",
      note: "",
      channel: "pos",
    }),
  );
}
function voidBody(o: Order, quantity: number, extra: object = {}) {
  return {
    operationId: randomUUID(),
    expectedVersion: o.version,
    lines: [{ lineId: o.lines[0].id, quantity }],
    reason: "Cliente cambió de opinión",
    stockDisposition: "no_return",
    ...extra,
  };
}
async function voidAs(s: Session, orderId: string, body: any) {
  const approverId = await verifyApproval(sql, s, body.approval);
  return run(s, (tx) => voidLines(tx, s, orderId, body, approverId));
}

try {
  // Ensure the owner's device has an open drawer for payment checks.
  await run(owner, async (tx) => {
    const [d] =
      await tx`select id from cash_sessions where device_id=${owner.deviceId} and closed_at is null`;
    if (!d)
      await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${tenantId},${randomUUID()},${owner.deviceId},${owner.employeeId},0)`;
  });

  await test("a cashier void requires a manager approval", async () => {
    const o = await newOrder();
    await rejects(voidAs(cashier, o.id, voidBody(o, 1)), "approval_required");
    await rejects(
      voidAs(
        cashier,
        o.id,
        voidBody(o, 1, { approval: { login: managerLogin, secret: "0000" } }),
      ),
      "approval_denied",
    );
    await rejects(
      voidAs(
        cashier,
        o.id,
        voidBody(o, 1, { approval: { login: "cashier", secret: "123456" } }),
      ),
      "approval_denied",
    );
    const after = await run(owner, (tx) => getOrder(tx, o.id));
    assert.equal(after.total, o.total);
    assert.equal(after.voids!.length, 0);
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${tenantId},true)`;
      await tx`update employees set failed_attempts=0,locked_until=null where id=${managerId}`;
      await tx`delete from pin_throttles where employee_id=${managerId}`;
    });
  });

  await test("approval by employeeId works", async () => {
    const o = await newOrder();
    await rejects(
      voidAs(
        cashier,
        o.id,
        voidBody(o, 1, { approval: { employeeId: managerId, secret: "0000" } }),
      ),
      "approval_denied",
    );
    const v = await voidAs(
      cashier,
      o.id,
      voidBody(o, 1, {
        approval: { employeeId: managerId, secret: managerPin },
      }),
    );
    assert.equal(v.voids![0].approverName, "Gerente prueba");
    // The successful PIN cleared the failure on this device.
    const [row] = await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${tenantId},true)`;
      return tx`select failures from pin_throttles where employee_id=${managerId} and scope=${deviceScope(cashier.deviceId)}`;
    });
    assert.equal(row.failures, 0);
  });

  await test("approved void removes unpaid units, returns stock before preparation, and records evidence", async () => {
    const o = await newOrder();
    const before = await stockBalance();
    const v = await voidAs(
      cashier,
      o.id,
      voidBody(o, 1, { approval, stockDisposition: "return" }),
    );
    const unit = o.lines[0].unitPrice;
    assert.equal(v.total, o.total - unit);
    assert.equal(v.version, o.version + 1);
    assert.deepEqual(v.lines[0].voidedUnits, [2]);
    assert.equal(v.paymentUnits!.length, 2);
    assert.equal(v.voids!.length, 1);
    assert.equal(v.voids![0].approverName, "Gerente prueba");
    assert.equal(v.voids![0].actorName !== "Gerente prueba", true);
    assert.equal(v.voids![0].stockDisposition, "returned");
    assert.equal(v.voids![0].kitchenPending, true);
    const expected = Number(before) + Number(product.recipe![0].quantity);
    assert.equal(Number(await stockBalance()), expected);
    const [audit] = await run(
      owner,
      (tx) =>
        tx`select detail from audit where entity_id=${o.id} and operation='order.void'`,
    );
    assert.equal(audit.detail.approverId, managerId);
    assert.equal(JSON.stringify(audit.detail).includes(managerPin), false);
  });

  await test("paid units cannot be voided; the remaining total never drops below paid", async () => {
    // Dine-in at a table: at balance zero the check stays "paid" (service 024),
    // so the last void still reaches the unpaid-units rule instead of check_closed.
    const [table] = await run(
      owner,
      (tx) => tx`select id from dining_tables order by name limit 1`,
    );
    const o = await run(owner, (tx) =>
      createOrder(tx, owner, {
        operationId: randomUUID(),
        lines: [
          {
            id: randomUUID(),
            productId: product.id,
            quantity: 2,
            options: [],
            note: "",
          },
        ],
        mode: "dine_in",
        tableId: table.id,
        name: "Voids",
        note: "",
        channel: "pos",
      }),
    );
    const unit = o.lines[0].unitPrice;
    const paid = await run(owner, (tx) =>
      recordPayment(tx, owner, o.id, {
        operationId: randomUUID(),
        amount: unit,
        tip: 0,
        received: unit,
        method: "cash",
      }),
    );
    await rejects(
      voidAs(owner, o.id, voidBody(paid, 2)),
      "void_exceeds_unpaid",
    );
    const v = await voidAs(owner, o.id, voidBody(paid, 1));
    assert.equal(v.total, v.paid);
    assert.deepEqual(v.lines[0].voidedUnits, [1]);
    assert.equal(v.checkState, "paid");
    await rejects(voidAs(owner, o.id, voidBody(v, 1)), "void_exceeds_unpaid");
  });

  await test("stock cannot be returned once the kitchen has seen the ticket", async () => {
    const o = await newOrder();
    const round = o.rounds.find((r) => r.station === "kitchen")!;
    await run(kitchen, (tx) =>
      progressPreparation(tx, kitchen, round.id, {
        operationId: randomUUID(),
        state: "seen",
      }),
    );
    const seen = await run(owner, (tx) => getOrder(tx, o.id));
    await rejects(
      voidAs(owner, o.id, voidBody(seen, 1, { stockDisposition: "return" })),
      "stock_return_not_allowed",
    );
    const before = await stockBalance();
    const v = await voidAs(owner, o.id, voidBody(seen, 1));
    assert.equal(v.voids![0].preparationState, "active");
    assert.equal(await stockBalance(), before);
  });

  await test("stale versions, replays and changed payloads are handled", async () => {
    const o = await newOrder();
    const body = voidBody(o, 1);
    const first = await voidAs(owner, o.id, body);
    const replay = await voidAs(owner, o.id, body);
    assert.deepEqual(replay, JSON.parse(JSON.stringify(first)));
    const rows = await run(
      owner,
      (tx) => tx`select id from line_voids where order_id=${o.id}`,
    );
    assert.equal(rows.length, 1);
    await rejects(
      voidAs(owner, o.id, { ...body, reason: "Otro motivo" }),
      "operation_conflict",
    );
    await rejects(voidAs(owner, o.id, voidBody(o, 1)), "stale_order");
  });

  await test("concurrent voids of the same version apply exactly once", async () => {
    const o = await newOrder();
    const results = await Promise.allSettled([
      voidAs(owner, o.id, voidBody(o, 2)),
      voidAs(owner, o.id, voidBody(o, 2)),
      voidAs(owner, o.id, voidBody(o, 2)),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const after = await run(owner, (tx) => getOrder(tx, o.id));
    assert.equal(after.lines[0].voidedUnits!.length, 2);
  });

  await test("the kitchen acknowledges voids and a fully voided order is cancelled", async () => {
    const o = await newOrder();
    const v = await voidAs(owner, o.id, voidBody(o, 3));
    assert.equal(v.total, 0);
    assert.equal(v.state, "cancelled");
    const [pending] = await run(
      owner,
      (tx) =>
        tx`select state from rounds where order_id=${o.id} and station='kitchen'`,
    );
    assert.equal(pending.state, "active");
    const round = o.rounds.find((r) => r.station === "kitchen")!;
    await rejects(
      run(cashier, (tx) =>
        acknowledgeVoids(tx, cashier, round.id, { operationId: randomUUID() }),
      ),
      "forbidden",
    );
    const ack = await run(kitchen, (tx) =>
      acknowledgeVoids(tx, kitchen, round.id, { operationId: randomUUID() }),
    );
    assert.equal(ack.acknowledged, 1);
    const [done] = await run(
      owner,
      (tx) =>
        tx`select state from rounds where order_id=${o.id} and station='kitchen'`,
    );
    assert.equal(done.state, "completed");
    const after = await run(owner, (tx) => getOrder(tx, o.id));
    assert.equal(after.state, "cancelled");
    assert.equal(after.voids![0].kitchenPending, false);
    assert.equal(after.checkState, "closed");
    assert.equal(after.closeReason, "voided");
    // service (024): a fully voided check is closed, so a new round is
    // rejected as check_closed (it was stale_order before the lifecycle split).
    await rejects(
      run(owner, (tx) =>
        addRound(tx, owner, o.id, {
          operationId: randomUUID(),
          expectedVersion: after.version,
          lines: [
            {
              id: randomUUID(),
              productId: product.id,
              quantity: 1,
              options: [],
              note: "",
            },
          ],
          mode: "takeaway",
        }),
      ),
      "check_closed",
    );
  });

  await test("voids are tenant scoped and immutable to the runtime role", async () => {
    const o = await newOrder();
    await rejects(
      run(foreignCashier, (tx) =>
        voidLines(
          tx,
          foreignCashier,
          o.id,
          voidBody(o, 1),
          foreignCashier.employeeId,
        ),
      ),
      "not_found",
    );
    const v = await voidAs(owner, o.id, voidBody(o, 1));
    await assert.rejects(
      run(
        owner,
        (tx) =>
          tx`update line_voids set reason='changed' where order_id=${o.id}`,
      ),
      /permission denied/,
    );
    await assert.rejects(
      run(owner, (tx) => tx`delete from line_voids where order_id=${o.id}`),
      /permission denied/,
    );
    assert.equal(v.voids!.length, 1);
  });

  await test("failed PINs lock the employee on this device and the count survives the rejected request", async () => {
    // SEC-2: the lock is per employee and device scope; the failure that reaches
    // the threshold already answers pin_locked.
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++)
      await rejects(
        verifyApproval(sql, cashier, { login: managerLogin, secret: "9999" }),
        "approval_denied",
      );
    await rejects(
      verifyApproval(sql, cashier, { login: managerLogin, secret: "9999" }),
      "pin_locked",
    );
    await rejects(verifyApproval(sql, cashier, approval), "pin_locked");
    const [row] = await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${tenantId},true)`;
      return tx`select t.failures,t.lock_level,t.locked_until>now() as locked,
          t.locked_until<=now()+make_interval(mins=>${LOCK_MINUTES}) as bounded,
          e.failed_attempts
        from pin_throttles t join employees e on e.tenant_id=t.tenant_id and e.id=t.employee_id
        where t.employee_id=${managerId} and t.scope=${deviceScope(cashier.deviceId)}`;
    });
    assert.equal(row.failures, 0);
    assert.equal(row.lock_level, 1);
    assert.equal(row.locked, true);
    assert.equal(row.bounded, true);
    assert.equal(row.failed_attempts, MAX_FAILED_ATTEMPTS);
    // Sign-in on the same device uses the same check and also refuses while locked.
    const check = await run(owner, (tx) =>
      checkEmployeeSecret(
        tx,
        managerLogin,
        managerPin,
        deviceScope(cashier.deviceId),
      ),
    );
    assert.equal(check.outcome, "locked");
  });

  await test("a successful PIN clears earlier failures", async () => {
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${tenantId},true)`;
      await tx`update pin_throttles set failures=3,lock_level=0,locked_until=null,last_failure_at=now()
        where employee_id=${managerId} and scope=${deviceScope(cashier.deviceId)}`;
      await tx`update employees set failed_attempts=3,locked_until=null where id=${managerId}`;
    });
    assert.equal(await verifyApproval(sql, cashier, approval), managerId);
    const [row] = await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${tenantId},true)`;
      return tx`select t.failures,t.lock_level,e.failed_attempts
        from pin_throttles t join employees e on e.tenant_id=t.tenant_id and e.id=t.employee_id
        where t.employee_id=${managerId} and t.scope=${deviceScope(cashier.deviceId)}`;
    });
    assert.deepEqual(row, { failures: 0, lock_level: 0, failed_attempts: 0 });
  });

  console.log(`${checks} void and approval checks passed`);
} finally {
  await admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id',${tenantId},true)`;
    await tx`update employees set active=false where id=${managerId}`;
  });
  await sql.end();
  await admin.end();
}
