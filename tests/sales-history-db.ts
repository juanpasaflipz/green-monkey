// Histórico POS Lite (040) against PostgreSQL: the preview, the import (replay, replacement of the
// covered days only, older exports refused), refused files, the read view, two-tenant RLS and the
// runtime role's grants, the HTTP routes (admission before the body), and the zero side effects
// on every other table and on the existing reports for the same dates.
// Fixture: fresh restaurants with staff, a terminal with an open drawer and a menu, and export
// files built here from obviously fictional sales (no pos-lite data).
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import postgres from "postgres";
import { password } from "../server/auth.js";
import { checkRole, connect, tenant, type Tx } from "../server/db.js";
import { makeRoute } from "../server/http.js";
import { apiErrorHandler } from "../server/api-errors.js";
import { createOrder, recordPayment } from "../server/orders.js";
import { salesSummary } from "../server/reports/summary.js";
import { breakdown } from "../server/reports/breakdowns.js";
import { dayCorte } from "../server/reports/cortes.js";
import { exceptionRows } from "../server/reports/exceptions.js";
import { reportsPorts } from "../server/reports/ports.js";
import { snapshotTenant } from "../server/reports/snapshot.js";
import {
  importSalesHistory,
  previewSalesHistory,
  salesHistoryReport,
} from "../server/sales-history.js";
import { FILE_HASH_HEADER, register as registerHistory } from "../server/routes/sales-history.js";
import { type Session } from "../shared/domain.js";
import { currentBusinessDate } from "../shared/reports.js";
import { isolatedTarget } from "./isolated-target.js";

const target = isolatedTarget(process.env);
const sql = connect(target.runtime),
  admin = postgres(target.migration, { max: 1 });
await checkRole(sql);
const [{ started }] = await admin`select clock_timestamp() as started`;

const restaurant = {
  name: "Taquería Histórico",
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
};
const roles = ["owner", "manager", "cashier", "kitchen"] as const;
type Role = (typeof roles)[number];
type Fixture = { tenantId: string; s: Record<Role, Session>; product: string };
const tenantsMade: string[] = [];

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
async function rejects(promise: Promise<unknown>, code: string | RegExp) {
  await assert.rejects(promise, (e: any) => {
    const got = String(e.code ?? e.message);
    if (code instanceof RegExp) assert.match(`${got} ${e.message ?? ""}`, code);
    else assert.equal(got, code, `expected ${code}, got ${got} (${e.message})`);
    return true;
  });
}
const asAdmin = <T>(tenantId: string, fn: (tx: any) => Promise<T>) =>
  admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id',${tenantId},true)`;
    return fn(tx);
  }) as Promise<T>;
const run = <T>(s: Session, fn: (tx: Tx) => Promise<T>) => tenant(sql, s.tenantId, fn);

async function makeTenant(label: string): Promise<Fixture> {
  const organizationId = randomUUID(),
    tenantId = randomUUID(),
    terminal = randomUUID(),
    product = randomUUID();
  const ids = Object.fromEntries(roles.map((r) => [r, randomUUID()])) as Record<Role, string>;
  await admin`insert into organizations(id,name) values(${organizationId},${"Histórico " + label})`;
  await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,free_location)
    values(${tenantId},${organizationId},${restaurant.name},'MXN','America/Mexico_City',240,true)`;
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source)
    values(${tenantId},'active',now()+interval '1 day','fixture')`;
  await asAdmin(tenantId, async (tx) => {
    for (const r of roles)
      await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
        values(${tenantId},${ids[r]},${"Histórico " + r},${r + "-" + ids[r].slice(0, 8)},${password("4321")},${r})`;
    await tx`insert into devices(tenant_id,id,name,token_hash,kind,free_slot) values(${tenantId},${terminal},'Caja histórico',${"fx-" + terminal},'terminal',1)`;
    await tx`insert into catalog(tenant_id,id,data) values(${tenantId},${product},${tx.json({
      id: product,
      name: { es: "Taco Prueba", en: "Test Taco" },
      category: { es: "Pruebas", en: "Tests" },
      price: 4500,
      available: true,
      station: "kitchen",
      groups: [],
      cost: 100,
      version: 1,
      recipe: [],
    })})`;
    await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${tenantId},${randomUUID()},${terminal},${ids.owner},0)`;
  });
  const s = Object.fromEntries(
    roles.map((r) => [
      r,
      {
        id: randomUUID(),
        tenantId,
        employeeId: ids[r],
        name: "Histórico " + r,
        role: r,
        deviceId: terminal,
        expiresAt: "",
        offlineUntil: "",
        csrf: "",
        restaurant,
      } satisfies Session,
    ]),
  ) as Record<Role, Session>;
  tenantsMade.push(tenantId);
  return { tenantId, s, product };
}
/** A terminal PIN session whose last PIN is older than the step-up window. */
const stale = (s: Session) =>
  ({
    ...s,
    access: {
      absoluteExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      authenticatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      deviceName: "Caja histórico",
      deviceKind: "terminal",
      idleLockSeconds: null,
      ownerAccount: false,
    },
  }) as Session;

type Sale = {
  id: number;
  at: string;
  source?: string;
  method?: string;
  /** Pesos before IVA; tax is 16 % on top (pos-lite's rule). */
  subtotal: number;
  tip?: number;
  product?: string;
};
/** A pos-lite export document (fictional) for `target`, as poslite-sales-export.sql emits it. */
function exportFile(targetTenantId: string, exportedAt: string, sales: Sale[], o: { currency?: string } = {}) {
  const p = (n: number) => n.toFixed(2);
  const orders = sales.map((x) => {
    const tax = Math.round(x.subtotal * 16) / 100;
    const total = x.subtotal + tax;
    return {
      id: x.id,
      created_at: x.at,
      paid_at: x.at,
      completed_at: x.at,
      source: x.source ?? "pos",
      payment_method: x.method ?? "cash",
      subtotal: p(x.subtotal),
      tax: p(tax),
      tip: p(x.tip ?? 0),
      total: p(total),
      discount_amount: null,
      refund_total: "0.00",
      lines: [{ name: x.product ?? "Taco Ficticio", quantity: 1, unit_price: p(total), discount_amount: null }],
      payments: [],
    };
  });
  const sum = (k: "total" | "tax" | "tip") =>
    (orders.reduce((a, x) => a + Math.round(Number(x[k]) * 100), 0) / 100).toFixed(2);
  return {
    source: "pos-lite-sales",
    sourceTenantId: "taqueria-ficticia",
    sourceName: "Taquería Ficticia",
    targetTenantId,
    exportedAt,
    currency: o.currency ?? "MXN",
    summary: { orders: orders.length, total: sum("total"), tax: sum("tax"), tip: sum("tip") },
    orders,
  };
}
const bytes = (doc: unknown) => Buffer.from(JSON.stringify(doc));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const preview = (s: Session, b: Buffer) => run(s, (tx) => previewSalesHistory(tx, s, b));
const importFile = (s: Session, b: Buffer, hash = sha(b)) =>
  run(s, (tx) => importSalesHistory(tx, s, b, hash));
const report = (s: Session, from: string, to: string) =>
  snapshotTenant(sql, s.tenantId, (tx) => salesHistoryReport(tx, s, { from, to }));
const dayTotals = async (s: Session, from: string, to: string) =>
  Object.fromEntries(
    (await report(s, from, to)).days.map((d) => [`${d.date}|${d.channel}`, d.total]),
  );

// Fixed fictional days (local 13:00 in Mexico City, well after the 04:00 cutoff).
const A = "2026-03-10",
  B = "2026-03-11",
  C = "2026-03-12";
const at = (date: string, hourUtc = 19) => `${date}T${String(hourUtc).padStart(2, "0")}:00:00.000Z`;

/** Every public table except the five sales_history_* and audit: row count and content digest. */
async function fingerprint(): Promise<Record<string, string>> {
  const tables = await admin`select c.relname as name from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relname not like 'sales_history_%'
      and c.relname <> 'audit' order by 1`;
  const out: Record<string, string> = {};
  for (const { name } of tables) {
    const [r] = await admin.unsafe(
      `select count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as f from public."${name}" t`,
    );
    out[name] = r!.f;
  }
  return out;
}
/** The existing reports for a range, minus the request id and generation instants. */
async function existingReports(s: Session, from: string, to: string) {
  const strip = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(strip)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => !/^(requestId|generatedAt|printedAt|asOf|now)$/.test(k))
              .map(([k, x]) => [k, strip(x)]),
          )
        : v;
  return snapshotTenant(sql, s.tenantId, async (tx) =>
    strip({
      summary: await salesSummary(tx, s, { from, to }, "req", reportsPorts),
      products: await breakdown(tx, s, { from, to, by: "product" }),
      exceptions: await exceptionRows(tx, s, { from, to }),
      corte: from === to ? await dayCorte(tx, s, from, "req", reportsPorts) : null,
    }),
  );
}

try {
  const f = await makeTenant("uno");
  const g = await makeTenant("dos");
  const v1 = bytes(
    exportFile(f.tenantId, "2026-03-13T12:00:00.000Z", [
      { id: 1, at: at(A), subtotal: 100, tip: 10 },
      { id: 2, at: at(A, 20), source: "customer_kiosk", method: "card", subtotal: 50 },
      { id: 3, at: at(B), subtotal: 200 },
      { id: 4, at: at(C), subtotal: 300, method: "transfer" },
      // 03:30 local on C+1 is before the 04:00 cutoff: business date C.
      { id: 5, at: "2026-03-13T09:30:00.000Z", subtotal: 10 },
      // Rejected: a delivery platform's order.
      { id: 6, at: at(B), source: "uber_eats", subtotal: 999 },
    ]),
  );

  await test("1. preview: owners and managers only; the source, coverage (business dates), totals and rejected rows; writes nothing", async () => {
    await rejects(preview(f.s.cashier, v1), "forbidden");
    await rejects(preview(f.s.kitchen, v1), "forbidden");
    const before = await fingerprint();
    const p = await preview(f.s.manager, v1);
    assert.equal(p.sourceName, "Taquería Ficticia");
    assert.deepEqual(p.coverage, { from: A, to: C });
    assert.equal(p.orders, 5);
    assert.deepEqual(p.rejected, [{ legacyId: "6", reason: "channel" }]);
    assert.equal(p.byChannel.kiosk.orders, 1);
    assert.equal(p.byChannel.pos.total, 11600 + 23200 + 34800 + 1160);
    assert.equal(p.byMethod.transfer.amount, 34800);
    assert.equal(p.reconciliation.matches, true);
    // The file's summary covers every exported order, the rejected one included.
    assert.equal(p.reconciliation.summaryOk, true);
    assert.equal(p.alreadyImported, false);
    assert.equal(p.replacesDays, 0);
    assert.equal(p.fileHash, sha(v1));
    assert.deepEqual(await fingerprint(), before);
    const [{ n }] = await run(f.s.owner, (tx: Tx) => tx`select count(*)::int as n from sales_history_batches`);
    assert.equal(n, 0);
  });

  await test("2. import: a recent PIN and the previewed file's hash are required", async () => {
    await rejects(importFile(f.s.cashier, v1), "forbidden");
    await rejects(importFile(stale(f.s.owner), v1), "step_up_required");
    await rejects(importFile(f.s.owner, v1, "0".repeat(64)), "sales_history_file_changed");
    await rejects(
      run(f.s.owner, (tx) => importSalesHistory(tx, f.s.owner, v1, undefined)),
      "sales_history_file_changed",
    );
  });

  let firstBatch = "";
  await test("3. import: aggregates per business date, channel, method and product; the coverage; one audit row", async () => {
    const r = await importFile(f.s.owner, v1);
    assert.equal(r.replayed, false);
    assert.equal(r.orders, 5);
    assert.equal(r.days, 3);
    assert.equal(r.replacedDays, 0);
    firstBatch = r.batchId;
    const rep = await report(f.s.manager, A, C);
    assert.deepEqual(
      rep.days.map((d) => [d.date, d.channel, d.orders, d.total, d.tax, d.tip]),
      [
        [A, "kiosk", 1, 5800, 800, 0],
        [A, "pos", 1, 11600, 1600, 1000],
        [B, "pos", 1, 23200, 3200, 0],
        [C, "pos", 2, 34800 + 1160, 4800 + 160, 0],
      ],
    );
    assert.deepEqual(
      rep.payments.filter((p) => p.date === C).map((p) => [p.method, p.payments, p.amount]),
      [
        ["cash", 1, 1160],
        ["transfer", 1, 34800],
      ],
    );
    assert.deepEqual(rep.products, [{ name: "Taco Ficticio", quantity: 5, amount: 5800 + 11600 + 23200 + 34800 + 1160 }]);
    assert.equal(rep.batches.length, 1);
    assert.equal(rep.batches[0]!.coverageFrom, A);
    const audits = await run(f.s.owner, (tx: Tx) =>
      tx`select operation, entity_id, detail from audit where operation='sales_history.import'`,
    );
    assert.equal(audits.length, 1);
    assert.equal(audits[0].entity_id, r.batchId);
    assert.equal(audits[0].detail.orders, 5);
    const [batch] = await run(f.s.owner, (tx: Tx) =>
      tx`select imported_by, report, rejected from sales_history_batches where id=${r.batchId}`,
    );
    assert.equal(batch.imported_by, f.s.owner.employeeId);
    assert.equal(batch.rejected, 1);
    assert.equal(batch.report.reconciliation.converted.total, 76560);
  });

  await test("4. the identical file again is a no-op (file hash): no batch, no rows, no audit", async () => {
    const before = await run(f.s.owner, (tx: Tx) =>
      tx`select (select count(*) from sales_history_batches)::int as b, (select count(*) from sales_history_days)::int as d,
        (select count(*) from audit where operation='sales_history.import')::int as a`,
    );
    const p = await preview(f.s.owner, v1);
    assert.equal(p.alreadyImported, true);
    const r = await importFile(f.s.owner, v1);
    assert.deepEqual(r, { batchId: firstBatch, replayed: true, orders: 5, days: 0, replacedDays: 0 });
    const after = await run(f.s.owner, (tx: Tx) =>
      tx`select (select count(*) from sales_history_batches)::int as b, (select count(*) from sales_history_days)::int as d,
        (select count(*) from audit where operation='sales_history.import')::int as a`,
    );
    assert.deepEqual(after, before);
  });

  await test("5. a newer export replaces only the business dates it covers; superseded rows stay as evidence", async () => {
    const v2 = bytes(
      exportFile(f.tenantId, "2026-03-14T12:00:00.000Z", [
        { id: 3, at: at(B), subtotal: 200 },
        { id: 7, at: at(B, 21), subtotal: 50, method: "card" },
        { id: 4, at: at(C), subtotal: 300, method: "transfer" },
      ]),
    );
    const p = await preview(f.s.owner, v2);
    assert.deepEqual(p.coverage, { from: B, to: C });
    assert.equal(p.replacesDays, 2);
    assert.equal(p.olderThanImported, false);
    const r = await importFile(f.s.owner, v2);
    assert.equal(r.replacedDays, 2);
    assert.equal(r.days, 2);
    assert.deepEqual(await dayTotals(f.s.owner, A, C), {
      [`${A}|kiosk`]: 5800,
      [`${A}|pos`]: 11600,
      [`${B}|pos`]: 23200 + 5800,
      // id 5 (03:30 on C+1) is not in v2: C is v2's, without it.
      [`${C}|pos`]: 34800,
    });
    const coverage = await run(f.s.owner, (tx: Tx) =>
      tx`select business_date::text as d, batch_id from sales_history_coverage order by 1`,
    );
    assert.deepEqual(
      coverage.map((c: any) => [c.d, c.batch_id === firstBatch ? "v1" : c.batch_id === r.batchId ? "v2" : "?"]),
      [
        [A, "v1"],
        [B, "v2"],
        [C, "v2"],
      ],
    );
    const [{ n }] = await run(f.s.owner, (tx: Tx) =>
      tx`select count(*)::int as n from sales_history_days where batch_id=${firstBatch}`,
    );
    assert.equal(n, 4, "v1's rows are kept");
    const [audit] = await run(f.s.owner, (tx: Tx) =>
      tx`select detail from audit where operation='sales_history.import' and entity_id=${r.batchId}`,
    );
    assert.deepEqual(audit.detail.replacedBatches, [firstBatch]);
    assert.equal(audit.detail.replacedDays, 2);
  });

  await test("6. an export older than the one covering its days is refused; nothing changes", async () => {
    const v0 = bytes(exportFile(f.tenantId, "2026-03-13T18:00:00.000Z", [{ id: 4, at: at(C), subtotal: 1 }]));
    const p = await preview(f.s.owner, v0);
    assert.equal(p.olderThanImported, true);
    const before = await dayTotals(f.s.owner, A, C);
    await rejects(importFile(f.s.owner, v0), "sales_history_older_export");
    assert.deepEqual(await dayTotals(f.s.owner, A, C), before);
    // A file covering only days nobody owns, even if exported earlier, is accepted (no overlap).
    const early = bytes(exportFile(f.tenantId, "2026-01-01T00:00:00.000Z", [{ id: 90, at: at("2026-02-01"), subtotal: 20 }]));
    assert.equal((await importFile(f.s.owner, early)).days, 1);
    assert.deepEqual(await dayTotals(f.s.owner, "2026-02-01", "2026-02-01"), { "2026-02-01|pos": 2320 });
  });

  await test("7. refused files: malformed, another source, another restaurant, another currency, nothing importable", async () => {
    const before = await fingerprint();
    await rejects(preview(f.s.owner, Buffer.from("{not json")), "sales_history_file_invalid");
    await rejects(preview(f.s.owner, Buffer.alloc(0)), "sales_history_file_invalid");
    await rejects(
      preview(f.s.owner, bytes({ ...exportFile(f.tenantId, "2026-03-15T00:00:00.000Z", []), source: "pos-lite-loyalty" })),
      "sales_history_file_invalid",
    );
    await rejects(
      preview(f.s.owner, bytes({ ...exportFile(f.tenantId, "2026-03-15T00:00:00.000Z", []), orders: [{ id: { nested: true }, lines: "many" }] })),
      "sales_history_file_invalid",
    );
    const foreign = bytes(exportFile(g.tenantId, "2026-03-15T00:00:00.000Z", [{ id: 1, at: at(A), subtotal: 1 }]));
    await rejects(preview(f.s.owner, foreign), "sales_history_scope");
    await rejects(importFile(f.s.owner, foreign), "sales_history_scope");
    const dollars = bytes(exportFile(f.tenantId, "2026-03-15T00:00:00.000Z", [{ id: 1, at: at(A), subtotal: 1 }], { currency: "USD" }));
    await rejects(preview(f.s.owner, dollars), "sales_history_currency");
    await rejects(importFile(f.s.owner, dollars), "sales_history_currency");
    const nothing = bytes(exportFile(f.tenantId, "2026-03-15T00:00:00.000Z", [{ id: 1, at: at(A), subtotal: 1, source: "rappi" }]));
    assert.equal((await preview(f.s.owner, nothing)).orders, 0);
    await rejects(importFile(f.s.owner, nothing), "sales_history_empty");
    assert.deepEqual(await fingerprint(), before);
  });

  await test("8. two restaurants: RLS keeps each one's history to itself; the runtime role cannot delete or rewrite rows", async () => {
    assert.deepEqual((await report(g.s.owner, A, C)).days, []);
    assert.deepEqual((await report(g.s.owner, A, C)).batches, []);
    const seen = await run(g.s.owner, (tx) =>
      tx`select (select count(*) from sales_history_batches)::int as b, (select count(*) from sales_history_days)::int as d,
        (select count(*) from sales_history_payments)::int as p, (select count(*) from sales_history_products)::int as r,
        (select count(*) from sales_history_coverage)::int as c`,
    );
    assert.deepEqual(seen[0], { b: 0, d: 0, p: 0, r: 0, c: 0 });
    const g1 = bytes(exportFile(g.tenantId, "2026-03-20T00:00:00.000Z", [{ id: 1, at: at(A), subtotal: 70 }]));
    await importFile(g.s.owner, g1);
    assert.deepEqual(await dayTotals(g.s.owner, A, C), { [`${A}|pos`]: 8120 });
    // f's figures are untouched by g's import of the same date.
    assert.equal((await dayTotals(f.s.owner, A, A))[`${A}|pos`], 11600);
    // Writing another restaurant's row is refused by RLS (WITH CHECK).
    await rejects(
      run(g.s.owner, (tx) =>
        tx`insert into sales_history_coverage(tenant_id,business_date,batch_id) values(${f.tenantId},'2026-01-05',${firstBatch})`,
      ),
      /42501|row-level security/,
    );
    // No DELETE, no UPDATE of aggregates, and only the coverage pointer's batch may change.
    for (const stmt of [
      (tx: Tx) => tx`delete from sales_history_days`,
      (tx: Tx) => tx`delete from sales_history_coverage`,
      (tx: Tx) => tx`delete from sales_history_batches`,
      (tx: Tx) => tx`update sales_history_days set total=0`,
      (tx: Tx) => tx`update sales_history_products set amount=0`,
      (tx: Tx) => tx`update sales_history_batches set orders=1`,
      (tx: Tx) => tx`update sales_history_coverage set business_date='2026-01-01'`,
    ])
      await rejects(run(f.s.owner, stmt), /42501|permission denied/);
    // A cross-tenant read through the runtime role, even naming the other tenant, sees nothing.
    const [{ n }] = await run(g.s.owner, (tx) =>
      tx`select count(*)::int as n from sales_history_days where tenant_id=${f.tenantId}`,
    );
    assert.equal(n, 0);
  });

  await test("9. zero side effects: an import over a day with Green Monkey sales leaves every other table and the existing reports (Ventas, IVA, Cobros, productos, excepciones, corte del día) unchanged", async () => {
    const h = await makeTenant("tres");
    // A real Green Monkey sale today, paid in cash.
    const order: any = await run(h.s.cashier, (tx) =>
      createOrder(tx, h.s.cashier, {
        operationId: randomUUID(),
        lines: [{ id: randomUUID(), productId: h.product, quantity: 2, options: [], note: "" }],
        mode: "takeaway",
        tableId: null,
        name: "Mostrador",
        note: "",
        channel: "pos",
      }),
    );
    await run(h.s.cashier, (tx) =>
      recordPayment(tx, h.s.cashier, order.id, {
        operationId: randomUUID(),
        amount: order.total,
        tip: 0,
        received: order.total,
        method: "cash",
        externalConfirmed: false,
        reference: "",
      }),
    );
    const today = currentBusinessDate(restaurant);
    const reportsBefore = await existingReports(h.s.owner, today, today);
    // The Green Monkey sale is in Ventas: the comparison below is not between two empty reports.
    assert.equal((reportsBefore as any).summary.sales.orders, 1);
    assert.equal((reportsBefore as any).summary.sales.salesTotal, order.total);
    const before = await fingerprint();
    for (const t of [
      "orders", "order_lines", "tenders", "tender_allocations", "refunds", "discounts", "cash_sessions",
      "cash_movements", "fiscal_tickets", "fiscal_folio_counters", "cfdi_documents", "cfdi_global_periods",
      "stock_items", "stock_movements", "loyalty_members", "loyalty_ledger", "jobs", "operations",
    ])
      assert.ok(t in before, `${t} is fingerprinted`);
    // pos-lite sales on the same business day as the Green Monkey sale (one hour ago).
    const now = Date.now();
    const doc = exportFile(h.tenantId, new Date(now).toISOString(), [
      { id: 1, at: new Date(now - 3600_000).toISOString(), subtotal: 500, tip: 50 },
      { id: 2, at: new Date(now - 1800_000).toISOString(), subtotal: 250, source: "customer_kiosk", method: "card" },
    ]);
    const r = await importFile(h.s.owner, bytes(doc));
    assert.equal(r.orders, 2);
    assert.deepEqual(await fingerprint(), before);
    assert.deepEqual(await existingReports(h.s.owner, today, today), reportsBefore);
    const [{ n }] = await run(h.s.owner, (tx: Tx) =>
      tx`select count(*)::int as n from audit where created_at>=${started} and operation like 'sales_history%'`,
    );
    assert.equal(n, 1, "the only other write is its audit row");
    // The history itself shows the sales under the server's business dates.
    const [{ d1, d2 }] = await run(h.s.owner, (tx: Tx) =>
      tx`select business_date_at(${h.tenantId}::uuid, ${new Date(now - 3600_000).toISOString()}::timestamptz)::text as d1,
        business_date_at(${h.tenantId}::uuid, ${new Date(now - 1800_000).toISOString()}::timestamptz)::text as d2`,
    );
    const rep = await report(h.s.owner, d1, d2);
    assert.equal(rep.days.reduce((a, x) => a + x.total, 0), 58000 + 29000);
  });

  await test("10. HTTP: managers only, checked before the body is read; raw upload, hash header, no-store", async () => {
    const h = await makeTenant("http");
    const app = express();
    app.use(express.json({ limit: "256kb" }));
    let who: Session = h.s.cashier;
    app.use("/api", (req, _res, next) => {
      (req as unknown as { session: Session }).session = who;
      next();
    });
    registerHistory({ app, sql, route: makeRoute(app, sql) });
    app.use(apiErrorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = async (path: string, body: Buffer, headers: Record<string, string> = {}) => {
      const res = await fetch(origin + path, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...headers },
        body: new Uint8Array(body),
      });
      return { status: res.status, body: await res.json(), cache: res.headers.get("cache-control") };
    };
    try {
      const doc = bytes(exportFile(h.tenantId, "2026-04-02T00:00:00.000Z", [{ id: 1, at: at("2026-04-01"), subtotal: 100 }]));
      const refused = await post("/api/sales-history/preview", doc);
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error, "forbidden");
      who = h.s.kitchen;
      assert.equal((await fetch(origin + "/api/sales-history?from=2026-04-01&to=2026-04-01")).status, 403);
      who = h.s.manager;
      const p = await post("/api/sales-history/preview", doc);
      assert.equal(p.status, 200);
      assert.equal(p.cache, "no-store");
      assert.equal(p.body.orders, 1);
      const bad = await post("/api/sales-history/import", doc, { [FILE_HASH_HEADER]: "f".repeat(64) });
      assert.equal(bad.body.error, "sales_history_file_changed");
      const ok = await post("/api/sales-history/import", doc, { [FILE_HASH_HEADER]: p.body.fileHash });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.days, 1);
      const res = await fetch(origin + "/api/sales-history?from=2026-04-01&to=2026-04-01");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal((await res.json()).days[0].total, 11600);
      // A realistic history (about 1.3 MB) is far above the app's 256 KB JSON limit: it passes as raw bytes.
      const big = bytes(
        exportFile(
          h.tenantId,
          "2026-04-03T00:00:00.000Z",
          Array.from({ length: 3000 }, (_, i) => ({
            id: 1000 + i,
            at: new Date(Date.parse("2025-10-01T19:00:00.000Z") + i * 3 * 3600_000).toISOString(),
            subtotal: 100 + (i % 7),
            product: "Producto Ficticio " + (i % 40),
          })),
        ),
      );
      assert.ok(big.length > 256 * 1024, `${big.length} bytes`);
      const bp = await post("/api/sales-history/preview", big);
      assert.equal(bp.status, 200);
      assert.equal(bp.body.orders, 3000);
      assert.equal(bp.body.reconciliation.matches, true);
      const wide = await fetch(origin + "/api/sales-history?from=2024-01-01&to=2026-04-01");
      assert.equal(wide.status, 400);
      // A JSON content type is not the upload: the body is not read as the file.
      const json = await fetch(origin + "/api/sales-history/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal((await json.json()).error, "sales_history_file_invalid");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  console.log(`${checks} sales-history checks passed`);
} finally {
  for (const id of tenantsMade)
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${id},true)`;
      await tx`delete from jobs where tenant_id=${id} and created_at>=${started}`;
    });
  await sql.end();
  await admin.end();
}
