import { useState } from "react";
import type { Locale } from "../../../shared/domain";
import type {
  OrderingState,
  PublicMenuView,
} from "../../../shared/public-ordering";
import { strings } from "../../i18n";
import { Button, Modal } from "../../components/ui";
import { useMediaQuery } from "../../serviceHooks";
import { fill, moneyFormatter } from "../menu/format";
import type { CartLine } from "../menu/cart";
import { UnavailableLines } from "../menu/UnavailableLines";
import { guestCopy } from "../../compat/public-account";
import type { Draft } from "./DinerApp";

/**
 * The cart: a side panel from 768 px, a sticky "Ver pedido" bar and a sheet on
 * phones. Lines, options, quantities, unavailable lines, the optional name
 * and kitchen note, the privacy copy, the total and "Enviar pedido".
 */
export function DinerCart(props: {
  menu: PublicMenuView;
  ordering: OrderingState;
  locale: Locale;
  draft: Draft;
  cart: { lines: CartLine[]; total: number; blocked: boolean };
  busy: boolean;
  error: string;
  unknown: boolean;
  /** The kiosk renders no navigational link: notices open in a dialog. */
  kiosk: boolean;
  /** The code stopped working on submit (UX-1): no sending, a way to the orders. */
  invalid: boolean;
  onShowOrders?: () => void;
  onPrivacy: () => void;
  onQuantity: (lineId: string, quantity: number) => void;
  onName: (name: string) => void;
  onNote: (note: string) => void;
  onSend: () => void;
  onRetry: () => void;
  /** After an unknown outcome: edit anyway, as a new order (new keys). */
  onEditAnyway: () => void;
}) {
  const { menu, locale, cart, draft } = props;
  const t = strings[locale];
  const wide = useMediaQuery("(min-width: 768px)");
  const [open, setOpen] = useState(false);
  const money = moneyFormatter(locale, menu.restaurant.currency);
  const count = draft.lines.reduce((n, l) => n + l.quantity, 0);
  if (wide)
    return (
      <aside className="diner-cart" aria-label={t.publicYourOrder}>
        <h2>{t.publicYourOrder}</h2>
        <CartBody {...props} />
      </aside>
    );
  return (
    <>
      {count > 0 && !open && (
        <div className="diner-cart-bar">
          <Button variant="primary" onClick={() => setOpen(true)}>
            {fill(t.publicCartBar, { count, total: money(cart.total) })}
          </Button>
        </div>
      )}
      {open && (
        <Modal
          title={t.publicYourOrder}
          close={() => setOpen(false)}
          closeLabel={t.close}
        >
          <CartBody {...props} />
        </Modal>
      )}
      {props.unknown && !open && (
        <div className="diner-cart-bar">
          <Button variant="primary" onClick={() => setOpen(true)}>
            {t.publicUnknownOutcome}
          </Button>
        </div>
      )}
    </>
  );
}

function CartBody({
  menu,
  ordering,
  locale,
  draft,
  cart,
  busy,
  error,
  unknown,
  kiosk,
  invalid,
  onShowOrders,
  onPrivacy,
  onQuantity,
  onName,
  onNote,
  onSend,
  onRetry,
  onEditAnyway,
}: Parameters<typeof DinerCart>[0]) {
  const t = strings[locale];
  const guest = guestCopy(locale);
  const money = moneyFormatter(locale, menu.restaurant.currency);
  const priced = cart.lines.flatMap((l) =>
    l.priced ? [{ input: l.input, line: l.priced }] : [],
  );
  const canSend =
    draft.lines.length > 0 &&
    !cart.blocked &&
    !busy &&
    !unknown &&
    !invalid &&
    ordering.open;
  // While a send is in flight or its outcome is unknown, the order stays as
  // sent: an edit is an explicit choice to send a new order (UX-9).
  const locked = busy || unknown;
  return (
    <div className="diner-cart-body">
      {draft.lines.length === 0 && <p className="muted">{t.publicEmptyCart}</p>}
      <ul className="diner-lines">
        {priced.map(({ input, line }) => {
          const name = line.name[locale];
          return (
            <li key={input.id} className="diner-line">
              <div className="diner-line-main">
                <span className="diner-line-name">
                  {fill(t.publicQuantity, { n: line.quantity })} {name}
                </span>
                {line.optionNames.length > 0 && (
                  <small className="muted">
                    {line.optionNames.map((o) => o[locale]).join(" · ")}
                  </small>
                )}
              </div>
              <strong className="diner-line-total">{money(line.total)}</strong>
              <div className="diner-stepper">
                <Button
                  aria-label={fill(t.publicLess, { name })}
                  disabled={locked}
                  onClick={() => onQuantity(input.id, line.quantity - 1)}
                >
                  −
                </Button>
                <Button
                  aria-label={fill(t.publicMore, { name })}
                  disabled={locked || line.quantity >= 20}
                  onClick={() => onQuantity(input.id, line.quantity + 1)}
                >
                  +
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`${t.remove} ${name}`}
                  disabled={locked}
                  onClick={() => onQuantity(input.id, 0)}
                >
                  {t.remove}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <UnavailableLines
        lines={cart.lines}
        catalog={menu.catalog}
        locale={locale}
        onRemove={(id) => onQuantity(id, 0)}
      />
      <label className="field">
        <span>{guest.nameLabel}</span>
        <input
          value={draft.name}
          disabled={locked}
          maxLength={40}
          autoComplete="off"
          aria-describedby="diner-name-hint"
          onChange={(e) => onName(e.target.value)}
        />
        <small id="diner-name-hint" className="muted">
          {guest.nameHint}
        </small>
      </label>
      <label className="field">
        <span>{t.publicNoteLabel}</span>
        <textarea
          value={draft.note}
          disabled={locked}
          maxLength={200}
          rows={2}
          aria-describedby="diner-note-hint"
          onChange={(e) => onNote(e.target.value)}
        />
        <small id="diner-note-hint" className="muted">
          {t.publicNoteHint}
        </small>
      </label>
      <p className="diner-privacy tiny">
        {!menu.restaurant.privacyNoticeUrl ? (
          guest.noNotice
        ) : kiosk ? (
          <button type="button" className="diner-link" onClick={onPrivacy}>
            {fill(guest.privacyLink, { restaurant: menu.restaurant.name })}
          </button>
        ) : (
          <a
            href={menu.restaurant.privacyNoticeUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {fill(guest.privacyLink, { restaurant: menu.restaurant.name })}
          </a>
        )}
      </p>
      {/* Total and send stay in view while the panel scrolls (UX-4). */}
      <div className="diner-cart-footer">
        <p className="diner-total">
          <span>{t.publicTotal}</span>
          <strong>{money(cart.total)}</strong>
        </p>
        {error && (
          <p className="error diner-error" role="alert">
            {error}
          </p>
        )}
        {invalid && onShowOrders && (
          <Button variant="primary" className="full" onClick={onShowOrders}>
            {t.publicShowMyOrders}
          </Button>
        )}
        {unknown ? (
          <div className="diner-unknown" role="alert">
            <p>{t.publicUnknownOutcome}</p>
            <Button variant="primary" disabled={busy} onClick={onRetry}>
              {busy ? t.publicSending : t.publicRetry}
            </Button>
            <Button disabled={busy} onClick={onEditAnyway}>
              {t.publicEditAnyway}
            </Button>
          </div>
        ) : invalid ? null : (
          <>
            {!ordering.open && (
              <p className="diner-closed">
                {ordering.reason === "table_unavailable"
                  ? t.publicTableClosedBanner
                  : t.publicClosedBanner}
              </p>
            )}
            <Button
              variant="primary"
              className="full diner-send"
              disabled={!canSend}
              onClick={onSend}
            >
              {busy ? t.publicSending : t.publicSend}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
