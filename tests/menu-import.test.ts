// «Importar menú de POS Lite»: the export file's schema and the pure plan (categories, reusable
// groups, products and their links), its warnings and its blocking errors, against the fictional
// fixture (tests/fixtures/pos-lite-menu.json; no real pos-lite data).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MENU_IMPORT_SOURCE,
  defaultStation,
  mapGroupRule,
  menuImportCommitInput,
  menuImportFile,
  planMenuImport,
  type MenuImportFile,
  type MenuImportPlan,
} from "../shared/menu-import";
import { MENU_LIMITS } from "../shared/menu";

const raw = JSON.parse(
  readFileSync(new URL("./fixtures/pos-lite-menu.json", import.meta.url), "utf8"),
);
const file = menuImportFile.parse(raw);
const plan = planMenuImport(file);
/** A copy of the fixture with some arrays replaced (the fixture itself is never mutated). */
const variant = (patch: Partial<MenuImportFile>): MenuImportFile => ({
  ...structuredClone(file),
  ...patch,
});
const codes = (issues: MenuImportPlan["errors"] | MenuImportPlan["warnings"]) =>
  issues.map((i) => i.code);
const item = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  categoryId: 11,
  name: `Producto de prueba ${id}`,
  price: "10.00",
  ...extra,
});
const group = (id: number, n: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Grupo de prueba ${id}`,
  selectionType: "multi",
  required: false,
  min: 0,
  max: 1,
  modifiers: Array.from({ length: n }, (_, i) => ({
    id: id * 1000 + i,
    name: `Opción ${i + 1}`,
    price: "1.00",
  })),
  ...extra,
});

describe("pos-lite menu export file", () => {
  it("parses the fixture; refuses another source, a missing currency or a bad target", () => {
    expect(file.source).toBe(MENU_IMPORT_SOURCE);
    expect(file.items).toHaveLength(5);
    expect(menuImportFile.safeParse({ ...raw, source: "pos-lite-sales" }).success).toBe(false);
    const { currency: _c, ...noCurrency } = raw;
    expect(menuImportFile.safeParse(noCurrency).success).toBe(false);
    expect(menuImportFile.safeParse({ ...raw, targetTenantId: "taqueria" }).success).toBe(false);
    expect(menuImportFile.safeParse({ ...raw, exportedAt: "not a date" }).success).toBe(false);
  });

  it("drops any field it does not know (image_url never reaches the plan)", () => {
    const parsed = menuImportFile.parse(raw);
    expect(parsed.items.find((i) => i.id === 201)).not.toHaveProperty("image_url");
    const f = menuImportFile.parse({ ...raw, stray: "x" });
    expect(f).not.toHaveProperty("stray");
  });

  it("accepts string or numeric ids and prices", () => {
    const f = menuImportFile.parse({
      ...raw,
      items: [{ ...raw.items[0], id: "a-101", price: 45 }],
      itemGroups: [],
    });
    expect(planMenuImport(f).products[0]).toMatchObject({ legacyId: "a-101", price: 4500 });
  });
});

describe("planMenuImport: the fixture's mapping", () => {
  it("has no blocking error, and carries the file's identity", () => {
    expect(plan.errors).toEqual([]);
    expect(plan).toMatchObject({
      source: MENU_IMPORT_SOURCE,
      sourceTenantId: "fictional-pos-location",
      sourceName: "Taquería Ficticia",
      targetTenantId: "10000000-0000-4000-8000-000000000001",
      exportedAt: "2026-10-14T12:00:00.000Z",
      currency: "MXN",
    });
  });

  it("orders categories by sort_order (nulls last), copies es to en, and picks a station", () => {
    expect(plan.categories).toEqual([
      { legacyId: "11", name: { es: "Tacos de prueba", en: "Tacos de prueba" }, position: 1, station: "kitchen", inactiveInSource: false },
      { legacyId: "12", name: { es: "Bebidas de ejemplo", en: "Bebidas de ejemplo" }, position: 2, station: "bar", inactiveInSource: false },
      { legacyId: "13", name: { es: "Postres ficticios", en: "Postres ficticios" }, position: 3, station: "kitchen", inactiveInSource: true },
    ]);
  });

  it("station: the role decides; without one, a printer \"bar\" or a drinks name; else the kitchen", () => {
    // A role decides alone, either way.
    expect(defaultStation({ name: "Platos", role: "Bar" })).toBe("bar");
    expect(defaultStation({ name: "Platos", role: "BEBIDAS frías" })).toBe("bar");
    expect(defaultStation({ name: "Platos", role: "drinks" })).toBe("bar");
    expect(defaultStation({ name: "Bebidas", role: "cocina" })).toBe("kitchen");
    // pos-lite's real shape: no role and printer_target "kitchen" everywhere, even on drinks.
    expect(defaultStation({ name: "Bebidas", role: null, printerTarget: "kitchen" })).toBe("bar");
    expect(defaultStation({ name: "Tacos", role: null, printerTarget: "kitchen" })).toBe("kitchen");
    expect(defaultStation({ name: "Tacos", role: "  ", printerTarget: "bar" })).toBe("bar");
    for (const name of ["Bebida", "Drinks", "drink", "Bar", "Cervezas", "cerveza", "Beers", "BÉBIDAS", "Café y bebidas"])
      expect(defaultStation({ name, role: null }), name).toBe("bar");
    // A whole word only: "Barbacoa" or "Embarazo" is not the bar.
    for (const name of ["Barbacoa", "Tacos al pastor", "Postres", ""])
      expect(defaultStation({ name, role: null, printerTarget: "kitchen" }), name).toBe("kitchen");
    expect(defaultStation({})).toBe("kitchen");
  });

  it("the owner's station choice overrides the default, and its products follow it", () => {
    const p = planMenuImport(file, { stations: { "11": "bar", "12": "kitchen" } });
    expect(p.categories.map((c) => c.station)).toEqual(["bar", "kitchen", "kitchen"]);
    expect(p.products.find((x) => x.legacyId === "101")?.station).toBe("bar");
    expect(p.products.find((x) => x.legacyId === "201")?.station).toBe("kitchen");
  });

  it("maps each group's rule, never repeats, orders options, and skips the empty one", () => {
    expect(plan.groups.map((g) => [g.legacyId, g.min, g.max, g.repeat])).toEqual([
      ["21", 0, 1, false], // single, optional
      ["22", 0, 3, false], // multi max 5, clamped to its 3 options
      ["23", 1, 1, false], // single, required
      ["25", 0, 2, false], // multi max 0 → every option
      ["26", 0, 1, false], // optional with min 1 → min ignored
    ]);
    expect(plan.groups.find((g) => g.legacyId === "26")?.options).toEqual([
      { legacyId: "262", name: "Chocolate", price: 800 },
      { legacyId: "261", name: "Cajeta", price: 800 },
    ]);
    expect(plan.groups.find((g) => g.legacyId === "22")?.options.map((o) => o.price)).toEqual([
      1000, 1550, 0,
    ]);
  });

  it("maps products: names, descriptions, centavos, category station, positions and links", () => {
    expect(plan.products).toEqual([
      {
        legacyId: "101", categoryLegacyId: "11",
        name: { es: "Taco de prueba", en: "Test taco" },
        description: { es: "Tortilla de maíz con relleno de ejemplo", en: "Corn tortilla with a sample filling" },
        price: 4500, station: "kitchen", position: 1,
        groupLegacyIds: ["23", "22"], // by the link's sort_order
      },
      {
        legacyId: "201", categoryLegacyId: "12",
        name: { es: "Agua de ejemplo", en: "Sample agua fresca" },
        price: 3000, station: "bar", position: 1, groupLegacyIds: ["25"],
      },
      {
        legacyId: "301", categoryLegacyId: "13",
        name: { es: "Flan ficticio", en: "Fictional flan" },
        description: { es: "", en: "Sample custard" },
        price: 3500, station: "kitchen", position: 1, groupLegacyIds: ["26"],
      },
      {
        legacyId: "102", categoryLegacyId: "11",
        name: { es: "Quesadilla ficticia", en: "Quesadilla ficticia" }, // null name_en
        description: { es: "Queso de ejemplo", en: "Queso de ejemplo" }, // blank en → es
        price: 5250, station: "kitchen", position: 2,
        groupLegacyIds: ["21"], // the empty group's link is dropped
      },
      {
        legacyId: "103", categoryLegacyId: "11",
        name: { es: "Gringa de muestra", en: "Gringa de muestra" }, // blank name_en
        price: 6000, station: "kitchen", position: 3, groupLegacyIds: [],
      },
    ]);
    expect(plan.products.find((p) => p.legacyId === "103")).not.toHaveProperty("description");
    expect(plan.products.find((p) => p.legacyId === "201")).not.toHaveProperty("description");
  });

  it("counts what it would create and the price control total (centavos)", () => {
    expect(plan.counts).toEqual({
      categories: 3, products: 5, groups: 5, options: 11, links: 5, skippedGroups: 1,
    });
    // products 45 + 52.50 + 60 + 30 + 35; options 10 + 15.50 + 5 + 8 + 8.
    expect(plan.priceControlTotal).toBe(22_250 + 4_650);
  });

  it("warns, in order, without blocking", () => {
    expect(plan.warnings).toEqual([
      { code: "inactive_category", entity: "category", ref: "13", name: "Postres ficticios" },
      { code: "max_clamped", entity: "group", ref: "22", name: "Extras de ejemplo", from: 5, to: 3 },
      { code: "empty_group", entity: "group", ref: "24", name: "Grupo vacío" },
      { code: "max_zero", entity: "group", ref: "25", name: "Hielo", from: 0, to: 2 },
      { code: "min_ignored", entity: "group", ref: "26", name: "Toppings de muestra", from: 1, to: 0 },
      { code: "virtual_brands_not_imported", entity: "file", from: 2 },
      { code: "combos_not_imported", entity: "file", from: 1 },
      { code: "photos_separate", entity: "file" },
    ]);
  });

  it("is deterministic and pure (the same file twice → the same plan; the file unchanged)", () => {
    const before = JSON.stringify(file);
    expect(planMenuImport(file)).toEqual(plan);
    expect(JSON.stringify(file)).toBe(before);
  });
});

describe("mapGroupRule", () => {
  it("required → at least one (the source min kept when higher)", () => {
    expect(mapGroupRule({ selectionType: "single", required: true, min: 0, max: 1 }, 3)).toEqual({ min: 1, max: 1, warnings: [] });
    expect(mapGroupRule({ selectionType: "multi", required: true, min: 2, max: 4 }, 5)).toEqual({ min: 2, max: 4, warnings: [] });
  });

  it("not required → optional; a source min > 0 is ignored with a warning", () => {
    expect(mapGroupRule({ selectionType: "multi", required: false, min: 0, max: 5 }, 5)).toEqual({ min: 0, max: 5, warnings: [] });
    expect(mapGroupRule({ selectionType: "single", required: null, min: 1, max: 1 }, 2).warnings).toEqual([
      { code: "min_ignored", from: 1, to: 0 },
    ]);
  });

  it("single → one, whatever the source max", () => {
    expect(mapGroupRule({ selectionType: "single", required: false, min: 0, max: 5 }, 4)).toEqual({ min: 0, max: 1, warnings: [] });
  });

  it("multi with max 0 or none → every option (max_zero)", () => {
    expect(mapGroupRule({ selectionType: "multi", max: 0 }, 4)).toEqual({ min: 0, max: 4, warnings: [{ code: "max_zero", from: 0, to: 4 }] });
    expect(mapGroupRule({ selectionType: "multi", max: null }, 2).max).toBe(2);
  });

  it("max clamped to the options (warned only when it changes) and to 30 choices", () => {
    expect(mapGroupRule({ selectionType: "multi", max: 5 }, 2)).toEqual({ min: 0, max: 2, warnings: [{ code: "max_clamped", from: 5, to: 2 }] });
    expect(mapGroupRule({ selectionType: "multi", max: 2 }, 2).warnings).toEqual([]);
    expect(mapGroupRule({ selectionType: "multi", max: 40 }, 45)).toEqual({
      min: 0, max: MENU_LIMITS.choicesPerLine, warnings: [{ code: "max_clamped", from: 40, to: 30 }],
    });
    expect(mapGroupRule({ selectionType: "multi", max: 0 }, 45).warnings).toEqual([
      { code: "max_zero", from: 0, to: 45 },
      { code: "max_clamped", from: 45, to: 30 },
    ]);
  });

  it("max never below the min (the plan then refuses an unsatisfiable group)", () => {
    expect(mapGroupRule({ selectionType: "multi", required: true, min: 3, max: 5 }, 2)).toMatchObject({ min: 3, max: 3 });
  });
});

describe("planMenuImport: blocking errors", () => {
  it("a currency whose exponent is not 2 is refused (pos-lite stores 2 decimals)", () => {
    const p = planMenuImport(variant({ currency: "JPY" }));
    expect(p.errors[0]).toEqual({ code: "currency", entity: "file", name: "JPY" });
    expect(planMenuImport(variant({ currency: "USD" })).errors).toEqual([]);
  });

  it("duplicate legacy ids: categories, products, groups, options and links", () => {
    const p = planMenuImport(
      variant({
        categories: [...file.categories, { ...file.categories[0] }],
        items: [...file.items, { ...file.items[0] }],
        groups: [...file.groups, { ...file.groups[0], id: 21 }],
        itemGroups: [...file.itemGroups, { ...file.itemGroups[0] }],
      }),
    );
    const dup = p.errors.filter((e) => e.code === "duplicate_id").map((e) => [e.entity, e.ref]);
    expect(dup).toEqual(
      expect.arrayContaining([
        ["category", "11"], ["product", "101"], ["group", "21"], ["option", "211"], ["link", "101:22"],
      ]),
    );
  });

  it("category names: empty or longer than 80 (the editor's limit)", () => {
    const ok = "C".repeat(80);
    const p = planMenuImport(
      variant({
        categories: [
          { ...file.categories[0], name: "   " },
          { ...file.categories[1], name: "C".repeat(81) },
          { ...file.categories[2], name: ok },
        ],
      }),
    );
    expect(p.errors.map((e) => [e.code, e.ref])).toEqual([
      ["category_name", "11"],
      ["category_name", "12"],
    ]);
  });

  it("product names: empty, or es/en longer than 80", () => {
    const p = planMenuImport(
      variant({
        items: [
          { ...file.items[0], name: " " },
          { ...file.items[1], name: "P".repeat(81) },
          { ...file.items[2], nameEn: "E".repeat(81) },
          { ...file.items[3], name: "P".repeat(80) },
        ],
        itemGroups: [],
      }),
    );
    expect(p.errors.map((e) => [e.code, e.ref])).toEqual([
      ["product_name", "101"],
      ["product_name", "102"],
      ["product_name", "103"],
    ]);
  });

  it("group and option names: empty or longer than 80; duplicate options (case-insensitive)", () => {
    const [g21, g22] = file.groups;
    const p = planMenuImport(
      variant({
        groups: [
          { ...g21, name: "" },
          {
            ...g22,
            modifiers: [
              { ...g22.modifiers[0], name: "O".repeat(81) },
              { ...g22.modifiers[1], name: "Aguacate" },
              { ...g22.modifiers[2], name: "  AGUACATE " },
            ],
          },
        ],
        itemGroups: [],
      }),
    );
    expect(p.errors.map((e) => [e.code, e.entity, e.ref])).toEqual([
      ["group_name", "group", "21"],
      ["option_name", "option", "221"],
      ["duplicate_option", "option", "223"],
    ]);
  });

  it("option names with emoji are accepted", () => {
    const g = file.groups[1];
    const p = planMenuImport(
      variant({
        groups: [
          {
            ...g,
            modifiers: [
              { ...g.modifiers[0], name: "🚫 Sin cebolla" },
              { ...g.modifiers[1], name: "✅ Agrega tocino" },
              { ...g.modifiers[2], name: "🌶️ Extra picante" },
            ],
          },
        ],
        itemGroups: [],
      }),
    );
    expect(p.errors).toEqual([]);
    expect(p.groups[0].options.map((o) => o.name)).toEqual([
      "🚫 Sin cebolla", "✅ Agrega tocino", "🌶️ Extra picante",
    ]);
  });

  it("descriptions: longer than 300 (es or en) or with control/bidi characters", () => {
    const p = planMenuImport(
      variant({
        items: [
          { ...file.items[0], description: "D".repeat(301) },
          { ...file.items[1], description: "ok", descriptionEn: "E".repeat(301) },
          { ...file.items[2], description: "Con\u0007campana" },
          { ...file.items[3], description: "Al revés ‮" },
          { ...file.items[4], description: "D".repeat(300), descriptionEn: "Línea 1\nLínea 2" },
        ],
        itemGroups: [],
      }),
    );
    expect(p.errors.map((e) => [e.code, e.ref])).toEqual([
      // In product order (sort_order, then the file's): 101, 201, 301, 102, 103.
      ["description_too_long", "101"],
      ["description_forbidden", "201"],
      ["description_too_long", "102"],
      ["description_forbidden", "103"],
    ]);
  });
});

describe("planMenuImport: blocking errors (money, references, shapes, limits)", () => {
  it("money: negative, not a number, scientific notation or above the money limit", () => {
    const p = planMenuImport(
      variant({
        items: [
          { ...file.items[0], price: "-1.00" },
          { ...file.items[1], price: "abc" },
          { ...file.items[2], price: 1e21 },
          { ...file.items[3], price: "1000000.01" },
          { ...file.items[4], price: "0.00" }, // free is a price
        ],
        groups: [{ ...file.groups[0], modifiers: [{ id: 211, name: "Verde", price: -5 }] }],
        itemGroups: [],
      }),
    );
    expect(p.errors.map((e) => [e.code, e.entity, e.ref])).toEqual([
      ["invalid_money", "option", "211"],
      ["invalid_money", "product", "101"],
      ["invalid_money", "product", "201"],
      ["invalid_money", "product", "102"],
      ["invalid_money", "product", "103"],
    ]);
  });

  it("unknown category, group or item references", () => {
    const p = planMenuImport(
      variant({
        items: [{ ...file.items[0], categoryId: 99 }],
        itemGroups: [
          { itemId: 101, groupId: 98 },
          { itemId: 97, groupId: 21 },
        ],
      }),
    );
    expect(p.errors).toEqual([
      { code: "unknown_group", entity: "link", ref: "101", name: "98" },
      { code: "unknown_item", entity: "link", ref: "97" },
      { code: "unknown_category", entity: "product", ref: "101", name: "Taco de prueba" },
    ]);
    // The unknown group's link is not carried.
    expect(p.products[0].groupLegacyIds).toEqual([]);
  });

  it("a selection type other than single or multi (e.g. pos-lite's never-used 'multiple')", () => {
    const p = planMenuImport(variant({ groups: [{ ...file.groups[0], selectionType: "multiple" }], itemGroups: [] }));
    expect(p.errors).toEqual([{ code: "selection_type", entity: "group", ref: "21", name: "Salsa de prueba" }]);
  });

  it("a required group asking more choices than it has options is unsatisfiable", () => {
    const g = file.groups[0]; // 2 options
    const p = planMenuImport(
      variant({ groups: [{ ...g, selectionType: "multi", required: true, min: 3, max: 3 }], itemGroups: [] }),
    );
    expect(p.errors).toEqual([
      { code: "group_unsatisfiable", entity: "group", ref: "21", name: "Salsa de prueba", from: 3, to: 2 },
    ]);
  });

  it("a product with more than 12 groups, or more than 30 choices across them", () => {
    const groups = Array.from({ length: 13 }, (_, i) => group(500 + i, 2, { selectionType: "single" }));
    const many = planMenuImport(
      variant({
        items: [item(1)],
        groups: groups as MenuImportFile["groups"],
        itemGroups: groups.map((g, i) => ({ itemId: 1, groupId: g.id, sortOrder: i })),
      }),
    );
    expect(codes(many.errors)).toEqual(["too_many_groups"]);
    expect(planMenuImport(variant({
      items: [item(1)],
      groups: groups.slice(0, 12) as MenuImportFile["groups"],
      itemGroups: groups.slice(0, 12).map((g) => ({ itemId: 1, groupId: g.id })),
    })).errors).toEqual([]);

    const big = [group(601, 20, { max: 20 }), group(602, 11, { max: 11 })] as MenuImportFile["groups"];
    const choices = planMenuImport(
      variant({ items: [item(1)], groups: big, itemGroups: big.map((g) => ({ itemId: 1, groupId: g.id })) }),
    );
    expect(choices.errors).toEqual([
      { code: "too_many_choices", entity: "product", ref: "1", name: "Producto de prueba 1", from: 31, to: 30 },
    ]);
  });

  it("MENU_LIMITS: categories, products, groups and options per group", () => {
    const cats = Array.from({ length: MENU_LIMITS.categories + 1 }, (_, i) => ({ id: i + 1, name: `Categoría ${i + 1}` }));
    expect(planMenuImport(variant({ categories: cats, items: [], itemGroups: [] })).errors).toEqual([
      { code: "limit_categories", entity: "category", from: 101, to: 100 },
    ]);
    const items = Array.from({ length: MENU_LIMITS.products + 1 }, (_, i) => item(i + 1));
    expect(codes(planMenuImport(variant({ items, itemGroups: [] })).errors)).toEqual(["limit_products"]);
    const groups = Array.from({ length: MENU_LIMITS.groups + 1 }, (_, i) => group(i + 1, 1));
    expect(planMenuImport(variant({ groups: groups as MenuImportFile["groups"], itemGroups: [] })).errors).toEqual([
      { code: "limit_groups", entity: "group", from: 301, to: 300 },
    ]);
    const wide = [group(700, MENU_LIMITS.optionsPerGroup + 1)] as MenuImportFile["groups"];
    expect(planMenuImport(variant({ groups: wide, itemGroups: [] })).errors).toEqual([
      { code: "limit_options", entity: "group", ref: "700", name: "Grupo de prueba 700", from: 51, to: 50 },
    ]);
    // At the limit, nothing is refused.
    const fifty = [group(701, MENU_LIMITS.optionsPerGroup)] as MenuImportFile["groups"];
    expect(planMenuImport(variant({ groups: fifty, itemGroups: [] })).errors).toEqual([]);
  });
});

describe("menuImportCommitInput", () => {
  it("takes the file, the owner's stations and the file hash; nothing else", () => {
    const hash = "a".repeat(64);
    expect(menuImportCommitInput.parse({ file: raw, fileHash: hash })).toMatchObject({ stations: {}, fileHash: hash });
    expect(menuImportCommitInput.safeParse({ file: raw, fileHash: hash, stations: { "11": "patio" } }).success).toBe(false);
    expect(menuImportCommitInput.safeParse({ file: raw, fileHash: "x" }).success).toBe(false);
    expect(menuImportCommitInput.safeParse({ file: raw, fileHash: hash, plan: {} }).success).toBe(false);
  });
});

describe("planMenuImport: other warnings", () => {
  it("an inactive category warns only when products use it; a repeated category name warns", () => {
    const p = planMenuImport(
      variant({
        categories: [...file.categories, { id: 14, name: "  tacos DE prueba ", active: false }],
        items: file.items.filter((i) => i.categoryId !== 13),
        itemGroups: file.itemGroups.filter((l) => l.itemId !== 301),
      }),
    );
    expect(p.errors).toEqual([]);
    expect(p.warnings.filter((w) => w.entity === "category")).toEqual([
      { code: "duplicate_category_name", entity: "category", ref: "14", name: "tacos DE prueba" },
    ]);
    expect(p.categories.find((c) => c.legacyId === "13")?.inactiveInSource).toBe(true);
  });

  it("no brands or combos → only the photos note", () => {
    const p = planMenuImport(variant({ summary: { ...file.summary, virtualBrands: 0, combos: 0 } }));
    expect(p.warnings.filter((w) => w.entity === "file")).toEqual([{ code: "photos_separate", entity: "file" }]);
  });
});
