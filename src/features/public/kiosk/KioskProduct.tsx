// The kiosk's product sheet and suggestion strips (039, §2.8–2.9): a large photo (or a neutral
// tile), the description, "Combínalo con…" and "Agregar · $". Suggestions only offer products the
// server listed as sellable that are not already in the cart; one with required choices opens
// its sheet, others add with one tap.
import { useState } from "react";
import type { Locale, Product } from "../../../../shared/domain";
import { orderable, pickerNeeded } from "../../../../shared/menu";
import { mediaUrl } from "../../../../shared/media";
import { pickSuggestions } from "../../../../shared/kiosk";
import { strings } from "../../../i18n";
import { Button, Modal } from "../../../components/ui";
import { fill, moneyFormatter } from "../../menu/format";

/**
 * The photo, or the product's initial on a neutral tile (never a broken image): also when the
 * photo fails to load (a /media 503 during a store outage, a 404 for a stale id), as the POS
 * grid's ProductArt does (KIOSK-UX-17).
 */
export function ProductPhoto(props: {
  product: Product;
  locale: Locale;
  variant: "thumb" | "card" | "hero";
  decorative?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <ProductPhotoView
      {...props}
      failed={!!props.product.image && failed === props.product.image.id}
      onError={(id) => setFailed(id)}
    />
  );
}

/** ProductPhoto's markup for a known load state (pure, tests/kiosk.test.ts). */
export function ProductPhotoView({
  product,
  locale,
  variant,
  decorative = false,
  failed,
  onError,
}: {
  product: Product;
  locale: Locale;
  variant: "thumb" | "card" | "hero";
  decorative?: boolean;
  failed: boolean;
  onError: (imageId: string) => void;
}) {
  if (!product.image || failed)
    return (
      <span className="kiosk-photo kiosk-photo-empty" aria-hidden="true">
        {product.name[locale].trim().charAt(0).toUpperCase()}
      </span>
    );
  const image = product.image;
  const { w, h } = image;
  const width = { thumb: 160, card: 480, hero: 1200 }[variant];
  const vw = Math.min(width, w);
  return (
    <img
      className="kiosk-photo"
      src={mediaUrl(image, variant)}
      srcSet={
        variant === "hero"
          ? `${mediaUrl(image, "card")} 480w, ${mediaUrl(image, "hero")} 1200w`
          : undefined
      }
      width={vw}
      height={Math.round((h * vw) / w)}
      loading="lazy"
      decoding="async"
      alt={decorative ? "" : product.name[locale]}
      onError={() => onError(image.id)}
    />
  );
}

export function KioskProductSheet({
  product,
  catalog,
  suggestions,
  inCart,
  locale,
  currency,
  onAdd,
  onPick,
  onClose,
}: {
  product: Product;
  catalog: Product[];
  suggestions: string[];
  inCart: Set<string>;
  locale: Locale;
  currency: string;
  /** Adds the product (opening the option picker when it needs choices). */
  onAdd: (p: Product, origin?: "suggestion") => void;
  onPick: (p: Product) => void;
  onClose: () => void;
}) {
  const t = strings[locale];
  const money = moneyFormatter(locale, currency);
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const sellable = new Set(catalog.filter(orderable).map((p) => p.id));
  const pairs = pickSuggestions(suggestions, {
    inCart,
    sellable,
    exclude: product.id,
    max: 4,
  }).map((id) => byId.get(id)!);
  const description = product.description?.[locale] || product.description?.es;
  return (
    <Modal
      title={product.name[locale]}
      close={onClose}
      closeLabel={t.close}
      wide
    >
      <div className="kiosk-sheet">
        <ProductPhoto
          product={product}
          locale={locale}
          variant="hero"
          decorative
        />
        {description && <p className="kiosk-description">{description}</p>}
        {pairs.length > 0 && (
          <SuggestionStrip
            title={t.kioskPairWith}
            products={pairs}
            locale={locale}
            currency={currency}
            onAdd={(p) =>
              pickerNeeded(p) ? onPick(p) : onAdd(p, "suggestion")
            }
          />
        )}
        <Button
          variant="primary"
          className="kiosk-add"
          onClick={() =>
            pickerNeeded(product) ? onPick(product) : onAdd(product)
          }
        >
          {fill(t.kioskAddToOrder, { price: money(product.price) })}
        </Button>
      </div>
    </Modal>
  );
}

export function SuggestionStrip({
  title,
  products,
  locale,
  currency,
  onAdd,
}: {
  title: string;
  products: Product[];
  locale: Locale;
  currency: string;
  onAdd: (p: Product) => void;
}) {
  const money = moneyFormatter(locale, currency);
  if (!products.length) return null;
  return (
    <section className="kiosk-suggestions" aria-label={title}>
      <h3>{title}</h3>
      <div className="kiosk-suggestion-row">
        {products.map((p) => (
          <button
            type="button"
            key={p.id}
            className="kiosk-suggestion"
            aria-label={fill(strings[locale].kioskSuggestionAdd, {
              name: p.name[locale],
              price: money(p.price),
            })}
            onClick={() => onAdd(p)}
          >
            <ProductPhoto
              product={p}
              locale={locale}
              variant="thumb"
              decorative
            />
            <span>{p.name[locale]}</span>
            <strong>{money(p.price)}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}
