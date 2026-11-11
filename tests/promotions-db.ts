import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { connect, tenant, checkRole } from "../server/db.js";
import { isolatedTarget } from "./isolated-target.js";
import {
  addRound,
  catalog,
  createOrder,
  getOrder,
  recordPayment,
} from "../server/orders.js";
import {
  listOffers,
  priceOrder,
  requestApproval,
  saveOffer,
} from "../server/offers.js";
import { orderInput, type Session } from "../shared/domain.js";

const { runtime: url, migration } = isolatedTarget(process.env);
const u = new URL(url);
const identity = u.hostname + ":" + (u.port || "5432") + u.pathname;
const sql = connect(url),
  admin = postgres(migration, { max: 1 });
await checkRole(sql);
const session = (n: 1 | 2, role = "owner", employee = "8000"): Session => ({
  id: randomUUID(),
  tenantId: `10000000-0000-4000-8000-00000000000${n}`,
  employeeId: `20000000-0000-4000-${employee}-00000000000${n}`,
  deviceId: `30000000-0000-4000-8000-00000000000${n}`,
  name: "Test",
  role,
  expiresAt: "",
  offlineUntil: "",
  csrf: "",
  restaurant: {
    name: "Test",
    currency: "MXN",
    timezone: "America/Mexico_City",
    cutoff: 240,
  },
});
const owner = session(1),
  cashier = session(1, "cashier", "8001"),
  other = session(2);
const [originalEntitlement] =
  await admin`select * from restaurant_entitlements where tenant_id=${owner.tenantId}`;
await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source) values(${owner.tenantId},'active',now()+interval '1 hour','fixture') on conflict(tenant_id) do update set status='active',access_until=now()+interval '1 hour'`;
let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
const run = <T>(s: Session, fn: (tx: any) => Promise<T>) =>
  tenant(sql, s.tenantId, fn);
const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (e: any) => e.code === code);
const deactivate = () =>
  Promise.all(
    [owner, other].map((s) =>
      run(s, (tx) => tx`update promotions set active=false where active`),
    ),
  );
try {
  await deactivate();
  const products = await run(owner, catalog);
  const product = products.find((p) => p.groups.length === 0 && !p.openAmount)!;
  const order = (extra: Record<string, unknown> = {}, quantity = 2) => ({
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
    name: "Promo",
    note: "",
    channel: "pos",
    ...extra,
  });
  const gross = product.price * 2;
  const define = (s: Session, offer: Record<string, unknown>, version = 0) =>
    run(s, (tx) =>
      saveOffer(tx, s, {
        operationId: randomUUID(),
        expectedVersion: version,
        offer: {
          id: randomUUID(),
          name: "Prueba",
          kind: "percent",
          value: 1000,
          scope: "order",
          ...offer,
        },
      }),
    );
  await run(
    owner,
    (tx) =>
      tx`select id from cash_sessions where device_id=${owner.deviceId} and closed_at is null`,
  ).then(async (open) => {
    if (!open.length)
      await run(
        owner,
        (tx) =>
          tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${owner.tenantId},${randomUUID()},${owner.deviceId},${owner.employeeId},0)`,
      );
  });

  let ten: any;
  await test("definitions are permissioned, versioned and tenant scoped", async () => {
    await rejects(define(cashier, {}), "forbidden");
    ten = await define(owner, { name: "Diez" });
    assert.equal(ten.version, 1);
    const { version: _version, ...definition } = ten;
    await rejects(
      run(owner, (tx) =>
        saveOffer(tx, owner, {
          operationId: randomUUID(),
          expectedVersion: 0,
          offer: { ...definition, name: "Stale" },
        }),
      ),
      "stale_order",
    );
    ten = await run(owner, (tx) =>
      saveOffer(tx, owner, {
        operationId: randomUUID(),
        expectedVersion: 1,
        offer: { ...definition, name: "Diez v2" },
      }),
    );
    assert.equal(ten.version, 2);
    assert((await run(owner, listOffers)).some((o) => o.id === ten.id));
    assert(!(await run(other, listOffers)).some((o) => o.id === ten.id));
    await rejects(
      define(owner, { scope: "product", targets: [randomUUID()] }),
      "invalid_target",
    );
  });

  let discounted: any;
  await test("automatic offer prices the order, lines and redemption together", async () => {
    const body = order();
    const preview = await run(owner, (tx) =>
      priceOrder(tx, owner, orderInput.parse(body), true, false),
    );
    discounted = await run(owner, (tx) => createOrder(tx, owner, body));
    const reduction = Math.round(gross * 0.1);
    assert.equal(preview.total, gross - reduction);
    assert.equal(discounted.total, gross - reduction);
    assert.equal(discounted.discount, reduction);
    assert.equal(discounted.lines[0].gross, gross);
    assert.equal(discounted.lines[0].total, gross - reduction);
    assert.deepEqual(
      discounted.discounts.map((d: any) => [d.id, d.version, d.amount]),
      [[ten.id, 2, reduction]],
    );
    assert.equal(
      discounted.paymentUnits.reduce((a: number, x: any) => a + x.due, 0),
      discounted.total,
    );
    const retry = await run(owner, (tx) => createOrder(tx, owner, body));
    assert.equal(retry.id, discounted.id);
    const rows = await run(
      owner,
      (tx) =>
        tx`select * from promotion_redemptions where order_id=${discounted.id}`,
    );
    assert.equal(rows.length, 1);
  });

  await test("payment is capped at the discounted total", async () => {
    const pay = (amount: number) =>
      run(owner, (tx) =>
        recordPayment(tx, owner, discounted.id, {
          operationId: randomUUID(),
          amount,
          tip: 0,
          received: amount,
          method: "cash",
        }),
      );
    await rejects(pay(gross), "overpayment");
    const paid = await pay(discounted.total);
    assert.equal(paid.paid, paid.total);
  });

  await test("later rounds get automatic offers but never codes", async () => {
    const created = await run(owner, (tx) => createOrder(tx, owner, order()));
    const round = {
      ...order(),
      expectedVersion: created.version,
    };
    await rejects(
      run(owner, (tx) =>
        addRound(tx, owner, created.id, { ...round, code: "HOLA10" }),
      ),
      "promo_code_not_eligible",
    );
    const next = await run(owner, (tx) =>
      addRound(tx, owner, created.id, round),
    );
    assert.equal(next.discount, created.discount * 2);
    assert.equal(next.total, created.total * 2);
    assert.equal(next.discounts.length, 2);
    assert.equal(
      next.lines.reduce((a: number, l: any) => a + l.total, 0),
      next.total,
    );
  });

  await test("codes are validated, tenant scoped and limited under concurrency", async () => {
    const code =
      "UNO" + randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    const limited = await define(owner, {
      name: "Código",
      value: 5000,
      code,
      usageLimit: 1,
      stackable: false,
    });
    await rejects(define(owner, { code }), "promo_code_taken");
    await rejects(
      run(owner, (tx) => createOrder(tx, owner, order({ code: "NOEXISTE" }))),
      "promo_code_invalid",
    );
    await rejects(
      run(other, async (tx) => {
        const theirs = (await catalog(tx)).find((p) => !p.groups.length)!;
        return createOrder(tx, other, {
          ...order({ code }),
          lines: [
            {
              id: randomUUID(),
              productId: theirs.id,
              quantity: 1,
              options: [],
              note: "",
            },
          ],
        });
      }),
      "promo_code_invalid",
    );
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        run(owner, (tx) => createOrder(tx, owner, order({ code }))),
      ),
    );
    const won = results.filter((r) => r.status === "fulfilled") as any[];
    assert.equal(won.length, 1);
    assert.equal(won[0].value.discount, Math.round(gross * 0.5));
    assert.equal(won[0].value.discounts[0].id, limited.id);
    assert(
      results
        .filter((r) => r.status === "rejected")
        .every((r: any) => r.reason.code === "promo_code_not_eligible"),
    );
  });

  await test("manual discounts need an exact single-use manager approval", async () => {
    const manual = {
      kind: "amount",
      value: 1500,
      reason: "Cortesía de la casa",
    };
    const body = order({ manualDiscount: manual });
    await rejects(
      run(cashier, (tx) => createOrder(tx, cashier, body)),
      "approval_required",
    );
    await rejects(
      run(cashier, (tx) =>
        requestApproval(tx, cashier, {
          login: "cashier",
          secret: "123456",
          operationId: body.operationId,
          kind: "amount",
          value: 1500,
        }),
      ),
      "invalid_approval",
    );
    const approve = (operationId: string, value: number) =>
      run(cashier, (tx) =>
        requestApproval(tx, cashier, {
          login: "owner",
          secret: "demo-green-monkey",
          operationId,
          kind: "amount",
          value,
        }),
      );
    const wrongAmount = await approve(body.operationId, 100);
    await rejects(
      run(cashier, (tx) =>
        createOrder(tx, cashier, {
          ...body,
          manualDiscount: { ...manual, approvalId: wrongAmount.approvalId },
        }),
      ),
      "approval_required",
    );
    const granted = await approve(body.operationId, 1500);
    const approved = {
      ...body,
      manualDiscount: { ...manual, approvalId: granted.approvalId },
    };
    const created = await run(cashier, (tx) =>
      createOrder(tx, cashier, approved),
    );
    const afterOffer = gross - Math.round(gross * 0.1);
    assert.equal(created.total, afterOffer - 1500);
    assert.deepEqual(
      created.discounts.map((d: any) => d.kind),
      ["promotion", "manual"],
    );
    const [row] = await run(
      owner,
      (tx) =>
        tx`select approval_id,reason from promotion_redemptions where order_id=${created.id} and kind='manual'`,
    );
    assert.equal(row.approval_id, granted.approvalId);
    // Same approval cannot authorize a second order.
    const second = order({ manualDiscount: approved.manualDiscount });
    await rejects(
      run(cashier, (tx) => createOrder(tx, cashier, second)),
      "approval_required",
    );
    // A different cashier cannot spend another requester's approval.
    const fresh = order({ manualDiscount: manual });
    const theirs = await approve(fresh.operationId, 1500);
    await rejects(
      run(owner, (tx) =>
        createOrder(
          tx,
          { ...cashier, employeeId: owner.employeeId },
          {
            ...fresh,
            manualDiscount: { ...manual, approvalId: theirs.approvalId },
          },
        ),
      ),
      "approval_required",
    );
    await admin`update approvals set expires_at=now()-interval '1 second' where id=${theirs.approvalId}`;
    await rejects(
      run(cashier, (tx) =>
        createOrder(tx, cashier, {
          ...fresh,
          manualDiscount: { ...manual, approvalId: theirs.approvalId },
        }),
      ),
      "approval_required",
    );
    const direct = await run(owner, (tx) =>
      createOrder(
        tx,
        owner,
        order({
          manualDiscount: { kind: "percent", value: 10000, reason: "Cortesía" },
        }),
      ),
    );
    assert.equal(direct.total, 0);
    assert.equal(direct.discount, gross);
    await rejects(
      run(owner, (tx) =>
        createOrder(
          tx,
          owner,
          order({ channel: "qr", manualDiscount: manual }),
        ),
      ),
      "forbidden",
    );
  });

  await test("offline sales never carry offers and item offers respect scope", async () => {
    await rejects(
      run(owner, (tx) =>
        priceOrder(
          tx,
          owner,
          orderInput.parse(order({ channel: "offline", code: "HOLA10" })),
          true,
          false,
        ),
      ),
      "offers_unavailable_offline",
    );
    const plain = await run(owner, (tx) =>
      priceOrder(
        tx,
        owner,
        orderInput.parse(order({ channel: "offline" })),
        true,
        false,
      ),
    );
    assert.equal(plain.total, gross);
    await deactivate();
    await define(owner, {
      name: "Producto",
      scope: "product",
      targets: [product.id],
      kind: "amount",
      value: 100,
      channels: ["qr"],
    });
    const pos = await run(owner, (tx) =>
      priceOrder(tx, owner, orderInput.parse(order()), true, false),
    );
    const qr = await run(owner, (tx) =>
      priceOrder(
        tx,
        owner,
        orderInput.parse(order({ channel: "qr" })),
        true,
        false,
      ),
    );
    assert.equal(pos.discount, 0);
    assert.equal(qr.discount, 200);
  });

  await test("the runtime role cannot rewrite redemptions or approvals", async () => {
    await assert.rejects(
      run(owner, (tx) => tx`update promotion_redemptions set amount=1`),
    );
    await assert.rejects(
      run(owner, (tx) => tx`delete from promotion_redemptions`),
    );
    await assert.rejects(
      run(owner, (tx) => tx`update approvals set binding='x'`),
    );
    const [check] = await run(owner, (tx) => getOrder(tx, discounted.id)).then(
      (o) => [o.discount],
    );
    assert(check > 0);
  });
  console.log(`${checks} promotion checks passed on ${identity}`);
} finally {
  await deactivate();
  if (originalEntitlement)
    await admin`update restaurant_entitlements set status=${originalEntitlement.status},access_until=${originalEntitlement.access_until} where tenant_id=${owner.tenantId}`;
  else
    await admin`delete from restaurant_entitlements where tenant_id=${owner.tenantId}`;
  await sql.end();
  await admin.end();
}
