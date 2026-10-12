// Public QR/kiosk ordering (032/033) against a real database: links, holds,
// staff decisions, durable caps, the diner HTTP router and the DB-9 checks.
// Every run creates its own fictional restaurants and never deletes: accepted
// holds write append-only ledgers (stock movements; fiscal from 027), so
// cleanups are impossible by design (LD-12 pattern).
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import postgres from "postgres";
import { ZodError } from "zod";
import { password } from "../server/auth.js";
import {
  checkRole,
  checkWorkerRole,
  connect,
  connectWorker,
  tenant,
  type Tx,
} from "../server/db.js";
import { makeRoute } from "../server/http.js";
import {
  addRound,
  catalog,
  createOrder,
  getOrder,
  recordPayment,
} from "../server/orders.js";
import { voidLines } from "../server/voids.js";
import { kitchenFeed } from "../server/kitchen.js";
import { closeCash } from "../server/operations.js";
import { closeCheck, tableOccupancy } from "../server/checks.js";
import { saveFiscalProfile } from "../server/fiscal.js";
import {
  archiveTable,
  floorPayload,
  tablesWithOpenChecks,
} from "../server/floor.js";
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
import { saveRestaurantPrivacy } from "../server/account-settings.js";
import { exportTables } from "../server/data-export.js";
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
  DEFAULT_FISCAL_CONTEXT,
  SELF_INVOICE_CODE_PATTERN,
  formatFolio,
  type FiscalContext,
} from "../shared/fiscal.js";
import {
  HOLD_EXPIRY_GRACE_SECONDS,
  PAID_ACCEPT_GRACE_SECONDS,
  holdExpiryGraceSeconds,
  LINK_HEADER,
  PUBLIC_LIMITS,
  STATUS_HEADER,
  type DinerHoldView,
  type InboxResponse,
  type PublicMenuView,
} from "../shared/public-ordering.js";
import { isolatedTarget, requireWorker } from "./isolated-target.js";
import { noRetries } from "./db-retries.js";
import { setLogSink } from "../server/logging.js";
import { runRetention } from "../server/ops/retention.js";

// The runner and the router log through the shared sink; keep the output to PASS lines.
const logLines: string[] = [];
setLogSink((line) => logLines.push(line));

const target = isolatedTarget(process.env);
const { runtime: url, migration } = target;
const sql = connect(url),
  admin = postgres(migration, { max: 2, onnotice: () => {} });
await checkRole(sql);
// cfdi's jobs worker login (030): only it may mark an organization ready.
const worker = connectWorker(requireWorker(target));
await checkWorkerRole(worker);

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
/**
 * The fenced `sql` blocks of one documentation section, from its heading to
 * the next heading of the same or a higher level. The operator procedures run
 * exactly as documented (PUB-B3-1, PUB-B3-2).
 */
function docSql(file: string, heading: string): string[] {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const at = text.indexOf(`\n${heading}\n`);
  assert.ok(at >= 0, `${file}: ${heading}`);
  const level = heading.indexOf(" ");
  const rest = text.slice(at + heading.length + 2);
  const end = rest.search(new RegExp(`\\n#{1,${level}} `));
  return [
    ...(end < 0 ? rest : rest.slice(0, end)).matchAll(/```sql\n([\s\S]*?)```/g),
  ].map((m) => m[1]);
}
/** The statements of a documented SQL block, in order: comment lines dropped, `;` inside `$$` bodies and quotes kept. */
function sqlStatements(block: string): string[] {
  const text = block
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");
  const out: string[] = [];
  let cur = "",
    dollar = false,
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (!quoted && text.startsWith("$$", i)) {
      dollar = !dollar;
      cur += "$$";
      i++;
      continue;
    }
    if (!dollar && text[i] === "'") quoted = !quoted;
    if (text[i] === ";" && !dollar && !quoted) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += text[i];
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
/**
 * Runs a documented block statement by statement on one fresh connection, as
 * an operator would in psql (after the `prelude`, such as SET ROLE). Returns
 * each statement's result; an error ends the connection, which rolls the
 * block's transaction back.
 */
async function runDocBlock(url: string, block: string, prelude: string[] = []) {
  const c = postgres(url, { max: 1, onnotice: () => {} });
  try {
    for (const s of prelude) await c.unsafe(s);
    const results: postgres.RowList<postgres.Row[]>[] = [];
    for (const s of sqlStatements(block)) results.push(await c.unsafe(s));
    return results;
  } finally {
    await c.end();
  }
}
const rowsOf = (results: postgres.RowList<postgres.Row[]>[]) =>
  results.flatMap((r) => [...r]);
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
 * claim its own client address (independent limiter buckets per simulated
 * diner unless a test pins one). Requests carry Railway's edge shape (LD-46):
 * X-Real-IP is the diner and X-Forwarded-For ends with one shared edge hop,
 * so the limiters must key on clientIp's X-Real-IP, not req.ip.
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
    const ip = o.ip ?? randomIp();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-forwarded-for": `${ip}, 192.0.2.84`,
      "x-real-ip": ip,
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
    /** Created 30 minutes ago and expired this many seconds ago. */
    expiredSecondsAgo?: number;
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
        ${o.expired ? tx`now()-interval '40 minutes'` : o.expiredSecondsAgo !== undefined ? tx`now()-interval '30 minutes'` : tx`now()`},
        ${o.expired ? tx`now()-interval '10 minutes'` : o.expiredSecondsAgo !== undefined ? tx`now()-make_interval(secs=>${o.expiredSecondsAgo})` : tx`now()+interval '30 minutes'`})
      returning *`;
    return h;
  });
  return { row, statusKey };
}

/**
 * A restaurant that offers self-invoicing (030), as cfdi leaves one after
 * activation: test-mode settings with self-invoicing on (the runtime role's
 * insert) and a ready organization (the worker's), on a platform whose
 * provider is not disabled. The platform row is global: the returned restore
 * puts back what was there (no row reads as disabled for every reader).
 */
async function cfdiReady(f: Fixture): Promise<() => Promise<void>> {
  const [before] =
    await worker`select provider,live_enabled,upload_kid,upload_public_jwk,shared_org_id,worker_version
      from cfdi_platform where id=1`;
  const publish = !before || before.provider === "disabled";
  if (publish)
    await worker`insert into cfdi_platform(id,provider,shared_org_id,worker_version)
      values(1,'sandbox_shared','org_public_db','public-ordering-db')
      on conflict(id) do update set provider=excluded.provider,live_enabled=false,upload_kid=null,
        upload_public_jwk=null,shared_org_id=excluded.shared_org_id,
        worker_version=excluded.worker_version,updated_at=now()`;
  await run(
    f.s.owner,
    (tx) =>
      tx`insert into cfdi_settings(tenant_id,test_from,updated_by) values(${f.tenantId},current_date,${f.ids.owner})`,
  );
  await tenant(
    worker,
    f.tenantId,
    (tx) =>
      tx`insert into cfdi_organizations(tenant_id,source,status,provider_org_id)
        values(${f.tenantId},'shared_sandbox','ready','org_public_db')`,
  );
  return async () => {
    if (!publish) return;
    await worker`update cfdi_platform set provider=${before?.provider ?? "disabled"},
      live_enabled=${before?.live_enabled ?? false},upload_kid=${before?.upload_kid ?? null},
      upload_public_jwk=${before?.upload_public_jwk ?? null},shared_org_id=${before?.shared_org_id ?? null},
      worker_version=${before?.worker_version ?? "public-ordering-db"},updated_at=now() where id=1`;
  };
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
  out.fiscal_tickets = await count(tenantId, "fiscal_tickets");
  return out;
}

try {
  const a = await makeTenant("A");
  const b = await makeTenant("B");
  const pub = await serve();

  // ------------------------------------------------------------ migrations

  await test("1+3. 032/033 apply in order as a non-superuser owner; 033 fails on another tenant's bad rows until they are repaired; RUNBOOK's DB-9 check and repair, run as written, find and fix one bad row per column as a Neon-owner-like BYPASSRLS role and fail as the owner instead of passing (PUB-B3-1); re-running is a no-op; the runner applies a no-transaction newest file with the grants hook", async () => {
    const suffix = randomBytes(5).toString("hex");
    const role = `gm_pub_mig_${suffix}`;
    const secret = randomBytes(16).toString("hex");
    // The Neon owner role's shape (PROVISIONING.md): LOGIN BYPASSRLS, never a
    // superuser, a member of the schema owner with INHERIT and SET.
    const neon = {
      name: `gm_pub_neon_${suffix}`,
      password: randomBytes(16).toString("hex"),
    };
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
    await admin.unsafe(
      `create role "${neon.name}" login password '${neon.password}' nosuperuser nocreatedb nocreaterole bypassrls`,
    );
    await admin.unsafe(
      `grant "${role}" to "${neon.name}" with inherit true, set true`,
    );
    await admin.unsafe(`create database "${database}" owner "${role}"`);
    const asOwner = urlFor({ name: role, password: secret }),
      asNeon = urlFor(neon);
    const owner = postgres(asOwner, {
      max: 2,
      onnotice: () => {},
    });
    const root = postgres(urlFor(), { max: 1, onnotice: () => {} });
    // The operator procedure: RUNBOOK "DB-9 validation" and PUBLIC_ORDERING
    // §7 carry the same two blocks, the check and the repair.
    const documented = docSql("docs/RUNBOOK.md", "## DB-9 validation");
    assert.equal(documented.length, 2, "RUNBOOK: the check and the repair");
    assert.deepEqual(
      docSql("docs/PUBLIC_ORDERING.md", "## 7. DB-9 contract and validation"),
      documented,
      "PUBLIC_ORDERING §7 carries RUNBOOK's two blocks",
    );
    const [check, repair] = documented;
    try {
      // 032 and 033 only: the test proves 033's no-transaction path through
      // the grants hook whatever lands after it (PUBLIC-CONCURRENCY-2;
      // tests/migrate-db.ts covers the hook on synthetic files).
      const files = readMigrations().filter((m) => m.number <= 33);
      assert.equal(files.at(-1)?.name, "033_state_checks_validate.sql");
      const before = files.filter((m) => m.number < 32);
      const grants = (tx: Tx) =>
        applyGrantsTx(tx, { role: "gm_app", database });
      // The grants manifest belongs to this revision (it names 032's
      // tables), so the older files apply without it.
      assert.equal(
        (await applyMigrations(owner, before)).length,
        before.length,
      );
      // History the previous revision could write: another tenant's rows,
      // each with a value outside one 032 set (no constraint yet).
      const org = randomUUID(),
        tenantId = randomUUID(),
        employee = randomUUID();
      const bad = {
        state: randomUUID(),
        channel: randomUUID(),
        mode: randomUUID(),
        round: randomUUID(),
        job: randomUUID(),
      };
      await root.begin(async (tx) => {
        await tx`insert into organizations(id,name) values(${org},'DB-9 fixture')`;
        await tx`insert into restaurants(id,organization_id,name) values(${tenantId},${org},'DB-9')`;
        await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
          values(${tenantId},${employee},'Caja','caja','x','cashier')`;
        await tx`insert into orders(tenant_id,id,number,business_date,employee_id,mode,name,note,channel,state,total)
          values(${tenantId},${bad.state},1,'2026-03-01',${employee},'takeaway','','','pos','legacy',0)`;
        await tx`insert into orders(tenant_id,id,number,business_date,employee_id,mode,name,note,channel,state,total)
          values(${tenantId},${bad.channel},2,'2026-03-01',${employee},'takeaway','','','web','completed',0)`;
        await tx`insert into orders(tenant_id,id,number,business_date,employee_id,mode,name,note,channel,state,total)
          values(${tenantId},${bad.mode},3,'2026-03-01',${employee},'eat_in','','','pos','completed',0)`;
        await tx`insert into rounds(tenant_id,id,order_id,number,station,state)
          values(${tenantId},${bad.round},${bad.channel},1,'kitchen','bogus')`;
        await tx`insert into jobs(tenant_id,id,kind,dedupe_key,payload,state)
          values(${tenantId},${bad.job},'db9','legacy',${tx.json({})},'failed')`;
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
        root`update orders set state='held' where id=${bad.state}`,
        (e: any) => e.code === "23514",
      );
      // The documented check, as the Neon owner role's shape with no tenant
      // set, lists every bad row of the other tenant (PUB-B3-1).
      const probe = postgres(asNeon, { max: 1, onnotice: () => {} });
      try {
        const [shape] =
          await probe`select rolsuper, rolbypassrls, pg_has_role(current_user, ${role}, 'USAGE') as inherits
            from pg_roles where rolname = current_user`;
        assert.deepEqual(
          { ...shape },
          { rolsuper: false, rolbypassrls: true, inherits: true },
        );
      } finally {
        await probe.end();
      }
      const found = async () =>
        rowsOf(await runDocBlock(asNeon, check)).map((r) => ({ ...r }));
      assert.deepEqual(await found(), [
        { tenant_id: tenantId, id: bad.state, state: "legacy" },
        { tenant_id: tenantId, id: bad.channel, channel: "web" },
        { tenant_id: tenantId, id: bad.mode, mode: "eat_in" },
        { tenant_id: tenantId, id: bad.round, state: "bogus" },
        { tenant_id: tenantId, id: bad.job, state: "failed" },
      ]);
      // As the owner (gm_migrator's shape: FORCE RLS, no tenant), the guard
      // fails the check instead of letting it pass on rows it cannot see.
      const rlsRefused = (e: any) =>
        e.code === "42501" && /row-level security/.test(e.message);
      await assert.rejects(runDocBlock(asOwner, check), rlsRefused);
      // Without the guard the owner sees nothing: the trap it closes.
      const unguarded = check.replace("set local row_security = off;\n", "");
      assert.notEqual(unguarded, check, "the check carries the guard");
      assert.deepEqual(rowsOf(await runDocBlock(asOwner, unguarded)), []);
      // The documented repair, one row at a time.
      const fill = (
        table: string,
        column: string,
        value: string,
        id: string,
      ) => {
        const block = repair
          .replace("<table>", table)
          .replace("<column>", column)
          .replace("<value>", value)
          .replace("<tenant_id>", tenantId)
          .replace("<id>", id);
        assert.doesNotMatch(block, /<[a-z_]+>/, "every placeholder filled");
        return block;
      };
      // As the owner it fails too: never a silent UPDATE 0.
      await assert.rejects(
        runDocBlock(asOwner, fill("orders", "state", "completed", bad.state)),
        rlsRefused,
      );
      for (const [table, column, value, id] of [
        ["orders", "state", "completed", bad.state],
        ["orders", "channel", "pos", bad.channel],
        ["orders", "mode", "takeaway", bad.mode],
        ["rounds", "state", "completed", bad.round],
        ["jobs", "state", "dead", bad.job],
      ]) {
        const results = await runDocBlock(
          asNeon,
          fill(table, column, value, id),
        );
        assert.equal(
          results.find((r) => r.command === "UPDATE")?.count,
          1,
          `${table}.${column}: UPDATE 1`,
        );
        assert.equal(results.at(-1)?.command, "COMMIT");
      }
      assert.deepEqual(await found(), []);
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
      await admin.unsafe(`drop role if exists "${neon.name}"`);
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

  await test("25. grants: no DELETE on the four tables; identity columns, and a hold's name and note (034), are not updatable; decision columns are", async () => {
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
    // 034: the trigger allows a redaction, the grants keep it to the owner.
    await denied(
      (tx) =>
        tx`update public_order_holds set name='',note='' where id=${h.id}`,
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
    // Staff rejections free the pending slots: diner cancellations have
    // their own, smaller budget since ABUSE-2 (test 42), so the window cap is
    // reached through decided holds here (deliberate change).
    for (let i = 3; i < 8; i++) {
      const bi = await body(t, [{ productId: t.p.taco }]);
      assert.equal((await pub.submit(fresh.token, bi)).status, 200, `#${i}`);
      await reject(t, (await holdOf(t, bi)).id);
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

  await test("14. tables: an archived table blocks its link; a pending hold blocks archiving with its own wording (table_pending_qr); an expired one does not; occupancy counts pending holds", async () => {
    const t = await makeTenant("tables");
    const [m1, m2, m3] = await noRetries("14. three table links", () =>
      Promise.all(
        t.tables.map((x) => link(t, { kind: "table", tableId: x.id })),
      ),
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
    // A table held only by a pending QR order says so (PUBLIC-UX-2).
    await rejects(archive(t.tables[0].id), "table_pending_qr");
    assert(
      (
        await run(t.s.owner, (tx) => tablesWithOpenChecks(tx, [t.tables[0].id]))
      ).has(t.tables[0].id),
    );
    const floor = await run(t.s.manager, (tx) => floorPayload(tx, t.s.manager));
    assert.deepEqual(
      floor.tables
        .filter((x) => x.id === t.tables[0].id)
        .map((x) => [x.open, x.pendingQr]),
      [[true, true]],
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
      // MONEY-2: the hold label leads the call name (KDS, kitchen ticket)
      // and the order note (receipt): the diner knows the order only as Q-1.
      [
        "qr",
        "dine_in",
        t.tables[0].id,
        "Q-1 · Ana",
        "Q-1 · sin cebolla",
        "open",
        15000,
      ],
    );
    const feed = await run(t.s.cashier, (tx) =>
      kitchenFeed(tx, t.s.cashier, {}),
    );
    assert(!feed.unchanged);
    const ticket = feed.rounds.find((x) => x.orderId === r.order.id);
    assert.deepEqual(
      [ticket?.callName, ticket?.orderNote],
      ["Q-1 · Ana", "Q-1 · sin cebolla"],
    );
    const after = await salesRows(t.tenantId);
    assert.equal(after.orders, before.orders + 1);
    assert.equal(after.rounds, before.rounds + 1);
    assert.equal(after.stock_movements, before.stock_movements + 1);
    assert.equal(after.feed, before.feed + 1);
    // Nothing is paid: the check gets its fiscal ticket only when it is (027).
    assert.equal(after.fiscal_tickets, before.fiscal_tickets);
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
    // PRIVACY-1: what acceptance charged, per line, from the inserted round.
    assert.equal(held.accepted_total, 15000);
    assert.deepEqual(
      held.accepted_lines
        .map((x: { id: string; total: number }) => [x.id, x.total])
        .sort(),
      r.order.lines.map((x) => [x.id, x.total]).sort(),
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
    // PRIVACY-3: the round note prints on the shared check's receipt (LD-1),
    // so it carries the label and the kitchen note, never the diner's name.
    assert.equal(round.note, "Q-1 · sin cebolla");
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
    // Fiscal D1 (LD-15 fiscal Q2): the paid check got its ticket when it was
    // paid and takes no more rounds; neither does the closed one.
    const ticketed = await run(t.s.owner, (tx) => getOrder(tx, paid.id));
    assert.equal(ticketed.checkState, "paid");
    assert(ticketed.fiscal?.ticket?.folio, "the paid check has its folio");
    const ticketsBefore = await count(t.tenantId, "fiscal_tickets");
    assert.equal(ticketsBefore, 2, "the paid and the closed check");
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
    const unchanged = await run(t.s.owner, (tx) => getOrder(tx, paid.id));
    assert.deepEqual(
      [
        unchanged.total,
        unchanged.rounds.length,
        unchanged.fiscal?.ticket?.folio,
      ],
      [ticketed.total, ticketed.rounds.length, ticketed.fiscal!.ticket!.folio],
    );
    assert.equal(await count(t.tenantId, "fiscal_tickets"), ticketsBefore);
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
    // Nothing is paid, so the exception issues no fiscal ticket.
    assert.equal(override.order.fiscal?.ticket ?? null, null);
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
    // Fiscal 027: the accept's payment settles the check, so its ticket is
    // issued inside the accept transaction; the replay issues no second one.
    const tickets = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select series,number,gross from fiscal_tickets where order_id=${paid.order.id}`,
    );
    assert.equal(tickets.length, 1, "one ticket in the accept transaction");
    assert.equal(
      paid.order.fiscal?.ticket?.folio,
      formatFolio(tickets[0].series, Number(tickets[0].number)),
    );
    // B1 totals: the charged total is the ticket's gross (X26).
    const [charged] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select quoted_total,accepted_total from public_order_holds where id=${holds[1].id}`,
    );
    assert.deepEqual(
      [charged.quoted_total, charged.accepted_total, tickets[0].gross],
      [4500, 4500, 4500],
    );
    assert.equal(await count(t.tenantId, "fiscal_tickets"), 1);
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
    // MONEY-1: the acknowledgement is the exact total staff saw. Staff saw
    // $50.00 and told the diner; the price moved again to $65.00: refused,
    // and nothing is written.
    await asAdmin(
      t.tenantId,
      (tx) =>
        tx`update catalog set data=jsonb_set(data,'{price}','6500') where id=${t.p.taco}`,
    );
    const before = await salesRows(t.tenantId);
    await rejects(
      accept(t, h2.id, { acknowledgedTotal: 5000 }),
      "public_hold_price_changed",
    );
    assert.deepEqual(await salesRows(t.tenantId), before);
    // An acknowledged total is checked even when the price went back.
    await asAdmin(
      t.tenantId,
      (tx) =>
        tx`update catalog set data=jsonb_set(data,'{price}','4500') where id=${t.p.taco}`,
    );
    await rejects(
      accept(t, h2.id, { acknowledgedTotal: 5000 }),
      "public_hold_price_changed",
    );
    await asAdmin(
      t.tenantId,
      (tx) =>
        tx`update catalog set data=jsonb_set(data,'{price}','5000') where id=${t.p.taco}`,
    );
    const ack = await accept(t, h2.id, { acknowledgedTotal: 5000 });
    assert.equal(ack.order.total, 5000);
    const [audited] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select detail from audit where operation='public.hold_accepted' and entity_id=${h2.id}`,
    );
    assert.deepEqual(
      [audited.detail.priceChanged, audited.detail.total],
      [true, 5000],
    );
    // PRIVACY-1: the diner's status shows the accepted price, not the sent one.
    const confirmed = await pub.status(l.token, b2.statusKey);
    assert.deepEqual(
      [
        confirmed.body.state,
        confirmed.body.total,
        confirmed.body.priceChanged,
        confirmed.body.lines[0].unitPrice,
        confirmed.body.lines[0].total,
      ],
      ["accepted", 5000, true, 5000, 5000],
    );
    assert.equal(confirmed.body.order?.money?.total, 5000);
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

  await test("21. diner cancel: only a pending, unexpired hold; the trigger refuses moving expiry and a second decision; support's documented ARCO redaction, as gm_migrator, blanks one hold's name and note in any state (an accepted one keeps its order's call name), refuses a missing restaurant, and takes no table lock (PUB-B3-2, LD-41, PUBLIC-SECURITY-3, PUBLIC-CONCURRENCY-3)", async () => {
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

    // PUB-B3-2: the ARCO redaction (PUBLIC_ORDERING §12), run as written as
    // the schema owner under FORCE RLS.
    const [arco, ...extra] = docSql(
      "docs/PUBLIC_ORDERING.md",
      "### Redacting a hold (ARCO)",
    );
    assert.ok(arco && extra.length === 0, "one documented block");
    const [owned] =
      await admin`select t.tableowner, r.rolsuper, r.rolbypassrls from pg_tables t
        join pg_roles r on r.rolname = t.tableowner where t.tablename = 'public_order_holds'`;
    assert.deepEqual(
      { ...owned },
      { tableowner: "gm_migrator", rolsuper: false, rolbypassrls: false },
      "the test database is migrated as gm_migrator (CI parity)",
    );
    const asMigrator = (block: string) =>
      runDocBlock(migration, block, ["set role gm_migrator"]);
    const fillArco = async (holdId: string, block = arco) => {
      const [k] = await asAdmin(
        t.tenantId,
        (tx) =>
          tx`select business_date::text as day, number from public_order_holds where id=${holdId}`,
      );
      const filled = block
        .replaceAll("<restaurant uuid>", t.tenantId)
        .replace("<YYYY-MM-DD>", k.day)
        .replace("<number>", String(k.number));
      assert.doesNotMatch(filled, /<[A-Za-z -]+>/, "every placeholder filled");
      return filled;
    };
    const holds = async () =>
      Object.fromEntries(
        (
          await asAdmin(
            t.tenantId,
            (tx) =>
              tx`select id, state, name, note, lines, decided_at from public_order_holds order by id`,
          )
        ).map((r: any) => [r.id, { ...r }]),
      );
    const named = await body(t, [{ productId: t.p.taco }], {
      name: "Ana",
      note: "sin cebolla",
    });
    await pub.submit(l.token, named);
    assert.equal(
      (await pub.cancel(l.token, named.statusKey)).body.state,
      "cancelled",
    );
    const target = await holdOf(t, named);
    const before = await holds();
    assert.deepEqual(
      [before[target.id].name, before[target.id].note],
      ["Ana", "sin cebolla"],
    );
    const refused = /expected exactly one hold, found 0/;
    // 034: a plain tenant-scoped UPDATE, no trigger change and no table lock.
    assert.doesNotMatch(arco, /disable trigger|alter table|lock table/i);
    // Without the restaurant, FORCE RLS hides every hold: refused.
    const noTenant = arco.replace(
      /^select set_config\('app\.tenant_id'.*\n/m,
      "",
    );
    assert.notEqual(noTenant, arco, "the block sets the restaurant");
    await assert.rejects(
      asMigrator(await fillArco(target.id, noTenant)),
      refused,
    );
    assert.deepEqual(await holds(), before, "a refused block changes nothing");
    const done = await asMigrator(await fillArco(target.id));
    assert.equal(done.at(-1)?.command, "COMMIT");
    const blanked = {
      ...before,
      [target.id]: { ...before[target.id], name: "", note: "" },
    };
    assert.deepEqual(await holds(), blanked);
    // An accepted hold too (LD-41): its copy goes, the order keeps its call
    // name and note, the restaurant's sales record.
    const acceptedNamed = await body(t, [{ productId: t.p.taco }], {
      name: "Luis",
      note: "sin sal",
    });
    await pub.submit(l.token, acceptedNamed);
    const acceptedHold = await holdOf(t, acceptedNamed);
    const r = await accept(t, acceptedHold.id);
    const label = r.hold.label;
    const withAccepted = await holds();
    await asMigrator(await fillArco(acceptedHold.id));
    assert.deepEqual(await holds(), {
      ...withAccepted,
      [acceptedHold.id]: {
        ...withAccepted[acceptedHold.id],
        name: "",
        note: "",
      },
    });
    const [order] = await asAdmin(
      t.tenantId,
      (tx) => tx`select name,note from orders where id=${r.order.id}`,
    );
    assert.deepEqual(
      { ...order },
      { name: `${label} · Luis`, note: `${label} · sin sal` },
    );
    const [trigger] =
      await admin`select tgenabled from pg_trigger where tgname = 'public_order_holds_transition'`;
    assert.equal(trigger.tgenabled, "O", "the transition trigger stays on");
    await assert.rejects(
      asAdmin(
        t.tenantId,
        (tx) =>
          tx`update public_order_holds set name='x' where id=${target.id}`,
      ),
      /public_order_hold_immutable/,
    );

    // PUBLIC-CONCURRENCY-3: while the block's transaction is open on one
    // hold, another restaurant's diner submits and this restaurant's other
    // holds are decided as usual.
    const other = await makeTenant("arco-other");
    const otherLink = await link(other, { kind: "counter", label: "Otra" });
    const waiting = await body(t, [{ productId: t.p.taco }], { name: "Eva" });
    await pub.submit(l.token, waiting);
    const waitingHold = await holdOf(t, waiting);
    const open = postgres(migration, {
      max: 1,
      onnotice: () => {},
      connection: { role: "gm_migrator" },
    });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));
    const redaction = open.begin(async (tx) => {
      for (const statement of sqlStatements(await fillArco(target.id)).slice(
        1,
        -1,
      ))
        await tx.unsafe(statement);
      locked();
      await released;
    });
    try {
      await holding;
      const fast = <T>(p: Promise<T>) =>
        Promise.race([
          p,
          new Promise<never>((_, no) =>
            setTimeout(() => no(new Error("blocked by the redaction")), 3000),
          ),
        ]);
      const elsewhere = await fast(
        pub.submit(
          otherLink.token,
          await body(other, [{ productId: other.p.taco }]),
        ),
      );
      assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.body));
      const decided = await fast(reject(t, waitingHold.id));
      assert.equal(decided.hold.state, "rejected");
      const here = await fast(
        pub.submit(l.token, await body(t, [{ productId: t.p.taco }])),
      );
      assert.equal(here.status, 200, JSON.stringify(here.body));
    } finally {
      release();
      await redaction;
      await open.end();
    }
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
    // The payment issued the check's fiscal ticket (027): the status shows its
    // folio, as the printed ticket does; no self-invoice link while the
    // restaurant has no CFDI (030; the invoice leg is 22 (030) below).
    const [ticket] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select series,number from fiscal_tickets where order_id=${r.order.id}`,
    );
    assert(ticket, "the payment issued the ticket");
    assert.deepEqual(v.order!.fiscal, {
      folio: formatFolio(ticket.series, Number(ticket.number)),
      selfInvoiceCode: null,
    });
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
    // PRIVACY-1: the price moved and staff acknowledged it; the appended
    // order shows its own round at the accepted price, never the sent one.
    await asAdmin(
      t.tenantId,
      (tx) =>
        tx`update catalog set data=jsonb_set(data,'{price}','5000') where id=${t.p.taco}`,
    );
    await accept(t, (await holdOf(t, b2)).id, {
      target: {
        kind: "append",
        orderId: check.id,
        expectedVersion: check.version,
      },
      acknowledgedTotal: 5000,
    });
    const appended = await view(b2.statusKey);
    assert.deepEqual(
      [
        appended.order!.target,
        appended.order!.money,
        appended.order!.progress,
        appended.order!.fiscal,
      ],
      ["append", null, "preparing", null],
    );
    assert.deepEqual(
      [appended.total, appended.priceChanged, appended.lines[0].total],
      [5000, true, 5000],
    );
    assert.equal((await view()).priceChanged, false);
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

  await test("22 (030). self-invoice leg: the code goes only to the diner known to be the payer (LD-41, PUBLIC-MONEY-1): a table check staff collect later shows its folio and no code; a pay-first table accept, a kiosk order paid at acceptance and a counter order paid later show their ticket's code (the /f/{CODE} link); with self-invoicing off it is null again", async () => {
    const t = await makeTenant("self-invoice");
    const restorePlatform = await cfdiReady(t);
    try {
      const ticketOf = async (orderId: string) => {
        const [row] = await asAdmin(
          t.tenantId,
          (tx) =>
            tx`select series,number,self_invoice_code from fiscal_tickets where order_id=${orderId}`,
        );
        assert(row, "the payment issued the ticket");
        assert.match(row.self_invoice_code, SELF_INVOICE_CODE_PATTERN);
        return {
          folio: formatFolio(row.series, Number(row.number)),
          selfInvoiceCode: row.self_invoice_code as string,
        };
      };
      // A table QR accepted without payment: the check may take other
      // diners' and the waiter's rounds, and whoever pays it holds the
      // printed ticket. Staff collect it later: this diner's status shows the
      // folio, never the code (a bearer credential for the whole ticket).
      const mesa = await link(t, { kind: "table", tableId: t.tables[0].id });
      const b1 = await body(t, [{ productId: t.p.taco }]);
      await pub.submit(mesa.token, b1);
      const r1 = await accept(t, (await holdOf(t, b1)).id);
      const before = await pub.status(mesa.token, b1.statusKey);
      assert.equal(before.body.order!.fiscal, null, "no ticket before payment");
      // The waiter adds another diner's drinks to the same check.
      const withRound = await run(t.s.server, (tx) =>
        addRound(tx, t.s.server, r1.order.id, {
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
          name: "",
          expectedVersion: r1.order.version,
        }),
      );
      await run(t.s.cashier, (tx) =>
        recordPayment(tx, t.s.cashier, r1.order.id, {
          operationId: op(),
          amount: withRound.total,
          received: withRound.total,
          method: "cash",
        }),
      );
      const paid = await pub.status(mesa.token, b1.statusKey);
      assert.equal(paid.status, 200);
      const ticket1 = await ticketOf(r1.order.id);
      assert.deepEqual(paid.body.order!.fiscal, {
        folio: ticket1.folio,
        selfInvoiceCode: null,
      });
      assert.doesNotMatch(
        JSON.stringify(paid.body),
        new RegExp(ticket1.selfInvoiceCode),
        "the code is nowhere in the table diner's status",
      );
      // A pay-first table: the accept collects this diner's own order, so
      // this diner is the payer and gets the code.
      const [settings] = await run(
        t.s.manager,
        (tx) => tx`select version from public_ordering_settings`,
      );
      await run(t.s.manager, (tx) =>
        saveOrderingSettings(tx, t.s.manager, {
          operationId: op(),
          expectedVersion: settings?.version ?? 0,
          tablePolicy: "pay_first",
          counterPolicy: "accept",
          holdMinutes: 30,
          maxOrderTotal: 1_000_000,
        }),
      );
      const mesa2 = await link(t, { kind: "table", tableId: t.tables[1].id });
      const b3 = await body(t, [{ productId: t.p.taco }]);
      await pub.submit(mesa2.token, b3);
      const h3 = await holdOf(t, b3);
      assert.equal(h3.policy, "pay_first");
      const r3 = await accept(t, h3.id, {
        payment: { amount: 4500, received: 5000, method: "cash" },
      });
      const ticket3 = await ticketOf(r3.order.id);
      assert.deepEqual(
        (await pub.status(mesa2.token, b3.statusKey)).body.order!.fiscal,
        ticket3,
      );
      // A counter (takeaway) order accepted without payment and paid later:
      // a one-diner check the diner pays at the counter, so the code shows.
      const counter = await link(t, { kind: "counter", label: "Mostrador" });
      const b4 = await body(t, [{ productId: t.p.taco }]);
      await pub.submit(counter.token, b4);
      const r4 = await accept(t, (await holdOf(t, b4)).id);
      await run(t.s.cashier, (tx) =>
        recordPayment(tx, t.s.cashier, r4.order.id, {
          operationId: op(),
          amount: r4.order.total,
          received: r4.order.total,
          method: "cash",
        }),
      );
      const ticket4 = await ticketOf(r4.order.id);
      assert.deepEqual(
        (await pub.status(counter.token, b4.statusKey)).body.order!.fiscal,
        ticket4,
      );
      // A kiosk order paid at acceptance: its ticket is issued in the accept.
      const kiosk = await link(t, { kind: "kiosk", label: "Kiosco" });
      const b2 = await body(t, [{ productId: t.p.taco, quantity: 2 }]);
      await pub.submit(kiosk.token, b2);
      const r2 = await accept(t, (await holdOf(t, b2)).id, {
        payment: { amount: 9000, received: 10000, method: "cash" },
      });
      assert.deepEqual(
        [r2.order.checkState, r2.order.closeReason, r2.order.paid],
        ["closed", "settled", 9000],
      );
      const ticket2 = await ticketOf(r2.order.id);
      assert.notEqual(ticket2.selfInvoiceCode, ticket1.selfInvoiceCode);
      assert.deepEqual(
        (await pub.status(kiosk.token, b2.statusKey)).body.order!.fiscal,
        ticket2,
      );
      // The owner switches self-invoicing off: the folio stays, the link goes.
      await asAdmin(
        t.tenantId,
        (tx) => tx`update cfdi_settings set self_invoice_enabled=false`,
      );
      assert.deepEqual(
        (await pub.status(kiosk.token, b2.statusKey)).body.order!.fiscal,
        { folio: ticket2.folio, selfInvoiceCode: null },
      );
      assert.deepEqual(
        (await pub.status(mesa.token, b1.statusKey)).body.order!.fiscal,
        { folio: ticket1.folio, selfInvoiceCode: null },
      );
      assert.deepEqual(
        (await pub.status(mesa2.token, b3.statusKey)).body.order!.fiscal,
        { folio: ticket3.folio, selfInvoiceCode: null },
      );
    } finally {
      await restorePlatform();
    }
  });

  await test("23. concurrency: two staff accepts make exactly one order; an accept racing the diner's cancel changes the hold once", async () => {
    const t = await makeTenant("race");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    for (let i = 0; i < 5; i++) {
      const h = await insertHold(t, { ...l, tableId: null });
      const both = await noRetries("23. two staff accepts", () =>
        Promise.allSettled([
          accept(t, h.row.id),
          accept(t, h.row.id, {}, t.s.server),
        ]),
      );
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
      const raced = await noRetries("23. accept vs diner cancel", () =>
        Promise.allSettled([
          accept(t, h2.row.id),
          pub.cancel(l.token, h2.statusKey),
        ]),
      );
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
      const results = await noRetries("24. lock-order burst", () =>
        Promise.allSettled([
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
          // A staggered start (0-135 ms). Started with the others, the short
          // close always closed the drawer before the pay-first accept and
          // the sale reached it, so neither ever committed: later starts let
          // them take the drawer and the folio counter (LO-11, LO-12) first,
          // or meet the close on the drawer row.
          new Promise((r) => setTimeout(r, (round % 10) * 15)).then(() =>
            run(t.s.manager, (tx) =>
              closeCash(tx, t.s.manager, {
                operationId: op(),
                counted: 0,
                reason: "Cierre de prueba",
              }),
            ),
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
        ]),
      );
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
    // Fiscal DB 28's harness (027): the folio counter advanced once per ticket
    // and never skipped; a settled order has exactly one ticket at its total,
    // an order with a balance due has none; and every pay-first accept's
    // ticket is the total the accept charged (B1, X26).
    const [folios] = await asAdmin(
      t.tenantId,
      (tx) => tx`select
        (select coalesce(sum(last_value),0)::int from fiscal_folio_counters where tenant_id=${t.tenantId}) as counter,
        (select count(*)::int from fiscal_tickets where tenant_id=${t.tenantId}) as tickets,
        (select count(distinct (series,number))::int from fiscal_tickets where tenant_id=${t.tenantId}) as distinct_folios,
        (select coalesce(max(number),0)::int from fiscal_tickets where tenant_id=${t.tenantId}) as top`,
    );
    assert(folios.tickets > 0, "the burst issued tickets");
    assert.deepEqual(
      [folios.counter, folios.distinct_folios, folios.top],
      [folios.tickets, folios.tickets, folios.tickets],
      "gapless, unique folios in the one series",
    );
    const [money] = await asAdmin(
      t.tenantId,
      (tx) => tx`select
        (select count(*)::int from fiscal_tickets f join orders o on o.tenant_id=f.tenant_id and o.id=f.order_id
           where f.tenant_id=${t.tenantId} and f.gross<>o.total) as wrong_gross,
        (select count(*)::int from orders o where o.tenant_id=${t.tenantId} and o.total>0
           and (select coalesce(sum(amount),0) from tenders x where x.order_id=o.id) >= o.total
           and (select count(*) from fiscal_tickets f where f.order_id=o.id) <> 1) as settled_without_one,
        (select count(*)::int from orders o where o.tenant_id=${t.tenantId}
           and (select coalesce(sum(amount),0) from tenders x where x.order_id=o.id) < o.total
           and exists(select 1 from fiscal_tickets f where f.order_id=o.id)) as ticketed_with_balance,
        (select count(*)::int from public_order_holds h where h.tenant_id=${t.tenantId} and h.paid_at_accept
           and (select count(*) from fiscal_tickets f where f.order_id=h.order_id
                and f.gross=h.accepted_total and f.gross=h.quoted_total) <> 1) as accept_gross_mismatch,
        (select count(*)::int from public_order_holds h where h.tenant_id=${t.tenantId} and h.paid_at_accept) as paid_accepts`,
    );
    assert(money.paid_accepts > 0, "some pay-first accepts committed");
    assert.deepEqual(
      [
        money.wrong_gross,
        money.settled_without_one,
        money.ticketed_with_balance,
        money.accept_gross_mismatch,
      ],
      [0, 0, 0, 0],
    );
  });

  await test("26. statement budgets: summary 1, an idle inbox 3, a busy inbox at most 5, holdStatus 3 before the ticket and for a table check paid later, 4 with the payer's ticket (fiscal's identity, cfdi's self-invoice offer; OQ-10 <= 5)", async () => {
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
      // The hold, the order and fiscalTicketIdentity (027); no ticket yet, so
      // cfdi's self-invoice offer (030) is not asked.
      assert.equal(
        await cost((tx) => holdStatus(tx, h.link_id, b1.statusKey)),
        3,
      );
      await run(t.s.cashier, (tx) =>
        recordPayment(tx, t.s.cashier, r.order.id, {
          operationId: op(),
          amount: r.order.total,
          received: r.order.total,
          method: "cash",
        }),
      );
      // A table check paid later: this diner is not known to be the payer,
      // so cfdi's offer is not asked either (LD-41, PUBLIC-MONEY-1).
      assert.equal(
        await cost((tx) => holdStatus(tx, h.link_id, b1.statusKey)),
        3,
        "no offer for a table check paid later",
      );
      // A counter order paid later: with the ticket, cfdi's
      // selfInvoiceOffered (030) is one statement more.
      const counter = await link(t, { kind: "counter", label: "Caja" });
      const b2 = await body(t, [{ productId: t.p.taco }]);
      await pub.submit(counter.token, b2);
      const r2 = await accept(t, (await holdOf(t, b2)).id);
      await run(t.s.cashier, (tx) =>
        recordPayment(tx, t.s.cashier, r2.order.id, {
          operationId: op(),
          amount: r2.order.total,
          received: r2.order.total,
          method: "cash",
        }),
      );
      const ticketed = await cost((tx) =>
        holdStatus(tx, counter.id, b2.statusKey),
      );
      assert.equal(ticketed, 4, "a ticket adds only cfdi's offer");
      assert(ticketed <= 5, "OQ-10 budget");
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
    // "Enviar a" names yesterday's open check with its date (LD-29, POL-R2-2).
    assert.match(check.businessDate!, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(box.holds[0].openChecks[0].businessDate, check.businessDate);
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

  await test("28. the kill switch (account's publicOrderingGate and publicOrderingEnabled): every diner route answers public_ordering_disabled before any limiter; staff routes refuse and the summary is empty; a pending table order neither shows on Mesas nor blocks archiving while it is off (PUBLIC-UX-2, PUBLIC-SECURITY-2)", async () => {
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
      const key = newPublicToken();
      for (const r of [
        await off.menu(l.token),
        await off.revision(l.token),
        await off.submit(l.token, await body(t, [{ productId: t.p.taco }])),
        await off.status(l.token, key),
        await off.cancel(l.token, key),
      ]) {
        assert.deepEqual(
          [r.status, r.body.error],
          [404, "public_ordering_disabled"],
        );
        assert.equal(r.headers.get("ratelimit-limit"), null);
        assert.equal(r.headers.get("ratelimit-policy"), null);
      }
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

    // PUBLIC-UX-2 / PUBLIC-SECURITY-2: with the switch off nobody can accept
    // or reject a pending QR order, so it neither shows on Mesas nor blocks
    // archiving its table; with the switch on again it does both.
    const mesa = await link(t, { kind: "table", tableId: t.tables[0].id });
    assert.equal(
      (await pub.submit(mesa.token, await body(t, [{ productId: t.p.taco }])))
        .status,
      200,
    );
    const pendingOf = async () =>
      (await run(t.s.cashier, (tx) => tableOccupancy(tx, t.s.cashier))).find(
        (o) => o.id === t.tables[0].id,
      )?.pendingHolds;
    const tableVersion = async () =>
      (
        await asAdmin(
          t.tenantId,
          (tx) =>
            tx`select version from dining_tables where id=${t.tables[0].id}`,
        )
      )[0].version as number;
    const archiveMesa = async (archived: boolean) =>
      run(t.s.manager, async (tx) =>
        archiveTable(tx, t.s.manager, {
          operationId: op(),
          id: t.tables[0].id,
          expectedVersion: await tableVersion(),
          archived,
        }),
      );
    assert.equal(await pendingOf(), 1);
    await rejects(archiveMesa(true), "table_pending_qr");
    process.env.PUBLIC_ORDERING_ENABLED = "false";
    try {
      assert.equal(await pendingOf(), 0, "no QR badge while switched off");
      const floor = await run(t.s.manager, (tx) =>
        floorPayload(tx, t.s.manager),
      );
      assert.deepEqual(
        floor.tables
          .filter((x) => x.id === t.tables[0].id)
          .map((x) => [x.open, x.pendingQr]),
        [[false, undefined]],
      );
      const archived = await archiveMesa(true);
      assert.deepEqual([archived.archived, archived.open], [true, false]);
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_ORDERING_ENABLED;
      else process.env.PUBLIC_ORDERING_ENABLED = previous;
    }
    await archiveMesa(false);
    assert.equal(await pendingOf(), 1, "the switch on again shows it");
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
      // ABUSE-3: cost-free requests (missing or malformed tokens) have their
      // own small bucket and never drain the shared per-IP ceilings, so a
      // guest-Wi-Fi script cannot starve the diners behind the same address.
      const wifi = randomIp();
      const junk = [];
      for (let i = 0; i < PUBLIC_RATES.menuPerIp + 5; i++)
        junk.push(await h.menu("", wifi));
      assert.equal(
        junk.filter((r) => r.status === 404).length,
        PUBLIC_RATES.malformedPerIp,
      );
      assert.deepEqual(
        [junk.at(-1)!.status, junk.at(-1)!.body.error],
        [429, "rate_limited"],
      );
      assert.equal(
        (await h.submit("", await body(t, [{ productId: t.p.taco }]), wifi))
          .status,
        429,
        "every malformed request shares that bucket",
      );
      assert.equal(transactions, 0, "still no database work");
      assert.equal((await h.menu(qr.token, wifi)).status, 200);
      assert.equal((await h.revision(qr.token, wifi)).status, 200);
      const diner = await h.submit(
        qr.token,
        await body(t, [{ productId: t.p.taco }]),
        wifi,
      );
      assert.equal(diner.status, 200, JSON.stringify(diner.body));
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

  await test("30. HTTP shape: no-store and noindex on every diner reply; old signed routes are gone; no internal fields leak; the menu carries account's restaurant privacy URL", async () => {
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
    // B3: account's restaurantPrivacyUrl (031) fills the field once the owner
    // saves the restaurant's own notice.
    await run(t.s.owner, (tx) =>
      saveRestaurantPrivacy(tx, t.s.owner, {
        operationId: op(),
        expectedVersion: 0,
        privacyNoticeUrl: "https://taqueria-prueba.mx/privacidad",
      }),
    );
    const noticed = await pub.menu(l.token);
    assert.equal(
      noticed.body.restaurant.privacyNoticeUrl,
      "https://taqueria-prueba.mx/privacidad",
    );
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

  await test("31. export: account's column rule drops token_hash, status_key_hash and request_hash; no token, status key or hash reaches an owner's export of the public tables", async () => {
    const t = await makeTenant("export");
    const l = await link(t, { kind: "counter", label: "Exportación" });
    const b1 = await body(t, [{ productId: t.p.taco }], { name: "Ana" });
    const sent = await pub.submit(l.token, b1);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const h = await holdOf(t, b1);
    const tables = new Map(
      (await run(t.s.owner, (tx) => exportTables(tx))).map((x) => [x.name, x]),
    );
    const columns = (name: string) => {
      const x = tables.get(name);
      assert(x, `${name} is exported`);
      for (const c of x.columns) assert(!/hash|token/.test(c), `${name}.${c}`);
      return x.columns;
    };
    assert(!columns("public_links").includes("token_hash"));
    assert(columns("public_links").includes("label"));
    const holds = columns("public_order_holds");
    for (const c of ["status_key_hash", "request_hash"])
      assert(!holds.includes(c), c);
    assert(holds.includes("name"), "the diner's own data is exported");
    columns("public_ordering_settings");
    columns("public_hold_numbers");
    const secrets = [
      l.token,
      linkHash(l.token),
      b1.statusKey,
      statusHash(b1.statusKey),
      h.request_hash as string,
      h.status_key_hash as string,
    ];
    for (const name of [
      "public_links",
      "public_order_holds",
      "public_ordering_settings",
      "public_hold_numbers",
    ]) {
      const rows = await run(
        t.s.owner,
        (tx) => tx`select ${tx(tables.get(name)!.columns)} from ${tx(name)}`,
      );
      assert(rows.length > 0 || name === "public_ordering_settings", name);
      const text = JSON.stringify(rows);
      for (const secret of secrets)
        assert(!text.includes(secret), `${name} leaks a token or hash`);
    }
    assert(
      JSON.stringify(
        await run(t.s.owner, (tx) => tx`select name from public_order_holds`),
      ).includes("Ana"),
    );
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
    // Concurrent reuse (PUB-R4): two submits with one status key and
    // different operationIds both pass the reuse check while this
    // connection holds the link's cap lock (LO-3); the later insert loses on
    // the unique key and answers 409, never a unique-violation 500.
    const racing = await link(t, { kind: "counter", label: "Carrera" });
    const key = newPublicToken();
    const bodies = [
      { ...(await body(t, [{ productId: t.p.taco }])), statusKey: key },
      { ...(await body(t, [{ productId: t.p.taco }])), statusKey: key },
    ];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    const holder = asAdmin(t.tenantId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id')||':public-hold:'||${racing.id},925))`;
      locked();
      await gate;
    });
    await held;
    const both = noRetries("PUB-R4 status-key race", () =>
      Promise.all(bodies.map((x) => pub.submit(racing.token, x))),
    );
    let waiting = 0;
    for (let i = 0; i < 200 && waiting < 2; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const [w] = await admin`select count(*)::int as n from pg_locks
        where locktype='advisory' and not granted
          and database=(select oid from pg_database where datname=current_database())`;
      waiting = w.n;
    }
    release();
    await holder;
    const raced = await both;
    assert.equal(waiting, 2, "both submits passed the reuse check");
    assert.deepEqual(
      raced.map((r) => [r.status, r.body.error ?? null]).sort(),
      [
        [200, null],
        [409, "operation_conflict"],
      ],
    );
    const [one] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select count(*)::int as n from public_order_holds where status_key_hash=${statusHash(key)}`,
    );
    assert.equal(one.n, 1);
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
    // M9: fiscal 027 tickets only orders.total > 0, so the closing refresh of
    // a $0 accept never reaches LO-12.
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
    assert.equal(await count(t.tenantId, "fiscal_tickets"), 0);
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

  await test("37. abuse: holds from a code deactivated as abuse are flagged in the inbox and need an explicit acknowledgement to accept (ABUSE-1)", async () => {
    const t = await makeTenant("abuse");
    const l = await link(t, { kind: "table", tableId: t.tables[0].id });
    const b1 = await body(t, [{ productId: t.p.taco }]);
    const b2 = await body(t, [{ productId: t.p.taco }]);
    const b3 = await body(t, [{ productId: t.p.taco }]);
    for (const b of [b1, b2, b3]) await pub.submit(l.token, b);
    const [h1, h2, h3] = [
      await holdOf(t, b1),
      await holdOf(t, b2),
      await holdOf(t, b3),
    ];
    await reject(t, h1.id, { reason: "abuse", revokeLink: true }, t.s.manager);
    const flagged = await run(t.s.cashier, (tx) => inbox(tx, t.s.cashier));
    assert.deepEqual(
      flagged.holds.map((x) => [x.id, x.linkRevoked]).sort(),
      [
        [h2.id, "abuse"],
        [h3.id, "abuse"],
      ].sort(),
    );
    const before = await salesRows(t.tenantId);
    await rejects(accept(t, h2.id), "public_hold_link_abuse");
    assert.deepEqual(await salesRows(t.tenantId), before, "nothing written");
    const ok = await accept(t, h2.id, { abuseAcknowledged: true });
    assert.equal(ok.hold.state, "accepted");
    const [audited] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select detail from audit where operation='public.hold_accepted' and entity_id=${h2.id}`,
    );
    assert.equal(audited.detail.abuseAcknowledged, true);
    // Rejecting a flagged hold needs no acknowledgement.
    await reject(t, h3.id, { reason: "abuse" });
    // A plain deactivation or a replacement is not abuse: no flag needed.
    const counter = await link(t, { kind: "counter", label: "Ventanilla" });
    const b4 = await body(t, [{ productId: t.p.taco }]);
    await pub.submit(counter.token, b4);
    await run(t.s.manager, (tx) =>
      revokeLink(tx, t.s.manager, counter.id, { operationId: op() }),
    );
    const plain = await run(t.s.cashier, (tx) => inbox(tx, t.s.cashier));
    assert.deepEqual(
      plain.holds.map((x) => x.linkRevoked),
      ["revoked"],
    );
    await accept(t, (await holdOf(t, b4)).id);
  });

  await test("38. a code revoked or replaced by another process stops at once, although this process cached it; status keeps answering (ABUSE-4)", async () => {
    const t = await makeTenant("crossproc");
    for (const reason of ["revoked", "rotated"] as const) {
      const l = await link(t, { kind: "counter", label: "Cruzado " + reason });
      const b1 = await body(t, [{ productId: t.p.taco }]);
      assert.equal((await pub.submit(l.token, b1)).status, 200);
      // Warm this process's positive cache.
      assert.equal((await pub.menu(l.token)).status, 200);
      // Another web process revokes it: a direct update, so this process's
      // cache is NOT told (no forgetLinkHash).
      await asAdmin(
        t.tenantId,
        (tx) =>
          tx`update public_links set revoked_at=now(),revoked_by=${t.ids.manager},revoke_reason=${reason} where id=${l.id}`,
      );
      for (const r of [
        await pub.menu(l.token),
        await pub.revision(l.token),
        await pub.submit(l.token, await body(t, [{ productId: t.p.taco }])),
      ])
        assert.deepEqual(
          [r.status, r.body.error],
          [404, "public_link_invalid"],
          reason,
        );
      const status = await pub.status(l.token, b1.statusKey);
      assert.deepEqual([status.status, status.body.state], [200, "pending"]);
    }
  });

  await test("39. a menu change committed between the accept's price check and createOrder's own read rolls the accept back (MONEY-1)", async () => {
    const t = await makeTenant("pricerace");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const b1 = await body(t, [{ productId: t.p.taco }]);
    await pub.submit(l.token, b1);
    const h = await holdOf(t, b1);
    const before = await salesRows(t.tenantId);
    // Hold the hold's own order key (createOrder's once()) so the accept
    // stops after its price check and before createOrder reads the menu.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    const holder = admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${t.tenantId + h.order_operation_id},0))`;
      locked();
      await gate;
    });
    await held;
    const racing = accept(t, h.id).then(
      () => "accepted",
      (e: { code?: string }) => e.code ?? String(e),
    );
    let waiting = 0;
    for (let i = 0; i < 200 && waiting < 1; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const [w] = await admin`select count(*)::int as n from pg_locks
        where locktype='advisory' and not granted
          and database=(select oid from pg_database where datname=current_database())`;
      waiting = w.n;
    }
    assert.equal(waiting, 1, "the accept waits on the hold's order key");
    await asAdmin(
      t.tenantId,
      (tx) =>
        tx`update catalog set data=jsonb_set(data,'{price}','5000') where id=${t.p.taco}`,
    );
    release();
    await holder;
    assert.equal(await racing, "public_hold_price_changed");
    assert.deepEqual(await salesRows(t.tenantId), before, "nothing written");
    const [row] = await asAdmin(
      t.tenantId,
      (tx) => tx`select state from public_order_holds where id=${h.id}`,
    );
    assert.equal(row.state, "pending");
    // The inbox now shows the new price; acknowledging it accepts at $50.00.
    const ok = await accept(t, h.id, { acknowledgedTotal: 5000 });
    assert.equal(ok.order.total, 5000);
  });

  await test("40. an append whose target was fully paid between the unlocked read and addRound's lock is refused and rolled back, with fiscal tickets on (D1) and off (CONCURRENCY-3)", async () => {
    // With tickets on, the payment issues the check's ticket and addRound
    // refuses the ticketed check (fiscal D1); with the kill switch it stays
    // unticketed and acceptHold's own guard refuses it. Same answer both ways.
    for (const ticketsOn of [true, false]) {
      const t = await makeTenant(ticketsOn ? "paidrace" : "paidrace-off");
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
      const b1 = await body(t, [{ productId: t.p.taco }]);
      await pub.submit(l.token, b1);
      const h = await holdOf(t, b1);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const held = new Promise<void>((r) => (locked = r));
      const holder = admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${t.tenantId + h.order_operation_id},0))`;
        locked();
        await gate;
      });
      await held;
      const racing = accept(t, h.id, {
        target: {
          kind: "append",
          orderId: check.id,
          expectedVersion: check.version,
        },
      }).then(
        () => "accepted",
        (e: { code?: string }) => e.code ?? String(e),
      );
      let waiting = 0;
      for (let i = 0; i < 200 && waiting < 1; i++) {
        await new Promise((r) => setTimeout(r, 25));
        const [w] = await admin`select count(*)::int as n from pg_locks
          where locktype='advisory' and not granted
            and database=(select oid from pg_database where datname=current_database())`;
        waiting = w.n;
      }
      assert.equal(
        waiting,
        1,
        "the accept read 'open' and waits before addRound",
      );
      const previous = process.env.FISCAL_TICKETS_ENABLED;
      if (!ticketsOn) process.env.FISCAL_TICKETS_ENABLED = "false";
      let paid: Awaited<ReturnType<typeof recordPayment>>;
      try {
        paid = await run(t.s.cashier, (tx) =>
          recordPayment(tx, t.s.cashier, check.id, {
            operationId: op(),
            amount: check.total,
            received: check.total,
            method: "cash",
          }),
        );
      } finally {
        if (previous === undefined) delete process.env.FISCAL_TICKETS_ENABLED;
        else process.env.FISCAL_TICKETS_ENABLED = previous;
      }
      assert.equal(paid.version, check.version, "a payment keeps the version");
      assert.equal(
        await count(t.tenantId, "fiscal_tickets"),
        ticketsOn ? 1 : 0,
        ticketsOn ? "the payment issued the ticket" : "the kill switch",
      );
      release();
      await holder;
      assert.equal(await racing, "public_hold_target_invalid");
      const after = await run(t.s.owner, (tx) => getOrder(tx, check.id));
      assert.deepEqual(
        [after.total, after.rounds.length, after.checkState],
        [check.total, check.rounds.length, "paid"],
      );
      assert.equal(
        await count(t.tenantId, "fiscal_tickets"),
        ticketsOn ? 1 : 0,
      );
      const [row] = await asAdmin(
        t.tenantId,
        (tx) => tx`select state from public_order_holds where id=${h.id}`,
      );
      assert.equal(row.state, "pending");
    }
  });

  await test("41. expiry: staff decisions stop at expires_at; the diner keeps seeing a just-expired hold as waiting for the grace (CONCURRENCY-2: 60 s for an accept-policy hold, PUB-R3-L1); a pay-first accept that carries its payment passes up to PAID_ACCEPT_GRACE_SECONDS after expiry, nothing else does, and only a pay-first hold reads as waiting that long (LD-41, PUBLIC-MONEY-2)", async () => {
    const t = await makeTenant("grace");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const recent = await insertHold(
      t,
      { ...l, tableId: null },
      { expiredSecondsAgo: 5 },
    );
    await rejects(accept(t, recent.row.id), "public_order_expired");
    await rejects(reject(t, recent.row.id), "public_order_expired");
    const seen = await pub.status(l.token, recent.statusKey);
    assert.equal(seen.body.state, "pending", "inside the grace");
    assert.equal(
      (await pub.cancel(l.token, recent.statusKey)).body.error,
      "public_order_expired",
      "the cancel uses the exact expiry",
    );
    const old = await insertHold(
      t,
      { ...l, tableId: null },
      { expiredSecondsAgo: HOLD_EXPIRY_GRACE_SECONDS + 5 },
    );
    assert.equal(
      (await pub.status(l.token, old.statusKey)).body.state,
      "expired",
    );

    // PUBLIC-MONEY-2: the cashier charged the terminal while the hold
    // expired. Only the pay-first accept that carries the payment still
    // passes, for PAID_ACCEPT_GRACE_SECONDS; the diner sees it as waiting
    // until then and cannot cancel it. An accept-policy hold keeps the
    // 60-second commit grace (PUB-R3-L1).
    assert.equal(PAID_ACCEPT_GRACE_SECONDS, 300);
    assert.equal(HOLD_EXPIRY_GRACE_SECONDS, 60);
    assert.equal(
      holdExpiryGraceSeconds("pay_first"),
      PAID_ACCEPT_GRACE_SECONDS,
    );
    assert.equal(holdExpiryGraceSeconds("accept"), HOLD_EXPIRY_GRACE_SECONDS);
    const pay = { amount: 4500, received: 5000, method: "cash" };
    const late = await insertHold(
      t,
      { ...l, tableId: null },
      { expiredSecondsAgo: 60, policy: "pay_first" },
    );
    assert.equal(
      (await pub.status(l.token, late.statusKey)).body.state,
      "pending",
      "the diner does not see vencido while staff can still collect",
    );
    assert.equal(
      (await pub.cancel(l.token, late.statusKey)).body.error,
      "public_order_expired",
      "the diner cannot cancel what staff may be collecting",
    );
    await rejects(reject(t, late.row.id), "public_order_expired");
    // A manager's exception without payment gets no grace.
    await rejects(
      accept(t, late.row.id, {}, t.s.manager),
      "public_order_expired",
    );
    const collected = await accept(t, late.row.id, { payment: pay });
    assert.deepEqual(
      [collected.hold.state, collected.order.paid],
      ["accepted", 4500],
    );
    const seen2 = await pub.status(l.token, late.statusKey);
    assert.equal(seen2.body.state, "accepted");
    // An accept-policy hold gets no payment grace.
    const acceptPolicy = await insertHold(
      t,
      { ...l, tableId: null },
      { expiredSecondsAgo: 60, policy: "accept" },
    );
    await rejects(
      accept(t, acceptPolicy.row.id, { payment: pay }),
      "public_order_expired",
    );
    // Nobody can accept it any more, so past the 60-second grace its diner
    // reads it as expired, while a pay-first hold expired as long ago still
    // reads as waiting (PUB-R3-L1).
    const lapsed = await insertHold(
      t,
      { ...l, tableId: null },
      { expiredSecondsAgo: 90, policy: "accept" },
    );
    assert.equal(
      (await pub.status(l.token, lapsed.statusKey)).body.state,
      "expired",
      "an accept-policy hold reads as expired after 60 s",
    );
    const collectable = await insertHold(
      t,
      { ...l, tableId: null },
      { expiredSecondsAgo: 90, policy: "pay_first" },
    );
    assert.equal(
      (await pub.status(l.token, collectable.statusKey)).body.state,
      "pending",
      "a pay-first hold reads as waiting while staff can still collect it",
    );
    // Past the grace even the paid accept is refused, and nothing was sold.
    const tooLate = await insertHold(
      t,
      { ...l, tableId: null },
      { expiredSecondsAgo: PAID_ACCEPT_GRACE_SECONDS + 5, policy: "pay_first" },
    );
    const sales = await salesRows(t.tenantId);
    await rejects(
      accept(t, tooLate.row.id, { payment: pay }),
      "public_order_expired",
    );
    assert.deepEqual(await salesRows(t.tenantId), sales);
    assert.equal(
      (await pub.status(l.token, tooLate.statusKey)).body.state,
      "expired",
    );
  });

  await test("42. churn: diner cancellations have their own budget per table; the inbox names the code, the links list counts them, and the log line says which code (ABUSE-2)", async () => {
    const t = await makeTenant("churn");
    const l = await link(t, { kind: "table", tableId: t.tables[1].id });
    for (let i = 0; i < PUBLIC_LIMITS.table.cancelsPerWindow; i++) {
      const bi = await body(t, [{ productId: t.p.taco }]);
      assert.equal((await pub.submit(l.token, bi)).status, 200);
      assert.equal((await pub.cancel(l.token, bi.statusKey)).status, 200);
    }
    logLines.length = 0;
    const next = await pub.submit(
      l.token,
      await body(t, [{ productId: t.p.taco }]),
    );
    assert.deepEqual(
      [next.status, next.body.error],
      [429, "public_order_churn"],
    );
    const logged = logLines
      .map((x) => JSON.parse(x))
      .find((x) => x.message === "public_order_limited");
    assert(logged, logLines.join("\n"));
    assert.deepEqual(
      [logged.code, logged.kind, logged.ref, typeof logged.ipHash],
      ["public_order_churn", "table", l.ref, "string"],
    );
    const read = await run(t.s.cashier, (tx) => inbox(tx, t.s.cashier));
    assert.deepEqual(read.churning, [{ kind: "table", name: "Mesa 02" }]);
    const links = await run(t.s.manager, (tx) => listLinks(tx, t.s.manager));
    assert.equal(
      links.links.find((x) => x.id === l.id)?.recentCancelled,
      PUBLIC_LIMITS.table.cancelsPerWindow,
    );
  });

  await test("43. an abuse rejection of a sibling that commits while an accept runs rolls the accept back unless acknowledged (PUB-HR-2)", async () => {
    const t = await makeTenant("abuserace");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const b1 = await body(t, [{ productId: t.p.taco }]);
    const b2 = await body(t, [{ productId: t.p.taco }]);
    for (const b of [b1, b2]) await pub.submit(l.token, b);
    const [fake, real] = [await holdOf(t, b1), await holdOf(t, b2)];
    const before = await salesRows(t.tenantId);
    // Hold the real hold's order key so its accept stops after the first
    // revoke_reason read (null) and before createOrder.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    const holder = admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${t.tenantId + real.order_operation_id},0))`;
      locked();
      await gate;
    });
    await held;
    const racing = accept(t, real.id).then(
      () => "accepted",
      (e: { code?: string }) => e.code ?? String(e),
    );
    let waiting = 0;
    for (let i = 0; i < 200 && waiting < 1; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const [w] = await admin`select count(*)::int as n from pg_locks
        where locktype='advisory' and not granted
          and database=(select oid from pg_database where datname=current_database())`;
      waiting = w.n;
    }
    assert.equal(waiting, 1, "the accept read the code and waits");
    // The sibling's abuse rejection waits on nothing the accept holds.
    await reject(
      t,
      fake.id,
      { reason: "abuse", revokeLink: true },
      t.s.manager,
    );
    release();
    await holder;
    assert.equal(await racing, "public_hold_link_abuse");
    assert.deepEqual(await salesRows(t.tenantId), before, "nothing written");
    const [row] = await asAdmin(
      t.tenantId,
      (tx) => tx`select state from public_order_holds where id=${real.id}`,
    );
    assert.equal(row.state, "pending");
    const ok = await accept(t, real.id, { abuseAcknowledged: true });
    assert.equal(ok.hold.state, "accepted");
    const [audited] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select detail from audit where operation='public.hold_accepted' and entity_id=${real.id}`,
    );
    assert.equal(audited.detail.abuseAcknowledged, true);
  });

  await test("44. the inbox's churn read uses the cancelled-holds partial index, not the tenant's history (PUB-HR-3)", async () => {
    const t = await makeTenant("churnplan");
    const plan = (
      await run(t.s.cashier, async (tx) => {
        await tx`set local enable_seqscan = off`;
        return tx.unsafe(
          `explain select coalesce(h.table_id,h.link_id),count(*)
            from public_order_holds h
            where h.state='cancelled'
              and h.created_at>now()-make_interval(mins=>$1)
            group by coalesce(h.table_id,h.link_id)`,
          [PUBLIC_LIMITS.windowMinutes],
        );
      })
    )
      .map((r: any) => r["QUERY PLAN"])
      .join("\n");
    assert.match(plan, /public_order_holds_cancelled_recent/, plan);
  });

  await test("45. B1 totals: a border restaurant with a full fiscal identity; the fiscal context never changes a hold's total, a pay-first accept's ticket gross is the total it charged, the status shows the folio, and the diner menu carries no fiscal fields (X26, C29)", async () => {
    const t = await makeTenant("border");
    // A complete border identity (LD-25 SAT-1: RFC, name, regime, a postal
    // code of a border state and the branch address), as fiscal's own suite.
    await run(t.s.owner, (tx) =>
      saveFiscalProfile(tx, t.s.owner, {
        operationId: op(),
        expectedVersion: 0,
        identity: {
          rfc: "EKU9003173C9",
          legalName: "ALIMENTOS FRONTERIZOS DE PRUEBA",
          regime: "601",
          postalCode: "22000",
          address: {
            street: "Av. Revolución 1234",
            neighborhood: "Zona Centro",
            municipality: "Tijuana",
            state: "Baja California",
          },
        },
        ticketSeries: "QR",
        taxRegion: "border_north",
        defaultTaxCategory: "iva8",
        borderConfirmed: true,
      }),
    );
    // One product at the profile default (IVA 8% here), one pinned to 16%.
    await asAdmin(
      t.tenantId,
      (tx) =>
        tx`update catalog set data=jsonb_set(data,'{fiscal}',${tx.json({ taxCategory: "iva16", satProductKey: "90101501", satUnitKey: "H87" })}) where id=${t.p.salsa}`,
    );
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
    const l = await link(t, { kind: "table", tableId: t.tables[0].id });
    // C29: the diner menu never carries a product's tax category or SAT keys.
    const menu = await pub.menu(l.token);
    assert.equal(menu.status, 200);
    for (const field of ['"fiscal"', '"taxCategory"', '"satProductKey"'])
      assert(!JSON.stringify(menu.body).includes(field), field);
    // X26: prices include IVA, so the context changes the tax split, never a
    // line total: the diner's quote, the inbox re-quote and acceptHold's
    // check (default context) match createOrder's (the restaurant's).
    const b1 = await body(t, [
      { productId: t.p.taco, quantity: 2 },
      { productId: t.p.salsa, options: [t.p.verde, t.p.queso] },
    ]);
    const catalogNow = await run(t.s.owner, (tx) => catalog(tx));
    const border: FiscalContext = {
      region: "border_north",
      defaultCategory: "iva8",
    };
    const lines = b1.lines.map((x) => ({ ...x, note: "" }));
    const plain = quote(lines, catalogNow, false, DEFAULT_FISCAL_CONTEXT);
    const real = quote(lines, catalogNow, false, border);
    assert.deepEqual(
      real.map((x) => x.total),
      plain.map((x) => x.total),
    );
    assert.deepEqual(
      real.map((x) => x.tax.category),
      ["iva8", "iva16"],
      "the border context really applies",
    );
    assert.equal(b1.expectedTotal, 15000);
    assert.equal((await pub.submit(l.token, b1)).status, 200);
    const h = await holdOf(t, b1);
    const r = await accept(t, h.id, {
      payment: { amount: 15000, received: 20000, method: "cash" },
    });
    assert.equal(r.order.checkState, "paid");
    const [ticket] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select f.series,f.number,f.gross,f.issuer->>'rfc' as rfc,
            (select coalesce(sum(x.gross),0)::int from fiscal_ticket_taxes x
              where x.tenant_id=f.tenant_id and x.ticket_id=f.id) as groups_gross,
            (select array_agg(x.category order by x.category) from fiscal_ticket_taxes x
              where x.tenant_id=f.tenant_id and x.ticket_id=f.id) as categories
          from fiscal_tickets f where f.order_id=${r.order.id}`,
    );
    assert(ticket, "the accept's payment issued the ticket");
    const [held] = await asAdmin(
      t.tenantId,
      (tx) =>
        tx`select quoted_total,accepted_total from public_order_holds where id=${h.id}`,
    );
    assert.deepEqual(
      [
        held.quoted_total,
        held.accepted_total,
        r.order.total,
        ticket.gross,
        ticket.groups_gross,
      ],
      [15000, 15000, 15000, 15000, 15000],
    );
    assert.deepEqual(ticket.categories, ["iva16", "iva8"]);
    assert.equal(ticket.rfc, "EKU9003173C9", "the full identity is on it");
    const folio = formatFolio(ticket.series, Number(ticket.number));
    assert.equal(folio, "QR-000001");
    assert.equal(r.order.fiscal?.ticket?.folio, folio);
    // The diner follows the order to its folio, as the printed ticket shows.
    const status = await pub.status(l.token, b1.statusKey);
    assert.deepEqual(status.body.order!.money, {
      total: 15000,
      paid: 15000,
      balance: 0,
    });
    assert.deepEqual(status.body.order!.fiscal, {
      folio,
      selfInvoiceCode: null,
    });
  });

  await test("46. diner name and note: a NUL, other controls and bidi overrides are refused with 400 invalid_input before any lock or row (never a 500); a note keeps its line breaks and tabs (PUBLIC-SECURITY-1)", async () => {
    const t = await makeTenant("controls");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const holds = () => count(t.tenantId, "public_order_holds");
    const before = await holds();
    for (const over of [
      { name: "\u0000" },
      { note: "sin cebolla\u0000" },
      { name: "Ana\u0007" },
      { name: "Ana\nLópez" },
      { name: "\u202eQ-3" },
      { name: "Luis\u2066" },
      { note: "\u202dsin sal" },
      { note: "sin\rsal" },
      { name: "\u0085" },
    ]) {
      const r = await pub.submit(
        l.token,
        await body(t, [{ productId: t.p.taco }], over),
      );
      assert.deepEqual(
        [r.status, r.body.error],
        [400, "invalid_input"],
        JSON.stringify(over),
      );
    }
    assert.equal(await holds(), before, "no row for a refused submit");
    const fine = await body(t, [{ productId: t.p.taco }], {
      name: "José Ñúñez",
      note: "sin cebolla\n\tsalsa aparte",
    });
    const ok = await pub.submit(l.token, fine);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const h = await holdOf(t, fine);
    assert.deepEqual(
      [h.name, h.note],
      ["José Ñúñez", "sin cebolla\n\tsalsa aparte"],
    );
  });

  await test("47. 034: the transition trigger lets a redaction-only update through in every state (name and note blanked, nothing else changed) and still refuses every other change, a redaction mixed with another change included; only the schema owner may send it (LD-41, PUBLIC-SECURITY-3)", async () => {
    const t = await makeTenant("redaction");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const owner = postgres(migration, {
      max: 1,
      onnotice: () => {},
      connection: { role: "gm_migrator" },
    });
    const asOwner = <T>(fn: (tx: any) => Promise<T>) =>
      owner.begin(async (tx) => {
        await tx`select set_config('app.tenant_id',${t.tenantId},true)`;
        return fn(tx);
      }) as Promise<T>;
    const row = async (id: string) =>
      (
        await asOwner(
          (tx) => tx`select * from public_order_holds where id=${id}`,
        )
      )[0];
    const immutable = /public_order_hold_immutable/;
    try {
      const named = async (
        state: "pending" | "accepted" | "rejected" | "cancelled",
      ) => {
        const b = await body(t, [{ productId: t.p.taco }], {
          name: `Ana ${state}`,
          note: "sin cebolla",
        });
        await pub.submit(l.token, b);
        const h = await holdOf(t, b);
        if (state === "accepted") await accept(t, h.id);
        if (state === "rejected") await reject(t, h.id);
        if (state === "cancelled") await pub.cancel(l.token, b.statusKey);
        return h.id as string;
      };
      for (const state of [
        "pending",
        "accepted",
        "rejected",
        "cancelled",
      ] as const) {
        const id = await named(state);
        const before = await row(id);
        assert.equal(before.state, state);
        // Mixed with any other change it is not a redaction: refused.
        await assert.rejects(
          asOwner(
            (tx) =>
              tx`update public_order_holds set name='',note='',expires_at=expires_at+interval '1 minute' where id=${id}`,
          ),
          immutable,
          state,
        );
        await assert.rejects(
          asOwner(
            (tx) =>
              tx`update public_order_holds set name='',note='',lines='[]' where id=${id}`,
          ),
          immutable,
        );
        // Half a redaction is a change too.
        await assert.rejects(
          asOwner(
            (tx) => tx`update public_order_holds set name='' where id=${id}`,
          ),
          immutable,
        );
        await assert.rejects(
          asOwner(
            (tx) =>
              tx`update public_order_holds set name='',note='otra' where id=${id}`,
          ),
          immutable,
        );
        if (state === "pending")
          await assert.rejects(
            asOwner(
              (tx) =>
                tx`update public_order_holds set name='',note='',state='cancelled',decided_at=now() where id=${id}`,
            ),
            immutable,
          );
        assert.deepEqual(
          await row(id),
          before,
          "refused updates change nothing",
        );
        await asOwner(
          (tx) =>
            tx`update public_order_holds set name='',note='' where id=${id}`,
        );
        assert.deepEqual(await row(id), { ...before, name: "", note: "" });
        // Redacting again is a no-op, not an error.
        await asOwner(
          (tx) =>
            tx`update public_order_holds set name='',note='' where id=${id}`,
        );
      }
      // A redacted pending hold is still decided as usual.
      const pendingId = await named("pending");
      await asOwner(
        (tx) =>
          tx`update public_order_holds set name='',note='' where id=${pendingId}`,
      );
      const r = await accept(t, pendingId);
      assert.equal(r.order.name, r.hold.label, "no name left to call");
      // The runtime role cannot send it (grants, scripts/grants.sql -- 034).
      const [privileges] =
        await admin`select has_column_privilege('gm_app','public_order_holds','name','UPDATE') as name,
          has_column_privilege('gm_app','public_order_holds','note','UPDATE') as note,
          has_column_privilege('gm_app','public_order_holds','state','UPDATE') as state`;
      assert.deepEqual(
        { ...privileges },
        { name: false, note: false, state: true },
      );
    } finally {
      await owner.end();
    }
  });

  await test("48. retention blanks the name and note of holds older than 30 days in every state, keeps newer ones, never deletes a hold, restores FORCE RLS and counts the redactions in its summary (LD-41, PUBLIC-SECURITY-3)", async () => {
    const t = await makeTenant("retention");
    const l = await link(t, { kind: "counter", label: "Ventanilla" });
    const recent = await body(t, [{ productId: t.p.taco }], {
      name: "Reciente",
      note: "sin sal",
    });
    await pub.submit(l.token, recent);
    const kept = await holdOf(t, recent);
    const paid = await body(t, [{ productId: t.p.taco }], {
      name: "Pagó",
      note: "aparte",
    });
    await pub.submit(l.token, paid);
    const order = await accept(t, (await holdOf(t, paid)).id);
    /** A hold created 40 days ago, as the previous months left it. */
    const old = (state: "pending" | "cancelled" | "accepted") =>
      asAdmin(t.tenantId, async (tx) => {
        const date = (
          await tx`select (now() - interval '40 days')::date as d`
        )[0].d;
        const [n] =
          await tx`insert into public_hold_numbers(tenant_id,business_date,value)
          values(${t.tenantId},${date},1) on conflict(tenant_id,business_date)
          do update set value=public_hold_numbers.value+1 returning value`;
        const lineId = randomUUID();
        const decided =
          state === "pending"
            ? tx`null,null,null,null,null,null`
            : state === "cancelled"
              ? tx`now()-interval '40 days'+interval '5 minutes',null,null,null,null,null`
              : tx`now()-interval '40 days'+interval '5 minutes',${t.ids.cashier}::uuid,${order.order.id}::uuid,1,4500,${tx.json([{ id: lineId, unitPrice: 4500, total: 4500 }])}`;
        const [h] =
          await tx`insert into public_order_holds(tenant_id,id,link_id,operation_id,request_hash,
            status_key_hash,business_date,number,channel,mode,table_id,policy,name,note,lines,priced,quoted_total,
            menu_revision,order_operation_id,state,created_at,expires_at,
            decided_at,decided_by,order_id,order_round,accepted_total,accepted_lines)
          values(${t.tenantId},${randomUUID()},${l.id},${randomUUID()},${"0".repeat(64)},
            ${statusHash(newPublicToken())},${date},${n.value},'qr','takeaway',null,'accept',
            ${"Antes " + state},'nota vieja',
            ${tx.json([{ id: lineId, productId: t.p.taco, quantity: 1, options: [] }])},
            ${tx.json([{ id: lineId, quantity: 1, name: { es: "Taco", en: "Taco" }, optionNames: [], unitPrice: 4500, total: 4500 }])},
            4500,0,${randomUUID()},${state},now()-interval '40 days',now()-interval '40 days'+interval '30 minutes',
            ${decided})
          returning id`;
        return h.id as string;
      });
    const olds = [
      await old("pending"),
      await old("cancelled"),
      await old("accepted"),
    ];
    const owner = postgres(migration, {
      max: 1,
      onnotice: () => {},
      connection: { role: "gm_migrator" },
    });
    const counted = () =>
      asAdmin(
        t.tenantId,
        (tx) =>
          tx`select id,name,note,state from public_order_holds order by id`,
      );
    try {
      const before = await counted();
      logLines.length = 0;
      const result = await runRetention(owner, { pauseMs: 0 });
      assert.deepEqual([result.failed, result.skipped], [[], []]);
      assert.ok(
        result.redacted.public_order_holds >= olds.length,
        JSON.stringify(result),
      );
      assert.ok("jobs" in result.deleted, "the summary keeps its deletions");
      const after = await counted();
      assert.equal(after.length, before.length, "no hold was deleted");
      const byId = new Map(after.map((h: any) => [h.id, h]));
      for (const id of olds)
        assert.deepEqual(
          [byId.get(id).name, byId.get(id).note],
          ["", ""],
          `old hold ${id}`,
        );
      assert.deepEqual(
        [byId.get(kept.id).name, byId.get(kept.id).note],
        ["Reciente", "sin sal"],
      );
      const paidHold = after.find((h: any) => h.name === "Pagó");
      assert.ok(paidHold, "a recent accepted hold keeps its name");
      const [states] = await asAdmin(
        t.tenantId,
        (tx) =>
          tx`select array_agg(state order by id) as s from public_order_holds where id=any(${tx.array(olds)}::uuid[])`,
      );
      assert.deepEqual(
        [...states.s].sort(),
        ["accepted", "cancelled", "pending"],
        "states unchanged",
      );
      const [forced] =
        await admin`select relforcerowsecurity as f from pg_class where oid=to_regclass('public.public_order_holds')`;
      assert.equal(forced.f, true, "FORCE ROW LEVEL SECURITY is restored");
      const summary = logLines
        .map((line) => JSON.parse(line))
        .find((line) => line.message === "retention_run");
      assert.ok(summary, "retention_run logged");
      assert.equal(
        summary.redacted.public_order_holds,
        result.redacted.public_order_holds,
      );
      // A second run finds nothing left of these holds to blank (nor, loyalty 038's rule, any
      // inactive club member, nor kiosk 039's, any old checkout member reference: every rule
      // reports its table).
      const again = await runRetention(owner, { pauseMs: 0 });
      assert.deepEqual(again.redacted, {
        public_order_holds: 0,
        loyalty_members: 0,
        kiosk_checkouts: 0,
      });
    } finally {
      await owner.end();
    }
  });

  console.log(`${checks} public ordering checks passed`);
  await pub.close();
} finally {
  await sql.end();
  await admin.end();
  await worker.end();
}
