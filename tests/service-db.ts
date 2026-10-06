import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import { password } from "../server/auth.js";
import { checkRole, connect, tenant, type Tx } from "../server/db.js";
import {
  addRound,
  createOrder,
  getOrder,
  getOrders,
  recordPayment,
} from "../server/orders.js";
import { assignService, progressPreparation } from "../server/service.js";
import {
  acknowledgeVoids,
  verifyApproval,
  voidLines,
} from "../server/voids.js";
import {
  closeCheck,
  listOrders,
  orderForOperation,
  tableOccupancy,
  updateOrderNote,
  recordPrint,
  recordSettlement,
} from "../server/checks.js";
import {
  clearStaleRounds,
  kitchenFeed,
  recallRound,
} from "../server/kitchen.js";
import { recordPaidOut, refund, cashSummary } from "../server/operations.js";
import { issueOfflineLease } from "../server/offline-leases.js";
import {
  reconcileOffline,
  synchronizeOffline,
} from "../server/offline-sync.js";
import type { Order, Session } from "../shared/domain.js";
import {
  KITCHEN_FEED_LIMIT,
  reconcileLostSend,
  type KitchenFeed,
  type OrderListResponse,
} from "../shared/service.js";
import { isolatedTarget } from "./isolated-target.js";
import { noRetries } from "./db-retries.js";

// Every run creates its own fictional organization and two restaurants, so
// feeds, lists and occupancy are deterministic regardless of earlier runs.
const { runtime: url, migration } = isolatedTarget(process.env);
const sql = connect(url),
  admin = postgres(migration, { max: 1 });
await checkRole(sql);

const organizationId = randomUUID();
const tenantId = randomUUID();
const otherTenantId = randomUUID();
const deviceId = randomUUID();
const ids = {
  owner: randomUUID(),
  manager: randomUUID(),
  cashier: randomUUID(),
  kitchen: randomUUID(),
  server: randomUUID(),
  foreign: randomUUID(),
};
const managerLogin = `mgr-${ids.manager.slice(0, 8)}`;
const managerPin = "4321";
const restaurant = {
  name: "Servicio · Prueba",
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
};
const session = (
  role: string,
  employeeId: string,
  tenant = tenantId,
): Session => ({
  id: randomUUID(),
  tenantId: tenant,
  employeeId,
  name: role,
  role,
  deviceId,
  expiresAt: "",
  offlineUntil: "",
  csrf: "",
  restaurant,
});
const owner = session("owner", ids.owner);
const manager = session("manager", ids.manager);
const cashier = session("cashier", ids.cashier);
const kitchen = session("kitchen", ids.kitchen);
const server = session("server", ids.server);
const foreign = session("cashier", ids.foreign, otherTenantId);
const tables = Array.from({ length: 4 }, (_, i) => ({
  id: randomUUID(),
  name: `Mesa ${String(i + 1).padStart(2, "0")}`,
}));
const stockId = randomUUID();
const plain = randomUUID(), // kitchen, recipe
  withOptions = randomUUID(), // kitchen, one optional group
  drink = randomUUID(), // bar
  salsa = randomUUID();
const product = (
  id: string,
  es: string,
  price: number,
  extra: object = {},
) => ({
  id,
  name: { es, en: es },
  category: { es: "Pruebas", en: "Tests" },
  price,
  available: true,
  station: "kitchen",
  groups: [],
  cost: null,
  version: 1,
  recipe: [],
  ...extra,
});

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
async function rejects(promise: Promise<unknown>, code: string | RegExp) {
  await assert.rejects(promise, (e: any) => {
    if (code instanceof RegExp)
      assert.match(`${e.code ?? ""} ${e.message}`, code);
    else assert.equal(e.code ?? e.message, code);
    return true;
  });
}
const run = <T>(s: Session, fn: (tx: Tx) => Promise<T>) =>
  tenant(sql, s.tenantId, fn);
const asAdmin = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
  admin.begin(fn) as Promise<T>;

type LineSpec = {
  productId?: string;
  quantity?: number;
  options?: string[];
  note?: string;
};
const line = (l: LineSpec = {}) => ({
  id: randomUUID(),
  productId: l.productId ?? plain,
  quantity: l.quantity ?? 1,
  options: l.options ?? [],
  note: l.note ?? "",
});
async function newOrder(
  o: {
    s?: Session;
    mode?: "takeaway" | "dine_in" | "delivery";
    tableId?: string | null;
    name?: string;
    note?: string;
    lines?: LineSpec[];
  } = {},
): Promise<Order> {
  const s = o.s ?? owner;
  return run(s, (tx) =>
    createOrder(tx, s, {
      operationId: randomUUID(),
      lines: (o.lines ?? [{}]).map(line),
      mode: o.mode ?? "takeaway",
      tableId: o.tableId ?? null,
      name: o.name ?? "Servicio",
      note: o.note ?? "",
      channel: "pos",
    }),
  );
}
const round = (o: Order, lines: LineSpec[] = [{}], note = "", s = owner) =>
  run(s, (tx) =>
    addRound(tx, s, o.id, {
      operationId: randomUUID(),
      expectedVersion: o.version,
      lines: lines.map(line),
      mode: o.mode,
      note,
    }),
  );
const pay = (
  o: { id: string },
  amount: number,
  extra: object = {},
  s: Session = owner,
) =>
  run(s, (tx) =>
    recordPayment(tx, s, o.id, {
      operationId: randomUUID(),
      amount,
      tip: 0,
      received: amount,
      method: "cash",
      ...extra,
    }),
  );
const progress = (roundId: string, state: string, s = kitchen) =>
  run(s, (tx) =>
    progressPreparation(tx, s, roundId, { operationId: randomUUID(), state }),
  );
const read = (id: string) => run(owner, (tx) => getOrder(tx, id));
const close = (id: string, operationId = randomUUID(), s = owner) =>
  run(s, (tx) => closeCheck(tx, s, id, { operationId }));
const feed = (s: Session, q: object = {}) =>
  run(s, (tx) => kitchenFeed(tx, s, q)) as Promise<KitchenFeed>;
const full = async (s: Session, q: object = {}) => {
  const f = await feed(s, q);
  assert.equal(f.unchanged, false);
  return f as Extract<KitchenFeed, { unchanged: false }>;
};
const list = (s: Session, q: Record<string, string> = {}) =>
  run(s, (tx) => listOrders(tx, s, q)) as Promise<OrderListResponse>;
async function voidAs(
  s: Session,
  o: Order,
  quantity: number,
  extra: object = {},
) {
  const body = {
    operationId: randomUUID(),
    expectedVersion: o.version,
    lines: [{ lineId: o.lines[0].id, quantity }],
    reason: "Cliente cambió de opinión",
    stockDisposition: "no_return",
    ...extra,
  };
  const approverId = await verifyApproval(sql, s, (body as any).approval);
  return run(s, (tx) => voidLines(tx, s, o.id, body, approverId));
}
const kitchenRound = (o: Order, n = 1, station = "kitchen") =>
  o.rounds.find((r) => r.number === n && r.station === station)!;
try {
  await admin`insert into organizations(id,name) values(${organizationId},'Servicio ficticio')`;
  for (const [id, name] of [
    [tenantId, restaurant.name],
    [otherTenantId, "Servicio ajeno · Prueba"],
  ])
    await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff) values(${id},${organizationId},${name},'MXN','America/Mexico_City',240)`;
  for (const t of [tenantId, otherTenantId])
    await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source) values(${t},'active',now()+interval '14 days','fixture')`;
  for (const [id, role, login, secret] of [
    [ids.owner, "owner", "owner", "fixture"],
    [ids.manager, "manager", managerLogin, password(managerPin)],
    [ids.cashier, "cashier", "cashier", "fixture"],
    [ids.kitchen, "kitchen", "kitchen", "fixture"],
    [ids.server, "server", "server", "fixture"],
  ])
    await admin`insert into employees(tenant_id,id,name,login,secret_hash,role) values(${tenantId},${id},${role + " prueba"},${login},${secret},${role})`;
  await admin`insert into employees(tenant_id,id,name,login,secret_hash,role) values(${otherTenantId},${ids.foreign},'Ajeno','cashier','fixture','cashier')`;
  await admin`insert into devices(tenant_id,id,name,token_hash) values(${tenantId},${deviceId},'Caja prueba','fixture')`;
  await admin`insert into devices(tenant_id,id,name,token_hash) values(${otherTenantId},${deviceId},'Caja ajena','fixture')`;
  for (const t of tables)
    await admin`insert into dining_tables(tenant_id,id,name) values(${tenantId},${t.id},${t.name})`;
  // The ledger trigger is SECURITY DEFINER, so it reads stock_items as the
  // schema owner. Under FORCE ROW LEVEL SECURITY a non-superuser owner
  // (gm_migrator in CI and production) sees the item only with the tenant set.
  await asAdmin(async (tx) => {
    await tx`select set_config('app.tenant_id',${tenantId},true)`;
    await tx`insert into stock_items(tenant_id,id,name,unit,kind,threshold) values(${tenantId},${stockId},'Tortilla','piece','prepared',0)`;
    await tx`insert into stock_movements(tenant_id,id,stock_id,quantity,cause,cause_id,reason,actor_id) values(${tenantId},${randomUUID()},${stockId},100000,'opening','fixture','Fixture',${ids.owner})`;
  });
  for (const p of [
    product(plain, "Taco prueba", 3000, {
      recipe: [{ stockId, quantity: "1" }],
    }),
    product(withOptions, "Taco con salsa", 4000, {
      groups: [
        {
          id: randomUUID(),
          name: { es: "Salsa", en: "Salsa" },
          min: 0,
          max: 1,
          options: [
            {
              id: salsa,
              name: { es: "Salsa verde", en: "Green salsa" },
              price: 500,
              available: true,
            },
          ],
        },
      ],
    }),
    product(drink, "Agua prueba", 2000, { station: "bar" }),
  ])
    await admin`insert into catalog(tenant_id,id,data) values(${tenantId},${p.id},${admin.json(p as any)})`;
  await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${tenantId},${randomUUID()},${deviceId},${ids.owner},0)`;

  await test("migration backfill leaves no open check that is already settled", async () => {
    // Only orders that existed when 024 applied were backfilled; later suites
    // may insert raw tenders on purpose, so they are out of scope here.
    const [bad] = await admin`select count(*)::int as n from orders o
      where o.check_state='open' and o.total>0 and o.state not like 'recovery%'
        and o.created_at < (select applied_at from schema_migrations where name='024_service_lifecycle.sql')
        and (select coalesce(sum(t.amount),0) from tenders t where t.tenant_id=o.tenant_id and t.order_id=o.id) >= o.total`;
    assert.equal(bad.n, 0);
    const [inconsistent] = await admin`select count(*)::int as n from orders
      where (check_state='closed') <> (closed_at is not null and closed_by is not null and close_reason is not null)`;
    assert.equal(inconsistent.n, 0);
  });

  await test("024 backfill closes historical checks when a non-superuser owner applies it (OPS-R2)", async () => {
    // Deployed migrations run as gm_migrator: owner of the tables, but neither
    // superuser nor BYPASSRLS, so FORCE ROW LEVEL SECURITY applies to it. A
    // throwaway database owned by such a role gets 001-021, then history, then
    // 024, in that order (the shared test database never holds orders older
    // than 024, so only this check exercises the backfill).
    const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
    const role = `gm_svc_backfill_${suffix}`;
    const secret = randomUUID().replace(/-/g, "");
    const database = `green_monkey_svc_backfill_${suffix}_test`;
    const urlFor = (user?: { name: string; password: string }) => {
      const u = new URL(migration);
      u.pathname = "/" + database;
      if (user) {
        u.username = user.name;
        u.password = user.password;
      }
      return u.href;
    };
    await admin.unsafe(
      `create role "${role}" login password '${secret}' nosuperuser nocreatedb nocreaterole nobypassrls`,
    );
    await admin.unsafe(`create database "${database}" owner "${role}"`);
    const owner = postgres(urlFor({ name: role, password: secret }), {
      max: 1,
      onnotice: () => {},
    });
    const root = postgres(urlFor(), { max: 1, onnotice: () => {} });
    try {
      const dir = new URL("../migrations/", import.meta.url);
      const files = (await readdir(dir))
        .filter((n) => n.endsWith(".sql"))
        .sort();
      const apply = async (name: string) => {
        const body = await readFile(new URL(name, dir), "utf8");
        await owner.begin((tx) => tx.unsafe(body));
      };
      for (const name of files.filter((n) => n < "024")) await apply(name);
      const [who] =
        await owner`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
      assert.deepEqual(
        { ...who },
        { rolsuper: false, rolbypassrls: false },
        "the backfill must run as an owner without BYPASSRLS",
      );

      // History written before 024, as the previous revision left it.
      const org = randomUUID(),
        tenant = randomUUID(),
        employee = randomUUID(),
        device = randomUUID(),
        drawer = randomUUID();
      const order = {
        paid: randomUUID(),
        partial: randomUUID(),
        voided: randomUUID(),
        unpaid: randomUUID(),
        served: randomUUID(),
        recovery: randomUUID(),
      };
      const paidAt = new Date("2026-03-01T19:30:00Z");
      await root.begin(async (tx) => {
        await tx`insert into organizations(id,name) values(${org},'Backfill fixture')`;
        await tx`insert into restaurants(id,organization_id,name) values(${tenant},${org},'Backfill')`;
        await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
          values(${tenant},${employee},'Caja','caja','x','cashier')`;
        await tx`insert into devices(tenant_id,id,name,token_hash) values(${tenant},${device},'Caja',${"fixture-" + device})`;
        await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${tenant},${drawer},${device},${employee},0)`;
        const rows: [string, number, string, number][] = [
          [order.paid, 1, "completed", 10000],
          [order.partial, 2, "active", 10000],
          [order.voided, 3, "cancelled", 0],
          [order.unpaid, 4, "active", 5000],
          [order.served, 5, "completed", 5000],
          [order.recovery, 6, "recovery_reviewed", 3000],
        ];
        for (const [id, number, state, total] of rows)
          await tx`insert into orders(tenant_id,id,number,business_date,employee_id,mode,name,note,channel,state,total,created_at)
            values(${tenant},${id},${number},'2026-03-01',${employee},'takeaway','','','pos',${state},${total},'2026-03-01T18:00:00Z')`;
        await tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,received,created_at)
          values(${tenant},${randomUUID()},${order.paid},${drawer},'cash',6000,6000,'2026-03-01T19:00:00Z'),
                (${tenant},${randomUUID()},${order.paid},${drawer},'cash',4000,4000,${paidAt}),
                (${tenant},${randomUUID()},${order.partial},${drawer},'cash',2500,2500,${paidAt})`;
      });

      await apply("024_service_lifecycle.sql");

      const after =
        await root`select id, check_state, close_reason, closed_at, closed_by from orders`;
      const byId = new Map(after.map((r) => [r.id as string, r]));
      const stateOf = (id: string) => {
        const r = byId.get(id)!;
        return [r.check_state, r.close_reason];
      };
      assert.deepEqual(stateOf(order.paid), ["closed", "settled"]);
      assert.equal(
        new Date(byId.get(order.paid)!.closed_at).toISOString(),
        paidAt.toISOString(),
        "a settled check closes at its last payment",
      );
      assert.equal(byId.get(order.paid)!.closed_by, employee);
      assert.deepEqual(stateOf(order.voided), ["closed", "voided"]);
      assert.deepEqual(stateOf(order.recovery), ["closed", "recovery"]);
      assert.deepEqual(stateOf(order.partial), ["open", null]);
      assert.deepEqual(stateOf(order.unpaid), ["open", null]);
      assert.deepEqual(
        stateOf(order.served),
        ["open", null],
        "delivered but unpaid stays open",
      );
      const [forced] = await root`
        select bool_and(relforcerowsecurity) as forced from pg_class
        where oid in ('public.orders'::regclass, 'public.tenders'::regclass)`;
      assert.equal(forced.forced, true, "FORCE is restored in the same file");
    } finally {
      await owner.end();
      await root.end();
      await admin.unsafe(`drop database if exists "${database}" with (force)`);
      await admin.unsafe(`drop role if exists "${role}"`);
    }
  });

  await test("delivered rounds keep the check open for more rounds and voids", async () => {
    const o = await newOrder({
      mode: "dine_in",
      tableId: tables[0].id,
      lines: [{ quantity: 2 }],
    });
    const r = kitchenRound(o);
    await progress(r.id, "seen");
    await progress(r.id, "ready");
    await progress(r.id, "completed");
    const served = await read(o.id);
    assert.equal(served.state, "completed");
    assert.equal(served.checkState, "open");
    const dessert = await round(served);
    assert.equal(dessert.state, "active");
    assert.equal(dessert.checkState, "open");
    const voided = await voidAs(owner, dessert, 1);
    const v = voided.voids!.at(-1)!;
    assert.equal(v.preparationState, "completed");
    assert.equal(v.kitchenPending, false);
    assert.equal(voided.checkState, "open");
  });

  await test("progress never resurrects a cancelled order", async () => {
    const o = await newOrder({ lines: [{ quantity: 2 }] });
    const r = kitchenRound(o);
    await progress(r.id, "seen");
    const voided = await voidAs(owner, o, 2);
    assert.equal(voided.state, "cancelled");
    assert.equal(voided.checkState, "closed");
    assert.equal(voided.closeReason, "voided");
    await progress(r.id, "ready");
    const after = await read(o.id);
    assert.equal(after.state, "cancelled");
    assert.equal(after.checkState, "closed");
    assert.equal(after.closeReason, "voided");
  });

  await test("full payment closes takeaway checks and holds dine-in tables until released", async () => {
    const takeaway = await newOrder();
    const paidTakeaway = await pay(takeaway, takeaway.total);
    assert.equal(paidTakeaway.checkState, "closed");
    assert.equal(paidTakeaway.closeReason, "settled");
    assert.equal(
      paidTakeaway.state,
      "active",
      "the kitchen continues independently",
    );

    const dine = await newOrder({ mode: "dine_in", tableId: tables[1].id });
    const paid = await pay(dine, dine.total);
    assert.equal(paid.checkState, "paid");
    const occupied = await run(owner, (tx) => tableOccupancy(tx, owner));
    const t1 = occupied.find((t) => t.id === tables[1].id)!;
    assert.deepEqual(
      t1.checks.map((c) => [c.id, c.checkState]),
      [[dine.id, "paid"]],
    );
    // fiscal 027 (LD-15 fiscal Q2): the ticket is issued at open → paid, so the
    // paid check takes no more rounds; late items go out as a new order for
    // the same table, a second check with its own ticket.
    await rejects(round(paid), "fiscal_ticket_issued");
    const late = await newOrder({ mode: "dine_in", tableId: tables[1].id });
    const latePaid = await pay(late, late.total);
    assert.equal(latePaid.checkState, "paid");
    const both = await run(owner, (tx) => tableOccupancy(tx, owner));
    assert.deepEqual(
      both
        .find((t) => t.id === tables[1].id)!
        .checks.map((c) => c.id)
        .sort(),
      [dine.id, late.id].sort(),
    );
    const released = await close(dine.id);
    assert.equal(released.checkState, "closed");
    assert.equal(released.closeReason, "released");
    assert.equal((await close(late.id)).closeReason, "released");
    const free = await run(owner, (tx) => tableOccupancy(tx, owner));
    assert.equal(free.find((t) => t.id === tables[1].id)!.checks.length, 0);

    await rejects(round(released), "check_closed");
    await rejects(pay(released, 1), "check_closed");
    await rejects(voidAs(owner, released, 1), "check_closed");
    await rejects(
      run(owner, (tx) =>
        assignService(tx, owner, dine.id, {
          operationId: randomUUID(),
          expectedVersion: released.serviceVersion ?? 0,
          tableId: tables[2].id,
          employeeId: ids.owner,
          mode: "dine_in",
          reason: "Cambio de mesa",
        }),
      ),
      "check_closed",
    );
    // SVC-K3: the released check's tickets are still open in the kitchen, so
    // its note can still change; once every round is served it is refused.
    const renoted = await run(owner, (tx) =>
      updateOrderNote(tx, owner, dine.id, {
        operationId: randomUUID(),
        note: "x",
      }),
    );
    assert.equal(renoted.note, "x");
    assert.equal(renoted.checkState, "closed");
    for (const r of renoted.rounds) {
      await progress(r.id, "ready");
      await progress(r.id, "completed");
    }
    assert.equal((await read(dine.id)).state, "completed");
    await rejects(
      run(owner, (tx) =>
        updateOrderNote(tx, owner, dine.id, {
          operationId: randomUUID(),
          note: "x",
        }),
      ),
      "check_closed",
    );
  });

  await test("a closed check's note stays editable while its kitchen tickets are open", async () => {
    // Pay-first counter: the customer mentions an allergy right after paying.
    const o = await newOrder({ note: "Sin prisa" });
    const paid = await pay(o, o.total);
    assert.equal(paid.checkState, "closed");
    assert.equal(paid.state, "active");
    const note = (text: string, s: Session = cashier) =>
      run(s, (tx) =>
        updateOrderNote(tx, s, o.id, { operationId: randomUUID(), note: text }),
      );
    const before = await full(kitchen);
    const edited = await note("Alergia: piña");
    assert.equal(edited.note, "Alergia: piña");
    assert.equal(edited.checkState, "closed");
    assert.equal(edited.closeReason, "settled");
    assert.equal(edited.total, paid.total);
    assert.equal(edited.paid, paid.paid);
    assert.equal(edited.version, paid.version);
    const changed = await feed(kitchen, { version: String(before.version) });
    assert.equal(changed.unchanged, false);
    assert.equal(
      (changed as Extract<KitchenFeed, { unchanged: false }>).rounds.find(
        (r) => r.orderId === o.id,
      )!.orderNote,
      "Alergia: piña",
    );
    const r = kitchenRound(o);
    await progress(r.id, "ready");
    assert.equal(
      (await note("Alergia: piña y nuez")).note,
      "Alergia: piña y nuez",
    );
    // Served: the kitchen has nothing left to read, so the edit is refused.
    await progress(r.id, "completed");
    await rejects(note("tarde"), "check_closed");
    assert.equal((await read(o.id)).note, "Alergia: piña y nuez");
    const audits = await run(
      owner,
      (tx) =>
        tx`select detail from audit where entity_id=${o.id} and operation='order.note' order by created_at`,
    );
    assert.deepEqual(
      audits.map((a) => a.detail.after),
      ["Alergia: piña", "Alergia: piña y nuez"],
    );

    // A fully voided check never takes a note.
    const v = await newOrder();
    const voided = await voidAs(owner, v, 1);
    assert.equal(voided.checkState, "closed");
    assert.equal(voided.closeReason, "voided");
    await rejects(
      run(owner, (tx) =>
        updateOrderNote(tx, owner, v.id, {
          operationId: randomUUID(),
          note: "x",
        }),
      ),
      "check_closed",
    );
  });

  await test("close requires a zero balance and replays safely", async () => {
    const o = await newOrder({ mode: "dine_in", tableId: tables[2].id });
    await rejects(close(o.id), "balance_due");
    await pay(o, o.total);
    const key = randomUUID();
    const first = await close(o.id, key);
    const replay = await close(o.id, key);
    assert.deepEqual(replay, JSON.parse(JSON.stringify(first)));
    const again = await close(o.id);
    assert.equal(again.checkState, "closed");
    const audits = await run(
      owner,
      (tx) =>
        tx`select detail from audit where entity_id=${o.id} and operation='check.closed'`,
    );
    assert.equal(audits.length, 1);
    assert.equal(audits[0].detail.reason, "released");
    await rejects(close(randomUUID()), "not_found");
    // A check settled by the previous app revision during a rolling deploy
    // stays open at balance 0; it is still listed and can be released.
    const legacy = await newOrder({ mode: "dine_in", tableId: tables[2].id });
    await asAdmin(async (tx) => {
      const [drawer] =
        await tx`select id from cash_sessions where tenant_id=${tenantId} and closed_at is null limit 1`;
      await tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,tip,received)
        values(${tenantId},${randomUUID()},${legacy.id},${drawer.id},'cash',${legacy.total},0,${legacy.total})`;
    });
    const listed = await run(owner, (tx) => tableOccupancy(tx, owner));
    const stuck = listed
      .find((t) => t.id === tables[2].id)!
      .checks.find((c) => c.id === legacy.id)!;
    assert.equal(stuck.checkState, "open");
    assert.equal(stuck.balance, 0);
    const releasedLegacy = await close(legacy.id);
    assert.equal(releasedLegacy.closeReason, "released");
  });

  await test("fully voided unpaid check closes as voided and frees its table", async () => {
    const o = await newOrder({
      mode: "dine_in",
      tableId: tables[3].id,
      lines: [{ quantity: 1 }],
    });
    const before = await run(owner, (tx) => tableOccupancy(tx, owner));
    assert.equal(before.find((t) => t.id === tables[3].id)!.checks.length, 1);
    const v = await voidAs(owner, o, 1);
    assert.equal(v.checkState, "closed");
    assert.equal(v.closeReason, "voided");
    const after = await run(owner, (tx) => tableOccupancy(tx, owner));
    assert.equal(after.find((t) => t.id === tables[3].id)!.checks.length, 0);
  });

  await test("closed checks are immutable to the runtime role", async () => {
    const o = await newOrder();
    await pay(o, o.total);
    await rejects(
      run(owner, (tx) => tx`update orders set total=total+1 where id=${o.id}`),
      /closed checks are immutable/,
    );
    await run(
      owner,
      (tx) => tx`update orders set state='completed' where id=${o.id}`,
    );
    await rejects(
      run(
        owner,
        (tx) => tx`update orders set check_state='open' where id=${o.id}`,
      ),
      /closed checks are immutable/,
    );
    await rejects(
      run(owner, (tx) => tx`delete from orders where id=${o.id}`),
      /permission denied/,
    );
  });

  await test("recovery orders and legacy inserts get consistent check states", async () => {
    const recoveryId = randomUUID(),
      legacyId = randomUUID();
    await run(owner, async (tx) => {
      for (const [id, state, number] of [
        [recoveryId, "recovery_pending", 990001],
        [legacyId, "active", 990002],
      ] as const)
        await tx`insert into orders(tenant_id,id,number,business_date,employee_id,mode,name,note,channel,total,state)
          values(${tenantId},${id},${number},current_date,${ids.owner},'takeaway','Legacy','','pos',100,${state})`;
    });
    const recovery = await read(recoveryId);
    assert.equal(recovery.checkState, "closed");
    assert.equal(recovery.closeReason, "recovery");
    const legacy = await read(legacyId);
    assert.equal(legacy.checkState, "open");
    assert.equal(legacy.closeReason, null);

    // A real reconciliation through the offline path, in its own tenant.
    const rTenant = randomUUID(),
      rEmployee = randomUUID(),
      rDevice = randomUUID(),
      rSession = randomUUID(),
      rDrawer = randomUUID(),
      rProduct = randomUUID();
    const s: Session = {
      ...session("owner", rEmployee, rTenant),
      id: rSession,
      deviceId: rDevice,
      expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
      offlineUntil: new Date(Date.now() + 4 * 3600_000).toISOString(),
      offlineLeaseVersion: 1,
      restaurant: { ...restaurant, configVersion: 1 },
    };
    await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,free_location) values(${rTenant},${organizationId},'Recuperación · Prueba','MXN','America/Mexico_City',240,true)`;
    await admin`insert into employees(tenant_id,id,name,login,secret_hash,role) values(${rTenant},${rEmployee},'Dueño','owner','fixture','owner')`;
    await admin`insert into devices(tenant_id,id,name,token_hash,free_slot) values(${rTenant},${rDevice},'Caja','fixture',1)`;
    await admin`insert into sessions(tenant_id,id,employee_id,device_id,token_hash,csrf,expires_at,offline_until,selling_authorized) values(${rTenant},${rSession},${rEmployee},${rDevice},${randomUUID()},'fixture',${s.expiresAt},${s.offlineUntil},true)`;
    await admin`insert into catalog(tenant_id,id,data) values(${rTenant},${rProduct},${admin.json(product(rProduct, "Recuperado", 100) as any)})`;
    await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at) values(${rTenant},${rDrawer},${rDevice},${rEmployee},0,now()-interval '1 minute')`;
    await tenant(sql, rTenant, (tx) => issueOfflineLease(tx, rSession));
    const sale = (mode: "takeaway" | "dine_in") => ({
      operationId: randomUUID(),
      order: {
        operationId: randomUUID(),
        lines: [line({ productId: rProduct })],
        mode,
        tableId: null,
        name: "Sin conexión",
        note: "",
        channel: "pos" as const,
      },
      expectedTotal: 100,
      received: 100,
      tip: 0,
      recordedAt: new Date().toISOString(),
      sessionId: rSession,
      cashSessionId: rDrawer,
    });
    const synced = (await tenant(sql, rTenant, (tx) =>
      synchronizeOffline(tx, s, sale("dine_in")),
    )) as Order;
    assert.equal(
      synced.checkState,
      "closed",
      "offline sales never hold a table",
    );
    assert.equal(synced.closeReason, "settled");
    const reconciled = (await tenant(sql, rTenant, (tx) =>
      reconcileOffline(tx, s, {
        sale: sale("takeaway"),
        reason: "Efectivo verificado contra el recibo del dispositivo",
        confirmed: true,
      }),
    )) as Order;
    assert.equal(reconciled.state, "recovery_pending");
    assert.equal(reconciled.checkState, "closed");
    assert.equal(reconciled.closeReason, "recovery");
  });

  await test("order list returns open checks of any age, filters and pages without gaps", async () => {
    const tag =
      "lst" +
      randomUUID()
        .replace(/[^a-f]/g, "")
        .slice(0, 8);
    const made: Order[] = [];
    for (let i = 0; i < 4; i++)
      made.push(await newOrder({ name: `${tag} uno ${i}` }));
    made.push(await newOrder({ name: `${tag} 50%_off` }));
    made.push(await newOrder({ name: `${tag} 50xxoff` }));
    made.push(
      await newOrder({
        name: `${tag} mesa`,
        mode: "dine_in",
        tableId: tables[3].id,
      }),
    );
    const aged = made[0];
    await asAdmin(async (tx) => {
      await tx`update orders set business_date=business_date-3,created_at=created_at-interval '3 days',
          number=${800000 + Math.floor(Math.random() * 100000)} where tenant_id=${tenantId} and id=${aged.id}`;
    });
    // Three checks share one microsecond-precise created_at, as orders created
    // in one transaction do; keyset pages must still return each once.
    await asAdmin(async (tx) => {
      await tx`update orders set created_at=date_trunc('second', now()) - interval '1 hour' + interval '123457 microseconds'
        where tenant_id=${tenantId} and id = any(${tx.array([made[2].id, made[3].id, made[4].id])}::uuid[])`;
    });
    const closedOne = made[1];
    await pay(closedOne, closedOne.total);
    const current = await list(owner, { q: tag });
    const currentIds = current.items.map((o) => o.id);
    assert.ok(currentIds.includes(aged.id), "an old open check stays visible");
    assert.ok(
      currentIds.includes(closedOne.id),
      "today's closed checks are listed",
    );
    assert.equal(current.items.length, 7);
    const open = await list(owner, { status: "open", q: tag });
    assert.ok(open.items.some((o) => o.id === aged.id));
    assert.ok(!open.items.some((o) => o.id === closedOne.id));
    const closed = await list(owner, { status: "closed", q: tag });
    assert.deepEqual(
      closed.items.map((o) => o.id),
      [closedOne.id],
    );
    assert.ok(closed.items.every((o) => o.checkState === "closed"));
    const agedRow = current.items.find((o) => o.id === aged.id)!;
    assert.ok(agedRow.businessDate < current.businessDate);
    const day = await list(owner, {
      status: "all",
      date: agedRow.businessDate,
      q: tag,
    });
    assert.deepEqual(
      day.items.map((o) => o.id),
      [aged.id],
    );
    const byTable = await list(owner, { table: tables[3].id, q: tag });
    assert.deepEqual(
      byTable.items.map((o) => o.id),
      [made[6].id],
    );
    const tableName = await list(owner, { q: tables[3].name });
    assert.ok(tableName.items.some((o) => o.id === made[6].id));
    assert.ok(
      tableName.items.every(
        (o) =>
          o.tableName === tables[3].name || o.name.includes(tables[3].name),
      ),
    );
    const escaped = await list(owner, { q: `${tag} 50%_off` });
    assert.deepEqual(
      escaped.items.map((o) => o.id),
      [made[4].id],
      "% and _ are literal characters",
    );
    const target = made[2];
    const byNumber = await list(owner, { q: String(target.number) });
    assert.ok(byNumber.items.some((o) => o.id === target.id));
    const row = byNumber.items.find((o) => o.id === target.id)!;
    assert.equal(row.preview[0].quantity, 1);
    assert.equal(row.balance, target.total);
    assert.equal(row.checkState, "open");
    const pages: string[] = [];
    let cursor: string | null = null;
    do {
      const page: OrderListResponse = await list(owner, {
        q: tag,
        limit: "2",
        ...(cursor ? { cursor } : {}),
      });
      assert.ok(page.items.length <= 2);
      pages.push(...page.items.map((o) => o.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(
      pages,
      currentIds,
      "keyset pages return every id once, in order",
    );
    assert.equal(new Set(pages).size, 7);
    const created = current.items.map((o) => Date.parse(o.createdAt));
    assert.deepEqual(
      created,
      [...created].sort((a, b) => b - a),
    );
    const first = await list(owner, { q: tag, limit: "2" });
    const tampered = first.nextCursor!.slice(0, -3) + "AAA";
    await rejects(list(owner, { q: tag, cursor: tampered }), "invalid_input");
    await rejects(list(owner, { q: tag, cursor: "%%%" }), "invalid_input");
    const impossible = Buffer.from(
      JSON.stringify({ t: "2026-02-30 10:00:00+00", i: randomUUID() }),
    ).toString("base64url");
    await rejects(list(owner, { q: tag, cursor: impossible }), "invalid_input");
    await rejects(
      list(owner, { status: "closed", date: "2026-02-30" }),
      "invalid_input",
    );
    await rejects(
      list(owner, { unknown: "1" }),
      /invalid_input|ZodError|unrecognized/i,
    );
    await rejects(list(session("kitchen", ids.kitchen), {}), "forbidden");
    const theirs = await list(foreign, { q: tag });
    assert.equal(theirs.items.length, 0);
  });

  await test("order list and occupancy use a constant number of statements", async () => {
    let n = 0;
    const counted = postgres(url, {
      max: 1,
      debug: (_c, query) => {
        // BEGIN, COMMIT, the tenant set_config and postgres.js's one-time type
        // lookup on a new connection are not part of the command budget.
        if (
          !/^\s*(begin|commit|rollback)\b/i.test(query) &&
          !query.includes("set_config") &&
          !query.includes("pg_catalog.pg_type")
        )
          n++;
      },
    });
    const count = async (fn: (tx: Tx) => Promise<unknown>) => {
      n = 0;
      await tenant(counted, tenantId, fn);
      return n;
    };
    try {
      const tag =
        "cnt" +
        randomUUID()
          .replace(/[^a-f]/g, "")
          .slice(0, 8);
      for (let i = 0; i < 2; i++) await newOrder({ name: `${tag} ${i}` });
      const small = await count((tx) => listOrders(tx, owner, { q: tag }));
      for (let i = 2; i < 20; i++) await newOrder({ name: `${tag} ${i}` });
      const large = await count((tx) =>
        listOrders(tx, owner, { q: tag, limit: "100" }),
      );
      assert.equal(small, 1);
      assert.equal(large, 1);
      assert.equal(await count((tx) => tableOccupancy(tx, owner)), 1);
      const page = await list(owner, { q: tag, limit: "10" });
      const one = await count((tx) => getOrders(tx, [page.items[0].id]));
      const ten = await count((tx) =>
        getOrders(
          tx,
          page.items.map((o) => o.id),
        ),
      );
      // Constant for any n; at most 10: service's 7 statements, plus one batched lookup each
      // from offline (Order.offline), fiscal (fiscalRows) and discounts (adjustmentRows).
      assert.equal(one, ten);
      assert.ok(one <= 10, `getOrders used ${one} statements`);
      const f = await full(kitchen);
      assert.equal(
        await count((tx) =>
          kitchenFeed(tx, kitchen, { version: String(f.version) }),
        ),
        1,
      );
      assert.equal(await count((tx) => kitchenFeed(tx, kitchen, {})), 3);
      // A partial index serves each literal predicate (both open-check
      // indexes qualify; on a tiny table the planner may pick either).
      const plan = async (query: (tx: Tx) => Promise<unknown>) =>
        JSON.stringify(
          await tenant(sql, tenantId, async (tx) => {
            await tx`set local enable_seqscan = off`;
            return query(tx);
          }),
        );
      assert.match(
        await plan(
          (tx) => tx`explain (format json) select id from orders o
          where o.check_state <> 'closed' order by o.created_at desc, o.id desc limit 51`,
        ),
        /orders_open_checks|orders_table_open/,
      );
      assert.match(
        await plan(
          (tx) => tx`explain (format json) select id from rounds r
          where r.state <> 'completed' and r.state <> 'offline_review' order by r.created_at desc, r.id desc limit 201`,
        ),
        /rounds_open/,
      );
    } finally {
      await counted.end();
    }
  });

  await test("getOrders batch matches getOrder for every id", async () => {
    const a = await newOrder({
      lines: [{ quantity: 2 }, { productId: drink }],
    });
    const b = await newOrder({ mode: "dine_in", tableId: tables[0].id });
    await pay(b, 1000);
    const c = await newOrder({ lines: [{ quantity: 3 }] });
    await voidAs(owner, c, 1);
    const wanted = [c.id, randomUUID(), a.id, b.id];
    const batch = await run(owner, (tx) => getOrders(tx, wanted));
    assert.deepEqual(
      batch.map((o) => o.id),
      [c.id, a.id, b.id],
      "input order is kept and missing ids are skipped",
    );
    for (const o of batch)
      assert.deepEqual(
        JSON.parse(JSON.stringify(o)),
        JSON.parse(JSON.stringify(await read(o.id))),
      );
    assert.deepEqual(await run(owner, (tx) => getOrders(tx, [])), []);
    await rejects(read(randomUUID()), "not_found");
  });

  await test("kitchen feed carries order, round and line notes with modifiers and versions", async () => {
    const o = await newOrder({
      note: "ALERGIA cacahuate",
      lines: [
        { productId: withOptions, options: [salsa], note: "Sin cebolla" },
        { productId: drink },
      ],
    });
    const second = await round(o, [{}], "Postres al final");
    assert.equal(
      second.rounds.find((r) => r.number === 2)!.note,
      "Postres al final",
    );
    const f = await full(kitchen);
    const r1 = f.rounds.find(
      (r) =>
        r.orderId === o.id && r.roundNumber === 1 && r.station === "kitchen",
    )!;
    assert.equal(r1.orderNote, "ALERGIA cacahuate");
    assert.equal(r1.lines[0].optionNames[0].es, "Salsa verde");
    assert.equal(r1.lines[0].note, "Sin cebolla");
    assert.equal(r1.roundNote, "");
    const r2 = f.rounds.find((r) => r.orderId === o.id && r.roundNumber === 2)!;
    assert.equal(r2.roundNote, "Postres al final");
    assert.equal(r2.orderNote, "ALERGIA cacahuate");
    const same = await feed(kitchen, { version: String(f.version) });
    assert.equal(same.unchanged, true);
    await progress(r1.id, "seen");
    const after = await feed(kitchen, { version: String(f.version) });
    assert.equal(after.unchanged, false);
    assert.ok(after.version > f.version);
    const bar = await full(kitchen, { station: "bar" });
    assert.ok(bar.rounds.length > 0);
    assert.ok(bar.rounds.every((r) => r.station === "bar"));
    assert.ok(bar.rounds.some((r) => r.orderId === o.id));
    await rejects(
      feed(kitchen, { station: "pantry" }),
      /invalid_input|ZodError|Invalid/i,
    );
  });

  await test("kitchen feed versions are tenant scoped", async () => {
    const theirs = await feed(foreign);
    await newOrder();
    const again = await feed(foreign, { version: String(theirs.version) });
    assert.equal(again.unchanged, true);
    const rows = await run(
      foreign,
      (tx) => tx`select tenant_id from kitchen_feed_versions`,
    );
    assert.ok(rows.every((r) => r.tenant_id === otherTenantId));
    const hidden = await run(
      foreign,
      (tx) =>
        tx`update kitchen_feed_versions set version=0 where tenant_id=${tenantId}`,
    );
    assert.equal(hidden.count, 0, "RLS hides another tenant's feed row");
    await rejects(
      run(owner, (tx) => tx`delete from kitchen_feed_versions`),
      /permission denied/,
    );
  });

  await test("recall returns a bumped round within two hours only", async () => {
    const o = await newOrder();
    const r = kitchenRound(o);
    await progress(r.id, "ready");
    await progress(r.id, "completed");
    const f = await full(kitchen);
    assert.ok(f.recent.some((x) => x.id === r.id));
    await rejects(
      run(cashier, (tx) =>
        recallRound(tx, cashier, r.id, { operationId: randomUUID() }),
      ),
      "forbidden",
    );
    await run(server, (tx) =>
      recallRound(tx, server, r.id, { operationId: randomUUID() }),
    );
    const after = await read(o.id);
    const recalled = after.rounds.find((x) => x.id === r.id)!;
    assert.equal(recalled.state, "ready");
    assert.equal(recalled.completed_at, null);
    assert.ok(recalled.ready_at);
    assert.equal(after.state, "ready");
    await rejects(
      run(kitchen, (tx) =>
        recallRound(tx, kitchen, r.id, { operationId: randomUUID() }),
      ),
      "round_not_recallable",
    );
    const old = await newOrder();
    const oldRound = kitchenRound(old);
    await progress(oldRound.id, "ready");
    await progress(oldRound.id, "completed");
    await asAdmin(
      (tx) =>
        tx`update rounds set completed_at=now()-interval '3 hours' where tenant_id=${tenantId} and id=${oldRound.id}`,
    );
    await rejects(
      run(kitchen, (tx) =>
        recallRound(tx, kitchen, oldRound.id, { operationId: randomUUID() }),
      ),
      "round_not_recallable",
    );
    const gone = await newOrder();
    const goneRound = kitchenRound(gone);
    await voidAs(owner, gone, 1);
    await asAdmin(
      (tx) =>
        tx`update rounds set state='completed',completed_at=now() where tenant_id=${tenantId} and id=${goneRound.id}`,
    );
    await rejects(
      run(kitchen, (tx) =>
        recallRound(tx, kitchen, goneRound.id, { operationId: randomUUID() }),
      ),
      "round_not_recallable",
    );
    await rejects(
      run(kitchen, (tx) =>
        recallRound(tx, kitchen, randomUUID(), { operationId: randomUUID() }),
      ),
      "not_found",
    );
  });

  await test("clear stale completes only previous-day rounds and acknowledges their voids", async () => {
    const yesterday = await newOrder({ lines: [{ quantity: 2 }] });
    await progress(kitchenRound(yesterday).id, "seen");
    const voided = await voidAs(owner, yesterday, 1);
    assert.equal(voided.voids![0].kitchenPending, true);
    await asAdmin(
      (
        tx,
      ) => tx`update orders set business_date=business_date-1,number=${700000 + Math.floor(Math.random() * 90000)}
        where tenant_id=${tenantId} and id=${yesterday.id}`,
    );
    const today = await newOrder();
    await rejects(
      run(cashier, (tx) =>
        clearStaleRounds(tx, cashier, { operationId: randomUUID() }),
      ),
      "forbidden",
    );
    await rejects(
      run(kitchen, (tx) =>
        clearStaleRounds(tx, kitchen, { operationId: randomUUID() }),
      ),
      "forbidden",
    );
    const result = await run(manager, (tx) =>
      clearStaleRounds(tx, manager, { operationId: randomUUID() }),
    );
    assert.ok(result.cleared >= 1);
    const old = await read(yesterday.id);
    assert.ok(old.rounds.every((r) => r.state === "completed"));
    assert.equal(old.voids![0].kitchenPending, false);
    const fresh = await read(today.id);
    assert.ok(fresh.rounds.every((r) => r.state === "active"));
    // Retired tickets still hold an item and were completed just now, yet they
    // never return: not in "Entregados recientes" and not recallable.
    const retired = kitchenRound(old);
    assert.ok(retired.completed_at);
    const after = await full(kitchen);
    assert.equal(
      after.recent.some((x) => x.id === retired.id),
      false,
    );
    await rejects(
      run(kitchen, (tx) =>
        recallRound(tx, kitchen, retired.id, { operationId: randomUUID() }),
      ),
      "round_not_recallable",
    );
    const [audit] = await run(
      owner,
      (tx) =>
        tx`select actor_id,detail from audit where operation='kitchen.cleared' order by created_at desc limit 1`,
    );
    assert.equal(audit.actor_id, ids.manager);
    const again = await run(manager, (tx) =>
      clearStaleRounds(tx, manager, { operationId: randomUUID() }),
    );
    assert.equal(again.cleared, 0);
  });

  await test("clear stale can be limited to the station on screen", async () => {
    const o = await newOrder({ lines: [{}, { productId: drink }] });
    await asAdmin(
      (
        tx,
      ) => tx`update orders set business_date=business_date-1,number=${700000 + Math.floor(Math.random() * 90000)}
        where tenant_id=${tenantId} and id=${o.id}`,
    );
    const states = async () =>
      Object.fromEntries(
        (await read(o.id)).rounds.map((r) => [r.station, r.state]),
      );
    await run(manager, (tx) =>
      clearStaleRounds(tx, manager, {
        operationId: randomUUID(),
        station: "bar",
      }),
    );
    assert.deepEqual(await states(), { kitchen: "active", bar: "completed" });
    const [audit] = await run(
      owner,
      (tx) =>
        tx`select detail from audit where operation='kitchen.cleared' order by created_at desc limit 1`,
    );
    assert.equal(audit.detail.station, "bar");
    await rejects(
      run(manager, (tx) =>
        clearStaleRounds(tx, manager, {
          operationId: randomUUID(),
          station: "terraza",
        }),
      ),
      /invalid_input|ZodError|invalid_enum|Invalid/i,
    );
    await run(manager, (tx) =>
      clearStaleRounds(tx, manager, {
        operationId: randomUUID(),
        station: "kitchen",
      }),
    );
    assert.deepEqual(await states(), {
      kitchen: "completed",
      bar: "completed",
    });
  });

  await test("KDS cap (LD-42): past 200 open rounds the feed carries the newest 200, oldest first, flags truncated and counts the previous-day rounds it hides", async () => {
    // A restaurant of its own, so the rounds other checks leave open do not count.
    const capTenant = randomUUID();
    const capIds = {
      owner: randomUUID(),
      manager: randomUUID(),
      kitchen: randomUUID(),
    };
    await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff) values(${capTenant},${organizationId},'Servicio tope · Prueba','MXN','America/Mexico_City',240)`;
    await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source) values(${capTenant},'active',now()+interval '14 days','fixture')`;
    for (const [role, id] of Object.entries(capIds))
      await admin`insert into employees(tenant_id,id,name,login,secret_hash,role) values(${capTenant},${id},${role + " tope"},${role},'fixture',${role})`;
    await admin`insert into devices(tenant_id,id,name,token_hash) values(${capTenant},${deviceId},'Caja tope','fixture')`;
    const taco = randomUUID(),
      water = randomUUID();
    for (const p of [
      product(taco, "Taco tope", 3000),
      product(water, "Agua tope", 2000, { station: "bar" }),
    ])
      await admin`insert into catalog(tenant_id,id,data) values(${capTenant},${p.id},${admin.json(p as any)})`;
    const capOwner = session("owner", capIds.owner, capTenant);
    const capManager = session("manager", capIds.manager, capTenant);
    const capKitchen = session("kitchen", capIds.kitchen, capTenant);
    const order = (productId = taco) =>
      newOrder({ s: capOwner, lines: [{ productId }] });
    // Oldest first: a kitchen ticket from yesterday, a bar ticket, then 200
    // kitchen tickets of today (202 open rounds, 201 in the kitchen).
    const yesterday = await order();
    await asAdmin(
      (
        tx,
      ) => tx`update orders set business_date=business_date-1,number=${700000 + Math.floor(Math.random() * 90000)}
        where tenant_id=${capTenant} and id=${yesterday.id}`,
    );
    const bar = await order(water);
    const today: Order[] = [];
    for (let i = 0; i < KITCHEN_FEED_LIMIT; i++) today.push(await order());
    const newest = today.at(-1)!;
    const ascending = (f: { rounds: { createdAt: string }[] }) =>
      f.rounds.every(
        (r, i) =>
          !i ||
          Date.parse(f.rounds[i - 1].createdAt) <= Date.parse(r.createdAt),
      );

    const all = await full(capKitchen);
    assert.equal(all.truncated, true);
    assert.equal(all.rounds.length, KITCHEN_FEED_LIMIT);
    assert.equal(all.rounds.at(-1)!.orderId, newest.id, "newest is shown");
    assert.equal(all.rounds[0].orderId, today[0].id);
    assert.ok(ascending(all), "displayed oldest first");
    assert.ok(
      !all.rounds.some((r) => [yesterday.id, bar.id].includes(r.orderId)),
      "the oldest rounds are the hidden ones",
    );
    assert.equal(all.staleCount, 1, "the hidden previous-day round counts");

    const kitchenOnly = await full(capKitchen, { station: "kitchen" });
    assert.equal(kitchenOnly.truncated, true);
    assert.equal(kitchenOnly.rounds.at(-1)!.orderId, newest.id);
    assert.equal(kitchenOnly.staleCount, 1);
    const barOnly = await full(capKitchen, { station: "bar" });
    assert.equal(barOnly.truncated, false);
    assert.deepEqual(
      barOnly.rounds.map((r) => r.orderId),
      [bar.id],
    );
    assert.equal(barOnly.staleCount, 0);

    // The alert's pointer: clear-stale retires the hidden previous-day round.
    const cleared = await run(capManager, (tx) =>
      clearStaleRounds(tx, capManager, { operationId: randomUUID() }),
    );
    assert.equal(cleared.cleared, 1);
    const afterClear = await full(capKitchen);
    assert.equal(afterClear.truncated, true, "201 rounds of today are open");
    assert.equal(afterClear.staleCount, 0);
    assert.equal(afterClear.rounds.at(-1)!.orderId, newest.id);

    // One delivered ticket brings the feed back under the cap: all shown.
    const first = kitchenRound(today[0]);
    await progress(first.id, "ready", capKitchen);
    await progress(first.id, "completed", capKitchen);
    const under = await full(capKitchen);
    assert.equal(under.truncated, false);
    assert.equal(under.rounds.length, KITCHEN_FEED_LIMIT);
    assert.equal(under.rounds[0].orderId, bar.id);
    assert.equal(under.rounds.at(-1)!.orderId, newest.id);
    assert.ok(ascending(under));
    assert.equal(under.staleCount, 0);
  });

  await test("a ticket with an unacknowledged void is not delivered until the kitchen acknowledges it", async () => {
    const o = await newOrder({ lines: [{ quantity: 3 }] });
    const r = kitchenRound(o);
    await progress(r.id, "seen");
    await progress(r.id, "ready");
    const voided = await voidAs(owner, o, 1);
    assert.equal(voided.voids!.at(-1)!.kitchenPending, true);
    await rejects(progress(r.id, "completed"), "void_ack_required");
    // Runners may deliver, but not past the kitchen's acknowledgement.
    await rejects(progress(r.id, "completed", server), "void_ack_required");
    assert.equal((await read(o.id)).rounds[0].state, "ready");
    await run(kitchen, (tx) =>
      acknowledgeVoids(tx, kitchen, r.id, { operationId: randomUUID() }),
    );
    await progress(r.id, "completed", server);
    const done = await read(o.id);
    assert.equal(done.state, "completed");
    assert.equal(done.voids!.at(-1)!.kitchenPending, false);
  });

  await test("external payments ignore received and store references only for external tenders", async () => {
    const o = await newOrder({
      mode: "dine_in",
      tableId: tables[2].id,
      lines: [{ quantity: 2 }],
    });
    const half = o.total / 2;
    const external = await pay(o, half, {
      method: "external",
      tip: 500,
      received: 0,
      externalConfirmed: true,
      reference: " 4821 ",
    });
    const ext = external.tenders[0];
    assert.equal(ext.received, half + 500);
    assert.equal(ext.external_reference, "4821");
    const cash = await pay(o, half, { reference: "4821" });
    assert.equal(cash.tenders[1].external_reference, null);
    await rejects(
      pay(await newOrder(), 100, {
        method: "external",
        received: 0,
        reference: "",
      }),
      "external_confirmation",
    );
    await rejects(
      pay(await newOrder(), 3000, { received: 100 }),
      "insufficient_cash",
    );
  });

  await test("concurrent close and round serialize", async () => {
    for (let i = 0; i < 10; i++) {
      const o = await newOrder({ mode: "dine_in", tableId: tables[i % 4].id });
      const paid = await pay(o, o.total);
      assert.equal(paid.checkState, "paid");
      const [closing, adding] = await noRetries("close vs round", () =>
        Promise.allSettled([close(o.id), round(paid)]),
      );
      const after = await read(o.id);
      // fiscal 027 (LD-15 fiscal Q2): the paid check already has its ticket, so
      // the round never lands: check_closed when the close wins the order lock,
      // fiscal_ticket_issued when the round does. The close always succeeds.
      assert.equal(closing.status, "fulfilled");
      assert.equal(adding.status, "rejected");
      assert.ok(
        ["check_closed", "fiscal_ticket_issued"].includes(
          (adding as PromiseRejectedResult).reason.code,
        ),
        (adding as PromiseRejectedResult).reason.code,
      );
      assert.equal(after.checkState, "closed");
      if (after.checkState === "closed")
        assert.equal(after.total - after.paid, 0);
    }
  });

  await test("order note edits reach open kitchen tickets and bump the feed", async () => {
    const o = await newOrder({ note: "Sin prisa" });
    const before = await full(kitchen);
    const edited = await run(cashier, (tx) =>
      updateOrderNote(tx, cashier, o.id, {
        operationId: randomUUID(),
        note: "  Alergia: nuez  ",
      }),
    );
    assert.equal(edited.note, "Alergia: nuez");
    const changed = await feed(kitchen, { version: String(before.version) });
    assert.equal(changed.unchanged, false);
    const f = changed as Extract<KitchenFeed, { unchanged: false }>;
    assert.equal(
      f.rounds.find((r) => r.orderId === o.id)!.orderNote,
      "Alergia: nuez",
    );
    const [audit] = await run(
      owner,
      (tx) =>
        tx`select detail from audit where entity_id=${o.id} and operation='order.note'`,
    );
    assert.deepEqual(audit.detail, {
      before: "Sin prisa",
      after: "Alergia: nuez",
    });
    await rejects(
      run(cashier, (tx) =>
        updateOrderNote(tx, cashier, o.id, {
          operationId: randomUUID(),
          note: "x".repeat(501),
        }),
      ),
      /invalid_input|ZodError|too_big|Too big/i,
    );
    await run(cashier, (tx) =>
      recordPrint(tx, cashier, o.id, {
        operationId: randomUUID(),
        document: "check",
        reprint: false,
      }),
    );
    const printed = await run(
      owner,
      (tx) =>
        tx`select operation from audit where entity_id=${o.id} and operation like '%printed'`,
    );
    assert.deepEqual(
      printed.map((p) => p.operation),
      ["check.printed"],
    );
  });

  await test("a lost send is found by its operation id and only unsent lines go out again", async () => {
    // A new order whose response was lost: the cart then gained a line, so
    // the same operation id now conflicts.
    const first = line(),
      second = line({ productId: drink });
    const created = randomUUID();
    const input = {
      operationId: created,
      lines: [first],
      mode: "takeaway" as const,
      tableId: null,
      name: "Respuesta perdida",
      note: "Sin prisa",
      channel: "pos",
    };
    const o = await run(cashier, (tx) => createOrder(tx, cashier, input));
    await rejects(
      run(cashier, (tx) =>
        createOrder(tx, cashier, { ...input, lines: [first, second] }),
      ),
      "operation_conflict",
    );
    const found = await run(cashier, (tx) =>
      orderForOperation(tx, cashier, created),
    );
    assert.equal(found.id, o.id);
    const draft = { ...input, lines: [first, second] };
    const next = reconcileLostSend(draft, found, randomUUID());
    assert.equal(next.sent, false);
    assert.deepEqual(
      next.draft.lines.map((l) => l.id),
      [second.id],
    );
    assert.equal(next.draft.note, "");
    assert.notEqual(next.draft.operationId, created);
    assert.deepEqual(next.rounds, [1]);
    const sent = await run(cashier, (tx) =>
      addRound(tx, cashier, found.id, {
        ...next.draft,
        expectedVersion: found.version,
      }),
    );
    assert.deepEqual(
      sent.lines.map((l) => l.id).sort(),
      [first.id, second.id].sort(),
    );

    // A round whose response was lost resolves to the same order, now current.
    const roundOp = randomUUID();
    const third = line();
    const roundInput = {
      operationId: roundOp,
      expectedVersion: sent.version,
      lines: [third],
      mode: sent.mode,
      note: "",
    };
    await run(server, (tx) => addRound(tx, server, sent.id, roundInput));
    const later = await run(server, (tx) =>
      orderForOperation(tx, server, roundOp),
    );
    assert.equal(later.id, sent.id);
    assert.ok(later.lines.some((l) => l.id === third.id));
    const done = reconcileLostSend(
      { ...roundInput, lines: [third] },
      later,
      randomUUID(),
    );
    assert.equal(done.sent, true);
    assert.deepEqual(done.rounds, [
      later.lines.find((l) => l.id === third.id)!.round,
    ]);

    // Other operations, unknown ids, other tenants and the kitchen role see nothing.
    const payment = randomUUID();
    await run(owner, (tx) =>
      recordPayment(tx, owner, sent.id, {
        operationId: payment,
        amount: 100,
        tip: 0,
        received: 100,
        method: "cash",
      }),
    );
    await rejects(
      run(cashier, (tx) => orderForOperation(tx, cashier, payment)),
      "not_found",
    );
    await rejects(
      run(cashier, (tx) => orderForOperation(tx, cashier, randomUUID())),
      "not_found",
    );
    await rejects(
      run(foreign, (tx) => orderForOperation(tx, foreign, created)),
      "not_found",
    );
    await rejects(
      run(kitchen, (tx) => orderForOperation(tx, kitchen, created)),
      "forbidden",
    );
  });

  await test("refund and paid-out replays with one operation id record once", async () => {
    const o = await newOrder();
    const paid = await pay(o, o.total);
    const body = {
      operationId: randomUUID(),
      tenderId: paid.tenders[0].id,
      amount: 1000,
      reason: "Devolución de prueba",
      disposition: "discard",
    };
    const first = await run(owner, (tx) => refund(tx, owner, body));
    const second = await run(owner, (tx) => refund(tx, owner, body));
    assert.equal(first.refunded, 1000);
    assert.equal(second.refunded, 1000);
    const rows = await run(
      owner,
      (tx) => tx`select id from refunds where tender_id=${body.tenderId}`,
    );
    assert.equal(rows.length, 1);
    const before = (await run(owner, (tx) => cashSummary(tx, owner)))!.expected;
    const paidOut = {
      operationId: randomUUID(),
      amount: 500,
      reason: "Compra de hielo",
    };
    await run(owner, (tx) => recordPaidOut(tx, owner, paidOut));
    await run(owner, (tx) => recordPaidOut(tx, owner, paidOut));
    const after = (await run(owner, (tx) => cashSummary(tx, owner)))!.expected;
    assert.equal(after, before - 500);
    await rejects(
      run(cashier, (tx) =>
        recordPaidOut(tx, cashier, { ...paidOut, operationId: randomUUID() }),
      ),
      "forbidden",
    );
  });

  await test("kitchen feed and progress do not deadlock with concurrent payments and rounds", async () => {
    const settle = (a: Order, b: Order) =>
      run(owner, (tx) =>
        recordSettlement(tx, owner, {
          operationId: randomUUID(),
          orders: [
            { id: a.id, amount: 100 },
            { id: b.id, amount: 100 },
          ],
          received: 200,
        }),
      );
    const expected = [
      "stale_order",
      "invalid_transition",
      "void_exceeds_unpaid",
      "overpayment",
      "check_closed",
      "unallocated_history",
      // SVC-K6: completing a round whose void the kitchen has not acknowledged.
      "void_ack_required",
      // fiscal 027: a round on the paid (ticketed) table check.
      "fiscal_ticket_issued",
    ];
    // Three bursts of 20 mixed commands on 3 orders: rounds, progress, voids,
    // payments and grouped settlements that interleave order and drawer locks.
    for (let burst = 0; burst < 3; burst++) {
      const orders = [
        await newOrder({ lines: [{ quantity: 6 }] }),
        await newOrder({ lines: [{ quantity: 6 }] }),
        await newOrder({
          mode: "dine_in",
          tableId: tables[0].id,
          lines: [{ quantity: 6 }],
        }),
      ];
      const fresh = (i: number) => read(orders[i].id);
      const commands: (() => Promise<unknown>)[] = [];
      for (let i = 0; i < 20; i++) {
        const k = i % 3;
        const kind = (i + burst) % 5;
        commands.push(async () => {
          const o = await fresh(k);
          if (kind === 0) return round(o);
          if (kind === 1) {
            const r = o.rounds.find((x) => x.state !== "completed");
            return (
              r && progress(r.id, r.state === "active" ? "ready" : "completed")
            );
          }
          if (kind === 2) return voidAs(owner, o, 1);
          if (kind === 3) return pay(o, 100);
          return settle(o, await fresh((k + 1) % 3));
        });
      }
      // LO-R9 (PLATFORM-LOCKS-3): no deadlock may hide behind tenant()'s retry.
      const results = await noRetries(`kitchen mix burst ${burst}`, () =>
        Promise.allSettled(commands.map((c) => c())),
      );
      assert.ok(
        results.filter((r) => r.status === "fulfilled").length >= 5,
        "the mix must actually commit commands concurrently",
      );
      const failures = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => String(r.reason?.code ?? r.reason));
      assert.equal(
        failures.filter((c) => c === "40P01").length,
        0,
        "no deadlocks",
      );
      assert.deepEqual(
        failures.filter((c) => !expected.includes(c)),
        [],
      );
    }
  });

  console.log(`${checks} service lifecycle checks passed`);
} finally {
  await sql.end();
  await admin.end();
}
