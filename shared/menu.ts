// Menu rules shared by the server, the POS and QR/kiosk ordering. Pure leaf:
// only type imports from ./domain.js, so domain.ts can import these helpers.
import { Decimal } from "decimal.js";
import type { Group, Label, Option, Product } from "./domain.js";

export type RecipeLine = { stockId: string; quantity: string };
export type NegativeStockPolicy = "allow" | "block";
export type MenuIssue =
  | "forbidden"
  | "invalid_amount"
  | "open_amount_exceeds"
  | "invalid_modifier"
  | "required_modifier";

/** Per-restaurant size limits (D12); exceeding one returns menu_limit. */
export const MENU_LIMITS = {
  categories: 100,
  products: 2000,
  groups: 300,
  optionsPerGroup: 50,
  groupsPerProduct: 12,
  choicesPerLine: 30,
  areas: 30,
  tables: 300,
  tablesPerBatch: 50,
  stockItems: 2000,
  recipeLines: 30,
} as const;

/** Tapping the product must open the picker (any group, or an open price). */
export function pickerNeeded(p: Product): boolean {
  return p.groups.length > 0 || !!p.openAmount;
}

/** A product can be added: available, not archived, and every required group
 * still has enough available choices. */
export function orderable(p: Product): boolean {
  return (
    p.available &&
    !p.archived &&
    p.groups.every(
      (g) =>
        g.min <= 0 ||
        g.options.filter((o) => o.available).length >= (g.repeat ? 1 : g.min),
    )
  );
}

/** Option id → how many times it was chosen. */
export function selectionCounts(options: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const o of options) counts.set(o, (counts.get(o) ?? 0) + 1);
  return counts;
}

/** Chosen options in group order, then option order; count > 0 only. */
export function chosenOptions(
  p: Product,
  options: string[],
): { group: Group; option: Option; count: number }[] {
  const counts = selectionCounts(options);
  return p.groups.flatMap((group) =>
    group.options
      .filter((option) => counts.has(option.id))
      .map((option) => ({ group, option, count: counts.get(option.id)! })),
  );
}

/** Expands picker counts into the line's options, in group/option order. */
export function expandSelection(
  p: Product,
  counts: ReadonlyMap<string, number>,
): string[] {
  return p.groups.flatMap((g) =>
    g.options.flatMap((o) =>
      Array.from({ length: Math.max(0, counts.get(o.id) ?? 0) }, () => o.id),
    ),
  );
}

/** First reason a selection cannot be sold, in the order quote() reports it. */
export function selectionIssue(
  p: Product,
  options: string[],
  openAmount: number | undefined,
  canOpen: boolean,
): MenuIssue | null {
  if (openAmount !== undefined && (!p.openAmount || !canOpen))
    return "forbidden";
  if (p.openAmount && (openAmount === undefined || openAmount <= 0))
    return "invalid_amount";
  if (
    p.openAmount &&
    p.openMax != null &&
    openAmount !== undefined &&
    openAmount > p.openMax
  )
    return "open_amount_exceeds";
  const counts = selectionCounts(options);
  for (const [optionId, count] of counts) {
    const group = p.groups.find((g) =>
      g.options.some((o) => o.id === optionId),
    );
    const option = group?.options.find((o) => o.id === optionId);
    if (!group || !option || !option.available) return "invalid_modifier";
    if (count > 1 && !group.repeat) return "invalid_modifier";
  }
  for (const g of p.groups) {
    const n = g.options.reduce((a, o) => a + (counts.get(o.id) ?? 0), 0);
    if (n < g.min || n > g.max) return "required_modifier";
  }
  return null;
}

/** Product recipe plus every chosen option's recipe × count, one line per
 * stock item. Returns the product recipe unchanged when no chosen option has a
 * recipe, so persisted recipes of plain lines stay byte-identical. */
export function mergeRecipes(
  base: RecipeLine[] | undefined,
  chosen: { option: Option; count: number }[],
): RecipeLine[] {
  const extra = chosen.filter((c) => c.option.recipe?.length);
  if (!extra.length) return base ?? [];
  const totals = new Map<string, Decimal>();
  const add = (stockId: string, quantity: Decimal) =>
    totals.set(stockId, (totals.get(stockId) ?? new Decimal(0)).add(quantity));
  for (const line of base ?? []) add(line.stockId, new Decimal(line.quantity));
  for (const { option, count } of extra)
    for (const line of option.recipe!)
      add(line.stockId, new Decimal(line.quantity).mul(count));
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([stockId, quantity]) => ({ stockId, quantity: quantity.toFixed() }));
}

/** "2× Asada" when an option was chosen more than once. */
export function optionLabel(name: Label, count: number): Label {
  return count > 1
    ? { es: `${count}× ${name.es}`, en: `${count}× ${name.en}` }
    : name;
}

/** Every stock item touched by these lines, unique and sorted (lock order). */
export function recipeStockIds(lines: { recipe?: RecipeLine[] }[]): string[] {
  return [
    ...new Set(lines.flatMap((l) => (l.recipe ?? []).map((r) => r.stockId))),
  ].sort();
}

export function groupRuleParts(g: Pick<Group, "min" | "max" | "repeat">): {
  kind: "required" | "optional";
  min: number;
  max: number;
  repeat: boolean;
} {
  return {
    kind: g.min > 0 ? "required" : "optional",
    min: g.min,
    max: g.max,
    repeat: !!g.repeat,
  };
}

// Response shapes of the menu, floor and stock-item routes.
export type MenuCategory = {
  id: string;
  name: Label;
  position: number;
  version: number;
  archived: boolean;
  productCount: number;
};
export type MenuGroup = Group & {
  version: number;
  archived: boolean;
  usedBy: string[];
};
export type MenuStockOption = {
  id: string;
  name: string;
  unit: string;
  kind: string;
  archived: boolean;
};
export type MenuEditorPayload = {
  categories: MenuCategory[];
  products: Product[];
  groups: MenuGroup[];
  stockItems: MenuStockOption[];
  policy: NegativeStockPolicy;
  plan: "free" | "pro";
  revision: number;
};
export type DiningArea = {
  id: string;
  name: string;
  position: number;
  version: number;
  archived: boolean;
};
export type DiningTable = {
  id: string;
  name: string;
  areaId: string | null;
  seats: number | null;
  position: number;
  version: number;
  archived: boolean;
  open: boolean;
  /** In use only by a pending QR order (public ordering 032), not a check. */
  pendingQr?: true;
};
export type StockItem = {
  id: string;
  name: string;
  unit: string;
  kind: string;
  threshold: string;
  parLevel: string | null;
  onHand: string;
  negativeSince: string | null;
  settingsVersion: number;
  archived: boolean;
  hasMovements: boolean;
  usedBy: { products: string[]; options: string[] };
};
export type StockMovement = {
  id: string;
  quantity: string;
  balanceAfter: string | null;
  cause: string;
  causeId: string;
  reason: string;
  actorName: string | null;
  createdAt: string;
};
