import type { StockUnit } from "./fixtures.ts";

// Pack parsing and conversion stay in code. A result of `null` means an operator must enter the stock quantity.

type Dimension = "mass" | "volume" | "count";

const MEASURE_UNITS: Record<string, { dimension: Dimension; toBase: number }> = {
  KG: { dimension: "mass", toBase: 1 },
  G: { dimension: "mass", toBase: 0.001 },
  L: { dimension: "volume", toBase: 1 },
  ML: { dimension: "volume", toBase: 0.001 },
};

const STOCK_DIMENSION: Record<StockUnit, Dimension> = { kg: "mass", L: "volume", pz: "count" };

export interface Pack {
  count: number | null; // Items per purchased unit: C/24, PQ/20, X12
  size: { amount: number; dimension: Dimension; base: number } | null; // Content per item: 20L, 360G
}

export function parsePack(text: string): Pack {
  const upper = text.toUpperCase();
  const countMatch = upper.match(/\b(?:C|PQ|X)\s*\/\s*(\d+)\b/);
  const sizeMatch = upper.match(/\b(\d+(?:\.\d+)?)\s*(KG|G|ML|L)\b/);
  const size = sizeMatch
    ? (() => {
        const amount = Number(sizeMatch[1]);
        const unit = MEASURE_UNITS[sizeMatch[2]];
        return { amount, dimension: unit.dimension, base: amount * unit.toBase };
      })()
    : null;
  return { count: countMatch ? Number(countMatch[1]) : null, size };
}

export interface Conversion {
  stockQuantity: number | null;
  reason: string;
}

export function toStockQuantity(quantity: number, lineUnit: string, text: string, stockUnit: StockUnit): Conversion {
  const target = STOCK_DIMENSION[stockUnit];
  const measured = MEASURE_UNITS[lineUnit.toUpperCase()];

  // Sold by weight or volume on the receipt: the quantity column already carries the measure.
  if (measured) {
    return measured.dimension === target
      ? { stockQuantity: round(quantity * measured.toBase), reason: `${quantity} ${lineUnit}` }
      : { stockQuantity: null, reason: `receipt unit ${lineUnit} cannot become ${stockUnit}` };
  }

  // Sold by piece, case, or pack.
  const pack = parsePack(text);
  const items = quantity * (pack.count ?? 1);
  if (target === "count") {
    return { stockQuantity: items, reason: pack.count ? `${quantity} × ${pack.count} pz` : `${quantity} pz` };
  }
  if (pack.size?.dimension === target) {
    return {
      stockQuantity: round(items * pack.size.base),
      reason: `${items} × ${pack.size.base} ${stockUnit}`,
    };
  }
  return { stockQuantity: null, reason: `no ${target} per ${lineUnit || "unit"} on the line` };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
