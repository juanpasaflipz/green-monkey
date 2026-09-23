import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { connect, tenant } from "../server/db.js";
import { issueOfflineLease } from "../server/offline-leases.js";
import {
  reconcileOffline,
  listOfflineRecoveries,
  reviewOffline,
  resolveOfflineRecoveryTask,
  synchronizeOffline,
} from "../server/offline-sync.js";
import { saveProduct } from "../server/management.js";
import {
  cashHistory,
  cashSummary,
  closeCash,
  refund,
} from "../server/operations.js";
import { currencyExponent, type Session } from "../shared/domain.js";
import { addRound, createOrder } from "../server/orders.js";
import {
  paymentRecoveryStatus,
  retryPaymentRecovery,
} from "../server/payment-recovery.js";

const { runtime, migration } = isolatedTarget(process.env),
  sql = connect(runtime),
  admin = postgres(migration, { max: 1 });
const organizationId = randomUUID(),
  tenantId = randomUUID(),
  employeeId = randomUUID(),
  deviceId = randomUUID(),
  sessionId = randomUUID(),
  drawerId = randomUUID(),
  productId = randomUUID();
const s: Session = {
  id: sessionId,
  tenantId,
  employeeId,
  deviceId,
  name: "Offline recovery manager",
  role: "owner",
  expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
  offlineUntil: new Date(Date.now() + 4 * 3600_000).toISOString(),
  offlineLeaseVersion: 1,
  csrf: "fixture",
  restaurant: {
    name: "Offline recovery fixture",
    currency: "MXN",
    timezone: "America/Mexico_City",
    cutoff: 240,
    configVersion: 1,
  },
};
const run = <T>(fn: Parameters<typeof tenant<T>>[2]) =>
  tenant(sql, tenantId, fn);

async function completeAll<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failure = results.find((r) => r.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}

try {
  await admin`insert into organizations(id,name) values(${organizationId},'Offline recovery fixture')`;
  await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,free_location) values(${tenantId},${organizationId},${s.restaurant.name},'MXN','America/Mexico_City',240,true)`;
  await admin`insert into employees(tenant_id,id,name,login,secret_hash,role,free_slot) values(${tenantId},${employeeId},${s.name},${randomUUID()},'fixture','owner',null)`;
  await admin`insert into devices(tenant_id,id,name,token_hash,free_slot) values(${tenantId},${deviceId},'Offline device','fixture',1)`;
  await admin`insert into sessions(tenant_id,id,employee_id,device_id,token_hash,csrf,expires_at,offline_until,selling_authorized) values(${tenantId},${sessionId},${employeeId},${deviceId},'fixture','fixture',${s.expiresAt},${s.offlineUntil},true)`;
  await run((tx) => issueOfflineLease(tx, sessionId));
  await run((tx) =>
    saveProduct(tx, s, {
      operationId: randomUUID(),
      id: productId,
      name: { es: "Recuperación", en: "Recovery" },
      category: { es: "Pruebas", en: "Tests" },
      price: 100,
      available: true,
      station: "kitchen",
      expectedVersion: 0,
      cost: null,
      recipe: [],
    }),
  );
  await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at) values(${tenantId},${drawerId},${deviceId},${employeeId},0,now()-interval '1 minute')`;

  const sale = (version: 1 | 2, operationId = randomUUID()) => {
    const recordedAt = new Date().toISOString();
    const base = {
      operationId,
      order: {
        operationId: randomUUID(),
        lines: [
          {
            id: randomUUID(),
            productId,
            quantity: 1,
            options: [],
            note: "",
          },
        ],
        mode: "takeaway" as const,
        tableId: null,
        name: "Offline fixture",
        note: "",
        channel: "pos" as const,
      },
      expectedTotal: 100,
      received: 100,
      tip: 0,
      recordedAt,
      sessionId,
      cashSessionId: drawerId,
    };
    return version === 1
      ? base
      : {
          ...base,
          formatVersion: 2 as const,
          tenantId,
          employeeId,
          deviceId,
          leaseVersion: 1,
          currency: "MXN",
          currencyExponent: currencyExponent("MXN"),
          configurationVersion: 1,
          receiptSnapshot: {
            lines: [],
            restaurant: s.restaurant,
          },
        };
  };

  const normalSale = sale(2);
  const normal = await run((tx) => synchronizeOffline(tx, s, normalSale));
  const normalReplay = await run((tx) => synchronizeOffline(tx, s, normalSale));
  assert.equal(
    normal.id,
    normalReplay.id,
    "lost response replays exact result",
  );
  assert.equal(normal.paid, 100);
  const legacy = await run((tx) => synchronizeOffline(tx, s, sale(1)));
  assert.equal(legacy.paid, 100, "stored v1 records remain replayable");

  const changedRecipe = sale(2);
  await admin`update catalog set data=jsonb_set(jsonb_set(data,'{version}','2'),'{recipe}',${JSON.stringify([{ stockId: randomUUID(), quantity: "1" }])}::jsonb) where tenant_id=${tenantId} and id=${productId}`;
  await assert.rejects(
    run((tx) => synchronizeOffline(tx, s, changedRecipe)),
    /offline_conflict/,
    "same price with a changed recipe cannot consume today's ingredients",
  );
  await admin`update catalog set data=jsonb_set(jsonb_set(data,'{version}','1'),'{recipe}','[]') where tenant_id=${tenantId} and id=${productId}`;
  await admin`update restaurants set config_version=config_version+1 where id=${tenantId}`;
  await assert.rejects(
    run((tx) => synchronizeOffline(tx, s, sale(2))),
    /settings_changed/,
  );
  await admin`update restaurants set config_version=config_version-1 where id=${tenantId}`;
  await admin`update devices set active=false where tenant_id=${tenantId} and id=${deviceId}`;
  await assert.rejects(
    run((tx) => synchronizeOffline(tx, s, sale(2))),
    /offline_conflict/,
  );
  await admin`update devices set active=true where tenant_id=${tenantId} and id=${deviceId}`;
  const expired = sale(2);
  expired.recordedAt = new Date(Date.now() - 24 * 3600_000).toISOString();
  await assert.rejects(
    run((tx) => synchronizeOffline(tx, s, expired)),
    /offline_context_invalid/,
  );

  const race = sale(2);
  const outcomes = await completeAll([
    run((tx) => synchronizeOffline(tx, s, race)),
    run((tx) =>
      reconcileOffline(tx, s, {
        sale: race,
        reason: "Concurrent verified original cash claim",
        confirmed: true,
      }),
    ),
  ]);
  assert.equal(
    outcomes[0].id,
    outcomes[1].id,
    "sync and reconciliation share one financial identity",
  );
  const [raceTender] =
    await admin`select count(*)::int as n from tenders where tenant_id=${tenantId} and order_id=${outcomes[0].id}`;
  assert.equal(raceTender.n, 1);

  const paymentOrder = await run((tx) =>
    createOrder(tx, s, {
      ...sale(1).order,
      operationId: randomUUID(),
      lines: [
        {
          id: randomUUID(),
          productId,
          quantity: 1,
          options: [],
          note: "",
        },
      ],
    }),
  );
  const paymentAttempt = {
    formatVersion: 1 as const,
    tenantId,
    employeeId,
    deviceId,
    sessionId,
    cashSessionId: drawerId,
    orderId: paymentOrder.id,
    createdAt: new Date().toISOString(),
    payload: {
      operationId: randomUUID(),
      amount: 100,
      tip: 0,
      received: 100,
      method: "cash" as const,
      externalConfirmed: false,
      reference: "",
    },
  };
  const missingPayment = await run((tx) =>
    paymentRecoveryStatus(tx, s, paymentAttempt),
  );
  assert.equal(missingPayment.state, "missing");
  assert.equal(missingPayment.retryAllowed, true);
  const retriedPayment = await run((tx) =>
    retryPaymentRecovery(tx, s, paymentAttempt),
  );
  assert.equal(retriedPayment.paid, 100);
  const committedPayment = await run((tx) =>
    paymentRecoveryStatus(tx, s, paymentAttempt),
  );
  assert.equal(committedPayment.state, "committed");
  await assert.rejects(
    run((tx) =>
      paymentRecoveryStatus(tx, s, {
        ...paymentAttempt,
        payload: { ...paymentAttempt.payload, amount: 99 },
      }),
    ),
    /operation_conflict/,
    "committed lookup verifies the complete immutable command",
  );
  const newAttempt = {
    ...paymentAttempt,
    payload: { ...paymentAttempt.payload, operationId: randomUUID() },
  };
  await assert.rejects(
    run((tx) =>
      retryPaymentRecovery(tx, { ...s, id: randomUUID() }, newAttempt),
    ),
    /payment_review_required/,
  );

  const recoverySale = sale(2);
  await run((tx) =>
    saveProduct(tx, s, {
      operationId: randomUUID(),
      id: productId,
      name: { es: "Recuperación", en: "Recovery" },
      category: { es: "Pruebas", en: "Tests" },
      price: 150,
      available: true,
      station: "kitchen",
      expectedVersion: 1,
      cost: null,
      recipe: [],
    }),
  );
  await assert.rejects(
    run((tx) => synchronizeOffline(tx, s, recoverySale)),
    /price_conflict/,
  );
  const review = await run((tx) => reviewOffline(tx, s, recoverySale));
  assert.equal(review.collected, 100);
  assert.equal(review.currentTotal, 150);
  assert.equal(review.evidenceVersion, 1);
  await admin`update cash_sessions set counted=100,expected=100,closed_at=now() where tenant_id=${tenantId} and id=${drawerId}`;
  await admin`update sessions set revoked=true where tenant_id=${tenantId} and id=${sessionId}`;
  const command = {
    sale: recoverySale,
    reason: "Verified original cash against the device receipt",
    confirmed: true as const,
  };
  const recovered = await run((tx) => reconcileOffline(tx, s, command));
  const replay = await run((tx) => reconcileOffline(tx, s, command));
  assert.equal(recovered.id, replay.id, "reconciliation is exactly once");
  assert.equal(recovered.state, "recovery_pending");
  assert.equal(recovered.lines.length, 0, "historical items are not invented");
  await assert.rejects(
    run((tx) =>
      addRound(tx, s, recovered.id, {
        ...sale(1).order,
        expectedVersion: recovered.version,
      }),
    ),
    /stale_order/,
    "financial recovery cannot be reopened as a fulfillment order",
  );
  assert.deepEqual(recovered.recovery?.fulfillment, "pending");
  assert.deepEqual(recovered.recovery?.stock, "pending");
  const [evidence] =
    await admin`select r.*,t.source,t.source_id from offline_recoveries r join tenders t on t.tenant_id=r.tenant_id and t.id=r.tender_id where r.tenant_id=${tenantId} and r.operation_id=${recoverySale.operationId}`;
  assert.equal(evidence.original_employee_id, employeeId);
  assert.equal(evidence.original_drawer_id, drawerId);
  assert.equal(evidence.source, "offline_recovery");
  assert.equal(evidence.source_id, recoverySale.operationId);
  const cases = await run((tx) => listOfflineRecoveries(tx, s));
  const recoveryCase = cases.find(
    (c) => c.operation_id === recoverySale.operationId,
  )!;
  assert.equal(recoveryCase.tasks.length, 2);
  await completeAll(
    recoveryCase.tasks.map(async (task: any) => {
      const resolution = {
        operationId: randomUUID(),
        taskId: task.id,
        outcome: "already_completed" as const,
        reason: `Verified ${task.kind} against the paper log`,
      };
      const first = await run((tx) =>
        resolveOfflineRecoveryTask(tx, s, resolution),
      );
      const duplicate = await run((tx) =>
        resolveOfflineRecoveryTask(tx, s, resolution),
      );
      assert.deepEqual(
        first,
        duplicate,
        "task resolution replays exactly once",
      );
    }),
  );
  const [reviewedOrder] =
    await admin`select state from orders where tenant_id=${tenantId} and id=${recovered.id}`;
  assert.equal(reviewedOrder.state, "recovery_reviewed");
  const summary = await run((tx) => cashSummary(tx, s));
  assert.equal(summary?.closedExpected, 100);
  assert.equal(summary?.lateRecovery, 100);
  const historical = await run((tx) =>
    cashSummary(tx, { ...s, deviceId: randomUUID() }, drawerId),
  );
  assert.equal(
    historical?.lateRecovery,
    100,
    "manager can inspect the original drawer from a replacement device",
  );
  const history = await run((tx) => cashHistory(tx, s, 0));
  assert(
    history.some((row) => row.id === drawerId && row.late_recovery === 100),
  );
  await assert.rejects(
    run((tx) => cashHistory(tx, { ...s, role: "cashier" }, 0)),
    /forbidden/,
  );

  const refundDrawer = randomUUID();
  await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at) values(${tenantId},${refundDrawer},${deviceId},${employeeId},0,now()-interval '1 minute')`;
  const refunded = await run((tx) =>
    refund(tx, s, {
      operationId: randomUUID(),
      tenderId: evidence.tender_id,
      amount: 40,
      reason: "Recovery refund fixture",
      disposition: "no_stock_return",
    }),
  );
  assert.equal(refunded.refunded, 40);
  await assert.rejects(
    run((tx) =>
      refund(tx, s, {
        operationId: randomUUID(),
        tenderId: evidence.tender_id,
        amount: 61,
        reason: "Recovery refund exceeds",
        disposition: "no_stock_return",
      }),
    ),
    /refund_exceeds/,
  );

  // Race the actual close service against recognition, with evidence belonging
  // to this second drawer. Either serialization must reconcile to the same cash.
  const concurrentSale = { ...sale(2), cashSessionId: refundDrawer };
  await completeAll([
    run((tx) =>
      closeCash(tx, s, {
        operationId: randomUUID(),
        counted: 60,
        reason: "Concurrent recovery fixture",
      }),
    ),
    run((tx) =>
      reconcileOffline(tx, s, {
        sale: concurrentSale,
        reason: "Verified cash during drawer close",
        confirmed: true,
      }),
    ),
  ]);
  const concurrentSummary = await run((tx) => cashSummary(tx, s));
  assert.equal(concurrentSummary!.expected, 60);
  assert.equal(
    concurrentSummary!.closedExpected + concurrentSummary!.lateRecovery,
    60,
    "original close plus late corrections equals final cash under contention",
  );

  const lastDrawer = randomUUID();
  await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at) values(${tenantId},${lastDrawer},${deviceId},${employeeId},0,now()-interval '1 minute')`;
  const beforeClose = { ...sale(2), cashSessionId: lastDrawer };
  let closingStarted!: () => void, allowClose!: () => void;
  const started = new Promise<void>((resolve) => {
    closingStarted = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    allowClose = resolve;
  });
  const closing = run(async (tx) => {
    closingStarted();
    await proceed;
    return closeCash(tx, s, {
      operationId: randomUUID(),
      counted: 100,
      reason: "Recovery recognized before close acquired its lock",
    });
  });
  await started;
  try {
    await run((tx) =>
      reconcileOffline(tx, s, {
        sale: beforeClose,
        reason: "Verified cash before close acquired its lock",
        confirmed: true,
      }),
    );
  } finally {
    allowClose();
    await closing;
  }
  const closed = await closing;
  assert.equal(closed!.closedExpected, 100);
  assert.equal(
    closed!.lateRecovery,
    0,
    "transaction start time is not the drawer close time",
  );

  await assert.rejects(
    tenant(sql, "10000000-0000-4000-8000-000000000002", (tx) =>
      reviewOffline(
        tx,
        { ...s, tenantId: "10000000-0000-4000-8000-000000000002" },
        recoverySale,
      ),
    ),
    /offline_context_invalid/,
  );
  console.log(
    "Offline recovery DB passed: v1 compatibility, v2 lease evidence, exact sync/reconciliation replay, price conflict review, uncertain-payment status/retry, revoked-session manager recovery, closed-drawer late correction, durable kitchen/stock task resolution, tenant isolation and capped refund.",
  );
} finally {
  for (const table of [
    "refunds",
    "tender_allocations",
    "offline_recovery_tasks",
    "offline_recoveries",
    "tenders",
    "rounds",
    "order_lines",
    "jobs",
    "operations",
    "audit",
    "orders",
    "order_numbers",
    "cash_movements",
    "cash_sessions",
    "recipe_versions",
    "catalog",
    "sessions",
    "devices",
    "employees",
    "restaurant_entitlements",
  ])
    await admin.unsafe(`delete from ${table} where tenant_id=$1`, [tenantId]);
  await admin`delete from restaurants where id=${tenantId}`;
  await admin`delete from organizations where id=${organizationId}`;
  await sql.end();
  await admin.end();
}
