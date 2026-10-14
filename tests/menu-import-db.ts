// «Importar menú de POS Lite» against PostgreSQL: the preview and the commit (server/menu-import.ts)
// write exactly the planned categories, reusable groups and products through the editor's own
// helpers (an imported product is the document saveMenuProduct saves), the QR/kiosk catalog
// shows them, stations, replay, one import per pos-lite restaurant, refused files and sessions,
// limits without partial writes, one menu revision, the audit/batch/mapping rows and RLS.
// Fixture: fresh restaurants with staff and the fictional tests/fixtures/pos-lite-menu.json.
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { password } from "../server/auth.js";
import { checkRole, connect, tenant, type Tx } from "../server/db.js";
import { commitMenuImport, previewMenuImport } from "../server/menu-import.js";
import { menuRevision, publicCatalog } from "../server/menu-read.js";
import { saveCategory, saveGroup, saveMenuProduct } from "../server/menu.js";
import { type Product, type Session } from "../shared/domain.js";
import { MENU_LIMITS } from "../shared/menu.js";
import {
  MENU_IMPORT_SOURCE,
  planMenuImport,
  menuImportFile,
} from "../shared/menu-import.js";
import { isolatedTarget } from "./isolated-target.js";

const target = isolatedTarget(process.env);
const sql = connect(target.runtime),
  admin = postgres(target.migration, { max: 1 });
await checkRole(sql);

const restaurant = {
  name: "Taquería Importación",
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
};
const roles = ["owner", "manager", "cashier", "kitchen"] as const;
type Role = (typeof roles)[number];
type Fixture = { tenantId: string; s: Record<Role, Session> };

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (e: any) => {
    const got = String(e.code ?? e.message);
    assert.equal(got, code, `expected ${code}, got ${got} (${e.message})`);
    return true;
  });
}
const asAdmin = <T>(tenantId: string, fn: (tx: any) => Promise<T>) =>
  admin.begin(async (tx: any) => {
    await tx`select set_config('app.tenant_id',${tenantId},true)`;
    return fn(tx);
  }) as Promise<T>;
const run = <T>(s: Session, fn: (tx: Tx) => Promise<T>) =>
  tenant(sql, s.tenantId, fn);
/** Reads as the runtime role, under the tenant's RLS scope (the migration role bypasses RLS). */
const read = (tenantId: string, fn: (tx: any) => Promise<any>): Promise<any> =>
  tenant(sql, tenantId, fn);

async function makeTenant(label: string): Promise<Fixture> {
  const organizationId = randomUUID(),
    tenantId = randomUUID(),
    terminal = randomUUID();
  const ids = Object.fromEntries(roles.map((r) => [r, randomUUID()])) as Record<
    Role,
    string
  >;
  await admin`insert into organizations(id,name) values(${organizationId},${"Importación " + label})`;
  await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,free_location)
    values(${tenantId},${organizationId},${restaurant.name},'MXN','America/Mexico_City',240,true)`;
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source)
    values(${tenantId},'active',now()+interval '1 day','fixture')`;
  await asAdmin(tenantId, async (tx) => {
    for (const r of roles)
      await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
        values(${tenantId},${ids[r]},${"Importación " + r},${r + "-" + ids[r].slice(0, 8)},${password("4321")},${r})`;
    await tx`insert into devices(tenant_id,id,name,token_hash,kind,free_slot) values(${tenantId},${terminal},'Caja importación',${"fx-" + terminal},'terminal',1)`;
  });
  const s = Object.fromEntries(
    roles.map((r) => [
      r,
      {
        id: randomUUID(),
        tenantId,
        employeeId: ids[r],
        name: "Importación " + r,
        role: r,
        deviceId: terminal,
        expiresAt: "",
        offlineUntil: "",
        csrf: "",
        restaurant,
      } satisfies Session,
    ]),
  ) as Record<Role, Session>;
  return { tenantId, s };
}
/** A terminal PIN session whose last PIN was `ageSeconds` ago. */
const pinned = (s: Session, ageSeconds: number) =>
  ({
    ...s,
    access: {
      absoluteExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      authenticatedAt: new Date(Date.now() - ageSeconds * 1000).toISOString(),
      deviceName: "Caja importación",
      deviceKind: "terminal",
      idleLockSeconds: null,
      ownerAccount: false,
    },
  }) as Session;
const fresh = (s: Session) => pinned(s, 5);
const stale = (s: Session) => pinned(s, 3 * 3600);

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/pos-lite-menu.json", import.meta.url),
    "utf8",
  ),
) as Record<string, any>;
/** The fictional export for `targetTenantId`, optionally changed. */
function menuFile(targetTenantId: string, patch: Record<string, unknown> = {}) {
  return { ...structuredClone(fixture), targetTenantId, ...patch } as Record<
    string,
    any
  >;
}
const sha = (doc: unknown) =>
  createHash("sha256").update(JSON.stringify(doc)).digest("hex");
const preview = (s: Session, file: unknown) =>
  run(s, (tx) => previewMenuImport(tx, s, file));
const commit = (
  s: Session,
  file: unknown,
  o: { stations?: Record<string, "kitchen" | "bar">; fileHash?: string } = {},
) =>
  run(s, (tx) =>
    commitMenuImport(tx, s, {
      file,
      stations: o.stations ?? {},
      fileHash: o.fileHash ?? sha(file),
    }),
  );
const planOf = (file: unknown, stations?: Record<string, "kitchen" | "bar">) =>
  planMenuImport(menuImportFile.parse(file), { stations });

/** Row counts of every table the import may write, seen by the tenant. */
async function rowCounts(tenantId: string) {
  return read(tenantId, async (tx) => {
    const [r] = await tx`select
      (select count(*)::int from menu_categories) as categories,
      (select count(*)::int from modifier_groups) as groups,
      (select count(*)::int from catalog) as products,
      (select count(*)::int from recipe_versions) as recipes,
      (select count(*)::int from import_batches) as batches,
      (select count(*)::int from source_mappings) as mappings,
      (select count(*)::int from audit) as audits,
      (select coalesce(max(revision),0)::int from menu_state) as revision`;
    return r as Record<string, number>;
  });
}
const products = (tenantId: string) =>
  read(tenantId, async (tx) =>
    (
      await tx`select data from catalog order by data->>'categoryPosition', data->>'position'`
    ).map((r: any) => r.data as Product),
  ) as Promise<Product[]>;

try {
  const f = await makeTenant("uno");
  const file = menuFile(f.tenantId);
  const plan = planOf(file);
  assert.deepEqual(
    plan.errors,
    [],
    "the fixture plans without blocking errors",
  );
  let result: Awaited<ReturnType<typeof commitMenuImport>>;

  await test("preview: managers only, the plan, the server's file hash, nothing written", async () => {
    await rejects(preview(f.s.cashier, file), "forbidden");
    const before = await rowCounts(f.tenantId);
    const p = await preview(f.s.manager, file);
    assert.equal(p.fileHash, sha(file));
    assert.deepEqual(p.counts, plan.counts);
    assert.equal(p.priceControlTotal, plan.priceControlTotal);
    assert.equal(p.alreadyImported, false);
    assert.equal(p.importedBefore, false);
    assert.deepEqual(p.existingNameClashes, []);
    assert.deepEqual(await rowCounts(f.tenantId), before);
  });

  await test("1. commit writes exactly the planned categories, groups, options and products", async () => {
    const before = await rowCounts(f.tenantId);
    result = await commit(fresh(f.s.owner), file);
    assert.equal(result.replayed, false);
    assert.equal(result.priceControlTotal, plan.priceControlTotal);
    assert.deepEqual(result.counts, { ...plan.counts, categoriesReused: 0 });
    const after = await rowCounts(f.tenantId);
    assert.equal(after.categories - before.categories, plan.categories.length);
    assert.equal(after.groups - before.groups, plan.groups.length);
    assert.equal(after.products - before.products, plan.products.length);
    assert.equal(after.recipes - before.recipes, plan.products.length);
    assert.equal(
      after.revision - before.revision,
      1,
      "one menu revision per import",
    );
    assert.equal(after.audits - before.audits, 1, "one audit row: menu.import");
    const cats = await read(
      f.tenantId,
      (tx) =>
        tx`select name_es,name_en,position from menu_categories order by position`,
    );
    assert.deepEqual(
      cats.map((c: any) => ({ es: c.name_es, en: c.name_en })),
      plan.categories.map((c) => c.name),
    );
    const groups = await read(
      f.tenantId,
      (tx) => tx`select data,version from modifier_groups`,
    );
    const byName = new Map(groups.map((g: any) => [g.data.name.es, g]));
    for (const g of plan.groups) {
      const row: any = byName.get(g.name);
      assert.ok(row, g.name);
      assert.equal(row.version, 1);
      assert.equal(row.data.min, g.min);
      assert.equal(row.data.max, g.max);
      assert.equal(row.data.repeat, false);
      assert.deepEqual(
        row.data.options.map((o: any) => [o.name.es, o.price, o.available]),
        g.options.map((o) => [o.name, o.price, true]),
      );
    }
    const options = plan.groups.reduce((n, g) => n + g.options.length, 0);
    assert.equal(options, plan.counts.options);
    const docs = await products(f.tenantId);
    assert.equal(docs.length, plan.products.length);
    let total = 0;
    for (const p of plan.products) {
      const d = docs.find((x) => x.name.es === p.name.es)!;
      assert.ok(d, p.name.es);
      assert.deepEqual(d.name, p.name);
      assert.equal(d.price, p.price);
      assert.equal(d.station, p.station);
      assert.equal(d.kind, "item");
      assert.equal(d.version, 1);
      assert.equal(d.available, true);
      assert.equal(d.cost, null);
      assert.deepEqual(d.recipe, []);
      assert.deepEqual(
        d.groups.map((g) => g.name.es),
        p.groupLegacyIds.map(
          (id) => plan.groups.find((g) => g.legacyId === id)!.name,
        ),
      );
      assert.deepEqual(
        d.groupIds,
        d.groups.map((g) => g.id),
      );
      if (p.description) assert.deepEqual(d.description, p.description);
      total += d.price;
    }
    for (const g of groups)
      total += g.data.options.reduce((n: number, o: any) => n + o.price, 0);
    assert.equal(total, plan.priceControlTotal);
  });

  await test("3. option ids are fresh UUIDs, unique across the restaurant", async () => {
    const ids = await read(
      f.tenantId,
      (tx) =>
        tx`select o->>'id' as id from modifier_groups g, jsonb_array_elements(g.data->'options') o`,
    );
    assert.equal(ids.length, plan.counts.options);
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const { id } of ids) assert.match(id, uuid);
    assert.equal(new Set(ids.map((r: any) => r.id)).size, ids.length);
    // Not the plan's placeholders, and not a group's id either.
    const groupIds = await read(
      f.tenantId,
      (tx) => tx`select id::text as id from modifier_groups`,
    );
    for (const { id } of ids) {
      assert.doesNotMatch(id, /^00000000-0000-4000-8000-/);
      assert.ok(!groupIds.some((g: any) => g.id === id));
    }
  });

  await test("4. the QR/kiosk catalog (publicCatalog) shows the imported products with their groups", async () => {
    const pub = await run(f.s.cashier, (tx) => publicCatalog(tx));
    assert.equal(pub.length, plan.products.length);
    for (const p of plan.products) {
      const d = pub.find((x) => x.name.es === p.name.es);
      assert.ok(d, p.name.es);
      assert.equal(d.price, p.price);
      assert.deepEqual(
        d.groups.map((g) => [
          g.name.es,
          g.options.map((o) => [o.name.es, o.price, o.available]),
        ]),
        p.groupLegacyIds.map((id) => {
          const g = plan.groups.find((x) => x.legacyId === id)!;
          return [g.name, g.options.map((o) => [o.name, o.price, true])];
        }),
      );
      for (const g of d.groups)
        for (const o of g.options)
          assert.ok(!("recipe" in o) && !("cost" in o));
      assert.ok(!("recipe" in d) && !("cost" in d));
    }
  });

  const g = await makeTenant("dos");
  await test("5. stations: a drinks category defaults to the bar; the owner's override is honoured", async () => {
    const drinks = plan.categories.find(
      (c) => c.name.es === "Bebidas de ejemplo",
    )!;
    assert.equal(drinks.station, "bar");
    const imported = await products(f.tenantId);
    assert.equal(
      imported.find((p) => p.name.es === "Agua de ejemplo")!.station,
      "bar",
    );
    assert.equal(
      imported.find((p) => p.name.es === "Taco de prueba")!.station,
      "kitchen",
    );
    const tacos = plan.categories.find((c) => c.name.es === "Tacos de prueba")!;
    const other = menuFile(g.tenantId);
    const stations = {
      [tacos.legacyId]: "bar",
      [drinks.legacyId]: "kitchen",
    } as const;
    const r = await commit(fresh(g.s.manager), other, { stations });
    assert.equal(r.replayed, false);
    const docs = await products(g.tenantId);
    for (const p of planOf(other).products) {
      const d = docs.find((x) => x.name.es === p.name.es)!;
      const want =
        p.categoryLegacyId === tacos.legacyId
          ? "bar"
          : p.categoryLegacyId === drinks.legacyId
            ? "kitchen"
            : p.station;
      assert.equal(d.station, want, p.name.es);
    }
    const [batch] = await read(
      g.tenantId,
      (tx) => tx`select report from import_batches`,
    );
    assert.equal(batch.report.stations[tacos.legacyId], "bar");
    assert.equal(batch.report.stations[drinks.legacyId], "kitchen");
  });

  await test("2. an imported product and group are what the editor saves for the same draft", async () => {
    const imported = (await products(f.tenantId)).find(
      (p) => p.name.es === "Taco de prueba",
    )!;
    const edited = await run(f.s.manager, (tx) =>
      saveMenuProduct(tx, f.s.manager, {
        operationId: randomUUID(),
        id: randomUUID(),
        expectedVersion: 0,
        name: imported.name,
        categoryId: imported.categoryId,
        price: imported.price,
        station: imported.station,
        groupIds: imported.groupIds,
        ...(imported.description ? { description: imported.description } : {}),
      }),
    );
    const [stored] = await read(
      f.tenantId,
      (tx) => tx`select data from catalog where id=${edited.id}`,
    );
    const strip = ({ id: _id, position: _position, ...rest }: Product) => rest;
    assert.deepEqual(strip(imported), strip(stored.data));
    assert.deepEqual(
      Object.keys(imported).sort(),
      Object.keys(stored.data).sort(),
    );
    assert.ok(imported.groups.length >= 2, "the draft links groups");
    // A group the editor saves with the same shape stores the same document but its ids.
    const [row] = await read(
      f.tenantId,
      (tx) =>
        tx`select data,version from modifier_groups where data->'name'->>'es'='Extras de ejemplo'`,
    );
    const saved = await run(f.s.manager, (tx) =>
      saveGroup(tx, f.s.manager, {
        operationId: randomUUID(),
        id: randomUUID(),
        expectedVersion: 0,
        name: row.data.name,
        min: row.data.min,
        max: row.data.max,
        repeat: row.data.repeat,
        options: row.data.options.map((o: any) => ({
          id: randomUUID(),
          name: o.name,
          price: o.price,
        })),
      }),
    );
    const [editor] = await read(
      f.tenantId,
      (tx) =>
        tx`select data,version from modifier_groups where id=${saved.group.id}`,
    );
    const noIds = (d: any) => ({
      ...d,
      options: d.options.map(({ id: _id, ...o }: any) => o),
    });
    assert.deepEqual(noIds(row.data), noIds(editor.data));
    assert.equal(row.version, editor.version);
    // The compiled copy on the product is the group the editor compiles.
    const compiled = imported.groups.find(
      (x) => x.name.es === "Extras de ejemplo",
    )!;
    const [linked] = await read(
      f.tenantId,
      (tx) => tx`select data from catalog where id=${edited.id}`,
    );
    assert.deepEqual(
      compiled,
      linked.data.groups.find((x: any) => x.id === compiled.id),
    );
  });

  await test("6. the same file again replays the stored report and writes nothing; preview says alreadyImported", async () => {
    const before = await rowCounts(f.tenantId);
    const again = await commit(fresh(f.s.manager), file);
    assert.deepEqual(again, { ...result, replayed: true });
    assert.deepEqual(await rowCounts(f.tenantId), before);
    const p = await preview(f.s.manager, file);
    assert.equal(p.alreadyImported, true);
    assert.equal(p.importedBefore, false);
    // Its products now exist in the restaurant: each is a name clash.
    assert.equal(p.existingNameClashes.length, plan.products.length);
  });

  await test("7. a different file of the same pos-lite restaurant: menu_import_existing_mapping; preview importedBefore", async () => {
    const newer = menuFile(f.tenantId, {
      exportedAt: "2026-10-15T12:00:00.000Z",
    });
    const before = await rowCounts(f.tenantId);
    await rejects(
      commit(fresh(f.s.owner), newer),
      "menu_import_existing_mapping",
    );
    assert.deepEqual(await rowCounts(f.tenantId), before);
    const p = await preview(f.s.owner, newer);
    assert.equal(p.alreadyImported, false);
    assert.equal(p.importedBefore, true);
  });

  const h = await makeTenant("tres");
  await test("8. refused files: another restaurant's, a changed hash, a blocking error, another currency", async () => {
    const before = await rowCounts(h.tenantId);
    const others = menuFile(g.tenantId);
    await rejects(preview(h.s.owner, others), "menu_import_scope");
    await rejects(commit(fresh(h.s.owner), others), "menu_import_scope");
    const own = menuFile(h.tenantId);
    await rejects(
      commit(fresh(h.s.owner), own, {
        fileHash: sha({ ...own, sourceName: "Otro" }),
      }),
      "menu_import_file_changed",
    );
    const blocking = menuFile(h.tenantId, {
      items: [
        ...own.items,
        { id: 999, categoryId: 77, name: "Huérfano de prueba", price: "10.00" },
      ],
    });
    const bp = await preview(h.s.owner, blocking);
    assert.ok(
      bp.errors.some((e) => e.code === "unknown_category"),
      JSON.stringify(bp.errors),
    );
    await rejects(commit(fresh(h.s.owner), blocking), "menu_import_invalid");
    const usd = menuFile(h.tenantId, { currency: "USD" });
    await rejects(preview(h.s.owner, usd), "menu_import_currency");
    await rejects(commit(fresh(h.s.owner), usd), "menu_import_currency");
    await rejects(
      preview(h.s.owner, { ...own, source: "pos-lite-sales" }),
      "menu_import_file_invalid",
    );
    await rejects(
      commit(fresh(h.s.owner), { ...own, categories: "x" }),
      "menu_import_file_invalid",
    );
    assert.deepEqual(await rowCounts(h.tenantId), before);
  });

  await test("9. sessions: cashier and kitchen refused; a manager without a recent PIN needs step-up; owner with one succeeds", async () => {
    const own = menuFile(h.tenantId);
    const before = await rowCounts(h.tenantId);
    await rejects(commit(fresh(h.s.cashier), own), "forbidden");
    await rejects(commit(fresh(h.s.kitchen), own), "forbidden");
    await rejects(preview(h.s.kitchen, own), "forbidden");
    await rejects(commit(stale(h.s.manager), own), "step_up_required");
    await rejects(commit(stale(h.s.owner), own), "step_up_required");
    assert.deepEqual(await rowCounts(h.tenantId), before);
    const r = await commit(fresh(h.s.owner), own);
    assert.equal(r.replayed, false);
    assert.equal(r.counts.products, plan.counts.products);
    // A Free restaurant: a manager without a free slot may not change the menu (requireSelling).
    const free = await makeTenant("free");
    await admin`delete from restaurant_entitlements where tenant_id=${free.tenantId}`;
    const freeBefore = await rowCounts(free.tenantId);
    await rejects(
      commit(fresh(free.s.manager), menuFile(free.tenantId)),
      "free_selection_required",
    );
    assert.deepEqual(await rowCounts(free.tenantId), freeBefore);
  });

  await test("10. limits: the groups the restaurant has plus the import's past MENU_LIMITS.groups → menu_import_invalid, nothing written", async () => {
    const l = await makeTenant("límites");
    const own = menuFile(l.tenantId);
    const existing = MENU_LIMITS.groups - plan.counts.groups + 1;
    await admin`insert into modifier_groups(tenant_id,id,data,version)
      select ${l.tenantId}::uuid, gen_random_uuid(),
        jsonb_build_object('name', jsonb_build_object('es','Grupo existente '||n,'en',''),'min',0,'max',1,'repeat',false,
          'options', jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'name',jsonb_build_object('es','Opción','en',''),'price',0,'available',true))),
        1
      from generate_series(1, ${existing}::int) as n`;
    const p = await preview(l.s.owner, own);
    assert.deepEqual(
      p.errors.filter((e) => e.code.startsWith("limit_")),
      [
        {
          code: "limit_groups",
          entity: "group",
          from: MENU_LIMITS.groups + 1,
          to: MENU_LIMITS.groups,
        },
      ],
    );
    const before = await rowCounts(l.tenantId);
    await rejects(commit(fresh(l.s.owner), own), "menu_import_invalid");
    assert.deepEqual(
      await rowCounts(l.tenantId),
      before,
      "no partial writes, no revision",
    );
    // Exactly at the limit is allowed: one archived group frees its place.
    await admin`update modifier_groups set archived_at=now()
      where tenant_id=${l.tenantId} and id=(select id from modifier_groups where tenant_id=${l.tenantId} order by id limit 1)`;
    assert.deepEqual((await preview(l.s.owner, own)).errors, []);
    const r = await commit(fresh(l.s.owner), own);
    assert.equal(r.counts.groups, plan.counts.groups);
    const [{ n }] = await read(
      l.tenantId,
      (tx) =>
        tx`select count(*)::int as n from modifier_groups where archived_at is null`,
    );
    assert.equal(n, MENU_LIMITS.groups);
  });

  await test("11. one menu revision, one menu.import audit row with counts, the import batch and its source mappings", async () => {
    // h saw nothing but the import: revision 1, one audit row, no per-record editor rows.
    assert.deepEqual(await run(h.s.owner, (tx) => menuRevision(tx)), {
      revision: 1,
    });
    const rows = await read(
      h.tenantId,
      (tx) =>
        tx`select operation,entity_id,actor_id,detail from audit order by created_at`,
    );
    assert.deepEqual(
      rows.map((r: any) => r.operation),
      ["menu.import"],
    );
    const [batch] = await read(
      h.tenantId,
      (tx) => tx`select id,source,file_hash,report from import_batches`,
    );
    assert.equal(batch.source, MENU_IMPORT_SOURCE);
    assert.equal(batch.file_hash, sha(menuFile(h.tenantId)));
    const audit = rows[0];
    assert.equal(audit.entity_id, batch.id);
    assert.equal(audit.actor_id, h.s.owner.employeeId);
    assert.deepEqual(audit.detail.counts, {
      ...plan.counts,
      categoriesReused: 0,
    });
    assert.equal(audit.detail.priceControlTotal, plan.priceControlTotal);
    assert.equal(audit.detail.sourceTenantId, fixture.sourceTenantId);
    assert.deepEqual(audit.detail.warnings, plan.warnings);
    assert.deepEqual(batch.report.counts, audit.detail.counts);
    const mappings = await read(
      h.tenantId,
      (tx) =>
        tx`select entity_type, count(*)::int as n, count(distinct target_id)::int as targets,
          bool_and(import_batch_id=${batch.id}) as same_batch, bool_and(source_tenant_id=${fixture.sourceTenantId}) as same_source
        from source_mappings where source_system=${MENU_IMPORT_SOURCE} group by 1 order by 1`,
    );
    assert.deepEqual(
      mappings.map((m: any) => [
        m.entity_type,
        m.n,
        m.targets,
        m.same_batch,
        m.same_source,
      ]),
      [
        ["catalog", plan.counts.products, plan.counts.products, true, true],
        [
          "menu_category",
          plan.counts.categories,
          plan.counts.categories,
          true,
          true,
        ],
        ["modifier", plan.counts.options, plan.counts.options, true, true],
        ["modifier_group", plan.counts.groups, plan.counts.groups, true, true],
      ],
    );
    // Every mapping names a record the import wrote.
    const [dangling] = await read(
      h.tenantId,
      (
        tx,
      ) => tx`select count(*)::int as n from source_mappings m where not case m.entity_type
        when 'catalog' then exists(select 1 from catalog c where c.id=m.target_id)
        when 'menu_category' then exists(select 1 from menu_categories c where c.id=m.target_id)
        when 'modifier_group' then exists(select 1 from modifier_groups g where g.id=m.target_id)
        else exists(select 1 from modifier_groups g, jsonb_array_elements(g.data->'options') o where o->>'id'=m.target_id::text) end`,
    );
    assert.equal(dangling.n, 0);
  });

  await test("12. RLS: another restaurant sees none of it; an active category with the same Spanish name is reused", async () => {
    const r = await makeTenant("cuatro");
    const empty = await rowCounts(r.tenantId);
    assert.deepEqual(empty, {
      categories: 0,
      groups: 0,
      products: 0,
      recipes: 0,
      batches: 0,
      mappings: 0,
      audits: 0,
      revision: 0,
    });
    const [leak] = await read(
      r.tenantId,
      (tx) => tx`select
      (select count(*)::int from catalog where tenant_id=${f.tenantId}) +
      (select count(*)::int from modifier_groups where tenant_id=${f.tenantId}) +
      (select count(*)::int from menu_categories where tenant_id=${f.tenantId}) +
      (select count(*)::int from import_batches where tenant_id=${f.tenantId}) +
      (select count(*)::int from source_mappings where tenant_id=${f.tenantId}) +
      (select count(*)::int from audit where tenant_id=${f.tenantId}) as n`,
    );
    assert.equal(leak.n, 0);
    assert.deepEqual(await run(r.s.cashier, (tx) => publicCatalog(tx)), []);
    const own = menuFile(r.tenantId);
    const p = await preview(r.s.owner, own);
    assert.equal(p.alreadyImported, false);
    assert.equal(p.importedBefore, false);
    // Category reuse: "TACOS DE PRUEBA" exists and is active in r.
    const existing = await run(r.s.manager, (tx) =>
      saveCategory(tx, r.s.manager, {
        operationId: randomUUID(),
        id: randomUUID(),
        expectedVersion: 0,
        name: { es: "TACOS DE PRUEBA", en: "Test tacos" },
      }),
    );
    const before = await rowCounts(r.tenantId);
    const res = await commit(fresh(r.s.owner), own);
    assert.equal(res.counts.categoriesReused, 1);
    const after = await rowCounts(r.tenantId);
    assert.equal(
      after.categories - before.categories,
      plan.categories.length - 1,
    );
    const tacos = plan.categories.find((c) => c.name.es === "Tacos de prueba")!;
    const [m] = await read(
      r.tenantId,
      (tx) =>
        tx`select target_id from source_mappings where entity_type='menu_category' and legacy_id=${tacos.legacyId}`,
    );
    assert.equal(m.target_id, existing.id);
    const docs = await products(r.tenantId);
    for (const pp of plan.products.filter(
      (x) => x.categoryLegacyId === tacos.legacyId,
    )) {
      const d = docs.find((x) => x.name.es === pp.name.es)!;
      assert.equal(d.categoryId, existing.id);
      assert.deepEqual(d.category, { es: "TACOS DE PRUEBA", en: "Test tacos" });
    }
    // f still has only its own: r's import added nothing there.
    assert.equal((await products(f.tenantId)).length, plan.products.length + 1);
  });

  console.log(`${checks} menu-import checks passed`);
} finally {
  await sql.end();
  await admin.end();
}
