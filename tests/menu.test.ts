import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  DomainError,
  quote,
  type Group,
  type LineInput,
  type Option,
  type Product,
} from "../shared/domain";
import {
  chosenOptions,
  expandSelection,
  mergeRecipes,
  optionLabel,
  orderable,
  pickerNeeded,
  recipeStockIds,
  selectionCounts,
  selectionIssue,
} from "../shared/menu";
import {
  groupInput,
  productInput,
  stockItemInput,
  tablesBulkInput,
} from "../shared/menu-schema";
import {
  decimalInput,
  moneyFormatter,
  moneyInput,
  savedAmount,
} from "../src/features/menu/format";
import {
  MENU_POLL_MS,
  MENU_REFRESH_EVENT,
  PUBLIC_MENU_POLL,
  advanceBaseline,
  menuBaseline,
  watchMenuRevision,
} from "../src/features/menu/freshness";
import { CATALOG_ERRORS, priceCart } from "../src/features/menu/cart";
import {
  withOptionAvailable,
  withProductAvailable,
} from "../src/features/menu/availability";
import type { MenuEditorPayload, MenuGroup } from "../shared/menu";
import { assertProductFiscalAllowed } from "../server/fiscal.js";
import type { Tx } from "../server/db.js";
import { translateError } from "../src/i18n";

const tortilla = "00000000-0000-4000-8000-0000000000a1";
const queso = "00000000-0000-4000-8000-0000000000a2";
const option = (
  es: string,
  price = 0,
  extra: Partial<Option> = {},
): Option => ({
  id: randomUUID(),
  name: { es, en: es },
  price,
  available: true,
  ...extra,
});
const salsa: Group = {
  id: randomUUID(),
  name: { es: "Salsa", en: "Salsa" },
  min: 1,
  max: 1,
  options: [option("Verde"), option("Roja")],
};
const extras: Group = {
  id: randomUUID(),
  name: { es: "Extras", en: "Extras" },
  min: 0,
  max: 2,
  options: [
    option("Queso", 1500, {
      cost: 400,
      recipe: [{ stockId: queso, quantity: "0.03" }],
    }),
    option("Aguacate", 2000),
  ],
};
const taco: Product = {
  id: randomUUID(),
  name: { es: "Taco al pastor", en: "Al pastor taco" },
  category: { es: "Tacos", en: "Tacos" },
  categoryId: randomUUID(),
  price: 2500,
  available: true,
  station: "kitchen",
  groups: [salsa, extras],
  recipe: [{ stockId: tortilla, quantity: "1" }],
  cost: 900,
  version: 3,
  kind: "item",
};
const line = (
  p: Product,
  options: string[] = [],
  extra: Partial<LineInput> = {},
): LineInput => ({
  id: randomUUID(),
  productId: p.id,
  quantity: 1,
  options,
  note: "",
  ...extra,
});
const code = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as DomainError).code;
  }
};
const varios: Product = {
  ...taco,
  id: randomUUID(),
  name: { es: "Varios", en: "Misc." },
  price: 0,
  openAmount: true,
  openMax: 50000,
  groups: [],
  recipe: [],
  cost: null,
};
const combo: Product = {
  ...taco,
  id: randomUUID(),
  name: { es: "Combo", en: "Combo" },
  kind: "combo",
  price: 11000,
  recipe: [],
  groups: [
    {
      id: randomUUID(),
      name: { es: "Tacos", en: "Tacos" },
      min: 3,
      max: 3,
      repeat: true,
      options: [
        option("Hongos", 0, { recipe: [{ stockId: tortilla, quantity: "1" }] }),
        option("Asada", 500, {
          recipe: [{ stockId: tortilla, quantity: "1" }],
        }),
      ],
    },
    {
      id: randomUUID(),
      name: { es: "Bebida", en: "Drink" },
      min: 1,
      max: 1,
      options: [option("Jamaica"), option("Limonada")],
    },
  ],
};

describe("menu picker and pricing", () => {
  it("FIT-4: pickerNeeded is true for optional-only groups and open-price products", () => {
    expect(pickerNeeded({ ...taco, groups: [extras] })).toBe(true);
    expect(pickerNeeded(varios)).toBe(true);
    expect(pickerNeeded({ ...taco, groups: [] })).toBe(false);
  });

  it("quote accepts a line that skips an optional group and prices chosen extras", () => {
    const plain = quote([line(taco, [salsa.options[0].id])], [taco]);
    expect(plain[0].unitPrice).toBe(2500);
    const rich = quote(
      [
        line(taco, [
          salsa.options[1].id,
          extras.options[0].id,
          extras.options[1].id,
        ]),
      ],
      [taco],
    );
    expect(rich[0].unitPrice).toBe(2500 + 1500 + 2000);
    expect(rich[0].optionNames.map((n) => n.es)).toEqual([
      "Roja",
      "Queso",
      "Aguacate",
    ]);
  });

  it("quote enforces min and max per group (required_modifier)", () => {
    expect(code(() => quote([line(taco)], [taco]))).toBe("required_modifier");
    expect(
      code(() =>
        quote([line(taco, [salsa.options[0].id, salsa.options[1].id])], [taco]),
      ),
    ).toBe("required_modifier");
  });

  it("repeatable groups count repeated choices; non-repeatable duplicates are invalid_modifier", () => {
    const [hongos, asada] = combo.groups[0].options;
    const jamaica = combo.groups[1].options[0].id;
    const ok = quote(
      [line(combo, [asada.id, hongos.id, asada.id, jamaica])],
      [combo],
    );
    expect(ok[0].unitPrice).toBe(11000 + 2 * 500);
    expect(
      code(() => quote([line(combo, [asada.id, asada.id, jamaica])], [combo])),
    ).toBe("required_modifier");
    expect(
      code(() =>
        quote([line(taco, [salsa.options[0].id, salsa.options[0].id])], [taco]),
      ),
    ).toBe("invalid_modifier");
  });

  it("optionNames follow group then option order and prefix repeat counts", () => {
    const [hongos, asada] = combo.groups[0].options;
    const limonada = combo.groups[1].options[1].id;
    const [l] = quote(
      [line(combo, [limonada, asada.id, hongos.id, hongos.id])],
      [combo],
    );
    expect(l.optionNames.map((n) => n.es)).toEqual([
      "2× Hongos",
      "Asada",
      "Limonada",
    ]);
    expect(optionLabel({ es: "Asada", en: "Asada" }, 1)).toEqual({
      es: "Asada",
      en: "Asada",
    });
  });

  it("option recipes merge into one recipe line per stock item", () => {
    const [hongos, asada] = combo.groups[0].options;
    const jamaica = combo.groups[1].options[0].id;
    const [l] = quote(
      [line(combo, [hongos.id, asada.id, asada.id, jamaica])],
      [{ ...combo, recipe: [{ stockId: queso, quantity: "0.010" }] }],
    );
    expect(l.recipe).toEqual([
      { stockId: tortilla, quantity: "3" },
      { stockId: queso, quantity: "0.01" },
    ]);
    const withQueso = quote(
      [line(taco, [salsa.options[0].id, extras.options[0].id])],
      [taco],
    )[0];
    expect(withQueso.recipe).toEqual([
      { stockId: tortilla, quantity: "1" },
      { stockId: queso, quantity: "0.03" },
    ]);
  });

  it("lines without option recipes keep the product recipe byte-identical", () => {
    const recipe = [
      { stockId: queso, quantity: "0.500000" },
      { stockId: tortilla, quantity: "2" },
    ];
    const p = { ...taco, recipe };
    const [l] = quote(
      [line(p, [salsa.options[0].id, extras.options[1].id])],
      [p],
    );
    expect(l.recipe).toBe(recipe);
    expect(JSON.stringify(l.recipe)).toBe(JSON.stringify(recipe));
    expect(mergeRecipes(undefined, [])).toEqual([]);
  });

  it("line cost adds option costs only when the product has a cost", () => {
    const ids = [salsa.options[0].id, extras.options[0].id];
    expect(quote([line(taco, ids)], [taco])[0].cost).toBe(900 + 400);
    expect(quote([line(taco, ids)], [{ ...taco, cost: null }])[0].cost).toBe(
      null,
    );
  });

  it("open price: amount within ceiling, ceiling exceeded, missing, zero, public channel forbidden", () => {
    const [ok] = quote(
      [line(varios, [], { openAmount: 12000 })],
      [varios],
      true,
    );
    expect(ok.unitPrice).toBe(12000);
    expect(ok.openAmount).toBe(12000);
    expect(
      code(() =>
        quote([line(varios, [], { openAmount: 50001 })], [varios], true),
      ),
    ).toBe("open_amount_exceeds");
    expect(code(() => quote([line(varios)], [varios], true))).toBe(
      "invalid_amount",
    );
    expect(
      code(() => quote([line(varios, [], { openAmount: 0 })], [varios], true)),
    ).toBe("invalid_amount");
    expect(
      code(() =>
        quote([line(varios, [], { openAmount: 12000 })], [varios], false),
      ),
    ).toBe("forbidden");
    expect(
      code(() =>
        quote(
          [line(taco, [salsa.options[0].id], { openAmount: 100 })],
          [taco],
          true,
        ),
      ),
    ).toBe("forbidden");
  });

  it("archived products are unavailable", () => {
    expect(
      code(() =>
        quote(
          [line(taco, [salsa.options[0].id])],
          [{ ...taco, archived: true }],
        ),
      ),
    ).toBe("unavailable");
    expect(orderable({ ...taco, archived: true })).toBe(false);
  });

  it("selectionIssue agrees with quote for every generated selection", () => {
    const repeatGroup: Group = {
      id: randomUUID(),
      name: { es: "Tacos", en: "Tacos" },
      min: 1,
      max: 3,
      repeat: true,
      options: [option("A"), option("B"), option("C", 0, { available: false })],
    };
    const single: Group = {
      id: randomUUID(),
      name: { es: "Bebida", en: "Drink" },
      min: 0,
      max: 1,
      options: [option("X"), option("Y")],
    };
    const p: Product = { ...taco, groups: [repeatGroup, single] };
    const ids = [...repeatGroup.options, ...single.options].map((o) => o.id);
    let checked = 0;
    const counts = (n: number): number[][] =>
      n === 0
        ? [[]]
        : counts(n - 1).flatMap((rest) =>
            [0, 1, 2, 3].map((c) => [c, ...rest]),
          );
    for (const combination of counts(ids.length)) {
      const options = combination.flatMap((c, i) =>
        Array.from({ length: c }, () => ids[i]),
      );
      const issue = selectionIssue(p, options, undefined, false);
      expect(
        code(() => quote([line(p, options)], [p])),
        options.join(),
      ).toBe(issue);
      checked++;
    }
    expect(checked).toBe(4 ** ids.length);
  });

  it("orderable is false when a required group has no available choices", () => {
    expect(orderable(taco)).toBe(true);
    const soldOut = {
      ...taco,
      groups: [
        {
          ...salsa,
          options: salsa.options.map((o) => ({ ...o, available: false })),
        },
        extras,
      ],
    };
    expect(orderable(soldOut)).toBe(false);
    const optionalSoldOut = {
      ...taco,
      groups: [
        salsa,
        {
          ...extras,
          options: extras.options.map((o) => ({ ...o, available: false })),
        },
      ],
    };
    expect(orderable(optionalSoldOut)).toBe(true);
    expect(orderable({ ...taco, available: false })).toBe(false);
  });

  it("DB-5: recipeStockIds returns unique ids sorted across all lines", () => {
    const a = "00000000-0000-4000-8000-00000000000a",
      b = "00000000-0000-4000-8000-00000000000b",
      c = "00000000-0000-4000-8000-00000000000c";
    expect(
      recipeStockIds([
        {
          recipe: [
            { stockId: c, quantity: "1" },
            { stockId: a, quantity: "1" },
          ],
        },
        {
          recipe: [
            { stockId: b, quantity: "1" },
            { stockId: c, quantity: "2" },
          ],
        },
        {},
      ]),
    ).toEqual([a, b, c]);
  });

  it("ModifierPicker selection expands counts in group/option order", () => {
    const [hongos, asada] = combo.groups[0].options;
    const jamaica = combo.groups[1].options[0].id;
    const counts = new Map([
      [jamaica, 1],
      [asada.id, 2],
      [hongos.id, 1],
    ]);
    expect(expandSelection(combo, counts)).toEqual([
      hongos.id,
      asada.id,
      asada.id,
      jamaica,
    ]);
    expect(selectionCounts(expandSelection(combo, counts))).toEqual(
      new Map([
        [hongos.id, 1],
        [asada.id, 2],
        [jamaica, 1],
      ]),
    );
    expect(
      chosenOptions(combo, [jamaica, asada.id]).map((c) => c.count),
    ).toEqual([1, 1]);
  });
});

describe("menu input schemas", () => {
  const base = {
    operationId: randomUUID(),
    id: randomUUID(),
    expectedVersion: 0,
    name: { es: " Taco ", en: "" },
    categoryId: randomUUID(),
    price: 2500,
    station: "kitchen",
  };
  it("productInput: open price needs openMax and zero price; English name defaults to Spanish", () => {
    const p = productInput.parse(base);
    expect(p.name).toEqual({ es: "Taco", en: "Taco" });
    expect(p.kind).toBe("item");
    expect(p.groupIds).toEqual([]);
    expect(
      productInput.safeParse({ ...base, openAmount: true, price: 0 }).success,
    ).toBe(false);
    expect(
      productInput.safeParse({
        ...base,
        openAmount: true,
        price: 100,
        openMax: 500,
      }).success,
    ).toBe(false);
    expect(
      productInput.safeParse({
        ...base,
        openAmount: true,
        price: 0,
        openMax: 500,
      }).success,
    ).toBe(true);
    expect(productInput.safeParse({ ...base, openMax: 500 }).success).toBe(
      false,
    );
    expect(productInput.safeParse({ ...base, extra: 1 }).success).toBe(false);
    const dup = randomUUID();
    expect(
      productInput.safeParse({ ...base, groupIds: [dup, dup] }).success,
    ).toBe(false);
  });

  it("groupInput rejects min > max, max above choice count without repeat, duplicate ids and names", () => {
    const g = {
      operationId: randomUUID(),
      id: randomUUID(),
      expectedVersion: 0,
      name: { es: "Salsa" },
      min: 1,
      max: 1,
      options: [
        { id: randomUUID(), name: { es: "Verde" }, price: 0 },
        { id: randomUUID(), name: { es: "Roja" }, price: 0 },
      ],
    };
    expect(groupInput.safeParse(g).success).toBe(true);
    expect(groupInput.safeParse({ ...g, min: 2 }).success).toBe(false);
    expect(groupInput.safeParse({ ...g, max: 3 }).success).toBe(false);
    expect(groupInput.safeParse({ ...g, max: 3, repeat: true }).success).toBe(
      true,
    );
    expect(
      groupInput.safeParse({
        ...g,
        options: [g.options[0], { ...g.options[1], id: g.options[0].id }],
      }).success,
    ).toBe(false);
    expect(
      groupInput.safeParse({
        ...g,
        options: [g.options[0], { ...g.options[1], name: { es: "VERDE" } }],
      }).success,
    ).toBe(false);
    expect(
      groupInput.safeParse({
        ...g,
        options: [{ ...g.options[0], price: -100 }, g.options[1]],
      }).success,
    ).toBe(false);
  });

  it("tablesBulkInput limits a batch to 50 tables", () => {
    const b = { operationId: randomUUID(), areaId: null, from: 1, to: 50 };
    expect(tablesBulkInput.parse(b).prefix).toBe("Mesa");
    expect(tablesBulkInput.safeParse({ ...b, to: 51 }).success).toBe(false);
    expect(tablesBulkInput.safeParse({ ...b, from: 5, to: 4 }).success).toBe(
      false,
    );
  });
});

describe("menu number entry (es-MX thousands separator)", () => {
  it('a thousands comma never becomes a decimal point: "1,200" is $1,200.00, not $1.20', () => {
    expect(moneyInput("1,200", 2)).toBe(120000);
    expect(moneyInput(" 1,450 ", 2)).toBe(145000);
    expect(moneyInput("12,500.50", 2)).toBe(1250050);
    expect(moneyInput("1,000,000", 2)).toBe(100000000);
    expect(moneyInput("25.50", 2)).toBe(2550);
    expect(moneyInput("1200", 2)).toBe(120000);
    expect(moneyInput("1,200", 0)).toBe(1200);
    // The review's cases: a Parrillada at "1,250" and "1,250.50".
    expect(moneyInput("1,250", 2)).toBe(125000);
    expect(moneyInput("1,250.50", 2)).toBe(125050);
    expect(moneyInput("1,250.5", 2)).toBe(125050);
  });

  it("more decimals than the currency has are rejected, not rounded", () => {
    // "1.250" is how a dot-thousands habit would type $1,250: never $1.25.
    for (const text of ["12.505", "1.250", "1,250.505", "0.001"])
      expect(() => moneyInput(text, 2), text).toThrow(DomainError);
    expect(() => moneyInput("1.5", 0)).toThrow(DomainError);
    expect(moneyInput("12.50", 2)).toBe(1250);
    expect(moneyInput("12.5", 2)).toBe(1250);
    expect(moneyInput("15", 0)).toBe(15);
  });

  it("the editors show how a typed amount will be saved", () => {
    const format = moneyFormatter("es", "MXN");
    expect(savedAmount("1,250", 2, format)).toBe(format(125000));
    expect(savedAmount("1,250", 2, format)).toMatch(/1,250\.00/);
    expect(savedAmount("12,5", 2, format)).toBeNull();
    expect(savedAmount("45,50", 2, format)).toBeNull();
    expect(savedAmount("12.505", 2, format)).toBeNull();
    expect(savedAmount("  ", 2, format)).toBeNull();
  });

  it("an ambiguous comma is rejected instead of guessed", () => {
    for (const text of [
      "25,50",
      "45,50",
      "12,5",
      "1,20",
      "1,2000",
      ",500",
      "1,",
      "1.200,50",
      "",
      "abc",
      "-5",
    ])
      expect(() => moneyInput(text, 2), text).toThrow(DomainError);
    expect(decimalInput("25,50")).toBeNull();
    expect(decimalInput("1,20")).toBeNull();
  });

  it('recipe and stock quantities keep their magnitude: "1,000" g stays 1000 g', () => {
    expect(decimalInput("1,000")).toBe("1000");
    expect(decimalInput("2,500.125")).toBe("2500.125");
    expect(decimalInput("0.03")).toBe("0.03");
    const stock = {
      operationId: randomUUID(),
      id: randomUUID(),
      expectedVersion: 0,
      name: "Harina",
      unit: "g",
      kind: "raw",
      threshold: decimalInput("1,000"),
      parLevel: decimalInput("5,000"),
      openingQuantity: decimalInput("1,000"),
    };
    expect(stockItemInput.parse(stock).openingQuantity).toBe("1000");
    // A malformed value stays as typed in the dialog, so the schema flags it.
    expect(
      stockItemInput.safeParse({ ...stock, openingQuantity: "1,5" }).success,
    ).toBe(false);
  });
});

describe("FOH-8: POS catalog freshness", () => {
  afterEach(() => vi.useRealTimers());
  class FakeDocument extends EventTarget {
    visibilityState: DocumentVisibilityState = "visible";
  }
  function harness(start: number | null = 7) {
    vi.useFakeTimers();
    const server = {
      revision: 7,
      catalog: [{ id: "v1" }] as unknown as Product[],
    };
    const calls = { revision: 0, catalog: 0 };
    const applied: Product[][] = [];
    let known = start;
    const win = new EventTarget(),
      doc = new FakeDocument();
    const stop = watchMenuRevision({
      revision: async () => (calls.revision++, server.revision),
      catalog: async () => (calls.catalog++, server.catalog),
      apply: (c) => void applied.push(c),
      baseline: { get: () => known, set: (r) => void (known = r) },
      win,
      doc,
    });
    return { server, calls, applied, win, doc, stop, known: () => known };
  }
  const settle = () => vi.advanceTimersByTimeAsync(0);

  it("an unchanged revision does not refetch; a changed one refetches and applies the catalog", async () => {
    const h = harness();
    await settle();
    expect(h.calls).toEqual({ revision: 1, catalog: 0 });
    h.server.revision = 8;
    h.server.catalog = [{ id: "v2" }] as unknown as Product[];
    await vi.advanceTimersByTimeAsync(MENU_POLL_MS - 1);
    expect(h.calls.revision).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toEqual({ revision: 2, catalog: 1 });
    expect(h.applied).toEqual([h.server.catalog]);
    expect(h.known()).toBe(8);
    await vi.advanceTimersByTimeAsync(MENU_POLL_MS);
    expect(h.calls).toEqual({ revision: 3, catalog: 1 });
    h.stop();
  });

  it("MENU-12: the first check of a scope refetches once, so a change between the catalog load and the first poll is not missed", async () => {
    const h = harness(null);
    await settle();
    expect(h.calls).toEqual({ revision: 1, catalog: 1 });
    expect(h.known()).toBe(7);
    await vi.advanceTimersByTimeAsync(MENU_POLL_MS);
    expect(h.calls.catalog).toBe(1);
    h.stop();
  });

  it("focus and visibilitychange check at once only while visible; gm-menu-refresh refetches without asking", async () => {
    const h = harness();
    await settle();
    h.server.revision = 9;
    h.doc.visibilityState = "hidden";
    h.doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(h.calls).toEqual({ revision: 1, catalog: 0 });
    h.doc.visibilityState = "visible";
    h.doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(h.calls).toEqual({ revision: 2, catalog: 1 });
    h.server.revision = 10;
    h.win.dispatchEvent(new Event("focus"));
    await settle();
    expect(h.calls).toEqual({ revision: 3, catalog: 2 });
    h.win.dispatchEvent(new Event(MENU_REFRESH_EVENT));
    await settle();
    expect(h.calls).toEqual({ revision: 3, catalog: 3 });
    expect(h.applied).toHaveLength(3);
    h.stop();
  });

  it("a failed refetch keeps the old baseline so the next tick retries; errors never escape", async () => {
    vi.useFakeTimers();
    let known: number | null = 1;
    let fail = true;
    const applied: unknown[] = [];
    const stop = watchMenuRevision({
      revision: async () => 2,
      catalog: async () => {
        if (fail) throw new Error("network");
        return [];
      },
      apply: (c) => void applied.push(c),
      baseline: { get: () => known, set: (r) => void (known = r) },
      win: new EventTarget(),
      doc: new FakeDocument(),
    });
    await settle();
    expect(known).toBe(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(MENU_POLL_MS);
    expect(known).toBe(2);
    expect(applied).toHaveLength(1);
    stop();
  });

  it("after cleanup nothing is polled, listened to or applied, even a response already in flight", async () => {
    vi.useFakeTimers();
    let release!: (n: number) => void;
    const applied: unknown[] = [];
    let revisions = 0;
    const win = new EventTarget(),
      doc = new FakeDocument();
    const stop = watchMenuRevision({
      revision: () => (revisions++, new Promise<number>((r) => (release = r))),
      catalog: async () => [],
      apply: (c) => void applied.push(c),
      baseline: { get: () => 1, set: () => {} },
      win,
      doc,
    });
    stop();
    release(2);
    await settle();
    win.dispatchEvent(new Event("focus"));
    win.dispatchEvent(new Event(MENU_REFRESH_EVENT));
    await vi.advanceTimersByTimeAsync(MENU_POLL_MS * 3);
    expect(revisions).toBe(1);
    expect(applied).toEqual([]);
  });

  it("baselines are kept per session scope", () => {
    const a = menuBaseline("tenant-a:device:employee"),
      b = menuBaseline("tenant-b:device:employee");
    a.set(4);
    expect(menuBaseline("tenant-a:device:employee").get()).toBe(4);
    expect(b.get()).toBeNull();
  });
});

describe("OWNER-6/OWNER-2: per-line cart pricing after a catalog refresh", () => {
  const brownie: Product = {
    ...taco,
    id: randomUUID(),
    name: { es: "Brownie", en: "Brownie" },
    price: 4500,
    groups: [],
    recipe: [],
    cost: null,
  };
  const withSalsa = line(taco, [salsa.options[0].id]);
  const plain = line(brownie);

  it("a product 86'd or archived while in the cart flags only its line; the rest still prices", () => {
    const fine = priceCart([withSalsa, plain], [taco, brownie], true);
    expect(fine.blocked).toBe(false);
    expect(fine.lines.map((l) => l.error)).toEqual([null, null]);
    expect(fine.total).toBe(2500 + 4500);
    // The same lines priced together and one by one agree.
    expect(fine.lines.map((l) => l.priced)).toEqual(
      quote([withSalsa, plain], [taco, brownie], true),
    );

    const soldOut = { ...brownie, available: false };
    const after86 = priceCart([withSalsa, plain], [taco, soldOut], true);
    expect(after86.blocked).toBe(true);
    expect(after86.lines[0].priced?.total).toBe(2500);
    expect(after86.lines[1]).toEqual({
      input: plain,
      priced: null,
      error: "unavailable",
    });
    expect(after86.total).toBe(2500);
    // The old all-or-nothing quote threw, which blanked the whole cart.
    expect(code(() => quote([withSalsa, plain], [taco, soldOut], true))).toBe(
      "unavailable",
    );

    const archived = priceCart([withSalsa, plain], [taco], true);
    expect(archived.lines.map((l) => l.error)).toEqual([null, "unavailable"]);
  });

  it("a chosen option that sold out flags its line as invalid_modifier, a catalog error", () => {
    const verde = salsa.options[0];
    const soldOutSalsa: Group = {
      ...salsa,
      options: salsa.options.map((o) =>
        o.id === verde.id ? { ...o, available: false } : o,
      ),
    };
    const cart = priceCart(
      [withSalsa, plain],
      [{ ...taco, groups: [soldOutSalsa, extras] }, brownie],
      true,
    );
    expect(cart.lines.map((l) => l.error)).toEqual(["invalid_modifier", null]);
    expect(cart.total).toBe(4500);
    for (const e of ["unavailable", "invalid_modifier", "required_modifier"])
      expect(CATALOG_ERRORS.has(e)).toBe(true);
    expect(CATALOG_ERRORS.has("insufficient_stock")).toBe(false);
  });

  it("an empty cart is not blocked and costs nothing", () => {
    expect(priceCart([], [taco], true)).toEqual({
      lines: [],
      total: 0,
      blocked: false,
    });
  });
});

describe("OWNER-4: availability shows in the menu list at once", () => {
  const groupOf = (g: Group): MenuGroup => ({
    ...g,
    version: 1,
    archived: false,
    usedBy: [taco.id],
  });
  const payload = (): MenuEditorPayload => ({
    categories: [],
    products: [taco, varios],
    groups: [groupOf(salsa), groupOf(extras)],
    stockItems: [],
    policy: "allow",
    plan: "pro",
    revision: 1,
  });

  it("a product switch patches that product only", () => {
    const before = payload();
    const after = withProductAvailable(before, taco.id, false);
    expect(after.products.find((p) => p.id === taco.id)?.available).toBe(false);
    expect(after.products[1]).toBe(before.products[1]);
    expect(before.products[0].available).toBe(true);
  });

  it("a choice switch patches the group card and every product compiled with it", () => {
    const aguacate = extras.options[1];
    const before = payload();
    const after = withOptionAvailable(before, extras.id, aguacate.id, false);
    const card = after.groups.find((g) => g.id === extras.id)!;
    expect(card.options.map((o) => o.available)).toEqual([true, false]);
    expect(card.usedBy).toEqual([taco.id]);
    const compiled = after.products
      .find((p) => p.id === taco.id)!
      .groups.find((g) => g.id === extras.id)!;
    expect(compiled.options.find((o) => o.id === aguacate.id)?.available).toBe(
      false,
    );
    // Untouched: the other group, products without the group, the input.
    expect(after.groups.find((g) => g.id === salsa.id)).toBe(
      before.groups.find((g) => g.id === salsa.id),
    );
    expect(after.products.find((p) => p.id === varios.id)).toBe(
      before.products.find((p) => p.id === varios.id),
    );
    expect(extras.options[1].available).toBe(true);
  });
});

describe("OWNER-2: QR/kiosk catalog freshness", () => {
  afterEach(() => vi.useRealTimers());
  it("the same watcher keeps the public catalog payload fresh from its revision", async () => {
    vi.useFakeTimers();
    type Payload = { revision: number; catalog: { id: string }[] };
    const server: Payload = { revision: 3, catalog: [{ id: "taco" }] };
    let known: number | null = 3;
    const applied: Payload[] = [];
    let fetched = 0;
    const win = new EventTarget();
    const stop = watchMenuRevision<Payload>({
      revision: async () => server.revision,
      catalog: async () => (fetched++, { ...server }),
      apply: (d) => void applied.push(d),
      baseline: { get: () => known, set: (r) => void (known = r) },
      win,
      doc: Object.assign(new EventTarget(), {
        visibilityState: "visible" as DocumentVisibilityState,
      }),
    });
    await vi.advanceTimersByTimeAsync(0);
    // Seeded from the revision served with the catalog: no extra fetch.
    expect(fetched).toBe(0);
    server.revision = 4;
    server.catalog = [];
    await vi.advanceTimersByTimeAsync(MENU_POLL_MS);
    expect(applied).toEqual([{ revision: 4, catalog: [] }]);
    expect(known).toBe(4);
    // A kiosk reset or a catalog error refetches without asking.
    win.dispatchEvent(new Event(MENU_REFRESH_EVENT));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetched).toBe(2);
    stop();
  });
});

describe("MENU-R1: QR/kiosk polls spare the venue's shared request budget", () => {
  afterEach(() => vi.useRealTimers());
  class Doc extends EventTarget {
    visibilityState: DocumentVisibilityState = "visible";
  }
  function publicHarness(random: () => number) {
    vi.useFakeTimers();
    const server = { revision: 1 };
    const calls = { revision: 0, catalog: 0 };
    let known: number | null = 1;
    let on = true;
    const win = new EventTarget(),
      doc = new Doc();
    const stop = watchMenuRevision<{ revision: number }>({
      revision: async () => (calls.revision++, server.revision),
      catalog: async () => (calls.catalog++, { ...server }),
      apply: () => {},
      baseline: { get: () => known, set: (r) => void (known = r) },
      win,
      doc,
      ...PUBLIC_MENU_POLL,
      active: () => on,
      random,
    });
    const setActive = (value: boolean) => void (on = value);
    return { server, calls, win, doc, stop, setActive };
  }

  it("a change still shows within a minute, and pages poll at spread times", async () => {
    expect(PUBLIC_MENU_POLL.jitter).toBeGreaterThan(0);
    expect(PUBLIC_MENU_POLL.jitter).toBeLessThanOrEqual(MENU_POLL_MS / 2);
    // random() = 1 takes the whole jitter off the wait; 0 takes nothing.
    const early = publicHarness(() => 0.999999);
    await vi.advanceTimersByTimeAsync(0);
    expect(early.calls.revision).toBe(1);
    await vi.advanceTimersByTimeAsync(
      MENU_POLL_MS - PUBLIC_MENU_POLL.jitter - 1,
    );
    expect(early.calls.revision).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(early.calls.revision).toBe(2);
    early.stop();
    const late = publicHarness(() => 0);
    await vi.advanceTimersByTimeAsync(MENU_POLL_MS - 1);
    expect(late.calls.revision).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(late.calls.revision).toBe(2);
    late.stop();
  });

  it("a hidden page or one showing its sent order does not poll; the refresh event still refetches", async () => {
    const h = publicHarness(() => 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual({ revision: 1, catalog: 0 });
    h.setActive(false);
    h.server.revision = 2;
    await vi.advanceTimersByTimeAsync(MENU_POLL_MS * 5);
    h.win.dispatchEvent(new Event("focus"));
    h.doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual({ revision: 1, catalog: 0 });
    // A kiosk reset refetches even before the page counts as active again.
    h.win.dispatchEvent(new Event(MENU_REFRESH_EVENT));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual({ revision: 1, catalog: 1 });
    h.setActive(true);
    await vi.advanceTimersByTimeAsync(MENU_POLL_MS);
    expect(h.calls.revision).toBe(2);
    h.stop();
  });

  it("focus and visibilitychange bursts collapse into one check per gap", async () => {
    const h = publicHarness(() => 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.revision).toBe(1);
    // Switching back to the tab fires both events; both fall in the gap of
    // the start check.
    h.doc.dispatchEvent(new Event("visibilitychange"));
    h.win.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.revision).toBe(1);
    await vi.advanceTimersByTimeAsync(PUBLIC_MENU_POLL.minGap);
    h.doc.dispatchEvent(new Event("visibilitychange"));
    h.win.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.revision).toBe(2);
    // Many app switches in a minute stay within the server's poll budget.
    for (let i = 0; i < 60; i++) {
      h.win.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(h.calls.revision).toBeLessThanOrEqual(
      2 + Math.ceil(60_000 / PUBLIC_MENU_POLL.minGap) + 1,
    );
    h.stop();
  });

  it("the baseline only moves forward, and only on a known revision", () => {
    const ref = { current: null as number | null };
    advanceBaseline(ref, undefined);
    expect(ref.current).toBeNull();
    advanceBaseline(ref, 5);
    expect(ref.current).toBe(5);
    // A poll read before a later catalog payload never moves it back.
    advanceBaseline(ref, 4);
    expect(ref.current).toBe(5);
    advanceBaseline(ref, 6);
    expect(ref.current).toBe(6);
  });
});

// The rule only: that archiveProduct applies it when (and only when) an archived product is
// restored is covered on the real path by menu-db "LD-28: restoring an archived IVA 8%
// product needs a border region…" (border allowed, general refused and still archived).
describe("LD-28: the fiscal product rate rule a restore reuses (restore wiring: menu-db LD-28 leg)", () => {
  /** A transaction whose only statement reads the fiscal profile (fiscalContext). */
  const profile = (region: string | null) =>
    (async () =>
      region
        ? [{ tax_region: region, default_tax_category: "iva16" }]
        : []) as unknown as Tx;

  it("IVA 8% needs a border region; other rates and products without a fiscal value restore anywhere", async () => {
    for (const region of ["general", null])
      await expect(
        assertProductFiscalAllowed(profile(region), { taxCategory: "iva8" }),
      ).rejects.toMatchObject({
        code: "fiscal_border_rate_not_allowed",
        status: 400,
      });
    for (const region of ["border_north", "border_south"])
      await expect(
        assertProductFiscalAllowed(profile(region), { taxCategory: "iva8" }),
      ).resolves.toBeUndefined();
    for (const fiscal of [
      undefined,
      {},
      { taxCategory: "iva16" },
      { taxCategory: "default" },
      { taxCategory: "iva0", satProductKey: "50201708", satUnitKey: null },
    ])
      await expect(
        assertProductFiscalAllowed(profile("general"), fiscal),
      ).resolves.toBeUndefined();
  });

  it("the refusal a manager sees on «Restaurar» has Spanish and English copy", () => {
    expect(translateError("fiscal_border_rate_not_allowed", "es")).toBe(
      "El IVA 8% solo se puede usar si la sucursal está en región fronteriza.",
    );
    expect(translateError("fiscal_border_rate_not_allowed", "en")).toBe(
      "8% VAT can only be used when the location is in a border region.",
    );
  });
});

describe("the product editor after a photo change (KF-SECURITY-2, KF-SECURITY-3)", () => {
  it("adopts the photo's version only when the photo was the one change since the editor opened; otherwise keeps its own, so «Guardar» and «Archivar» meet menu_changed", async () => {
    const { versionAfterPhoto } = await import(
      "../src/features/menu/ProductEditor"
    );
    // 7 → the photo → 8: the editor's form is the product but for the photo.
    expect(versionAfterPhoto(7, 8)).toEqual({ version: 8, changed: false });
    // Another device saved 7 → 8, then the photo 8 → 9: the form still holds 7's fields.
    expect(versionAfterPhoto(7, 9)).toEqual({ version: 7, changed: true });
    expect(versionAfterPhoto(7, 12)).toEqual({ version: 7, changed: true });
    // Two photo changes in one editor: each is one step from the version the editor follows.
    const first = versionAfterPhoto(7, 8);
    expect(versionAfterPhoto(first.version, 9)).toEqual({
      version: 9,
      changed: false,
    });
  });
});
