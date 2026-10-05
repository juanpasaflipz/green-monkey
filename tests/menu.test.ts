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
import { decimalInput, moneyInput } from "../src/features/menu/format";
import {
  MENU_POLL_MS,
  MENU_REFRESH_EVENT,
  menuBaseline,
  watchMenuRevision,
} from "../src/features/menu/freshness";

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
  });

  it("an ambiguous comma is rejected instead of guessed", () => {
    for (const text of [
      "25,50",
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
