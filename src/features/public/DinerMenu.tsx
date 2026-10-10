import type { Locale, Product } from "../../../shared/domain";
import type {
  OrderingState,
  PublicMenuView,
} from "../../../shared/public-ordering";
import { orderable } from "../../../shared/menu";
import { strings } from "../../i18n";
import { fill, moneyFormatter } from "../menu/format";
import { ProductPhoto } from "./kiosk/KioskProduct";

/** Products grouped by category in POS order. */
function byCategory(products: Product[], locale: Locale) {
  const groups: { key: string; name: string; products: Product[] }[] = [];
  for (const p of products) {
    const key = p.categoryId ?? p.category.es;
    const last = groups.at(-1);
    if (last && last.key === key) last.products.push(p);
    else groups.push({ key, name: p.category[locale], products: [p] });
  }
  return groups;
}

/** The policy line, the closed banner and the category-grouped menu. */
export function DinerMenu({
  menu,
  ordering,
  locale,
  onPick,
  kiosk = false,
}: {
  menu: PublicMenuView;
  ordering: OrderingState;
  locale: Locale;
  onPick: (p: Product) => void;
  /** Kiosk (039): photo cards, a neutral tile when a product has none (only when any has one). */
  kiosk?: boolean;
}) {
  const photos = menu.catalog.some((p) => p.image);
  const t = strings[locale];
  const money = moneyFormatter(locale, menu.restaurant.currency);
  const table = menu.link.kind === "table";
  const policy =
    ordering.policy === "pay_first"
      ? table
        ? t.publicPolicyPayFirstTable
        : t.publicPolicyPayFirstCounter
      : table
        ? t.publicPolicyAcceptTable
        : t.publicPolicyAcceptCounter;
  return (
    <section className="diner-menu" aria-label={menu.restaurant.name}>
      <div className="diner-policy">
        <p>{policy}</p>
        <p className="muted">
          {fill(t.publicPricesTax, { currency: menu.restaurant.currency })}
        </p>
      </div>
      {!ordering.open && (
        <p className="diner-closed" role="alert">
          {ordering.reason === "table_unavailable"
            ? t.publicTableClosedBanner
            : t.publicClosedBanner}
        </p>
      )}
      {byCategory(menu.catalog, locale).map((g) => (
        <section className="diner-category" key={g.key}>
          <h2>{g.name}</h2>
          <div className="diner-products">
            {g.products.map((p) => {
              const can = orderable(p);
              const price = can ? money(p.price) : t.publicSoldOut;
              return (
                <button
                  type="button"
                  key={p.id}
                  className="diner-product"
                  disabled={!can}
                  aria-label={`${p.name[locale]}, ${price}`}
                  onClick={() => onPick(p)}
                >
                  {(p.image || (kiosk && photos)) && (
                    <ProductPhoto
                      product={p}
                      locale={locale}
                      variant={kiosk ? "card" : "thumb"}
                      decorative
                    />
                  )}
                  <span className="diner-product-name">{p.name[locale]}</span>
                  {!kiosk && (p.description?.[locale] || p.description?.es) && (
                    <span className="diner-product-description">
                      {p.description?.[locale] || p.description?.es}
                    </span>
                  )}
                  <span className="diner-product-meta">
                    <strong>{price}</strong>
                    {p.kind === "combo" && (
                      <span className="badge">{t.publicCombo}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </section>
  );
}
