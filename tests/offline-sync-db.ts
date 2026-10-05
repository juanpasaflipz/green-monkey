import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { checkRole, connect, tenant } from "../server/db.js";
import { hash } from "../server/auth.js";
import {
  archiveOfflineRecord,
  listOfflineArchives,
  listOfflineRecoveries,
  listOfflineRecoveriesPage,
  reconcileOffline,
  reconcileOfflineRecord,
  reviewOfflineRecord,
  synchronizeOffline,
  syncOfflineRecord,
} from "../server/offline-sync.js";
import {
  decideOfflineKitchen,
  listOfflineKitchen,
} from "../server/offline-kitchen.js";
import { offlineDevicePrefix } from "../server/offline-device.js";
import { registerPreAuth } from "../server/routes/offline.js";
import { refreshOrderState } from "../server/voids.js";
import {
  addRound as addRoundOnline,
  createOrder,
  getOrder,
  recordPayment,
} from "../server/orders.js";
import { openOrdersSnapshot } from "../server/offline-tables.js";
import {
  readOfflineSettings,
  saveOfflineSettings,
} from "../server/offline-settings.js";
import { ZodError } from "zod";
import {
  businessDate,
  currencyExponent,
  type LineInput,
  type Session,
} from "../shared/domain.js";
import { offlineRecord } from "../shared/offline-recovery.js";

const { runtime, migration } = isolatedTarget(process.env),
  sql = connect(runtime),
  admin = postgres(migration, { max: 1 });
await checkRole(sql);

const organizationId = randomUUID(),
  tenantId = randomUUID(),
  otherOrganization = randomUUID(),
  otherTenant = randomUUID();
const ids = {
  cashier: randomUUID(),
  manager: randomUUID(),
  kitchen: randomUUID(),
  server: randomUUID(),
  device1: randomUUID(),
  device2: randomUUID(),
  drawer1: randomUUID(),
  drawer2: randomUUID(),
  plate: randomUUID(),
  drink: randomUUID(),
  stocked: randomUUID(),
  open: randomUUID(),
  stockItem: randomUUID(),
  otherEmployee: randomUUID(),
};
const restaurant = {
  name: "Offline sync fixture",
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
};
const run = <T>(fn: Parameters<typeof tenant<T>>[2]) =>
  tenant(sql, tenantId, fn);
let sequence = 0;

async function expectCode(
  promise: Promise<unknown>,
  code: string,
  message?: string,
) {
  await assert.rejects(promise, new RegExp(`\\b${code}\\b`), message);
}

/** Session row plus its offline lease, issued `issuedAgoMin` ago. */
async function openSession(
  employeeId: string,
  deviceId: string,
  role: string,
  opts: {
    issuedAgoMin?: number;
    validMin?: number;
    snapshot?: typeof restaurant;
    revoked?: boolean;
  } = {},
): Promise<Session> {
  const id = randomUUID();
  const issued = opts.issuedAgoMin ?? 240,
    valid = opts.validMin ?? 240;
  await admin`insert into sessions(tenant_id,id,employee_id,device_id,token_hash,csrf,expires_at,offline_until,selling_authorized,revoked)
    values(${tenantId},${id},${employeeId},${deviceId},${"fixture-" + id},'fixture',now()+interval '12 hours',now()+make_interval(mins=>${valid}),true,${opts.revoked ?? false})`;
  const [r] =
    await admin`select config_version from restaurants where id=${tenantId}`;
  await admin`insert into offline_leases(tenant_id,session_id,employee_id,device_id,contract_version,issued_at,valid_until,selling_authorized,plan,configuration_version,restaurant_snapshot)
    values(${tenantId},${id},${employeeId},${deviceId},1,now()-make_interval(mins=>${issued}),now()+make_interval(mins=>${valid}),true,'pro',${r.config_version},${admin.json(opts.snapshot ?? restaurant)})`;
  return {
    id,
    tenantId,
    employeeId,
    deviceId,
    name: role,
    role,
    expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
    offlineUntil: new Date(Date.now() + valid * 60_000).toISOString(),
    offlineLeaseVersion: 1,
    offlineLeaseConfigVersion: r.config_version,
    csrf: "fixture",
    restaurant: { ...restaurant, configVersion: r.config_version },
  };
}

const line = (
  productId: string,
  quantity = 1,
  extra: Partial<LineInput> = {},
) => ({
  id: randomUUID(),
  productId,
  quantity,
  options: [] as string[],
  note: "",
  ...extra,
});
const prices: Record<string, number> = {};

/** A v3 cash or external sale as the device would store it. */
function sale(
  s: Session,
  opts: {
    lines?: ReturnType<typeof line>[];
    total?: number;
    recordedAt?: string;
    drawer?: string;
    method?: "cash" | "external";
    tip?: number;
    reference?: string;
    provisional?: string;
    order?: Record<string, unknown>;
    configurationVersion?: number | null;
    productVersion?: number;
  } = {},
) {
  const lines = opts.lines ?? [line(ids.plate, 2), line(ids.drink)];
  const total =
    opts.total ??
    lines.reduce(
      (a, l) => a + (l.openAmount ?? prices[l.productId]!) * l.quantity,
      0,
    );
  const recordedAt = opts.recordedAt ?? new Date().toISOString();
  const tip = opts.tip ?? 0;
  const external = opts.method === "external";
  return {
    formatVersion: 3 as const,
    kind: "sale" as const,
    operationId: randomUUID(),
    tenantId,
    employeeId: s.employeeId,
    deviceId: s.deviceId,
    sessionId: s.id,
    lease: {
      contractVersion: 1,
      configurationVersion:
        opts.configurationVersion === undefined
          ? (s.offlineLeaseConfigVersion ?? null)
          : opts.configurationVersion,
    },
    currency: "MXN",
    currencyExponent: currencyExponent("MXN"),
    recordedAt,
    recordedAtDevice: recordedAt,
    clockOffsetMs: 0,
    sequence: ++sequence,
    provisionalNumber: opts.provisional ?? "B-01",
    kitchenDelivery: "device_list" as const,
    cashSessionId: opts.drawer ?? ids.drawer1,
    order: {
      operationId: randomUUID(),
      lines,
      mode: "takeaway" as const,
      tableId: null,
      name: "Offline v3",
      note: "",
      channel: "pos" as const,
      ...opts.order,
    },
    expectedTotal: total,
    payment: {
      method: external ? ("external" as const) : ("cash" as const),
      amount: total,
      tip,
      received: external ? total + tip : total + tip + 500,
      reference: opts.reference ?? (external ? "AUTH-123" : ""),
      externalConfirmed: external,
    },
    receiptSnapshot: {
      lines: lines.map((l) => ({
        ...l,
        productVersion: opts.productVersion ?? 1,
      })),
      restaurant,
    },
  };
}

async function count(table: string, where = "true", ...params: unknown[]) {
  const [row] = await admin.unsafe(
    `select count(*)::int as n from ${table} where tenant_id=$1 and ${where}`,
    [tenantId, ...params] as any[],
  );
  return row.n as number;
}

let s1: Session;
try {
  // Fixture: one Pro restaurant, two devices with drawers, four roles.
  await admin`insert into organizations(id,name) values(${organizationId},'Offline sync fixture'),(${otherOrganization},'Other tenant')`;
  await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,free_location) values(${tenantId},${organizationId},${restaurant.name},'MXN',${restaurant.timezone},240,true),(${otherTenant},${otherOrganization},'Other','MXN',${restaurant.timezone},240,true)`;
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source) values(${tenantId},'active',now()+interval '1 day','fixture')`;
  for (const [employee, role] of [
    [ids.cashier, "cashier"],
    [ids.manager, "manager"],
    [ids.kitchen, "kitchen"],
    [ids.server, "server"],
  ])
    await admin`insert into employees(tenant_id,id,name,login,secret_hash,role) values(${tenantId},${employee},${role},${randomUUID()},'fixture',${role})`;
  await admin`insert into employees(tenant_id,id,name,login,secret_hash,role) values(${otherTenant},${ids.otherEmployee},'other','other','fixture','owner')`;
  await admin`insert into devices(tenant_id,id,name,token_hash,free_slot) values(${tenantId},${ids.device1},'Caja 1','fixture',1),(${tenantId},${ids.device2},'Caja 2','fixture',null)`;
  await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at) values(${tenantId},${ids.drawer1},${ids.device1},${ids.cashier},0,now()-interval '5 hours')`;
  await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at) values(${tenantId},${ids.drawer2},${ids.device2},${ids.cashier},0,now()-interval '10 minutes')`;
  await admin`insert into stock_items(tenant_id,id,name,unit,kind) values(${tenantId},${ids.stockItem},'Tortilla','piece','raw')`;
  const product = (
    productId: string,
    name: string,
    price: number,
    station: string,
    extra: Record<string, unknown> = {},
  ) => {
    prices[productId] = price;
    return admin`insert into catalog(tenant_id,id,data) values(${tenantId},${productId},${admin.json(
      {
        id: productId,
        name: { es: name, en: name },
        category: { es: "Pruebas", en: "Tests" },
        price,
        available: true,
        station,
        groups: [],
        cost: null,
        recipe: [],
        version: 1,
        ...extra,
      },
    )})`;
  };
  await product(ids.plate, "Taco", 100, "kitchen");
  await product(ids.drink, "Agua", 50, "bar");
  await product(ids.stocked, "Taco con tortilla", 70, "kitchen", {
    recipe: [{ stockId: ids.stockItem, quantity: "2" }],
  });
  await product(ids.open, "Precio abierto", 0, "kitchen", { openAmount: true });
  s1 = await openSession(ids.cashier, ids.device1, "cashier");
  const manager1 = await openSession(ids.manager, ids.device1, "manager");
  const kitchen = await openSession(ids.kitchen, ids.device2, "kitchen");
  const server = await openSession(ids.server, ids.device2, "server");
  const s2 = await openSession(ids.cashier, ids.device2, "cashier");

  // 1. A v3 cash sale applies exactly once (I1, I11, I12, OFF-4).
  const first = sale(s1);
  const ordersBefore = await count("orders");
  const synced = await run((tx) => syncOfflineRecord(tx, s1, first));
  const replay = await run((tx) => syncOfflineRecord(tx, s1, first));
  assert.equal(replay.orderId, synced.orderId, "replay returns the same order");
  assert.equal(
    replay.tenderId,
    synced.tenderId,
    "replay returns the same tender",
  );
  assert.equal(await count("orders"), ordersBefore + 1, "exactly one order");
  assert.equal(await count("tenders", "order_id=$2", synced.orderId), 1);
  assert.equal(synced.kind, "sale");
  assert.equal(synced.provisionalNumber, "B-01");
  assert.equal(synced.kitchenReview, true);
  assert(synced.orderNumber > 0);
  const [created] =
    await admin`select channel,business_date::text as day,total from orders where tenant_id=${tenantId} and id=${synced.orderId}`;
  assert.equal(created.channel, "offline");
  assert.equal(created.total, 250);
  assert.equal(
    created.day,
    businessDate(synced.soldAt, restaurant.timezone, restaurant.cutoff),
  );
  const rounds =
    await admin`select r.state,k.state as review from rounds r left join offline_kitchen_reviews k on k.tenant_id=r.tenant_id and k.round_id=r.id where r.tenant_id=${tenantId} and r.order_id=${synced.orderId} order by r.station`;
  assert.deepEqual(
    rounds.map((r) => [r.state, r.review]),
    [
      ["offline_review", "pending"],
      ["offline_review", "pending"],
    ],
    "both stations wait in the review lane",
  );
  const [ledgerRow] =
    await admin`select * from offline_sync_records where tenant_id=${tenantId} and operation_id=${first.operationId}`;
  assert.equal(ledgerRow.provisional_number, "B-01");
  assert.equal(ledgerRow.kind, "sale");
  assert.equal(ledgerRow.path, "automatic");
  assert.equal(ledgerRow.tender_id, synced.tenderId);
  assert.equal(ledgerRow.amount, 250);
  assert.equal(ledgerRow.round_number, 1);
  const order = await run((tx) => getOrder(tx, synced.orderId));
  assert.equal(order.offline?.provisionalNumber, "B-01");
  assert.equal(order.offline?.soldAt, synced.soldAt);
  // I11: total equals the sum of line totals and tenders never exceed it.
  assert.equal(
    order.total,
    order.lines.reduce((a, l) => a + l.total, 0),
  );
  assert(order.paid <= order.total);

  // 2. External terminal sale keeps method, reference and tip.
  const external = sale(s1, {
    method: "external",
    tip: 20,
    reference: "AUTH-777",
  });
  const externalResult = await run((tx) => syncOfflineRecord(tx, s1, external));
  const [externalTender] =
    await admin`select method,external_reference,amount,tip,received from tenders where tenant_id=${tenantId} and id=${externalResult.tenderId}`;
  assert.deepEqual(
    { ...externalTender },
    {
      method: "external",
      external_reference: "AUTH-777",
      amount: 250,
      tip: 20,
      received: 270,
    },
  );

  // 3. Business date comes from the validated sale time, not sync time (I12).
  const local = new Date().toLocaleString("en-US", {
    timeZone: restaurant.timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const [hh, mm] = local.split(":").map(Number);
  const cutoff = ((((hh! % 24) * 60 + mm! - 60) % 1440) + 1440) % 1440;
  const dated = await openSession(ids.cashier, ids.device1, "cashier", {
    snapshot: { ...restaurant, cutoff },
  });
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  const late = await run((tx) =>
    syncOfflineRecord(tx, dated, sale(dated, { recordedAt: twoHoursAgo })),
  );
  const expectedDay = businessDate(twoHoursAgo, restaurant.timezone, cutoff);
  assert.notEqual(
    expectedDay,
    businessDate(new Date().toISOString(), restaurant.timezone, cutoff),
    "fixture puts the sale on the previous business day",
  );
  assert.equal(late.businessDate, expectedDay);
  const [lateOrder] =
    await admin`select business_date::text as day from orders where tenant_id=${tenantId} and id=${late.orderId}`;
  assert.equal(lateOrder.day, expectedDay);

  // 4. Clock tolerance (OFF-8 case 1): 90 s ahead syncs and is clamped; 5 min
  // ahead is retried later; 4 min before the drawer opened is clamped; 6 min
  // before is outside the lease window.
  const ahead = await run((tx) =>
    syncOfflineRecord(
      tx,
      s1,
      sale(s1, { recordedAt: new Date(Date.now() + 90_000).toISOString() }),
    ),
  );
  assert(
    Date.parse(ahead.soldAt) <= Date.now() + 1000,
    "clamped to server now",
  );
  const future = sale(s1, {
    recordedAt: new Date(Date.now() + 300_000).toISOString(),
  });
  const beforeFuture = await count("orders");
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s1, future)),
    "offline_recorded_in_future",
  );
  assert.equal(
    await count("orders"),
    beforeFuture,
    "nothing partially applied",
  );
  const [drawer2] =
    await admin`select opened_at from cash_sessions where tenant_id=${tenantId} and id=${ids.drawer2}`;
  const early = await run((tx) =>
    syncOfflineRecord(
      tx,
      s2,
      sale(s2, {
        drawer: ids.drawer2,
        recordedAt: new Date(
          drawer2.opened_at.getTime() - 240_000,
        ).toISOString(),
      }),
    ),
  );
  assert.equal(early.soldAt, drawer2.opened_at.toISOString());
  await expectCode(
    run((tx) =>
      syncOfflineRecord(
        tx,
        s2,
        sale(s2, {
          drawer: ids.drawer2,
          recordedAt: new Date(
            drawer2.opened_at.getTime() - 360_000,
          ).toISOString(),
        }),
      ),
    ),
    "offline_outside_lease",
  );

  // 5. Config cited from the lease (OFF-8 case 2): a live settings change
  // blocks auto-sync, but the evidence stays authentic and reconcilable.
  await admin`update restaurants set config_version=config_version+1 where id=${tenantId}`;
  const changed = sale(s1);
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s1, changed)),
    "settings_changed",
  );
  const changedReview = await run((tx) =>
    reviewOfflineRecord(tx, manager1, changed),
  );
  assert.equal(changedReview.authentic, true);
  assert.deepEqual(changedReview.problems, ["settings_changed"]);
  assert.equal(changedReview.reconcilable, true);
  const reconciled = await run((tx) =>
    reconcileOfflineRecord(tx, manager1, {
      record: changed,
      reason: "Settings changed during the outage; cash verified",
      confirmed: true,
    }),
  );
  assert.equal(reconciled.state, "recovery_pending");
  const [recoveryTender] =
    await admin`select session_id,source,source_id from tenders where tenant_id=${tenantId} and order_id=${reconciled.id}`;
  assert.equal(recoveryTender.session_id, ids.drawer1, "original drawer");
  assert.equal(recoveryTender.source, "offline_recovery");
  // Reconcile and sync share one identity: a later sync replays the result.
  const afterReconcile = await run((tx) => syncOfflineRecord(tx, s1, changed));
  assert.equal(afterReconcile.orderId, reconciled.id);
  await admin`update restaurants set config_version=config_version-1 where id=${tenantId}`;

  // 6. Unverifiable evidence: sync refuses, review explains without
  // throwing, reconcile refuses, archive always works.
  const unverifiable = sale(s1, { drawer: randomUUID() });
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s1, unverifiable)),
    "offline_evidence_invalid",
  );
  const unverifiableReview = await run((tx) =>
    reviewOfflineRecord(tx, manager1, unverifiable),
  );
  assert.equal(unverifiableReview.authentic, false);
  assert.equal(unverifiableReview.reconcilable, false);
  await expectCode(
    run((tx) =>
      reconcileOfflineRecord(tx, manager1, {
        record: unverifiable,
        reason: "Trying to reconcile unverifiable evidence",
        confirmed: true,
      }),
    ),
    "offline_evidence_invalid",
  );
  const archiveCommand = {
    operationId: randomUUID(),
    record: unverifiable,
    localError: "offline_evidence_invalid",
    reason: "Drawer cannot be verified; sale entered on paper",
    confirmed: true,
  };
  const archived = await run((tx) =>
    archiveOfflineRecord(tx, manager1, archiveCommand),
  );
  assert.equal(archived.operationId, unverifiable.operationId);
  const [archiveRow] =
    await admin`select * from offline_archives where tenant_id=${tenantId} and operation_id=${unverifiable.operationId}`;
  assert.equal(archiveRow.evidence_valid, true);
  assert.equal(archiveRow.amount, 250);
  assert.equal(archiveRow.claimed_drawer_id, unverifiable.cashSessionId);
  assert.equal(archiveRow.actor_id, ids.manager);
  assert.match(archiveRow.evidence_hash, /^[0-9a-f]{64}$/);

  // 7. Archive semantics (I1, I10).
  const replayedArchive = await run((tx) =>
    archiveOfflineRecord(tx, manager1, archiveCommand),
  );
  assert.deepEqual(replayedArchive, archived, "same command replays");
  const secondDialog = await run((tx) =>
    archiveOfflineRecord(tx, manager1, {
      ...archiveCommand,
      operationId: randomUUID(),
    }),
  );
  assert.equal(secondDialog.id, archived.id, "same evidence, same archive");
  await expectCode(
    run((tx) =>
      archiveOfflineRecord(tx, manager1, {
        ...archiveCommand,
        operationId: randomUUID(),
        record: { ...unverifiable, expectedTotal: 1 },
      }),
    ),
    "operation_conflict",
  );
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s1, unverifiable)),
    "offline_evidence_invalid",
  );
  const authenticArchived = sale(s1);
  await run((tx) =>
    archiveOfflineRecord(tx, manager1, {
      operationId: randomUUID(),
      record: authenticArchived,
      localError: null,
      reason: "Already entered online by the manager",
      confirmed: true,
    }),
  );
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s1, authenticArchived)),
    "offline_archived",
  );
  await expectCode(
    run((tx) =>
      reconcileOfflineRecord(tx, manager1, {
        record: authenticArchived,
        reason: "Reconcile after archive must fail",
        confirmed: true,
      }),
    ),
    "offline_archived",
  );
  await expectCode(
    run((tx) =>
      archiveOfflineRecord(tx, manager1, {
        operationId: randomUUID(),
        record: first,
        localError: null,
        reason: "Archive after a successful sync",
        confirmed: true,
      }),
    ),
    "offline_already_synced",
  );
  const garbage = await run((tx) =>
    archiveOfflineRecord(tx, manager1, {
      operationId: randomUUID(),
      record: {
        operationId: randomUUID(),
        expectedTotal: 990,
        tip: -5,
        kind: "sale",
      },
      localError: "invalid_input",
      reason: "Corrupted local record from an old tablet",
      confirmed: true,
    }),
  );
  const [garbageRow] =
    await admin`select evidence_valid,amount,tip,kind from offline_archives where tenant_id=${tenantId} and id=${garbage.id}`;
  assert.deepEqual(
    { ...garbageRow },
    { evidence_valid: false, amount: 990, tip: 0, kind: "sale" },
  );
  await expectCode(
    run((tx) =>
      archiveOfflineRecord(tx, manager1, {
        operationId: randomUUID(),
        record: { ...sale(s1), tenantId: otherTenant },
        localError: null,
        reason: "Evidence from another restaurant",
        confirmed: true,
      }),
    ),
    "forbidden",
  );
  await expectCode(
    run((tx) =>
      archiveOfflineRecord(tx, s1, {
        operationId: randomUUID(),
        record: sale(s1),
        localError: null,
        reason: "Cashiers cannot archive evidence",
        confirmed: true,
      }),
    ),
    "forbidden",
  );

  // 8. Concurrent sync and archive of one record: exactly one wins (I1).
  for (let i = 0; i < 4; i++) {
    const raced = sale(s1);
    const outcomes = await Promise.allSettled([
      run((tx) => syncOfflineRecord(tx, s1, raced)),
      run((tx) =>
        archiveOfflineRecord(tx, manager1, {
          operationId: randomUUID(),
          record: raced,
          localError: null,
          reason: "Concurrent archive race fixture",
          confirmed: true,
        }),
      ),
    ]);
    const won = outcomes.filter((o) => o.status === "fulfilled").length;
    assert.equal(won, 1, "exactly one of sync or archive wins");
    const reasons = outcomes
      .filter((o): o is PromiseRejectedResult => o.status === "rejected")
      .map((o) => String(o.reason?.message ?? o.reason));
    assert(
      reasons.every((r) =>
        ["offline_archived", "offline_already_synced"].includes(r),
      ),
      reasons.join(","),
    );
    assert.equal(
      (await count(
        "offline_sync_records",
        "operation_id=$2",
        raced.operationId,
      )) +
        (await count("offline_archives", "operation_id=$2", raced.operationId)),
      1,
    );
  }
  const doubled = sale(s1);
  const both = await Promise.all([
    run((tx) => syncOfflineRecord(tx, s1, doubled)),
    run((tx) => syncOfflineRecord(tx, s1, doubled)),
  ]);
  assert.equal(both[0].tenderId, both[1].tenderId);
  assert.equal(await count("tenders", "order_id=$2", both[0].orderId), 1);

  // 9. An online create that committed with a lost response is reused, and
  // the kitchen (which already saw it) is not asked again.
  const onlineDraft = {
    operationId: randomUUID(),
    lines: [line(ids.plate)],
    mode: "takeaway" as const,
    tableId: null,
    name: "Lost response",
    note: "",
    channel: "pos" as const,
  };
  const online = await run((tx) => createOrder(tx, s1, onlineDraft));
  const reuse = sale(s1, { lines: onlineDraft.lines, order: onlineDraft });
  const reused = await run((tx) => syncOfflineRecord(tx, s1, reuse));
  assert.equal(reused.orderId, online.id);
  assert.equal(reused.reusedOnlineOrder, true);
  assert.equal(reused.kitchenReview, false);
  assert.equal(
    await count(
      "offline_kitchen_reviews",
      "operation_id=$2",
      reuse.operationId,
    ),
    0,
  );
  const [onlineRound] =
    await admin`select state from rounds where tenant_id=${tenantId} and order_id=${online.id}`;
  assert.equal(onlineRound.state, "active");
  assert.equal(
    (await run((tx) => getOrder(tx, online.id))).paid,
    100,
    "the sale paid the reused order once",
  );
  // A different draft under the same order id is a conflict, not a merge.
  const changedLines = [line(ids.plate, 3)];
  await expectCode(
    run((tx) =>
      syncOfflineRecord(
        tx,
        s1,
        sale(s1, {
          lines: changedLines,
          order: { ...onlineDraft, lines: changedLines },
        }),
      ),
    ),
    "offline_order_already_exists",
  );
  // I2: the reused order is already paid, so a second offline sale of it
  // exceeds the due amount and is never applied.
  const paidAgain = sale(s1, { lines: onlineDraft.lines, order: onlineDraft });
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s1, paidAgain)),
    "offline_payment_exceeds_due",
  );
  assert.equal(await count("tenders", "order_id=$2", online.id), 1);
  // OFF-R20 (I3 on reuse): the device priced the same draft below the server
  // (a stale catalog). Reusing the online order would record the device's
  // amount as a partial payment and leave an unexplained balance: it is a
  // price conflict for a manager, and no tender is recorded.
  const cheaperDraft = {
    ...onlineDraft,
    operationId: randomUUID(),
    lines: [line(ids.plate)],
    name: "Lost response, stale price",
  };
  const pricedOnline = await run((tx) => createOrder(tx, s1, cheaperDraft));
  assert.equal(pricedOnline.total, 100);
  const stalePrice = sale(s1, {
    lines: cheaperDraft.lines,
    order: cheaperDraft,
    total: 90,
  });
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s1, stalePrice)),
    "price_conflict",
  );
  assert.equal(await count("tenders", "order_id=$2", pricedOnline.id), 0);
  assert.equal(
    await count(
      "offline_sync_records",
      "operation_id=$2",
      stalePrice.operationId,
    ),
    0,
  );
  // The same evidence at the server's price reuses the order and pays it once.
  const fair = await run((tx) =>
    syncOfflineRecord(
      tx,
      s1,
      sale(s1, { lines: cheaperDraft.lines, order: cheaperDraft }),
    ),
  );
  assert.equal(fair.orderId, pricedOnline.id);
  assert.equal(fair.reusedOnlineOrder, true);
  assert.equal(fair.order.paid, 100);

  // 10. A sale that physically happened may take stock negative.
  await expectCode(
    run((tx) =>
      createOrder(tx, s1, {
        ...onlineDraft,
        operationId: randomUUID(),
        lines: [line(ids.stocked)],
      }),
    ),
    "insufficient_stock",
    "online orders still refuse negative stock",
  );
  await run((tx) =>
    syncOfflineRecord(tx, s1, sale(s1, { lines: [line(ids.stocked, 3)] })),
  );
  const [balance] =
    await admin`select coalesce(sum(quantity),0)::text as qty from stock_movements where tenant_id=${tenantId} and stock_id=${ids.stockItem}`;
  assert.equal(Number(balance.qty), -6);

  // 11. Server repricing is authoritative (I3); open price is valid evidence (D11).
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s1, sale(s1, { total: 999 }))),
    "price_conflict",
  );
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s1, sale(s1, { productVersion: 0 }))),
    "offline_catalog_changed",
  );
  // Sync quotes with canOpen=true. Until menu (025) merges, createOrder still
  // applies its role rule, so the fixture sale is a manager's.
  const openPrice = await run((tx) =>
    syncOfflineRecord(
      tx,
      manager1,
      sale(manager1, { lines: [line(ids.open, 1, { openAmount: 333 })] }),
    ),
  );
  assert.equal(openPrice.order.total, 333);

  // 12. Money auto-applies only to the device's open drawer (I4); a manager
  // records it to the original drawer even after that drawer closed.
  const closingDrawer = randomUUID();
  const s3 = await openSession(ids.cashier, ids.device2, "cashier");
  const manager2 = await openSession(ids.manager, ids.device2, "manager");
  await admin`update cash_sessions set closed_at=now(),counted=0,expected=0 where tenant_id=${tenantId} and id=${ids.drawer2}`;
  await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at) values(${tenantId},${closingDrawer},${ids.device2},${ids.cashier},0,now())`;
  const oldDrawer = sale(s3, {
    drawer: ids.drawer2,
    recordedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s3, oldDrawer)),
    "offline_drawer_conflict",
  );
  const oldDrawerReview = await run((tx) =>
    reviewOfflineRecord(tx, manager2, oldDrawer),
  );
  assert.equal(oldDrawerReview.reconcilable, true);
  assert.equal(oldDrawerReview.drawerClosed, true);
  const lateCash = await run((tx) =>
    reconcileOfflineRecord(tx, manager2, {
      record: oldDrawer,
      reason: "Cash verified in the closed drawer envelope",
      confirmed: true,
    }),
  );
  const [lateTender] =
    await admin`select session_id from tenders where tenant_id=${tenantId} and order_id=${lateCash.id}`;
  assert.equal(lateTender.session_id, ids.drawer2);

  // 13. Kitchen review lane decisions (I7, OFF-4).
  const lane = await run((tx) => listOfflineKitchen(tx, kitchen));
  const mine = lane.items.filter((item) => item.orderId === synced.orderId);
  assert.equal(mine.length, 2);
  assert.equal(mine[0]!.provisionalNumber, "B-01");
  assert.equal(mine[0]!.orderNumber, synced.orderNumber);
  assert.equal(mine[0]!.kitchenDelivery, "device_list");
  assert.equal(mine[0]!.deviceName, "Caja 1");
  assert(mine.every((item) => item.lines.length === 1));
  const cashierView = await run((tx) => listOfflineKitchen(tx, s1));
  assert(cashierView.items.length >= 2, "cashiers can see the lane");
  const plateRound = mine.find((item) => item.station === "kitchen")!;
  const drinkRound = mine.find((item) => item.station === "bar")!;
  await expectCode(
    run((tx) =>
      decideOfflineKitchen(tx, server, plateRound.roundId, {
        operationId: randomUUID(),
        decision: "prepare",
      }),
    ),
    "forbidden",
  );
  await expectCode(
    run((tx) =>
      decideOfflineKitchen(tx, s1, plateRound.roundId, {
        operationId: randomUUID(),
        decision: "already_served",
      }),
    ),
    "forbidden",
  );
  // A pending void ticket on the served round is acknowledged with it.
  const [plateLine] =
    await admin`select id from order_lines where tenant_id=${tenantId} and order_id=${synced.orderId} and data->>'station'='kitchen'`;
  const voidId = randomUUID();
  await admin`insert into line_voids(tenant_id,id,order_id,line_id,units,amount,reason,stock_disposition,preparation_state,actor_id,approver_id,kitchen_ack_required)
    values(${tenantId},${voidId},${synced.orderId},${plateLine.id},'{1}',100,'fixture void','not_returned','offline_review',${ids.manager},${ids.manager},true)`;
  const served = {
    operationId: randomUUID(),
    decision: "already_served" as const,
  };
  const decision = await run((tx) =>
    decideOfflineKitchen(tx, server, plateRound.roundId, served),
  );
  assert.deepEqual(
    { state: decision.state, alreadyDecided: decision.alreadyDecided },
    { state: "completed", alreadyDecided: false },
  );
  assert.equal(
    decision.orderState,
    "active",
    "the other round still waits in review, so the order stays active",
  );
  assert.deepEqual(
    await run((tx) =>
      decideOfflineKitchen(tx, server, plateRound.roundId, served),
    ),
    decision,
    "a retried decision replays",
  );
  const [ack] =
    await admin`select kitchen_acknowledged_by from line_voids where tenant_id=${tenantId} and id=${voidId}`;
  assert.equal(ack.kitchen_acknowledged_by, ids.server);
  const second = await run((tx) =>
    decideOfflineKitchen(tx, kitchen, plateRound.roundId, {
      operationId: randomUUID(),
      decision: "prepare",
    }),
  );
  assert.equal(second.alreadyDecided, true, "first decision wins");
  assert.equal(second.state, "completed");
  const prepared = await run((tx) =>
    decideOfflineKitchen(tx, kitchen, drinkRound.roundId, {
      operationId: randomUUID(),
      decision: "prepare",
    }),
  );
  assert.equal(prepared.state, "active");
  assert.equal(prepared.orderState, "active");
  const [review] =
    await admin`select state,decided_by from offline_kitchen_reviews where tenant_id=${tenantId} and round_id=${drinkRound.roundId}`;
  assert.deepEqual(
    { ...review },
    { state: "prepare", decided_by: ids.kitchen },
  );
  assert(
    !(await run((tx) => listOfflineKitchen(tx, kitchen))).items.some(
      (item) => item.orderId === synced.orderId,
    ),
    "decided rounds leave the lane",
  );
  // refreshOrderState: a round in review keeps the order active, never "ready".
  const reviewOrder = await run((tx) =>
    syncOfflineRecord(
      tx,
      s1,
      sale(s1, { lines: [line(ids.plate), line(ids.drink)] }),
    ),
  );
  const [reviewRound] =
    await admin`select id from rounds where tenant_id=${tenantId} and order_id=${reviewOrder.orderId} and station='bar'`;
  await admin`update rounds set state='ready' where tenant_id=${tenantId} and id=${reviewRound.id}`;
  await run((tx) => refreshOrderState(tx, reviewOrder.orderId));
  const [stillActive] =
    await admin`select state from orders where tenant_id=${tenantId} and id=${reviewOrder.orderId}`;
  assert.equal(stillActive.state, "active");

  // 14. Device prefixes are unique under concurrency and immutable.
  const prefixes = await Promise.all([
    run((tx) => offlineDevicePrefix(tx, s1)),
    run((tx) => offlineDevicePrefix(tx, s2)),
    run((tx) => offlineDevicePrefix(tx, s1)),
    run((tx) => offlineDevicePrefix(tx, s2)),
  ]);
  assert.equal(prefixes[0].prefix, prefixes[2].prefix);
  assert.equal(prefixes[1].prefix, prefixes[3].prefix);
  assert.notEqual(prefixes[0].prefix, prefixes[1].prefix);
  assert.deepEqual(new Set(prefixes.map((p) => p.prefix)), new Set(["A", "B"]));
  await assert.rejects(
    admin`update devices set offline_prefix='C' where tenant_id=${tenantId} and id=${ids.device1}`,
    /offline_prefix_immutable/,
  );
  await assert.rejects(
    admin`update devices set offline_prefix='Z' where tenant_id=${tenantId} and id=${ids.device1}`,
    /offline_prefix_immutable|check/,
  );

  // 15. Revoked sessions need a manager; an ended session of the same
  // employee and device still auto-syncs (contract D6).
  const revoked = await openSession(ids.cashier, ids.device1, "cashier", {
    revoked: true,
  });
  const revokedSale = sale(revoked);
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s1, revokedSale)),
    "offline_conflict",
  );
  assert.equal(
    (await run((tx) => reviewOfflineRecord(tx, manager1, revokedSale)))
      .reconcilable,
    true,
  );
  await run((tx) =>
    reconcileOfflineRecord(tx, manager1, {
      record: revokedSale,
      reason: "Deactivated cashier's verified offline cash",
      confirmed: true,
    }),
  );
  const ended = await openSession(ids.cashier, ids.device1, "cashier");
  const endedSale = sale(ended);
  assert.equal(
    (await run((tx) => syncOfflineRecord(tx, s1, endedSale))).kind,
    "sale",
    "the same person on the same device syncs an earlier session's sale",
  );
  await expectCode(
    run((tx) => syncOfflineRecord(tx, manager1, sale(s1))),
    "offline_conflict",
    "another employee never auto-syncs someone else's evidence",
  );

  // 16. Legacy wrapper: v2 bodies return an Order and legacy codes.
  const v2 = {
    operationId: randomUUID(),
    formatVersion: 2 as const,
    order: {
      operationId: randomUUID(),
      lines: [line(ids.plate)],
      mode: "takeaway" as const,
      tableId: null,
      name: "Legacy",
      note: "",
      channel: "pos" as const,
    },
    expectedTotal: 100,
    received: 100,
    tip: 0,
    recordedAt: new Date().toISOString(),
    sessionId: s1.id,
    cashSessionId: ids.drawer1,
    tenantId,
    employeeId: s1.employeeId,
    deviceId: s1.deviceId,
    leaseVersion: 1,
    currency: "MXN",
    currencyExponent: 2,
    configurationVersion: s1.offlineLeaseConfigVersion ?? null,
  };
  const legacyOrder = await run((tx) => synchronizeOffline(tx, s1, v2));
  assert.equal(legacyOrder.paid, 100);
  assert.equal(
    (await run((tx) => syncOfflineRecord(tx, s1, v2))).orderId,
    legacyOrder.id,
    "the new route replays a record first synced by the legacy route",
  );
  await expectCode(
    run((tx) =>
      synchronizeOffline(tx, s1, {
        ...v2,
        operationId: randomUUID(),
        cashSessionId: randomUUID(),
      }),
    ),
    "offline_context_invalid",
  );
  await expectCode(
    run((tx) =>
      reconcileOffline(tx, manager1, {
        sale: { ...v2, operationId: randomUUID(), cashSessionId: randomUUID() },
        reason: "Legacy reconcile of unverifiable cash",
        confirmed: true,
      }),
    ),
    "offline_context_invalid",
  );
  // A result stored by the pre-v3 server (a plain Order) is normalized.
  const stored = { ...v2, operationId: randomUUID() };
  const storedOrder = await run((tx) => getOrder(tx, legacyOrder.id));
  await run(
    (tx) =>
      tx`insert into operations(tenant_id,id,kind,hash,result) values(${tenantId},${stored.operationId},'offline_sync',${hash(JSON.stringify(offlineRecord.parse(stored)))},${tx.json(storedOrder as any)})`,
  );
  const normalized = await run((tx) => syncOfflineRecord(tx, s1, stored));
  assert.equal(normalized.kind, "sale");
  assert.equal(normalized.orderId, legacyOrder.id);
  assert.equal(normalized.order.id, legacyOrder.id);

  // 17. RLS and grants on the new tables.
  const crossTenant = await tenant(sql, otherTenant, (tx) =>
    Promise.all(
      [
        "offline_sync_records",
        "offline_archives",
        "offline_kitchen_reviews",
      ].map(
        async (table) =>
          (await tx.unsafe(`select count(*)::int as n from ${table}`))[0]!.n,
      ),
    ),
  );
  assert.deepEqual(crossTenant, [0, 0, 0], "tenant B sees none of A's rows");
  await assert.rejects(
    tenant(
      sql,
      otherTenant,
      (tx) =>
        tx`insert into offline_archives(tenant_id,id,operation_id,command_id,evidence,evidence_hash,evidence_valid,amount,tip,reason,actor_id)
          values(${tenantId},${randomUUID()},${randomUUID()},${randomUUID()},'{}',${"0".repeat(64)},false,0,0,'cross tenant insert',${ids.manager})`,
    ),
    /row-level security/,
  );
  for (const statement of [
    `update offline_sync_records set amount=0`,
    `delete from offline_sync_records`,
    `update offline_archives set amount=0`,
    `delete from offline_archives`,
    `delete from offline_kitchen_reviews`,
    `update offline_kitchen_reviews set operation_id=operation_id`,
  ])
    await assert.rejects(
      run((tx) => tx.unsafe(statement)),
      /permission denied/,
      statement,
    );
  await assert.rejects(
    run(
      (tx) =>
        tx`update offline_kitchen_reviews set state='prepare',decided_by=${ids.kitchen},decided_at=now() where round_id=${plateRound.roundId}`,
    ),
    /offline_kitchen_review_immutable/,
    "a decided review cannot be decided again",
  );
  await assert.rejects(
    admin`update offline_sync_records set amount=0 where tenant_id=${tenantId}`,
    /offline_evidence_immutable/,
  );
  await assert.rejects(
    admin`update offline_archives set reason='edited reason here' where tenant_id=${tenantId}`,
    /offline_evidence_immutable/,
  );

  // 18. Paginated recoveries and archives are stable keyset pages.
  for (let i = 0; i < 3; i++)
    await run((tx) =>
      archiveOfflineRecord(tx, manager1, {
        operationId: randomUUID(),
        record: sale(s1),
        localError: null,
        reason: `Pagination fixture archive ${i}`,
        confirmed: true,
      }),
    );
  const pageAll = async (
    fn: (
      tx: any,
      s: Session,
      q: unknown,
    ) => Promise<{ items: { id: string }[]; nextCursor: string | null }>,
  ) => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await run((tx) =>
        fn(tx, manager1, { limit: "2", ...(cursor ? { cursor } : {}) }),
      );
      assert(page.items.length <= 2);
      seen.push(...page.items.map((item) => item.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return seen;
  };
  const archivedIds = await pageAll(listOfflineArchives);
  const [{ n: archiveCount }] =
    await admin`select count(*)::int as n from offline_archives where tenant_id=${tenantId}`;
  assert.equal(archivedIds.length, archiveCount);
  assert.equal(new Set(archivedIds).size, archivedIds.length, "no duplicates");
  const recoveryIds = await pageAll(listOfflineRecoveriesPage);
  const legacy = await run((tx) => listOfflineRecoveries(tx, manager1));
  assert.deepEqual(
    recoveryIds,
    legacy.map((r) => r.id),
    "pages concatenate to the full newest-first list",
  );
  assert(recoveryIds.length >= 3);
  await assert.rejects(
    run((tx) => listOfflineArchives(tx, manager1, { cursor: "nonsense" })),
  );
  await expectCode(
    run((tx) => listOfflineArchives(tx, s1, {})),
    "forbidden",
  );

  // 19. A payment past the balance never auto-applies, even under recordPayment.
  await assert.rejects(
    run((tx) =>
      recordPayment(tx, s1, synced.orderId, {
        operationId: randomUUID(),
        amount: 1,
        tip: 0,
        received: 1,
        method: "cash",
      }),
    ),
    /overpayment/,
  );

  // 21. Offline table service (feat(offline-tables)): orders, rounds and
  // payments that depend on each other (I5), additive rounds, closed targets
  // (I6), balance revalidation (I2) and totals (I11).
  const priced = (lines: ReturnType<typeof line>[]) =>
    lines.reduce(
      (a, l) => a + (l.openAmount ?? prices[l.productId]!) * l.quantity,
      0,
    );
  const v3 = (s: Session, kind: string, fields: Record<string, unknown>) => {
    const at = new Date().toISOString();
    return {
      formatVersion: 3 as const,
      operationId: randomUUID(),
      tenantId,
      employeeId: s.employeeId,
      deviceId: s.deviceId,
      sessionId: s.id,
      lease: {
        contractVersion: 1,
        configurationVersion: s.offlineLeaseConfigVersion ?? null,
      },
      currency: "MXN",
      currencyExponent: 2,
      recordedAt: at,
      recordedAtDevice: at,
      clockOffsetMs: 0,
      sequence: ++sequence,
      provisionalNumber: null as string | null,
      kitchenDelivery: "device_list" as const,
      kind,
      ...fields,
    };
  };
  const snapshotOf = (lines: ReturnType<typeof line>[]) => ({
    lines: lines.map((l) => ({ ...l, productVersion: 1 })),
    restaurant,
  });
  const orderRecord = (s: Session, lines: ReturnType<typeof line>[]) =>
    v3(s, "order", {
      provisionalNumber: "C-01",
      cashSessionId: null,
      order: {
        operationId: randomUUID(),
        lines,
        mode: "dine_in",
        tableId: null,
        name: "Mesa sin conexión",
        note: "",
        channel: "pos",
      },
      expectedTotal: priced(lines),
      receiptSnapshot: snapshotOf(lines),
    });
  const roundRecord = (
    s: Session,
    target: Record<string, string>,
    lines: ReturnType<typeof line>[],
  ) =>
    v3(s, "round", {
      cashSessionId: null,
      target,
      lines,
      expectedTotal: priced(lines),
      receiptSnapshot: snapshotOf(lines),
    });
  const paymentRecord = (
    s: Session,
    target: Record<string, string>,
    amount: number,
    drawer = ids.drawer1,
  ) =>
    v3(s, "payment", {
      kitchenDelivery: "not_applicable",
      cashSessionId: drawer,
      target,
      expectedDue: amount,
      payment: {
        method: "cash",
        amount,
        tip: 0,
        received: amount,
        reference: "",
        externalConfirmed: false,
      },
    });
  const table = orderRecord(s1, [line(ids.plate, 2)]);
  const localTarget = { localOrderOperationId: table.operationId };
  const tableRound = roundRecord(s1, localTarget, [line(ids.drink)]);
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s1, tableRound)),
    "offline_dependency_pending",
    "a round never applies before its order",
  );
  const opened = await run((tx) => syncOfflineRecord(tx, s1, table));
  assert.equal(opened.kind, "order");
  assert.equal(opened.tenderId, null);
  assert.equal(opened.kitchenReview, true);
  const added = await run((tx) => syncOfflineRecord(tx, s1, tableRound));
  assert.equal(added.orderId, opened.orderId, "never re-targeted");
  assert.equal(added.roundNumber, 2);
  assert.equal(added.kitchenReview, true);
  const partial = paymentRecord(s1, localTarget, 120);
  const rest = paymentRecord(s1, localTarget, 130);
  await run((tx) => syncOfflineRecord(tx, s1, partial));
  await run((tx) => syncOfflineRecord(tx, s1, partial));
  const settled = await run((tx) => syncOfflineRecord(tx, s1, rest));
  assert.equal(settled.order.total, 250);
  assert.equal(settled.order.paid, 250);
  assert.equal(await count("tenders", "order_id=$2", opened.orderId), 2);
  assert.equal(
    await count(
      "offline_kitchen_reviews k",
      "exists(select 1 from rounds r where r.tenant_id=k.tenant_id and r.id=k.round_id and r.order_id=$2)",
      opened.orderId,
    ),
    2,
    "both offline rounds wait in the review lane",
  );
  // I11: total equals line totals; tenders never exceed it.
  assert.equal(
    settled.order.total,
    settled.order.lines.reduce((a, l) => a + l.total, 0),
  );
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s1, paymentRecord(s1, localTarget, 1))),
    "offline_payment_exceeds_due",
    "a paid order never takes another offline payment",
  );

  // An archived parent: dependents never apply; the money is still reconcilable.
  const lost = orderRecord(s1, [line(ids.plate)]);
  await run((tx) =>
    archiveOfflineRecord(tx, manager1, {
      operationId: randomUUID(),
      record: lost,
      localError: null,
      reason: "Order entered again on paper before the outage ended",
      confirmed: true,
    }),
  );
  const orphan = paymentRecord(
    s1,
    { localOrderOperationId: lost.operationId },
    100,
  );
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s1, orphan)),
    "offline_dependency_archived",
  );
  const orphanReview = await run((tx) =>
    reviewOfflineRecord(tx, manager1, orphan),
  );
  assert.equal(orphanReview.target, null);
  assert.equal(orphanReview.reconcilable, true);
  const orphanCash = await run((tx) =>
    reconcileOfflineRecord(tx, manager1, {
      record: orphan,
      reason: "Cash for an archived order counted in the drawer",
      confirmed: true,
    }),
  );
  assert.equal(orphanCash.state, "recovery_pending");
  assert.equal(orphanCash.paid, 100);

  // OFF-R1 (shift change): a payment whose original order record is still
  // queued is never reconciled. Recording it now would leave the money in a
  // recovery order while the real order later syncs unpaid: revenue twice and
  // a balance the guest already paid.
  const queuedTable = orderRecord(s1, [line(ids.plate)]);
  const queuedPayment = paymentRecord(
    s1,
    { localOrderOperationId: queuedTable.operationId },
    40,
  );
  const queuedReview = await run((tx) =>
    reviewOfflineRecord(tx, manager1, queuedPayment),
  );
  assert.equal(queuedReview.authentic, true);
  assert.equal(queuedReview.target, null);
  assert.equal(queuedReview.reconcilable, false, "parent still queued");
  assert(queuedReview.problems.includes("offline_dependency_pending"));
  const recoveriesBefore = await count("offline_recoveries");
  const tendersBefore = await count("tenders");
  await expectCode(
    run((tx) =>
      reconcileOfflineRecord(tx, manager1, {
        record: queuedPayment,
        reason: "Shift change before the table order synced",
        confirmed: true,
      }),
    ),
    "offline_dependency_pending",
  );
  assert.equal(await count("offline_recoveries"), recoveriesBefore);
  assert.equal(await count("tenders"), tendersBefore, "no money recorded");
  assert.equal(
    await count("operations", "id=$2", queuedPayment.operationId),
    0,
    "the payment can still sync or reconcile later",
  );
  // Once its order syncs, the same payment reconciles into that order, once.
  const queuedOpened = await run((tx) =>
    syncOfflineRecord(tx, s1, queuedTable),
  );
  const queuedReady = await run((tx) =>
    reviewOfflineRecord(tx, manager1, queuedPayment),
  );
  assert.equal(queuedReady.reconcilable, true);
  assert.equal(queuedReady.target?.orderId, queuedOpened.orderId);
  // OFF-R10: a reconcile into an order waits for a drawer close in progress
  // (which holds the drawer row), so the close either counts the tender or
  // happens first and the tender is a late adjustment; never a lost tender.
  let releaseDrawer!: () => void;
  const drawerHeld = new Promise<void>((resolve) => (releaseDrawer = resolve));
  let drawerLocked!: () => void;
  const locked = new Promise<void>((resolve) => (drawerLocked = resolve));
  const closing = admin.begin(async (a) => {
    await a`select id from cash_sessions where tenant_id=${tenantId} and id=${ids.drawer1} for update`;
    drawerLocked();
    await drawerHeld;
  });
  await locked;
  await assert.rejects(
    run(async (tx) => {
      await tx`set local lock_timeout = '300ms'`;
      return reconcileOfflineRecord(tx, manager1, {
        record: queuedPayment,
        reason: "Shift change; cash counted for the table",
        confirmed: true,
      });
    }),
    /lock timeout/,
    "waits for the drawer row",
  );
  releaseDrawer();
  await closing;
  assert.equal(
    await count("tenders", "order_id=$2", queuedOpened.orderId),
    0,
    "nothing recorded while it waited",
  );
  const intoOrder = await run((tx) =>
    reconcileOfflineRecord(tx, manager1, {
      record: queuedPayment,
      reason: "Shift change; cash counted for the table",
      confirmed: true,
    }),
  );
  assert.equal(intoOrder.id, queuedOpened.orderId, "into the real order");
  assert.equal(intoOrder.paid, 40);
  assert(!intoOrder.state.startsWith("recovery"));
  const replayed = await run((tx) => syncOfflineRecord(tx, s1, queuedPayment));
  assert.equal(replayed.orderId, queuedOpened.orderId);
  assert.equal(
    await count("tenders", "order_id=$2", queuedOpened.orderId),
    1,
    "a later automatic sync replays, never a second tender",
  );
  assert.equal(await count("offline_recoveries"), recoveriesBefore);

  // Rounds on a onlineOrder order are additive; a cancelled order is closed (I6).
  const onlineOrder = await run((tx) =>
    createOrder(tx, s1, {
      operationId: randomUUID(),
      lines: [line(ids.plate)],
      mode: "dine_in",
      tableId: null,
      name: "Mesa en línea",
      note: "",
      channel: "pos",
    }),
  );
  const cachedRound = roundRecord(s1, { orderId: onlineOrder.id }, [
    line(ids.drink),
  ]);
  await run((tx) =>
    addRoundOnline(tx, s1, onlineOrder.id, {
      operationId: randomUUID(),
      lines: [line(ids.plate)],
      mode: "dine_in",
      tableId: null,
      name: "Mesa en línea",
      note: "",
      channel: "pos",
      expectedVersion: onlineOrder.version,
    }),
  );
  const extended = await run((tx) => syncOfflineRecord(tx, s1, cachedRound));
  assert.equal(extended.roundNumber, 3, "applied after the online round");
  assert.equal(extended.order.total, 250);
  const cancelled = await run((tx) =>
    createOrder(tx, s1, {
      operationId: randomUUID(),
      lines: [line(ids.plate)],
      mode: "takeaway",
      tableId: null,
      name: "Cancelada",
      note: "",
      channel: "pos",
    }),
  );
  await admin`update orders set state='cancelled' where tenant_id=${tenantId} and id=${cancelled.id}`;
  await expectCode(
    run((tx) =>
      syncOfflineRecord(
        tx,
        s1,
        roundRecord(s1, { orderId: cancelled.id }, [line(ids.drink)]),
      ),
    ),
    "offline_order_closed",
  );
  await expectCode(
    run((tx) =>
      syncOfflineRecord(
        tx,
        s1,
        paymentRecord(s1, { orderId: cancelled.id }, 50),
      ),
    ),
    "offline_order_closed",
  );
  // OFF-R21: an online round send committed but its response was lost, so the
  // draft kept its line ids and the offline round carries the same ones. They
  // can never be inserted again (order_lines primary key): the record reaches
  // a manager as a domain conflict, never a 500 retried forever.
  const twinOrder = await run((tx) =>
    createOrder(tx, s1, {
      operationId: randomUUID(),
      lines: [line(ids.plate)],
      mode: "dine_in",
      tableId: null,
      name: "Ronda con respuesta perdida",
      note: "",
      channel: "pos",
    }),
  );
  const sentLines = [line(ids.drink)];
  await run((tx) =>
    addRoundOnline(tx, s1, twinOrder.id, {
      operationId: randomUUID(),
      lines: sentLines,
      mode: "dine_in",
      tableId: null,
      name: "Ronda con respuesta perdida",
      note: "",
      channel: "pos",
      expectedVersion: twinOrder.version,
    }),
  );
  const twin = roundRecord(s1, { orderId: twinOrder.id }, sentLines);
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s1, twin)),
    "offline_lines_already_sent",
  );
  assert.equal(
    await count("order_lines", "order_id=$2", twinOrder.id),
    2,
    "nothing appended twice",
  );
  const twinReview = await run((tx) => reviewOfflineRecord(tx, manager1, twin));
  assert.equal(twinReview.authentic, true, "review explains, never throws");
  // An order record whose lines were already recorded is refused the same way.
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s1, orderRecord(s1, sentLines))),
    "offline_lines_already_sent",
  );

  // A payment past the onlineOrder balance is refused and cannot be reconciled (I2).
  await run((tx) =>
    recordPayment(tx, s1, onlineOrder.id, {
      operationId: randomUUID(),
      amount: 200,
      tip: 0,
      received: 200,
      method: "cash",
    }),
  );
  const tooMuch = paymentRecord(s1, { orderId: onlineOrder.id }, 100);
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s1, tooMuch)),
    "offline_payment_exceeds_due",
  );
  const tooMuchReview = await run((tx) =>
    reviewOfflineRecord(tx, manager1, tooMuch),
  );
  assert.equal(tooMuchReview.target?.due, 50);
  assert.equal(tooMuchReview.reconcilable, false);
  await expectCode(
    run((tx) =>
      reconcileOfflineRecord(tx, manager1, {
        record: tooMuch,
        reason: "Trying to reconcile more than the balance",
        confirmed: true,
      }),
    ),
    "offline_payment_exceeds_due",
  );
  await expectCode(
    run((tx) =>
      reconcileOfflineRecord(tx, manager1, {
        record: roundRecord(s1, { orderId: cancelled.id }, [line(ids.drink)]),
        reason: "Rounds carry no money to reconcile",
        confirmed: true,
      }),
    ),
    "offline_reconcile_unsupported",
  );
  // OFF-R1: a fully paid order never takes a reconciled payment (I2): the
  // guest already paid, so the manager archives instead.
  const paidTab = await run((tx) =>
    createOrder(tx, s1, {
      operationId: randomUUID(),
      lines: [line(ids.plate)],
      mode: "dine_in",
      tableId: null,
      name: "Pagada en línea",
      note: "",
      channel: "pos",
    }),
  );
  await run((tx) =>
    recordPayment(tx, s1, paidTab.id, {
      operationId: randomUUID(),
      amount: paidTab.total,
      tip: 0,
      received: paidTab.total,
      method: "cash",
    }),
  );
  const paidTwice = paymentRecord(s1, { orderId: paidTab.id }, paidTab.total);
  const paidTwiceReview = await run((tx) =>
    reviewOfflineRecord(tx, manager1, paidTwice),
  );
  assert.equal(paidTwiceReview.target?.due, 0);
  assert.equal(paidTwiceReview.reconcilable, false);
  assert(paidTwiceReview.problems.includes("offline_payment_exceeds_due"));
  await expectCode(
    run((tx) =>
      reconcileOfflineRecord(tx, manager1, {
        record: paidTwice,
        reason: "Paid online and offline for the same table",
        confirmed: true,
      }),
    ),
    "offline_payment_exceeds_due",
  );
  assert.equal(await count("tenders", "order_id=$2", paidTab.id), 1);
  // §2.3 / §4.4.2: a round made against a stale copy of a check that is now
  // paid never reopens it; it goes to a manager.
  const paidTabTotal = paidTab.total;
  await expectCode(
    run((tx) =>
      syncOfflineRecord(
        tx,
        s1,
        roundRecord(s1, { orderId: paidTab.id }, [line(ids.drink)]),
      ),
    ),
    "offline_order_closed",
  );
  assert.equal(
    (await run((tx) => getOrder(tx, paidTab.id))).total,
    paidTabTotal,
    "the paid check keeps its total",
  );
  // A cancelled order can never hold the money: financial-only recovery.
  const cancelledCash = paymentRecord(s1, { orderId: cancelled.id }, 50);
  const cancelledReview = await run((tx) =>
    reviewOfflineRecord(tx, manager1, cancelledCash),
  );
  assert.equal(cancelledReview.target, null);
  assert.equal(cancelledReview.reconcilable, true);
  assert(cancelledReview.problems.includes("offline_order_closed"));
  const cancelledRecovery = await run((tx) =>
    reconcileOfflineRecord(tx, manager1, {
      record: cancelledCash,
      reason: "Cash for a table cancelled on another device",
      confirmed: true,
    }),
  );
  assert.equal(cancelledRecovery.state, "recovery_pending");
  assert.equal(cancelledRecovery.paid, 50);
  assert.equal(await count("tenders", "order_id=$2", cancelled.id), 0);
  // Reconciling a record that already synced replays its result (I1).
  assert.equal(
    (
      await run((tx) =>
        reconcileOfflineRecord(tx, manager1, {
          record: rest,
          reason: "Second attempt on an already synced payment",
          confirmed: true,
        }),
      )
    ).id,
    opened.orderId,
  );
  assert.equal(await count("tenders", "order_id=$2", opened.orderId), 2);

  // Manager reconcile of a payment records it in the original, closed drawer;
  // the order stays a normal, serviceable order (no recovery record).
  const device3 = randomUUID(),
    drawer3 = randomUUID(),
    drawer4 = randomUUID();
  await admin`insert into devices(tenant_id,id,name,token_hash) values(${tenantId},${device3},'Caja 3','fixture')`;
  await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at) values(${tenantId},${drawer3},${device3},${ids.cashier},0,now()-interval '1 hour')`;
  const s4 = await openSession(ids.cashier, device3, "cashier");
  const manager4 = await openSession(ids.manager, device3, "manager");
  const tab = await run((tx) =>
    createOrder(tx, s4, {
      operationId: randomUUID(),
      lines: [line(ids.plate)],
      mode: "dine_in",
      tableId: null,
      name: "Mesa del cajón cerrado",
      note: "",
      channel: "pos",
    }),
  );
  const latePayment = paymentRecord(s4, { orderId: tab.id }, 100, drawer3);
  await admin`update cash_sessions set closed_at=now(),counted=0,expected=0 where tenant_id=${tenantId} and id=${drawer3}`;
  await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at) values(${tenantId},${drawer4},${device3},${ids.cashier},0,now())`;
  await expectCode(
    run((tx) => syncOfflineRecord(tx, s4, latePayment)),
    "offline_drawer_conflict",
  );
  const paidLate = await run((tx) =>
    reconcileOfflineRecord(tx, manager4, {
      record: latePayment,
      reason: "Cash for the table counted in the closed drawer",
      confirmed: true,
    }),
  );
  assert.equal(paidLate.id, tab.id, "same order");
  assert.equal(paidLate.paid, 100);
  assert(!paidLate.state.startsWith("recovery"));
  const [lateTender2] =
    await admin`select session_id,source,source_id from tenders where tenant_id=${tenantId} and order_id=${tab.id}`;
  assert.deepEqual(
    { ...lateTender2 },
    {
      session_id: drawer3,
      source: "offline_recovery",
      source_id: latePayment.operationId,
    },
  );
  const [managerLedger] =
    await admin`select path,reason,actor_id from offline_sync_records where tenant_id=${tenantId} and operation_id=${latePayment.operationId}`;
  assert.equal(managerLedger.path, "manager");
  assert.equal(managerLedger.actor_id, ids.manager);
  assert.equal(
    await count(
      "offline_recoveries",
      "operation_id=$2",
      latePayment.operationId,
    ),
    0,
  );
  const stillServiceable = await run((tx) =>
    addRoundOnline(tx, s4, tab.id, {
      operationId: randomUUID(),
      lines: [line(ids.drink)],
      mode: "dine_in",
      tableId: null,
      name: "Mesa del cajón cerrado",
      note: "",
      channel: "pos",
      expectedVersion: paidLate.version,
    }),
  );
  assert.equal(stillServiceable.total, 150);

  // 22. LD-7: offline table service is a per-restaurant beta, OFF by default.
  // Every table record above synced with it off: sync never consults the
  // setting, because a record saved while it was on is a real sale.
  assert.deepEqual(await run((tx) => readOfflineSettings(tx, s1)), {
    tableService: false,
  });
  // With it off no device fetches the open-orders snapshot (GAP-4).
  await expectCode(
    run((tx) => openOrdersSnapshot(tx, s1)),
    "offline_table_service_off",
  );
  const settingsCommand = { operationId: randomUUID(), tableService: true };
  await expectCode(
    run((tx) => saveOfflineSettings(tx, s1, settingsCommand)),
    "forbidden",
    "a cashier cannot turn it on",
  );
  await expectCode(
    run((tx) => saveOfflineSettings(tx, server, settingsCommand)),
    "forbidden",
  );
  await expectCode(
    run((tx) => readOfflineSettings(tx, kitchen)),
    "forbidden",
  );
  const auditsBefore = await count(
    "audit",
    "operation='offline.settings_changed'",
  );
  assert.deepEqual(
    await run((tx) => saveOfflineSettings(tx, manager1, settingsCommand)),
    { tableService: true },
  );
  // A replay (or a second save of the same value) changes and audits nothing.
  await run((tx) => saveOfflineSettings(tx, manager1, settingsCommand));
  assert.equal(
    await count("audit", "operation='offline.settings_changed'"),
    auditsBefore + 1,
  );
  const [settingAudit] =
    await admin`select actor_id,detail from audit where tenant_id=${tenantId} and operation='offline.settings_changed'`;
  assert.equal(settingAudit.actor_id, ids.manager);
  assert.deepEqual(settingAudit.detail.before, { tableService: false });
  assert.deepEqual(settingAudit.detail.after, { tableService: true });
  assert.deepEqual(await run((tx) => readOfflineSettings(tx, s1)), {
    tableService: true,
  });
  const [otherSetting] =
    await admin`select offline_table_service from restaurants where id=${otherTenant}`;
  assert.equal(otherSetting.offline_table_service, false, "per restaurant");
  await assert.rejects(
    run((tx) =>
      saveOfflineSettings(tx, manager1, {
        operationId: randomUUID(),
        tableService: "yes",
      }),
    ),
    ZodError,
  );

  // Open-orders snapshot: excludes cancelled and recovery orders, includes
  // completed-but-unpaid ones and excludes completed-and-paid ones.
  const delivered = await run((tx) =>
    createOrder(tx, s1, {
      operationId: randomUUID(),
      lines: [line(ids.plate)],
      mode: "dine_in",
      tableId: null,
      name: "Entregada sin pagar",
      note: "",
      channel: "pos",
    }),
  );
  await admin`update orders set state='completed' where tenant_id=${tenantId} and id in (${delivered.id},${onlineOrder.id})`;
  const snapshot = await run((tx) => openOrdersSnapshot(tx, s1));
  const listed = new Set(snapshot.orders.map((o) => o.id));
  assert(listed.has(delivered.id), "completed but unpaid");
  assert(listed.has(opened.orderId), "active offline table order");
  assert(!listed.has(cancelled.id), "cancelled");
  assert(!listed.has(orphanCash.id), "recovery");
  assert(listed.has(onlineOrder.id), "completed with a balance left");
  const deliveredView = snapshot.orders.find((o) => o.id === delivered.id)!;
  assert.equal(deliveredView.lines.length, 1);
  assert.equal(deliveredView.total - deliveredView.paid, 100);
  assert.deepEqual(deliveredView.tenderIds, []);
  assert.deepEqual(deliveredView.offlineOperationIds, []);
  assert(snapshot.orders.length <= 200);
  // OFF-R3: each copy lists exactly the tenders and offline records it already
  // contains, so a device never counts its own synced rows twice.
  const tableView = snapshot.orders.find((o) => o.id === opened.orderId)!;
  assert.equal(tableView.tenderIds.length, 2);
  assert.deepEqual(
    new Set(tableView.offlineOperationIds),
    new Set([
      table.operationId,
      tableRound.operationId,
      partial.operationId,
      rest.operationId,
    ]),
  );

  // 20. Heartbeat: no auth, no-store, single-flight DB check.
  const app = express();
  registerPreAuth({ app, sql });
  let selects = 0;
  const slow = Object.assign(() => {
    selects++;
    return new Promise((resolve) => setTimeout(() => resolve([]), 150));
  }, {}) as unknown as postgres.Sql;
  const slowApp = express();
  registerPreAuth({ app: slowApp, sql: slow });
  const down = postgres("postgres://nobody:nothing@127.0.0.1:1/none", {
    connect_timeout: 1,
    max: 1,
  });
  const downApp = express();
  registerPreAuth({ app: downApp, sql: down });
  const listen = (handler: express.Express) =>
    new Promise<{ url: string; close: () => void }>((resolve) => {
      const server = handler.listen(0, "127.0.0.1", () =>
        resolve({
          url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          close: () => server.close(),
        }),
      );
    });
  const [up, slowServer, downServer] = await Promise.all([
    listen(app),
    listen(slowApp),
    listen(downApp),
  ]);
  try {
    const ping = await fetch(up.url + "/api/offline/ping");
    assert.equal(ping.status, 200);
    assert.equal(ping.headers.get("cache-control"), "no-store");
    const body = await ping.json();
    assert.equal(body.ok, true);
    assert(Math.abs(body.now - Date.now()) < 5000);
    assert.equal(typeof body.build, "string");
    const pings = await Promise.all(
      Array.from({ length: 50 }, () =>
        fetch(slowServer.url + "/api/offline/ping").then((r) => r.status),
      ),
    );
    assert(pings.every((status) => status === 200));
    assert.equal(selects, 1, "at most one select in flight for 50 pings");
    const failed = await fetch(downServer.url + "/api/offline/ping");
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error, "database_unavailable");
  } finally {
    up.close();
    slowServer.close();
    downServer.close();
    await down.end({ timeout: 1 }).catch(() => {});
  }

  console.log(
    "Offline sync DB passed: exactly-once v3 sale (cash and external), business date from sale time, clock tolerance and clamping, lease-cited config, authenticity vs eligibility, archive semantics and races, lost-response reuse (only at the server's price), overpayment refusal, negative stock, server repricing, drawer guard and late reconcile, kitchen review lane and decisions, device prefixes, revoked vs ended sessions, legacy compatibility, RLS, grants, immutability, pagination, the heartbeat and offline table service (dependencies, additive rounds, closed targets, balance revalidation, payment reconcile, lines already sent online, rounds on paid checks, open-orders snapshot) and the LD-7 setting (off by default, managers only, audited once, gates the snapshot, never sync).",
  );
} finally {
  for (const table of [
    "offline_kitchen_reviews",
    "offline_sync_records",
    "offline_archives",
    "line_voids",
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
    "stock_movements",
    "stock_items",
    "recipe_versions",
    "catalog",
    "offline_leases",
    "sessions",
    "devices",
    "employees",
    "restaurant_entitlements",
  ])
    for (const id of [tenantId, otherTenant])
      await admin.unsafe(`delete from ${table} where tenant_id=$1`, [id]);
  await admin`delete from restaurants where id in (${tenantId},${otherTenant})`;
  await admin`delete from organizations where id in (${organizationId},${otherOrganization})`;
  await sql.end();
  await admin.end();
}
