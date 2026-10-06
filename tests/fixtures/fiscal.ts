// Helpers for the fiscal unit tests: a seeded PRNG (so property tests are deterministic and a
// failure always reproduces) and an order-line builder in the shape server/orders.ts persists.
import type { Label, PricedLine } from "../../shared/domain";
import {
  DEFAULT_FISCAL_CONTEXT,
  lineTaxSnapshot,
  type FiscalContext,
  type LineTaxSnapshot,
} from "../../shared/tax";

/** Same shape as TaxedLine in shared/fiscal.ts. */
type TaxedLine = PricedLine & { tax?: LineTaxSnapshot | null };

/** mulberry32: small, fast and good enough to drive property tests. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** Integer in [min, max]. */
  const int = (min: number, max: number) =>
    min + Math.floor(next() * (max - min + 1));
  const pick = <T>(values: readonly T[]): T =>
    values[int(0, values.length - 1)];
  return { next, int, pick };
}

let counter = 0;
/** A deterministic, sortable fake uuid. */
export function fakeId(n = ++counter): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/**
 * A persisted order line. `fiscal` is the product's fiscal field: when present (even `{}`), the
 * line carries the quote-time snapshot taken with `ctx`; `legacy: true` builds a line priced
 * before migration 027 (no snapshot).
 */
export function line(
  input: {
    id?: string;
    total: number;
    quantity?: number;
    voidedUnits?: number[];
    round?: number;
    name?: Label;
    optionNames?: Label[];
    fiscal?: unknown;
    ctx?: FiscalContext;
    legacy?: boolean;
  } = { total: 0 },
): TaxedLine {
  const quantity = input.quantity ?? 1;
  return {
    id: input.id ?? fakeId(),
    productId: fakeId(),
    quantity,
    options: [],
    note: "",
    name: input.name ?? { es: "Taco al pastor", en: "Al pastor taco" },
    optionNames: input.optionNames ?? [],
    unitPrice: Math.floor(input.total / quantity),
    total: input.total,
    cost: null,
    station: "kitchen",
    recipe: [],
    productVersion: 1,
    round: input.round ?? 1,
    voidedUnits: input.voidedUnits ?? [],
    ...(input.legacy
      ? {}
      : {
          tax: lineTaxSnapshot(
            input.fiscal ?? {},
            input.total,
            input.ctx ?? DEFAULT_FISCAL_CONTEXT,
          ),
        }),
  };
}
