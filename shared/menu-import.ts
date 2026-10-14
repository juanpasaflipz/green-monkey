/**
 * «Importar menú de POS Lite» (docs/MENU.md): one restaurant's whole pos-lite menu as Green Monkey
 * categories, products, reusable modifier groups and each product's group links. Pure: the export
 * file's schema (scripts/menu/poslite-menu-export.sql emits it) and the plan the owner reviews and
 * the server commits (server/menu-import.ts recomputes it from the file; a client plan is never
 * trusted). The older name/price/category import (shared/import.ts) is separate and unchanged.
 *
 * pos-lite semantics (read-only inspection of pos-lite's schema, docs/MENU.md):
 * - prices are NUMERIC(10,2) pesos, IVA included, as Green Monkey's; a modifier's
 *   `price_adjustment` is the option's price.
 * - groups are reusable and attach per item through menu_item_modifier_groups (sort_order);
 *   `required`, `min_selections` and `max_selections` live on the group; selection_type is
 *   'single' or 'multi'.
 * - kitchen/bar comes from ai_category_roles.role (free text); without one, from the category's
 *   name (menu_categories.printer_target defaults to "kitchen" and pos-lite never reads it).
 *
 * Every Green Monkey rule is the editor's own: names, descriptions, prices and group shapes are
 * checked with shared/menu-schema.ts's input schemas (productInput, groupInput) and the limits of
 * shared/menu.ts, so an imported record is one the editor could save.
 */
import { z } from "zod";
import { currencyExponent, minor } from "./domain.js";
import { MENU_LIMITS } from "./menu.js";
import { groupInput, productInput } from "./menu-schema.js";
import { matchKey } from "./media-import.js";

export const MENU_IMPORT_SOURCE = "pos-lite-menu";
export type Station = "kitchen" | "bar";

const legacyId = z.union([z.string().trim().min(1).max(64), z.number().int().min(0)]);
const pesos = z.union([z.string().max(32), z.number()]);
const text = z.string().max(2000).nullable().optional();
const sortOrder = z.number().int().nullable().optional();

// Unknown keys are dropped (.strip(), as the sales-history file): a newer export may carry more
// columns (image_url, prep time), and nothing the plan does not name can reach a stored row.
const posLiteCategory = z
  .object({
    id: legacyId,
    name: z.string().max(2000),
    sortOrder,
    active: z.boolean().nullable().optional(),
    role: text,
    printerTarget: text,
  })
  .strip();
const posLiteItem = z
  .object({
    id: legacyId,
    categoryId: legacyId,
    name: z.string().max(2000),
    nameEn: text,
    price: pesos,
    description: text,
    descriptionEn: text,
    sortOrder,
  })
  .strip();
const posLiteModifier = z
  .object({ id: legacyId, name: z.string().max(2000), price: pesos, sortOrder })
  .strip();
const posLiteGroup = z
  .object({
    id: legacyId,
    name: z.string().max(2000),
    selectionType: z.string().max(40).nullable().optional(),
    required: z.boolean().nullable().optional(),
    min: z.number().int().nullable().optional(),
    max: z.number().int().nullable().optional(),
    sortOrder,
    modifiers: z.array(posLiteModifier).max(1000).default([]),
  })
  .strip();
const count = z.number().int().min(0).default(0);
/** The export file (one JSON document). */
export const menuImportFile = z
  .object({
    source: z.literal(MENU_IMPORT_SOURCE),
    sourceTenantId: z.string().min(1).max(100),
    sourceName: z.string().max(200).nullable().optional(),
    targetTenantId: z.string().uuid(),
    exportedAt: z
      .string()
      .min(10)
      .max(40)
      .refine((v) => !Number.isNaN(Date.parse(v))),
    currency: z.string().regex(/^[A-Z]{3}$/),
    summary: z
      .object({
        categories: count,
        items: count,
        groups: count,
        modifiers: count,
        itemGroups: count,
        virtualBrands: count,
        combos: count,
      })
      .strip(),
    categories: z.array(posLiteCategory).max(1000),
    items: z.array(posLiteItem).max(10_000),
    groups: z.array(posLiteGroup).max(1000),
    itemGroups: z
      .array(z.object({ itemId: legacyId, groupId: legacyId, sortOrder }).strip())
      .max(20_000),
  })
  .strip();
export type MenuImportFile = z.infer<typeof menuImportFile>;

/** Not blocking: shown on the preview and kept in the import report. */
export type MenuImportWarningCode =
  | "min_ignored"
  | "max_zero"
  | "max_clamped"
  | "empty_group"
  | "inactive_category"
  | "duplicate_category_name"
  | "virtual_brands_not_imported"
  | "combos_not_imported"
  | "photos_separate";
/** Blocking: the commit is refused while any is present. */
export type MenuImportErrorCode =
  | "currency"
  | "duplicate_id"
  | "category_name"
  | "product_name"
  | "group_name"
  | "option_name"
  | "description_too_long"
  | "description_forbidden"
  | "invalid_money"
  | "unknown_category"
  | "unknown_group"
  | "unknown_item"
  | "selection_type"
  | "group_unsatisfiable"
  | "duplicate_option"
  | "too_many_groups"
  | "too_many_choices"
  | "limit_categories"
  | "limit_products"
  | "limit_groups"
  | "limit_options";
export type MenuImportEntity = "file" | "category" | "product" | "group" | "option" | "link";
export type MenuImportIssue<C extends string> = {
  code: C;
  entity: MenuImportEntity;
  /** The pos-lite id of the record (a link names its item). */
  ref?: string;
  /** Its pos-lite name, as written in the file (cut to 120 characters). */
  name?: string;
  /** A count or limit (max_clamped: the source value; limits: the limit). */
  from?: number;
  to?: number;
};
export type MenuImportWarning = MenuImportIssue<MenuImportWarningCode>;
export type MenuImportError = MenuImportIssue<MenuImportErrorCode>;

export type PlannedCategory = {
  legacyId: string;
  name: { es: string; en: string };
  position: number;
  station: Station;
  inactiveInSource: boolean;
};
export type PlannedOption = { legacyId: string; name: string; price: number };
export type PlannedGroup = {
  legacyId: string;
  name: string;
  min: number;
  max: number;
  repeat: false;
  options: PlannedOption[];
};
export type PlannedProduct = {
  legacyId: string;
  categoryLegacyId: string;
  name: { es: string; en: string };
  description?: { es: string; en: string };
  price: number;
  station: Station;
  position: number;
  groupLegacyIds: string[];
};
export type MenuImportPlan = {
  source: typeof MENU_IMPORT_SOURCE;
  sourceTenantId: string;
  sourceName: string | null;
  targetTenantId: string;
  exportedAt: string;
  currency: string;
  categories: PlannedCategory[];
  groups: PlannedGroup[];
  products: PlannedProduct[];
  counts: {
    categories: number;
    products: number;
    groups: number;
    options: number;
    links: number;
    skippedGroups: number;
  };
  /** Σ product prices + Σ option prices, minor units: the owner compares it with pos-lite. */
  priceControlTotal: number;
  warnings: MenuImportWarning[];
  errors: MenuImportError[];
};
export type MenuImportOptions = {
  /** Per pos-lite category id: the owner's Estación choice on the preview. */
  stations?: Record<string, Station>;
};

/** A bar role ("Bar", "Bebidas", "drinks") sends the category to the bar. */
const BAR_ROLE = /bar|bebida|drink/i;
/** With no role, a drinks name ("Bebidas", "Cervezas", "Drinks", "Bar") does, as a whole word. */
const BAR_NAME = /\b(bebidas?|drinks?|bar|cervezas?|beers?)\b/i;
const unaccented = (v: string) => v.normalize("NFD").replace(/\p{M}/gu, "");
const shortName = (v: string) => v.trim().slice(0, 120);
const nonEmpty = (v: string | null | undefined) => (v ?? "").trim();
/** sort_order nulls last, then the file's order (the export already orders by sort_order, id). */
function ordered<T extends { sortOrder?: number | null }>(rows: T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        (a.row.sortOrder ?? Number.MAX_SAFE_INTEGER) -
          (b.row.sortOrder ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
    )
    .map((x) => x.row);
}
/** Placeholder uuids so the editor's input schemas can check a record before it has ids. */
const placeholder = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const operation = placeholder(0);

/**
 * Default station of a pos-lite category. Its role decides when it has one (a bar role → the
 * bar, any other → the kitchen). Without a role, a printer named "bar" or a drinks name sends it
 * to the bar. printer_target "kitchen" says nothing: it is pos-lite's column default (a
 * "Bebidas" category carries it too) and pos-lite's code never reads it.
 */
export function defaultStation(c: {
  name?: string | null;
  role?: string | null;
  printerTarget?: string | null;
}): Station {
  const role = (c.role ?? "").trim();
  if (role) return BAR_ROLE.test(role) ? "bar" : "kitchen";
  if ((c.printerTarget ?? "").trim().toLowerCase() === "bar") return "bar";
  return BAR_NAME.test(unaccented(c.name ?? "")) ? "bar" : "kitchen";
}

/**
 * The pos-lite group → a Green Monkey group's min/max (repeat is always off: pos-lite never
 * chose one option twice). Required → at least one; not required → optional. Single → one;
 * multi → the source max (0 = unlimited in pos-lite: every option). Max never above the options
 * or 30 choices, and never below the min.
 */
export function mapGroupRule(
  g: { required?: boolean | null; min?: number | null; max?: number | null; selectionType?: string | null },
  options: number,
): { min: number; max: number; warnings: { code: MenuImportWarningCode; from?: number; to?: number }[] } {
  const warnings: { code: MenuImportWarningCode; from?: number; to?: number }[] = [];
  const srcMin = g.min ?? 0;
  const min = g.required ? Math.max(1, srcMin) : 0;
  if (!g.required && srcMin > 0) warnings.push({ code: "min_ignored", from: srcMin, to: 0 });
  let max: number;
  if (g.selectionType === "multi") {
    const srcMax = g.max ?? 0;
    max = srcMax > 0 ? srcMax : options;
    if (srcMax <= 0) warnings.push({ code: "max_zero", from: srcMax, to: options });
  } else max = 1;
  const clamped = Math.min(max, options, MENU_LIMITS.choicesPerLine);
  if (clamped !== max) warnings.push({ code: "max_clamped", from: max, to: clamped });
  return { min, max: Math.max(clamped, min, 1), warnings };
}

/** Pesos text → minor units with the editor's money rule; null when it is not a valid amount. */
function moneyOf(v: string | number, exponent: number): number | null {
  try {
    return minor(typeof v === "number" ? String(v) : v.trim(), exponent);
  } catch {
    return null;
  }
}

/**
 * The plan: what committing this file would create, its warnings and its blocking errors.
 * Groups without an active option are skipped (and their links dropped).
 */
export function planMenuImport(file: MenuImportFile, opts: MenuImportOptions = {}): MenuImportPlan {
  const warnings: MenuImportWarning[] = [];
  const errors: MenuImportError[] = [];
  let exponent = 2;
  try {
    exponent = currencyExponent(file.currency);
  } catch {
    exponent = -1;
  }
  // pos-lite stores 2 decimals: a currency with another exponent would round its prices.
  if (exponent !== 2) errors.push({ code: "currency", entity: "file", name: file.currency });
  const money = (v: string | number) => (exponent === 2 ? moneyOf(v, exponent) : null);
  const duplicates = (entity: MenuImportEntity, ids: string[]) => {
    const seen = new Set<string>();
    for (const ref of ids) {
      if (seen.has(ref)) errors.push({ code: "duplicate_id", entity, ref });
      seen.add(ref);
    }
  };
  duplicates("category", file.categories.map((c) => String(c.id)));
  duplicates("product", file.items.map((i) => String(i.id)));
  duplicates("group", file.groups.map((g) => String(g.id)));
  duplicates("option", file.groups.flatMap((g) => g.modifiers.map((m) => String(m.id))));
  duplicates("link", file.itemGroups.map((l) => `${l.itemId}:${l.groupId}`));
  const limit = (code: MenuImportErrorCode, entity: MenuImportEntity, n: number, max: number) => {
    if (n > max) errors.push({ code, entity, from: n, to: max });
  };
  limit("limit_categories", "category", file.categories.length, MENU_LIMITS.categories);
  limit("limit_products", "product", file.items.length, MENU_LIMITS.products);

  // Categories, in pos-lite's order.
  const usedCategories = new Set(file.items.map((i) => String(i.categoryId)));
  const names = new Map<string, string>();
  const categories: PlannedCategory[] = ordered(file.categories).map((c, index) => {
    const ref = String(c.id);
    const es = c.name.trim();
    // The editor's categoryInput (bilingual): 80, so an imported name stays editable.
    if (!es || es.length > 80)
      errors.push({ code: "category_name", entity: "category", ref, name: shortName(c.name) });
    const key = es.toLocaleLowerCase("es-MX");
    if (names.has(key))
      warnings.push({ code: "duplicate_category_name", entity: "category", ref, name: shortName(es) });
    else names.set(key, ref);
    const inactive = c.active === false;
    if (inactive && usedCategories.has(ref))
      warnings.push({ code: "inactive_category", entity: "category", ref, name: shortName(es) });
    return {
      legacyId: ref,
      name: { es, en: es },
      position: index + 1,
      station: opts.stations?.[ref] ?? defaultStation(c),
      inactiveInSource: inactive,
    };
  });

  // Groups: the editor's group schema checks names, options, duplicates and min/max.
  const groups: PlannedGroup[] = [];
  const skipped = new Set<string>();
  let n = 1;
  for (const g of ordered(file.groups)) {
    const ref = String(g.id);
    const name = g.name.trim();
    if (!g.modifiers.length) {
      skipped.add(ref);
      warnings.push({ code: "empty_group", entity: "group", ref, name: shortName(name) });
      continue;
    }
    if (g.selectionType !== "single" && g.selectionType !== "multi")
      errors.push({ code: "selection_type", entity: "group", ref, name: shortName(name) });
    const rule = mapGroupRule(g, g.modifiers.length);
    for (const w of rule.warnings) warnings.push({ ...w, entity: "group", ref, name: shortName(name) });
    const options = ordered(g.modifiers).map((m) => {
      const price = money(m.price);
      if (price === null)
        errors.push({ code: "invalid_money", entity: "option", ref: String(m.id), name: shortName(m.name) });
      return { legacyId: String(m.id), name: m.name.trim(), price: price ?? 0 };
    });
    if (options.length > MENU_LIMITS.optionsPerGroup)
      errors.push({
        code: "limit_options",
        entity: "group",
        ref,
        name: shortName(name),
        from: options.length,
        to: MENU_LIMITS.optionsPerGroup,
      });
    const checked = groupInput.safeParse({
      operationId: operation,
      id: placeholder(n++),
      expectedVersion: 0,
      name: { es: name, en: "" },
      min: rule.min,
      max: rule.max,
      repeat: false,
      options: options.map((o) => ({ id: placeholder(n++), name: { es: o.name, en: "" }, price: o.price })),
    });
    if (!checked.success) {
      const seen = new Set<string>();
      for (const issue of checked.error.issues) {
        const [field, index, sub] = issue.path;
        const option = typeof index === "number" ? options[index] : undefined;
        // Too many options: already reported above, with the count and the limit.
        if (field === "options" && !option) continue;
        const e: MenuImportError =
          field === "name"
            ? { code: "group_name", entity: "group", ref, name: shortName(name) }
            : field === "options" && option && sub === "name"
              ? {
                  code: issue.message === "duplicate" ? "duplicate_option" : "option_name",
                  entity: "option",
                  ref: option.legacyId,
                  name: shortName(option.name),
                }
              : field === "min" || field === "max"
                  ? { code: "group_unsatisfiable", entity: "group", ref, name: shortName(name), from: rule.min, to: g.modifiers.length }
                  : { code: "invalid_money", entity: "option", ref: option?.legacyId ?? ref, name: shortName(option?.name ?? name) };
        const k = `${e.code}:${e.ref}`;
        // A price the money rule already refused, or one issue reported twice, is listed once.
        if (seen.has(k) || (e.code === "invalid_money" && errors.some((x) => x.code === e.code && x.ref === e.ref))) continue;
        seen.add(k);
        errors.push(e);
      }
    }
    groups.push({ legacyId: ref, name, min: rule.min, max: rule.max, repeat: false, options });
  }
  limit("limit_groups", "group", groups.length, MENU_LIMITS.groups);
  const groupById = new Map(groups.map((g) => [g.legacyId, g]));
  const knownGroups = new Set(file.groups.map((g) => String(g.id)));
  const knownItems = new Set(file.items.map((i) => String(i.id)));
  for (const l of file.itemGroups) {
    if (!knownItems.has(String(l.itemId)))
      errors.push({ code: "unknown_item", entity: "link", ref: String(l.itemId) });
    if (!knownGroups.has(String(l.groupId)))
      errors.push({ code: "unknown_group", entity: "link", ref: String(l.itemId), name: String(l.groupId) });
  }

  // Products, per category in pos-lite's order.
  const categoryById = new Map(categories.map((c) => [c.legacyId, c]));
  const positions = new Map<string, number>();
  const products: PlannedProduct[] = [];
  for (const item of ordered(file.items)) {
    const ref = String(item.id);
    const categoryRef = String(item.categoryId);
    const category = categoryById.get(categoryRef);
    const name = { es: item.name.trim(), en: nonEmpty(item.nameEn) || item.name.trim() };
    if (!category)
      errors.push({ code: "unknown_category", entity: "product", ref, name: shortName(name.es) });
    const price = money(item.price);
    if (price === null)
      errors.push({ code: "invalid_money", entity: "product", ref, name: shortName(name.es) });
    const descEs = nonEmpty(item.description);
    const descEn = nonEmpty(item.descriptionEn) || descEs;
    const description = descEs || descEn ? { es: descEs, en: descEn } : undefined;
    const links = ordered(file.itemGroups.filter((l) => String(l.itemId) === ref));
    const groupLegacyIds = [...new Set(links.map((l) => String(l.groupId)))].filter(
      (id) => groupById.has(id) && !skipped.has(id),
    );
    const linked = groupLegacyIds.map((id) => groupById.get(id)!);
    const checked = productInput.safeParse({
      operationId: operation,
      id: placeholder(1),
      expectedVersion: 0,
      name,
      categoryId: placeholder(2),
      price: price ?? 0,
      station: "kitchen",
      groupIds: linked.map((_, i) => placeholder(10 + i)),
      ...(description ? { description } : {}),
    });
    if (!checked.success)
      for (const issue of checked.error.issues) {
        const field = issue.path[0];
        const code: MenuImportErrorCode =
          field === "name"
            ? "product_name"
            : field === "description"
              ? issue.message === "forbidden"
                ? "description_forbidden"
                : "description_too_long"
              : field === "groupIds"
                ? "too_many_groups"
                : "invalid_money";
        if (!errors.some((e) => e.code === code && e.entity === "product" && e.ref === ref))
          errors.push({ code, entity: "product", ref, name: shortName(name.es) });
      }
    const choices = linked.reduce((a, g) => a + g.max, 0);
    if (choices > MENU_LIMITS.choicesPerLine)
      errors.push({
        code: "too_many_choices",
        entity: "product",
        ref,
        name: shortName(name.es),
        from: choices,
        to: MENU_LIMITS.choicesPerLine,
      });
    const position = (positions.get(categoryRef) ?? 0) + 1;
    positions.set(categoryRef, position);
    products.push({
      legacyId: ref,
      categoryLegacyId: categoryRef,
      name,
      ...(description ? { description } : {}),
      price: price ?? 0,
      station: category?.station ?? "kitchen",
      position,
      groupLegacyIds,
    });
  }

  if (file.summary.virtualBrands > 0)
    warnings.push({ code: "virtual_brands_not_imported", entity: "file", from: file.summary.virtualBrands });
  if (file.summary.combos > 0)
    warnings.push({ code: "combos_not_imported", entity: "file", from: file.summary.combos });
  warnings.push({ code: "photos_separate", entity: "file" });

  const options = groups.reduce((a, g) => a + g.options.length, 0);
  return {
    source: MENU_IMPORT_SOURCE,
    sourceTenantId: file.sourceTenantId,
    sourceName: file.sourceName ?? null,
    targetTenantId: file.targetTenantId,
    exportedAt: new Date(file.exportedAt).toISOString(),
    currency: file.currency,
    categories,
    groups,
    products,
    counts: {
      categories: categories.length,
      products: products.length,
      groups: groups.length,
      options,
      links: products.reduce((a, p) => a + p.groupLegacyIds.length, 0),
      skippedGroups: skipped.size,
    },
    priceControlTotal:
      products.reduce((a, p) => a + p.price, 0) +
      groups.reduce((a, g) => a + g.options.reduce((b, o) => b + o.price, 0), 0),
    warnings,
    errors,
  };
}

/** Accents, case and spacing ignored: the key existing-name clashes compare. */
export const productNameKey = matchKey;

/** POST /api/menu/import/preview: the plan plus what the restaurant already has. */
export type MenuImportPreview = MenuImportPlan & {
  /** sha256 of the canonical file the server parsed; the commit sends it back. */
  fileHash: string;
  alreadyImported: boolean;
  /** Active products whose Spanish name equals an imported one (accents and case ignored). */
  existingNameClashes: { legacyId: string; name: string; productId: string }[];
};
export type MenuImportResult = {
  batchId: string;
  replayed: boolean;
  counts: MenuImportPlan["counts"] & { categoriesReused: number };
  priceControlTotal: number;
};
/** POST /api/menu/import/commit. `file` is re-validated with menuImportFile on the server. */
export const menuImportCommitInput = z
  .object({
    file: z.unknown(),
    stations: z.record(z.string().max(64), z.enum(["kitchen", "bar"])).default({}),
    fileHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
