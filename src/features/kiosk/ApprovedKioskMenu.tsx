import { useEffect, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import type { Locale, Product } from "../../../shared/domain";
import { orderable } from "../../../shared/menu";
import type {
  OrderingState,
  PublicMenuView,
} from "../../../shared/public-ordering";
import type { Draft } from "../public/DinerApp";
import type { CartLine } from "../menu/cart";
import { moneyFormatter } from "../menu/format";
import { ProductPhoto } from "../public/kiosk/KioskProduct";
import { NameEntry } from "./NameEntry";
import { kioskText } from "./text";
import { strings } from "../../i18n";

/** Approved prototype presentation; the parent retains the deployed order/payment state machine. */
export function ApprovedKioskMenu(p: {
  menu: PublicMenuView;
  ordering: OrderingState;
  locale: Locale;
  draft: Draft;
  cart: { lines: CartLine[]; total: number; blocked: boolean };
  review: boolean;
  busy: boolean;
  unknown: boolean;
  error: string;
  header: ReactNode;
  extra: ReactNode;
  onReview: (review: boolean) => void;
  onPick: (product: Product) => void;
  onEdit: (id: string) => void;
  onQuantity: (id: string, quantity: number) => void;
  onName: (name: string) => void;
  onNote: (note: string) => void;
  onPrivacy: () => void;
  onSend: () => void;
  onRetry: () => void;
  onEditAnyway: () => void;
}) {
  const t = kioskText[p.locale],
    existing = strings[p.locale];
  const money = moneyFormatter(p.locale, p.menu.restaurant.currency);
  const [category, setCategory] = useState("all");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [p.review]);
  const locked = p.busy || p.unknown;
  const canSend =
    !locked && !!p.draft.lines.length && !p.cart.blocked && p.ordering.open;
  const categories = [
    ...new Map(
      p.menu.catalog.map((product) => [
        product.categoryId ?? product.category.es,
        product.category[p.locale],
      ]),
    ).entries(),
  ];
  const lines = (
    <div className="approved-lines">
      {p.cart.lines.map(({ input, priced }) => {
        const name =
          priced?.name[p.locale] ??
          p.menu.catalog.find((product) => product.id === input.productId)
            ?.name[p.locale] ??
          t.unavailable;
        return (
          <div className="line diner-line" key={input.id}>
            <div className="line-top">
              <span className="diner-line-name">
                {input.quantity} × {name}
              </span>
              <strong>{priced ? money(priced.total) : "—"}</strong>
            </div>
            <p>
              {priced
                ? priced.optionNames
                    .map((option) => option[p.locale])
                    .join(" · ")
                : t.unavailable}
            </p>
            <div className="line-actions">
              <button
                disabled={locked}
                aria-label={`${existing.publicLess.replace("{name}", name)}`}
                onClick={() => p.onQuantity(input.id, input.quantity - 1)}
              >
                −
              </button>
              <button
                disabled={locked || input.quantity >= 20}
                aria-label={`${existing.publicMore.replace("{name}", name)}`}
                onClick={() => p.onQuantity(input.id, input.quantity + 1)}
              >
                +
              </button>
              <button disabled={locked} onClick={() => p.onEdit(input.id)}>
                {t.edit}
              </button>
              <button
                className="remove"
                disabled={locked}
                onClick={() => p.onQuantity(input.id, 0)}
              >
                {t.remove}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
  const totals = (
    <div className="total diner-total">
      <span>{t.total}</span>
      <strong>{money(p.cart.total)}</strong>
    </div>
  );
  return (
    <>
      {p.header}
      <nav className="journey" aria-label={t.yourOrder}>
        {[t.choose, t.review, t.pay].map((label, index) => (
          <span
            key={label}
            aria-current={index === (p.review ? 1 : 0) ? "step" : undefined}
          >
            <b>0{index + 1}</b>
            {label}
          </span>
        ))}
      </nav>
      {p.error && (
        <p className="alert" role="alert">
          {p.error}
        </p>
      )}
      {!p.ordering.open && (
        <p className="alert" role="status">
          {t.closed}
        </p>
      )}
      {p.unknown && (
        <div className="alert" role="alert">
          <p>{existing.publicUnknownOutcome}</p>
          <button onClick={p.onRetry}>{existing.publicRetry}</button>
          <button onClick={p.onEditAnyway}>
            {p.locale === "es"
              ? "Editar como pedido nuevo"
              : "Edit as a new order"}
          </button>
        </div>
      )}
      {p.review ? (
        <section className="review-screen">
          <button
            className="back"
            disabled={locked}
            onClick={() => p.onReview(false)}
          >
            ← {t.back}
          </button>
          <h1 ref={heading} tabIndex={-1}>
            {t.reviewHeading}
          </h1>
          {lines}
          <fieldset disabled={locked} className="approved-guest-details">
            <NameEntry
              value={p.draft.name}
              onChange={p.onName}
              locale={p.locale}
            />
            <label htmlFor="approved-kiosk-note">
              {existing.publicNoteLabel}
            </label>
            <textarea
              id="approved-kiosk-note"
              value={p.draft.note}
              maxLength={200}
              onChange={(event) => p.onNote(event.target.value)}
            />
          </fieldset>
          <p className="fine">{existing.publicNoteHint}</p>
          <p className="diner-privacy tiny">
            {p.menu.restaurant.privacyNoticeUrl ? (
              <button
                type="button"
                className="diner-link"
                onClick={p.onPrivacy}
              >
                {existing.accountGuestPrivacyLink.replace(
                  "{restaurant}",
                  p.menu.restaurant.name,
                )}
              </button>
            ) : (
              existing.accountGuestNoNotice
            )}
          </p>
          {p.extra}
          <div className="review-footer">
            <div>
              {totals}
              <p className="fine">
                {p.menu.restaurant.currency} · {t.tax}
              </p>
            </div>
            <button className="primary" disabled={!canSend} onClick={p.onSend}>
              {existing.publicSend}
            </button>
          </div>
        </section>
      ) : (
        <div className="menu-layout">
          <section
            className="menu-main diner-main"
            aria-label={p.menu.restaurant.name}
          >
            <div className="intro">
              <p className="eyebrow">{t.eyebrow}</p>
              <h1 ref={heading} tabIndex={-1}>
                {t.headline}
                <br />
                <em>{t.accent}</em>
              </h1>
              <p>{t.intro}</p>
            </div>
            <nav className="categories" aria-label={t.all}>
              <button
                aria-pressed={category === "all"}
                onClick={() => setCategory("all")}
              >
                {t.all}
              </button>
              {categories.map(([id, label]) => (
                <button
                  key={id}
                  aria-pressed={category === id}
                  onClick={() => setCategory(id)}
                >
                  {label}
                </button>
              ))}
            </nav>
            <div className="products">
              {p.menu.catalog
                .filter(
                  (product) =>
                    category === "all" ||
                    (product.categoryId ?? product.category.es) === category,
                )
                .map((product) => (
                  <button
                    className="product diner-product"
                    key={product.id}
                    disabled={
                      locked ||
                      !orderable(product) ||
                      p.draft.lines.length >= 40
                    }
                    aria-label={`${product.name[p.locale]}, ${orderable(product) ? money(product.price) : t.soldOut}`}
                    onClick={() => p.onPick(product)}
                  >
                    <ProductPhoto
                      product={product}
                      locale={p.locale}
                      variant="card"
                      decorative
                    />
                    <span className="product-copy">
                      <span className="product-name">
                        {product.name[p.locale]}
                      </span>
                      {product.description && (
                        <span className="product-description">
                          {product.description[p.locale] ||
                            product.description.es}
                        </span>
                      )}
                      <span className="product-price">
                        <strong>
                          {orderable(product)
                            ? money(product.price)
                            : t.soldOut}
                        </strong>
                        <span className="plus" aria-hidden="true">
                          <Plus size={20} />
                        </span>
                      </span>
                    </span>
                  </button>
                ))}
            </div>
          </section>
          <aside className="cart diner-cart" aria-label={t.yourOrder}>
            <div className="cart-heading">
              <h2>
                {t.yourOrder}
                <span>
                  {p.draft.lines.reduce((sum, line) => sum + line.quantity, 0)}
                </span>
              </h2>
            </div>
            {p.draft.lines.length ? (
              lines
            ) : (
              <div className="empty">
                <strong>{t.empty}</strong>
                {t.emptyHint}
              </div>
            )}
            {p.extra}
            <div className="cart-bottom">
              {totals}
              <p className="fine">
                {p.menu.restaurant.currency} · {t.tax}
              </p>
              <button
                className="primary"
                disabled={!canSend}
                onClick={() => p.onReview(true)}
              >
                {t.reviewOrder} →
              </button>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
