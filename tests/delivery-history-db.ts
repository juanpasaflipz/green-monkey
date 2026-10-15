// Histórico de plataformas (041) against PostgreSQL: the preview, the import (replay, replacement
// per platform of the covered dates only, older files refused), refused files, the read view,
// two-tenant RLS and the runtime role's grants, the HTTP routes (admission before the body), and
// the zero side effects on every other table (040's sales_history_* included) and on the existing
// reports and Histórico POS Lite for the same dates.
// Fixture: fresh restaurants with staff, a terminal with an open drawer and a menu, and
// gm-delivery-sales files built here from obviously fictional rows (no platform data).
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
  deliveryHistoryReport,
  importDeliveryHistory,
  previewDeliveryHistory,
} from "../server/delivery-history.js";
import { importSalesHistory, salesHistoryReport } from "../server/sales-history.js";
import { FILE_HASH_HEADER, register as registerDelivery } from "../server/routes/delivery-history.js";
import { type Session } from "../shared/domain.js";
import { currentBusinessDate } from "../shared/reports.js";
import { isolatedTarget } from "./isolated-target.js";

const target = isolatedTarget(process.env);
const sql = connect(target.runtime),
  admin = postgres(target.migration, { max: 1 });
await checkRole(sql);
const [{ started }] = await admin`select clock_timestamp() as started`;

const restaurant = {
  name: "Taquería Plataformas",
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
  await admin`insert into organizations(id,name) values(${organizationId},${"Plataformas " + label})`;
  await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,free_location)
    values(${tenantId},${organizationId},${restaurant.name},'MXN','America/Mexico_City',240,true)`;
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source)
    values(${tenantId},'active',now()+interval '1 day','fixture')`;
  await asAdmin(tenantId, async (tx) => {
    for (const r of roles)
      await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
        values(${tenantId},${ids[r]},${"Plataformas " + r},${r + "-" + ids[r].slice(0, 8)},${password("4321")},${r})`;
    await tx`insert into devices(tenant_id,id,name,token_hash,kind,free_slot) values(${tenantId},${terminal},'Caja plataformas',${"fx-" + terminal},'terminal',1)`;
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
        name: "Plataformas " + r,
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
      deviceName: "Caja plataformas",
      deviceKind: "terminal",
      idleLockSeconds: null,
      ownerAccount: false,
    },
  }) as Session;

type Row = {
  date: string;
  platform?: string;
  store?: string;
  orders?: number;
  /** Pesos. */
  gross: number;
  commission?: number | null;
  net?: number | null;
  unsettledOrders?: number;
  cancelled?: number;
};
/** A gm-delivery-sales document (fictional) for `target`, as delivery-sales-build.ts writes it. */
function deliveryFile(targetTenantId: string, exportedAt: string, rows: Row[], o: { currency?: string } = {}) {
  const p = (n: number) => n.toFixed(2);
  const days = rows.map((r) => {
    const commission = r.commission === undefined ? Math.round(r.gross * 25) / 100 : r.commission;
    const net = r.net === undefined ? (commission === null ? null : r.gross - commission) : r.net;
    return {
      date: r.date,
      platform: r.platform ?? "uber_eats",
      store: r.store ?? "Taquería Demo",
      orders: r.orders ?? 2,
      gross: p(r.gross),
      commission: commission === null ? null : p(commission),
      net: net === null ? null : p(net),
      unsettledOrders: r.unsettledOrders ?? 0,
      cancelled: r.cancelled ?? 0,
      chargebacks: "0.00",
    };
  });
  const sum = (k: "gross" | "commission" | "net") =>
    (days.reduce((a, x) => a + Math.round(Number(x[k] ?? 0) * 100), 0) / 100).toFixed(2);
  return {
    format: "gm-delivery-sales",
    version: 1,
    exportedAt,
    currency: o.currency ?? "MXN",
    targetTenantId,
    sourceName: "Taquería Demo",
    sources: [{ platform: "uber_eats", origin: "portal", from: "2026-03-01", to: "2026-03-31", note: "ficticio" }],
    days,
    summary: {
      days: days.length,
      orders: days.reduce((a, x) => a + x.orders, 0),
      gross: sum("gross"),
      commission: sum("commission"),
      net: sum("net"),
    },
  };
}
const bytes = (doc: unknown) => Buffer.from(JSON.stringify(doc));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const preview = (s: Session, b: Buffer) => run(s, (tx) => previewDeliveryHistory(tx, s, b));
const importFile = (s: Session, b: Buffer, hash = sha(b)) =>
  run(s, (tx) => importDeliveryHistory(tx, s, b, hash));
const report = (s: Session, from: string, to: string) =>
  snapshotTenant(sql, s.tenantId, (tx) => deliveryHistoryReport(tx, s, { from, to }));
const dayGross = async (s: Session, from: string, to: string) =>
  Object.fromEntries(
    (await report(s, from, to)).days.map((d) => [`${d.date}|${d.platform}|${d.store}`, d.gross]),
  );

// Fixed fictional calendar dates.
const A = "2026-03-10",
  B = "2026-03-11",
  C = "2026-03-12";

/** Every public table except the three delivery_history_* and audit: row count and content digest. */
async function fingerprint(): Promise<Record<string, string>> {
  const tables = await admin`select c.relname as name from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relname not like 'delivery_history_%'
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
      // Histórico POS Lite (040) for the same dates.
      posLite: await salesHistoryReport(tx, s, { from, to }),
    }),
  );
}
/** A 040 pos-lite export (fictional) with one POS sale per instant, as in tests/sales-history-db.ts. */
function posLiteFile(targetTenantId: string, exportedAt: string, ats: string[]) {
  const orders = ats.map((at, i) => ({
    id: i + 1,
    created_at: at,
    paid_at: at,
    completed_at: at,
    source: "pos",
    payment_method: "cash",
    subtotal: "100.00",
    tax: "16.00",
    tip: "0.00",
    total: "116.00",
    discount_amount: null,
    refund_total: "0.00",
    lines: [{ name: "Taco Ficticio", quantity: 1, unit_price: "116.00", discount_amount: null }],
    payments: [],
  }));
  return {
    source: "pos-lite-sales",
    sourceTenantId: "taqueria-demo",
    sourceName: "Taquería Demo",
    targetTenantId,
    exportedAt,
    currency: "MXN",
    summary: { orders: orders.length, total: (116 * orders.length).toFixed(2), tax: (16 * orders.length).toFixed(2), tip: "0.00" },
    orders,
  };
}

try {
  const f = await makeTenant("uno");
  const g = await makeTenant("dos");
  const v1 = bytes(
    deliveryFile(f.tenantId, "2026-03-13T12:00:00.000Z", [
      { date: A, gross: 400, orders: 4 },
      { date: B, gross: 200 },
      // The last Uber day: one order's payout is not known yet.
      { date: C, gross: 300, orders: 3, unsettledOrders: 1, cancelled: 1 },
      { date: A, platform: "rappi", gross: 100, commission: null, net: null, orders: 1 },
      { date: C, platform: "rappi", gross: 500, orders: 5 },
      { date: B, platform: "didi_food", store: "Rollos Demo", gross: 50, orders: 1 },
      // Rejected: an unknown platform, and a commission above the gross.
      { date: B, platform: "ifood", gross: 999 },
      { date: B, platform: "didi_food", gross: 10, commission: 20, net: -10 },
    ]),
  );

  await test("1. preview: owners and managers only; coverage per platform, totals and rejected rows; writes nothing", async () => {
    await rejects(preview(f.s.cashier, v1), "forbidden");
    await rejects(preview(f.s.kitchen, v1), "forbidden");
    const before = await fingerprint();
    const p = await preview(f.s.manager, v1);
    assert.equal(p.sourceName, "Taquería Demo");
    assert.deepEqual(p.coverage, {
      uber_eats: { from: A, to: C },
      rappi: { from: A, to: C },
      didi_food: { from: B, to: B },
    });
    assert.equal(p.days, 6);
    assert.equal(p.orders, 4 + 2 + 3 + 1 + 5 + 1);
    assert.deepEqual(
      p.rejected.map((r) => [r.row, r.platform, r.reason]),
      [
        [7, "ifood", "platform"],
        [8, "didi_food", "commission"],
      ],
    );
    assert.equal(p.byPlatform.uber_eats.gross, 90000);
    assert.equal(p.byPlatform.uber_eats.unsettledOrders, 1);
    assert.equal(p.byPlatform.rappi.commissionUnknown, 1);
    assert.equal(p.byPlatform.rappi.commission, 12500);
    assert.equal(p.reconciliation.matches, true);
    // The file's summary covers every row, the rejected ones included.
    assert.equal(p.reconciliation.summaryOk, true);
    assert.equal(p.alreadyImported, false);
    assert.equal(p.replacesDays, 0);
    assert.equal(p.fileHash, sha(v1));
    assert.deepEqual(await fingerprint(), before);
    const [{ n }] = await run(f.s.owner, (tx: Tx) => tx`select count(*)::int as n from delivery_history_batches`);
    assert.equal(n, 0);
  });

  await test("2. import: a recent PIN and the previewed file's hash are required", async () => {
    await rejects(importFile(f.s.cashier, v1), "forbidden");
    await rejects(importFile(stale(f.s.owner), v1), "step_up_required");
    await rejects(importFile(f.s.owner, v1, "0".repeat(64)), "delivery_history_file_changed");
    await rejects(
      run(f.s.owner, (tx) => importDeliveryHistory(tx, f.s.owner, v1, undefined)),
      "delivery_history_file_changed",
    );
  });

  let firstBatch = "";
  await test("3. import: rows per platform date and store as given (no cutoff re-bucketing); coverage per platform; one audit row", async () => {
    const r = await importFile(f.s.owner, v1);
    assert.equal(r.replayed, false);
    assert.equal(r.days, 6);
    assert.equal(r.orders, 16);
    assert.equal(r.replacedDays, 0);
    firstBatch = r.batchId;
    const rep = await report(f.s.manager, A, C);
    assert.deepEqual(
      rep.days.map((d) => [d.date, d.platform, d.store, d.orders, d.gross, d.commission, d.net, d.unsettledOrders, d.cancelled]),
      [
        [A, "rappi", "Taquería Demo", 1, 10000, null, null, 0, 0],
        [A, "uber_eats", "Taquería Demo", 4, 40000, 10000, 30000, 0, 0],
        [B, "didi_food", "Rollos Demo", 1, 5000, 1250, 3750, 0, 0],
        [B, "uber_eats", "Taquería Demo", 2, 20000, 5000, 15000, 0, 0],
        [C, "rappi", "Taquería Demo", 5, 50000, 12500, 37500, 0, 0],
        [C, "uber_eats", "Taquería Demo", 3, 30000, 7500, 22500, 1, 1],
      ],
    );
    assert.equal(rep.batches.length, 1);
    assert.deepEqual(rep.batches[0]!.coverage.didi_food, { from: B, to: B });
    const coverage = await run(f.s.owner, (tx: Tx) =>
      tx`select platform, count(*)::int as n from delivery_history_coverage group by platform order by platform`,
    );
    assert.deepEqual(
      coverage.map((c: any) => [c.platform, c.n]),
      [
        ["didi_food", 1],
        ["rappi", 3],
        ["uber_eats", 3],
      ],
    );
    const audits = await run(f.s.owner, (tx: Tx) =>
      tx`select operation, entity_id, detail from audit where operation='delivery_history.import'`,
    );
    assert.equal(audits.length, 1);
    assert.equal(audits[0].entity_id, r.batchId);
    assert.equal(audits[0].detail.orders, 16);
    assert.equal(audits[0].detail.coveredDates, 7);
    const [batch] = await run(f.s.owner, (tx: Tx) =>
      tx`select imported_by, report, rejected, days from delivery_history_batches where id=${r.batchId}`,
    );
    assert.equal(batch.imported_by, f.s.owner.employeeId);
    assert.equal(batch.rejected, 2);
    assert.equal(batch.days, 6);
    assert.equal(batch.report.reconciliation.converted.gross, 155000);
    assert.deepEqual(batch.report.rejectedByReason, { platform: 1, commission: 1 });
  });

  await test("4. the identical file again is a no-op (file hash): no batch, no rows, no audit", async () => {
    const counts = () =>
      run(f.s.owner, (tx: Tx) =>
        tx`select (select count(*) from delivery_history_batches)::int as b, (select count(*) from delivery_history_days)::int as d,
          (select count(*) from audit where operation='delivery_history.import')::int as a`,
      );
    const before = await counts();
    const p = await preview(f.s.owner, v1);
    assert.equal(p.alreadyImported, true);
    assert.equal(p.replacesDays, 0);
    const r = await importFile(f.s.owner, v1);
    assert.deepEqual(r, { batchId: firstBatch, replayed: true, days: 0, orders: 16, replacedDays: 0 });
    assert.deepEqual(await counts(), before);
  });

  await test("5. a newer file replaces, per platform it contains, only the dates it covers; other platforms and superseded rows stay", async () => {
    // Uber only, B..C: Uber's A stays v1's; Rappi and DiDi keep every date.
    const v2 = bytes(
      deliveryFile(f.tenantId, "2026-03-14T12:00:00.000Z", [
        { date: B, gross: 250 },
        { date: C, gross: 320, orders: 3 },
      ]),
    );
    const p = await preview(f.s.owner, v2);
    assert.deepEqual(p.coverage, { uber_eats: { from: B, to: C } });
    assert.equal(p.replacesDays, 2);
    assert.equal(p.olderThanImported, false);
    const r = await importFile(f.s.owner, v2);
    assert.equal(r.replacedDays, 2);
    assert.equal(r.days, 2);
    assert.deepEqual(await dayGross(f.s.owner, A, C), {
      [`${A}|rappi|Taquería Demo`]: 10000,
      [`${A}|uber_eats|Taquería Demo`]: 40000,
      [`${B}|didi_food|Rollos Demo`]: 5000,
      [`${B}|uber_eats|Taquería Demo`]: 25000,
      [`${C}|rappi|Taquería Demo`]: 50000,
      [`${C}|uber_eats|Taquería Demo`]: 32000,
    });
    const coverage = await run(f.s.owner, (tx: Tx) =>
      tx`select platform, business_date::text as d, batch_id from delivery_history_coverage order by 1, 2`,
    );
    assert.deepEqual(
      coverage.map((c: any) => [c.platform, c.d, c.batch_id === firstBatch ? "v1" : c.batch_id === r.batchId ? "v2" : "?"]),
      [
        ["didi_food", B, "v1"],
        ["rappi", A, "v1"],
        ["rappi", B, "v1"],
        ["rappi", C, "v1"],
        ["uber_eats", A, "v1"],
        ["uber_eats", B, "v2"],
        ["uber_eats", C, "v2"],
      ],
    );
    const [{ n }] = await run(f.s.owner, (tx: Tx) =>
      tx`select count(*)::int as n from delivery_history_days where batch_id=${firstBatch}`,
    );
    assert.equal(n, 6, "v1's rows are kept");
    const [audit] = await run(f.s.owner, (tx: Tx) =>
      tx`select detail from audit where operation='delivery_history.import' and entity_id=${r.batchId}`,
    );
    assert.deepEqual(audit.detail.replacedBatches, [firstBatch]);
    assert.equal(audit.detail.replacedDays, 2);
    // A newer Rappi file whose span has a day without rows: that day is now empty for Rappi.
    const v3 = bytes(
      deliveryFile(f.tenantId, "2026-03-15T12:00:00.000Z", [
        { date: A, platform: "rappi", gross: 110, orders: 1 },
        { date: C, platform: "rappi", gross: 510, orders: 5 },
      ]),
    );
    assert.equal((await importFile(f.s.owner, v3)).replacedDays, 3);
    const after = await dayGross(f.s.owner, A, C);
    assert.equal(after[`${A}|rappi|Taquería Demo`], 11000);
    assert.equal(after[`${C}|rappi|Taquería Demo`], 51000);
    assert.equal(after[`${B}|uber_eats|Taquería Demo`], 25000);
  });

  await test("6. a file older than the one covering its (platform, date) pairs is refused; another platform's older file is not", async () => {
    const v0 = bytes(deliveryFile(f.tenantId, "2026-03-13T18:00:00.000Z", [{ date: C, gross: 1 }]));
    const p = await preview(f.s.owner, v0);
    assert.equal(p.olderThanImported, true);
    const before = await dayGross(f.s.owner, A, C);
    await rejects(importFile(f.s.owner, v0), "delivery_history_older_export");
    assert.deepEqual(await dayGross(f.s.owner, A, C), before);
    // The same older instant for DiDi's C (DiDi owns only B): no overlap, accepted.
    const didi = bytes(
      deliveryFile(f.tenantId, "2026-03-13T18:00:00.000Z", [{ date: C, platform: "didi_food", store: "Rollos Demo", gross: 60, orders: 1 }]),
    );
    assert.equal((await preview(f.s.owner, didi)).olderThanImported, false);
    assert.equal((await importFile(f.s.owner, didi)).replacedDays, 0);
    assert.equal((await dayGross(f.s.owner, C, C))[`${C}|didi_food|Rollos Demo`], 6000);
  });

  await test("7. refused files: malformed, another format or version, another restaurant, another currency, nothing importable", async () => {
    const before = await fingerprint();
    const ok = deliveryFile(f.tenantId, "2026-03-20T00:00:00.000Z", [{ date: A, gross: 1 }]);
    await rejects(preview(f.s.owner, Buffer.from("{not json")), "delivery_history_file_invalid");
    await rejects(preview(f.s.owner, Buffer.alloc(0)), "delivery_history_file_invalid");
    await rejects(preview(f.s.owner, bytes({ ...ok, format: "pos-lite-sales" })), "delivery_history_file_invalid");
    await rejects(preview(f.s.owner, bytes({ ...ok, version: 2 })), "delivery_history_file_invalid");
    await rejects(preview(f.s.owner, bytes({ ...ok, days: [{ date: A, platform: "rappi" }] })), "delivery_history_file_invalid");
    // A 040 pos-lite export is not a delivery file (and vice versa).
    await rejects(preview(f.s.owner, bytes(posLiteFile(f.tenantId, "2026-03-20T00:00:00.000Z", [`${A}T19:00:00.000Z`]))), "delivery_history_file_invalid");
    const foreign = bytes(deliveryFile(g.tenantId, "2026-03-20T00:00:00.000Z", [{ date: A, gross: 1 }]));
    await rejects(preview(f.s.owner, foreign), "delivery_history_scope");
    await rejects(importFile(f.s.owner, foreign), "delivery_history_scope");
    const dollars = bytes(deliveryFile(f.tenantId, "2026-03-20T00:00:00.000Z", [{ date: A, gross: 1 }], { currency: "USD" }));
    await rejects(preview(f.s.owner, dollars), "delivery_history_currency");
    await rejects(importFile(f.s.owner, dollars), "delivery_history_currency");
    const nothing = bytes(
      deliveryFile(f.tenantId, "2026-03-20T00:00:00.000Z", [
        { date: "2026-02-30", gross: 1 },
        { date: A, gross: 1, orders: 0 },
      ]),
    );
    const np = await preview(f.s.owner, nothing);
    assert.equal(np.days, 0);
    assert.deepEqual(np.rejected.map((r) => r.reason), ["date", "orders"]);
    await rejects(importFile(f.s.owner, nothing), "delivery_history_empty");
    assert.deepEqual(await fingerprint(), before);
  });

  await test("8. two restaurants: RLS keeps each one's history to itself; the runtime role cannot delete or rewrite rows", async () => {
    assert.deepEqual((await report(g.s.owner, A, C)).days, []);
    assert.deepEqual((await report(g.s.owner, A, C)).batches, []);
    const seen = await run(g.s.owner, (tx) =>
      tx`select (select count(*) from delivery_history_batches)::int as b, (select count(*) from delivery_history_days)::int as d,
        (select count(*) from delivery_history_coverage)::int as c`,
    );
    assert.deepEqual(seen[0], { b: 0, d: 0, c: 0 });
    const g1 = bytes(deliveryFile(g.tenantId, "2026-03-20T00:00:00.000Z", [{ date: A, gross: 70, orders: 1 }]));
    await importFile(g.s.owner, g1);
    assert.deepEqual(await dayGross(g.s.owner, A, C), { [`${A}|uber_eats|Taquería Demo`]: 7000 });
    // f's figures are untouched by g's import of the same platform and date.
    assert.equal((await dayGross(f.s.owner, A, A))[`${A}|uber_eats|Taquería Demo`], 40000);
    // Writing another restaurant's row is refused by RLS (WITH CHECK).
    await rejects(
      run(g.s.owner, (tx) =>
        tx`insert into delivery_history_coverage(tenant_id,platform,business_date,batch_id) values(${f.tenantId},'rappi','2026-01-05',${firstBatch})`,
      ),
      /42501|row-level security/,
    );
    // No DELETE, no UPDATE of rows or batches, and only the coverage pointer's batch may change.
    for (const stmt of [
      (tx: Tx) => tx`delete from delivery_history_days`,
      (tx: Tx) => tx`delete from delivery_history_coverage`,
      (tx: Tx) => tx`delete from delivery_history_batches`,
      (tx: Tx) => tx`update delivery_history_days set gross=0`,
      (tx: Tx) => tx`update delivery_history_batches set orders=1`,
      (tx: Tx) => tx`update delivery_history_coverage set business_date='2026-01-01'`,
      (tx: Tx) => tx`update delivery_history_coverage set platform='rappi'`,
    ])
      await rejects(run(f.s.owner, stmt), /42501|permission denied/);
    // The table CHECKs hold even for a direct insert: net above gross, an unknown platform.
    for (const stmt of [
      (tx: Tx) => tx`insert into delivery_history_days(tenant_id,batch_id,business_date,platform,store,orders,gross,commission,net,unsettled_orders,cancelled,chargebacks)
        values(${f.tenantId},${firstBatch},'2026-01-01','uber_eats','X',1,100,0,101,0,0,0)`,
      (tx: Tx) => tx`insert into delivery_history_days(tenant_id,batch_id,business_date,platform,store,orders,gross,commission,net,unsettled_orders,cancelled,chargebacks)
        values(${f.tenantId},${firstBatch},'2026-01-01','ifood','X',1,100,0,50,0,0,0)`,
    ])
      await rejects(run(f.s.owner, stmt), /23514|check constraint/);
    // A cross-tenant read through the runtime role, even naming the other tenant, sees nothing.
    const [{ n }] = await run(g.s.owner, (tx) =>
      tx`select count(*)::int as n from delivery_history_days where tenant_id=${f.tenantId}`,
    );
    assert.equal(n, 0);
    // The grants are exactly 041's: SELECT and INSERT on the three, UPDATE of two coverage columns.
    const [{ grants }] = await admin`select string_agg(table_name || ':' || privilege_type, ',' order by table_name, privilege_type) as grants
      from information_schema.role_table_grants where grantee='gm_app' and table_name like 'delivery_history_%'`;
    assert.equal(
      grants,
      "delivery_history_batches:INSERT,delivery_history_batches:SELECT,delivery_history_coverage:INSERT,delivery_history_coverage:SELECT,delivery_history_days:INSERT,delivery_history_days:SELECT",
    );
    const [{ cols }] = await admin`select string_agg(column_name, ',' order by column_name) as cols
      from information_schema.column_privileges where grantee='gm_app' and table_name='delivery_history_coverage' and privilege_type='UPDATE'`;
    assert.equal(cols, "batch_id,updated_at");
    const forced = await admin`select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relname like 'delivery_history_%' and relkind='r' order by relname`;
    assert.deepEqual(
      forced.map((r: any) => [r.relname, r.relrowsecurity, r.relforcerowsecurity]),
      [
        ["delivery_history_batches", true, true],
        ["delivery_history_coverage", true, true],
        ["delivery_history_days", true, true],
      ],
    );
  });

  await test("9. zero side effects: an import over a day with Green Monkey sales and Histórico POS Lite leaves every other table (040's included) and the existing reports unchanged; 040 imports leave this history unchanged", async () => {
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
    const now = Date.now();
    // Histórico POS Lite (040) for the same business day (one hour ago).
    const pl = bytes(posLiteFile(h.tenantId, new Date(now).toISOString(), [new Date(now - 3600_000).toISOString()]));
    await run(h.s.owner, (tx) => importSalesHistory(tx, h.s.owner, pl, sha(pl)));
    const [{ plDate }] = await run(h.s.owner, (tx: Tx) =>
      tx`select business_date_at(${h.tenantId}::uuid, ${new Date(now - 3600_000).toISOString()}::timestamptz)::text as "plDate"`,
    );
    const reportsBefore: any = await existingReports(h.s.owner, today, today);
    // The Green Monkey sale is in Ventas and the pos-lite sale in 040: not two empty reports.
    assert.equal(reportsBefore.summary.sales.orders, 1);
    assert.equal(reportsBefore.summary.sales.salesTotal, order.total);
    const pos040 = await snapshotTenant(sql, h.tenantId, (tx) => salesHistoryReport(tx, h.s.owner, { from: plDate, to: plDate }));
    assert.equal(pos040.days.reduce((a, d) => a + d.total, 0), 11600);
    const before = await fingerprint();
    for (const t of [
      "orders", "order_lines", "tenders", "tender_allocations", "refunds", "discounts", "cash_sessions",
      "cash_movements", "fiscal_tickets", "fiscal_folio_counters", "cfdi_documents", "cfdi_global_periods",
      "stock_items", "stock_movements", "loyalty_members", "loyalty_ledger", "jobs", "operations",
      "sales_history_batches", "sales_history_days", "sales_history_payments", "sales_history_products",
      "sales_history_coverage",
    ])
      assert.ok(t in before, `${t} is fingerprinted`);
    // Platform days on the same dates as both: today and the pos-lite sale's business date.
    const doc = deliveryFile(h.tenantId, new Date(now).toISOString(), [
      { date: today, gross: 500, orders: 5 },
      { date: plDate, platform: "rappi", gross: 300, orders: 3 },
      { date: today, platform: "didi_food", store: "Rollos Demo", gross: 100, orders: 1 },
    ]);
    const r = await importFile(h.s.owner, bytes(doc));
    assert.equal(r.orders, 9);
    assert.deepEqual(await fingerprint(), before);
    assert.deepEqual(await existingReports(h.s.owner, today, today), reportsBefore);
    assert.deepEqual(
      await snapshotTenant(sql, h.tenantId, (tx) => salesHistoryReport(tx, h.s.owner, { from: plDate, to: plDate })),
      pos040,
    );
    const [{ n }] = await run(h.s.owner, (tx: Tx) =>
      tx`select count(*)::int as n from audit where created_at>=${started} and tenant_id=${h.tenantId}
        and operation like 'delivery_history%'`,
    );
    assert.equal(n, 1, "the only other write is its audit row");
    // 040's coverage still owns its date; ours is a separate table per platform.
    const [{ owner040 }] = await run(h.s.owner, (tx: Tx) =>
      tx`select count(*)::int as owner040 from sales_history_coverage where business_date=${plDate}::date`,
    );
    assert.equal(owner040, 1);
    // And the other way round: a newer 040 import for the same day leaves this history unchanged.
    const deliveryBefore = await report(h.s.owner, plDate < today ? plDate : today, today);
    const pl2 = bytes(posLiteFile(h.tenantId, new Date(now + 1000).toISOString(), [new Date(now - 1800_000).toISOString()]));
    await run(h.s.owner, (tx) => importSalesHistory(tx, h.s.owner, pl2, sha(pl2)));
    assert.deepEqual(await report(h.s.owner, plDate < today ? plDate : today, today), deliveryBefore);
    assert.equal(
      deliveryBefore.days.reduce((a, d) => a + d.gross, 0),
      50000 + 30000 + 10000,
    );
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
    registerDelivery({ app, sql, route: makeRoute(app, sql) });
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
      const doc = bytes(deliveryFile(h.tenantId, "2026-04-02T00:00:00.000Z", [{ date: "2026-04-01", gross: 100 }]));
      const refused = await post("/api/delivery-history/preview", doc);
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error, "forbidden");
      assert.equal(refused.cache, "no-store");
      who = h.s.kitchen;
      assert.equal((await fetch(origin + "/api/delivery-history?from=2026-04-01&to=2026-04-01")).status, 403);
      who = h.s.manager;
      const p = await post("/api/delivery-history/preview", doc);
      assert.equal(p.status, 200);
      assert.equal(p.cache, "no-store");
      assert.equal(p.body.days, 1);
      const bad = await post("/api/delivery-history/import", doc, { [FILE_HASH_HEADER]: "f".repeat(64) });
      assert.equal(bad.body.error, "delivery_history_file_changed");
      const ok = await post("/api/delivery-history/import", doc, { [FILE_HASH_HEADER]: p.body.fileHash });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.days, 1);
      const res = await fetch(origin + "/api/delivery-history?from=2026-04-01&to=2026-04-01");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal((await res.json()).days[0].gross, 10000);
      // Years of daily rows for three platforms are above the app's 256 KB JSON limit: raw bytes.
      const big = bytes(
        deliveryFile(
          h.tenantId,
          "2026-04-03T00:00:00.000Z",
          Array.from({ length: 3 * 730 }, (_, i) => ({
            date: new Date(Date.parse("2024-01-01T00:00:00.000Z") + Math.floor(i / 3) * 86_400_000).toISOString().slice(0, 10),
            platform: ["uber_eats", "rappi", "didi_food"][i % 3],
            gross: 100 + (i % 7),
          })),
        ),
      );
      assert.ok(big.length > 256 * 1024, `${big.length} bytes`);
      const bp = await post("/api/delivery-history/preview", big);
      assert.equal(bp.status, 200);
      assert.equal(bp.body.days, 3 * 730);
      assert.equal(bp.body.reconciliation.matches, true);
      const wide = await fetch(origin + "/api/delivery-history?from=2024-01-01&to=2026-04-01");
      assert.equal(wide.status, 400);
      // A JSON content type is not the upload: the body is not read as the file.
      const json = await fetch(origin + "/api/delivery-history/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal((await json.json()).error, "delivery_history_file_invalid");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  console.log(`${checks} delivery-history checks passed`);
} finally {
  for (const id of tenantsMade)
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${id},true)`;
      await tx`delete from jobs where tenant_id=${id} and created_at>=${started}`;
    });
  await sql.end();
  await admin.end();
}
