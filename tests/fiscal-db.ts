// Fiscal (027) DB suite: ticket issuance with a gapless folio, tax snapshots, refund tax,
// immutability, RLS, the profile, the register, the summary, repair and the global lock order.
// Runs against the isolated test target (tests/isolated-target.ts) on fresh fixture tenants,
// which the cleanup deletes in one transaction with the immutability triggers switched off by
// name (LD-12 pattern, LD-16 L5).
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { noRetries } from "./db-retries.js";
import { checkRole, connect, tenant, type Tx } from "../server/db.js";
import {
  addRound,
  createOrder,
  getOrder,
  getOrders,
  recordPayment,
} from "../server/orders.js";
import { closeCheck, listOrders, recordSettlement } from "../server/checks.js";
import { voidLines } from "../server/voids.js";
import { assignService } from "../server/service.js";
import { refund } from "../server/operations.js";
import { saveLegacyProduct, saveMenuProduct } from "../server/menu.js";
import {
  reconcileOfflineRecord,
  syncOfflineRecord,
} from "../server/offline-sync.js";
import { resolvePaymentAttempt } from "../server/offline-attempts.js";
// Registers the order, round and payment appliers and reconcilers (offline table service).
import "../server/offline-tables.js";
import {
  fiscalContextView,
  fiscalSummary,
  fiscalTicketIdentity,
  getFiscalProfile,
  issueDueTicket,
  listTickets,
  missingTicketCount,
  recordRefundTax,
  REPAIR_BATCH,
  repairMissingTickets,
  saveFiscalProfile,
  ticketForCfdi,
} from "../server/fiscal.js";
import { businessDate, type Order, type Session } from "../shared/domain.js";
import {
  extractTax,
  RECOVERY_LINE_NAME,
  TAX_RULES,
  type TaxCategory,
} from "../shared/fiscal.js";
import type { SessionAccess } from "../shared/access.js";

const { runtime, migration } = isolatedTarget(process.env),
  sql = connect(runtime),
  // TRUNCATE … CASCADE notices are expected noise in the immutability checks.
  admin = postgres(migration, { max: 1, onnotice: () => {} });
await checkRole(sql);

/** Fiscal (027) and menu (025) triggers the cleanup disables to delete fixture rows. */
const CLEANUP_TRIGGERS = [
  ["fiscal_adjustments", "fiscal_adjustments_immutable"],
  ["fiscal_ticket_taxes", "fiscal_ticket_taxes_immutable"],
  ["fiscal_tickets", "fiscal_tickets_immutable"],
  ["fiscal_folio_counters", "fiscal_folio_counters_guard"],
  ["stock_movements", "stock_movements_immutable"],
] as const;

const timezone = "America/Mexico_City";
const cutoff = 240;
type Fixture = {
  org: string;
  id: string;
  name: string;
  currency: string;
  owner: string;
  manager: string;
  cashier: string;
  devices: string[];
  drawers: string[];
};
function fixture(name: string, currency = "MXN", devices = 2): Fixture {
  return {
    org: randomUUID(),
    id: randomUUID(),
    name,
    currency,
    owner: randomUUID(),
    manager: randomUUID(),
    cashier: randomUUID(),
    devices: Array.from({ length: devices }, () => randomUUID()),
    drawers: Array.from({ length: devices }, () => randomUUID()),
  };
}
const A = fixture("Taquería Fiscal A");
const B = fixture("Frontera Fiscal B", "MXN", 1);
const C = fixture("Dollar Diner C", "USD", 1);
const tenants = [A, B, C];

const restaurantOf = (f: Fixture) => ({
  name: f.name,
  currency: f.currency,
  timezone,
  cutoff,
});
const session = (
  f: Fixture,
  role: "owner" | "manager" | "cashier",
  device = 0,
  access?: SessionAccess,
): Session => ({
  id: randomUUID(),
  tenantId: f.id,
  employeeId: f[role],
  name: role,
  role,
  deviceId: f.devices[device],
  expiresAt: "",
  offlineUntil: "",
  csrf: "",
  restaurant: restaurantOf(f),
  ...(access ? { access } : {}),
});
const staleAccess: SessionAccess = {
  absoluteExpiresAt: null,
  authenticatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  deviceName: "Caja",
  deviceKind: "terminal",
  idleLockSeconds: null,
  ownerAccount: false,
};

const ownerA = session(A, "owner");
const managerA = session(A, "manager");
const cashierA = session(A, "cashier");
const cashierA2 = session(A, "cashier", 1);
const ownerB = session(B, "owner");
const cashierB = session(B, "cashier");
const ownerC = session(C, "owner");

// Products (ids by name) and their prices.
const P = {
  taco: randomUUID(), // 4500, default (IVA 16%), optional "Queso extra" +1000
  agua: randomUUID(), // 3500, explicit IVA 16%
  cafe: randomUUID(), // 18000, IVA 0% (coffee beans)
  exento: randomUUID(), // 5000, exempt
  gratis: randomUUID(), // 0
  platillo: randomUUID(), // 12345, default
  stocked: randomUUID(), // 3000, default, recipe on a stock item
  frontera8: randomUUID(), // B: 2000, IVA 8%
  fronteraDefault: randomUUID(), // B: 1000, default (IVA 8% in B)
  fronteraStocked: randomUUID(), // B: 1500, recipe
  dolar: randomUUID(), // C: 1000
};
const cheese = randomUUID();
const queso = randomUUID();
const stockA = randomUUID();
const stockB = randomUUID();
const tablesA = Array.from({ length: 6 }, () => randomUUID());
const tablesB = Array.from({ length: 6 }, () => randomUUID());
const prices: Record<string, number> = {};

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
async function rejects(promise: Promise<unknown>, code: string | RegExp) {
  await assert.rejects(promise, (e: any) => {
    if (code instanceof RegExp)
      assert.match(`${e?.code ?? ""} ${e?.message ?? e}`, code);
    else assert.equal(e?.code ?? e?.message, code);
    return true;
  });
}
const run = <T>(s: Session, fn: (tx: Tx) => Promise<T>) =>
  tenant(sql, s.tenantId, fn);
/** The fixture role with a tenant set: triggers fire, RLS is bypassed (superuser). */
const asAdmin = <T>(tenantId: string, fn: (tx: any) => Promise<T>) =>
  admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id',${tenantId},true)`;
    return fn(tx);
  }) as Promise<T>;

type LineSpec = { product: string; quantity?: number; options?: string[] };
const lineInput = (l: LineSpec) => ({
  id: randomUUID(),
  productId: l.product,
  quantity: l.quantity ?? 1,
  options: l.options ?? [],
  note: "",
});
async function newOrder(
  s: Session,
  lines: LineSpec[],
  extra: { mode?: string; tableId?: string | null; name?: string } = {},
): Promise<Order> {
  return run(s, (tx) =>
    createOrder(tx, s, {
      operationId: randomUUID(),
      lines: lines.map(lineInput),
      mode: extra.mode ?? "takeaway",
      tableId: extra.tableId ?? null,
      name: extra.name ?? "Fiscal",
      note: "",
      channel: "pos",
    }),
  );
}
function pay(
  s: Session,
  o: Order,
  amount = o.total - o.paid,
  extra: Record<string, unknown> = {},
): Promise<Order> {
  return run(s, (tx) =>
    recordPayment(tx, s, o.id, {
      operationId: randomUUID(),
      amount,
      tip: 0,
      received: amount + ((extra.tip as number | undefined) ?? 0),
      method: "cash",
      ...extra,
    }),
  );
}
const read = (s: Session, id: string) => run(s, (tx) => getOrder(tx, id));
async function tickets(tenantId: string, where = "true") {
  return admin.unsafe(
    `select * from fiscal_tickets where tenant_id=$1 and ${where} order by number`,
    [tenantId],
  );
}
async function ticketOf(tenantId: string, orderId: string) {
  const [t] =
    await admin`select * from fiscal_tickets where tenant_id=${tenantId} and order_id=${orderId}`;
  return t;
}
async function counter(tenantId: string, series = "") {
  const [c] =
    await admin`select last_value from fiscal_folio_counters where tenant_id=${tenantId} and series=${series}`;
  return c ? Number(c.last_value) : 0;
}
const today = () => businessDate(new Date().toISOString(), timezone, cutoff);
const rate = (c: TaxCategory) => TAX_RULES[c].rateBps;

/** Session row plus offline lease (offline-sync-db's fixture), for offline records. */
async function offlineSession(
  f: Fixture,
  role: "owner" | "manager" | "cashier",
  device = 0,
  leaseAge = "30 minutes",
): Promise<Session> {
  const id = randomUUID();
  await admin`insert into sessions(tenant_id,id,employee_id,device_id,token_hash,csrf,expires_at,offline_until,selling_authorized)
    values(${f.id},${id},${f[role]},${f.devices[device]},${"fixture-" + id},'fixture',now()+interval '12 hours',now()+interval '4 hours',true)`;
  const [r] =
    await admin`select config_version from restaurants where id=${f.id}`;
  await admin`insert into offline_leases(tenant_id,session_id,employee_id,device_id,contract_version,issued_at,valid_until,selling_authorized,plan,configuration_version,restaurant_snapshot)
    values(${f.id},${id},${f[role]},${f.devices[device]},1,now()-${leaseAge}::interval,now()+interval '4 hours',true,'pro',${r.config_version},${admin.json(restaurantOf(f))})`;
  return {
    ...session(f, role, device),
    id,
    expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
    offlineUntil: new Date(Date.now() + 4 * 3600_000).toISOString(),
    offlineLeaseVersion: 1,
    offlineLeaseConfigVersion: r.config_version,
    csrf: "fixture",
    restaurant: { ...restaurantOf(f), configVersion: r.config_version },
  };
}
let sequence = 0;
function v3(
  f: Fixture,
  s: Session,
  kind: string,
  fields: Record<string, unknown>,
) {
  const at = new Date().toISOString();
  return {
    formatVersion: 3 as const,
    operationId: randomUUID(),
    tenantId: f.id,
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
}
const totalOf = (lines: ReturnType<typeof lineInput>[]) =>
  lines.reduce((a, l) => a + prices[l.productId] * l.quantity, 0);
const snapshotOf = (f: Fixture, lines: ReturnType<typeof lineInput>[]) => ({
  lines: lines.map((l) => ({ ...l, productVersion: 1 })),
  restaurant: restaurantOf(f),
});
function offlineSale(
  f: Fixture,
  s: Session,
  specs: LineSpec[],
  drawer = 0,
  draft?: { operationId: string; lines: ReturnType<typeof lineInput>[] },
) {
  const lines = draft?.lines ?? specs.map(lineInput);
  const total = totalOf(lines);
  return v3(f, s, "sale", {
    provisionalNumber: "F-01",
    cashSessionId: f.drawers[drawer],
    order: {
      operationId: draft?.operationId ?? randomUUID(),
      lines,
      mode: "takeaway",
      tableId: null,
      name: "Venta sin conexión",
      note: "",
      channel: "pos",
    },
    expectedTotal: total,
    payment: {
      method: "cash",
      amount: total,
      tip: 0,
      received: total,
      reference: "",
      externalConfirmed: false,
    },
    receiptSnapshot: snapshotOf(f, lines),
  });
}
function offlineRound(
  f: Fixture,
  s: Session,
  orderId: string,
  specs: LineSpec[],
) {
  const lines = specs.map(lineInput);
  return v3(f, s, "round", {
    cashSessionId: null,
    target: { orderId },
    lines,
    expectedTotal: totalOf(lines),
    receiptSnapshot: snapshotOf(f, lines),
  });
}
function offlinePayment(
  f: Fixture,
  s: Session,
  orderId: string,
  amount: number,
  drawer = 0,
) {
  return v3(f, s, "payment", {
    kitchenDelivery: "not_applicable",
    cashSessionId: f.drawers[drawer],
    target: { orderId },
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
}

async function setupFixtures() {
  for (const f of tenants) {
    await admin`insert into organizations(id,name) values(${f.org},${f.name})`;
    await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,free_location)
      values(${f.id},${f.org},${f.name},${f.currency},${timezone},${cutoff},true)`;
    await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source)
      values(${f.id},'active',now()+interval '1 day','fixture')`;
    for (const role of ["owner", "manager", "cashier"] as const)
      await admin`insert into employees(tenant_id,id,name,login,secret_hash,role)
        values(${f.id},${f[role]},${role + " " + f.name},${randomUUID()},'fixture',${role})`;
    for (let i = 0; i < f.devices.length; i++) {
      await admin`insert into devices(tenant_id,id,name,token_hash,free_slot)
        values(${f.id},${f.devices[i]},${"Caja " + (i + 1)},'fixture',${i === 0 ? 1 : null})`;
      await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at)
        values(${f.id},${f.drawers[i]},${f.devices[i]},${f.cashier},0,now()-interval '2 hours')`;
    }
  }
  await admin`insert into stock_items(tenant_id,id,name,unit,kind) values(${A.id},${stockA},'Tortilla A','piece','raw'),(${B.id},${stockB},'Tortilla B','piece','raw')`;
  const product = (
    f: Fixture,
    id: string,
    name: string,
    price: number,
    extra: Record<string, unknown> = {},
  ) => {
    prices[id] = price;
    return admin`insert into catalog(tenant_id,id,data) values(${f.id},${id},${admin.json(
      {
        id,
        name: { es: name, en: name },
        category: { es: "Pruebas", en: "Tests" },
        price,
        available: true,
        station: "kitchen",
        groups: [],
        cost: null,
        recipe: [],
        version: 1,
        ...extra,
      },
    )})`;
  };
  prices[queso] = 1000;
  await product(A, P.taco, "Taco al pastor", 4500, {
    groups: [
      {
        id: cheese,
        name: { es: "Extras", en: "Extras" },
        min: 0,
        max: 1,
        options: [
          {
            id: queso,
            name: { es: "Queso extra", en: "Extra cheese" },
            price: 1000,
            available: true,
          },
        ],
      },
    ],
  });
  await product(A, P.agua, "Agua de jamaica", 3500, {
    fiscal: { taxCategory: "iva16", satProductKey: null, satUnitKey: null },
  });
  await product(A, P.cafe, "Café en grano", 18000, {
    fiscal: {
      taxCategory: "iva0",
      satProductKey: "50201708",
      satUnitKey: "KGM",
    },
  });
  await product(A, P.exento, "Servicio exento", 5000, {
    fiscal: { taxCategory: "exempt" },
  });
  await product(A, P.gratis, "Cortesía", 0);
  await product(A, P.platillo, "Platillo del día", 12345);
  await product(A, P.stocked, "Taco con tortilla", 3000, {
    recipe: [{ stockId: stockA, quantity: "2" }],
  });
  await product(B, P.frontera8, "Burrito fronterizo", 2000, {
    fiscal: { taxCategory: "iva8" },
  });
  await product(B, P.fronteraDefault, "Refresco", 1000);
  await product(B, P.fronteraStocked, "Taco norteño", 1500, {
    recipe: [{ stockId: stockB, quantity: "1" }],
  });
  await product(C, P.dolar, "Burger", 1000);
  for (const [f, tables] of [
    [A, tablesA],
    [B, tablesB],
  ] as const)
    for (let i = 0; i < tables.length; i++)
      await admin`insert into dining_tables(tenant_id,id,name) values(${f.id},${tables[i]},${"Mesa " + (i + 1)})`;
  // Opening stock for the recipe products (the ledger trigger scopes by app.tenant_id).
  for (const [f, stockId] of [
    [A, stockA],
    [B, stockB],
  ] as const)
    await asAdmin(
      f.id,
      (tx) =>
        tx`insert into stock_movements(tenant_id,id,stock_id,quantity,cause,cause_id,reason,actor_id)
          values(${f.id},${randomUUID()},${stockId},100000,'receipt',${randomUUID()},'Inventario inicial',${f.owner})`,
    );
}

/** B's issuer: a fictional SAT test RFC at a real northern-border postal code (Tijuana). */
const tijuana = {
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
};
const profileBody = (
  version: number,
  over: Partial<{
    identity: Record<string, unknown> | null;
    ticketSeries: string;
    taxRegion: string;
    defaultTaxCategory: string;
    borderConfirmed: boolean;
    multipleBranches: boolean;
  }> = {},
) => ({
  operationId: randomUUID(),
  expectedVersion: version,
  identity: {
    rfc: "EKU9003173C9",
    legalName: "ALIMENTOS DE PRUEBA",
    regime: "601",
    postalCode: "06700",
    address: {
      street: "Av. Ficticia 123",
      neighborhood: "Roma Norte",
      municipality: "Cuauhtémoc",
      state: "Ciudad de México",
    },
  },
  ticketSeries: "",
  taxRegion: "general",
  defaultTaxCategory: "iva16",
  borderConfirmed: false,
  ...over,
});

try {
  await setupFixtures();
  // B is a border restaurant whose products default to IVA 8%: the incentive needs its full
  // identity at a border postal code (SAT-1, LD-25).
  await run(ownerB, (tx) =>
    saveFiscalProfile(
      tx,
      ownerB,
      profileBody(0, {
        identity: tijuana,
        taxRegion: "border_north",
        defaultTaxCategory: "iva8",
        borderConfirmed: true,
      }),
    ),
  );

  const firstTickets: Record<string, number> = {};

  await test("MON-1: a fully paid order stores per-line tax snapshots and one ticket whose IVA reconciles to orders.total", async () => {
    // A's identity, so the ticket freezes an issuer.
    await run(ownerA, (tx) => saveFiscalProfile(tx, ownerA, profileBody(0)));
    const o = await newOrder(cashierA, [
      { product: P.taco, quantity: 2, options: [queso] },
      { product: P.agua },
      { product: P.cafe },
    ]);
    assert.equal(o.total, 2 * 5500 + 3500 + 18000);
    const rows =
      await admin`select data from order_lines where tenant_id=${A.id} and order_id=${o.id} order by round,id`;
    const snaps = rows.map((r) => r.data.tax);
    for (const r of rows) {
      const t = r.data.tax;
      assert.equal(t.v, 1);
      assert.equal(t.base + t.tax, r.data.total, "snapshot of the line total");
      assert.deepEqual(
        { base: t.base, tax: t.tax },
        extractTax(r.data.total, t.rateBps),
      );
    }
    assert.deepEqual(snaps.map((t) => t.category).sort(), [
      "iva0",
      "iva16",
      "iva16",
    ]);
    assert.equal(
      snaps.find((t) => t.category === "iva0").satProductKey,
      "50201708",
    );
    const paid = await pay(cashierA, o);
    assert.equal(paid.checkState, "closed");
    const all = await tickets(A.id, `order_id='${o.id}'`);
    assert.equal(all.length, 1);
    const t = all[0];
    firstTickets[A.id] = Number(t.number);
    assert.equal(t.gross, o.total);
    assert.equal(t.base + t.tax, o.total);
    assert.equal(t.source, "sale");
    assert.equal(t.tax_basis, "line_snapshot");
    assert.equal(t.issuer.rfc, "EKU9003173C9");
    assert.equal(t.issuer.tradeName, A.name);
    assert.equal(t.issued_by, cashierA.employeeId);
    assert.equal(t.device_id, A.devices[0]);
    const taxes =
      await admin`select * from fiscal_ticket_taxes where tenant_id=${A.id} and ticket_id=${t.id} order by category`;
    const iva16 = taxes.find((x) => x.category === "iva16")!;
    const iva0 = taxes.find((x) => x.category === "iva0")!;
    assert.deepEqual(
      { base: iva16.base, tax: iva16.tax },
      extractTax(14500, 1600),
      "IVA extracted once per category, not per line",
    );
    assert.deepEqual(
      { gross: iva0.gross, base: iva0.base, tax: iva0.tax },
      { gross: 18000, base: 18000, tax: 0 },
    );
    assert.equal(
      taxes.reduce((a, x) => a + x.gross, 0),
      o.total,
    );
    // The order JSON carries the ticket; its lines reconcile to the groups.
    const ticket = paid.fiscal!.ticket!;
    assert.equal(ticket.folio, String(t.number).padStart(6, "0"));
    assert.equal(paid.fiscal!.provisional, null);
    assert.deepEqual(
      ticket.groups.map((g) => g.category),
      ["iva16", "iva0"],
    );
    for (const g of ticket.groups) {
      const lines = ticket.lines.filter((l) => l.category === g.category);
      assert.equal(
        lines.reduce((a, l) => a + l.gross, 0),
        g.gross,
      );
      assert.equal(
        lines.reduce((a, l) => a + l.tax, 0),
        g.tax,
      );
    }
    assert.deepEqual(ticket.lines.find((l) => l.quantity === 2)!.optionNames, [
      { es: "Queso extra", en: "Extra cheese" },
    ]);
    assert.deepEqual(
      await run(cashierA, (tx) => fiscalTicketIdentity(tx, o.id)),
      { folio: ticket.folio, selfInvoiceCode: ticket.selfInvoiceCode },
    );
    assert.equal(
      await run(cashierA, (tx) => fiscalTicketIdentity(tx, randomUUID())),
      null,
    );
    // cfdi's payload: one concept per group with the folio as NoIdentificacion.
    const payload = await run(ownerA, (tx) => ticketForCfdi(tx, ticket.id));
    assert.deepEqual(
      payload.concepts.map((c) => [
        c.category,
        c.noIdentificacion,
        c.satRate,
        c.gross,
        c.tax,
      ]),
      ticket.groups.map((g) => [
        g.category,
        ticket.folio,
        TAX_RULES[g.category].satRate,
        g.gross,
        g.tax,
      ]),
    );
    assert.equal(
      payload.itemizedValid,
      ticket.lines.every((l) => l.valid),
    );
    assert.deepEqual(payload.payments, [{ method: "cash", amount: o.total }]);
  });

  await test("FIT-6: folios are consecutive per location and do not reset with the business date while order numbers do", async () => {
    const before = await counter(A.id);
    const folios: number[] = [];
    for (let i = 0; i < 3; i++) {
      const o = await newOrder(cashierA, [{ product: P.agua }]);
      await pay(cashierA, o);
      folios.push(Number((await ticketOf(A.id, o.id)).number));
    }
    assert.deepEqual(folios, [before + 1, before + 2, before + 3]);
    // Another business day: the daily order number restarts at 1, the folio does not.
    const nextDay = "2099-01-02";
    const o = await run(cashierA, (tx) =>
      createOrder(
        tx,
        cashierA,
        {
          operationId: randomUUID(),
          lines: [lineInput({ product: P.agua })],
          mode: "takeaway",
          tableId: null,
          name: "Mañana",
          note: "",
          channel: "pos",
        },
        { businessDate: nextDay },
      ),
    );
    assert.equal(o.number, 1, "the daily call number restarts");
    await pay(cashierA, o);
    const t = await ticketOf(A.id, o.id);
    assert.equal(Number(t.number), before + 4, "the folio keeps counting");
    assert.equal(
      (
        await admin`select business_date::text as d from fiscal_tickets where id=${t.id}`
      )[0].d,
      nextDay,
      "fiscal business date = the order's business date",
    );
  });

  await test("partial payment issues no ticket; the settling payment issues it with every tender snapshotted", async () => {
    const o = await newOrder(cashierA, [{ product: P.platillo }]);
    const part = await pay(cashierA, o, 5000, { tip: 700 });
    assert.equal(await ticketOf(A.id, o.id), undefined);
    assert.equal(
      await run(cashierA, (tx) => issueDueTicket(tx, cashierA, o.id)),
      null,
      "an unpaid balance issues nothing",
    );
    assert.equal(part.fiscal!.ticket, null);
    assert.equal(part.fiscal!.provisional!.gross, 12345);
    const settled = await run(cashierA, (tx) =>
      recordPayment(tx, cashierA, o.id, {
        operationId: randomUUID(),
        amount: 7345,
        tip: 300,
        received: 7645,
        method: "external",
        externalConfirmed: true,
        reference: "AUT-778",
      }),
    );
    const t = await ticketOf(A.id, o.id);
    assert.ok(t);
    assert.equal(t.tip, 1000, "Σ tender tips");
    assert.deepEqual(
      t.payments.map((p: any) => [p.method, p.amount, p.tip, p.reference]),
      [
        ["cash", 5000, 700, null],
        ["external", 7345, 300, "AUT-778"],
      ],
    );
    assert.equal(settled.fiscal!.ticket!.payments.length, 2);
  });

  await test("folios stay gapless and unique under 20 concurrent settling payments on two devices", async () => {
    const before = await counter(A.id);
    const orders = [];
    for (let i = 0; i < 20; i++)
      orders.push(await newOrder(cashierA, [{ product: P.agua }]));
    // LO-R9: no deadlock or serialization failure may hide behind tenant()'s retry.
    const results = await noRetries("20 settling payments", () =>
      Promise.allSettled(
        orders.map((o, i) => pay(i % 2 ? cashierA2 : cashierA, o)),
      ),
    );
    assert.deepEqual(
      results.filter((r) => r.status === "rejected"),
      [],
    );
    const numbers = (
      await admin`select number from fiscal_tickets where tenant_id=${A.id} and order_id=any(${admin.array(orders.map((o) => o.id))}::uuid[]) order by number`
    ).map((r) => Number(r.number));
    assert.deepEqual(
      numbers,
      Array.from({ length: 20 }, (_, i) => before + 1 + i),
    );
    assert.equal(await counter(A.id), before + 20);
  });

  await test("a transaction that fails after issuing rolls back the folio; the next ticket reuses the number", async () => {
    const before = await counter(A.id);
    const o = await newOrder(cashierA, [{ product: P.agua }]);
    await assert.rejects(
      run(cashierA, async (tx) => {
        await recordPayment(tx, cashierA, o.id, {
          operationId: randomUUID(),
          amount: o.total,
          tip: 0,
          received: o.total,
          method: "cash",
        });
        assert.equal(
          (
            await tx`select last_value from fiscal_folio_counters where series=''`
          )[0].last_value,
          String(before + 1),
        );
        throw new Error("after issuance");
      }),
      /after issuance/,
    );
    assert.equal(await counter(A.id), before);
    assert.equal(await ticketOf(A.id, o.id), undefined);
    await pay(cashierA, o);
    assert.equal(Number((await ticketOf(A.id, o.id)).number), before + 1);
  });

  await test("a counter advance without a ticket cannot commit (deferred gapless trigger)", async () => {
    const before = await counter(A.id);
    await rejects(
      run(
        ownerA,
        (tx) =>
          tx`insert into fiscal_folio_counters(tenant_id,series,last_value) values(${A.id},'',1)
            on conflict (tenant_id,series) do update set last_value=fiscal_folio_counters.last_value+1`,
      ),
      /has no ticket/,
    );
    await rejects(
      run(
        ownerA,
        (tx) =>
          tx`insert into fiscal_folio_counters(tenant_id,series,last_value) values(${A.id},'GAP',1)`,
      ),
      /has no ticket/,
    );
    await rejects(
      run(
        ownerA,
        (tx) =>
          tx`insert into fiscal_folio_counters(tenant_id,series,last_value) values(${A.id},'GAP2',5)`,
      ),
      /start at 1/,
    );
    assert.equal(await counter(A.id), before);
  });

  await test("a grouped settlement (service's up-front order lock) and a concurrent single payment both issue tickets without deadlock", async () => {
    for (let round = 0; round < 10; round++) {
      const a = await newOrder(cashierA, [{ product: P.agua }]);
      const b = await newOrder(cashierA, [{ product: P.agua }]);
      const c = await newOrder(cashierA, [{ product: P.agua }]);
      const [settled, single] = await noRetries(
        "grouped settlement vs single payment",
        () =>
          Promise.allSettled([
            run(cashierA, (tx) =>
              recordSettlement(tx, cashierA, {
                operationId: randomUUID(),
                orders: [
                  { id: a.id, amount: a.total },
                  { id: b.id, amount: b.total },
                ],
                received: a.total + b.total,
              }),
            ),
            pay(cashierA2, c),
          ]),
      );
      assert.equal(
        settled.status,
        "fulfilled",
        String((settled as any).reason),
      );
      assert.equal(single.status, "fulfilled", String((single as any).reason));
      for (const o of [a, b, c]) assert.ok(await ticketOf(A.id, o.id));
    }
  });

  await test("a round on a ticketed check fails with fiscal_ticket_issued in applyRound; an offline round sync onto it becomes offline_order_closed; a raw order_lines insert is blocked by the trigger", async () => {
    const o = await newOrder(cashierA, [{ product: P.taco }], {
      mode: "dine_in",
      tableId: tablesA[0],
    });
    const paid = await pay(cashierA, o);
    assert.equal(paid.checkState, "paid");
    assert.ok(paid.fiscal!.ticket);
    await rejects(
      run(cashierA, (tx) =>
        addRound(tx, cashierA, o.id, {
          operationId: randomUUID(),
          lines: [lineInput({ product: P.agua })],
          mode: "dine_in",
          tableId: tablesA[0],
          name: "",
          note: "",
          channel: "pos",
          expectedVersion: paid.version,
        }),
      ),
      "fiscal_ticket_issued",
    );
    const offlineA = await offlineSession(A, "cashier");
    for (const tableService of [false, true]) {
      await admin`update restaurants set offline_table_service=${tableService} where id=${A.id}`;
      await rejects(
        run(offlineA, (tx) =>
          syncOfflineRecord(
            tx,
            offlineA,
            offlineRound(A, offlineA, o.id, [{ product: P.agua }]),
          ),
        ),
        "offline_order_closed",
      );
    }
    await admin`update restaurants set offline_table_service=false where id=${A.id}`;
    await rejects(
      run(cashierA, async (tx) => {
        const line = { ...paid.lines[0], id: randomUUID() };
        await tx`insert into order_lines(tenant_id,id,order_id,product_id,round,data)
          values(${A.id},${line.id},${o.id},${line.productId},9,${tx.json(line as any)})`;
      }),
      /fiscal_ticket_issued/,
    );
    // Late items go out as a new order for the same table.
    const late = await newOrder(cashierA, [{ product: P.agua }], {
      mode: "dine_in",
      tableId: tablesA[0],
    });
    assert.equal(late.tableId, tablesA[0]);
    await pay(cashierA, late);
    for (const id of [o.id, late.id])
      await run(cashierA, (tx) =>
        closeCheck(tx, cashierA, id, { operationId: randomUUID() }),
      );
  });

  const voidBody = (o: Order, lineId: string, quantity: number) => ({
    operationId: randomUUID(),
    expectedVersion: o.version,
    lines: [{ lineId, quantity }],
    reason: "Prueba fiscal",
    stockDisposition: "no_return",
  });
  const voidAs = (s: Session, o: Order, lineId: string, quantity: number) =>
    run(s, (tx) =>
      voidLines(tx, s, o.id, voidBody(o, lineId, quantity), s.employeeId),
    );

  await test("a void that clears the last unpaid units issues the ticket for the paid units only", async () => {
    const o = await newOrder(cashierA, [{ product: P.taco, quantity: 3 }]);
    const line = o.lines[0];
    const part = await pay(cashierA, o, 4500, { items: [`${line.id}:0`] });
    assert.equal(await ticketOf(A.id, o.id), undefined);
    const after = await voidAs(ownerA, part, line.id, 2);
    assert.equal(after.checkState, "closed");
    assert.equal(after.closeReason, "settled");
    const t = await ticketOf(A.id, o.id);
    assert.equal(t.gross, 4500);
    assert.deepEqual(
      t.lines.map((l: any) => [l.quantity, l.gross]),
      [[1, 4500]],
    );
    assert.deepEqual({ base: t.base, tax: t.tax }, extractTax(4500, 1600));
  });

  await test("a fully voided unpaid order and a zero-total order get no ticket", async () => {
    const before = await counter(A.id);
    const o = await newOrder(cashierA, [{ product: P.taco, quantity: 2 }]);
    const voided = await voidAs(ownerA, o, o.lines[0].id, 2);
    assert.equal(voided.closeReason, "voided");
    const free = await newOrder(cashierA, [{ product: P.gratis }]);
    assert.equal(free.checkState, "closed");
    const freeTable = await newOrder(cashierA, [{ product: P.gratis }], {
      mode: "dine_in",
      tableId: tablesA[1],
    });
    assert.equal(freeTable.checkState, "paid");
    // closeCheck of a zero-total paid table check issues nothing either.
    const released = await run(cashierA, (tx) =>
      closeCheck(tx, cashierA, freeTable.id, { operationId: randomUUID() }),
    );
    assert.equal(released.closeReason, "released");
    for (const id of [o.id, free.id, freeTable.id])
      assert.equal(await ticketOf(A.id, id), undefined);
    assert.equal(await counter(A.id), before);
  });

  let offlineB: Session;
  await test("offline sync issues the ticket with the sale's business date; synced orders and rounds snapshot tax with the server context (border tenant, iva8 product)", async () => {
    offlineB = await offlineSession(B, "cashier");
    const before = await counter(B.id);
    const record = {
      ...offlineSale(B, offlineB, [
        { product: P.frontera8 },
        { product: P.fronteraDefault, quantity: 2 },
      ]),
      provisionalNumber: "Z9-731",
    };
    const synced = await run(offlineB, (tx) =>
      syncOfflineRecord(tx, offlineB, record),
    );
    const replay = await run(offlineB, (tx) =>
      syncOfflineRecord(tx, offlineB, record),
    );
    assert.equal(replay.orderId, synced.orderId);
    const all = await tickets(B.id, `order_id='${synced.orderId}'`);
    assert.equal(
      all.length,
      1,
      "newTender's second refresh issues no second folio",
    );
    assert.equal(await counter(B.id), before + 1);
    firstTickets[B.id] = Number(all[0].number);
    const [order] =
      await admin`select business_date::text as d from orders where tenant_id=${B.id} and id=${synced.orderId}`;
    assert.equal(
      (
        await admin`select business_date::text as d from fiscal_tickets where id=${all[0].id}`
      )[0].d,
      order.d,
    );
    assert.equal(
      order.d,
      businessDate(synced.soldAt, timezone, cutoff),
      "the sale's business date",
    );
    // FISCAL-OFFLINE-1: staff find the sale by the provisional number on the customer's
    // local receipt, and the order carries it (and the sale time) for its reprints.
    const found = await run(cashierB, (tx) =>
      listOrders(tx, cashierB, { status: "all", date: order.d, q: "z9-731" }),
    );
    assert.deepEqual(
      found.items.map((i) => i.id),
      [synced.orderId],
    );
    const view = await read(cashierB, synced.orderId);
    assert.equal(view.offline!.provisionalNumber, "Z9-731");
    assert.equal(view.offline!.soldAt, synced.soldAt);
    const lines =
      await admin`select data from order_lines where tenant_id=${B.id} and order_id=${synced.orderId}`;
    assert.deepEqual(
      lines.map((l) => [l.data.tax.category, l.data.tax.basis]).sort(),
      [
        ["iva8", "default"],
        ["iva8", "product"],
      ],
    );
    const taxes =
      await admin`select category,gross,tax from fiscal_ticket_taxes where ticket_id=${all[0].id}`;
    assert.deepEqual(
      taxes.map((t) => ({ ...t })),
      [{ category: "iva8", gross: 4000, tax: extractTax(4000, 800).tax }],
    );
    // An offline round onto an open server order also snapshots with B's context,
    // with offline table service off (default) and on (LD-7).
    for (const tableService of [false, true]) {
      await admin`update restaurants set offline_table_service=${tableService} where id=${B.id}`;
      const open = await newOrder(cashierB, [{ product: P.frontera8 }], {
        mode: "dine_in",
        tableId: tablesB[tableService ? 1 : 0],
      });
      const round = await run(offlineB, (tx) =>
        syncOfflineRecord(
          tx,
          offlineB,
          offlineRound(B, offlineB, open.id, [{ product: P.fronteraDefault }]),
        ),
      );
      assert.equal(round.orderId, open.id);
      const roundLines =
        await admin`select data from order_lines where tenant_id=${B.id} and order_id=${open.id} order by round`;
      assert.deepEqual(
        roundLines.map((l) => l.data.tax.category),
        ["iva8", "iva8"],
      );
      // The offline payment of the rest issues the ticket at sync.
      const settled = await run(offlineB, (tx) =>
        syncOfflineRecord(
          tx,
          offlineB,
          offlinePayment(B, offlineB, open.id, 3000),
        ),
      );
      assert.equal(settled.order.checkState, "paid");
      assert.ok(await ticketOf(B.id, open.id));
      await run(cashierB, (tx) =>
        closeCheck(tx, cashierB, open.id, { operationId: randomUUID() }),
      );
    }
    await admin`update restaurants set offline_table_service=false where id=${B.id}`;
  });

  await test("OFFLINE-6: an offline sale synced two days after it was sold gets its ticket on the sale's business date: in that day's summary, not in today's", async () => {
    // The lease and the drawer were open when the sale happened.
    const s = await offlineSession(A, "cashier", 1, "3 days");
    await admin`update cash_sessions set opened_at=now()-interval '3 days' where id=${A.drawers[1]}`;
    const soldAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const record = {
      ...offlineSale(A, s, [{ product: P.agua }], 1),
      recordedAt: soldAt,
      recordedAtDevice: soldAt,
      provisionalNumber: "Y7-12",
    };
    const synced = await run(s, (tx) => syncOfflineRecord(tx, s, record));
    const saleDay = businessDate(synced.soldAt, timezone, cutoff);
    assert.notEqual(saleDay, today());
    const [t] =
      await admin`select number,series,business_date::text as d,issued_at from fiscal_tickets
        where tenant_id=${A.id} and order_id=${synced.orderId}`;
    assert.equal(t.d, saleDay, "the sale's business date");
    assert.equal(
      businessDate((t.issued_at as Date).toISOString(), timezone, cutoff),
      today(),
      "issued today",
    );
    const inRuns = (summary: Awaited<ReturnType<typeof fiscalSummary>>) =>
      summary.tickets.series.some(
        (r) =>
          r.series === t.series &&
          r.first <= Number(t.number) &&
          Number(t.number) <= r.last,
      );
    assert.ok(
      inRuns(
        await run(managerA, (tx) =>
          fiscalSummary(tx, managerA, { from: saleDay, to: saleDay }),
        ),
      ),
    );
    assert.ok(
      !inRuns(
        await run(managerA, (tx) =>
          fiscalSummary(tx, managerA, { from: today(), to: today() }),
        ),
      ),
    );
  });

  await test("offline financial recovery issues a recovery_default ticket at the restaurant default category", async () => {
    const record = offlineSale(B, offlineB, [{ product: P.fronteraDefault }]);
    const recovered = await run(ownerB, (tx) =>
      reconcileOfflineRecord(tx, ownerB, {
        record,
        reason: "Efectivo contado en la caja original",
        confirmed: true,
      }),
    );
    assert.equal(recovered.state, "recovery_pending");
    // FISCAL-OFFLINE-2: the order note prints on the Spanish comprobante.
    assert.equal(
      recovered.note,
      "Conciliación de efectivo sin conexión: Efectivo contado en la caja original",
    );
    const t = await ticketOf(B.id, recovered.id);
    assert.equal(t.source, "recovery");
    assert.equal(t.tax_basis, "recovery_default");
    assert.equal(t.gross, 1000);
    assert.deepEqual(
      t.lines.map((l: any) => [l.category, l.gross, l.name.es]),
      [["iva8", 1000, RECOVERY_LINE_NAME.es]],
    );
    assert.equal(recovered.fiscal!.ticket!.folio, t.number.padStart(6, "0"));
    // A replay returns the stored result without a second ticket.
    await run(ownerB, (tx) =>
      reconcileOfflineRecord(tx, ownerB, {
        record,
        reason: "Efectivo contado en la caja original",
        confirmed: true,
      }),
    );
    assert.equal((await tickets(B.id, `order_id='${recovered.id}'`)).length, 1);
    // OFF-R31: the sale's online create committed and its order was cancelled
    // since; the money becomes a financial-only recovery, with its own ticket.
    const draft = {
      operationId: randomUUID(),
      lines: [lineInput({ product: P.fronteraDefault, quantity: 2 })],
    };
    const online = await run(cashierB, (tx) =>
      createOrder(tx, cashierB, {
        ...draft,
        mode: "takeaway",
        tableId: null,
        name: "Venta sin conexión",
        note: "",
        channel: "pos",
      }),
    );
    await admin`update orders set state='cancelled',total=0 where tenant_id=${B.id} and id=${online.id}`;
    const cancelledSale = offlineSale(B, offlineB, [], 0, draft);
    const recoveredCancelled = await run(ownerB, (tx) =>
      reconcileOfflineRecord(tx, ownerB, {
        record: cancelledSale,
        reason: "Efectivo de una orden anulada en línea",
        confirmed: true,
      }),
    );
    assert.notEqual(recoveredCancelled.id, online.id);
    assert.equal(recoveredCancelled.state, "recovery_pending");
    const cancelledTicket = await ticketOf(B.id, recoveredCancelled.id);
    assert.equal(cancelledTicket.source, "recovery");
    assert.equal(cancelledTicket.gross, 2000);
    assert.equal(await ticketOf(B.id, online.id), undefined);
  });

  await test("manager reconcile into an order (reconcileIntoOrder) issues the ticket in the original drawer's transaction and does not advance the folio on replay", async () => {
    const open = await newOrder(cashierB, [{ product: P.frontera8 }]);
    const record = offlinePayment(B, offlineB, open.id, 2000);
    const first = await run(ownerB, (tx) =>
      reconcileOfflineRecord(tx, ownerB, {
        record,
        reason: "Pago revisado por la gerencia",
        confirmed: true,
      }),
    );
    assert.equal(first.id, open.id);
    const t = await ticketOf(B.id, open.id);
    assert.ok(t);
    assert.equal(t.issued_by, ownerB.employeeId, "the reconciling manager");
    const value = await counter(B.id);
    await run(ownerB, (tx) =>
      reconcileOfflineRecord(tx, ownerB, {
        record,
        reason: "Pago revisado por la gerencia",
        confirmed: true,
      }),
    );
    assert.equal(await counter(B.id), value);
  });

  await test("a parked payment attempt recorded by a manager (resolvePaymentAttempt) issues the ticket once", async () => {
    const open = await newOrder(cashierB, [{ product: P.fronteraDefault }]);
    const attempt = {
      formatVersion: 1 as const,
      tenantId: B.id,
      employeeId: cashierB.employeeId,
      deviceId: cashierB.deviceId,
      sessionId: offlineB.id,
      cashSessionId: B.drawers[0],
      orderId: open.id,
      createdAt: new Date().toISOString(),
      payload: {
        operationId: randomUUID(),
        amount: open.total,
        tip: 0,
        received: open.total,
        method: "cash" as const,
        externalConfirmed: false,
        reference: "",
      },
    };
    const body = {
      operationId: randomUUID(),
      attempt,
      outcome: "recorded",
      reason: "El cliente pagó en efectivo; verificado",
      confirmed: true,
    };
    const resolved = await run(ownerB, (tx) =>
      resolvePaymentAttempt(tx, ownerB, body),
    );
    assert.equal(resolved.state, "recorded");
    const value = await counter(B.id);
    assert.ok(await ticketOf(B.id, open.id));
    await run(ownerB, (tx) => resolvePaymentAttempt(tx, ownerB, body));
    assert.equal(await counter(B.id), value);
    assert.equal((await tickets(B.id, `order_id='${open.id}'`)).length, 1);
  });

  const legacyRefund = (s: Session, tenderId: string, amount: number) =>
    run(s, (tx) =>
      refund(tx, s, {
        operationId: randomUUID(),
        tenderId,
        amount,
        reason: "Devolución de prueba",
        disposition: "discard",
      }),
    );
  /** ticket tax − Σ adjustment tax per category, against extract(net gross). */
  async function netOf(tenantId: string, orderId: string) {
    const t = await ticketOf(tenantId, orderId);
    const taxes =
      await admin`select category,gross,tax from fiscal_ticket_taxes where ticket_id=${t.id}`;
    const adj =
      await admin`select category,gross,tax from fiscal_adjustments where tenant_id=${tenantId} and order_id=${orderId}`;
    return taxes.map((g) => {
      const mine = adj.filter((a) => a.category === g.category);
      const gross = g.gross - mine.reduce((a, x) => a + x.gross, 0);
      const tax = g.tax - mine.reduce((a, x) => a + x.tax, 0);
      return { category: g.category as TaxCategory, gross, tax };
    });
  }

  await test("refund adjustments (legacy refund): partial refunds leave the ticket's remaining IVA equal to extractTax(net gross); a full refund nets IVA to zero", async () => {
    const o = await newOrder(cashierA, [{ product: P.platillo }]);
    const paid = await pay(managerA, o);
    const tender = paid.tenders[0];
    for (const amount of [6789, 3000]) {
      const after = await legacyRefund(managerA, tender.id, amount);
      for (const g of await netOf(A.id, o.id))
        assert.equal(g.tax, extractTax(g.gross, rate(g.category)).tax);
      assert.ok(after.fiscal!.refunds.length >= 1);
    }
    const rest = 12345 - 6789 - 3000;
    const last = await legacyRefund(managerA, tender.id, rest);
    assert.deepEqual(await netOf(A.id, o.id), [
      { category: "iva16", gross: 0, tax: 0 },
    ]);
    assert.equal(last.fiscal!.refunds.length, 3);
    assert.equal(
      last.fiscal!.refunds.reduce((a, r) => a + r.groups[0].tax, 0),
      extractTax(12345, 1600).tax,
    );
  });

  await test("the legacy refund locks the order before the tender key: two concurrent refunds on two tenders of one order keep P1 exact", async () => {
    for (let i = 0; i < 8; i++) {
      const o = await newOrder(cashierA, [{ product: P.platillo }]);
      await pay(managerA, o, 6000);
      const paid = await pay(managerA, await read(managerA, o.id));
      const [a, b] = paid.tenders;
      const results = await noRetries("two legacy refunds on one order", () =>
        Promise.allSettled([
          legacyRefund(managerA, a.id, 1234 + i),
          legacyRefund(managerA, b.id, 2345 + i),
        ]),
      );
      assert.deepEqual(
        results.filter((r) => r.status === "rejected"),
        [],
      );
      for (const g of await netOf(A.id, o.id))
        assert.equal(
          g.tax,
          extractTax(g.gross, rate(g.category)).tax,
          "net IVA = extract(net)",
        );
    }
  });

  await test("immutability: gm_app cannot UPDATE or DELETE fiscal_tickets, fiscal_ticket_taxes or fiscal_adjustments; the owner role is stopped by triggers", async () => {
    for (const table of [
      "fiscal_tickets",
      "fiscal_ticket_taxes",
      "fiscal_adjustments",
    ]) {
      await rejects(
        run(ownerA, (tx) =>
          tx.unsafe(`update ${table} set tax=tax where true`),
        ),
        /permission denied/,
      );
      await rejects(
        run(ownerA, (tx) => tx.unsafe(`delete from ${table} where true`)),
        /permission denied/,
      );
      // The owner (and the superuser fixture role) with the tenant set, so RLS
      // shows the rows and the row triggers fire (CI parity: never vacuous).
      const [{ n }] = await asAdmin(A.id, (tx) =>
        tx.unsafe(
          `select count(*)::int as n from ${table} where tenant_id=$1`,
          [A.id],
        ),
      );
      assert.ok(n > 0, `${table} has rows`);
      await rejects(
        asAdmin(A.id, (tx) =>
          tx.unsafe(`update ${table} set tax=tax where tenant_id=$1`, [A.id]),
        ),
        /immutable fiscal records/,
      );
      await rejects(
        asAdmin(A.id, (tx) =>
          tx.unsafe(`delete from ${table} where tenant_id=$1`, [A.id]),
        ),
        /immutable fiscal records/,
      );
    }
    for (const table of [
      "fiscal_adjustments",
      "fiscal_ticket_taxes",
      "fiscal_tickets",
    ])
      await rejects(
        asAdmin(A.id, (tx) => tx.unsafe(`truncate ${table} cascade`)),
        /immutable fiscal records/,
      );
    await rejects(
      run(ownerA, (tx) => tx`delete from fiscal_folio_counters where true`),
      /permission denied/,
    );
    await rejects(
      run(
        ownerA,
        (tx) => tx`update fiscal_folio_counters set series='X' where series=''`,
      ),
      /permission denied/,
    );
    await rejects(
      asAdmin(
        A.id,
        (tx) =>
          tx`update fiscal_folio_counters set last_value=last_value+2 where tenant_id=${A.id} and series=''`,
      ),
      /only advance by one/,
    );
    await rejects(
      asAdmin(
        A.id,
        (tx) =>
          tx`delete from fiscal_folio_counters where tenant_id=${A.id} and series=''`,
      ),
      /cannot be deleted/,
    );
  });

  await test("tenant isolation: tenant B cannot read tenant A's profile, tickets, taxes or adjustments; both have folio 1", async () => {
    for (const table of [
      "restaurant_fiscal_profiles",
      "fiscal_folio_counters",
      "fiscal_tickets",
      "fiscal_ticket_taxes",
      "fiscal_adjustments",
    ]) {
      const rows = await run(ownerB, (tx) =>
        tx.unsafe(`select tenant_id from ${table}`),
      );
      assert.ok(
        rows.every((r) => r.tenant_id === B.id),
        `${table} is tenant scoped`,
      );
    }
    // WITH CHECK: B cannot write rows for A.
    await rejects(
      run(
        ownerB,
        (tx) =>
          tx`insert into restaurant_fiscal_profiles(tenant_id,updated_by) values(${A.id},${A.owner})`,
      ),
      /row-level security/,
    );
    await rejects(
      run(
        ownerB,
        (tx) =>
          tx`insert into fiscal_folio_counters(tenant_id,series,last_value) values(${A.id},'X',1)`,
      ),
      /row-level security/,
    );
    const aTicket = (await tickets(A.id))[0];
    assert.equal(
      (
        await run(
          ownerB,
          (tx) => tx`select id from fiscal_tickets where id=${aTicket.id}`,
        )
      ).length,
      0,
    );
    assert.equal(firstTickets[A.id], 1);
    assert.equal(firstTickets[B.id], 1);
    const bView = await run(ownerB, (tx) => getFiscalProfile(tx, ownerB));
    assert.equal(bView.issuer!.postalCode, "22000");
    assert.equal(bView.taxRegion, "border_north");
  });

  await test("profile: validation codes, version conflict, border confirmation, iva8 default needs border, border→general blocked by iva8 products, step_up_required without a fresh PIN", async () => {
    const view = await run(ownerA, (tx) => getFiscalProfile(tx, ownerA));
    const v = view.version;
    const save = (s: Session, body: unknown) =>
      run(s, (tx) => saveFiscalProfile(tx, s, body));
    const identity = profileBody(v).identity!;
    const cases: [Record<string, unknown>, string][] = [
      [{ identity: { ...identity, rfc: "" } }, "fiscal_identity_incomplete"],
      [
        { identity: { ...identity, rfc: "XAXX010101000" } },
        "fiscal_generic_rfc",
      ],
      [{ identity: { ...identity, rfc: "ABC" } }, "fiscal_invalid_rfc"],
      [
        { identity: { ...identity, legalName: "" } },
        "fiscal_identity_incomplete",
      ],
      [
        { identity: { ...identity, legalName: "x".repeat(260) } },
        "fiscal_invalid_legal_name",
      ],
      [{ identity: { ...identity, regime: "605" } }, "fiscal_invalid_regime"],
      [{ identity: { ...identity, regime: "612" } }, "fiscal_regime_mismatch"],
      [
        { identity: { ...identity, postalCode: "0670" } },
        "fiscal_invalid_postal_code",
      ],
      [{ ticketSeries: "A-1" }, "fiscal_invalid_series"],
      [{ defaultTaxCategory: "iva8" }, "fiscal_border_rate_not_allowed"],
      [
        {
          taxRegion: "border_south",
          identity: { ...identity, postalCode: "30700" },
        },
        "fiscal_border_confirmation_required",
      ],
      // SAT-1 (LD-25): the incentive needs the issuer's identity and a postal code in a state
      // of the chosen border region.
      [
        {
          identity: null,
          taxRegion: "border_north",
          defaultTaxCategory: "iva8",
          borderConfirmed: true,
        },
        "fiscal_border_identity_required",
      ],
      [
        {
          taxRegion: "border_north",
          defaultTaxCategory: "iva8",
          borderConfirmed: true,
        },
        "fiscal_border_postal_code",
      ],
      [
        {
          identity: { ...identity, postalCode: "22000" },
          taxRegion: "border_south",
          borderConfirmed: true,
        },
        "fiscal_border_postal_code",
      ],
      // SAT-2: several premises make the branch street, municipality and state mandatory.
      [
        {
          multipleBranches: true,
          identity: {
            ...identity,
            address: { ...identity.address, municipality: " " },
          },
        },
        "fiscal_address_required",
      ],
    ];
    for (const [over, code] of cases)
      await rejects(save(ownerA, profileBody(v, over as any)), code);
    // A check-digit mismatch is only a warning: it saves.
    const warned = await save(
      ownerA,
      profileBody(v, { identity: { ...identity, rfc: "EKU9003173C8" } }),
    );
    assert.equal(warned.issuer!.rfc, "EKU9003173C8");
    await rejects(save(ownerA, profileBody(v)), "fiscal_profile_changed");
    const restored = await save(ownerA, profileBody(warned.version));
    assert.equal(restored.issuer!.rfc, "EKU9003173C9");
    assert.equal(restored.version, warned.version + 1);
    await rejects(save(managerA, profileBody(restored.version)), "forbidden");
    await rejects(
      save(session(A, "owner", 0, staleAccess), profileBody(restored.version)),
      "step_up_required",
    );
    // Border confirmation: recorded when chosen, kept while the region stays.
    const bProfile = await run(ownerB, (tx) => getFiscalProfile(tx, ownerB));
    assert.ok(bProfile.borderConfirmedAt);
    const kept = await save(
      ownerB,
      profileBody(bProfile.version, {
        identity: tijuana,
        taxRegion: "border_north",
        defaultTaxCategory: "iva8",
        borderConfirmed: true,
        ticketSeries: "",
      }),
    );
    assert.equal(kept.borderConfirmedAt, bProfile.borderConfirmedAt);
    // B has an IVA 8% product: it cannot go back to the general region.
    assert.equal(kept.iva8Products, 1);
    await rejects(
      save(
        ownerB,
        profileBody(kept.version, {
          identity: null,
          taxRegion: "general",
          defaultTaxCategory: "iva16",
        }),
      ),
      "fiscal_border_products_exist",
    );
    // The profile change is audited with before and after.
    const [auditRow] =
      await admin`select detail from audit where tenant_id=${A.id} and operation='fiscal.profile.saved' order by created_at desc limit 1`;
    assert.equal(auditRow.detail.before.rfc, "EKU9003173C8");
    assert.equal(auditRow.detail.after.identity.rfc, "EKU9003173C9");
  });

  await test("SAT-2: a multi-branch RFC saves with its branch address, stays complete and prints it; the table refuses a border region without an RFC and a multi-branch profile without the address (SAT-1/SAT-2 backstop)", async () => {
    const v = (await run(ownerA, (tx) => getFiscalProfile(tx, ownerA))).version;
    const multi = await run(ownerA, (tx) =>
      saveFiscalProfile(tx, ownerA, profileBody(v, { multipleBranches: true })),
    );
    assert.equal(multi.multipleBranches, true);
    assert.equal(multi.complete, true);
    const ctx = await run(cashierA, (tx) => fiscalContextView(tx, cashierA));
    assert.equal(ctx.multipleBranches, true);
    assert.equal(ctx.issuer!.address.municipality, "Cuauhtémoc");
    // Rows written around the app.
    await rejects(
      asAdmin(
        A.id,
        (tx) =>
          tx`update restaurant_fiscal_profiles set address=jsonb_set(address,'{state}','""') where tenant_id=${A.id}`,
      ),
      /check constraint/,
    );
    await rejects(
      asAdmin(
        B.id,
        (tx) =>
          tx`update restaurant_fiscal_profiles set rfc=null,legal_name=null,regime=null,postal_code=null
            where tenant_id=${B.id}`,
      ),
      /check constraint/,
    );
    const single = await run(ownerA, (tx) =>
      saveFiscalProfile(tx, ownerA, profileBody(multi.version)),
    );
    assert.equal(single.multipleBranches, false);
  });

  await test("profile save does not change restaurants.config_version (offline leases stay valid)", async () => {
    const [before] =
      await admin`select config_version from restaurants where id=${A.id}`;
    const v = (await run(ownerA, (tx) => getFiscalProfile(tx, ownerA))).version;
    await run(ownerA, (tx) => saveFiscalProfile(tx, ownerA, profileBody(v)));
    const [after] =
      await admin`select config_version from restaurants where id=${A.id}`;
    assert.equal(after.config_version, before.config_version);
  });

  await test("series change starts the new series at 1 and keeps the old series history", async () => {
    const old = await counter(A.id);
    let v = (await run(ownerA, (tx) => getFiscalProfile(tx, ownerA))).version;
    let view = await run(ownerA, (tx) =>
      saveFiscalProfile(tx, ownerA, profileBody(v, { ticketSeries: "b" })),
    );
    assert.equal(view.ticketSeries, "B");
    assert.equal(view.lastFolio, null);
    // FISCAL-UI-9: the panel still names the last folio, of the series used before.
    assert.equal(view.previousFolio, String(old).padStart(6, "0"));
    const o = await newOrder(cashierA, [{ product: P.agua }]);
    const paid = await pay(cashierA, o);
    assert.equal(paid.fiscal!.ticket!.folio, "B-000001");
    assert.equal(await counter(A.id), old, "the old series is untouched");
    view = await run(ownerA, (tx) => getFiscalProfile(tx, ownerA));
    assert.equal(view.lastFolio, "B-000001");
    assert.equal(view.previousFolio, null);
    v = view.version;
    await run(ownerA, (tx) =>
      saveFiscalProfile(tx, ownerA, profileBody(v, { ticketSeries: "" })),
    );
    const next = await pay(
      cashierA,
      await newOrder(cashierA, [{ product: P.agua }]),
    );
    assert.equal(
      next.fiscal!.ticket!.number,
      old + 1,
      "back to the old series",
    );
  });

  await test("line tax snapshot does not change after the product category or region changes", async () => {
    const o = await newOrder(cashierA, [{ product: P.agua }]);
    await asAdmin(
      A.id,
      (tx) =>
        tx`update catalog set data=jsonb_set(data,'{fiscal}','{"taxCategory":"iva0"}'::jsonb) where id=${P.agua}`,
    );
    try {
      const paid = await pay(cashierA, o);
      assert.deepEqual(
        paid.fiscal!.ticket!.groups.map((g) => g.category),
        ["iva16"],
      );
      const fresh = await newOrder(cashierA, [{ product: P.agua }]);
      assert.equal(fresh.lines[0].tax!.category, "iva0");
      assert.equal(
        (await pay(cashierA, fresh)).fiscal!.ticket!.groups[0].category,
        "iva0",
      );
    } finally {
      await asAdmin(
        A.id,
        (tx) =>
          tx`update catalog set data=jsonb_set(data,'{fiscal}','{"taxCategory":"iva16"}'::jsonb) where id=${P.agua}`,
      );
    }
    // A region change: an open check keeps its IVA 16% snapshot while new
    // lines of the same default product follow the new default (IVA 8%).
    const open = await newOrder(cashierA, [{ product: P.taco }]);
    assert.deepEqual(
      [open.lines[0].tax!.category, open.lines[0].tax!.basis],
      ["iva16", "default"],
    );
    let v = (await run(ownerA, (tx) => getFiscalProfile(tx, ownerA))).version;
    await run(ownerA, (tx) =>
      saveFiscalProfile(
        tx,
        ownerA,
        profileBody(v, {
          // SAT-1: a border region needs a border postal code.
          identity: tijuana,
          taxRegion: "border_north",
          defaultTaxCategory: "iva8",
          borderConfirmed: true,
        }),
      ),
    );
    try {
      const border = await newOrder(cashierA, [{ product: P.taco }]);
      assert.equal(border.lines[0].tax!.category, "iva8");
      const settled = await pay(cashierA, open);
      assert.deepEqual(
        settled.fiscal!.ticket!.groups.map((g) => g.category),
        ["iva16"],
        "the open check's snapshot did not change",
      );
      await pay(cashierA, border);
    } finally {
      v = (await run(ownerA, (tx) => getFiscalProfile(tx, ownerA))).version;
      await run(ownerA, (tx) => saveFiscalProfile(tx, ownerA, profileBody(v)));
    }
    // Back in the general region an "iva8" product falls back to the default.
    await asAdmin(
      A.id,
      (tx) =>
        tx`update catalog set data=jsonb_set(data,'{fiscal}','{"taxCategory":"iva8"}'::jsonb) where id=${P.agua}`,
    );
    try {
      const fallback = await newOrder(cashierA, [{ product: P.agua }]);
      assert.deepEqual(
        [fallback.lines[0].tax!.category, fallback.lines[0].tax!.basis],
        ["iva16", "fallback"],
      );
      await pay(cashierA, fallback);
    } finally {
      await asAdmin(
        A.id,
        (tx) =>
          tx`update catalog set data=jsonb_set(data,'{fiscal}','{"taxCategory":"iva16"}'::jsonb) where id=${P.agua}`,
      );
    }
  });

  await test("old-revision payment (tender inserted without issuance) is found by missingTicketCount and repaired with source repair", async () => {
    const o = await newOrder(cashierA, [{ product: P.platillo }]);
    const before = await run(ownerA, (tx) => missingTicketCount(tx));
    // The previous app revision inserts the tender with no fiscal hook.
    await run(
      cashierA,
      (tx) =>
        tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,tip,received)
        values(${A.id},${randomUUID()},${o.id},${A.drawers[0]},'cash',${o.total},0,${o.total})`,
    );
    assert.equal(await run(ownerA, (tx) => missingTicketCount(tx)), before + 1);
    const view = await run(ownerA, (tx) => getFiscalProfile(tx, ownerA));
    assert.equal(view.missingTickets, before + 1);
    await rejects(
      run(session(A, "manager", 0, staleAccess), (tx) =>
        repairMissingTickets(tx, session(A, "manager", 0, staleAccess), {
          operationId: randomUUID(),
        }),
      ),
      "step_up_required",
    );
    await rejects(
      run(cashierA, (tx) =>
        repairMissingTickets(tx, cashierA, { operationId: randomUUID() }),
      ),
      "forbidden",
    );
    const body = { operationId: randomUUID() };
    const repaired = await run(managerA, (tx) =>
      repairMissingTickets(tx, managerA, body),
    );
    assert.ok(repaired.issued >= 1);
    assert.equal(repaired.remaining, 0);
    const t = await ticketOf(A.id, o.id);
    assert.equal(t.source, "repair");
    assert.equal(t.tax_basis, "line_snapshot");
    assert.ok(repaired.folios.includes(String(t.number).padStart(6, "0")));
    // Idempotent per operationId.
    const value = await counter(A.id);
    assert.deepEqual(
      await run(managerA, (tx) => repairMissingTickets(tx, managerA, body)),
      repaired,
    );
    assert.equal(await counter(A.id), value);
    const [auditRow] =
      await admin`select detail from audit where tenant_id=${A.id} and operation='fiscal.tickets.repaired' order by created_at desc limit 1`;
    assert.equal(auditRow.detail.count, repaired.issued);
  });

  /** Paid sales of A without a ticket (the kill switch is on while they are paid). */
  async function unticketed(n: number) {
    const made: Order[] = [];
    for (let i = 0; i < n; i++)
      made.push(await newOrder(cashierA, [{ product: P.agua }]));
    process.env.FISCAL_TICKETS_ENABLED = "false";
    try {
      for (const o of made) await pay(cashierA, o);
    } finally {
      delete process.env.FISCAL_TICKETS_ENABLED;
    }
    return made;
  }
  /** Polls until some backend of this database waits on a row lock. */
  async function lockWaiter() {
    for (let i = 0; i < 500; i++) {
      const [{ n }] =
        await admin`select count(*)::int as n from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock'`;
      if (n > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no backend waited on a lock");
  }

  await test("CONCURRENCY-1: the repair holds the folio counter (LO-12) for two statements per ticket plus one insert each for the category and audit rows; a payment concurrent with a full batch commits with no retry", async () => {
    await unticketed(REPAIR_BATCH);
    // Every statement the repair transaction runs from its first counter upsert to commit.
    let counting = false;
    let underCounter = 0;
    const counted = postgres(runtime, {
      max: 1,
      debug: (_c, query) => {
        if (/insert into fiscal_folio_counters/i.test(query)) counting = true;
        if (counting && !/^\s*(commit|rollback)\b/i.test(query)) underCounter++;
      },
    });
    try {
      const repaired = await tenant(counted, A.id, (tx) =>
        repairMissingTickets(tx, managerA, { operationId: randomUUID() }),
      );
      assert.equal(repaired.issued, REPAIR_BATCH);
      // Counter + ticket per ticket, then the category rows, the issued audits, the repair
      // audit and once()'s operations row.
      assert.ok(
        underCounter <= 2 * repaired.issued + 4,
        `${underCounter} statements under LO-12 for ${repaired.issued} tickets`,
      );
      // The remaining count is read before the counter and still exact.
      assert.equal(
        repaired.remaining,
        await run(ownerA, (tx) => missingTicketCount(tx)),
      );
    } finally {
      await counted.end();
    }
    // A full batch and a settling payment on another device, concurrently.
    await unticketed(REPAIR_BATCH);
    const before = await counter(A.id);
    const sale = await newOrder(cashierA2, [{ product: P.agua }]);
    const [repaired, paid] = await noRetries("repair vs payment", () =>
      Promise.all([
        run(managerA, (tx) =>
          repairMissingTickets(tx, managerA, { operationId: randomUUID() }),
        ),
        pay(cashierA2, sale),
      ]),
    );
    assert.equal(repaired.issued, REPAIR_BATCH);
    assert.ok(paid.fiscal!.ticket);
    assert.equal(await counter(A.id), before + REPAIR_BATCH + 1);
  });

  await test("SAT-6: an order ticketed by another command while the repair waits for its lock is neither issued again nor reported as repaired", async () => {
    const [o] = await unticketed(1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let holding!: () => void;
    const held = new Promise<void>((r) => (holding = r));
    // A command that holds the order (as closeCheck or a payment would) and issues its ticket.
    const issuing = run(cashierA, async (tx) => {
      await tx`select id from orders where id=${o.id} for update`;
      holding();
      await gate;
      return issueDueTicket(tx, cashierA, o.id);
    });
    await held;
    const repairing = run(managerA, (tx) =>
      repairMissingTickets(tx, managerA, { operationId: randomUUID() }),
    );
    await lockWaiter();
    release();
    const [ticket, repaired] = await noRetries("repair vs issuance", () =>
      Promise.all([issuing, repairing]),
    );
    assert.equal((await ticketOf(A.id, o.id)).source, "sale");
    assert.ok(
      !repaired.folios.includes(ticket!.folio),
      "not counted as repaired",
    );
    const [auditRow] =
      await admin`select detail from audit where tenant_id=${A.id} and operation='fiscal.tickets.repaired' order by created_at desc limit 1`;
    assert.ok(!auditRow.detail.folios.includes(ticket!.folio));
  });

  await test("MON-6/FIT-7 (fiscal part): fiscalSummary for a date range equals Σ ticket taxes − Σ refund adjustments per category, by business date", async () => {
    const day = today();
    const summary = await run(managerA, (tx) =>
      fiscalSummary(tx, managerA, { from: day, to: day }),
    );
    const sales =
      await admin`select c.category,sum(c.gross)::int as gross,sum(c.tax)::int as tax
        from fiscal_ticket_taxes c join fiscal_tickets t on t.id=c.ticket_id
        where t.tenant_id=${A.id} and t.business_date=${day} group by c.category`;
    const refunds =
      await admin`select category,sum(gross)::int as gross,sum(tax)::int as tax
        from fiscal_adjustments where tenant_id=${A.id} and business_date=${day} group by category`;
    for (const s of sales) {
      const r = refunds.find((x) => x.category === s.category);
      const net = summary.net.find((n) => n.category === s.category)!;
      assert.equal(net.gross, s.gross - (r?.gross ?? 0));
      assert.equal(net.tax, s.tax - (r?.tax ?? 0));
      assert.equal(net.base + net.tax, net.gross);
    }
    assert.equal(
      summary.totals.netTax,
      summary.totals.tax - summary.totals.refundTax,
    );
    const [count] =
      await admin`select count(*)::int as n from fiscal_tickets where tenant_id=${A.id} and business_date=${day}`;
    assert.equal(summary.tickets.count, count.n);
    // Contiguous runs per series (FISCAL-SAT-3): FIT-6's ticket dated 2099-01-02 splits
    // today's run of the default series.
    assert.deepEqual(
      [...new Set(summary.tickets.series.map((x) => x.series))],
      ["", "B"],
    );
    for (const r of summary.tickets.series)
      assert.equal(r.last - r.first + 1, r.count, JSON.stringify(r));
    assert.equal(
      summary.tickets.series.reduce((a, r) => a + r.count, 0),
      count.n,
    );
    assert.equal(summary.missingTickets, 0);
    await rejects(
      run(managerA, (tx) =>
        fiscalSummary(tx, managerA, { from: "2026-01-01", to: "2026-02-15" }),
      ),
      "fiscal_range_invalid",
    );
    await rejects(
      run(managerA, (tx) =>
        fiscalSummary(tx, managerA, { from: day, to: "2020-01-01" }),
      ),
      "fiscal_range_invalid",
    );
    await rejects(
      run(cashierA, (tx) =>
        fiscalSummary(tx, cashierA, { from: day, to: day }),
      ),
      "forbidden",
    );
  });

  await test("SAT-3/SAT-4: the IVA summary lists contiguous folio runs, so a later folio dated an earlier day is its own run; a range's register sums only refunds recorded up to its last day", async () => {
    const day = new Date(Date.parse(today() + "T00:00:00Z") - 10 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    // A sale of `day` paid now: its ticket takes today's next folio (as a late offline sync).
    const earlier = async () => {
      const o = await newOrder(cashierA, [{ product: P.agua }]);
      await asAdmin(
        A.id,
        (tx) => tx`update orders set business_date=${day} where id=${o.id}`,
      );
      return pay(cashierA, o);
    };
    const first = await earlier();
    const between = await pay(
      cashierA,
      await newOrder(cashierA, [{ product: P.agua }]),
    );
    const late = await earlier();
    const t = (o: Order) => o.fiscal!.ticket!;
    assert.equal(t(between).number, t(first).number + 1);
    assert.equal(t(late).number, t(between).number + 1);
    assert.equal(t(first).businessDate, day);
    const summary = await run(managerA, (tx) =>
      fiscalSummary(tx, managerA, { from: day, to: day }),
    );
    const series = t(first).series;
    assert.deepEqual(summary.tickets.series, [
      { series, first: t(first).number, last: t(first).number, count: 1 },
      { series, first: t(late).number, last: t(late).number, count: 1 },
    ]);
    assert.equal(summary.tickets.count, 2);
    // A refund recorded today on that day's ticket.
    await legacyRefund(managerA, first.tenders[0].id, 1000);
    const row = async (range: Record<string, string>) =>
      (await run(managerA, (tx) => listTickets(tx, managerA, range))).rows.find(
        (r) => r.orderId === first.id,
      )!;
    assert.equal((await row({ from: day, to: day })).refundGross, 0);
    const untilToday = await row({ from: day, to: today() });
    assert.equal(untilToday.refundGross, 1000);
    assert.equal(
      untilToday.refundTax,
      extractTax(3500, 1600).tax - extractTax(2500, 1600).tax,
    );
    // One folio shows every refund of its ticket.
    assert.equal((await row({ folio: t(first).folio })).refundGross, 1000);
  });

  await test("ticket register pages by issue time, finds one folio and reports refunds per ticket", async () => {
    const day = today();
    const pages: string[] = [];
    let after: string | undefined;
    let first: Awaited<ReturnType<typeof listTickets>> | null = null;
    do {
      const page = await run(managerA, (tx) =>
        listTickets(tx, managerA, {
          from: day,
          to: day,
          limit: "7",
          ...(after ? { after } : {}),
        }),
      );
      first ??= page;
      pages.push(...page.rows.map((r) => r.id));
      after = page.next ?? undefined;
    } while (after);
    const [count] =
      await admin`select count(*)::int as n from fiscal_tickets where tenant_id=${A.id} and business_date=${day}`;
    assert.equal(pages.length, count.n);
    assert.equal(new Set(pages).size, pages.length, "no row twice");
    const row = first!.rows[0];
    const found = await run(managerA, (tx) =>
      listTickets(tx, managerA, { folio: row.folio.toLowerCase() }),
    );
    assert.deepEqual(
      found.rows.map((r) => r.id),
      [row.id],
    );
    assert.deepEqual(
      (
        await run(managerA, (tx) =>
          listTickets(tx, managerA, { folio: "nope" }),
        )
      ).rows,
      [],
    );
    const refunded = (
      await run(managerA, (tx) =>
        listTickets(tx, managerA, { from: day, to: day, limit: "500" }),
      )
    ).rows.filter((r) => r.refundGross > 0);
    assert.ok(refunded.length > 0);
    for (const r of refunded) assert.ok(r.refundTax <= r.refundGross);
    await rejects(
      run(managerA, (tx) =>
        listTickets(tx, managerA, { from: day, to: day, after: "x|y" }),
      ),
      "invalid_input",
    );
  });

  await test("replaying a settling payment operation returns the same ticket and does not advance the counter", async () => {
    const o = await newOrder(cashierA, [{ product: P.agua }]);
    const body = {
      operationId: randomUUID(),
      amount: o.total,
      tip: 0,
      received: o.total,
      method: "cash",
    };
    const first = await run(cashierA, (tx) =>
      recordPayment(tx, cashierA, o.id, body),
    );
    const value = await counter(A.id);
    const again = await run(cashierA, (tx) =>
      recordPayment(tx, cashierA, o.id, body),
    );
    assert.equal(again.fiscal!.ticket!.folio, first.fiscal!.ticket!.folio);
    assert.equal(await counter(A.id), value);
  });

  await test("ticket insert guard rejects a gross different from orders.total and a number different from the counter", async () => {
    const o = await newOrder(cashierA, [{ product: P.agua }]);
    const value = await counter(A.id);
    const insert = (tx: any, number: number, gross: number) =>
      tx`insert into fiscal_tickets(tenant_id,id,order_id,series,number,self_invoice_code,business_date,issued_by,source,currency,
          gross_before_discount,discount,gross,base,tax,tax_basis,lines,payments)
        values(${A.id},${randomUUID()},${o.id},'',${number},'ABCDEFGH1234',current_date,${A.owner},'sale','MXN',
          ${gross},0,${gross},${gross},0,'line_snapshot','[]','[]')`;
    await rejects(
      asAdmin(A.id, async (tx) => {
        await tx`update fiscal_folio_counters set last_value=last_value+1 where tenant_id=${A.id} and series=''`;
        await insert(tx, value + 1, o.total + 1);
      }),
      /gross must equal the order total/,
    );
    await rejects(
      asAdmin(A.id, async (tx) => {
        await tx`update fiscal_folio_counters set last_value=last_value+1 where tenant_id=${A.id} and series=''`;
        await insert(tx, value + 2, o.total);
      }),
      /must equal the series counter/,
    );
    assert.equal(await counter(A.id), value);
  });

  await test("the deferred reconcile trigger rejects a ticket whose category rows do not sum to its totals", async () => {
    const o = await newOrder(cashierA, [{ product: P.agua }]);
    const value = await counter(A.id);
    await rejects(
      run(ownerA, async (tx) => {
        await tx`update fiscal_folio_counters set last_value=last_value+1 where series=''`;
        const id = randomUUID();
        await tx`insert into fiscal_tickets(tenant_id,id,order_id,series,number,self_invoice_code,business_date,issued_by,source,currency,
            gross_before_discount,discount,gross,base,tax,tax_basis,lines,payments)
          values(${A.id},${id},${o.id},'',${value + 1},'ZZZZZZZZ9999',current_date,${A.owner},'sale','MXN',
            ${o.total},0,${o.total},${o.total - 1},1,'line_snapshot','[]','[]')`;
        await tx`insert into fiscal_ticket_taxes(tenant_id,ticket_id,category,rate_bps,gross_before_discount,discount,gross,base_before_discount,discount_base,base,tax)
          values(${A.id},${id},'iva16',1600,${o.total},0,${o.total},${o.total - 2},0,${o.total - 2},2)`;
      }),
      /do not reconcile/,
    );
    assert.equal(await counter(A.id), value);
    assert.equal(await ticketOf(A.id, o.id), undefined);
  });

  await test("kill switch FISCAL_TICKETS_ENABLED=false skips issuance and the order counts as missing", async () => {
    const o = await newOrder(cashierA, [{ product: P.agua }]);
    const before = await run(ownerA, (tx) => missingTicketCount(tx));
    process.env.FISCAL_TICKETS_ENABLED = "false";
    let paid: Order;
    try {
      paid = await pay(cashierA, o);
    } finally {
      delete process.env.FISCAL_TICKETS_ENABLED;
    }
    assert.equal(paid.checkState, "closed", "payments still work");
    assert.equal(paid.fiscal!.ticket, null);
    assert.equal(await ticketOf(A.id, o.id), undefined);
    assert.equal(await run(ownerA, (tx) => missingTicketCount(tx)), before + 1);
    // SAT-5: while the switch is still off the repair is refused before it locks any order,
    // and the panel says issuance is paused.
    process.env.FISCAL_TICKETS_ENABLED = "false";
    try {
      await rejects(
        run(managerA, (tx) =>
          repairMissingTickets(tx, managerA, { operationId: randomUUID() }),
        ),
        "fiscal_tickets_disabled",
      );
      assert.equal(
        (await run(managerA, (tx) => getFiscalProfile(tx, managerA)))
          .ticketsEnabled,
        false,
      );
    } finally {
      delete process.env.FISCAL_TICKETS_ENABLED;
    }
    assert.equal(
      (await run(managerA, (tx) => getFiscalProfile(tx, managerA)))
        .ticketsEnabled,
      true,
    );
    await run(managerA, (tx) =>
      repairMissingTickets(tx, managerA, { operationId: randomUUID() }),
    );
    assert.equal((await ticketOf(A.id, o.id)).source, "repair");
  });

  await test("non-MXN restaurant: no ticket, context currencySupported=false, and recordRefundTax writes no adjustments", async () => {
    const o = await newOrder(ownerC, [{ product: P.dolar }]);
    const paid = await pay(ownerC, o);
    assert.equal(paid.checkState, "closed");
    assert.equal(await ticketOf(C.id, o.id), undefined);
    const ctx = await run(ownerC, (tx) => fiscalContextView(tx, ownerC));
    assert.equal(ctx.currencySupported, false);
    const after = await legacyRefund(ownerC, paid.tenders[0].id, 500);
    assert.deepEqual(after.fiscal!.refunds, []);
    const [{ n }] =
      await admin`select count(*)::int as n from fiscal_adjustments where tenant_id=${C.id}`;
    assert.equal(n, 0);
    // SAT-5: a non-MXN restaurant never issues tickets, so none is missing and the repair
    // finds nothing to lock.
    assert.equal(await run(ownerC, (tx) => missingTicketCount(tx)), 0);
    const ownerCFresh = session(C, "owner");
    const view = await run(ownerCFresh, (tx) =>
      getFiscalProfile(tx, ownerCFresh),
    );
    assert.equal(view.missingTickets, 0);
    assert.equal(view.currencySupported, false);
  });

  await test("getOrders exposes order.fiscal for 1 and 10 ids with one extra statement", async () => {
    let n = 0;
    const counted = postgres(runtime, {
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
    try {
      const made: Order[] = [];
      for (let i = 0; i < 10; i++) {
        const o = await newOrder(cashierA, [{ product: P.agua }]);
        made.push(i % 2 ? await pay(cashierA, o) : o);
      }
      const count = async (ids: string[]) => {
        n = 0;
        const orders = await tenant(counted, A.id, (tx) => getOrders(tx, ids));
        return { n, orders };
      };
      const one = await count([made[0].id]);
      const ten = await count(made.map((o) => o.id));
      assert.equal(one.n, ten.n);
      assert.ok(one.n <= 10, `getOrders used ${one.n} statements`);
      for (const [i, o] of ten.orders.entries()) {
        assert.ok(o.fiscal);
        if (i % 2) {
          assert.ok(o.fiscal.ticket);
          assert.equal(o.fiscal.provisional, null);
        } else {
          assert.equal(o.fiscal.ticket, null);
          assert.equal(o.fiscal.provisional!.gross, o.total);
        }
      }
    } finally {
      await counted.end();
    }
  });

  await test("lock order: concurrent offline-style sync with payment, a void that settles a check, a service reassignment that settles, and single payments all commit and tenant() catches no deadlock (LO-R9: zero db_retry)", async () => {
    const before = await counter(B.id);
    let issued = 0;
    for (let round = 0; round < 50; round++) {
      // Setup (sequential): a check to void down to its paid unit, a paid table
      // check to move off its table, an order to pay, a stocked order whose
      // unpaid unit is voided with stock returned (MENU-INT-5), and an offline sale.
      const toVoid = await newOrder(cashierB, [
        { product: P.fronteraDefault, quantity: 2 },
      ]);
      const partVoid = await pay(cashierB, toVoid, 1000, {
        items: [`${toVoid.lines[0].id}:0`],
      });
      const table = tablesB[2 + (round % 4)];
      const tab = await newOrder(cashierB, [{ product: P.frontera8 }], {
        mode: "dine_in",
        tableId: table,
      });
      const paidTab = await pay(cashierB, tab);
      const toPay = await newOrder(cashierB, [{ product: P.frontera8 }]);
      const stocked = await newOrder(cashierB, [
        { product: P.fronteraStocked, quantity: 2 },
      ]);
      const partStocked = await pay(cashierB, stocked, 1500, {
        items: [`${stocked.lines[0].id}:0`],
      });
      const sale = offlineSale(B, offlineB, [{ product: P.fronteraStocked }]);
      const legs = () => [
        run(offlineB, (tx) => syncOfflineRecord(tx, offlineB, sale)),
        run(ownerB, (tx) =>
          voidLines(
            tx,
            ownerB,
            toVoid.id,
            voidBody(partVoid, toVoid.lines[0].id, 1),
            ownerB.employeeId,
          ),
        ),
        run(ownerB, (tx) =>
          assignService(tx, ownerB, tab.id, {
            operationId: randomUUID(),
            expectedVersion: paidTab.serviceVersion ?? 0,
            tableId: null,
            employeeId: B.cashier,
            mode: "takeaway",
            reason: "Se lo llevan",
          }),
        ),
        pay(cashierB, toPay),
        run(ownerB, (tx) =>
          voidLines(
            tx,
            ownerB,
            stocked.id,
            {
              ...voidBody(partStocked, stocked.lines[0].id, 1),
              stockDisposition: "return",
            },
            ownerB.employeeId,
          ),
        ),
      ];
      const results = await noRetries(`lock order round ${round}`, () =>
        Promise.allSettled(legs()),
      );
      const failed = results
        .map((r, i) =>
          r.status === "rejected"
            ? `${i}: ${r.reason?.code ?? r.reason}`
            : null,
        )
        .filter(Boolean);
      assert.deepEqual(failed, [], `round ${round}`);
      // The tab's ticket (issued by its setup payment at open → paid), then the
      // sale, the void, the payment and the stocked void each issue one.
      issued += 5;
    }
    assert.equal(await counter(B.id), before + issued);
  });

  await test("refreshCheckState issues only on open → paid and on a settled close; a zero-priced round on a paid unticketed check issues nothing and takes no folio lock; closeCheck then issues it", async () => {
    const o = await newOrder(cashierA, [{ product: P.agua }], {
      mode: "dine_in",
      tableId: tablesA[2],
    });
    process.env.FISCAL_TICKETS_ENABLED = "false";
    let paid: Order;
    try {
      paid = await pay(cashierA, o);
    } finally {
      delete process.env.FISCAL_TICKETS_ENABLED;
    }
    assert.equal(paid.checkState, "paid");
    assert.equal(paid.fiscal!.ticket, null);
    const value = await counter(A.id);
    const more = await run(cashierA, (tx) =>
      addRound(tx, cashierA, o.id, {
        operationId: randomUUID(),
        lines: [lineInput({ product: P.gratis })],
        mode: "dine_in",
        tableId: tablesA[2],
        name: "",
        note: "",
        channel: "pos",
        expectedVersion: paid.version,
      }),
    );
    assert.equal(more.checkState, "paid");
    assert.equal(more.fiscal!.ticket, null, "a round never issues");
    assert.equal(await counter(A.id), value, "no folio lock was taken");
    // Re-running refresh through another command (a note) issues nothing either.
    const released = await run(cashierA, (tx) =>
      closeCheck(tx, cashierA, o.id, { operationId: randomUUID() }),
    );
    assert.equal(released.closeReason, "released");
    const t = await ticketOf(A.id, o.id);
    assert.equal(t.source, "sale");
    assert.equal(t.gross, o.total);
    assert.equal(Number(t.number), value + 1);
  });

  await test("closeCheck of a ticketed check returns the existing ticket and does not advance the counter; assignService moving a ticketed paid check off its table returns the same ticket", async () => {
    const o = await newOrder(cashierA, [{ product: P.taco }], {
      mode: "dine_in",
      tableId: tablesA[3],
    });
    const paid = await pay(cashierA, o);
    const folio = paid.fiscal!.ticket!.folio;
    const value = await counter(A.id);
    const released = await run(cashierA, (tx) =>
      closeCheck(tx, cashierA, o.id, { operationId: randomUUID() }),
    );
    assert.equal(released.fiscal!.ticket!.folio, folio);
    assert.equal(await counter(A.id), value);
    const moved = await newOrder(cashierA, [{ product: P.taco }], {
      mode: "dine_in",
      tableId: tablesA[4],
    });
    const movedPaid = await pay(cashierA, moved);
    const value2 = await counter(A.id);
    const settled = await run(ownerA, (tx) =>
      assignService(tx, ownerA, moved.id, {
        operationId: randomUUID(),
        expectedVersion: movedPaid.serviceVersion ?? 0,
        tableId: null,
        employeeId: A.cashier,
        mode: "takeaway",
        reason: "Para llevar",
      }),
    );
    assert.equal(settled.checkState, "closed");
    assert.equal(settled.closeReason, "settled");
    assert.equal(
      settled.fiscal!.ticket!.folio,
      movedPaid.fiscal!.ticket!.folio,
    );
    assert.equal(await counter(A.id), value2);
  });

  await test("CONCURRENCY-3: an IVA 8% product save and a switch back to the general region serialize on menu_state; the switch waits for the product and is refused", async () => {
    let v = (await run(ownerA, (tx) => getFiscalProfile(tx, ownerA))).version;
    const border = await run(ownerA, (tx) =>
      saveFiscalProfile(
        tx,
        ownerA,
        profileBody(v, {
          identity: tijuana,
          taxRegion: "border_north",
          borderConfirmed: true,
        }),
      ),
    );
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let holding!: () => void;
      const held = new Promise<void>((r) => (holding = r));
      // saveMenuProduct's order: menu_state, the region check, then the product row.
      const productSave = run(managerA, async (tx) => {
        await tx`insert into menu_state(tenant_id,revision) values(${A.id},1)
          on conflict(tenant_id) do update set revision=menu_state.revision+1`;
        await tx`update catalog set data=jsonb_set(data,'{fiscal}','{"taxCategory":"iva8"}'::jsonb) where id=${P.agua}`;
        holding();
        await gate;
      });
      await held;
      const switching = run(ownerA, (tx) =>
        saveFiscalProfile(tx, ownerA, profileBody(border.version)),
      );
      await lockWaiter();
      release();
      const [saved, refused] = await noRetries(
        "product save vs region switch",
        () => Promise.allSettled([productSave, switching]),
      );
      assert.equal(saved.status, "fulfilled");
      assert.equal(refused.status, "rejected");
      assert.equal(
        (refused as PromiseRejectedResult).reason.code,
        "fiscal_border_products_exist",
      );
    } finally {
      await asAdmin(
        A.id,
        (tx) =>
          tx`update catalog set data=jsonb_set(data,'{fiscal}','{"taxCategory":"iva16"}'::jsonb) where id=${P.agua}`,
      );
      v = (await run(ownerA, (tx) => getFiscalProfile(tx, ownerA))).version;
      await run(ownerA, (tx) => saveFiscalProfile(tx, ownerA, profileBody(v)));
    }
  });

  await test("product save rejects iva8 outside a border region (fiscal_border_rate_not_allowed); a save without fiscal and the legacy catalog save keep the stored value; the version bumps on a tax change", async () => {
    const [doc] =
      await admin`select data from catalog where tenant_id=${A.id} and id=${P.cafe}`;
    const category = randomUUID();
    await asAdmin(
      A.id,
      (tx) =>
        tx`insert into menu_categories(tenant_id,id,name_es,name_en,position) values(${A.id},${category},'Pruebas','Tests',1)`,
    );
    const body = (version: number, fiscal?: unknown) => ({
      operationId: randomUUID(),
      id: P.cafe,
      expectedVersion: version,
      name: { es: "Café en grano", en: "Coffee beans" },
      categoryId: category,
      kind: "item",
      price: 18000,
      station: "kitchen",
      ...(fiscal === undefined ? {} : { fiscal }),
    });
    await rejects(
      run(managerA, (tx) =>
        saveMenuProduct(
          tx,
          managerA,
          body(doc.data.version, { taxCategory: "iva8" }),
        ),
      ),
      "fiscal_border_rate_not_allowed",
    );
    await rejects(
      run(managerA, (tx) =>
        saveMenuProduct(
          tx,
          managerA,
          body(doc.data.version, { taxCategory: "iva0", satProductKey: "123" }),
        ),
      ),
      /invalid_input|fiscal_invalid_sat_key|ZodError|invalid/,
    );
    const changed = await run(managerA, (tx) =>
      saveMenuProduct(
        tx,
        managerA,
        body(doc.data.version, {
          taxCategory: "exempt",
          satProductKey: "50201708",
        }),
      ),
    );
    assert.equal(changed.version, doc.data.version + 1);
    assert.deepEqual(changed.fiscal, {
      taxCategory: "exempt",
      satProductKey: "50201708",
      satUnitKey: null,
    });
    const kept = await run(managerA, (tx) =>
      saveMenuProduct(tx, managerA, body(changed.version)),
    );
    assert.deepEqual(
      kept.fiscal,
      changed.fiscal,
      "absent keeps the stored value",
    );
    await run(managerA, (tx) =>
      saveLegacyProduct(tx, managerA, {
        operationId: randomUUID(),
        id: P.cafe,
        name: { es: "Café en grano", en: "Coffee beans" },
        category: { es: "Pruebas", en: "Tests" },
        price: 18000,
        available: true,
        station: "kitchen",
        expectedVersion: kept.version,
        cost: null,
        recipe: [],
      }),
    );
    const [afterLegacy] =
      await admin`select data from catalog where tenant_id=${A.id} and id=${P.cafe}`;
    assert.deepEqual(
      afterLegacy.data.fiscal,
      changed.fiscal,
      "the legacy save keeps it",
    );
    // Back to IVA 0% for the tests below.
    const restored = await run(managerA, (tx) =>
      saveMenuProduct(
        tx,
        managerA,
        body(afterLegacy.data.version, {
          taxCategory: "iva0",
          satProductKey: "50201708",
          satUnitKey: "KGM",
        }),
      ),
    );
    assert.equal(restored.version, afterLegacy.data.version + 1);
    // In the border tenant IVA 8% is accepted.
    const [bdoc] =
      await admin`select data from catalog where tenant_id=${B.id} and id=${P.fronteraDefault}`;
    const bCategory = randomUUID();
    await asAdmin(
      B.id,
      (tx) =>
        tx`insert into menu_categories(tenant_id,id,name_es,name_en,position) values(${B.id},${bCategory},'Pruebas','Tests',1)`,
    );
    const bSaved = await run(ownerB, (tx) =>
      saveMenuProduct(tx, ownerB, {
        operationId: randomUUID(),
        id: P.fronteraDefault,
        expectedVersion: bdoc.data.version,
        name: { es: "Refresco", en: "Soda" },
        categoryId: bCategory,
        kind: "item",
        price: 1000,
        station: "kitchen",
        fiscal: { taxCategory: "iva8" },
      }),
    );
    assert.equal(
      (bSaved.fiscal as { taxCategory: string }).taxCategory,
      "iva8",
    );
  });

  await test("recordRefundTax with an item scope uses each entry's gross verbatim, grouped by the line's category, and rejects Σ gross ≠ refund amount", async () => {
    const o = await newOrder(managerA, [
      { product: P.taco, quantity: 2 },
      { product: P.cafe },
    ]);
    const paid = await pay(managerA, o);
    const tender = paid.tenders[0];
    const [taco, cafe] = [
      paid.lines.find((l) => l.productId === P.taco)!,
      paid.lines.find((l) => l.productId === P.cafe)!,
    ];
    const refundRow = (tx: Tx, amount: number) => {
      const id = randomUUID();
      return tx`insert into refunds(tenant_id,id,tender_id,session_id,amount,reason,disposition,actor_id)
        values(${A.id},${id},${tender.id},${A.drawers[0]},${amount},'Devolución por producto','discard',${A.manager})`.then(
        () => id,
      );
    };
    const view = await run(managerA, async (tx) => {
      const id = await refundRow(tx, 4000 + 9000);
      return recordRefundTax(tx, managerA, id, [
        { lineId: taco.id, units: [1], gross: 4000 },
        { lineId: cafe.id, units: [0], gross: 9000 },
      ]);
    });
    assert.deepEqual(
      view.groups.map((g) => [g.category, g.gross]),
      [
        ["iva16", 4000],
        ["iva0", 9000],
      ],
    );
    // Complement extraction against the ticket's category gross.
    assert.equal(
      view.groups[0].tax,
      extractTax(9000, 1600).tax - extractTax(5000, 1600).tax,
    );
    await rejects(
      run(managerA, async (tx) => {
        const id = await refundRow(tx, 100);
        return recordRefundTax(tx, managerA, id, [
          { lineId: taco.id, units: [0], gross: 99 },
        ]);
      }),
      "fiscal_total_mismatch",
    );
    // Idempotent: a second call returns the stored rows.
    const [stored] =
      await admin`select refund_id from fiscal_adjustments where tenant_id=${A.id} and order_id=${o.id} limit 1`;
    const again = await run(managerA, (tx) =>
      recordRefundTax(tx, managerA, stored.refund_id),
    );
    assert.deepEqual(again.groups, view.groups);
  });

  await test("MONEY-1 (LD-25): no refund by amount or by item on an unticketed order with a balance due; voiding the unpaid units settles it, and the ticket and a later refund net to gross 0 and IVA 0", async () => {
    // The second opinion's shape: 3 × Agua de jamaica, one unit paid and refunded before the
    // ticket, the other two voided. Refunded against the provisional $105.00 the adjustment
    // would carry IVA 482 while the $35.00 ticket carries 483: 1 centavo of IVA on gross 0.
    const o = await newOrder(managerA, [{ product: P.agua, quantity: 3 }]);
    const line = o.lines[0];
    const part = await pay(managerA, o, 3500, { items: [`${line.id}:0`] });
    const tender = part.tenders[0];
    assert.equal(await ticketOf(A.id, o.id), undefined);
    await rejects(
      legacyRefund(managerA, tender.id, 3500),
      "refund_balance_due",
    );
    // An item refund (discounts 028 records it through recordRefundTax) is refused the same way.
    await rejects(
      run(managerA, async (tx) => {
        const id = randomUUID();
        await tx`insert into refunds(tenant_id,id,tender_id,session_id,amount,reason,disposition,actor_id)
          values(${A.id},${id},${tender.id},${A.drawers[0]},3500,'Antes del ticket','discard',${A.manager})`;
        return recordRefundTax(tx, managerA, id, [
          { lineId: line.id, units: [0], gross: 3500 },
        ]);
      }),
      "refund_balance_due",
    );
    const [money] =
      await admin`select count(*)::int as n from refunds where tenant_id=${A.id} and tender_id=${tender.id}`;
    assert.equal(money.n, 0, "no refund row");
    const [adjusted] =
      await admin`select count(*)::int as n from fiscal_adjustments where tenant_id=${A.id} and order_id=${o.id}`;
    assert.equal(
      adjusted.n,
      0,
      "no IVA adjustment against a provisional gross",
    );
    // Staff void the unpaid units instead: the check settles and gets its ticket.
    const settled = await voidAs(ownerA, part, line.id, 2);
    assert.equal(settled.fiscal!.ticket!.gross, 3500);
    // Now the refund is against the ticket: gross 0 nets IVA 0 exactly.
    await legacyRefund(managerA, tender.id, 3500);
    assert.deepEqual(await netOf(A.id, o.id), [
      { category: "iva16", gross: 0, tax: 0 },
    ]);
  });

  await test("refund business date: a batchless refund near the cutoff is dated by the refund row's created_at (MONEY-3)", async () => {
    // Move A's cutoff to one minute from now (restaurant time), so "now" is the
    // last minute of a business day; the session carries the same cutoff.
    const local = new Date(
      new Date().toLocaleString("en-US", { timeZone: timezone }),
    );
    const near = (local.getHours() * 60 + local.getMinutes() + 1) % 1440;
    await admin`update restaurants set cutoff=${near} where id=${A.id}`;
    const s = {
      ...managerA,
      restaurant: { ...managerA.restaurant, cutoff: near },
    };
    const cashierNear = { ...cashierA, restaurant: s.restaurant };
    try {
      const o = await newOrder(cashierNear, [{ product: P.agua }]);
      const paid = await pay(cashierNear, o);
      const after = await legacyRefund(s, paid.tenders[0].id, 500);
      const [row] =
        await admin`select a.business_date::text as d,r.created_at from fiscal_adjustments a
          join refunds r on r.tenant_id=a.tenant_id and r.id=a.refund_id
          where a.tenant_id=${A.id} and a.order_id=${o.id}`;
      assert.equal(
        row.d,
        businessDate((row.created_at as Date).toISOString(), timezone, near),
        "the refund row's business date, not the clock when the tax was written",
      );
      assert.equal(after.fiscal!.refunds[0].businessDate, row.d);
    } finally {
      await admin`update restaurants set cutoff=${cutoff} where id=${A.id}`;
    }
  });

  await test("MONEY-3: recordRefundTax dates the adjustment by its refund row's created_at, not by the clock when it runs", async () => {
    const o = await newOrder(cashierA, [{ product: P.agua }]);
    const paid = await pay(cashierA, o);
    const view = await run(managerA, async (tx) => {
      const id = randomUUID();
      await tx`insert into refunds(tenant_id,id,tender_id,session_id,amount,reason,disposition,actor_id,created_at)
        values(${A.id},${id},${paid.tenders[0].id},${A.drawers[0]},500,'Devolución tardía','discard',${A.manager},
          now()-interval '2 days')`;
      return recordRefundTax(tx, managerA, id);
    });
    const [row] =
      await admin`select created_at from refunds where tenant_id=${A.id} and id=${view.refundId}`;
    const expected = businessDate(
      (row.created_at as Date).toISOString(),
      timezone,
      cutoff,
    );
    assert.notEqual(expected, today());
    assert.equal(view.businessDate, expected);
  });

  console.log(`${checks} fiscal checks passed`);
} finally {
  await admin.begin(async (tx) => {
    for (const [table, trigger] of CLEANUP_TRIGGERS)
      await tx.unsafe(`alter table ${table} disable trigger ${trigger}`);
    for (const table of [
      // fiscal (027), first in FK order (LD-16 L5).
      "fiscal_adjustments",
      "fiscal_ticket_taxes",
      "fiscal_tickets",
      "fiscal_folio_counters",
      "restaurant_fiscal_profiles",
      "offline_kitchen_reviews",
      "offline_sync_records",
      "offline_archives",
      "offline_recovery_tasks",
      "offline_recoveries",
      "refunds",
      "line_voids",
      "tender_allocations",
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
      "menu_state",
      "menu_categories",
      "modifier_groups",
      "catalog",
      "offline_lease_renewals",
      "offline_leases",
      "sessions",
      "devices",
      "employees",
      "restaurant_entitlements",
      "kitchen_feed_versions",
      "dining_tables",
      "dining_areas",
    ])
      for (const f of tenants)
        await tx.unsafe(`delete from ${table} where tenant_id=$1`, [f.id]);
    for (const f of tenants) {
      await tx`delete from restaurants where id=${f.id}`;
      await tx`delete from organizations where id=${f.org}`;
    }
    for (const [table, trigger] of CLEANUP_TRIGGERS)
      await tx.unsafe(`alter table ${table} enable trigger ${trigger}`);
  });
  await sql.end();
  await admin.end();
}
