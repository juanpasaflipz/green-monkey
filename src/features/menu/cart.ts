import {
  DomainError,
  quote,
  type LineInput,
  type PricedLine,
  type Product,
} from "../../../shared/domain";

/**
 * Per-line cart pricing. The menu's catalog refresh (60 s poll, focus and
 * gm-menu-refresh) can 86 a product or a choice while it is in a cart; one
 * bad line must never blank the whole cart (OWNER-6).
 *
 * Same signature and result as service's `priceCart` in shared/service.ts
 * (wave contract 4.8), which supersedes this copy at service's merge: the
 * integrator switches the import and deletes this file.
 */
export type CartLine = {
  input: LineInput;
  priced: PricedLine | null;
  error: string | null;
};

export function priceCart(
  lines: LineInput[],
  catalog: Product[],
  canOpen: boolean,
): { lines: CartLine[]; total: number; blocked: boolean } {
  const result = lines.map((input): CartLine => {
    try {
      return {
        input,
        priced: quote([input], catalog, canOpen)[0],
        error: null,
      };
    } catch (e) {
      return {
        input,
        priced: null,
        error: e instanceof DomainError ? e.code : "invalid_input",
      };
    }
  });
  return {
    lines: result,
    total: result.reduce((a, l) => a + (l.priced?.total ?? 0), 0),
    blocked: result.some((l) => l.error !== null),
  };
}

/** Codes a catalog refresh can fix: refetch after the server returns one. */
export const CATALOG_ERRORS = new Set([
  "unavailable",
  "invalid_modifier",
  "required_modifier",
  "open_amount_exceeds",
]);
