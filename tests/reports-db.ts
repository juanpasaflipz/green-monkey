// Reports (029) DB suite: migration 029 (versioned business-day settings, business_date_at,
// report print records), the read-only snapshot, and the report statements that read wave-1
// tables only (collections S3, paid-outs S5, the tender list, the employee/hour/channel/mode
// breakdowns, the activity log and the filters). The statements that need fiscal (027) and
// discounts (028) are covered here once those merge (docs/REPORTS.md "Merge wiring").
// Runs against an isolated target (tests/isolated-target.ts), like tests/voids-db.ts.
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { Temporal } from "@js-temporal/polyfill";
import { checkRole, connect, tenant, type Tx } from "../server/db.js";
import { createOrder, recordPayment } from "../server/orders.js";
import { saveSettings, getSettings } from "../server/restaurant.js";
import { recordPaidOut } from "../server/operations.js";
import { snapshotTenant } from "../server/reports/snapshot.js";
import { collectionDays, paidOutDays } from "../server/reports/summary.js";
import { tenderRows } from "../server/reports/lists.js";
import {
  employeeRows,
  groupBreakdown,
  hourBreakdown,
} from "../server/reports/breakdowns.js";
import { auditLog } from "../server/reports/audit-log.js";
import { reportFilters } from "../server/reports/filters.js";
import { salesSummary } from "../server/reports/summary.js";
import { breakdown } from "../server/reports/breakdowns.js";
import { orderRows } from "../server/reports/lists.js";
import { exceptionRows } from "../server/reports/exceptions.js";
import { drawerList } from "../server/reports/drawers.js";
import {
  closeDrawerRemotely,
  dayCorte,
  drawerCorte,
  printDayCorte,
  printDrawerCorte,
} from "../server/reports/cortes.js";
import { todaySummary } from "../server/reports/today.js";
import { legacyDailyReport } from "../server/reports/legacy.js";
import type { ReportsPorts } from "../server/reports/ports.js";
import { restaurantOf } from "../server/reports/restaurant.js";
import { windowOf } from "../server/reports/days.js";
import { businessDate, type Session } from "../shared/domain.js";
import { addDays, wallClockBusinessDate } from "../shared/reports.js";
import { isolatedTarget } from "./isolated-target.js";
import { removeTenants } from "./fixtures/reports-cleanup.js";

const { runtime: url, migration } = isolatedTarget(process.env);
const sql = connect(url),
  admin = postgres(migration, { max: 3 });
await checkRole(sql);

const run = Date.now().toString(36);
const organizationId = randomUUID();
const A = randomUUID(); // America/Mexico_City, cutoff 04:00, MXN
const B = randomUUID(); // America/Tijuana, cutoff 00:00 (DST)
const C = randomUUID(); // USD, Free plan, selling blocked
const ids = {
  owner: randomUUID(),
  manager: randomUUID(),
  cashier: randomUUID(),
  server: randomUUID(),
  kitchen: randomUUID(),
  ownerB: randomUUID(),
  ownerC: randomUUID(),
  device1: randomUUID(),
  device2: randomUUID(),
  deviceB: randomUUID(),
  deviceC: randomUUID(),
  drawer1: randomUUID(),
  drawer2: randomUUID(),
  drawerB: randomUUID(),
  taco: randomUUID(),
  agua: randomUUID(),
  tacoB: randomUUID(),
};
const settingsA = {
  name: "Taquería Ficticia A " + run,
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
};
const settingsB = {
  name: "Ficticia B " + run,
  currency: "MXN",
  timezone: "America/Tijuana",
  cutoff: 0,
};
const settingsC = {
  name: "Ficticia C " + run,
  currency: "USD",
  timezone: "America/Mexico_City",
  cutoff: 240,
};
const session = (
  tenantId: string,
  employeeId: string,
  role: string,
  deviceId: string,
  restaurant: Session["restaurant"],
): Session => ({
  id: randomUUID(),
  tenantId,
  employeeId,
  name: role,
  role,
  deviceId,
  expiresAt: "",
  offlineUntil: "",
  csrf: "",
  restaurant: { ...restaurant },
});
const owner = session(A, ids.owner, "owner", ids.device1, settingsA);
const manager = session(A, ids.manager, "manager", ids.device1, settingsA);
const cashier = session(A, ids.cashier, "cashier", ids.device1, settingsA);
const server = session(A, ids.server, "server", ids.device2, settingsA);
const kitchen = session(A, ids.kitchen, "kitchen", ids.device2, settingsA);
const ownerB = session(B, ids.ownerB, "owner", ids.deviceB, settingsB);
const ownerC = session(C, ids.ownerC, "owner", ids.deviceC, settingsC);

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (e: any) => {
    assert.equal(e.code ?? e.message, code, String(e.message));
    return true;
  });
}
const write = <T>(s: Session, fn: (tx: Tx) => Promise<T>) =>
  tenant(sql, s.tenantId, fn);
const read = <T>(s: Session, fn: (tx: Tx) => Promise<T>) =>
  snapshotTenant(sql, s.tenantId, fn);
/** An instant at local wall-clock `time` on `date` in `zone`, ISO. */
const at = (date: string, time: string, zone: string) =>
  Temporal.PlainDateTime.from(`${date}T${time}`)
    .toZonedDateTime(zone)
    .toInstant()
    .toString();

async function newOrder(
  s: Session,
  lines: { productId: string; quantity: number }[],
  extra: Record<string, unknown> = {},
) {
  return write(s, (tx) =>
    createOrder(tx, s, {
      operationId: randomUUID(),
      lines: lines.map((l) => ({
        id: randomUUID(),
        options: [],
        note: "",
        ...l,
      })),
      mode: "takeaway",
      tableId: null,
      name: "Reportes",
      note: "",
      channel: "pos",
      ...extra,
    }),
  );
}
async function pay(
  s: Session,
  orderId: string,
  amount: number,
  method: "cash" | "external" = "cash",
  tip = 0,
) {
  return write(s, (tx) =>
    recordPayment(tx, s, orderId, {
      operationId: randomUUID(),
      amount,
      tip,
      received: method === "cash" ? amount + tip : 0,
      method,
      externalConfirmed: method === "external",
      reference: method === "external" ? "AUT-" + run : "",
    }),
  );
}
/** Rows inserted by the owner connection inside the tenant scope (fixture clock cases). */
async function asOwner(tenantId: string, fn: (tx: any) => Promise<unknown>) {
  await admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    await fn(tx);
  });
}

try {
  // ---- Fixture: three fictional restaurants (A Pro, B Pro, C Free with selling blocked).
  await admin`insert into organizations(id,name) values(${organizationId},${"Reportes ficticios " + run})`;
  await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,free_location)
    values (${A},${organizationId},${settingsA.name},'MXN',${settingsA.timezone},${settingsA.cutoff},false),
           (${B},${organizationId},${settingsB.name},'MXN',${settingsB.timezone},${settingsB.cutoff},false),
           (${C},${organizationId},${settingsC.name},'USD',${settingsC.timezone},${settingsC.cutoff},false)`;
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source)
    values (${A},'active',now()+interval '1 day','fixture'),(${B},'active',now()+interval '1 day','fixture')`;
  for (const [tenantId, employee, role, name] of [
    [A, ids.owner, "owner", "Olga Dueña"],
    [A, ids.manager, "manager", "Marisol Vega"],
    [A, ids.cashier, "cashier", "Carlos Caja"],
    [A, ids.server, "server", "Sara Mesera"],
    [A, ids.kitchen, "kitchen", "Kiko Cocina"],
    [B, ids.ownerB, "owner", "Beto Dueño"],
    [C, ids.ownerC, "owner", "Cata Dueña"],
  ])
    await admin`insert into employees(tenant_id,id,name,login,secret_hash,role)
      values(${tenantId},${employee},${name},${"r" + randomUUID().slice(0, 12)},'fixture',${role})`;
  await admin`insert into devices(tenant_id,id,name,token_hash,free_slot)
    values (${A},${ids.device1},'Caja mostrador','fixture',1),(${A},${ids.device2},'Barra','fixture',null),
           (${B},${ids.deviceB},'Caja B','fixture',1),(${C},${ids.deviceC},'Caja C','fixture',null)`;
  await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at)
    values (${A},${ids.drawer1},${ids.device1},${ids.cashier},100000,now()-interval '2 hours'),
           (${A},${ids.drawer2},${ids.device2},${ids.server},50000,now()-interval '1 hour'),
           (${B},${ids.drawerB},${ids.deviceB},${ids.ownerB},0,now()-interval '1 hour')`;
  const product = (
    tenantId: string,
    productId: string,
    name: string,
    price: number,
    station: string,
  ) =>
    admin`insert into catalog(tenant_id,id,data) values(${tenantId},${productId},${admin.json(
      {
        id: productId,
        name: { es: name, en: name },
        category: { es: "Pruebas", en: "Tests" },
        price,
        available: true,
        station,
        groups: [],
        cost: 1500,
        recipe: [],
        version: 1,
      },
    )})`;
  await product(A, ids.taco, "Taco ficticio", 4500, "kitchen");
  await product(A, ids.agua, "Agua ficticia", 3000, "bar");
  await product(B, ids.tacoB, "Taco B", 2000, "kitchen");

  await test("1. FIN-04/DB-7: the SQL day formula and business_date_at equal JS businessDate for 10,000 instants across cutoffs 0, 240 and 1439, Mexico City and Tijuana DST transitions, month and year ends and 2028-02-29", async () => {
    const zones = ["America/Mexico_City", "America/Tijuana"];
    const cutoffs = [0, 240, 1439];
    const anchors = [
      "2026-03-08T09:30:00Z", // Tijuana spring forward
      "2026-11-01T08:30:00Z", // Tijuana fall back (repeated 01:00)
      "2026-04-05T07:59:59.999Z",
      "2026-12-31T23:59:59Z",
      "2027-01-01T06:00:00Z",
      "2028-02-29T05:59:00Z",
      "2026-01-31T10:00:00Z",
    ];
    let seed = 20261005;
    const random = () =>
      (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const instants: string[] = [];
    const zoneList: string[] = [];
    const cutoffList: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      const base = Date.parse(anchors[i % anchors.length]);
      // Within ±3 days of an anchor, minute and millisecond precision.
      const instant = new Date(
        base + Math.floor((random() - 0.5) * 6 * 86_400_000),
      ).toISOString();
      instants.push(instant);
      zoneList.push(zones[i % 2]);
      cutoffList.push(cutoffs[Math.floor(i / 2) % 3]);
    }
    const rows = await admin<{ d: string }[]>`
      select ((x.t at time zone x.z) - make_interval(mins => x.c))::date::text as d
        from unnest(${instants}::timestamptz[], ${zoneList}::text[], ${cutoffList}::int[]) with ordinality as x(t, z, c, k)
       order by x.k`;
    rows.forEach((r, i) => {
      const expected = businessDate(instants[i], zoneList[i], cutoffList[i]);
      assert.equal(
        r.d,
        expected,
        `${instants[i]} ${zoneList[i]} ${cutoffList[i]}`,
      );
      assert.equal(
        wallClockBusinessDate(instants[i], zoneList[i], cutoffList[i]),
        expected,
      );
    });
    // business_date_at for a restaurant without history (B: Tijuana, cutoff 0), as gm_app.
    const tijuana = instants
      .filter((_, i) => zoneList[i] === "America/Tijuana")
      .slice(0, 2_000);
    const viaFunction = await write(
      ownerB,
      (tx) =>
        tx<{ d: string }[]>`select business_date_at(${B}::uuid, t)::text as d
        from unnest(${tijuana}::timestamptz[]) with ordinality as x(t, k) order by k`,
    );
    viaFunction.forEach((r, i) =>
      assert.equal(
        r.d,
        businessDate(tijuana[i], "America/Tijuana", 0),
        tijuana[i],
      ),
    );
    // The repeated 01:00 hour of 2026-11-01 is one business date and one wall-clock hour.
    const [repeated] = await write(
      ownerB,
      (tx) => tx<{ a: string; b: string; ha: number; hb: number }[]>`
      select business_date_at(${B}::uuid, '2026-11-01T08:30:00Z')::text as a,
             business_date_at(${B}::uuid, '2026-11-01T09:30:00Z')::text as b,
             extract(hour from business_local_at(${B}::uuid, '2026-11-01T08:30:00Z'))::int as ha,
             extract(hour from business_local_at(${B}::uuid, '2026-11-01T09:30:00Z'))::int as hb`,
    );
    assert.deepEqual(repeated, {
      a: "2026-11-01",
      b: "2026-11-01",
      ha: 1,
      hb: 1,
    });
  });

  await test("4. business_day_settings and report_prints are INSERT-only for gm_app, immutable for the owner role by trigger, tenant-isolated, and business_date_at is NULL without a tenant", async () => {
    for (const statement of [
      `update business_day_settings set cutoff = 0`,
      `delete from business_day_settings`,
      `update report_prints set print_number = 1`,
      `delete from report_prints`,
    ])
      await rejects(
        write(owner, (tx) => tx.unsafe(statement)),
        "42501", // permission denied: no UPDATE or DELETE grant
      );
    // Without app.tenant_id a non-superuser sees no settings rows: NULL, never another tenant's day.
    const [none] = await sql`select business_date_at(${A}::uuid, now()) as d`;
    assert.equal(none.d, null);
    const [own] = await write(
      owner,
      (tx) => tx`select business_date_at(${A}::uuid, now())::text as d`,
    );
    assert.equal(
      own.d,
      businessDate(
        new Date().toISOString(),
        settingsA.timezone,
        settingsA.cutoff,
      ),
    );
    // The owner role is stopped by the immutability triggers (superuser fixture role here).
    await asOwner(
      A,
      (tx) =>
        tx`insert into business_day_settings(tenant_id,valid_until,timezone,cutoff)
         values(${A},'2020-01-01T00:00:00Z','America/Mexico_City',240)`,
    );
    await rejects(
      asOwner(
        A,
        (tx) =>
          tx`update business_day_settings set cutoff = 0 where tenant_id = ${A}`,
      ),
      "23001",
    );
    await rejects(
      asOwner(
        A,
        (tx) => tx`delete from business_day_settings where tenant_id = ${A}`,
      ),
      "23001",
    );
    await rejects(
      asOwner(A, (tx) => tx`truncate business_day_settings`),
      "23001",
    );
    // Tenant B cannot read A's history.
    const [seen] = await write(
      ownerB,
      (tx) => tx`select count(*)::int as n from business_day_settings`,
    );
    assert.equal(seen.n, 0);
  });

  await test("print records: numbers are consecutive per (kind, subject) by trigger, the blind count slip numbers apart from the corte Z, the subject has the kind's lowercase shape, and gm_app inserts only inside its tenant", async () => {
    const drawer = ids.drawer1;
    const insert = (s: Session, kind: string, subject: string, n: number) =>
      write(
        s,
        (
          tx,
        ) => tx`insert into report_prints(tenant_id,id,kind,subject,print_number,actor_id,device_id)
        values(${s.tenantId},${randomUUID()},${kind},${subject},${n},${s.employeeId},${s.deviceId})`,
      );
    await insert(manager, "corte_x", drawer, 1);
    await rejects(insert(manager, "corte_x", drawer, 3), "23514");
    await insert(manager, "corte_x", drawer, 2);
    await rejects(insert(manager, "corte_x", drawer, 2), "23514");
    await insert(manager, "day_corte", "2026-10-05", 1);
    await rejects(insert(manager, "day_corte", drawer, 1), "23514");
    await rejects(insert(manager, "corte_z", "2026-10-05", 1), "23514");
    // RPT-R11: the blind count slip is a document of its own. A cashier's slip is slip 1 and
    // the manager's first corte Z of the same drawer is still Z 1, not a reprint.
    await insert(cashier, "count_slip", drawer, 1);
    await insert(manager, "corte_z", drawer, 1);
    await rejects(insert(manager, "corte_z", drawer, 3), "23514");
    await insert(cashier, "count_slip", drawer, 2);
    await rejects(insert(cashier, "count_slip", "2026-10-05", 1), "23514");
    await rejects(insert(manager, "corte", drawer, 1), "23514");
    // RPT-R14: subjects are lowercase uuids (cash_sessions.id::text); the print command
    // lowercases the drawer id before it numbers or records anything.
    await rejects(insert(manager, "corte_x", drawer.toUpperCase(), 1), "23514");
    const [sequences] = await write(
      owner,
      (tx) => tx`select
        max(print_number) filter (where kind = 'count_slip')::int as slips,
        max(print_number) filter (where kind = 'corte_z')::int as zs
        from report_prints where subject = ${drawer}`,
    );
    assert.deepEqual({ ...sequences }, { slips: 2, zs: 1 });
    // A row for another tenant fails RLS WITH CHECK.
    await rejects(
      write(
        owner,
        (
          tx,
        ) => tx`insert into report_prints(tenant_id,id,kind,subject,print_number,actor_id,device_id)
        values(${B},${randomUUID()},'day_corte','2026-10-05',1,${ids.ownerB},${ids.deviceB})`,
      ),
      "42501",
    );
  });

  await test("5. snapshotTenant sets app.tenant_id, statement_timeout 30s, lock_timeout 8s and idle 15s in its first statement, runs read only, isolates tenants, and refuses writes with 25006", async () => {
    const values = await read(
      owner,
      (tx) => tx`
      select current_setting('app.tenant_id') as tenant, current_setting('statement_timeout') as statement,
        current_setting('lock_timeout') as lock, current_setting('idle_in_transaction_session_timeout') as idle,
        current_setting('transaction_read_only') as read_only,
        current_setting('transaction_isolation') as isolation`,
    );
    assert.deepEqual(
      { ...values[0] },
      {
        tenant: A,
        statement: "30s",
        lock: "8s",
        idle: "15s",
        read_only: "on",
        isolation: "repeatable read",
      },
    );
    await rejects(
      read(
        owner,
        (tx) =>
          tx`insert into audit(tenant_id,id,actor_id,operation,entity_id) values(${A},${randomUUID()},${ids.owner},'reports.test','x')`,
      ),
      "25006",
    );
    const [other] = await read(
      owner,
      (tx) => tx`select count(*)::int as n from restaurants where id = ${B}`,
    );
    assert.equal(other.n, 0);
    await rejects(
      snapshotTenant(sql, "", async () => 1),
      "missing_tenant",
    );
  });

  await test("30. limits: a forced statement timeout maps to reports_timeout (422), a 32-day list to reports_range_invalid, a forged cursor to invalid_input", async () => {
    await assert.rejects(
      read(owner, async (tx) => {
        await tx`select set_config('statement_timeout', '50ms', true)`;
        await tx`select pg_sleep(1)`;
      }),
      (e: any) => e.code === "reports_timeout" && e.status === 422,
    );
    const today = businessDate(
      new Date().toISOString(),
      settingsA.timezone,
      settingsA.cutoff,
    );
    await rejects(
      read(owner, (tx) =>
        auditLog(tx, owner, { from: addDays(today, -31), to: today }),
      ),
      "reports_range_invalid",
    );
    await rejects(
      read(owner, (tx) =>
        tenderRows(tx, owner, { from: addDays(today, -31), to: today }),
      ),
      "reports_range_invalid",
    );
    await rejects(
      read(owner, (tx) =>
        auditLog(tx, owner, {
          from: today,
          to: today,
          cursor: "bm90LWEtY3Vyc29y",
        }),
      ),
      "invalid_input",
    );
  });

  // ---- Sales fixture for the statements that read wave-1 tables.
  const today = businessDate(
    new Date().toISOString(),
    settingsA.timezone,
    settingsA.cutoff,
  );
  const o1 = await newOrder(cashier, [{ productId: ids.taco, quantity: 2 }]); // 9000
  await pay(cashier, o1.id, 9000, "cash", 1000);
  const o2 = await newOrder(server, [{ productId: ids.agua, quantity: 1 }]); // 3000
  await pay(server, o2.id, 3000, "external", 500);
  await newOrder(cashier, [{ productId: ids.taco, quantity: 1 }], {
    channel: "qr",
  }); // 4500, unpaid
  const o4 = await newOrder(cashier, [{ productId: ids.agua, quantity: 2 }], {
    mode: "delivery",
  }); // 6000
  await pay(cashier, o4.id, 2000, "cash");
  await write(manager, (tx) =>
    recordPaidOut(tx, manager, {
      operationId: randomUUID(),
      amount: 1500,
      reason: "Hielo ficticio",
    }),
  );

  await test("7 (collections). the S3 statement splits collected, tips and count by cash and terminal on today's collection date", async () => {
    const restaurant = await read(owner, (tx) => restaurantOf(tx, owner));
    const range = { from: today, to: today };
    const rows = await read(owner, (tx) =>
      collectionDays(tx, owner, range, windowOf(range, restaurant)),
    );
    const cash = rows.find((r) => r.method === "cash")!;
    const ext = rows.find((r) => r.method === "external")!;
    assert.deepEqual(
      { count: cash.count, amount: cash.amount, tips: cash.tips },
      { count: 2, amount: 11_000, tips: 1_000 },
    );
    assert.deepEqual(
      { count: ext.count, amount: ext.amount, tips: ext.tips },
      { count: 1, amount: 3_000, tips: 500 },
    );
    assert.equal(cash.lateCount + ext.lateCount, 0);
    const paidOuts = await read(owner, (tx) =>
      paidOutDays(tx, owner, range, windowOf(range, restaurant)),
    );
    assert.deepEqual(paidOuts, [{ date: today, count: 1, amount: 1_500 }]);
  });

  await test("17. the employee breakdown attributes sales and tips to the assigned server, else the creator; unassigned QR/kiosk orders form the QR / Kiosco row; every sales breakdown totals Σ orders.total", async () => {
    const range = { from: today, to: today };
    const restaurant = await read(owner, (tx) => restaurantOf(tx, owner));
    // Assign o4 to the server: its sale and tips move to her.
    await asOwner(
      A,
      (tx) =>
        tx`update orders set assigned_employee_id = ${ids.server} where id = ${o4.id}`,
    );
    const staff = await read(owner, (tx) => employeeRows(tx, range));
    const byId = new Map(staff.rows.map((r) => [r.employeeId, r]));
    assert.deepEqual(
      {
        orders: byId.get(ids.cashier)?.orders,
        sales: byId.get(ids.cashier)?.salesTotal,
        tips: byId.get(ids.cashier)?.tips,
      },
      { orders: 1, sales: 9_000, tips: 1_000 },
    );
    assert.deepEqual(
      {
        orders: byId.get(ids.server)?.orders,
        sales: byId.get(ids.server)?.salesTotal,
        tips: byId.get(ids.server)?.tips,
      },
      { orders: 2, sales: 9_000, tips: 500 },
    );
    const qr = byId.get(null)!;
    assert.deepEqual(
      { orders: qr.orders, sales: qr.salesTotal, role: qr.role },
      { orders: 1, sales: 4_500, role: "public" },
    );
    const [{ total }] = await read(
      owner,
      (tx) =>
        tx`select sum(total)::int as total from orders where business_date = ${today}::date`,
    );
    assert.equal(staff.total, total);
    const hours = await read(owner, (tx) =>
      hourBreakdown(tx, owner, range, restaurant),
    );
    const channels = await read(owner, (tx) =>
      groupBreakdown(tx, range, "channel"),
    );
    const modes = await read(owner, (tx) => groupBreakdown(tx, range, "mode"));
    for (const b of [hours, channels, modes])
      assert.equal(b.total, total, b.by);
    assert.deepEqual(
      channels.rows.map((r) => [r.key, r.orders, r.salesTotal]).sort(),
      [
        ["pos", 3, 18_000],
        ["qr", 1, 4_500],
      ],
    );
    assert.deepEqual(
      modes.rows.find((r) => r.key === "delivery")?.salesTotal,
      6_000,
    );
    assert.equal(hours.cutoffHour, 4);
  });

  await test("FIN-04/OFF-9: a tender at the cutoff instant is on the new day; an offline sale sold at 23:30 and synced the next morning counts on the sale day, late, in the 23:00 hour; a recovery order's tender counts on its order's date", async () => {
    // Clock cases inside tenant B (Tijuana, cutoff 00:00) on fixed past dates.
    const zone = settingsB.timezone;
    const day = "2026-09-14";
    const cutoffInstant = at("2026-09-15", "00:00:00", zone); // first instant of the 15th
    const insertOrder = async (o: {
      id: string;
      number: number;
      date: string;
      created: string;
      channel?: string;
      state?: string;
      total: number;
    }) =>
      asOwner(
        B,
        (
          tx,
        ) => tx`insert into orders(tenant_id,id,number,business_date,employee_id,mode,name,note,channel,state,total,created_at)
        values(${B},${o.id},${o.number},${o.date},${ids.ownerB},'takeaway','Reloj','',${o.channel ?? "pos"},${o.state ?? "completed"},${o.total},${o.created})`,
      );
    const insertTender = async (
      orderId: string,
      tenderId: string,
      created: string,
      amount: number,
      extra: { source?: string } = {},
    ) =>
      asOwner(
        B,
        (
          tx,
        ) => tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,tip,received,created_at,source)
        values(${B},${tenderId},${orderId},${ids.drawerB},'cash',${amount},0,${amount},${created},${extra.source ?? "normal"})`,
      );
    const edge = randomUUID();
    await insertOrder({
      id: edge,
      number: 9001,
      date: "2026-09-15",
      created: cutoffInstant,
      total: 1000,
    });
    await insertTender(edge, randomUUID(), cutoffInstant, 1000);
    const before = randomUUID();
    const justBefore = new Date(Date.parse(cutoffInstant) - 1).toISOString();
    await insertOrder({
      id: before,
      number: 9002,
      date: day,
      created: justBefore,
      total: 700,
    });
    await insertTender(before, randomUUID(), justBefore, 700);
    // Offline sale: sold 23:30 on the 14th, synced 09:10 on the 15th.
    const sold = at(day, "23:30:00", zone);
    const synced = at("2026-09-15", "09:10:00", zone);
    const offlineOrder = randomUUID();
    const offlineTender = randomUUID();
    await insertOrder({
      id: offlineOrder,
      number: 9003,
      date: day,
      created: synced,
      channel: "offline",
      total: 2500,
    });
    await insertTender(offlineOrder, offlineTender, synced, 2500);
    await asOwner(
      B,
      (
        tx,
      ) => tx`insert into offline_sync_records(tenant_id,operation_id,kind,format_version,path,device_id,employee_id,session_id,
        order_id,round_number,tender_id,recorded_at,sold_at,business_date,kitchen_delivery,amount,tip,actor_id)
      values(${B},${randomUUID()},'sale',3,'automatic',${ids.deviceB},${ids.ownerB},${randomUUID()},${offlineOrder},1,${offlineTender},
        ${sold},${sold},${day},'not_applicable',2500,0,${ids.ownerB})`,
    );
    // A recovery order dated the 14th whose tender was recorded on the 16th.
    const recovery = randomUUID();
    await insertOrder({
      id: recovery,
      number: 9004,
      date: day,
      created: at("2026-09-16", "10:00:00", zone),
      channel: "offline",
      state: "recovery_reviewed",
      total: 900,
    });
    await insertTender(
      recovery,
      randomUUID(),
      at("2026-09-16", "10:00:00", zone),
      900,
      { source: "offline_recovery" },
    );

    const restaurant = await read(ownerB, (tx) => restaurantOf(tx, ownerB));
    const days = (from: string, to: string) =>
      read(ownerB, (tx) =>
        collectionDays(
          tx,
          ownerB,
          { from, to },
          windowOf({ from, to }, restaurant),
        ),
      );
    const fourteenth = await days(day, day);
    assert.deepEqual(
      fourteenth.map((r) => ({
        amount: r.amount,
        count: r.count,
        lateCount: r.lateCount,
        lateAmount: r.lateAmount,
      })),
      [
        {
          amount: 700 + 2500 + 900,
          count: 3,
          lateCount: 2,
          lateAmount: 2500 + 900,
        },
      ],
    );
    const fifteenth = await days("2026-09-15", "2026-09-15");
    assert.deepEqual(
      fifteenth.map((r) => r.amount),
      [1000],
    );
    const both = await days(day, "2026-09-15");
    assert.equal(
      both.reduce((a, r) => a + r.amount, 0),
      700 + 2500 + 900 + 1000,
      "the cutoff tender is counted once",
    );
    const hours = await read(ownerB, (tx) =>
      hourBreakdown(tx, ownerB, { from: day, to: day }, restaurant),
    );
    assert.equal(
      hours.rows.find((r) => r.hour === 23)?.salesTotal,
      2500 + 700,
      "sold_at places the offline sale at 23:00",
    );
    // The tender list shows the offline badge, the recovered source and the sale-day collection date.
    const list = await read(ownerB, (tx) =>
      tenderRows(tx, ownerB, { from: day, to: day }),
    );
    const offline = list.rows.find((r) => r.id === offlineTender)!;
    assert.deepEqual(
      {
        offline: offline.offline,
        collectionDate: offline.collectionDate,
        orderDate: offline.orderDate,
      },
      { offline: true, collectionDate: day, orderDate: day },
    );
    assert.equal(
      list.rows.find((r) => r.orderId === recovery)?.source,
      "offline_recovery",
    );
    // Every computed collection day equals business_date_at for tenders without a ledger date.
    for (const r of list.rows.filter(
      (x) => !x.offline && x.source === "normal",
    )) {
      const [d] = await write(
        ownerB,
        (tx) =>
          tx`select business_date_at(${B}::uuid, ${r.at}::timestamptz)::text as d`,
      );
      assert.equal(r.collectionDate, d.d);
    }
  });

  await test("20/22. GAP-3: the activity log reaches events older than the newest 100 with keyset paging (rows sharing a timestamp each once, newest first) and filters by employee, activity group and order number", async () => {
    // One instant with microseconds (sent as text: postgres.js would round a timestamptz
    // parameter to milliseconds), so the page boundary falls inside rows that share it.
    const instant = new Date().toISOString().replace("Z", "417Z");
    await asOwner(A, async (tx) => {
      for (let i = 0; i < 130; i++)
        await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail,created_at)
          values(${A},${randomUUID()},${i % 2 ? ids.manager : ids.cashier},${i % 3 ? "kitchen.seen" : "cash.paidout"},${i % 5 ? ids.drawer1 : o1.id},
                 ${tx.json({ amount: i, reason: "Evento " + i })},${instant}::text::timestamptz)`;
    });
    const all: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await read(owner, (tx) =>
        auditLog(tx, owner, {
          from: today,
          to: today,
          limit: "100",
          ...(cursor ? { cursor } : {}),
        }),
      );
      all.push(...page.rows.map((r) => r.id));
      cursor = page.next ?? undefined;
      pages++;
      for (let i = 1; i < page.rows.length; i++)
        assert.ok(page.rows[i - 1].at >= page.rows[i].at, "newest first");
    } while (cursor);
    const [{ n }] = await write(
      owner,
      (tx) =>
        tx`select count(*)::int as n from audit where business_date_at(${A}::uuid, created_at) = ${today}::date`,
    );
    assert.equal(all.length, n, "every row of the day");
    assert.equal(new Set(all).size, all.length, "each row once");
    assert.ok(pages >= 2 && n > 130);
    const cash = await read(owner, (tx) =>
      auditLog(tx, owner, {
        from: today,
        to: today,
        group: "cash",
        limit: "500",
      }),
    );
    assert.ok(
      cash.rows.length >= 44 &&
        cash.rows.every((r) => r.operation.startsWith("cash.")),
    );
    const byEmployee = await read(owner, (tx) =>
      auditLog(tx, owner, {
        from: today,
        to: today,
        employee: ids.manager,
        limit: "500",
      }),
    );
    assert.ok(
      byEmployee.rows.length > 0 &&
        byEmployee.rows.every((r) => r.actorId === ids.manager),
    );
    const byOrder = await read(owner, (tx) =>
      auditLog(tx, owner, {
        from: today,
        to: today,
        order: String(o1.number),
        limit: "500",
      }),
    );
    assert.ok(
      byOrder.rows.length >= 26 &&
        byOrder.rows.every((r) => r.entityId === o1.id),
    );
    assert.ok(byOrder.rows.every((r) => r.orderNumber === o1.number));
    const sample = byOrder.rows.find((r) => r.operation === "cash.paidout");
    assert.ok(
      sample &&
        typeof sample.summary.amount === "number" &&
        sample.summary.reason?.startsWith("Evento"),
    );
    const none = await read(owner, (tx) =>
      auditLog(tx, owner, { from: today, to: today, order: "999999" }),
    );
    assert.deepEqual(none, { rows: [], next: null });
    // Every row's business date equals business_date_at.
    for (const r of cash.rows.slice(0, 20)) {
      const [d] = await write(
        owner,
        (tx) =>
          tx`select business_date_at(${A}::uuid, ${r.at}::timestamptz)::text as d`,
      );
      assert.equal(r.businessDate, d.d);
    }
  });

  await test("tender list: newest first with keyset paging, method and drawer filters, refunded per tender", async () => {
    const page1 = await read(owner, (tx) =>
      tenderRows(tx, owner, { from: today, to: today, limit: "2" }),
    );
    assert.equal(page1.rows.length, 2);
    assert.ok(page1.next);
    const page2 = await read(owner, (tx) =>
      tenderRows(tx, owner, {
        from: today,
        to: today,
        limit: "2",
        cursor: page1.next!,
      }),
    );
    const seen = [...page1.rows, ...page2.rows].map((r) => r.id);
    assert.equal(new Set(seen).size, 3);
    const ext = await read(owner, (tx) =>
      tenderRows(tx, owner, { from: today, to: today, method: "external" }),
    );
    assert.deepEqual(
      ext.rows.map((r) => [r.amount, r.tip, r.reference, r.deviceName]),
      [[3_000, 500, "AUT-" + run, "Barra"]],
    );
    const drawer1 = await read(owner, (tx) =>
      tenderRows(tx, owner, { from: today, to: today, drawer: ids.drawer1 }),
    );
    assert.deepEqual(drawer1.rows.map((r) => r.amount).sort(), [2_000, 9_000]);
    const [tender] =
      await admin`select id from tenders where tenant_id = ${A} and order_id = ${o1.id}`;
    await asOwner(
      A,
      (
        tx,
      ) => tx`insert into refunds(tenant_id,id,tender_id,session_id,amount,reason,disposition,actor_id)
      values(${A},${randomUUID()},${tender.id},${ids.drawer1},1500,'Reembolso ficticio','discard',${ids.manager})`,
    );
    const after = await read(owner, (tx) =>
      tenderRows(tx, owner, { from: today, to: today, drawer: ids.drawer1 }),
    );
    assert.equal(after.rows.find((r) => r.amount === 9_000)?.refunded, 1_500);
  });

  await test("DB-7/MON-6: changing the cutoff from 04:00 to 02:00 records the old settings; earlier instants keep their business date, later ones use the new cutoff, and past days' collections and activity pages are unchanged; a raw old-revision update is recorded too, and outside the tenant scope it changes nothing", async () => {
    const restaurant = await read(owner, (tx) => restaurantOf(tx, owner));
    const range = { from: today, to: today };
    const before = {
      collections: await read(owner, (tx) =>
        collectionDays(tx, owner, range, windowOf(range, restaurant)),
      ),
      audit: (
        await read(owner, (tx) =>
          auditLog(tx, owner, { from: today, to: today, limit: "500" }),
        )
      ).rows.map((r) => r.id),
    };
    // An instant at 03:00 local yesterday: with 04:00 it is the day before yesterday.
    const three = at(addDays(today, -1), "03:00:00", settingsA.timezone);
    const [old] = await write(
      owner,
      (tx) =>
        tx`select business_date_at(${A}::uuid, ${three}::timestamptz)::text as d`,
    );
    assert.equal(old.d, addDays(today, -2));
    const version = (await write(owner, (tx) => getSettings(tx, owner)))
      .version;
    await write(owner, (tx) =>
      saveSettings(tx, owner, {
        operationId: randomUUID(),
        expectedVersion: version,
        name: settingsA.name,
        currency: "MXN",
        timezone: settingsA.timezone,
        cutoff: 120,
        openingDays: [1, 2, 3, 4, 5, 6, 7],
      }),
    );
    for (const s of [owner, manager, cashier, server, kitchen])
      s.restaurant.cutoff = 120;
    const history = await write(
      owner,
      (tx) =>
        tx`select timezone, cutoff from business_day_settings where tenant_id = ${A} order by valid_until`,
    );
    assert.deepEqual(
      history.map((h) => [h.timezone, h.cutoff]),
      [
        ["America/Mexico_City", 240],
        ["America/Mexico_City", 240],
      ],
    );
    const [kept] = await write(
      owner,
      (tx) =>
        tx`select business_date_at(${A}::uuid, ${three}::timestamptz)::text as d`,
    );
    assert.equal(
      kept.d,
      addDays(today, -2),
      "an earlier instant keeps its business date",
    );
    const later = at(addDays(today, 3), "03:00:00", settingsA.timezone);
    const [next] = await write(
      owner,
      (tx) =>
        tx`select business_date_at(${A}::uuid, ${later}::timestamptz)::text as d`,
    );
    assert.equal(next.d, addDays(today, 3), "a later instant uses 02:00");
    const restaurantAfter = await read(owner, (tx) => restaurantOf(tx, owner));
    assert.equal(restaurantAfter.cutoff, 120);
    const after = {
      collections: await read(owner, (tx) =>
        collectionDays(tx, owner, range, windowOf(range, restaurantAfter)),
      ),
      audit: (
        await read(owner, (tx) =>
          auditLog(tx, owner, { from: today, to: today, limit: "500" }),
        )
      ).rows
        .filter((r) => r.operation !== "restaurant.settings")
        .map((r) => r.id),
    };
    assert.deepEqual(after.collections, before.collections);
    assert.deepEqual(after.audit, before.audit);
    // The previous app revision updates the columns directly inside its tenant scope: recorded.
    await write(
      owner,
      (tx) => tx`update restaurants set cutoff = 180 where id = ${A}`,
    );
    // Two changes in one transaction keep the first (older) settings.
    await write(owner, async (tx) => {
      await tx`update restaurants set cutoff = 60 where id = ${A}`;
      await tx`update restaurants set timezone = 'America/Tijuana' where id = ${A}`;
    });
    const rows = await write(
      owner,
      (tx) =>
        tx`select cutoff, timezone from business_day_settings where tenant_id = ${A} order by valid_until`,
    );
    assert.deepEqual(
      rows.slice(-2).map((h) => [h.timezone, h.cutoff]),
      [
        ["America/Mexico_City", 120],
        ["America/Mexico_City", 180],
      ],
    );
    // Outside the tenant scope the runtime role's update sees no row: nothing changes, nothing recorded.
    const changed =
      await sql`update restaurants set cutoff = 0 where id = ${A}`;
    assert.equal(changed.count, 0);
    await asOwner(
      A,
      (tx) =>
        tx`update restaurants set timezone = ${settingsA.timezone}, cutoff = 240 where id = ${A}`,
    );
    for (const s of [owner, manager, cashier, server, kitchen])
      s.restaurant.cutoff = 240;
  });

  await test("31/32. reports run on the Free plan and while selling is blocked; cashier, server and kitchen get forbidden; tenant B never sees tenant A rows", async () => {
    const free = await read(ownerC, (tx) =>
      auditLog(tx, ownerC, { from: today, to: today }),
    );
    assert.deepEqual(free.rows, []);
    const filters = await read(ownerC, (tx) => reportFilters(tx, ownerC));
    assert.deepEqual(
      filters.employees.map((e) => e.id),
      [ids.ownerC],
    );
    for (const s of [cashier, server, kitchen]) {
      await rejects(
        read(s, (tx) => auditLog(tx, s, { from: today, to: today })),
        "forbidden",
      );
      await rejects(
        read(s, (tx) => reportFilters(tx, s)),
        "forbidden",
      );
      await rejects(
        read(s, (tx) => tenderRows(tx, s, { from: today, to: today })),
        "forbidden",
      );
    }
    const filtersA = await read(manager, (tx) => reportFilters(tx, manager));
    assert.deepEqual(filtersA.devices.map((d) => d.name).sort(), [
      "Barra",
      "Caja mostrador",
    ]);
    const fromB = await read(ownerB, (tx) =>
      tenderRows(tx, ownerB, { from: today, to: today }),
    );
    assert.ok(
      fromB.rows.every((r) => ![o1.id, o2.id, o4.id].includes(r.orderId)),
    );
    const auditB = await read(ownerB, (tx) =>
      auditLog(tx, ownerB, { from: today, to: today, limit: "500" }),
    );
    assert.ok(auditB.rows.every((r) => r.actorId === ids.ownerB));
  });

  await test("32b. the manager endpoints that read fiscal (027) and discounts (028) refuse cashier, server and kitchen before any port or 027/028 statement; kitchen gets no corte; the remote close needs a recent PIN on a shared device", async () => {
    // Ports that fail loudly: a refused call must never reach fiscal or discounts.
    const port = (name: string) => () => {
      throw new Error("port_called:" + name);
    };
    const refusing: ReportsPorts = {
      fiscalSummary: port("fiscalSummary"),
      missingTicketCount: port("missingTicketCount"),
      moneyControls: port("moneyControls"),
      canSeeExpected: port("canSeeExpected"),
      closeDrawerRow: port("closeDrawerRow"),
    };
    const refused = (label: string, p: Promise<unknown>, code: string) =>
      assert.rejects(p, (e: any) => {
        assert.equal(e.code ?? e.message, code, `${label}: ${e.message}`);
        return true;
      });
    const day = { from: today, to: today };
    const reads: [string, (tx: Tx, s: Session) => Promise<unknown>][] = [
      ["salesSummary", (tx, s) => salesSummary(tx, s, day, "req", refusing)],
      ["breakdown", (tx, s) => breakdown(tx, s, { ...day, by: "product" })],
      ["orderRows", (tx, s) => orderRows(tx, s, day)],
      ["exceptionRows", (tx, s) => exceptionRows(tx, s, day)],
      ["drawerList", (tx, s) => drawerList(tx, s, day, refusing)],
      ["todaySummary", (tx, s) => todaySummary(tx, s, "req", refusing)],
      ["dayCorte", (tx, s) => dayCorte(tx, s, today, "req", refusing)],
      [
        "legacyDailyReport",
        (tx, s) => legacyDailyReport(tx, s, { date: today }),
      ],
    ];
    const commands: [string, (tx: Tx, s: Session) => Promise<unknown>][] = [
      [
        "printDayCorte",
        (tx, s) =>
          printDayCorte(tx, s, today, { operationId: randomUUID() }, refusing),
      ],
      [
        "closeDrawerRemotely",
        (tx, s) =>
          closeDrawerRemotely(
            tx,
            s,
            ids.drawer2,
            { operationId: randomUUID(), counted: 0, reason: "Prueba" },
            refusing,
          ),
      ],
    ];
    for (const s of [cashier, server, kitchen]) {
      for (const [label, fn] of reads)
        await refused(
          `${s.role} ${label}`,
          read(s, (tx) => fn(tx, s)),
          "forbidden",
        );
      for (const [label, fn] of commands)
        await refused(
          `${s.role} ${label}`,
          write(s, (tx) => fn(tx, s)),
          "forbidden",
        );
    }
    await refused(
      "kitchen drawerCorte",
      read(kitchen, (tx) => drawerCorte(tx, kitchen, ids.drawer2, refusing)),
      "forbidden",
    );
    await refused(
      "kitchen printDrawerCorte",
      write(kitchen, (tx) =>
        printDrawerCorte(
          tx,
          kitchen,
          ids.drawer2,
          { operationId: randomUUID(), kind: "x" },
          refusing,
        ),
      ),
      "forbidden",
    );
    // A manager on a shared terminal (SEC-6): no PIN yet, or one entered a day ago, is refused
    // before the drawer is read; a fresh PIN passes the step-up, so the next refusal is the
    // drawer's own (an unknown drawer: not_found).
    const onTerminal = (authenticatedAt: string | null): Session => ({
      ...manager,
      id: randomUUID(),
      access: {
        absoluteExpiresAt: null,
        authenticatedAt,
        deviceName: "Caja mostrador",
        deviceKind: "terminal",
        idleLockSeconds: null,
        ownerAccount: false,
      },
    });
    const remote = (s: Session) =>
      write(s, (tx) =>
        closeDrawerRemotely(
          tx,
          s,
          randomUUID(),
          { operationId: randomUUID(), counted: 0, reason: "Prueba" },
          refusing,
        ),
      );
    await refused("no PIN", remote(onTerminal(null)), "step_up_required");
    await refused(
      "stale PIN",
      remote(onTerminal(new Date(Date.now() - 86_400_000).toISOString())),
      "step_up_required",
    );
    await refused(
      "fresh PIN",
      remote(onTerminal(new Date().toISOString())),
      "not_found",
    );
  });

  await test("keyset cursors keep microseconds: tenders that share one instant page each once (tenant C)", async () => {
    // Same cursor code as the order, audit and exceptions lists: the cursor time is passed as
    // text, so rows in the same millisecond as the page boundary are not skipped.
    const instant = new Date().toISOString().replace("Z", "731Z");
    const order = randomUUID();
    const tenders = [randomUUID(), randomUUID(), randomUUID()];
    await asOwner(C, async (tx) => {
      await tx`insert into orders(tenant_id,id,number,business_date,employee_id,mode,name,note,channel,state,total,created_at)
        values(${C},${order},1,${today},${ids.ownerC},'takeaway','Micro','','pos','completed',3000,${instant}::text::timestamptz)`;
      for (const t of tenders)
        await tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,tip,received,created_at)
          values(${C},${t},${order},null,'cash',1000,0,1000,${instant}::text::timestamptz)`;
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await read(ownerC, (tx) =>
        tenderRows(tx, ownerC, {
          from: today,
          to: today,
          limit: "1",
          ...(cursor ? { cursor } : {}),
        }),
      );
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.next ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, [...tenders].sort().reverse());
  });

  console.log(`Reports DB passed (${checks} checks)`);
} finally {
  // Append-only history (029, and 027/028 once merged): LD-12 named-trigger cleanup in the
  // LD-16 L5 order (tests/fixtures/reports-cleanup.ts).
  await removeTenants(admin, [A, B, C], [organizationId]);
  await sql.end();
  await admin.end();
}
