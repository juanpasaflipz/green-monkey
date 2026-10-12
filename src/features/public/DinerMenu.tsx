import { useLayoutEffect, useRef, useState } from "react";
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
            {g.products.map((p) => (
              <DinerProduct
                key={p.id}
                product={p}
                locale={locale}
                price={orderable(p) ? money(p.price) : t.publicSoldOut}
                kiosk={kiosk}
                photos={photos}
                onPick={onPick}
              />
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}

/**
 * One product of the menu. Its accessible name is "name, price" and its description is the
 * accessible description (aria-describedby), so a screen reader hears it in full; on the QR menu a
 * description clamped to two lines gets «Leer más», which shows it whole (KIOSK-UX-18).
 */
export function DinerProduct({
  product: p,
  locale,
  price,
  kiosk,
  photos,
  onPick,
}: {
  product: Product;
  locale: Locale;
  price: string;
  kiosk: boolean;
  photos: boolean;
  onPick: (p: Product) => void;
}) {
  const t = strings[locale];
  const can = orderable(p);
  const description = kiosk ? "" : p.description?.[locale] || p.description?.es || "";
  const descId = `diner-desc-${p.id}`;
  const ref = useRef<HTMLSpanElement>(null);
  const [clamped, setClamped] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [description, open]);
  return (
    <div className="diner-product-card">
      <button
        type="button"
        className="diner-product"
        disabled={!can}
        aria-label={`${p.name[locale]}, ${price}`}
        aria-describedby={description ? descId : undefined}
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
        {description && (
          <span
            id={descId}
            ref={ref}
            className={
              open
                ? "diner-product-description open"
                : "diner-product-description"
            }
          >
            {description}
          </span>
        )}
        <span className="diner-product-meta">
          <strong>{price}</strong>
          {p.kind === "combo" && <span className="badge">{t.publicCombo}</span>}
        </span>
      </button>
      {description && (clamped || open) && (
        <button
          type="button"
          className="diner-product-more"
          aria-expanded={open}
          aria-controls={descId}
          onClick={() => setOpen(!open)}
        >
          {open ? t.publicDescriptionLess : t.publicDescriptionMore}
        </button>
      )}
    </div>
  );
}
