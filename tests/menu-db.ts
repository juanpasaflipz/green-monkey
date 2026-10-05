// Menu, floor and stock engine against a real database (FIT-4, FIT-5, DB-4,
// DB-5, INV-02). Every run creates its own fictional restaurants, so reruns
// never collide with fixture data or with menu size limits.
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { password } from "../server/auth.js";
import { checkRole, connect, tenant } from "../server/db.js";
import {
  addRound,
  createOrder,
  getOrder,
  recordPayment,
  stock,
} from "../server/orders.js";
import { saveProduct } from "../server/management.js";
import { commitImport } from "../server/imports.js";
import {
  serviceOptions,
  assignService,
  progressPreparation,
} from "../server/service.js";
import { voidLines } from "../server/voids.js";
import { catalog, menuRevision, publicCatalog } from "../server/menu-read.js";
import {
  archiveCategory,
  archiveGroup,
  archiveProduct,
  menuEditor,
  reorderCategories,
  reorderProducts,
  saveCategory,
  saveGroup,
  saveMenuProduct,
  setOptionAvailability,
  setProductAvailability,
} from "../server/menu.js";
import {
  activeTables,
  archiveArea,
  archiveTable,
  bulkTables,
  floorPayload,
  saveArea,
  saveTable,
} from "../server/floor.js";
import {
  archiveStockItem,
  listStockItems,
  saveNegativeStockPolicy,
  saveStockItem,
  stockMovements,
} from "../server/stock-items.js";
import { lockStockItems } from "../server/stock.js";
import { Decimal } from "decimal.js";
import {
  DomainError,
  type Order,
  type Product,
  type Session,
} from "../shared/domain.js";
import { isolatedTarget } from "./isolated-target.js";

const { runtime: url, migration } = isolatedTarget(process.env);
const sql = connect(url),
  admin = postgres(migration, { max: 1 });
await checkRole(sql);

type Fixture = {
  tenantId: string;
  owner: Session;
  manager: Session;
  cashier: Session;
  server: Session;
  kitchen: Session;
};
const restaurant = {
  name: "Menu fixture",
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
};
async function makeTenant(label: string): Promise<Fixture> {
  const organizationId = randomUUID(),
    tenantId = randomUUID(),
    deviceId = randomUUID();
  const ids = Object.fromEntries(
    ["owner", "manager", "cashier", "server", "kitchen"].map((r) => [
      r,
      randomUUID(),
    ]),
  );
  await admin.begin(async (tx) => {
    await tx`insert into organizations(id,name) values(${organizationId},${"Menu fixture " + label})`;
    await tx`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,free_location)
      values(${tenantId},${organizationId},${restaurant.name},'MXN','America/Mexico_City',240,true)`;
    await tx`select set_config('app.tenant_id',${tenantId},true)`;
    for (const [role, id] of Object.entries(ids))
      await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
        values(${tenantId},${id},${"Menu " + role},${role + "-" + id.slice(0, 8)},${password("menu-fixture")},${role})`;
    await tx`insert into devices(tenant_id,id,name,token_hash,free_slot) values(${tenantId},${deviceId},'Menu device','fixture',1)`;
    await tx`insert into restaurant_entitlements(tenant_id,status,access_until,source)
      values(${tenantId},'active',now()+interval '1 day','fixture')`;
  });
  const session = (role: string): Session => ({
    id: randomUUID(),
    tenantId,
    employeeId: ids[role],
    name: "Menu " + role,
    role,
    deviceId,
    expiresAt: "",
    offlineUntil: "",
    csrf: "",
    restaurant,
  });
  return {
    tenantId,
    owner: session("owner"),
    manager: session("manager"),
    cashier: session("cashier"),
    server: session("server"),
    kitchen: session("kitchen"),
  };
}

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (e: any) => {
    assert.equal(e.code ?? e.message, code);
    return true;
  });
}
const op = () => randomUUID();
const run = <T>(s: Session, fn: (tx: any) => Promise<T>) =>
  tenant(sql, s.tenantId, fn);
const asAdmin = <T>(tenantId: string, fn: (tx: any) => Promise<T>) =>
  admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id',${tenantId},true)`;
    return fn(tx);
  }) as Promise<T>;
const setPlan = (tenantId: string, plan: "free" | "pro") =>
  admin`update restaurant_entitlements set status=${plan === "pro" ? "active" : "free"},
    access_until=${plan === "pro" ? admin`now()+interval '1 day'` : null} where tenant_id=${tenantId}`;
async function onHand(s: Session, stockId: string) {
  const [r] = await run(
    s,
    (tx) =>
      tx`select on_hand::text as q,negative_since,version from stock_items where id=${stockId}`,
  );
  return r as { q: string; negative_since: Date | null; version: number };
}
async function newStock(
  s: Session,
  name: string,
  unit = "piece",
  opening: string | null = null,
) {
  const item = await run(s, (tx) =>
    saveStockItem(tx, s, {
      operationId: op(),
      id: randomUUID(),
      expectedVersion: 0,
      name: `${name} ${randomUUID().slice(0, 6)}`,
      unit,
      kind: "raw",
      threshold: "0",
      parLevel: null,
      openingQuantity: opening,
    }),
  );
  return item.id;
}
async function newCategory(s: Session, name: string) {
  return run(s, (tx) =>
    saveCategory(tx, s, {
      operationId: op(),
      id: randomUUID(),
      expectedVersion: 0,
      name: { es: name },
    }),
  );
}
function productBody(categoryId: string, extra: Record<string, unknown> = {}) {
  return {
    operationId: op(),
    id: randomUUID(),
    expectedVersion: 0,
    name: { es: "Producto " + randomUUID().slice(0, 6) },
    categoryId,
    price: 5000,
    station: "kitchen",
    ...extra,
  };
}
const newProduct = (
  s: Session,
  categoryId: string,
  extra: Record<string, unknown> = {},
) => run(s, (tx) => saveMenuProduct(tx, s, productBody(categoryId, extra)));
function groupBody(extra: Record<string, unknown> = {}) {
  return {
    operationId: op(),
    id: randomUUID(),
    expectedVersion: 0,
    name: { es: "Salsa" },
    min: 1,
    max: 1,
    options: [
      { id: randomUUID(), name: { es: "Verde" }, price: 0 },
      { id: randomUUID(), name: { es: "Roja" }, price: 0 },
    ],
    ...extra,
  };
}
function orderBody(
  lines: {
    productId: string;
    options?: string[];
    quantity?: number;
    openAmount?: number;
  }[],
  extra: Record<string, unknown> = {},
) {
  return {
    operationId: op(),
    lines: lines.map((l) => ({
      id: randomUUID(),
      productId: l.productId,
      quantity: l.quantity ?? 1,
      options: l.options ?? [],
      note: "",
      ...(l.openAmount !== undefined ? { openAmount: l.openAmount } : {}),
    })),
    mode: "takeaway",
    tableId: null,
    name: "Menu DB",
    note: "",
    channel: "pos",
    ...extra,
  };
}
const order = (s: Session, body: unknown, offline = false) =>
  run(s, (tx) => createOrder(tx, s, body, offline)) as Promise<Order>;
async function openDrawer(s: Session) {
  await run(s, async (tx) => {
    const [d] =
      await tx`select id from cash_sessions where device_id=${s.deviceId} and closed_at is null`;
    if (!d)
      await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${s.tenantId},${randomUUID()},${s.deviceId},${s.employeeId},0)`;
  });
}
/** Mirrors POST /inventory/movement (server/index.ts) for receipt and waste. */
const move = (
  s: Session,
  stockId: string,
  quantity: string,
  cause: "receipt" | "waste",
) =>
  run(s, (tx) =>
    stock(
      tx,
      s,
      stockId,
      new Decimal(quantity).mul(cause === "waste" ? -1 : 1).toFixed(6),
      cause,
      op(),
      cause,
    ),
  );
/** Mirrors the count branch of POST /inventory/movement: version check, then
 * the difference against the cached balance of the locked row. */
const count = (
  s: Session,
  stockId: string,
  counted: string,
  expectedVersion: number,
) =>
  run(s, async (tx) => {
    const [i] =
      await tx`select * from stock_items where id=${stockId} for update`;
    if (i.version !== expectedVersion)
      throw new DomainError("count_changed", 409);
    await stock(
      tx,
      s,
      stockId,
      new Decimal(counted).minus(i.on_hand).toFixed(6),
      "count_adjust",
      op(),
      "Conteo",
    );
  });
/** Mirrors POST /inventory/prep: both rows locked in id order, then two movements. */
const prep = (
  s: Session,
  inputId: string,
  inputQuantity: string,
  outputId: string,
  outputQuantity: string,
) =>
  run(s, async (tx) => {
    const key = op();
    await lockStockItems(tx, [inputId, outputId]);
    await stock(
      tx,
      s,
      inputId,
      new Decimal(inputQuantity).negated().toString(),
      "prep_input",
      key,
      "Prep",
    );
    await stock(tx, s, outputId, outputQuantity, "prep_output", key, "Prep");
  });
async function drift(): Promise<unknown[]> {
  // Owner-scoped and across every tenant: the cache must equal the ledger.
  return [
    ...(await admin`select i.tenant_id,i.id,i.on_hand,coalesce(m.total,0) as ledger from stock_items i
    left join (select tenant_id,stock_id,sum(quantity) as total from stock_movements group by 1,2) m
      on m.tenant_id=i.tenant_id and m.stock_id=i.id
    where i.on_hand<>coalesce(m.total,0)`),
  ];
}

const a = await makeTenant("A"),
  b = await makeTenant("B");
const { owner, manager, cashier } = a;

try {
  // ------------------------------------------------------------------ menu
  await test("legacy catalog adoption creates categories, positions and reusable groups without bumping versions", async () => {
    const productId = randomUUID(),
      groupId = randomUUID(),
      optionId = randomUUID();
    await asAdmin(
      a.tenantId,
      (tx) =>
        tx`insert into catalog(tenant_id,id,data) values(${a.tenantId},${productId},${tx.json(
          {
            id: productId,
            name: { es: "Legado", en: "Legacy" },
            category: { es: "Categoría legado", en: "Legacy category" },
            price: 1000,
            available: true,
            station: "kitchen",
            groups: [
              {
                id: groupId,
                name: { es: "Salsa", en: "Salsa" },
                min: 1,
                max: 1,
                options: [
                  {
                    id: optionId,
                    name: { es: "Verde", en: "Green" },
                    price: 0,
                    available: true,
                  },
                ],
              },
            ],
            recipe: [],
            cost: null,
            version: 4,
          },
        )})`,
    );
    const [first] = await admin`select menu_adopt_legacy_catalog() as n`;
    assert(first.n >= 1);
    const [second] = await admin`select menu_adopt_legacy_catalog() as n`;
    assert.equal(second.n, 0, "adoption is idempotent");
    const [doc] = await asAdmin(
      a.tenantId,
      (tx) => tx`select data from catalog where id=${productId}`,
    );
    assert.equal(doc.data.version, 4, "adoption does not bump versions");
    assert.equal(doc.data.position, 1);
    assert.deepEqual(doc.data.groupIds, [groupId]);
    assert.deepEqual(doc.data.category, {
      es: "Categoría legado",
      en: "Legacy category",
    });
    const [category] = await asAdmin(
      a.tenantId,
      (tx) => tx`select * from menu_categories where id=${doc.data.categoryId}`,
    );
    assert.equal(category.name_es, "Categoría legado");
    const [group] = await asAdmin(
      a.tenantId,
      (tx) => tx`select data from modifier_groups where id=${groupId}`,
    );
    assert.equal(group.data.options[0].id, optionId);
    assert.equal(group.data.repeat, false);
  });

  const tacos = await newCategory(manager, "Tacos " + randomUUID().slice(0, 4));
  let salsa: any, p1: Product, p2: Product;
  await test("manager builds categories, products and a shared group; a group edit recompiles both products and writes recipe_versions", async () => {
    const created = await run(manager, (tx) =>
      saveGroup(tx, manager, groupBody({ name: { es: "Salsa", en: "Salsa" } })),
    );
    salsa = created.group;
    assert.equal(created.recompiled, 0);
    p1 = await newProduct(manager, tacos.id, { groupIds: [salsa.id] });
    p2 = await newProduct(manager, tacos.id, { groupIds: [salsa.id] });
    assert.equal(p1.position, 1);
    assert.equal(p2.position, 2);
    assert.equal(p1.categoryPosition, tacos.position);
    const edited = await run(manager, (tx) =>
      saveGroup(tx, manager, {
        ...groupBody(),
        id: salsa.id,
        expectedVersion: 1,
        name: { es: "Salsa", en: "Salsa" },
        options: [
          ...salsa.options.map((o: any) => ({
            id: o.id,
            name: o.name,
            price: o.price,
          })),
          { id: randomUUID(), name: { es: "Habanero" }, price: 500 },
        ],
      }),
    );
    assert.equal(edited.recompiled, 2);
    salsa = edited.group;
    const docs = (await run(manager, catalog)).filter((p) =>
      [p1.id, p2.id].includes(p.id),
    );
    for (const doc of docs) {
      assert.equal(doc.version, 2);
      assert.equal(doc.groups[0].options.length, 3);
      assert.equal(doc.groups[0].version, 2);
    }
    const versions = await run(
      manager,
      (tx) =>
        tx`select version,data from recipe_versions where product_id=${p1.id} order by version`,
    );
    assert.deepEqual(
      versions.map((v: any) => v.version),
      [1, 2],
    );
    assert.deepEqual(versions[1].data.groups, [{ id: salsa.id, version: 2 }]);
    [p1, p2] = [
      docs.find((d) => d.id === p1.id)!,
      docs.find((d) => d.id === p2.id)!,
    ];
    const editor = await run(manager, (tx) => menuEditor(tx, manager));
    assert.deepEqual(
      editor.groups.find((g) => g.id === salsa.id)!.usedBy.sort(),
      [p1.id, p2.id].sort(),
    );
    assert.equal(
      editor.categories.find((c) => c.id === tacos.id)!.productCount,
      2,
    );
  });

  await test("reorder requires the exact active set and only moves positions", async () => {
    await rejects(
      run(manager, (tx) =>
        reorderProducts(tx, manager, {
          operationId: op(),
          scopeId: tacos.id,
          ids: [p1.id],
        }),
      ),
      "menu_changed",
    );
    await run(manager, (tx) =>
      reorderProducts(tx, manager, {
        operationId: op(),
        scopeId: tacos.id,
        ids: [p2.id, p1.id],
      }),
    );
    const docs = await run(manager, catalog);
    const order = docs
      .filter((p) => p.categoryId === tacos.id)
      .map((p) => p.id);
    assert.deepEqual(order, [p2.id, p1.id]);
    assert.equal(docs.find((p) => p.id === p1.id)!.version, p1.version);
    const editor = await run(manager, (tx) => menuEditor(tx, manager));
    const ids = editor.categories.filter((c) => !c.archived).map((c) => c.id);
    await run(manager, (tx) =>
      reorderCategories(tx, manager, {
        operationId: op(),
        ids: [...ids].reverse(),
      }),
    );
    const moved = (await run(manager, catalog)).find((p) => p.id === p1.id)!;
    assert.equal(moved.categoryPosition, ids.length - ids.indexOf(tacos.id));
    assert.equal(
      moved.version,
      p1.version,
      "category order is not priced content",
    );
  });

  await test("availability toggles bump the menu revision but not product versions", async () => {
    const before = (await run(manager, menuRevision)).revision;
    const off = await run(manager, (tx) =>
      setProductAvailability(tx, manager, {
        operationId: op(),
        id: p2.id,
        available: false,
      }),
    );
    assert.equal(off.available, false);
    assert.equal(off.version, p2.version);
    const habanero = salsa.options[2].id;
    await run(manager, (tx) =>
      setOptionAvailability(tx, manager, {
        operationId: op(),
        groupId: salsa.id,
        optionId: habanero,
        available: false,
      }),
    );
    const after = (await run(manager, menuRevision)).revision;
    assert(after >= before + 2);
    const doc = (await run(manager, catalog)).find((p) => p.id === p1.id)!;
    assert.equal(doc.version, p1.version);
    assert.equal(doc.groups[0].options[2].available, false);
    await rejects(
      order(cashier, orderBody([{ productId: p1.id, options: [habanero] }])),
      "invalid_modifier",
    );
    await rejects(
      order(
        cashier,
        orderBody([{ productId: p2.id, options: [salsa.options[0].id] }]),
      ),
      "unavailable",
    );
    await run(manager, (tx) =>
      setProductAvailability(tx, manager, {
        operationId: op(),
        id: p2.id,
        available: true,
      }),
    );
    await run(manager, (tx) =>
      setOptionAvailability(tx, manager, {
        operationId: op(),
        groupId: salsa.id,
        optionId: habanero,
        available: true,
      }),
    );
  });

  await test("stale expectedVersion returns menu_changed; the same operationId replays; a changed payload returns operation_conflict", async () => {
    const before = (await run(manager, catalog)).find((p) => p.id === p1.id)!;
    const body = {
      ...productBody(tacos.id, { groupIds: [salsa.id] }),
      id: p1.id,
      expectedVersion: p1.version,
      name: p1.name,
      price: 5500,
    };
    const saved = await run(manager, (tx) =>
      saveMenuProduct(tx, manager, body),
    );
    assert.equal(saved.version, p1.version + 1);
    const replay = await run(manager, (tx) =>
      saveMenuProduct(tx, manager, body),
    );
    assert.deepEqual(replay, saved);
    await rejects(
      run(manager, (tx) =>
        saveMenuProduct(tx, manager, { ...body, price: 6000 }),
      ),
      "operation_conflict",
    );
    await rejects(
      run(manager, (tx) =>
        saveMenuProduct(tx, manager, { ...body, operationId: op() }),
      ),
      "menu_changed",
    );
    assert.equal(
      saved.position,
      before.position,
      "same category keeps its position",
    );
    p1 = saved;
  });

  await test("choice ids cannot be reused by another group", async () => {
    await rejects(
      run(manager, (tx) =>
        saveGroup(
          tx,
          manager,
          groupBody({
            options: [
              { id: salsa.options[0].id, name: { es: "Copia" }, price: 0 },
            ],
          }),
        ),
      ),
      "invalid_group",
    );
  });

  let combo: any;
  await test("a combo without a required group is rejected", async () => {
    const optional = (
      await run(manager, (tx) =>
        saveGroup(
          tx,
          manager,
          groupBody({ name: { es: "Extras" }, min: 0, max: 2 }),
        ),
      )
    ).group;
    await rejects(
      newProduct(manager, tacos.id, { kind: "combo", groupIds: [optional.id] }),
      "combo_requires_choice",
    );
    combo = await newProduct(manager, tacos.id, {
      kind: "combo",
      groupIds: [optional.id, salsa.id],
    });
    assert.equal(combo.kind, "combo");
    const big = (
      await run(manager, (tx) =>
        saveGroup(
          tx,
          manager,
          groupBody({ name: { es: "Grande" }, min: 0, max: 30, repeat: true }),
        ),
      )
    ).group;
    await rejects(
      newProduct(manager, tacos.id, { groupIds: [big.id, salsa.id] }),
      "invalid_group",
    );
  });

  await test("archiving a group unlinks it from every product", async () => {
    const group = (
      await run(manager, (tx) =>
        saveGroup(tx, manager, groupBody({ name: { es: "Término" } })),
      )
    ).group;
    const x = await newProduct(manager, tacos.id, { groupIds: [group.id] });
    const y = await newProduct(manager, tacos.id, {
      groupIds: [group.id, salsa.id],
    });
    const result = await run(manager, (tx) =>
      archiveGroup(tx, manager, {
        operationId: op(),
        id: group.id,
        expectedVersion: group.version,
        archived: true,
      }),
    );
    assert.equal(result.unlinked, 2);
    assert.equal(result.group.archived, true);
    const docs = await run(manager, catalog);
    const dx = docs.find((p) => p.id === x.id)!,
      dy = docs.find((p) => p.id === y.id)!;
    assert.deepEqual(dx.groupIds, []);
    assert.deepEqual(dy.groupIds, [salsa.id]);
    assert.deepEqual(
      dy.groups.map((g) => g.id),
      [salsa.id],
    );
    assert.equal(dx.version, x.version + 1);
    await rejects(
      newProduct(manager, tacos.id, { groupIds: [group.id] }),
      "invalid_group",
    );
  });

  await test("a category with active products cannot be archived", async () => {
    const category = await newCategory(
      manager,
      "Temporal " + randomUUID().slice(0, 4),
    );
    const product = await newProduct(manager, category.id);
    await rejects(
      run(manager, (tx) =>
        archiveCategory(tx, manager, {
          operationId: op(),
          id: category.id,
          expectedVersion: category.version,
          archived: true,
        }),
      ),
      "category_in_use",
    );
    const archived = await run(manager, (tx) =>
      archiveProduct(tx, manager, {
        operationId: op(),
        id: product.id,
        expectedVersion: product.version,
        archived: true,
      }),
    );
    assert.equal(archived.archived, true);
    assert.equal(archived.available, false);
    assert(!(await run(manager, catalog)).some((p) => p.id === product.id));
    const closed = await run(manager, (tx) =>
      archiveCategory(tx, manager, {
        operationId: op(),
        id: category.id,
        expectedVersion: category.version,
        archived: true,
      }),
    );
    assert.equal(closed.archived, true);
    await rejects(
      run(manager, (tx) =>
        archiveProduct(tx, manager, {
          operationId: op(),
          id: product.id,
          expectedVersion: archived.version,
          archived: false,
        }),
      ),
      "invalid_category",
    );
  });

  await test("recipe or cost edits require Pro; names and prices do not", async () => {
    const stockId = await newStock(owner, "Pro gate");
    await setPlan(a.tenantId, "free");
    try {
      const product = await newProduct(owner, tacos.id);
      const renamed = await run(owner, (tx) =>
        saveMenuProduct(tx, owner, {
          ...productBody(tacos.id),
          id: product.id,
          expectedVersion: product.version,
          name: { es: "Renombrado" },
          price: 7000,
        }),
      );
      assert.equal(renamed.price, 7000);
      for (const change of [
        { recipe: [{ stockId, quantity: "1" }] },
        { cost: 100 },
      ])
        await rejects(
          run(owner, (tx) =>
            saveMenuProduct(tx, owner, {
              ...productBody(tacos.id),
              id: product.id,
              expectedVersion: renamed.version,
              ...change,
            }),
          ),
          "pro_required",
        );
      await rejects(
        run(owner, (tx) =>
          saveGroup(
            tx,
            owner,
            groupBody({
              options: [
                {
                  id: randomUUID(),
                  name: { es: "Queso" },
                  price: 1500,
                  recipe: [{ stockId, quantity: "0.03" }],
                },
              ],
            }),
          ),
        ),
        "pro_required",
      );
      await rejects(newStock(owner, "Free"), "pro_required");
      const policy = await run(owner, (tx) =>
        saveNegativeStockPolicy(tx, owner, {
          operationId: op(),
          policy: "allow",
        }),
      );
      assert.equal(policy.policy, "allow");
      const item = (
        await run(owner, (tx) => listStockItems(tx, owner))
      ).items.find((i) => i.id === stockId)!;
      const archived = await run(owner, (tx) =>
        archiveStockItem(tx, owner, {
          operationId: op(),
          id: stockId,
          expectedVersion: item.settingsVersion,
          archived: true,
        }),
      );
      assert.equal(archived.archived, true);
    } finally {
      await setPlan(a.tenantId, "pro");
    }
  });

  await test("cashier, server and kitchen cannot call menu, floor or stock-item mutations", async () => {
    for (const s of [a.cashier, a.server, a.kitchen])
      for (const call of [
        (tx: any) => menuEditor(tx, s),
        (tx: any) =>
          saveCategory(tx, s, {
            operationId: op(),
            id: randomUUID(),
            expectedVersion: 0,
            name: { es: "X" },
          }),
        (tx: any) => saveMenuProduct(tx, s, productBody(tacos.id)),
        (tx: any) => saveGroup(tx, s, groupBody()),
        (tx: any) =>
          setProductAvailability(tx, s, {
            operationId: op(),
            id: p1.id,
            available: false,
          }),
        (tx: any) => floorPayload(tx, s),
        (tx: any) =>
          saveArea(tx, s, {
            operationId: op(),
            id: randomUUID(),
            expectedVersion: 0,
            name: "X",
          }),
        (tx: any) =>
          saveTable(tx, s, {
            operationId: op(),
            id: randomUUID(),
            expectedVersion: 0,
            name: "X",
            areaId: null,
          }),
        (tx: any) =>
          bulkTables(tx, s, {
            operationId: op(),
            areaId: null,
            from: 1,
            to: 2,
          }),
        (tx: any) => listStockItems(tx, s),
        (tx: any) =>
          saveNegativeStockPolicy(tx, s, {
            operationId: op(),
            policy: "block",
          }),
        (tx: any) =>
          archiveStockItem(tx, s, {
            operationId: op(),
            id: randomUUID(),
            expectedVersion: 1,
            archived: true,
          }),
      ])
        await rejects(run(s, call), "forbidden");
    // Every signed-in role may poll the revision.
    assert.equal(
      typeof (await run(a.kitchen, menuRevision)).revision,
      "number",
    );
  });

  await test("tenant isolation for menu_state, menu_categories, modifier_groups and dining_areas", async () => {
    await run(manager, (tx) =>
      saveArea(tx, manager, {
        operationId: op(),
        id: randomUUID(),
        expectedVersion: 0,
        name: "Aislada " + randomUUID().slice(0, 4),
      }),
    );
    for (const table of [
      "menu_state",
      "menu_categories",
      "modifier_groups",
      "dining_areas",
    ]) {
      const own = await run(a.owner, (tx) =>
        tx.unsafe(`select tenant_id from ${table}`),
      );
      assert(own.length > 0, table);
      const other = await run(b.owner, (tx) =>
        tx.unsafe(`select tenant_id from ${table}`),
      );
      assert(!other.some((r: any) => r.tenant_id === a.tenantId), table);
    }
    await assert.rejects(
      run(
        b.owner,
        (tx) =>
          tx`insert into menu_categories(tenant_id,id,name_es,name_en) values(${a.tenantId},${randomUUID()},'Ajena','Foreign')`,
      ),
    );
    await assert.rejects(
      run(
        b.owner,
        (tx) =>
          tx`insert into menu_state(tenant_id,revision) values(${a.tenantId},5)`,
      ),
    );
    // A foreign id is invisible, so B cannot link A's group or category.
    const bCategory = await newCategory(
      b.manager,
      "B " + randomUUID().slice(0, 4),
    );
    await rejects(newProduct(b.manager, tacos.id), "invalid_category");
    await rejects(
      newProduct(b.manager, bCategory.id, { groupIds: [salsa.id] }),
      "invalid_group",
    );
  });

  await test("legacy /catalog/save keeps working and attaches a category", async () => {
    const label = {
      es: "Bebidas legado " + randomUUID().slice(0, 4),
      en: "Legacy drinks",
    };
    const id = randomUUID();
    const body = {
      operationId: op(),
      id,
      name: { es: "Agua legado", en: "Legacy water" },
      category: label,
      price: 3000,
      available: true,
      station: "bar",
      expectedVersion: 0,
      cost: null,
      recipe: [],
    };
    const first = await run(manager, (tx) => saveProduct(tx, manager, body));
    assert(first.categoryId);
    assert.deepEqual(first.groupIds, []);
    assert.equal(first.kind, "item");
    assert.equal(first.version, 1);
    const second = await run(manager, (tx) =>
      saveProduct(tx, manager, {
        ...body,
        operationId: op(),
        category: { es: label.es.toUpperCase(), en: label.en },
        expectedVersion: 1,
        available: false,
      }),
    );
    assert.equal(
      second.categoryId,
      first.categoryId,
      "same label, same category",
    );
    assert.equal(second.available, false, "the legacy form edits availability");
    const replay = await run(manager, (tx) => saveProduct(tx, manager, body));
    assert.equal(replay.version, 1, "legacy operation kind still replays");
    await rejects(
      run(manager, (tx) =>
        saveProduct(tx, manager, { ...body, operationId: op() }),
      ),
      "menu_changed",
    );
  });

  await test("catalog import assigns categories and empty groupIds", async () => {
    const sourceTenantId = "menu-" + randomUUID();
    await run(manager, (tx) =>
      commitImport(tx, manager, {
        source: "luma",
        sourceTenantId,
        targetTenantId: a.tenantId,
        currency: "MXN",
        rows: [
          {
            id: "m-1",
            name: "Importado uno",
            price: "10.00",
            category: "Importados",
          },
          {
            id: "m-2",
            name: "Importado dos",
            price: "12.50",
            category: "Importados",
          },
        ],
      }),
    );
    const docs = (await run(manager, catalog)).filter((p) =>
      ["Importado uno", "Importado dos"].includes(p.name.es),
    );
    assert.equal(docs.length, 2);
    assert.equal(docs[0].categoryId, docs[1].categoryId);
    for (const d of docs) {
      assert.deepEqual(d.groupIds, []);
      assert.equal(d.kind, "item");
      assert.equal(d.openAmount, false);
      assert.equal(d.archived, false);
      assert(d.position! >= 1);
    }
  });

  let varios: Product;
  await test("public catalog hides open-price and archived products, recipes and costs", async () => {
    varios = await newProduct(manager, tacos.id, {
      name: { es: "Varios" },
      openAmount: true,
      openMax: 50000,
      price: 0,
    });
    assert.equal(varios.price, 0);
    const stockId = await newStock(manager, "Público", "kg", "10");
    const secret = await newProduct(manager, tacos.id, {
      recipe: [{ stockId, quantity: "0.2" }],
      cost: 1200,
    });
    await run(manager, (tx) =>
      saveGroup(tx, manager, {
        ...groupBody(),
        id: salsa.id,
        expectedVersion: salsa.version,
        name: salsa.name,
        options: salsa.options.map((o: any, i: number) => ({
          id: o.id,
          name: o.name,
          price: o.price,
          ...(i === 0
            ? { cost: 50, recipe: [{ stockId, quantity: "0.01" }] }
            : {}),
        })),
      }),
    ).then((r) => (salsa = r.group));
    const list = await run(manager, publicCatalog);
    assert(!list.some((p) => p.id === varios.id), "open price is staff only");
    assert(list.some((p) => p.id === secret.id));
    for (const p of list) {
      assert(!("recipe" in p) && !("cost" in p));
      for (const g of p.groups)
        for (const o of g.options) assert(!("recipe" in o) && !("cost" in o));
    }
    assert(!list.some((p) => p.archived));
  });

  await test("open-price sale by a cashier within the ceiling; above the ceiling and via QR are rejected", async () => {
    const sold = await order(
      cashier,
      orderBody([{ productId: varios.id, openAmount: 12000 }]),
    );
    assert.equal(sold.total, 12000);
    assert.equal(sold.lines[0].openAmount, 12000);
    await rejects(
      order(cashier, orderBody([{ productId: varios.id, openAmount: 50001 }])),
      "open_amount_exceeds",
    );
    await rejects(
      order(
        cashier,
        orderBody([{ productId: varios.id, openAmount: 100 }], {
          channel: "qr",
        }),
      ),
      "forbidden",
    );
    await rejects(
      order(a.kitchen, orderBody([{ productId: varios.id, openAmount: 100 }])),
      "forbidden",
    );
  });

  await test("an option recipe deducts the merged quantity once per stock item", async () => {
    const stockId = await newStock(manager, "Tortilla", "piece", "100");
    const group = (
      await run(manager, (tx) =>
        saveGroup(
          tx,
          manager,
          groupBody({
            name: { es: "Tortilla doble" },
            min: 0,
            max: 2,
            repeat: true,
            options: [
              {
                id: randomUUID(),
                name: { es: "Extra" },
                price: 500,
                cost: 100,
                recipe: [{ stockId, quantity: "0.5" }],
              },
            ],
          }),
        ),
      )
    ).group;
    const product = await newProduct(manager, tacos.id, {
      groupIds: [group.id],
      recipe: [{ stockId, quantity: "1" }],
      cost: 1000,
    });
    const extra = group.options[0].id;
    const sold = await order(
      cashier,
      orderBody([
        { productId: product.id, options: [extra, extra], quantity: 2 },
      ]),
    );
    const line = sold.lines[0];
    assert.deepEqual(line.recipe, [{ stockId, quantity: "2" }]);
    assert.equal(line.cost, 1000 + 2 * 100);
    assert.equal(line.unitPrice, 5000 + 1000);
    assert.equal(line.categoryId, tacos.id);
    assert.equal(line.kind, "item");
    assert.deepEqual(line.optionNames, [{ es: "2× Extra", en: "2× Extra" }]);
    const moves = await run(
      manager,
      (tx) =>
        tx`select quantity::text as q from stock_movements where stock_id=${stockId} and cause='sale' and cause_id=${line.id}`,
    );
    assert.equal(moves.length, 1);
    assert.equal(Number(moves[0].q), -4);
    assert.equal(Number((await onHand(manager, stockId)).q), 96);
  });

  // ----------------------------------------------------------------- floor
  let terraza: any;
  await test("bulk tables create named tables in an area; a duplicate rejects the whole batch", async () => {
    terraza = await run(manager, (tx) =>
      saveArea(tx, manager, {
        operationId: op(),
        id: randomUUID(),
        expectedVersion: 0,
        name: "Terraza",
      }),
    );
    const prefix = "T" + randomUUID().slice(0, 4);
    const created = await run(manager, (tx) =>
      bulkTables(tx, manager, {
        operationId: op(),
        areaId: terraza.id,
        prefix,
        from: 1,
        to: 3,
        seats: 4,
      }),
    );
    assert.deepEqual(
      created.map((t) => t.name),
      [`${prefix} 1`, `${prefix} 2`, `${prefix} 3`],
    );
    assert.deepEqual(
      created.map((t) => t.position),
      [1, 2, 3],
    );
    await rejects(
      run(manager, (tx) =>
        bulkTables(tx, manager, {
          operationId: op(),
          areaId: terraza.id,
          prefix: prefix.toLowerCase(),
          from: 3,
          to: 5,
        }),
      ),
      "duplicate_name",
    );
    const floor = await run(manager, (tx) => floorPayload(tx, manager));
    assert(
      !floor.tables.some((t) => t.name === `${prefix} 4`),
      "all or nothing",
    );
    await rejects(
      run(manager, (tx) =>
        bulkTables(tx, manager, {
          operationId: op(),
          areaId: randomUUID(),
          prefix,
          from: 10,
          to: 11,
        }),
      ),
      "invalid_area",
    );
  });

  let table: any;
  await test("a table with an unpaid order cannot be archived; a paid completed one can", async () => {
    table = await run(manager, (tx) =>
      saveTable(tx, manager, {
        operationId: op(),
        id: randomUUID(),
        expectedVersion: 0,
        name: "Mesa " + randomUUID().slice(0, 4),
        areaId: terraza.id,
        seats: 2,
      }),
    );
    const plain = await newProduct(manager, tacos.id);
    const sold = await order(
      cashier,
      orderBody([{ productId: plain.id }], {
        mode: "dine_in",
        tableId: table.id,
      }),
    );
    const floor = await run(manager, (tx) => floorPayload(tx, manager));
    assert.equal(floor.tables.find((t) => t.id === table.id)!.open, true);
    await rejects(
      run(manager, (tx) =>
        archiveTable(tx, manager, {
          operationId: op(),
          id: table.id,
          expectedVersion: table.version,
          archived: true,
        }),
      ),
      "table_in_use",
    );
    await openDrawer(owner);
    await run(owner, (tx) =>
      recordPayment(tx, owner, sold.id, {
        operationId: op(),
        amount: sold.total,
        tip: 0,
        received: sold.total,
        method: "cash",
      }),
    );
    for (const state of ["ready", "completed"])
      await run(owner, (tx) =>
        progressPreparation(tx, owner, sold.rounds[0].id, {
          operationId: op(),
          state,
        }),
      );
    assert.equal(
      (await run(owner, (tx) => getOrder(tx, sold.id))).state,
      "completed",
    );
    const archived = await run(manager, (tx) =>
      archiveTable(tx, manager, {
        operationId: op(),
        id: table.id,
        expectedVersion: table.version,
        archived: true,
      }),
    );
    assert.equal(archived.archived, true);
    table = archived;
  });

  await test("archived tables are hidden from /tables and service options and rejected for new dine-in orders", async () => {
    assert(
      !(await run(manager, activeTables)).some((t: any) => t.id === table.id),
    );
    const options = await run(cashier, (tx) => serviceOptions(tx, cashier));
    assert(!options.tables.some((t: any) => t.id === table.id));
    const plain = await newProduct(manager, tacos.id);
    await rejects(
      order(
        cashier,
        orderBody([{ productId: plain.id }], {
          mode: "dine_in",
          tableId: table.id,
        }),
      ),
      "invalid_table",
    );
    const open = await order(cashier, orderBody([{ productId: plain.id }]));
    await rejects(
      run(cashier, (tx) =>
        assignService(tx, cashier, open.id, {
          operationId: op(),
          expectedVersion: 0,
          tableId: table.id,
          employeeId: cashier.employeeId,
          mode: "dine_in",
          reason: "Cambio de mesa",
        }),
      ),
      "invalid_table",
    );
    const tables = await run(manager, activeTables);
    const terrazaTables = tables.filter((t: any) => t.area_id === terraza.id);
    assert(terrazaTables.every((t: any) => t.area_name === "Terraza"));
  });

  await test("an area with active tables cannot be archived", async () => {
    const fresh = (
      await run(manager, (tx) => floorPayload(tx, manager))
    ).areas.find((x) => x.id === terraza.id)!;
    await rejects(
      run(manager, (tx) =>
        archiveArea(tx, manager, {
          operationId: op(),
          id: terraza.id,
          expectedVersion: fresh.version,
          archived: true,
        }),
      ),
      "area_in_use",
    );
    const empty = await run(manager, (tx) =>
      saveArea(tx, manager, {
        operationId: op(),
        id: randomUUID(),
        expectedVersion: 0,
        name: "Vacía " + randomUUID().slice(0, 4),
      }),
    );
    const archived = await run(manager, (tx) =>
      archiveArea(tx, manager, {
        operationId: op(),
        id: empty.id,
        expectedVersion: empty.version,
        archived: true,
      }),
    );
    assert.equal(archived.archived, true);
    await rejects(
      run(manager, (tx) =>
        saveTable(tx, manager, {
          operationId: op(),
          id: randomUUID(),
          expectedVersion: 0,
          name: "Sin área " + randomUUID().slice(0, 4),
          areaId: empty.id,
        }),
      ),
      "invalid_area",
    );
  });

  // ----------------------------------------------------------------- stock
  await test("DB-4: on_hand equals the movement ledger after sales, voids, receipts, prep, counts and waste", async () => {
    const raw = await newStock(manager, "Maíz", "kg", "50");
    const prepared = await newStock(manager, "Masa", "kg", "5");
    const product = await newProduct(manager, tacos.id, {
      recipe: [
        { stockId: raw, quantity: "0.1" },
        { stockId: prepared, quantity: "0.25" },
      ],
    });
    const sold = await order(
      cashier,
      orderBody([{ productId: product.id, quantity: 4 }]),
    );
    await run(owner, (tx) =>
      voidLines(
        tx,
        owner,
        sold.id,
        {
          operationId: op(),
          expectedVersion: sold.version,
          lines: [{ lineId: sold.lines[0].id, quantity: 1 }],
          reason: "Cliente cambió",
          stockDisposition: "return",
        },
        owner.employeeId,
      ),
    );
    await move(manager, raw, "12.5", "receipt");
    await move(manager, raw, "1", "waste");
    await prep(manager, raw, "2", prepared, "3");
    await count(
      manager,
      prepared,
      "4",
      (await onHand(manager, prepared)).version,
    );
    assert.equal(Number((await onHand(manager, prepared)).q), 4);
    assert.equal(
      Number((await onHand(manager, raw)).q),
      50 - 0.4 + 0.1 + 12.5 - 1 - 2,
    );
    assert.deepEqual(await drift(), []);
    const history = await run(manager, (tx) =>
      stockMovements(tx, manager, raw, { limit: "2" }),
    );
    assert.equal(history.movements.length, 2);
    assert(history.next);
    assert.equal(
      Number(history.movements[0].balanceAfter),
      Number((await onHand(manager, raw)).q),
    );
    const rest = await run(manager, (tx) =>
      stockMovements(tx, manager, raw, { before: history.next!, limit: "50" }),
    );
    assert.equal(history.movements.length + rest.movements.length, 6);
    assert.equal(rest.next, null);
  });

  await test("DB-4: createOrder issues no aggregate over stock_movements", async () => {
    const captured: string[] = [];
    const traced = postgres(url, {
      max: 1,
      debug: (_connection: number, query: string) => {
        captured.push(query);
      },
    });
    try {
      const stockId = await newStock(manager, "Traza", "piece", "10");
      const product = await newProduct(manager, tacos.id, {
        recipe: [{ stockId, quantity: "1" }],
      });
      await tenant(traced, cashier.tenantId, (tx) =>
        createOrder(
          tx,
          cashier,
          orderBody([{ productId: product.id, quantity: 2 }]),
        ),
      );
      assert(captured.some((q) => /insert into stock_movements/i.test(q)));
      assert(
        !captured.some((q) => /sum\(\s*quantity\s*\)/i.test(q)),
        captured.join("\n"),
      );
    } finally {
      await traced.end();
    }
  });

  await test("FIT-5: under allow, a sale past zero succeeds, sets negative_since, and a receipt clears it", async () => {
    const stockId = await newStock(manager, "Aguacate", "piece", "1");
    const product = await newProduct(manager, tacos.id, {
      recipe: [{ stockId, quantity: "1" }],
    });
    await order(cashier, orderBody([{ productId: product.id, quantity: 3 }]));
    const negative = await onHand(manager, stockId);
    assert.equal(Number(negative.q), -2);
    assert(negative.negative_since instanceof Date);
    const listed = (
      await run(manager, (tx) => listStockItems(tx, manager))
    ).items.find((i) => i.id === stockId)!;
    assert.equal(listed.negativeSince, negative.negative_since!.toISOString());
    await move(manager, stockId, "5", "receipt");
    const cleared = await onHand(manager, stockId);
    assert.equal(Number(cleared.q), 3);
    assert.equal(cleared.negative_since, null);
  });

  await test("under block, a sale past zero returns insufficient_stock; an offline-authorized sale is still recorded", async () => {
    const stockId = await newStock(manager, "Queso", "kg", "0.5");
    const product = await newProduct(manager, tacos.id, {
      recipe: [{ stockId, quantity: "0.2" }],
    });
    await run(manager, (tx) =>
      saveNegativeStockPolicy(tx, manager, {
        operationId: op(),
        policy: "block",
      }),
    );
    try {
      await rejects(
        order(cashier, orderBody([{ productId: product.id, quantity: 3 }])),
        "insufficient_stock",
      );
      await rejects(move(manager, stockId, "1", "waste"), "insufficient_stock");
      const offline = await order(
        cashier,
        orderBody([{ productId: product.id, quantity: 3 }], {
          channel: "offline",
        }),
        true,
      );
      assert.equal(offline.lines.length, 1);
      assert.equal(Number((await onHand(manager, stockId)).q), -0.1);
      // A forged offline channel without the sync authorization gets no bypass.
      await rejects(
        order(
          cashier,
          orderBody([{ productId: product.id }], { channel: "offline" }),
        ),
        "insufficient_stock",
      );
    } finally {
      await run(manager, (tx) =>
        saveNegativeStockPolicy(tx, manager, {
          operationId: op(),
          policy: "allow",
        }),
      );
    }
  });

  await test("INV-02: concurrent last-portion sales under block serialize and exactly one succeeds", async () => {
    const stockId = await newStock(manager, "Última porción", "piece", "1");
    const product = await newProduct(manager, tacos.id, {
      recipe: [{ stockId, quantity: "1" }],
    });
    await run(manager, (tx) =>
      saveNegativeStockPolicy(tx, manager, {
        operationId: op(),
        policy: "block",
      }),
    );
    try {
      const results = await Promise.allSettled(
        [1, 2, 3].map(() =>
          order(cashier, orderBody([{ productId: product.id }])),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      for (const r of results)
        if (r.status === "rejected")
          assert.equal((r.reason as any).code, "insufficient_stock");
      assert.equal(Number((await onHand(manager, stockId)).q), 0);
    } finally {
      await run(manager, (tx) =>
        saveNegativeStockPolicy(tx, manager, {
          operationId: op(),
          policy: "allow",
        }),
      );
    }
  });

  await test("count adjustment uses the cached balance and still detects concurrent movement (count_changed)", async () => {
    const stockId = await newStock(manager, "Conteo", "piece", "20");
    const product = await newProduct(manager, tacos.id, {
      recipe: [{ stockId, quantity: "1" }],
    });
    const seen = await onHand(manager, stockId);
    await order(cashier, orderBody([{ productId: product.id, quantity: 2 }]));
    await rejects(count(manager, stockId, "17", seen.version), "count_changed");
    await count(
      manager,
      stockId,
      "17",
      (await onHand(manager, stockId)).version,
    );
    const [move] = await run(
      manager,
      (tx) =>
        tx`select quantity::text as q,balance_after::text as b from stock_movements where stock_id=${stockId} and cause='count_adjust'`,
    );
    assert.equal(Number(move.q), -1);
    assert.equal(Number(move.b), 17);
  });

  await test("the runtime role cannot write on_hand or negative_since directly", async () => {
    const stockId = await newStock(manager, "Directo", "piece", "1");
    await assert.rejects(
      run(
        manager,
        (tx) => tx`update stock_items set on_hand=100 where id=${stockId}`,
      ),
    );
    await assert.rejects(
      run(
        manager,
        (tx) =>
          tx`update stock_items set negative_since=now() where id=${stockId}`,
      ),
    );
    await assert.rejects(
      run(
        manager,
        (tx) =>
          tx`update stock_movements set quantity=5 where stock_id=${stockId}`,
      ),
    );
    assert.equal(Number((await onHand(manager, stockId)).q), 1);
  });

  await test("stock movements are append-only even for the table owner", async () => {
    const stockId = await newStock(manager, "Historial", "piece", "3");
    await assert.rejects(
      asAdmin(
        a.tenantId,
        (tx) =>
          tx`update stock_movements set reason='editado' where stock_id=${stockId}`,
      ),
      /append-only/,
    );
    await assert.rejects(
      asAdmin(
        a.tenantId,
        (tx) => tx`delete from stock_movements where stock_id=${stockId}`,
      ),
      /append-only/,
    );
  });

  await test("a repeated movement inserted with ON CONFLICT DO NOTHING does not drift on_hand", async () => {
    const stockId = await newStock(manager, "Repetido", "piece", "3");
    for (let i = 0; i < 2; i++)
      await asAdmin(
        a.tenantId,
        (tx) =>
          tx`insert into stock_movements(tenant_id,id,stock_id,quantity,cause,cause_id,reason,actor_id)
          values(${a.tenantId},${randomUUID()},${stockId},5,'receipt','dup-receipt','Repetido',${owner.employeeId})
          on conflict do nothing`,
      );
    assert.equal(Number((await onHand(manager, stockId)).q), 8);
    await assert.rejects(
      asAdmin(
        b.tenantId,
        (tx) =>
          tx`insert into stock_movements(tenant_id,id,stock_id,quantity,cause,cause_id,reason,actor_id)
          values(${a.tenantId},${randomUUID()},${stockId},5,'receipt','foreign','Ajeno',${owner.employeeId})`,
      ),
    );
    assert.deepEqual(await drift(), []);
  });

  await test("a stock item unit is locked after movements or recipe use", async () => {
    const save = (id: string, version: number, unit: string, name: string) =>
      run(manager, (tx) =>
        saveStockItem(tx, manager, {
          operationId: op(),
          id,
          expectedVersion: version,
          name,
          unit,
          kind: "raw",
          threshold: "1",
          parLevel: "10",
          openingQuantity: null,
        }),
      );
    const fresh = await newStock(manager, "Sin uso", "g");
    const item = (
      await run(manager, (tx) => listStockItems(tx, manager))
    ).items.find((i) => i.id === fresh)!;
    const changed = await save(fresh, item.settingsVersion, "kg", item.name);
    assert.equal(changed.unit, "kg");
    assert.equal(Number(changed.parLevel), 10);
    await rejects(
      save(fresh, item.settingsVersion, "g", item.name),
      "menu_changed",
    );
    const moved = await newStock(manager, "Con movimiento", "kg", "1");
    const m = (
      await run(manager, (tx) => listStockItems(tx, manager))
    ).items.find((i) => i.id === moved)!;
    await rejects(save(moved, m.settingsVersion, "g", m.name), "unit_locked");
    const used = await newStock(manager, "En receta", "kg");
    await newProduct(manager, tacos.id, {
      recipe: [{ stockId: used, quantity: "1" }],
    });
    const u = (
      await run(manager, (tx) => listStockItems(tx, manager))
    ).items.find((i) => i.id === used)!;
    await rejects(save(used, u.settingsVersion, "g", u.name), "unit_locked");
    await rejects(
      save(randomUUID(), 0, "kg", u.name.toUpperCase()),
      "duplicate_name",
    );
  });

  await test("a stock item used in a recipe cannot be archived", async () => {
    const used = await newStock(manager, "Archivar", "kg", "2");
    const product = await newProduct(manager, tacos.id, {
      recipe: [{ stockId: used, quantity: "1" }],
    });
    const item = (
      await run(manager, (tx) => listStockItems(tx, manager))
    ).items.find((i) => i.id === used)!;
    assert.deepEqual(item.usedBy.products, [product.name.es]);
    await rejects(
      run(manager, (tx) =>
        archiveStockItem(tx, manager, {
          operationId: op(),
          id: used,
          expectedVersion: item.settingsVersion,
          archived: true,
        }),
      ),
      "stock_in_use",
    );
    await run(manager, (tx) =>
      archiveProduct(tx, manager, {
        operationId: op(),
        id: product.id,
        expectedVersion: product.version,
        archived: true,
      }),
    );
    const archived = await run(manager, (tx) =>
      archiveStockItem(tx, manager, {
        operationId: op(),
        id: used,
        expectedVersion: item.settingsVersion,
        archived: true,
      }),
    );
    assert.equal(archived.archived, true);
    await rejects(
      newProduct(manager, tacos.id, {
        recipe: [{ stockId: used, quantity: "1" }],
      }),
      "invalid_recipe",
    );
  });

  await test("an opening quantity writes exactly one opening movement", async () => {
    const stockId = await newStock(manager, "Apertura", "l", "7.25");
    const moves = await run(
      manager,
      (tx) =>
        tx`select cause,quantity::text as q,balance_after::text as b,reason from stock_movements where stock_id=${stockId}`,
    );
    assert.equal(moves.length, 1);
    assert.equal(moves[0].cause, "opening");
    assert.equal(Number(moves[0].q), 7.25);
    assert.equal(Number(moves[0].b), 7.25);
    assert.equal(moves[0].reason, "Existencia inicial");
    const none = await newStock(manager, "Sin apertura", "l", "0");
    assert.equal(
      (
        await run(
          manager,
          (tx) => tx`select id from stock_movements where stock_id=${none}`,
        )
      ).length,
      0,
    );
  });

  await test("DB-5: concurrent rounds with opposite line order never deadlock", async () => {
    const [x, y] = [
      await newStock(manager, "Orden A", "piece", "1000"),
      await newStock(manager, "Orden B", "piece", "1000"),
    ];
    const px = await newProduct(manager, tacos.id, {
      recipe: [{ stockId: x, quantity: "1" }],
    });
    const py = await newProduct(manager, tacos.id, {
      recipe: [{ stockId: y, quantity: "1" }],
    });
    let first = await order(cashier, orderBody([{ productId: px.id }]));
    let second = await order(cashier, orderBody([{ productId: py.id }]));
    const deadlocks = async () =>
      Number(
        (
          await admin`select deadlocks from pg_stat_database where datname=current_database()`
        )[0].deadlocks,
      );
    const before = await deadlocks();
    for (let i = 0; i < 20; i++) {
      const results = await Promise.allSettled([
        run(cashier, (tx) =>
          addRound(tx, cashier, first.id, {
            ...orderBody([{ productId: px.id }, { productId: py.id }]),
            expectedVersion: first.version,
          }),
        ),
        run(cashier, (tx) =>
          addRound(tx, cashier, second.id, {
            ...orderBody([{ productId: py.id }, { productId: px.id }]),
            expectedVersion: second.version,
          }),
        ),
      ]);
      for (const r of results)
        assert.equal(
          r.status,
          "fulfilled",
          r.status === "rejected" ? String(r.reason) : "",
        );
      [first, second] = results.map(
        (r) => (r as PromiseFulfilledResult<Order>).value,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(
      await deadlocks(),
      before,
      "no deadlock was resolved by a retry",
    );
    assert.deepEqual(await drift(), []);
  });

  await test("tenant() retries one deadlocked transaction, then reports concurrent_update", async () => {
    const [x, y] = [
      await newStock(manager, "Bloqueo A", "piece"),
      await newStock(manager, "Bloqueo B", "piece"),
    ];
    let attempts = 0;
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const crossing = (firstId: string, secondId: string) =>
      tenant(sql, a.tenantId, async (tx) => {
        attempts++;
        await tx`select id from stock_items where id=${firstId} for update`;
        if (++arrived === 2) release();
        await barrier;
        await tx`select id from stock_items where id=${secondId} for update`;
        return true;
      });
    const both = await Promise.allSettled([crossing(x, y), crossing(y, x)]);
    assert.deepEqual(
      both.map((r) => r.status),
      ["fulfilled", "fulfilled"],
    );
    assert.equal(attempts, 3, "exactly one transaction was retried");
    let forced = 0;
    await rejects(
      tenant(sql, a.tenantId, async () => {
        forced++;
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      }),
      "concurrent_update",
    );
    assert.equal(forced, 2);
  });

  await test("menu editor payload lists archived records and the stock options", async () => {
    const editor = await run(owner, (tx) => menuEditor(tx, owner));
    assert.equal(editor.plan, "pro");
    assert.equal(editor.policy, "allow");
    assert(editor.products.some((p) => p.archived));
    assert(editor.categories.some((c) => c.archived));
    assert(editor.stockItems.some((i) => i.archived));
    assert(editor.revision > 0);
  });

  console.log(`${checks} menu checks passed`);
} finally {
  await sql.end();
  await admin.end();
}
