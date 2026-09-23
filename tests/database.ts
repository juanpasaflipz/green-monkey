import {
  assignService,
  serviceOptions,
  progressPreparation,
} from "../server/service.js";
import { getSettings, saveSettings } from "../server/restaurant.js";
import "dotenv/config";
import { saveProduct } from "../server/management.js";
import { commitImport } from "../server/imports.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { connect, tenant, checkRole } from "../server/db.js";
import { isolatedTarget } from "./isolated-target.js";
import {
  createOrder,
  recordPayment,
  addRound,
  getOrder,
  catalog,
  stock,
} from "../server/orders.js";
import type { Session } from "../shared/domain.js";
const { runtime: url, migration } = isolatedTarget(process.env);
const u = new URL(url);
const identity = u.hostname + ":" + (u.port || "5432") + u.pathname;
const sql = connect(url),
  admin = postgres(migration, { max: 1 });
await checkRole(sql);
const s: Session = {
  id: randomUUID(),
  tenantId: "10000000-0000-4000-8000-000000000001",
  employeeId: "20000000-0000-4000-8000-000000000001",
  deviceId: "30000000-0000-4000-8000-000000000001",
  name: "Test",
  role: "owner",
  expiresAt: "",
  offlineUntil: "",
  csrf: "",
  restaurant: {
    name: "Test",
    currency: "MXN",
    timezone: "America/Mexico_City",
    cutoff: 240,
  },
};
let checks = 0;
const [originalEntitlement] =
  await admin`select * from restaurant_entitlements where tenant_id=${s.tenantId}`;
await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source) values(${s.tenantId},'active',now()+interval '1 hour','fixture') on conflict(tenant_id) do update set status='active',access_until=now()+interval '1 hour'`;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
try {
  await test("missing tenant fails closed", async () => {
    await assert.rejects(tenant(sql, "", async () => 0));
    assert.equal((await sql`select * from catalog`).length, 0);
  });
  await test("two tenants cannot read each other", async () => {
    const a = await tenant(sql, s.tenantId, catalog);
    const b = await tenant(
      sql,
      "10000000-0000-4000-8000-000000000002",
      catalog,
    );
    assert(a.length > 0 && b.length > 0);
    assert(!a.some((p) => b.some((q) => q.id === p.id)));
  });
  const products = await tenant(sql, s.tenantId, catalog);
  const product = products.find(
    (p) => p.groups.length === 0 && p.recipe?.length,
  )!;
  const body = {
    operationId: randomUUID(),
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
    tableId: null,
    name: "Integration",
    note: "",
    channel: "pos",
  };
  let order: any;
  await test("concurrent identical order creates one effect", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        tenant(sql, s.tenantId, (tx) => createOrder(tx, s, body)),
      ),
    );
    assert.equal(new Set(results.map((r) => r.id)).size, 1);
    order = results[0];
    const moves = await tenant(
      sql,
      s.tenantId,
      (tx) =>
        tx`select * from stock_movements where cause_id=${body.lines[0].id}`,
    );
    assert.equal(moves.length, 1);
  });
  await test("changed payload with same operation ID conflicts", async () => {
    await assert.rejects(
      tenant(sql, s.tenantId, (tx) =>
        createOrder(tx, s, { ...body, name: "changed" }),
      ),
    );
  });
  await test("round retries are bound to the exact order", async () => {
    const command = {
      ...body,
      operationId: randomUUID(),
      expectedVersion: order.version,
      lines: [{ ...body.lines[0], id: randomUUID() }],
    };
    const first = await tenant(sql, s.tenantId, (tx) =>
      addRound(tx, s, order.id, command),
    );
    const retry = await tenant(sql, s.tenantId, (tx) =>
      addRound(tx, s, order.id, command),
    );
    assert.equal(first.id, retry.id);
    assert.equal(first.lines.length, retry.lines.length);
    await assert.rejects(
      tenant(sql, s.tenantId, (tx) => addRound(tx, s, randomUUID(), command)),
      (e: any) => e.code === "operation_conflict",
    );
    order = first;
  });
  await test("cross-tenant foreign keys reject references", async () => {
    await assert.rejects(
      tenant(
        sql,
        s.tenantId,
        (tx) =>
          tx`insert into order_lines(tenant_id,id,order_id,product_id,round,data) values(${s.tenantId},${randomUUID()},${order.id},'60000000-0000-4000-8002-000000000001',2,'{}')`,
      ),
    );
  });
  await tenant(sql, s.tenantId, async (tx) => {
    const [d] =
      await tx`select id from cash_sessions where device_id=${s.deviceId} and closed_at is null`;
    if (!d)
      await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${s.tenantId},${randomUUID()},${s.deviceId},${s.employeeId},0)`;
  });
  await test("concurrent payments cannot overcollect", async () => {
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        tenant(sql, s.tenantId, (tx) =>
          recordPayment(tx, s, order.id, {
            operationId: randomUUID(),
            amount: order.total,
            tip: 0,
            received: order.total,
            method: "cash",
          }),
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const result = await tenant(sql, s.tenantId, (tx) =>
      getOrder(tx, order.id),
    );
    assert.equal(result.paid, order.total);
    assert.equal(result.state, "active");
  });
  await test("transaction rollback preserves stock and connection context", async () => {
    const stockId = product.recipe![0].stockId;
    const before = await tenant(
      sql,
      s.tenantId,
      (tx) =>
        tx`select sum(quantity)::text as n from stock_movements where stock_id=${stockId}`,
    );
    await assert.rejects(
      tenant(sql, s.tenantId, async (tx) => {
        await stock(tx, s, stockId, "-1", "test", randomUUID(), "rollback");
        throw Error("rollback");
      }),
    );
    const after = await tenant(
      sql,
      s.tenantId,
      (tx) =>
        tx`select sum(quantity)::text as n from stock_movements where stock_id=${stockId}`,
    );
    assert.equal(before[0].n, after[0].n);
    assert.equal((await sql`select * from orders`).length, 0);
  });
  await test("history cannot be updated by runtime role", async () => {
    await assert.rejects(
      tenant(
        sql,
        s.tenantId,
        (tx) => tx`update tenders set amount=1 where order_id=${order.id}`,
      ),
    );
  });
  await test("concurrent stock decisions serialize at the last portion", async () => {
    const stockId = randomUUID();
    await tenant(sql, s.tenantId, async (tx) => {
      await tx`insert into stock_items(tenant_id,id,name,unit,kind) values(${s.tenantId},${stockId},'Concurrency fixture','piece','prepared')`;
      await stock(tx, s, stockId, "1", "opening", stockId, "test");
    });
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        tenant(sql, s.tenantId, (tx) =>
          stock(tx, s, stockId, "-1", "sale", randomUUID(), "test"),
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  });
  await test("catalog import rerun preserves mappings with no operational side effects", async () => {
    const raw = {
      source: "luma",
      sourceTenantId: "test-" + randomUUID(),
      targetTenantId: s.tenantId,
      currency: "MXN",
      rows: [
        {
          id: "catalog-1",
          name: "Imported fixture",
          price: "10.05",
          category: "Test",
        },
      ],
    };
    const counts = () =>
      tenant(
        sql,
        s.tenantId,
        async (tx) =>
          (
            await tx`select (select count(*) from tenders)::int as tenders,(select count(*) from stock_movements)::int as stock,(select count(*) from jobs)::int as jobs`
          )[0],
      );
    const before = await counts();
    const a = await tenant(sql, s.tenantId, (tx) => commitImport(tx, s, raw));
    const b = await tenant(sql, s.tenantId, (tx) => commitImport(tx, s, raw));
    assert.equal(a.counts.accepted, b.counts.accepted);
    assert.deepEqual(await counts(), before);
    const mappings = await tenant(
      sql,
      s.tenantId,
      (tx) =>
        tx`select * from source_mappings where source_tenant_id=${raw.sourceTenantId}`,
    );
    assert.equal(mappings.length, 1);
  });
  await test("recipe versions retain historical costs and reject stale or duplicate ingredients", async () => {
    const recipeStocks = await tenant(sql, s.tenantId, async (tx) => {
      const ids = [randomUUID(), randomUUID()];
      for (const stockId of ids) {
        await tx`insert into stock_items(tenant_id,id,name,unit,kind) values(${s.tenantId},${stockId},'Recipe fixture','piece','raw')`;
        await stock(tx, s, stockId, "100", "opening", stockId, "Recipe test");
      }
      return ids;
    });
    const input = {
      operationId: randomUUID(),
      id: randomUUID(),
      name: { es: "Receta de prueba", en: "Test recipe" },
      category: { es: "Prueba", en: "Test" },
      price: 5000,
      cost: 1500,
      available: true,
      station: "kitchen",
      expectedVersion: 0,
      recipe: recipeStocks.map((stockId) => ({ stockId, quantity: "2" })),
    };
    const first = await tenant(sql, s.tenantId, (tx) =>
      saveProduct(tx, s, input),
    );
    const original = await tenant(sql, s.tenantId, (tx) =>
      createOrder(tx, s, {
        ...body,
        operationId: randomUUID(),
        lines: [{ ...body.lines[0], id: randomUUID(), productId: first.id }],
      }),
    );
    await tenant(sql, s.tenantId, (tx) =>
      saveProduct(tx, s, {
        ...input,
        operationId: randomUUID(),
        expectedVersion: 1,
        cost: 2000,
        price: 5500,
      }),
    );
    await assert.rejects(
      tenant(sql, s.tenantId, (tx) =>
        saveProduct(tx, s, {
          ...input,
          operationId: randomUUID(),
          expectedVersion: 1,
        }),
      ),
    );
    await assert.rejects(
      tenant(sql, s.tenantId, (tx) =>
        saveProduct(tx, s, {
          ...input,
          operationId: randomUUID(),
          expectedVersion: 2,
          recipe: [input.recipe[0], input.recipe[0]],
        }),
      ),
    );
    const historic = await tenant(sql, s.tenantId, (tx) =>
      getOrder(tx, original.id),
    );
    assert.equal(historic.total, 5000);
    assert.equal(historic.lines[0].cost, 1500);
    const versions = await tenant(
      sql,
      s.tenantId,
      (tx) =>
        tx`select version,data from recipe_versions where product_id=${input.id} order by version`,
    );
    assert.equal(versions.length, 2);
    assert.equal(versions[0].data.recipe.length, 2);
    assert.equal(versions[0].data.cost, 1500);
  });
  await test("item settlements serialize competing selections and preserve partial units", async () => {
    const created = await tenant(sql, s.tenantId, (tx) =>
      createOrder(tx, s, {
        ...body,
        operationId: randomUUID(),
        lines: [{ ...body.lines[0], id: randomUUID(), quantity: 3 }],
      }),
    );
    const unitPrice = created.paymentUnits![0].due;
    const pay = (amount: number, items?: string[]) => ({
      operationId: randomUUID(),
      amount,
      tip: 42,
      received: amount + 42,
      method: "cash",
      ...(items ? { items } : {}),
    });
    const request = pay(unitPrice, [created.paymentUnits![0].key]);
    const settled = await tenant(sql, s.tenantId, (tx) =>
      recordPayment(tx, s, created.id, request),
    );
    const retry = await tenant(sql, s.tenantId, (tx) =>
      recordPayment(tx, s, created.id, request),
    );
    assert.equal(settled.paid, retry.paid);
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        tenant(sql, s.tenantId, (tx) =>
          recordPayment(
            tx,
            s,
            created.id,
            pay(unitPrice, [created.paymentUnits![1].key]),
          ),
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const partial = await tenant(sql, s.tenantId, (tx) =>
      recordPayment(tx, s, created.id, pay(1)),
    );
    assert.equal(partial.paymentUnits![2].due, unitPrice - 1);
    const final = await tenant(sql, s.tenantId, (tx) =>
      recordPayment(
        tx,
        s,
        created.id,
        pay(unitPrice - 1, [partial.paymentUnits![2].key]),
      ),
    );
    assert.equal(final.paid, final.total);
    assert(final.paymentUnits!.every((u) => u.due === 0));
    assert.equal(final.state, "active");
    await assert.rejects(
      tenant(
        sql,
        s.tenantId,
        (tx) =>
          tx`update tender_allocations set amount=1 where order_id=${created.id}`,
      ),
    );
  });
  await test("pre-allocation tenders are never assigned invented item choices", async () => {
    const created = await tenant(sql, s.tenantId, (tx) =>
      createOrder(tx, s, {
        ...body,
        operationId: randomUUID(),
        lines: [{ ...body.lines[0], id: randomUUID(), quantity: 2 }],
      }),
    );
    await tenant(
      sql,
      s.tenantId,
      (tx) =>
        tx`insert into tenders(tenant_id,id,order_id,method,amount,received) values(${s.tenantId},${randomUUID()},${created.id},'cash',1,1)`,
    );
    const old = await tenant(sql, s.tenantId, (tx) => getOrder(tx, created.id));
    assert.equal(old.itemSplitAvailable, false);
    assert.deepEqual(old.paymentUnits, []);
    await assert.rejects(
      tenant(sql, s.tenantId, (tx) =>
        recordPayment(tx, s, created.id, {
          operationId: randomUUID(),
          amount: created.paymentUnits![0].due,
          received: created.paymentUnits![0].due,
          method: "cash",
          items: [created.paymentUnits![0].key],
        }),
      ),
      (e: any) => e.code === "unallocated_history",
    );
  });
  await test("restaurant settings are scoped, versioned and preserve order snapshots", async () => {
    await assert.rejects(
      tenant(
        sql,
        s.tenantId,
        (tx) =>
          tx`update restaurants set organization_id=organization_id where id=${s.tenantId}`,
      ),
    );
    await assert.rejects(
      tenant(sql, s.tenantId, async (tx) => {
        const old = await getSettings(tx, s);
        const request = {
          operationId: randomUUID(),
          expectedVersion: old.version,
          name: "Changed fixture",
          currency: old.currency,
          timezone: "UTC",
          cutoff: 330,
          openingDays: [1, 2, 3, 4, 5],
        };
        const changed = await saveSettings(tx, s, request);
        assert.equal(changed.version, old.version + 1);
        assert.equal(changed.timezone, "UTC");
        const historic = await getOrder(tx, order.id);
        assert.equal(
          historic.restaurantSnapshot!.timezone,
          "America/Mexico_City",
        );
        await assert.rejects(
          saveSettings(tx, s, { ...request, operationId: randomUUID() }),
          (e: any) => e.code === "settings_changed",
        );
        await assert.rejects(
          saveSettings(tx, s, {
            ...request,
            operationId: randomUUID(),
            expectedVersion: changed.version,
            currency: "USD",
          }),
          (e: any) => e.code === "currency_locked",
        );
        await assert.rejects(
          saveSettings(
            tx,
            { ...s, role: "cashier" },
            { ...request, operationId: randomUUID() },
          ),
          (e: any) => e.code === "forbidden",
        );
        const retry = await saveSettings(tx, s, request);
        assert.equal(retry.version, changed.version);
        throw new Error("settings_test_rollback");
      }),
      (e: any) => e.message === "settings_test_rollback",
    );
  });
  await test("service reassignment preserves creator, payments and kitchen rounds", async () => {
    const created = await tenant(sql, s.tenantId, (tx) =>
      createOrder(tx, s, {
        ...body,
        operationId: randomUUID(),
        lines: [{ ...body.lines[0], id: randomUUID() }],
      }),
    );
    const options = await tenant(sql, s.tenantId, (tx) =>
      serviceOptions(tx, s),
    );
    const employee = options.employees.find((e) => e.id !== s.employeeId)!;
    const request = {
      operationId: randomUUID(),
      expectedVersion: 0,
      mode: "dine_in",
      tableId: options.tables[0].id,
      employeeId: employee.id,
      reason: "Transfer service fixture",
    };
    const moved = await tenant(sql, s.tenantId, (tx) =>
      assignService(tx, s, created.id, request),
    );
    assert.equal(moved.tableId, request.tableId);
    assert.equal(moved.assignedEmployeeId, employee.id);
    assert.equal(moved.version, created.version);
    assert.equal(moved.rounds.length, created.rounds.length);
    assert.equal(moved.paid, created.paid);
    const [row] = await tenant(
      sql,
      s.tenantId,
      (tx) => tx`select employee_id from orders where id=${created.id}`,
    );
    assert.equal(row.employee_id, s.employeeId);
    const retry = await tenant(sql, s.tenantId, (tx) =>
      assignService(tx, s, created.id, request),
    );
    assert.equal(retry.serviceVersion, 1);
    await assert.rejects(
      tenant(sql, s.tenantId, (tx) =>
        assignService(tx, s, created.id, {
          ...request,
          operationId: randomUUID(),
        }),
      ),
      (e: any) => e.code === "stale_order",
    );
    await assert.rejects(
      tenant(sql, s.tenantId, (tx) =>
        assignService(tx, s, created.id, {
          ...request,
          operationId: randomUUID(),
          expectedVersion: 1,
          employeeId: "20000000-0000-4000-8000-000000000002",
        }),
      ),
      (e: any) => e.code === "invalid_assignee",
    );
    await assert.rejects(
      tenant(sql, s.tenantId, (tx) =>
        assignService(tx, s, created.id, {
          ...request,
          operationId: randomUUID(),
          expectedVersion: 1,
          tableId: "40000000-0000-4000-8002-000000000001",
        }),
      ),
      (e: any) => e.code === "invalid_table",
    );
    const round = await tenant(sql, s.tenantId, (tx) =>
      addRound(tx, s, created.id, {
        ...body,
        operationId: randomUUID(),
        expectedVersion: moved.version,
        lines: [{ ...body.lines[0], id: randomUUID() }],
      }),
    );
    assert.equal(round.rounds[1].number, 2);
    assert.equal(round.assignedEmployeeId, employee.id);
  });
  await test("kitchen progress and new rounds cannot overwrite aggregate preparation state", async () => {
    const created = await tenant(sql, s.tenantId, (tx) =>
      createOrder(tx, s, {
        ...body,
        operationId: randomUUID(),
        lines: [{ ...body.lines[0], id: randomUUID() }],
      }),
    );
    await Promise.all([
      tenant(sql, s.tenantId, (tx) =>
        progressPreparation(tx, s, created.rounds[0].id, {
          operationId: randomUUID(),
          state: "ready",
        }),
      ),
      tenant(sql, s.tenantId, (tx) =>
        addRound(tx, s, created.id, {
          ...body,
          operationId: randomUUID(),
          expectedVersion: created.version,
          lines: [{ ...body.lines[0], id: randomUUID() }],
        }),
      ),
    ]);
    const result = await tenant(sql, s.tenantId, (tx) =>
      getOrder(tx, created.id),
    );
    assert.equal(result.state, "active");
    assert(result.rounds.some((r) => r.state === "active"));
    assert(result.rounds.some((r) => r.state === "ready"));
  });
  console.log(`${checks} integration checks passed on ${identity}`);
} finally {
  if (originalEntitlement)
    await admin`update restaurant_entitlements set status=${originalEntitlement.status},access_until=${originalEntitlement.access_until},trial_used=${originalEntitlement.trial_used},source=${originalEntitlement.source},stripe_customer_id=${originalEntitlement.stripe_customer_id},stripe_subscription_id=${originalEntitlement.stripe_subscription_id},version=${originalEntitlement.version},updated_at=${originalEntitlement.updated_at} where tenant_id=${s.tenantId}`;
  else
    await admin`delete from restaurant_entitlements where tenant_id=${s.tenantId}`;
  await sql.end();
  await admin.end();
}
