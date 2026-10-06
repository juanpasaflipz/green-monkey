import "dotenv/config";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect, tenant } from "../server/db.js";
import { entitlement, requirePro } from "../server/entitlements.js";
import { catalog, createOrder } from "../server/orders.js";
import type { Session } from "../shared/domain.js";
import { isolatedTarget } from "./isolated-target.js";
const { runtime, migration } = isolatedTarget(process.env);
const sql = connect(runtime),
  admin = postgres(migration, { max: 1 });
const a = "10000000-0000-4000-8000-000000000001",
  b = "10000000-0000-4000-8000-000000000002";
const before =
  await admin`select * from restaurant_entitlements where tenant_id in (${a},${b})`;
try {
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source) values(${a},'active',now()+interval '1 hour','fixture') on conflict(tenant_id) do update set status='active',access_until=now()+interval '1 hour'`;
  await admin`insert into restaurant_entitlements(tenant_id,status,source) values(${b},'canceled','fixture') on conflict(tenant_id) do update set status='canceled',access_until=null`;
  assert.equal((await tenant(sql, a, entitlement)).plan, "pro");
  assert.equal((await tenant(sql, b, entitlement)).plan, "free");
  await assert.rejects(tenant(sql, b, requirePro), /pro_required/);
  assert.equal((await sql`select * from restaurant_entitlements`).length, 0);
  await assert.rejects(
    tenant(
      sql,
      b,
      (tx) => tx`update restaurant_entitlements set status='active'`,
    ),
    /permission denied/,
  );
  const s: Session = {
    id: randomUUID(),
    tenantId: a,
    employeeId: "20000000-0000-4000-8000-000000000001",
    deviceId: "30000000-0000-4000-8000-000000000001",
    name: "Entitlement test",
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
  const products = await tenant(sql, a, catalog);
  const product = products.find((p) => !p.groups.length)!;
  const input = {
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
    channel: "kiosk",
    mode: "takeaway",
    tableId: null,
    name: "Entitlement retry test",
    note: "",
  };
  const order = await tenant(sql, a, (tx) => createOrder(tx, s, input));
  await admin`update restaurant_entitlements set access_until=now()-interval '1 second' where tenant_id=${a}`;
  const replay = await tenant(sql, a, (tx) => createOrder(tx, s, input));
  assert.equal(order.id, replay.id);
  await assert.rejects(
    tenant(sql, a, (tx) =>
      createOrder(tx, s, { ...input, operationId: randomUUID() }),
    ),
    /pro_required/,
  );
  console.log(
    "PASS entitlement database checks: isolation, fail closed, privilege denial, Pro kiosk, expiry, accepted-order retry and rejection of new orders",
  );
} finally {
  for (const row of before)
    await admin`update restaurant_entitlements set status=${row.status},access_until=${row.access_until},trial_used=${row.trial_used},source=${row.source},stripe_customer_id=${row.stripe_customer_id},stripe_subscription_id=${row.stripe_subscription_id},version=${row.version},updated_at=${row.updated_at} where tenant_id=${row.tenant_id}`;
  const priorIds = before.map((row) => row.tenant_id);
  if (!priorIds.includes(a))
    await admin`delete from restaurant_entitlements where tenant_id=${a}`;
  if (!priorIds.includes(b))
    await admin`delete from restaurant_entitlements where tenant_id=${b}`;
  await sql.end();
  await admin.end();
}
