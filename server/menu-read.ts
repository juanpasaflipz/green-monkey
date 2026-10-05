// Catalog reads used by selling, offline sync and QR/kiosk. Leaf module.
import type { Tx } from "./db.js";
import type { Product } from "../shared/domain.js";

/** Sellable catalog (archived products excluded) in POS order. */
export async function catalog(tx: Tx): Promise<Product[]> {
  return (
    await tx`select data from catalog
      where not coalesce((data->>'archived')::boolean, false)
      order by coalesce((data->>'categoryPosition')::int, 2147483647), data->'category'->>'es',
               coalesce((data->>'position')::int, 2147483647), data->'name'->>'es', id`
  ).map((r) => r.data as Product);
}

/** QR/kiosk catalog: no open-price products and no recipes or costs. */
export async function publicCatalog(tx: Tx) {
  return (await catalog(tx))
    .filter((p) => !p.openAmount)
    .map(({ recipe: _recipe, cost: _cost, ...p }) => ({
      ...p,
      groups: p.groups.map((g) => ({
        ...g,
        options: g.options.map(
          ({ recipe: _optionRecipe, cost: _optionCost, ...o }) => o,
        ),
      })),
    }));
}

/** Bumped by every menu write, including availability ("86") toggles. */
export async function menuRevision(tx: Tx): Promise<{ revision: number }> {
  const [r] = await tx`select revision from menu_state`;
  return { revision: Number(r?.revision ?? 0) };
}
