// Catalog reads used by selling, offline sync and QR/kiosk. Leaf module.
import type { Tx } from "./db.js";
import type { Product } from "../shared/domain.js";
import { menuPhotosEnabled } from "./kiosk-config.js";

/**
 * Sellable catalog (archived products excluded) in POS order. payments (037, LD-72): each
 * product carries its platform prices (`platformPrices`, only the set ones) in the same
 * statement; the diner catalog strips them.
 */
export async function catalog(tx: Tx): Promise<Product[]> {
  return (
    await tx`select c.data,
        (select jsonb_object_agg(pp.platform, pp.price) from payment_platform_prices pp
          where pp.product_id = c.id and pp.price is not null) as platform_prices
      from catalog c
      where not coalesce((c.data->>'archived')::boolean, false)
      order by coalesce((c.data->>'categoryPosition')::int, 2147483647), c.data->'category'->>'es',
               coalesce((c.data->>'position')::int, 2147483647), c.data->'name'->>'es', c.id`
  ).map((r) =>
    r.platform_prices
      ? ({ ...r.data, platformPrices: r.platform_prices } as Product)
      : (r.data as Product),
  );
}

/**
 * GET /api/catalog (Vender): the sellable catalog; with MENU_PHOTOS_ENABLED=false its products
 * carry no photo, so the grid shows the initials tiles (kiosk 039, §2.9).
 */
export async function sellingCatalog(tx: Tx): Promise<Product[]> {
  const products = await catalog(tx);
  if (menuPhotosEnabled()) return products;
  return products.map(({ image: _image, ...p }) => p as Product);
}

/** QR/kiosk catalog: no open-price products and no recipes, costs or fiscal data. */
export async function publicCatalog(tx: Tx) {
  const photos = menuPhotosEnabled();
  return (
    (await catalog(tx))
      .filter((p) => !p.openAmount)
      // fiscal (027): a product's tax category and SAT keys stay off the diner payload.
      // payments (037): platform prices are staff-only (LD-72).
      .map(
        ({
          recipe: _recipe,
          cost: _cost,
          fiscal: _fiscal,
          platformPrices: _platformPrices,
          image,
          ...p
        }) => ({
          ...p,
          // kiosk (039): MENU_PHOTOS_ENABLED=false stops rendering photos everywhere.
          ...(image && photos ? { image } : {}),
          groups: p.groups.map((g) => ({
            ...g,
            options: g.options.map(
              ({ recipe: _optionRecipe, cost: _optionCost, ...o }) => o,
            ),
          })),
        }),
      )
  );
}

/** Bumped by every menu write, including availability ("86") toggles. */
export async function menuRevision(tx: Tx): Promise<{ revision: number }> {
  const [r] = await tx`select revision from menu_state`;
  return { revision: Number(r?.revision ?? 0) };
}
