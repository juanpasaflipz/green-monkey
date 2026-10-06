// Public QR/kiosk ordering (032/033) against a real database: links, holds,
// staff decisions, durable caps, the diner HTTP router and the DB-9 checks.
// Every run creates its own fictional restaurants and never deletes: accepted
// holds write append-only ledgers (stock movements; fiscal from 027), so
// cleanups are impossible by design (LD-12 pattern).
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import postgres from "postgres";
import { ZodError } from "zod";
import { password } from "../server/auth.js";
import { checkRole, connect, tenant, type Tx } from "../server/db.js";
import { makeRoute } from "../server/http.js";
import {
  catalog,
  createOrder,
  getOrder,
  recordPayment,
} from "../server/orders.js";
import { voidLines } from "../server/voids.js";
import { closeCash } from "../server/operations.js";
import { closeCheck, tableOccupancy } from "../server/checks.js";
import { archiveTable, tablesWithOpenChecks } from "../server/floor.js";
import { publicOrdering } from "../server/public-ordering.js";
import {
  createLink,
  createTableLinks,
  listLinks,
  orderingSettings,
  revokeLink,
  rotateLink,
  saveOrderingSettings,
  setPaused,
} from "../server/public-links.js";
import {
  acceptHold,
  inbox,
  inboxSummary,
  rejectHold,
} from "../server/public-holds.js";
import { holdStatus } from "../server/public-diner.js";
import {
  linkHash,
  newPublicToken,
  statusHash,
} from "../server/public-tokens.js";
import { PUBLIC_RATES } from "../server/public-limits.js";
import * as publicOrderingRoutes from "../server/routes/public-ordering.js";
import {
  applyGrantsTx,
  applyMigrations,
  readMigrations,
} from "../server/ops/schema.js";
import {
  DomainError,
  businessDate,
  quote,
  sum,
  type Session,
} from "../shared/domain.js";
import {
  LINK_HEADER,
  STATUS_HEADER,
  type DinerHoldView,
  type InboxResponse,
  type PublicMenuView,
} from "../shared/public-ordering.js";
import { isolatedTarget } from "./isolated-target.js";
import { setLogSink } from "../server/logging.js";

// The runner and the router log through the shared sink; keep the output to PASS lines.
const logLines: string[] = [];
setLogSink((line) => logLines.push(line));

const { runtime: url, migration } = isolatedTarget(process.env);
const sql = connect(url),
  admin = postgres(migration, { max: 2, onnotice: () => {} });
await checkRole(sql);

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (e: any) => {
    // A schema failure is what the route answers as 400 invalid_input.
    const got = e instanceof ZodError ? "invalid_input" : (e.code ?? e.message);
    assert.equal(got, code, String(e.stack ?? e));
    return true;
  });
}
const op = () => randomUUID();
const restaurant = {
  name: "Pedidos en línea · Prueba",
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
};
const roles = ["owner", "manager", "cashier", "server", "kitchen"] as const;
type Role = (typeof roles)[number];

type Fixture = {
  tenantId: string;
  terminal: string;
  bare: string;
  personal: string;
  ids: Record<Role, string>;
  s: Record<Role, Session>;
  tables: { id: string; name: string }[];
  p: {
    taco: string;
    salsa: string;
    roja: string;
    verde: string;
    queso: string;
    open: string;
    scarce: string;
    free: string;
  };
  tortilla: string;
  short: string;
};

/** Superuser fixture writes with the tenant set (FORCE RLS triggers read it). */
const asAdmin = <T>(tenantId: string, fn: (tx: any) => Promise<T>) =>
  admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id',${tenantId},true)`;
    return fn(tx);
  }) as Promise<T>;
const run = <T>(s: Session, fn: (tx: Tx) => Promise<T>) =>
  tenant(sql, s.tenantId, fn);

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
  cost: 100,
  version: 1,
  recipe: [],
  ...extra,
});

/** A fresh restaurant: staff, a terminal with an open drawer, a menu and three tables. */
async function makeTenant(
  label: string,
  o: { staffOnline?: boolean; plan?: "pro" | "free" } = {},
): Promise<Fixture> {
  const organizationId = randomUUID(),
    tenantId = randomUUID(),
    terminal = randomUUID(),
    bare = randomUUID(),
    personal = randomUUID();
  const ids = Object.fromEntries(roles.map((r) => [r, randomUUID()])) as Record<
    Role,
    string
  >;
  const tables = [1, 2, 3].map((n) => ({
    id: randomUUID(),
    name: `Mesa 0${n}`,
  }));
  const p = {
    taco: randomUUID(),
    salsa: randomUUID(),
    roja: randomUUID(),
    verde: randomUUID(),
    queso: randomUUID(),
    open: randomUUID(),
    scarce: randomUUID(),
    free: randomUUID(),
  };
  const tortilla = randomUUID(),
    short = randomUUID();
  await admin`insert into organizations(id,name) values(${organizationId},${"Pedidos " + label})`;
  await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,free_location)
    values(${tenantId},${organizationId},${restaurant.name},'MXN','America/Mexico_City',240,true)`;
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source)
    values(${tenantId},${o.plan === "free" ? "free" : "active"},${o.plan === "free" ? null : admin`now()+interval '1 day'`},'fixture')`;
  await asAdmin(tenantId, async (tx) => {
    for (const r of roles)
      await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
        values(${tenantId},${ids[r]},${"Pedidos " + r},${r + "-" + ids[r].slice(0, 8)},${password("fixture")},${r})`;
    await tx`insert into devices(tenant_id,id,name,token_hash,kind,free_slot) values(${tenantId},${terminal},'Caja pedidos',${"fx-" + terminal},'terminal',1)`;
    await tx`insert into devices(tenant_id,id,name,token_hash,kind) values(${tenantId},${bare},'Caja sin cajón',${"fx-" + bare},'terminal')`;
    await tx`insert into devices(tenant_id,id,name,token_hash,kind) values(${tenantId},${personal},'Owner browser',${"fx-" + personal},'personal')`;
    for (const [i, t] of tables.entries())
      await tx`insert into dining_tables(tenant_id,id,name,position) values(${tenantId},${t.id},${t.name},${i + 1})`;
    await tx`insert into stock_items(tenant_id,id,name,unit,kind,threshold) values(${tenantId},${tortilla},'Tortilla','piece','prepared',0)`;
    await tx`insert into stock_items(tenant_id,id,name,unit,kind,threshold) values(${tenantId},${short},'Escaso','piece','prepared',0)`;
    await tx`insert into stock_movements(tenant_id,id,stock_id,quantity,cause,cause_id,reason,actor_id)
      values(${tenantId},${randomUUID()},${tortilla},100000,'opening','fixture','Fixture',${ids.owner})`;
    const products = [
      product(p.taco, "Taco de prueba", 4500, {
        recipe: [{ stockId: tortilla, quantity: "1" }],
      }),
      product(p.salsa, "Taco con salsa", 4000, {
        groups: [
          {
            id: randomUUID(),
            name: { es: "Salsa", en: "Salsa" },
            min: 1,
            max: 1,
            options: [
              {
                id: p.roja,
                name: { es: "Salsa roja", en: "Red salsa" },
                price: 0,
                available: true,
              },
              {
                id: p.verde,
                name: { es: "Salsa verde", en: "Green salsa" },
                price: 500,
                available: true,
              },
            ],
          },
          {
            id: randomUUID(),
            name: { es: "Extras", en: "Extras" },
            min: 0,
            max: 2,
            options: [
              {
                id: p.queso,
                name: { es: "Queso", en: "Cheese" },
                price: 1500,
                available: true,
              },
            ],
          },
        ],
      }),
      product(p.open, "Varios prueba", 0, { openAmount: true }),
      product(p.scarce, "Tostada escasa", 2000, {
        recipe: [{ stockId: short, quantity: "1" }],
      }),
      product(p.free, "Salsa extra gratis", 0),
    ];
    for (const item of products)
      await tx`insert into catalog(tenant_id,id,data) values(${tenantId},${item.id},${tx.json(item)})`;
    await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${tenantId},${randomUUID()},${terminal},${ids.owner},0)`;
  });
  const s = Object.fromEntries(
    roles.map((r) => [
      r,
      {
        id: randomUUID(),
        tenantId,
        employeeId: ids[r],
        name: "Pedidos " + r,
        role: r,
        deviceId: terminal,
        expiresAt: "",
        offlineUntil: "",
        csrf: "",
        restaurant,
      } satisfies Session,
    ]),
  ) as Record<Role, Session>;
  const f: Fixture = {
    tenantId,
    terminal,
    bare,
    personal,
    ids,
    s,
    tables,
    p,
    tortilla,
    short,
  };
  if (o.staffOnline !== false) await staffSession(f, "cashier", terminal);
  return f;
}

/** A session row seen `ageSeconds` ago (staff liveness reads sessions.last_seen_at). */
async function staffSession(
  f: Fixture,
  role: Role,
  deviceId: string,
  ageSeconds = 0,
) {
  await asAdmin(
    f.tenantId,
    (
      tx,
    ) => tx`insert into sessions(tenant_id,id,employee_id,device_id,token_hash,csrf,expires_at,
        offline_until,created_at,last_seen_at,authenticated_at,absolute_expires_at)
      values(${f.tenantId},${randomUUID()},${f.ids[role]},${deviceId},${"fx-" + randomUUID()},'fixture',
        now()+interval '8 hours',now()+interval '4 hours',now()-make_interval(secs=>${ageSeconds}),
        now()-make_interval(secs=>${ageSeconds}),now(),now()+interval '16 hours')`,
  );
}

/** A terminal PIN session whose last PIN is older than the step-up window. */
const stale = (s: Session, deviceKind: "terminal" | "personal" = "terminal") =>
  ({
    ...s,
    access: {
      absoluteExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      authenticatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      deviceName: "Caja pedidos",
      deviceKind,
      idleLockSeconds: null,
      ownerAccount: false,
    },
  }) satisfies Session;
/** A Google-entered owner session on the owner's own personal device. */
const ownerGoogle = (s: Session) =>
  ({
    ...stale(s, "personal"),
    access: { ...stale(s, "personal").access, ownerAccount: true },
  }) satisfies Session;

// ---------------------------------------------------------------- diner HTTP

type Reply<T = any> = {
  status: number;
  body: T;
  headers: Headers;
};
/**
 * The real diner router behind loopback proxy trust, so every request may
 * claim its own client address with X-Forwarded-For (independent limiter
 * buckets per simulated diner unless a test pins one).
 */
async function serve(db: postgres.Sql = sql) {
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "256kb" }));
  app.use("/api/public", publicOrdering(db));
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) =>
      res
        .status(
          error instanceof DomainError
            ? error.status
            : error instanceof ZodError
              ? 400
              : 500,
        )
        .json({
          error:
            error instanceof DomainError
              ? error.code
              : error instanceof ZodError
                ? "invalid_input"
                : String(error),
        }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/public`;
  const call = async (
    method: "GET" | "POST",
    path: string,
    o: { link?: string; status?: string; body?: unknown; ip?: string } = {},
  ): Promise<Reply> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-forwarded-for": o.ip ?? randomIp(),
    };
    if (o.link !== undefined) headers[LINK_HEADER] = o.link;
    if (o.status !== undefined) headers[STATUS_HEADER] = o.status;
    const r = await fetch(origin + path, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(o.body ?? {}) : undefined,
    });
    const text = await r.text();
    return {
      status: r.status,
      body: text ? JSON.parse(text) : null,
      headers: r.headers,
    };
  };
  return {
    call,
    menu: (link: string, ip?: string) =>
      call("GET", "/menu", { link, ip }) as Promise<Reply<PublicMenuView>>,
    revision: (link: string, ip?: string) =>
      call("GET", "/revision", { link, ip }),
    submit: (link: string, body: unknown, ip?: string) =>
      call("POST", "/orders", { link, body, ip }) as Promise<
        Reply<DinerHoldView>
      >,
    status: (link: string, status: string, ip?: string) =>
      call("GET", "/status", { link, status, ip }) as Promise<
        Reply<DinerHoldView>
      >,
    cancel: (link: string, status: string, ip?: string) =>
      call("POST", "/status/cancel", { link, status, ip }) as Promise<
        Reply<DinerHoldView>
      >,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
const randomIp = () =>
  `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0] % 250) + 1}`;

type LineSpec = { productId: string; quantity?: number; options?: string[] };
/** A diner order body with the server's own quote as expectedTotal. */
async function body(f: Fixture, lines: LineSpec[], over: object = {}) {
  const input = lines.map((l) => ({
    id: randomUUID(),
    productId: l.productId,
    quantity: l.quantity ?? 1,
    options: l.options ?? [],
  }));
  const menu = await run(f.s.owner, (tx) => catalog(tx));
  const expectedTotal = sum(
    quote(
      input.map((l) => ({ ...l, note: "" })),
      menu,
      false,
    ).map((l) => l.total),
  );
  return {
    operationId: randomUUID(),
    statusKey: newPublicToken(),
    lines: input,
    name: "",
    note: "",
    expectedTotal,
    ...over,
  };
}
const holdOf = async (f: Fixture, b: { operationId: string }) => {
  const [h] = await asAdmin(
    f.tenantId,
    (tx) =>
      tx`select * from public_order_holds where operation_id=${b.operationId}`,
  );
  assert(h, "hold row");
  return h;
};

const link = (
  f: Fixture,
  input:
    | { kind: "table"; tableId: string }
    | { kind: "counter" | "kiosk"; label: string },
) => run(f.s.manager, (tx) => createLink(tx, f.s.manager, input));

const accept = (
  f: Fixture,
  holdId: string,
  p: object = {},
  s: Session = f.s.cashier,
) =>
  run(s, (tx) =>
    acceptHold(tx, s, holdId, {
      operationId: randomUUID(),
      target: { kind: "new" },
      ...p,
    }),
  );
const reject = (
  f: Fixture,
  holdId: string,
  p: object = {},
  s: Session = f.s.cashier,
) =>
  run(s, (tx) =>
    rejectHold(tx, s, holdId, {
      operationId: randomUUID(),
      reason: "unavailable",
      ...p,
    }),
  );

/**
 * A complete hold row written directly (fixtures bypass the diner caps). An
 * expired one is inserted already expired: the transition trigger forbids
 * moving expires_at or keeping state pending in an update.
 */
async function insertHold(
  f: Fixture,
  l: { id: string; tableId: string | null; channel: "qr" | "kiosk" },
  o: {
    expired?: boolean;
    policy?: "accept" | "pay_first";
    productId?: string;
    price?: number;
  } = {},
) {
  const statusKey = newPublicToken();
  const row = await asAdmin(f.tenantId, async (tx) => {
    const date = businessDate(
      new Date().toISOString(),
      restaurant.timezone,
      restaurant.cutoff,
    );
    const [n] =
      await tx`insert into public_hold_numbers(tenant_id,business_date,value)
      values(${f.tenantId},${date},1) on conflict(tenant_id,business_date)
      do update set value=public_hold_numbers.value+1 returning value`;
    const lineId = randomUUID();
    const price = o.price ?? 4500;
    const [h] =
      await tx`insert into public_order_holds(tenant_id,id,link_id,operation_id,request_hash,
        status_key_hash,business_date,number,channel,mode,table_id,policy,lines,priced,quoted_total,
        menu_revision,order_operation_id,created_at,expires_at)
      values(${f.tenantId},${randomUUID()},${l.id},${randomUUID()},${"0".repeat(64)},
        ${statusHash(statusKey)},${date},${n.value},${l.channel},
        ${l.tableId ? "dine_in" : "takeaway"},${l.tableId},${o.policy ?? "accept"},
        ${tx.json([{ id: lineId, productId: o.productId ?? f.p.taco, quantity: 1, options: [] }])},
        ${tx.json([{ id: lineId, quantity: 1, name: { es: "Taco de prueba", en: "Taco de prueba" }, optionNames: [], unitPrice: price, total: price }])},
        ${price},0,${randomUUID()},
        ${o.expired ? tx`now()-interval '40 minutes'` : tx`now()`},
        ${o.expired ? tx`now()-interval '10 minutes'` : tx`now()+interval '30 minutes'`})
      returning *`;
    return h;
  });
  return { row, statusKey };
}

const count = async (tenantId: string, table: string) => {
  const [r] = await asAdmin(
    tenantId,
    (tx) =>
      tx`select count(*)::int as n from ${tx(table)} where tenant_id=${tenantId}`,
  );
  return r.n as number;
};
const feedVersion = async (tenantId: string) => {
  const [r] = await asAdmin(
    tenantId,
    (tx) =>
      tx`select coalesce(max(version),0)::int as v from kitchen_feed_versions where tenant_id=${tenantId}`,
  );
  return r.v as number;
};
/** Sales-side rows a hold must never create before acceptance. */
async function salesRows(tenantId: string) {
  const out: Record<string, number> = {};
  for (const t of [
    "orders",
    "order_lines",
    "rounds",
    "stock_movements",
    "jobs",
    "tenders",
  ])
    out[t] = await count(tenantId, t);
  out.feed = await feedVersion(tenantId);
  const [fiscal] =
    await admin`select to_regclass('public.fiscal_tickets') is not null as present`;
  if (fiscal.present)
    out.fiscal_tickets = await count(tenantId, "fiscal_tickets");
  return out;
}

try {
  const a = await makeTenant("A");
  const b = await makeTenant("B");
  const pub = await serve();

  // ------------------------------------------------------------ migrations

  await test("1+3. 032/033 apply in order as a non-superuser owner; 033 fails on another tenant's bad row until it is repaired; re-running is a no-op; the runner applies a no-transaction newest file with the grants hook", async () => {
    const suffix = randomBytes(5).toString("hex");
    const role = `gm_pub_mig_${suffix}`;
    const secret = randomBytes(16).toString("hex");
    const database = `green_monkey_pub_mig_${suffix}_test`;
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
      max: 2,
      onnotice: () => {},
    });
    const root = postgres(urlFor(), { max: 1, onnotice: () => {} });
    try {
      const files = readMigrations();
      const before = files.filter((m) => m.number < 32);
      const grants = (tx: Tx) =>
        applyGrantsTx(tx, { role: "gm_app", database });
      // The grants manifest belongs to this revision (it names 032's
      // tables), so the older files apply without it.
      assert.equal(
        (await applyMigrations(owner, before)).length,
        before.length,
      );
      // History the previous revision could write: another tenant's order
      // with a state outside the 032 set (no constraint yet).
      const org = randomUUID(),
        tenantId = randomUUID(),
        employee = randomUUID(),
        orderId = randomUUID();
      await root.begin(async (tx) => {
        await tx`insert into organizations(id,name) values(${org},'DB-9 fixture')`;
        await tx`insert into restaurants(id,organization_id,name) values(${tenantId},${org},'DB-9')`;
        await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
          values(${tenantId},${employee},'Caja','caja','x','cashier')`;
        await tx`insert into orders(tenant_id,id,number,business_date,employee_id,mode,name,note,channel,state,total)
          values(${tenantId},${orderId},1,'2026-03-01',${employee},'takeaway','','','pos','legacy',0)`;
      });
      const [who] =
        await owner`select rolsuper, rolbypassrls, current_setting('app.tenant_id', true) as tenant from pg_roles where rolname=current_user`;
      assert.deepEqual(
        { super: who.rolsuper, bypass: who.rolbypassrls },
        { super: false, bypass: false },
      );
      await assert.rejects(
        applyMigrations(owner, files, {
          beforeLastRecord: grants,
          sleep: async () => {},
        }),
        (e: any) =>
          e.code === "migration_failed" &&
          e.detail?.file === "033_state_checks_validate.sql",
      );
      const constraints = async () =>
        Object.fromEntries(
          (
            await root`select conname,convalidated from pg_constraint
              where conname in ('orders_state_valid','orders_channel_valid','orders_mode_valid','rounds_state_valid','jobs_state_valid')`
          ).map((r) => [r.conname, r.convalidated]),
        );
      // 032 committed: the constraints exist and already block new bad writes.
      assert.deepEqual(await constraints(), {
        orders_state_valid: false,
        orders_channel_valid: false,
        orders_mode_valid: false,
        rounds_state_valid: false,
        jobs_state_valid: false,
      });
      await assert.rejects(
        root`update orders set state='held' where id=${orderId}`,
        (e: any) => e.code === "23514",
      );
      // Repair (docs/PUBLIC_ORDERING.md "DB-9 validation") and re-run.
      await root`update orders set state='completed' where id=${orderId}`;
      assert.deepEqual(
        await applyMigrations(owner, files, { beforeLastRecord: grants }),
        ["033_state_checks_validate.sql"],
      );
      assert.deepEqual(Object.values(await constraints()), [
        true,
        true,
        true,
        true,
        true,
      ]);
      // The grants hook ran inside the no-transaction file's record step.
      const [granted] =
        await root`select has_table_privilege('gm_app','public_order_holds','INSERT') as ok`;
      assert.equal(granted.ok, true);
      assert.deepEqual(await applyMigrations(owner, files), []);
      // VALIDATE of a valid constraint is a no-op.
      await owner.unsafe(
        "ALTER TABLE orders VALIDATE CONSTRAINT orders_state_valid",
      );
    } finally {
      await owner.end();
      await root.end();
      await admin.unsafe(`drop database if exists "${database}" with (force)`);
      await admin.unsafe(`drop role if exists "${role}"`);
    }
  });

  await test("1b. the shared test database has every DB-9 check validated", async () => {
    const rows =
      await admin`select conname,convalidated from pg_constraint where conname like any(array['orders_%_valid','rounds_state_valid','jobs_state_valid'])`;
    const v = Object.fromEntries(rows.map((r) => [r.conname, r.convalidated]));
    for (const name of [
      "orders_state_valid",
      "orders_channel_valid",
      "orders_mode_valid",
      "rounds_state_valid",
      "jobs_state_valid",
    ])
      assert.equal(v[name], true, name);
  });

  await test("2. DB-9: the runtime role cannot write a state outside the sets, and every allowed value is accepted", async () => {
    const order = await run(a.s.owner, (tx) =>
      createOrder(tx, a.s.owner, {
        operationId: op(),
        lines: [
          {
            id: randomUUID(),
            productId: a.p.taco,
            quantity: 1,
            options: [],
            note: "",
          },
        ],
        mode: "takeaway",
        tableId: null,
        name: "DB-9",
        note: "",
        channel: "pos",
      }),
    );
    const bad = async (q: (tx: Tx) => Promise<unknown>) =>
      assert.rejects(run(a.s.owner, q), (e: any) => e.code === "23514");
    await bad((tx) => tx`update orders set state='held' where id=${order.id}`);
    await bad((tx) => tx`update orders set channel='web' where id=${order.id}`);
    await bad((tx) => tx`update orders set mode='eat_in' where id=${order.id}`);
    await bad(
      (tx) => tx`update rounds set state='bogus' where order_id=${order.id}`,
    );
    await bad(
      (tx) =>
        tx`insert into jobs(tenant_id,id,kind,dedupe_key,payload,state) values(${a.tenantId},${randomUUID()},'db9','x',${tx.json({})},'failed')`,
    );
    await run(a.s.owner, async (tx) => {
      for (const v of [
        "active",
        "ready",
        "completed",
        "cancelled",
        "recovery_pending",
        "recovery_reviewed",
      ])
        await tx`update orders set state=${v} where id=${order.id}`;
      for (const v of ["pos", "qr", "kiosk", "offline"])
        await tx`update orders set channel=${v} where id=${order.id}`;
      for (const v of ["takeaway", "dine_in", "delivery"])
        await tx`update orders set mode=${v} where id=${order.id}`;
      for (const v of ["active", "ready", "completed", "offline_review"])
        await tx`update rounds set state=${v} where order_id=${order.id}`;
      for (const v of [
        "queued",
        "available",
        "running",
        "done",
        "blocked",
        "dead",
      ])
        await tx`insert into jobs(tenant_id,id,kind,dedupe_key,payload,state) values(${a.tenantId},${randomUUID()},'db9',${v},${tx.json({})},${v})`;
      // Roll the probe back: the order stays as createOrder left it.
      throw new Error("rollback");
    }).catch((e) => assert.equal(e.message, "rollback"));
  });

  await test("4. lookup policy: no tenant and no hash sees nothing; a hash sees exactly its link, never writable through the lookup", async () => {
    const la = await link(a, { kind: "counter", label: "Lookup A" });
    const hidden = await sql.begin(
      (tx) => tx`select count(*)::int as n from public_links`,
    );
    assert.equal(hidden[0].n, 0);
    const seen = await sql.begin(async (tx) => {
      await tx`select set_config('app.public_link_hash',${linkHash(la.token)},true)`;
      return tx`select id from public_links`;
    });
    assert.deepEqual(
      seen.map((r) => r.id),
      [la.id],
    );
    const cross = await sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${b.tenantId},true)`;
      await tx`select set_config('app.public_link_hash',${linkHash(la.token)},true)`;
      const rows =
        await tx`select id,tenant_id from public_links where token_hash=${linkHash(la.token)}`;
      const updated =
        await tx`update public_links set label='x' where id=${la.id} returning id`;
      return { rows, updated: updated.length };
    });
    assert.deepEqual(
      cross.rows.map((r) => r.id),
      [la.id],
    );
    assert.equal(cross.updated, 0);
  });

  await test("25. grants: no DELETE on the four tables; identity columns are not updatable; decision columns are", async () => {
    const la = await link(a, { kind: "counter", label: "Grants" });
    const b1 = await body(a, [{ productId: a.p.taco }]);
    assert.equal((await pub.submit(la.token, b1)).status, 200);
    const h = await holdOf(a, b1);
    const denied = async (q: (tx: Tx) => Promise<unknown>) =>
      assert.rejects(run(a.s.owner, q), (e: any) => e.code === "42501");
    for (const t of [
      "public_ordering_settings",
      "public_links",
      "public_hold_numbers",
      "public_order_holds",
    ])
      await denied((tx) => tx`delete from ${tx(t)}`);
    await denied(
      (tx) =>
        tx`update public_links set token_hash=${"f".repeat(64)} where id=${la.id}`,
    );
    await denied(
      (tx) => tx`update public_order_holds set lines='[]' where id=${h.id}`,
    );
    await denied(
      (tx) =>
        tx`update public_hold_numbers set business_date='2020-01-01'::date`,
    );
    await run(
      a.s.owner,
      (tx) => tx`update public_links set label='Grants 2' where id=${la.id}`,
    );
    await run(
      a.s.owner,
      (tx) =>
        tx`update public_order_holds set state='cancelled',decided_at=now() where id=${h.id}`,
    );
  });

  // ----------------------------------------------------------------- links

  await test("5. table link: a 128-bit token stored only as its hash, never in operations; one active link per table; archived table and Free refused", async () => {
    const t = await makeTenant("links");
    const l = await link(t, { kind: "table", tableId: t.tables[0].id });
    assert.match(l.token, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(l.path, "/qr#" + l.token);
    assert.equal(l.tableName, "Mesa 01");
    const [row] = await asAdmin(
      t.tenantId,
      (tx) => tx`select token_hash from public_links where id=${l.id}`,
    );
    assert.equal(
      row.token_hash,
      createHash("sha256")
        .update("gm-public-link-v1:" + l.token)
        .digest("hex"),
    );
    const [leak] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select count(*)::int as n from operations where result::text like ${"%" + l.token + "%"}`,
    );
    assert.equal(leak.n, 0);
    const [audit] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select detail from audit where operation='public.link_created' and entity_id=${l.id}`,
    );
    assert.equal(audit.detail.ref, l.ref);
    assert(!JSON.stringify(audit.detail).includes(l.token));
    await rejects(
      link(t, { kind: "table", tableId: t.tables[0].id }),
      "public_link_exists",
    );
    await asAdmin(
      t.tenantId,
      (tx) =>
        tx`update dining_tables set archived_at=now() where id=${t.tables[2].id}`,
    );
    await rejects(
      link(t, { kind: "table", tableId: t.tables[2].id }),
      "invalid_table",
    );
    await admin`update restaurant_entitlements set status='free',access_until=null where tenant_id=${t.tenantId}`;
    await rejects(
      link(t, { kind: "table", tableId: t.tables[1].id }),
      "pro_required",
    );
    // Cashiers never create links.
    await rejects(
      run(t.s.cashier, (tx) =>
        createLink(tx, t.s.cashier, { kind: "counter", label: "x" }),
      ),
      "forbidden",
    );
  });

  await test("6. rotate: the old token dies at once, the new one works, a pending hold of the old link stays acceptable and readable", async () => {
    const t = await makeTenant("rotate");
    const old = await link(t, { kind: "table", tableId: t.tables[0].id });
    const b1 = await body(t, [{ productId: t.p.taco }]);
    assert.equal((await pub.submit(old.token, b1)).status, 200);
    const fresh = await run(t.s.manager, (tx) =>
      rotateLink(tx, t.s.manager, old.id),
    );
    const [rows] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select (select revoke_reason from public_links where id=${old.id}) as reason,
          (select replaces_id from public_links where id=${fresh.id}) as replaces`,
    );
    assert.deepEqual(
      { reason: rows.reason, replaces: rows.replaces },
      { reason: "rotated", replaces: old.id },
    );
    assert.equal(fresh.tableId, old.tableId);
    const dead = await pub.menu(old.token);
    assert.deepEqual(
      [dead.status, dead.body.error],
      [404, "public_link_invalid"],
    );
    assert.equal((await pub.menu(fresh.token)).status, 200);
    const status = await pub.status(old.token, b1.statusKey);
    assert.deepEqual([status.status, status.body.state], [200, "pending"]);
    const h = await holdOf(t, b1);
    const accepted = await accept(t, h.id);
    assert.equal(accepted.hold.state, "accepted");
    assert.equal(
      (await pub.status(old.token, b1.statusKey)).body.state,
      "accepted",
    );
  });

  await test("7. revoke: the menu refuses the token; the trigger keeps identity and revocation immutable; a label edit while active is allowed", async () => {
    const t = await makeTenant("revoke");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    await run(
      t.s.owner,
      (tx) => tx`update public_links set label='Ventanilla 2' where id=${l.id}`,
    );
    const key = op();
    const v = await run(t.s.manager, (tx) =>
      revokeLink(tx, t.s.manager, l.id, { operationId: key }),
    );
    assert(v.revokedAt);
    // Idempotent replay and a second revoke of the same link.
    assert.deepEqual(
      await run(t.s.manager, (tx) =>
        revokeLink(tx, t.s.manager, l.id, { operationId: key }),
      ),
      v,
    );
    assert.equal(
      (
        await run(t.s.manager, (tx) =>
          revokeLink(tx, t.s.manager, l.id, { operationId: op() }),
        )
      ).revokedAt,
      v.revokedAt,
    );
    assert.equal((await pub.menu(l.token)).body.error, "public_link_invalid");
    const immutable = (q: (tx: Tx) => Promise<unknown>) =>
      assert.rejects(run(t.s.owner, q), /public_link_immutable/);
    await immutable(
      (tx) =>
        tx`update public_links set revoked_at=null,revoked_by=null,revoke_reason=null where id=${l.id}`,
    );
    await immutable(
      (tx) => tx`update public_links set label='Otra' where id=${l.id}`,
    );
    const active = await link(t, { kind: "kiosk", label: "Entrada" });
    // Identity columns are not even granted; as the owner the trigger refuses.
    await assert.rejects(
      asAdmin(
        t.tenantId,
        (tx) =>
          tx`update public_links set kind='counter',channel='qr' where id=${active.id}`,
      ),
      /public_link_immutable/,
    );
    await assert.rejects(
      asAdmin(
        t.tenantId,
        (tx) =>
          tx`update public_links set token_hash=${"a".repeat(64)} where id=${active.id}`,
      ),
      /public_link_immutable/,
    );
  });

  await test("8. active link caps: 5 counter links, 10 kiosks; revoked links do not count", async () => {
    const t = await makeTenant("caps");
    const counters = [];
    for (let i = 0; i < 5; i++)
      counters.push(
        await link(t, { kind: "counter", label: `Ventanilla ${i}` }),
      );
    await rejects(
      link(t, { kind: "counter", label: "Sexta" }),
      "public_link_limit",
    );
    for (let i = 0; i < 10; i++)
      await link(t, { kind: "kiosk", label: `Kiosco ${i}` });
    await rejects(
      link(t, { kind: "kiosk", label: "Undécimo" }),
      "public_link_limit",
    );
    await run(t.s.manager, (tx) =>
      revokeLink(tx, t.s.manager, counters[0].id, { operationId: op() }),
    );
    await link(t, { kind: "counter", label: "Reemplazo" });
  });

  await test("bulk table codes: create for tables without a code, skip or replace the rest, in floor order", async () => {
    const t = await makeTenant("bulk");
    const first = await link(t, { kind: "table", tableId: t.tables[1].id });
    const r = await run(t.s.manager, (tx) =>
      createTableLinks(tx, t.s.manager, {
        tableIds: t.tables.map((x) => x.id).reverse(),
      }),
    );
    assert.deepEqual(
      r.created.map((l) => l.tableName),
      ["Mesa 01", "Mesa 03"],
    );
    assert.deepEqual(r.skipped, [
      { tableId: t.tables[1].id, tableName: "Mesa 02" },
    ]);
    const again = await run(t.s.manager, (tx) =>
      createTableLinks(tx, t.s.manager, {
        tableIds: [t.tables[1].id],
        replaceExisting: true,
      }),
    );
    assert.equal(again.created.length, 1);
    assert.equal((await pub.menu(first.token)).status, 404);
    assert.equal((await pub.menu(again.created[0].token)).status, 200);
    const listed = await run(t.s.manager, (tx) => listLinks(tx, t.s.manager));
    assert.equal(
      listed.links.filter((l) => !l.revokedAt && l.kind === "table").length,
      3,
    );
    assert(listed.links.some((l) => l.revokedAt && l.id === first.id));
    await rejects(
      run(t.s.manager, (tx) =>
        createTableLinks(tx, t.s.manager, { tableIds: [randomUUID()] }),
      ),
      "invalid_table",
    );
  });

  // ---------------------------------------------------------------- holds

  await test("9. submit creates a pending hold Q-1 with server line ids, and nothing on the sales side", async () => {
    const t = await makeTenant("submit");
    const l = await link(t, { kind: "table", tableId: t.tables[0].id });
    const before = await salesRows(t.tenantId);
    const b1 = await body(t, [{ productId: t.p.taco, quantity: 2 }], {
      name: " Ana ",
      note: "sin cebolla",
    });
    const r = await pub.submit(l.token, b1);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.label, "Q-1");
    assert.equal(r.body.state, "pending");
    assert.equal(r.body.kind, "table");
    assert.equal(r.body.policy, "accept");
    assert.equal(r.body.total, 9000);
    assert.equal(r.body.order, null);
    const h = await holdOf(t, b1);
    assert.equal(
      (h.expires_at.getTime() - h.created_at.getTime()) / 60_000,
      30,
    );
    assert.deepEqual(
      [h.mode, h.table_id, h.name, h.note, h.policy, h.channel],
      ["dine_in", t.tables[0].id, "Ana", "sin cebolla", "accept", "qr"],
    );
    assert.notEqual(h.lines[0].id, b1.lines[0].id, "server line ids");
    assert.equal(h.priced[0].id, h.lines[0].id);
    assert.deepEqual(await salesRows(t.tenantId), before);
    const kiosk = await link(t, { kind: "kiosk", label: "Entrada" });
    const k = await pub.submit(
      kiosk.token,
      await body(t, [{ productId: t.p.taco }]),
    );
    assert.equal(k.body.label, "K-2");
    assert.equal(k.body.kind, "kiosk");
  });

  await test("10. idempotency: a replay returns the same hold; a changed body or another link conflicts; diner line ids never collide at acceptance", async () => {
    const t = await makeTenant("idem");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const other = await link(t, { kind: "kiosk", label: "Kiosco" });
    const b1 = await body(t, [{ productId: t.p.taco }]);
    const first = await pub.submit(l.token, b1);
    const again = await pub.submit(l.token, b1);
    assert.deepEqual(again.body, first.body);
    const [n] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select count(*)::int as n from public_order_holds where operation_id=${b1.operationId}`,
    );
    assert.equal(n.n, 1);
    const changed = await pub.submit(l.token, { ...b1, name: "Otro" });
    assert.deepEqual(
      [changed.status, changed.body.error],
      [409, "operation_conflict"],
    );
    const moved = await pub.submit(other.token, b1);
    assert.equal(moved.body.error, "operation_conflict");
    // A POS line id reused by two diners.
    const pos = await run(t.s.cashier, (tx) =>
      createOrder(tx, t.s.cashier, {
        operationId: op(),
        lines: [
          {
            id: randomUUID(),
            productId: t.p.taco,
            quantity: 1,
            options: [],
            note: "",
          },
        ],
        mode: "takeaway",
        name: "POS",
        channel: "pos",
      }),
    );
    const reused = pos.lines[0].id;
    const holds = [];
    for (let i = 0; i < 2; i++) {
      const bi = await body(t, [{ productId: t.p.taco }]);
      bi.lines[0].id = reused;
      assert.equal((await pub.submit(l.token, bi)).status, 200);
      holds.push(await holdOf(t, bi));
    }
    for (const h of holds) await accept(t, h.id);
    // Duplicate line ids inside one body come only from a modified client.
    const dup = await body(t, [
      { productId: t.p.taco },
      { productId: t.p.taco },
    ]);
    dup.lines[1].id = dup.lines[0].id;
    assert.equal((await pub.submit(l.token, dup)).body.error, "invalid_input");
  });

  await test("11. pricing: a stale total, an open-price item, an 86'd item and an order above the maximum are refused", async () => {
    const t = await makeTenant("pricing");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const b1 = await body(t, [{ productId: t.p.taco }]);
    const wrong = await pub.submit(l.token, {
      ...b1,
      expectedTotal: b1.expectedTotal + 100,
    });
    assert.deepEqual(
      [wrong.status, wrong.body.error],
      [409, "public_price_changed"],
    );
    const open = await pub.submit(l.token, {
      ...b1,
      operationId: op(),
      statusKey: newPublicToken(),
      lines: [
        { id: randomUUID(), productId: t.p.open, quantity: 1, options: [] },
      ],
      expectedTotal: 0,
    });
    assert.equal(open.body.error, "forbidden");
    const withAmount = await pub.submit(l.token, {
      ...b1,
      operationId: op(),
      lines: [
        {
          id: randomUUID(),
          productId: t.p.open,
          quantity: 1,
          options: [],
          openAmount: 5000,
        },
      ],
    });
    assert.equal(withAmount.body.error, "invalid_input");
    await asAdmin(
      t.tenantId,
      (tx) =>
        tx`update catalog set data=jsonb_set(data,'{available}','false') where id=${t.p.scarce}`,
    );
    const gone = await pub.submit(l.token, {
      ...b1,
      operationId: op(),
      statusKey: newPublicToken(),
      lines: [
        { id: randomUUID(), productId: t.p.scarce, quantity: 1, options: [] },
      ],
      expectedTotal: 2000,
    });
    assert.deepEqual([gone.status, gone.body.error], [400, "unavailable"]);
    await run(t.s.manager, (tx) =>
      saveOrderingSettings(tx, t.s.manager, {
        operationId: op(),
        expectedVersion: 0,
        tablePolicy: "accept",
        counterPolicy: "accept",
        holdMinutes: 30,
        maxOrderTotal: 10_000,
      }),
    );
    const big = await pub.submit(
      l.token,
      await body(t, [{ productId: t.p.taco, quantity: 3 }]),
    );
    assert.deepEqual(
      [big.status, big.body.error],
      [409, "public_order_too_large"],
    );
    assert.equal(
      (await pub.submit(l.token, await body(t, [{ productId: t.p.taco }])))
        .status,
      200,
    );
  });

  await test("12. durable caps: per table across rotations (3 pending, 8 per 15 min), per kiosk (5 pending), per restaurant (40 pending)", async () => {
    const t = await makeTenant("limits");
    const mesa = await link(t, { kind: "table", tableId: t.tables[0].id });
    const keys: string[] = [];
    for (let i = 0; i < 3; i++) {
      const bi = await body(t, [{ productId: t.p.taco }]);
      assert.equal((await pub.submit(mesa.token, bi)).status, 200);
      keys.push(bi.statusKey);
    }
    const fourth = await pub.submit(
      mesa.token,
      await body(t, [{ productId: t.p.taco }]),
    );
    assert.deepEqual(
      [fourth.status, fourth.body.error],
      [429, "public_order_limit"],
    );
    const fresh = await run(t.s.manager, (tx) =>
      rotateLink(tx, t.s.manager, mesa.id),
    );
    assert.equal(
      (await pub.submit(fresh.token, await body(t, [{ productId: t.p.taco }])))
        .body.error,
      "public_order_limit",
      "the count is per table, not per link",
    );
    // Old link's status keys still cancel (status lookups accept revoked links).
    for (const key of keys)
      assert.equal((await pub.cancel(mesa.token, key)).body.state, "cancelled");
    for (let i = 3; i < 8; i++) {
      const bi = await body(t, [{ productId: t.p.taco }]);
      assert.equal((await pub.submit(fresh.token, bi)).status, 200, `#${i}`);
      assert.equal((await pub.cancel(fresh.token, bi.statusKey)).status, 200);
    }
    const ninth = await pub.submit(
      fresh.token,
      await body(t, [{ productId: t.p.taco }]),
    );
    assert.equal(ninth.body.error, "public_order_limit");
    const kiosk = await link(t, { kind: "kiosk", label: "Kiosco" });
    for (let i = 0; i < 5; i++)
      assert.equal(
        (
          await pub.submit(
            kiosk.token,
            await body(t, [{ productId: t.p.taco }]),
          )
        ).status,
        200,
      );
    assert.equal(
      (await pub.submit(kiosk.token, await body(t, [{ productId: t.p.taco }])))
        .body.error,
      "public_order_limit",
    );
    const cap = logLines.filter((l) => l.includes('"public_order_limited"'));
    assert(cap.length > 0);
    assert(cap.every((l) => !l.includes(kiosk.token) && l.includes("ipHash")));

    const busy = await makeTenant("busy");
    const counter = await link(busy, { kind: "counter", label: "Ventanilla" });
    for (let i = 0; i < 40; i++)
      await insertHold(busy, { id: counter.id, tableId: null, channel: "qr" });
    const another = await link(busy, { kind: "kiosk", label: "Kiosco" });
    const refused = await pub.submit(
      another.token,
      await body(busy, [{ productId: busy.p.taco }]),
    );
    assert.deepEqual(
      [refused.status, refused.body.error],
      [429, "public_ordering_busy"],
    );
  });

  await test("13. liveness: ordering pauses without a recent operator session on a terminal, and when paused", async () => {
    const t = await makeTenant("liveness", { staffOnline: false });
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const closed = async () => {
      const m = await pub.menu(l.token);
      assert.equal(m.status, 200, "the menu stays browsable");
      assert.deepEqual(
        [m.body.ordering.open, m.body.ordering.reason],
        [false, "paused"],
      );
      const r = await pub.submit(
        l.token,
        await body(t, [{ productId: t.p.taco }]),
      );
      assert.deepEqual(
        [r.status, r.body.error],
        [409, "public_ordering_paused"],
      );
    };
    await closed();
    await staffSession(t, "cashier", t.terminal, 400);
    await closed();
    await staffSession(t, "kitchen", t.terminal);
    await closed();
    await staffSession(t, "cashier", t.personal);
    await closed();
    await staffSession(t, "cashier", t.terminal);
    const open = await pub.menu(l.token);
    assert.deepEqual(
      [open.body.ordering.open, open.body.ordering.reason],
      [true, null],
    );
    assert.equal(
      (await pub.revision(l.token)).body.ordering.open,
      true,
      "the minute poll carries the open state",
    );
    await run(t.s.cashier, (tx) =>
      setPaused(tx, t.s.cashier, { operationId: op(), paused: true }),
    );
    await closed();
    const s = await run(t.s.cashier, (tx) => orderingSettings(tx, t.s.cashier));
    assert.deepEqual(
      [s.paused, s.reason, s.acceptingNow],
      [true, "paused", false],
    );
    await run(t.s.cashier, (tx) =>
      setPaused(tx, t.s.cashier, { operationId: op(), paused: false }),
    );
    assert.equal(
      (await pub.submit(l.token, await body(t, [{ productId: t.p.taco }])))
        .status,
      200,
    );
  });

  await test("14. tables: an archived table blocks its link; a pending hold blocks archiving; an expired one does not; occupancy counts pending holds", async () => {
    const t = await makeTenant("tables");
    const [m1, m2, m3] = await Promise.all(
      t.tables.map((x) => link(t, { kind: "table", tableId: x.id })),
    );
    const version = async (id: string) =>
      (
        await asAdmin(
          t.tenantId,
          (tx) => tx`select version from dining_tables where id=${id}`,
        )
      )[0].version as number;
    const archive = async (id: string) =>
      run(t.s.manager, async (tx) =>
        archiveTable(tx, t.s.manager, {
          operationId: op(),
          id,
          expectedVersion: await version(id),
          archived: true,
        }),
      );
    await archive(t.tables[2].id);
    const menu = await pub.menu(m3.token);
    assert.deepEqual(
      [menu.status, menu.body.ordering.reason],
      [200, "table_unavailable"],
    );
    const refused = await pub.submit(
      m3.token,
      await body(t, [{ productId: t.p.taco }]),
    );
    assert.deepEqual(
      [refused.status, refused.body.error],
      [409, "public_table_unavailable"],
    );
    assert.equal(
      (await pub.submit(m1.token, await body(t, [{ productId: t.p.taco }])))
        .status,
      200,
    );
    await rejects(archive(t.tables[0].id), "table_in_use");
    assert(
      (
        await run(t.s.owner, (tx) => tablesWithOpenChecks(tx, [t.tables[0].id]))
      ).has(t.tables[0].id),
    );
    await insertHold(t, m2, { expired: true });
    await archive(t.tables[1].id);
    const occupancy = await run(t.s.cashier, (tx) =>
      tableOccupancy(tx, t.s.cashier),
    );
    assert.deepEqual(
      occupancy.map((o) => [o.name, o.pendingHolds, o.checks.length]),
      [["Mesa 01", 1, 0]],
    );
  });

  // --------------------------------------------------------------- accept

  await test("15. accept as a new check: the cashier's order gets rounds, stock, the kitchen job and the feed bump only now", async () => {
    const t = await makeTenant("accept");
    const l = await link(t, { kind: "table", tableId: t.tables[0].id });
    const b1 = await body(
      t,
      [
        { productId: t.p.taco, quantity: 2 },
        { productId: t.p.salsa, options: [t.p.verde, t.p.queso] },
      ],
      { name: "Ana", note: "sin cebolla" },
    );
    await pub.submit(l.token, b1);
    const h = await holdOf(t, b1);
    const before = await salesRows(t.tenantId);
    const r = await accept(t, h.id);
    assert.equal(r.round, 1);
    assert.deepEqual(
      [
        r.order.channel,
        r.order.mode,
        r.order.tableId,
        r.order.name,
        r.order.note,
        r.order.checkState,
        r.order.total,
      ],
      ["qr", "dine_in", t.tables[0].id, "Ana", "sin cebolla", "open", 15000],
    );
    const after = await salesRows(t.tenantId);
    assert.equal(after.orders, before.orders + 1);
    assert.equal(after.rounds, before.rounds + 1);
    assert.equal(after.stock_movements, before.stock_movements + 1);
    assert.equal(after.feed, before.feed + 1);
    const [o] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select employee_id,(select count(*)::int from jobs j where j.kind='kitchen_dispatch' and j.payload->>'orderId'=o.id::text) as jobs from orders o where o.id=${r.order.id}`,
    );
    assert.deepEqual([o.employee_id, o.jobs], [t.ids.cashier, 1]);
    const [held] = await asAdmin(
      t.tenantId,
      (tx) => tx`select * from public_order_holds where id=${h.id}`,
    );
    assert.deepEqual(
      [held.state, held.order_id, held.order_round, held.decided_by],
      ["accepted", r.order.id, 1, t.ids.cashier],
    );
    const [audit] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select detail from audit where operation='public.hold_accepted' and entity_id=${h.id}`,
    );
    assert.deepEqual(
      [audit.detail.label, audit.detail.target, audit.detail.override],
      ["Q-1", "new", false],
    );
    // The new check's line ids are the hold's server ids.
    assert.deepEqual(
      r.order.lines.map((x) => x.id).sort(),
      held.lines.map((x: { id: string }) => x.id).sort(),
    );
  });

  await test("16. accept onto the table's open check: a new round noted with the hold label; stale, closed, paid, foreign and counter targets refused", async () => {
    const t = await makeTenant("append");
    const l = await link(t, { kind: "table", tableId: t.tables[0].id });
    const pos = (tableId: string) =>
      run(t.s.server, (tx) =>
        createOrder(tx, t.s.server, {
          operationId: op(),
          lines: [
            {
              id: randomUUID(),
              productId: t.p.taco,
              quantity: 1,
              options: [],
              note: "",
            },
          ],
          mode: "dine_in",
          tableId,
          name: "Mesa",
          channel: "pos",
        }),
      );
    const check = await pos(t.tables[0].id);
    const b1 = await body(t, [{ productId: t.p.taco }], {
      name: "Ana",
      note: "sin cebolla",
    });
    await pub.submit(l.token, b1);
    const h = await holdOf(t, b1);
    await rejects(
      accept(t, h.id, {
        target: {
          kind: "append",
          orderId: check.id,
          expectedVersion: check.version - 1,
        },
      }),
      "stale_order",
    );
    const r = await accept(t, h.id, {
      target: {
        kind: "append",
        orderId: check.id,
        expectedVersion: check.version,
      },
    });
    assert.equal(r.round, 2);
    const round = r.order.rounds.find((x) => x.number === 2);
    assert.equal(round.note, "Q-1 · Ana · sin cebolla");
    const [held] = await asAdmin(
      t.tenantId,
      (tx) => tx`select order_round from public_order_holds where id=${h.id}`,
    );
    assert.equal(held.order_round, 2);
    // A paid check, a closed one, another table's and a counter hold.
    const paid = await pos(t.tables[0].id);
    await run(t.s.cashier, (tx) =>
      recordPayment(tx, t.s.cashier, paid.id, {
        operationId: op(),
        amount: paid.total,
        received: paid.total,
        method: "cash",
      }),
    );
    const closed = await pos(t.tables[0].id);
    await run(t.s.cashier, (tx) =>
      recordPayment(tx, t.s.cashier, closed.id, {
        operationId: op(),
        amount: closed.total,
        received: closed.total,
        method: "cash",
      }),
    );
    await run(t.s.cashier, (tx) =>
      closeCheck(tx, t.s.cashier, closed.id, { operationId: op() }),
    );
    const foreign = await pos(t.tables[1].id);
    const h2 = await insertHold(t, l);
    for (const target of [paid, closed, foreign]) {
      const fresh = await run(t.s.owner, (tx) => getOrder(tx, target.id));
      await rejects(
        accept(t, h2.row.id, {
          target: {
            kind: "append",
            orderId: fresh.id,
            expectedVersion: fresh.version,
          },
        }),
        "public_hold_target_invalid",
      );
    }
    const counter = await link(t, { kind: "counter", label: "Ventanilla" });
    const h3 = await insertHold(t, { ...counter, tableId: null });
    await rejects(
      accept(t, h3.row.id, {
        target: { kind: "append", orderId: check.id, expectedVersion: 2 },
      }),
      "public_hold_target_invalid",
    );
    await rejects(
      accept(t, h2.row.id, {
        target: { kind: "append", orderId: check.id, expectedVersion: 2 },
        payment: { amount: 4500, received: 4500, method: "cash" },
      }),
      "invalid_input",
    );
  });

  await test("17. atomicity: a short payment, a missing drawer or insufficient stock leaves no order, round, stock, job, tender or feed bump, and the hold pending", async () => {
    const t = await makeTenant("atomic");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const b1 = await body(t, [{ productId: t.p.taco }]);
    await pub.submit(l.token, b1);
    const h = await holdOf(t, b1);
    const before = await salesRows(t.tenantId);
    const pending = async () => {
      const [r] = await asAdmin(
        t.tenantId,
        (tx) =>
          tx`select state from public_order_holds where operation_id=${b1.operationId}`,
      );
      assert.equal(r.state, "pending");
      assert.deepEqual(await salesRows(t.tenantId), before);
    };
    await rejects(
      accept(t, h.id, {
        payment: { amount: 4400, received: 4400, method: "cash" },
      }),
      "public_payment_must_cover_total",
    );
    await pending();
    const noDrawer = { ...t.s.cashier, deviceId: t.bare };
    await rejects(
      accept(
        t,
        h.id,
        { payment: { amount: 4500, received: 5000, method: "cash" } },
        noDrawer,
      ),
      "drawer_required",
    );
    await pending();
    await admin`update restaurants set negative_stock_policy='block' where id=${t.tenantId}`;
    const b2 = await body(t, [{ productId: t.p.scarce }]);
    await pub.submit(l.token, b2);
    const h2 = await holdOf(t, b2);
    const beforeStock = await salesRows(t.tenantId);
    await rejects(accept(t, h2.id), "insufficient_stock");
    assert.deepEqual(await salesRows(t.tenantId), beforeStock);
  });

  await test("18. pay-first: payment or a manager's PIN-confirmed exception; the payment key is server-fresh; a replay adds no tender", async () => {
    const t = await makeTenant("payfirst");
    await run(t.s.manager, (tx) =>
      saveOrderingSettings(tx, t.s.manager, {
        operationId: op(),
        expectedVersion: 0,
        tablePolicy: "pay_first",
        counterPolicy: "pay_first",
        holdMinutes: 30,
        maxOrderTotal: 1_000_000,
      }),
    );
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const holds = [];
    for (let i = 0; i < 3; i++) {
      const bi = await body(t, [{ productId: t.p.taco }]);
      const r = await pub.submit(l.token, bi);
      assert.equal(r.body.policy, "pay_first");
      holds.push(await holdOf(t, bi));
    }
    await rejects(accept(t, holds[0].id), "public_payment_required");
    const before = await salesRows(t.tenantId);
    const key = op();
    await rejects(
      run(stale(t.s.manager), (tx) =>
        acceptHold(tx, stale(t.s.manager), holds[0].id, {
          operationId: key,
          target: { kind: "new" },
        }),
      ),
      "step_up_required",
    );
    assert.deepEqual(await salesRows(t.tenantId), before);
    const [noOp] = await asAdmin(
      t.tenantId,
      (tx) => tx`select count(*)::int as n from operations where id=${key}`,
    );
    assert.equal(noOp.n, 0);
    const override = await accept(t, holds[0].id, {}, t.s.manager);
    assert.equal(override.order.checkState, "open");
    const [o] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select h.policy_override,a.detail from public_order_holds h
          join audit a on a.entity_id=h.id::text and a.operation='public.hold_accepted' where h.id=${holds[0].id}`,
    );
    assert.deepEqual([o.policy_override, o.detail.override], [true, true]);
    // A client payment key is refused: the accept's own key covers the payment.
    await rejects(
      accept(t, holds[1].id, {
        payment: {
          operationId: op(),
          amount: 4500,
          received: 5000,
          method: "cash",
        },
      }),
      "invalid_input",
    );
    const acceptKey = op();
    const paidBody = {
      operationId: acceptKey,
      target: { kind: "new" },
      payment: { amount: 4500, received: 5000, method: "cash" },
    };
    const paid = await run(t.s.cashier, (tx) =>
      acceptHold(tx, t.s.cashier, holds[1].id, paidBody),
    );
    assert.deepEqual(
      [paid.order.checkState, paid.order.closeReason, paid.order.paid],
      ["closed", "settled", 4500],
    );
    const tenders = await asAdmin(
      t.tenantId,
      (tx) => tx`select id from tenders where order_id=${paid.order.id}`,
    );
    assert.equal(tenders.length, 1);
    const payments = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select id from operations where kind='payment' and result->>'id'=${paid.order.id}`,
    );
    assert.equal(payments.length, 1);
    assert.notEqual(payments[0].id, acceptKey);
    const [flag] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select paid_at_accept,policy_override from public_order_holds where id=${holds[1].id}`,
    );
    assert.deepEqual(
      [flag.paid_at_accept, flag.policy_override],
      [true, false],
    );
    const replay = await run(t.s.cashier, (tx) =>
      acceptHold(tx, t.s.cashier, holds[1].id, paidBody),
    );
    assert.equal(replay.order.id, paid.order.id);
    assert.equal(
      (
        await asAdmin(
          t.tenantId,
          (tx) => tx`select id from tenders where order_id=${paid.order.id}`,
        )
      ).length,
      1,
    );
    const [fiscal] =
      await admin`select to_regclass('public.fiscal_tickets') is not null as present`;
    if (fiscal.present) {
      const tickets = await asAdmin(
        t.tenantId,
        (tx) =>
          tx`select id from fiscal_tickets where order_id=${paid.order.id}`,
      );
      assert.equal(tickets.length, 1, "one ticket in the accept transaction");
    }
  });

  await test("19. exclusions and price changes: excluded lines stay out; all or unknown exclusions refused; a new price needs the acknowledgement", async () => {
    const t = await makeTenant("exclude");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const b1 = await body(t, [
      { productId: t.p.taco },
      { productId: t.p.salsa, options: [t.p.roja] },
    ]);
    await pub.submit(l.token, b1);
    const h = await holdOf(t, b1);
    const [tacoLine, salsaLine] = h.lines.map((x: { id: string }) => x.id);
    await rejects(
      accept(t, h.id, { excludeLineIds: [tacoLine, salsaLine] }),
      "invalid_input",
    );
    await rejects(
      accept(t, h.id, { excludeLineIds: [randomUUID()] }),
      "invalid_input",
    );
    const r = await accept(t, h.id, { excludeLineIds: [tacoLine] });
    assert.deepEqual(
      r.order.lines.map((x) => x.id),
      [salsaLine],
    );
    assert.equal(r.order.total, 4000);
    const [stored] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select excluded_line_ids from public_order_holds where id=${h.id}`,
    );
    assert.deepEqual(stored.excluded_line_ids, [tacoLine]);
    const status = await pub.status(l.token, b1.statusKey);
    assert.deepEqual(
      status.body.lines.map((x) => x.excluded),
      [true, false],
    );
    const b2 = await body(t, [{ productId: t.p.taco }]);
    await pub.submit(l.token, b2);
    const h2 = await holdOf(t, b2);
    await asAdmin(
      t.tenantId,
      (tx) =>
        tx`update catalog set data=jsonb_set(data,'{price}','5000') where id=${t.p.taco}`,
    );
    await rejects(accept(t, h2.id), "public_hold_price_changed");
    const ack = await accept(t, h2.id, { priceChangeAcknowledged: true });
    assert.equal(ack.order.total, 5000);
  });

  await test("20. reject: decided once; an expired hold refused; only managers deactivate the link with an abuse rejection", async () => {
    const t = await makeTenant("reject");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const b1 = await body(t, [{ productId: t.p.taco }]);
    await pub.submit(l.token, b1);
    const h = await holdOf(t, b1);
    const r = await reject(t, h.id, { reason: "duplicate" });
    assert.deepEqual(r.hold.state, "rejected");
    await rejects(accept(t, h.id), "public_order_not_pending");
    const expired = await insertHold(
      t,
      { ...l, tableId: null },
      {
        expired: true,
      },
    );
    await rejects(reject(t, expired.row.id), "public_order_expired");
    const b2 = await body(t, [{ productId: t.p.taco }]);
    await pub.submit(l.token, b2);
    const h2 = await holdOf(t, b2);
    await rejects(
      reject(t, h2.id, { reason: "abuse", revokeLink: true }),
      "forbidden",
    );
    const abuse = await reject(
      t,
      h2.id,
      { reason: "abuse", revokeLink: true },
      t.s.manager,
    );
    assert.equal(abuse.revokedLink, true);
    const [linkRow] = await asAdmin(
      t.tenantId,
      (tx) => tx`select revoke_reason from public_links where id=${l.id}`,
    );
    assert.equal(linkRow.revoke_reason, "abuse");
    assert.equal((await pub.menu(l.token)).body.error, "public_link_invalid");
    const seen = await pub.status(l.token, b2.statusKey);
    assert.deepEqual(
      [seen.body.state, seen.body.rejectReason],
      ["rejected", "other"],
      "the diner never sees abuse",
    );
    assert.equal(
      (await pub.status(l.token, b1.statusKey)).body.rejectReason,
      "duplicate",
    );
  });

  await test("21. diner cancel: only a pending, unexpired hold; the trigger refuses moving expiry and a second decision", async () => {
    const t = await makeTenant("cancel");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const b1 = await body(t, [{ productId: t.p.taco }]);
    await pub.submit(l.token, b1);
    const c = await pub.cancel(l.token, b1.statusKey);
    assert.deepEqual([c.status, c.body.state], [200, "cancelled"]);
    const h = await holdOf(t, b1);
    await rejects(accept(t, h.id), "public_order_not_pending");
    const again = await pub.cancel(l.token, b1.statusKey);
    assert.deepEqual(
      [again.status, again.body.error],
      [409, "public_order_not_pending"],
    );
    const b2 = await body(t, [{ productId: t.p.taco }]);
    await pub.submit(l.token, b2);
    await accept(t, (await holdOf(t, b2)).id);
    assert.equal(
      (await pub.cancel(l.token, b2.statusKey)).body.error,
      "public_order_not_pending",
    );
    const expired = await insertHold(
      t,
      { ...l, tableId: null },
      {
        expired: true,
      },
    );
    assert.equal(
      (await pub.cancel(l.token, expired.statusKey)).body.error,
      "public_order_expired",
    );
    assert.equal(
      (await pub.status(l.token, expired.statusKey)).body.state,
      "expired",
    );
    await assert.rejects(
      asAdmin(
        t.tenantId,
        (tx) =>
          tx`update public_order_holds set expires_at=now()+interval '1 hour' where id=${expired.row.id}`,
      ),
      /public_order_hold_immutable/,
    );
    await assert.rejects(
      asAdmin(
        t.tenantId,
        (tx) =>
          tx`update public_order_holds set state='rejected',reject_reason='other',decided_by=${t.ids.manager} where id=${h.id}`,
      ),
      /public_order_hold_immutable/,
    );
  });

  await test("22. status view: progress follows the hold's round, money for a new check, none for an appended round; unknown and foreign keys are not found", async () => {
    const t = await makeTenant("status");
    const l = await link(t, { kind: "table", tableId: t.tables[0].id });
    const b1 = await body(t, [{ productId: t.p.taco }]);
    await pub.submit(l.token, b1);
    const r = await accept(t, (await holdOf(t, b1)).id);
    const view = async (key = b1.statusKey) =>
      (await pub.status(l.token, key)).body;
    let v = await view();
    assert.equal(v.state, "accepted");
    assert.deepEqual(v.order, {
      number: r.order.number,
      target: "new",
      progress: "preparing",
      money: { total: 4500, paid: 0, balance: 4500 },
      fiscal: null,
    });
    await asAdmin(
      t.tenantId,
      (tx) => tx`update rounds set state='ready' where order_id=${r.order.id}`,
    );
    assert.equal((await view()).order!.progress, "ready");
    await asAdmin(
      t.tenantId,
      (tx) =>
        tx`update rounds set state='completed' where order_id=${r.order.id}`,
    );
    await run(t.s.cashier, (tx) =>
      recordPayment(tx, t.s.cashier, r.order.id, {
        operationId: op(),
        amount: 4500,
        received: 4500,
        method: "cash",
      }),
    );
    v = await view();
    assert.equal(v.order!.progress, "served");
    assert.deepEqual(v.order!.money, { total: 4500, paid: 4500, balance: 0 });
    const b2 = await body(t, [{ productId: t.p.taco }]);
    await pub.submit(l.token, b2);
    const check = await run(t.s.server, (tx) =>
      createOrder(tx, t.s.server, {
        operationId: op(),
        lines: [
          {
            id: randomUUID(),
            productId: t.p.taco,
            quantity: 1,
            options: [],
            note: "",
          },
        ],
        mode: "dine_in",
        tableId: t.tables[0].id,
        name: "Mesa",
        channel: "pos",
      }),
    );
    await accept(t, (await holdOf(t, b2)).id, {
      target: {
        kind: "append",
        orderId: check.id,
        expectedVersion: check.version,
      },
    });
    const appended = await view(b2.statusKey);
    assert.deepEqual(
      [appended.order!.target, appended.order!.money, appended.order!.progress],
      ["append", null, "preparing"],
    );
    const unknown = await pub.status(l.token, newPublicToken());
    assert.deepEqual(
      [unknown.status, unknown.body.error],
      [404, "public_hold_not_found"],
    );
    const other = await link(t, { kind: "counter", label: "Otra" });
    assert.equal(
      (await pub.status(other.token, b1.statusKey)).body.error,
      "public_hold_not_found",
    );
    const bad = await pub.status(l.token, "nope");
    assert.deepEqual(
      [bad.status, bad.body.error],
      [404, "public_hold_not_found"],
    );
  });

  await test("23. concurrency: two staff accepts make exactly one order; an accept racing the diner's cancel changes the hold once", async () => {
    const t = await makeTenant("race");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    for (let i = 0; i < 5; i++) {
      const h = await insertHold(t, { ...l, tableId: null });
      const both = await Promise.allSettled([
        accept(t, h.row.id),
        accept(t, h.row.id, {}, t.s.server),
      ]);
      assert.equal(both.filter((x) => x.status === "fulfilled").length, 1);
      const lost = both.find((x) => x.status === "rejected") as
        PromiseRejectedResult | undefined;
      assert.equal(lost?.reason.code, "public_order_not_pending");
      const [n] = await asAdmin(
        t.tenantId,
        (tx) =>
          tx`select count(*)::int as n from orders o join public_order_holds h on h.order_id=o.id where h.id=${h.row.id}`,
      );
      assert.equal(n.n, 1);
      const h2 = await insertHold(t, { ...l, tableId: null });
      const raced = await Promise.allSettled([
        accept(t, h2.row.id),
        pub.cancel(l.token, h2.statusKey),
      ]);
      const [row] = await asAdmin(
        t.tenantId,
        (tx) => tx`select state from public_order_holds where id=${h2.row.id}`,
      );
      const cancelled = (raced[1] as PromiseFulfilledResult<Reply>).value;
      if (row.state === "accepted") {
        assert.equal(raced[0].status, "fulfilled");
        assert.equal(cancelled.body.error, "public_order_not_pending");
      } else {
        assert.equal(row.state, "cancelled");
        assert.equal(
          (raced[0] as PromiseRejectedResult).reason.code,
          "public_order_not_pending",
        );
        assert.equal(cancelled.status, 200);
      }
    }
  });

  await test("24. lock order: concurrent pay-first accepts, appends, abuse rejections, rotations, drawer closes, settling voids and offline-style sales never surface a deadlock", async () => {
    const t = await makeTenant("lockorder");
    const counter = await link(t, { kind: "counter", label: "Ventanilla" });
    const mesa1 = await link(t, { kind: "table", tableId: t.tables[0].id });
    let mesa2 = await link(t, { kind: "table", tableId: t.tables[1].id });
    const posLine = (quantity = 1) => [
      {
        id: randomUUID(),
        productId: t.p.taco,
        quantity,
        options: [],
        note: "",
      },
    ];
    const target = await run(t.s.server, (tx) =>
      createOrder(tx, t.s.server, {
        operationId: op(),
        lines: posLine(),
        mode: "dine_in",
        tableId: t.tables[0].id,
        name: "Mesa 01",
        channel: "pos",
      }),
    );
    const failures: unknown[] = [];
    const allowed = new Set(["drawer_required", "stale_order"]);
    for (let round = 0; round < 50; round++) {
      const pay = await insertHold(t, { ...counter, tableId: null });
      const append = await insertHold(t, mesa1);
      const kiosk = await link(t, { kind: "kiosk", label: `Kiosco ${round}` });
      const abuse = await insertHold(t, { ...kiosk, tableId: null });
      // A check on Mesa 03 that a void settles: 2 units, 1 paid.
      const settle = await run(t.s.server, (tx) =>
        createOrder(tx, t.s.server, {
          operationId: op(),
          lines: posLine(2),
          mode: "dine_in",
          tableId: t.tables[2].id,
          name: "Mesa 03",
          channel: "pos",
        }),
      );
      await run(t.s.cashier, (tx) =>
        recordPayment(tx, t.s.cashier, settle.id, {
          operationId: op(),
          amount: 4500,
          received: 4500,
          method: "cash",
        }),
      );
      const fresh = await run(t.s.owner, (tx) => getOrder(tx, target.id));
      const settled = await run(t.s.owner, (tx) => getOrder(tx, settle.id));
      const results = await Promise.allSettled([
        accept(t, pay.row.id, {
          payment: { amount: 4500, received: 4500, method: "cash" },
        }),
        accept(t, append.row.id, {
          target: {
            kind: "append",
            orderId: target.id,
            expectedVersion: fresh.version,
          },
        }),
        reject(
          t,
          abuse.row.id,
          { reason: "abuse", revokeLink: true },
          t.s.manager,
        ),
        run(t.s.manager, (tx) => rotateLink(tx, t.s.manager, mesa2.id)),
        run(t.s.manager, (tx) =>
          closeCash(tx, t.s.manager, {
            operationId: op(),
            counted: 0,
            reason: "Cierre de prueba",
          }),
        ),
        run(t.s.manager, (tx) =>
          voidLines(
            tx,
            t.s.manager,
            settle.id,
            {
              operationId: op(),
              expectedVersion: settled.version,
              lines: [{ lineId: settled.lines[0].id, quantity: 1 }],
              reason: "Prueba de orden de bloqueos",
              stockDisposition: "no_return",
            },
            t.ids.manager,
          ),
        ),
        // Offline-style sale: createOrder then recordPayment in one transaction.
        run(t.s.cashier, async (tx) => {
          const o = await createOrder(tx, t.s.cashier, {
            operationId: op(),
            lines: posLine(),
            mode: "takeaway",
            name: "Sync",
            channel: "pos",
          });
          return recordPayment(tx, t.s.cashier, o.id, {
            operationId: op(),
            amount: o.total,
            received: o.total,
            method: "cash",
          });
        }),
      ]);
      for (const [i, r] of results.entries())
        if (r.status === "rejected") {
          const code = (r.reason as { code?: string })?.code;
          if (!code || !allowed.has(code)) failures.push([round, i, r.reason]);
        }
      const rotated = results[3];
      if (rotated.status === "fulfilled") mesa2 = rotated.value;
      // Reopen this device's drawer for the next round.
      await asAdmin(
        t.tenantId,
        (tx) =>
          tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening)
            select ${t.tenantId},${randomUUID()},${t.terminal},${t.ids.owner},0
            where not exists(select 1 from cash_sessions where device_id=${t.terminal} and closed_at is null)`,
      );
    }
    assert.deepEqual(failures, []);
    const [inv] = await asAdmin(
      t.tenantId,
      (tx) => tx`select
        (select count(*)::int from orders o where o.tenant_id=${t.tenantId}
           and (select coalesce(sum(amount),0) from tenders x where x.order_id=o.id) > o.total) as overpaid,
        (select count(*)::int from public_order_holds h where h.tenant_id=${t.tenantId} and h.state='accepted'
           and not exists(select 1 from rounds r where r.order_id=h.order_id and r.number=h.order_round)) as lost_rounds,
        (select count(*)::int from public_order_holds h where h.tenant_id=${t.tenantId} and h.paid_at_accept
           and (select coalesce(sum(amount),0) from tenders x where x.order_id=h.order_id) <> 4500) as wrong_paid`,
    );
    assert.deepEqual(
      { ...inv },
      { overpaid: 0, lost_rounds: 0, wrong_paid: 0 },
    );
  });

  await test("26. statement budgets: summary 1, an idle inbox 3, a busy inbox at most 5, holdStatus 2 with the Phase A stubs (<= 5 from 030)", async () => {
    const t = await makeTenant("budget");
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
    const cost = async (fn: (tx: Tx) => Promise<unknown>) => {
      n = 0;
      await tenant(counted, t.tenantId, fn);
      return n;
    };
    try {
      assert.equal(await cost((tx) => inboxSummary(tx, t.s.cashier)), 1);
      assert.equal(await cost((tx) => inbox(tx, t.s.cashier)), 3);
      const l = await link(t, { kind: "table", tableId: t.tables[0].id });
      const b1 = await body(t, [{ productId: t.p.taco }]);
      await pub.submit(l.token, b1);
      await insertHold(t, {
        ...(await link(t, { kind: "counter", label: "V" })),
        tableId: null,
      });
      assert.equal(await cost((tx) => inbox(tx, t.s.cashier)), 5);
      const r = await accept(t, (await holdOf(t, b1)).id);
      const [h] = await asAdmin(
        t.tenantId,
        (tx) =>
          tx`select link_id from public_order_holds where order_id=${r.order.id}`,
      );
      assert.equal(
        await cost((tx) => holdStatus(tx, h.link_id, b1.statusKey)),
        2,
      );
    } finally {
      await counted.end();
    }
  });

  await test("inbox: oldest first, re-quoted lines, open checks of the hold's table only, the recently expired count, and the summary", async () => {
    const t = await makeTenant("inbox");
    const mesa = await link(t, { kind: "table", tableId: t.tables[0].id });
    const counter = await link(t, { kind: "counter", label: "Ventanilla" });
    const check = await run(t.s.server, (tx) =>
      createOrder(tx, t.s.server, {
        operationId: op(),
        lines: [
          {
            id: randomUUID(),
            productId: t.p.taco,
            quantity: 1,
            options: [],
            note: "",
          },
        ],
        mode: "dine_in",
        tableId: t.tables[0].id,
        name: "Mesa",
        channel: "pos",
      }),
    );
    const b1 = await body(t, [{ productId: t.p.taco }], {
      note: "alergia al cacahuate",
    });
    await pub.submit(mesa.token, b1);
    const b2 = await body(t, [
      { productId: t.p.scarce },
      { productId: t.p.salsa, options: [t.p.roja] },
    ]);
    await pub.submit(counter.token, b2);
    await insertHold(t, { ...counter, tableId: null }, { expired: true });
    await asAdmin(t.tenantId, async (tx) => {
      await tx`update catalog set data=jsonb_set(data,'{available}','false') where id=${t.p.scarce}`;
      await tx`update catalog set data=jsonb_set(data,'{price}','4200') where id=${t.p.salsa}`;
    });
    const box: InboxResponse = await run(t.s.server, (tx) =>
      inbox(tx, t.s.server),
    );
    assert.deepEqual(
      [box.available, box.acceptingNow, box.recentlyExpired],
      [true, true, 1],
    );
    assert.deepEqual(
      box.holds.map((h) => [h.label, h.kind, h.tableName]),
      [
        ["Q-1", "table", "Mesa 01"],
        ["Q-2", "counter", null],
      ],
    );
    assert.equal(box.holds[0].note, "alergia al cacahuate");
    assert.deepEqual(
      box.holds[0].openChecks.map((c) => [c.id, c.checkState]),
      [[check.id, "open"]],
    );
    assert.deepEqual(box.holds[1].openChecks, []);
    assert.deepEqual(
      box.holds[1].lines.map((l) => [l.issue, l.currentTotal]),
      [
        ["unavailable", null],
        ["price_changed", 4200],
      ],
    );
    assert.equal(box.holds[1].currentTotal, null);
    assert.equal(box.holds[0].currentTotal, 4500);
    const summary = await run(t.s.cashier, (tx) =>
      inboxSummary(tx, t.s.cashier),
    );
    assert.deepEqual(
      [summary.available, summary.active, summary.pending],
      [true, true, 2],
    );
    await rejects(
      run(t.s.kitchen, (tx) => inbox(tx, t.s.kitchen)),
      "forbidden",
    );
  });

  // -------------------------------------------------------------- settings

  await test("27. settings: version-checked; managers edit, every operator pauses; audited", async () => {
    const t = await makeTenant("settings");
    const save = (s: Session, expectedVersion: number, over: object = {}) =>
      run(s, (tx) =>
        saveOrderingSettings(tx, s, {
          operationId: op(),
          expectedVersion,
          tablePolicy: "accept",
          counterPolicy: "pay_first",
          holdMinutes: 45,
          maxOrderTotal: 500_000,
          ...over,
        }),
      );
    const first = await save(t.s.manager, 0);
    assert.deepEqual(
      [
        first.version,
        first.counterPolicy,
        first.holdMinutes,
        first.maxOrderTotal,
      ],
      [1, "pay_first", 45, 500_000],
    );
    await rejects(save(t.s.manager, 0), "settings_changed");
    await rejects(save(t.s.cashier, 1), "forbidden");
    const second = await save(t.s.owner, 1, { holdMinutes: 60 });
    assert.equal(second.version, 2);
    const paused = await run(t.s.cashier, (tx) =>
      setPaused(tx, t.s.cashier, { operationId: op(), paused: true }),
    );
    assert.deepEqual(
      [paused.paused, paused.canEdit, paused.canPause],
      [true, false, true],
    );
    const ops = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select operation,detail from audit where tenant_id=${t.tenantId} and operation like 'public.%' order by created_at`,
    );
    assert.deepEqual(
      ops.map((o) => o.operation),
      ["public.settings_saved", "public.settings_saved", "public.paused"],
    );
    assert.deepEqual(ops[1].detail.changed, {
      holdMinutes: { from: 45, to: 60 },
    });
    const fresh = await makeTenant("settings-free", { plan: "free" });
    const view = await run(fresh.s.cashier, (tx) =>
      orderingSettings(tx, fresh.s.cashier),
    );
    assert.deepEqual([view.pro, view.reason, view.version], [false, "plan", 0]);
  });

  // ------------------------------------------------------------------ HTTP

  await test("28. the kill switch: diner routes answer public_ordering_disabled before any limiter; staff routes refuse and the summary is empty", async () => {
    const t = await makeTenant("gate");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const previous = process.env.PUBLIC_ORDERING_ENABLED;
    process.env.PUBLIC_ORDERING_ENABLED = "false";
    const off = await serve();
    const staff = express();
    staff.use(express.json());
    staff.use((req, _res, next) => {
      (req as unknown as { session: Session }).session = t.s.manager;
      next();
    });
    try {
      const r = await off.menu(l.token);
      assert.deepEqual(
        [r.status, r.body.error],
        [404, "public_ordering_disabled"],
      );
      assert.equal(r.headers.get("ratelimit-limit"), null);
      publicOrderingRoutes.register({
        app: staff,
        sql,
        route: makeRoute(staff, sql),
      });
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_ORDERING_ENABLED;
      else process.env.PUBLIC_ORDERING_ENABLED = previous;
      await off.close();
    }
    staff.use(
      (
        error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) =>
        res
          .status(error instanceof DomainError ? error.status : 500)
          .json({ error: error instanceof DomainError ? error.code : "x" }),
    );
    const server = staff.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    try {
      const created = await fetch(origin + "/ordering/links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "counter", label: "x" }),
      });
      assert.deepEqual(
        [created.status, (await created.json()).error],
        [404, "public_ordering_disabled"],
      );
      const summary = await fetch(origin + "/ordering/inbox/summary");
      assert.equal(summary.headers.get("cache-control"), "no-store");
      assert.deepEqual(await summary.json(), {
        available: false,
        active: false,
        pending: 0,
        oldestAt: null,
      });
      const settings = await (
        await fetch(origin + "/ordering/settings")
      ).json();
      assert.equal(settings.available, false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  await test("29. HTTP limits: per-link revision budget, malformed tokens refused before the database, one IP's flood stops at the ceilings, submit and cancel budgets, separate clients", async () => {
    const t = await makeTenant("http");
    const qr = await link(t, { kind: "counter", label: "Ventanilla" });
    const kiosk = await link(t, { kind: "kiosk", label: "Kiosco" });
    let transactions = 0;
    const counting = new Proxy(sql, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== "begin") return value;
        return (...args: unknown[]) => {
          transactions++;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as postgres.Sql;
    let h = await serve(counting);
    try {
      // MENU-R1: 20 polls per (IP, link); another link of the same IP polls on.
      const ip = randomIp();
      const polls = [];
      for (let i = 0; i < PUBLIC_RATES.revisionPerIpLink + 1; i++)
        polls.push(await h.revision(qr.token, ip));
      assert(polls.slice(0, -1).every((p) => p.status === 200));
      const limited = polls.at(-1)!;
      assert.equal(limited.status, 429);
      assert.equal(limited.body.error, "rate_limited");
      assert.equal(typeof limited.body.requestId, "string");
      assert.equal(
        limited.headers.get("ratelimit-limit"),
        String(PUBLIC_RATES.revisionPerIpLink),
      );
      assert.equal((await h.revision(kiosk.token, ip)).status, 200);
      assert.equal(
        (await h.revision(qr.token, randomIp())).status,
        200,
        "another client is a separate bucket",
      );
      // MENU-R3: malformed spellings never reach the database.
      const legacy = "eyJwdXJwb3NlIjoib3JkZXJpbmcifQ.c2lnbmF0dXJlLWxlZ2FjeQ";
      const spellings = [
        "",
        legacy,
        qr.token.slice(1),
        qr.token + "A",
        qr.token + "=",
        qr.token.slice(0, -1) + "!",
      ];
      transactions = 0;
      const bad = randomIp();
      for (const token of spellings)
        for (const r of [
          await h.revision(token, bad),
          await h.menu(token, bad),
          await h.submit(token, await body(t, [{ productId: t.p.taco }]), bad),
          await h.status(token, newPublicToken(), bad),
        ])
          assert.deepEqual(
            [r.status, r.body.error],
            [404, "public_link_invalid"],
            token,
          );
      assert.equal(transactions, 0, "refused before the database");
    } finally {
      await h.close();
    }

    // A flood of distinct well-formed tokens from one IP stops at the ceiling.
    h = await serve(counting);
    try {
      const ip = randomIp();
      transactions = 0;
      const flood = [];
      for (let i = 0; i < PUBLIC_RATES.revisionPerIp + 10; i++)
        flood.push(await h.revision(newPublicToken(), ip));
      assert.equal(
        flood.filter((r) => r.status === 404).length,
        PUBLIC_RATES.revisionPerIp,
      );
      assert.equal(flood.filter((r) => r.status === 429).length, 10);
      assert.equal(transactions, PUBLIC_RATES.revisionPerIp);
      // The ceiling is per IP, whatever the token; menu and submit keep their budgets.
      assert.equal((await h.revision(qr.token, ip)).status, 429);
      assert.equal(transactions, PUBLIC_RATES.revisionPerIp);
      assert.equal((await h.menu(qr.token, ip)).status, 200);
      const sent = await h.submit(
        qr.token,
        await body(t, [{ productId: t.p.taco }]),
        ip,
      );
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      // Status: 240 distinct keys from one IP, then 429 without a transaction.
      const statusIp = randomIp();
      for (let i = 0; i < PUBLIC_RATES.statusPerIp; i++)
        assert.equal(
          (await h.status(qr.token, newPublicToken(), statusIp)).status,
          404,
        );
      const before = transactions;
      const over = await h.status(qr.token, newPublicToken(), statusIp);
      assert.equal(over.status, 429);
      assert.equal(transactions, before);
    } finally {
      await h.close();
    }

    // Submit: 10 per (IP, link); cancel shares that budget.
    h = await serve(counting);
    try {
      const ip = randomIp();
      // A counter link holds up to 10 pending orders, so the 11th submit
      // meets the per-(IP, link) budget before the durable cap.
      const budget = await link(t, { kind: "counter", label: "Budget" });
      const keys = [];
      for (let i = 0; i < PUBLIC_RATES.writePerIpLink; i++) {
        const bi = await body(t, [{ productId: t.p.taco }]);
        const r = await h.submit(budget.token, bi, ip);
        assert.equal(r.status, 200, `#${i} ${JSON.stringify(r.body)}`);
        keys.push(bi.statusKey);
      }
      const eleventh = await h.submit(
        budget.token,
        await body(t, [{ productId: t.p.taco }]),
        ip,
      );
      assert.deepEqual(
        [eleventh.status, eleventh.body.error],
        [429, "rate_limited"],
      );
      assert.equal((await h.cancel(budget.token, keys[0], ip)).status, 429);
      assert.notEqual(
        (await h.cancel(budget.token, keys[0], randomIp())).status,
        429,
      );
    } finally {
      await h.close();
    }
  });

  await test("30. HTTP shape: no-store and noindex on every diner reply; old signed routes are gone; no internal fields leak", async () => {
    const t = await makeTenant("shape");
    const l = await link(t, { kind: "table", tableId: t.tables[0].id });
    const replies = [
      await pub.menu(l.token),
      await pub.revision(l.token),
      await pub.menu(newPublicToken()),
      await pub.call("GET", "/" + l.token + "/catalog"),
      await pub.call("GET", "/receipt/" + l.token),
    ];
    for (const r of replies) {
      assert.equal(r.headers.get("cache-control"), "no-store");
      assert.equal(r.headers.get("x-robots-tag"), "noindex");
    }
    assert.deepEqual(
      [replies[3].status, replies[3].body.error],
      [404, "not_found"],
    );
    assert.equal(replies[4].body.error, "not_found");
    const menu = replies[0].body as PublicMenuView;
    assert.deepEqual(menu.link, {
      kind: "table",
      channel: "qr",
      tableName: "Mesa 01",
      label: "",
    });
    assert.deepEqual(menu.restaurant, {
      name: restaurant.name,
      currency: "MXN",
      timezone: "America/Mexico_City",
      privacyNoticeUrl: null,
    });
    assert(!menu.catalog.some((p) => p.openAmount), "no open-price products");
    const b1 = await body(t, [{ productId: t.p.taco }]);
    await pub.submit(l.token, b1);
    await accept(t, (await holdOf(t, b1)).id);
    const status = await pub.status(l.token, b1.statusKey);
    for (const text of [JSON.stringify(menu), JSON.stringify(status.body)])
      for (const field of [
        '"recipe"',
        '"cost"',
        '"tenantId"',
        '"employeeId"',
        t.tenantId,
      ])
        assert(!text.includes(field), field);
  });

  await test("32. a reused status key conflicts (no 500, no row); the same key in another restaurant is fine", async () => {
    const t = await makeTenant("statuskey");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const b1 = await body(t, [{ productId: t.p.taco }]);
    await pub.submit(l.token, b1);
    const reuse = await pub.submit(l.token, {
      ...(await body(t, [{ productId: t.p.taco }])),
      statusKey: b1.statusKey,
    });
    assert.deepEqual(
      [reuse.status, reuse.body.error],
      [409, "operation_conflict"],
    );
    const [n] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select count(*)::int as n from public_order_holds where tenant_id=${t.tenantId}`,
    );
    assert.equal(n.n, 1);
    const elsewhere = await link(b, { kind: "counter", label: "Otra" });
    const there = await pub.submit(elsewhere.token, {
      ...(await body(b, [{ productId: b.p.taco }])),
      statusKey: b1.statusKey,
    });
    assert.equal(there.status, 200);
  });

  await test("33. a free pay-first hold is accepted without payment and is not an override; a payment for it is refused", async () => {
    const t = await makeTenant("free");
    await run(t.s.manager, (tx) =>
      saveOrderingSettings(tx, t.s.manager, {
        operationId: op(),
        expectedVersion: 0,
        tablePolicy: "pay_first",
        counterPolicy: "pay_first",
        holdMinutes: 30,
        maxOrderTotal: 1_000_000,
      }),
    );
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const b1 = await body(t, [{ productId: t.p.free }]);
    assert.equal((await pub.submit(l.token, b1)).body.total, 0);
    const b2 = await body(t, [{ productId: t.p.free }]);
    await pub.submit(l.token, b2);
    await rejects(
      accept(t, (await holdOf(t, b2)).id, {
        payment: { amount: 100, received: 100, method: "cash" },
      }),
      "invalid_input",
    );
    const r = await accept(t, (await holdOf(t, b1)).id);
    assert.deepEqual(
      [r.order.checkState, r.order.closeReason, r.order.tenders.length],
      ["closed", "settled", 0],
    );
    const [h] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select policy_override,paid_at_accept from public_order_holds where operation_id=${b1.operationId}`,
    );
    assert.deepEqual([h.policy_override, h.paid_at_accept], [false, false]);
    const [fiscal] =
      await admin`select to_regclass('public.fiscal_tickets') is not null as present`;
    if (fiscal.present)
      assert.equal(
        (
          await asAdmin(
            t.tenantId,
            (tx) =>
              tx`select id from fiscal_tickets where order_id=${r.order.id}`,
          )
        ).length,
        0,
        "a $0 order gets no fiscal ticket",
      );
  });

  await test("34. step-up: creating or replacing links and saving policies need a fresh PIN on terminals (Google owners on their own device pass); revoking, rejecting, pausing and accepting never ask", async () => {
    const t = await makeTenant("stepup");
    const m = stale(t.s.manager);
    const links = async () => count(t.tenantId, "public_links");
    const before = await links();
    for (const call of [
      (tx: Tx) => createLink(tx, m, { kind: "counter", label: "x" }),
      (tx: Tx) => createTableLinks(tx, m, { tableIds: [t.tables[0].id] }),
      (tx: Tx) =>
        saveOrderingSettings(tx, m, {
          operationId: op(),
          expectedVersion: 0,
          tablePolicy: "accept",
          counterPolicy: "accept",
          holdMinutes: 30,
          maxOrderTotal: 1_000_000,
        }),
    ])
      await rejects(run(m, call), "step_up_required");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    await rejects(
      run(m, (tx) => rotateLink(tx, m, l.id)),
      "step_up_required",
    );
    assert.equal(await links(), before + 1);
    // A PIN session on a personal device steps up too (access M8).
    await rejects(
      run(stale(t.s.manager, "personal"), (tx) =>
        createLink(tx, stale(t.s.manager, "personal"), {
          kind: "counter",
          label: "y",
        }),
      ),
      "step_up_required",
    );
    const google = ownerGoogle(t.s.owner);
    assert.match(
      (
        await run(google, (tx) =>
          createLink(tx, google, { kind: "counter", label: "Google" }),
        )
      ).token,
      /^[A-Za-z0-9_-]{22}$/,
    );
    const h1 = await insertHold(t, { ...l, tableId: null });
    await accept(t, h1.row.id, {}, m);
    const h2 = await insertHold(t, { ...l, tableId: null });
    await run(m, (tx) => setPaused(tx, m, { operationId: op(), paused: true }));
    await reject(t, h2.row.id, { reason: "abuse", revokeLink: true }, m);
    const kiosk = await link(t, { kind: "kiosk", label: "K" });
    await run(m, (tx) => revokeLink(tx, m, kiosk.id, { operationId: op() }));
  });

  await test("35. plan lapse: accepting needs Pro (new and append); rejecting still works; the diner page says unavailable", async () => {
    const t = await makeTenant("lapse");
    const l = await link(t, { kind: "table", tableId: t.tables[0].id });
    const check = await run(t.s.server, (tx) =>
      createOrder(tx, t.s.server, {
        operationId: op(),
        lines: [
          {
            id: randomUUID(),
            productId: t.p.taco,
            quantity: 1,
            options: [],
            note: "",
          },
        ],
        mode: "dine_in",
        tableId: t.tables[0].id,
        name: "Mesa",
        channel: "pos",
      }),
    );
    const h = await insertHold(t, l);
    await admin`update restaurant_entitlements set status='free',access_until=null where tenant_id=${t.tenantId}`;
    await rejects(accept(t, h.row.id), "pro_required");
    await rejects(
      accept(t, h.row.id, {
        target: {
          kind: "append",
          orderId: check.id,
          expectedVersion: check.version,
        },
      }),
      "pro_required",
    );
    const [row] = await asAdmin(
      t.tenantId,
      (tx) => tx`select state from public_order_holds where id=${h.row.id}`,
    );
    assert.equal(row.state, "pending");
    await reject(t, h.row.id);
    const menu = await pub.menu(l.token);
    assert.deepEqual([menu.status, menu.body.error], [403, "pro_required"]);
  });

  await test("36. the appended round number is the round actually inserted, even after a void bumped the check's version", async () => {
    const t = await makeTenant("roundno");
    const l = await link(t, { kind: "table", tableId: t.tables[0].id });
    const check = await run(t.s.server, (tx) =>
      createOrder(tx, t.s.server, {
        operationId: op(),
        lines: [
          {
            id: randomUUID(),
            productId: t.p.taco,
            quantity: 2,
            options: [],
            note: "",
          },
        ],
        mode: "dine_in",
        tableId: t.tables[0].id,
        name: "Mesa",
        channel: "pos",
      }),
    );
    const voided = await run(t.s.manager, (tx) =>
      voidLines(
        tx,
        t.s.manager,
        check.id,
        {
          operationId: op(),
          expectedVersion: check.version,
          lines: [{ lineId: check.lines[0].id, quantity: 1 }],
          reason: "Cliente cambió de opinión",
          stockDisposition: "no_return",
        },
        t.ids.manager,
      ),
    );
    const current = await run(t.s.owner, (tx) => getOrder(tx, check.id));
    assert(current.version > check.version, "the void bumped the version");
    assert(voided);
    const b1 = await body(t, [{ productId: t.p.taco }]);
    await pub.submit(l.token, b1);
    const r = await accept(t, (await holdOf(t, b1)).id, {
      target: {
        kind: "append",
        orderId: check.id,
        expectedVersion: current.version,
      },
    });
    const numbers = [...new Set(r.order.rounds.map((x) => x.number))].sort();
    assert.equal(r.round, Math.max(...numbers));
    assert.notEqual(r.round, numbers.length, "round numbers skip after a void");
    await asAdmin(
      t.tenantId,
      (tx) =>
        tx`update rounds set state='ready' where order_id=${check.id} and number=${r.round}`,
    );
    const v = (await pub.status(l.token, b1.statusKey)).body;
    assert.deepEqual([v.order!.target, v.order!.progress], ["append", "ready"]);
  });

  console.log(`${checks} public ordering checks passed`);
  await pub.close();
} finally {
  await sql.end();
  await admin.end();
}
