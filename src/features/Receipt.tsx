import { useState, type ReactNode } from "react";
import { lineRemaining } from "../../shared/settlement";
import { changeDue, orderNoteEditable, roundNotes } from "../../shared/service";
import {
  currencyExponent,
  type Locale,
  type Order,
  type Session,
} from "../../shared/domain";
import { strings, translateError } from "../i18n";
import { api } from "../api";
import { tenderMethodLabel } from "../labels";
import { Badge, Button, Modal } from "../components/ui";
import { printDocument, usePrintSettings, type PaperWidth } from "../print";
import type { LocalReceipt } from "../offline-records";
import { DocNote } from "./KitchenTicket";

export function moneyFormatter(currency: string, locale: Locale) {
  const scale = 10 ** currencyExponent(currency);
  const format = new Intl.NumberFormat(locale === "es" ? "es-MX" : "en-US", {
    style: "currency",
    currency,
  });
  return (n: number) => format.format(n / scale);
}

/** Effective check state, with a fallback for replies stored before 024. */
export function checkStateOf(order: Order) {
  return order.checkState ?? (order.paid >= order.total ? "closed" : "open");
}

/**
 * Whether "Editar nota" is offered: open and paid checks, and closed checks
 * whose kitchen tickets are still open (SVC-K3).
 */
export function noteEditableOf(order: Order) {
  return (
    order.state !== "local" &&
    !order.recovery &&
    orderNoteEditable({
      checkState: checkStateOf(order),
      state: order.state,
      closeReason: order.closeReason,
    })
  );
}

/**
 * What this device collected for a local (offline) receipt. Offline's records
 * carry their payment, which may be partial with offline table service
 * (LD-7); a local receipt without one was collected in full before it was
 * saved, so it never prints as unpaid (SERVICE-MONEY-5).
 */
function localCollected(order: Order) {
  return (order as Partial<LocalReceipt>).offline?.method
    ? order.paid
    : order.total;
}

export type ReceiptKind = "receipt" | "check" | "local";
/** Content another area adds to receipts (fiscal 027, CFDI 030). */
export type ReceiptSlot = (p: {
  order: Order;
  kind: ReceiptKind;
  reprint: boolean;
  locale: Locale;
}) => ReactNode;
const receiptSlots: { header?: ReceiptSlot; footer?: ReceiptSlot } = {};
/**
 * Registers receipt header/footer content once, at startup. Every
 * ReceiptDocument then shows it: the receipt modal and its print, and the
 * pre-bill and reprint printed from order detail. A registry rather than React
 * context, because printDocument renders into its own root, where context from
 * the app tree does not reach. Explicit `header`/`footer` props win.
 */
export function setReceiptSlots(slots: {
  header?: ReceiptSlot;
  footer?: ReceiptSlot;
}) {
  receiptSlots.header = slots.header;
  receiptSlots.footer = slots.footer;
}

/**
 * The printable receipt, pre-bill ("cuenta") or local offline receipt. Fiscal
 * (027) and CFDI (030) content is injected through `header` and `footer`
 * (props, or slots registered with setReceiptSlots).
 */
export function ReceiptDocument({
  order,
  session,
  locale,
  kind,
  reprint = false,
  label,
  labelHint,
  header,
  footer,
}: {
  order: Order;
  session: Session;
  locale: Locale;
  kind: ReceiptKind;
  reprint?: boolean;
  /** Replaces "#number" (offline provisional numbers). */
  label?: string;
  labelHint?: string;
  header?: ReactNode;
  footer?: ReactNode;
}) {
  const t = strings[locale];
  const restaurant = order.restaurantSnapshot ?? session.restaurant;
  const money = moneyFormatter(restaurant.currency, locale);
  const slot = { order, kind, reprint, locale };
  const top = header ?? receiptSlots.header?.(slot);
  const bottom = footer ?? receiptSlots.footer?.(slot);
  // LD-1: the order note and round notes print for the customer as well as
  // the kitchen; round notes identical to the order note are left out.
  const notes = roundNotes(order);
  // offline (026), LD-10 B4: the payment this device collected for a local
  // receipt, which has no tender until it syncs.
  const localPayment =
    kind === "local" && !order.tenders.length
      ? ((order as Partial<LocalReceipt>).offline ?? null)
      : null;
  const paidTone =
    kind === "local"
      ? "neutral"
      : order.paid >= order.total
        ? "green"
        : order.paid > 0
          ? "amber"
          : "neutral";
  return (
    <div className="receipt-doc">
      <h2 className="doc-title">{restaurant.name}</h2>
      {reprint && <p className="doc-flag">{t.serviceReceiptReprint}</p>}
      {kind === "check" && (
        <p className="doc-flag">{t.serviceReceiptCheckTitle}</p>
      )}
      {top}
      <Badge tone={paidTone}>
        {kind === "local"
          ? t.pending
          : order.paid >= order.total
            ? t.paid
            : order.paid > 0
              ? t.partial
              : t.unpaid}
      </Badge>
      {labelHint && <p className="muted tiny">{labelHint}</p>}
      <p>
        {label ?? "#" + (order.number || order.id.slice(0, 8))} ·{" "}
        {new Date(order.createdAt).toLocaleString(locale, {
          timeZone: restaurant.timezone,
        })}
        {order.tableName && (
          <>
            <br />
            {t.serviceReceiptTable.replace("{name}", order.tableName)}
          </>
        )}
        {order.waiterName && (
          <>
            <br />
            {t.serviceReceiptServer.replace("{name}", order.waiterName)}
          </>
        )}
      </p>
      {order.recovery && (
        <p>
          {locale === "es"
            ? "Efectivo conciliado. Cocina e inventario requieren revisión manual."
            : "Cash reconciled. Kitchen and inventory require manual review."}
          <br />
          {order.recovery.reason}
        </p>
      )}
      {order.note && (
        <DocNote
          label={t.serviceDetailOrderNote}
          text={order.note}
          locale={locale}
        />
      )}
      {notes.map((n) => (
        <DocNote
          key={n.round}
          label={t.serviceDetailRoundNote.replace("{n}", String(n.round))}
          text={n.note}
          locale={locale}
        />
      ))}
      <div className="doc-lines">
        {order.lines
          .filter((l) => lineRemaining(l).quantity > 0)
          .map((l) => (
            <div className="doc-line" key={l.id}>
              <div className="row between">
                <span>
                  {lineRemaining(l).quantity} × {l.name[locale]}
                </span>
                <strong>{money(lineRemaining(l).total)}</strong>
              </div>
              {l.optionNames.map((o, i) => (
                <div className="doc-option muted" key={i}>
                  + {o[locale]}
                </div>
              ))}
              {l.note && <div className="doc-line-note">{l.note}</div>}
            </div>
          ))}
      </div>
      <hr />
      <div className="row between doc-total">
        <span>{t.total}</span>
        <strong>{money(order.total)}</strong>
      </div>
      {order.tenders.map((tender) => (
        <div className="doc-tender" key={tender.id}>
          <div className="row between">
            <span>
              {tenderMethodLabel(tender.method, tender.source, locale)}
            </span>
            <strong>{money(tender.amount)}</strong>
          </div>
          {tender.method === "external" && tender.external_reference && (
            <div className="muted">
              {t.serviceReceiptReference.replace(
                "{ref}",
                tender.external_reference,
              )}
            </div>
          )}
          {tender.tip > 0 && (
            <div className="row between muted">
              <span>{t.serviceReceiptTip}</span>
              <span>{money(tender.tip)}</span>
            </div>
          )}
          {tender.method === "cash" && (
            <>
              <div className="row between muted">
                <span>{t.serviceReceiptReceived}</span>
                <span>{money(tender.received)}</span>
              </div>
              <div className="row between muted">
                <span>{t.change}</span>
                <span>
                  {money(changeDue(tender.received, tender.amount, tender.tip))}
                </span>
              </div>
            </>
          )}
        </div>
      ))}
      {order.refunded > 0 && (
        <div className="row between">
          <span>{t.serviceReceiptRefund}</span>
          <strong>−{money(order.refunded)}</strong>
        </div>
      )}
      {kind === "local" && !order.tenders.length ? (
        // A local (offline) payment carries no tender until it syncs: print
        // what this device collected (LD-10 B4) and never print it as unpaid
        // (SERVICE-MONEY-5); with offline table service (LD-7) it may be a
        // partial payment, with its balance.
        <>
          {localPayment?.method && (
            <div className="doc-tender">
              <div className="row between">
                <span>
                  {tenderMethodLabel(localPayment.method, undefined, locale)}
                </span>
                {localPayment.amount !== undefined && (
                  <strong>{money(localPayment.amount)}</strong>
                )}
              </div>
              {localPayment.method === "external" && localPayment.reference && (
                <div className="muted">
                  {t.serviceReceiptReference.replace(
                    "{ref}",
                    localPayment.reference,
                  )}
                </div>
              )}
              {!!localPayment.tip && (
                <div className="row between muted">
                  <span>{t.serviceReceiptTip}</span>
                  <span>{money(localPayment.tip)}</span>
                </div>
              )}
              {localPayment.method === "cash" &&
                localPayment.received !== undefined &&
                localPayment.amount !== undefined && (
                  <>
                    <div className="row between muted">
                      <span>{t.serviceReceiptReceived}</span>
                      <span>{money(localPayment.received)}</span>
                    </div>
                    <div className="row between muted">
                      <span>{t.change}</span>
                      <span>
                        {money(
                          changeDue(
                            localPayment.received,
                            localPayment.amount,
                            localPayment.tip ?? 0,
                          ),
                        )}
                      </span>
                    </div>
                  </>
                )}
            </div>
          )}
          <div className="row between">
            <span>{t.serviceReceiptLocalPaid}</span>
            <strong>{money(localCollected(order))}</strong>
          </div>
          {localCollected(order) < order.total && (
            <div className="row between">
              <span>{t.remaining}</span>
              <strong>{money(order.total - localCollected(order))}</strong>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="row between">
            <span>{t.paid}</span>
            <strong>{money(order.paid)}</strong>
          </div>
          <div className="row between">
            <span>{t.remaining}</span>
            <strong>{money(order.total - order.paid)}</strong>
          </div>
        </>
      )}
      {bottom}
    </div>
  );
}

/** Records a print in the audit trail; printing still happens offline. */
export async function auditPrint(
  orderId: string,
  document: "receipt" | "check",
  reprint: boolean,
) {
  try {
    await api(`/service/orders/${orderId}/print`, {
      operationId: crypto.randomUUID(),
      document,
      reprint,
    });
  } catch {
    /* The audit is best effort; the print itself never waits for it. */
  }
}

/** Receipt shown after a payment, with print and next/back/release actions. */
export function ReceiptModal({
  order,
  session,
  locale,
  onNext,
  onBack,
  onRelease,
  reprint = false,
  label,
  labelHint,
  extraActions,
  noteActions,
  header,
  footer,
}: {
  order: Order;
  session: Session;
  locale: Locale;
  onNext: () => void;
  onBack: () => void;
  /** Shown for a paid table check; may return a promise to report errors here. */
  onRelease?: () => void | Promise<void>;
  reprint?: boolean;
  label?: string;
  labelHint?: string;
  extraActions?: ReactNode;
  /**
   * Selling's "Editar nota" (and "Reimprimir comanda" after an edit) while the
   * kitchen still has open tickets for this order (SVC-K3).
   */
  noteActions?: ReactNode;
  /** Forwarded to the shown and the printed ReceiptDocument. */
  header?: ReactNode;
  footer?: ReactNode;
}) {
  const t = strings[locale];
  const [settings, saveSettings] = usePrintSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const local = order.state === "local";
  // A local receipt with a balance (a partial offline payment, LD-7) goes
  // back to its order, like an open check; paid in full, on to the next sale.
  const state = local
    ? localCollected(order) >= order.total
      ? "closed"
      : "open"
    : checkStateOf(order);
  const kind = local ? "local" : "receipt";
  return (
    <Modal
      title={local ? t.localReceipt : t.receipt}
      close={state === "open" ? onBack : onNext}
      closeLabel={t.close}
    >
      <div className="receipt">
        <ReceiptDocument
          order={order}
          session={session}
          locale={locale}
          kind={kind}
          reprint={reprint}
          label={label}
          labelHint={labelHint}
          header={header}
          footer={footer}
        />
      </div>
      <p className="muted tiny">{t.receiptPrintHint}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row wrap">
        <label className="field compact-field">
          <span>{t.servicePrintPaper}</span>
          <select
            value={settings.paper}
            onChange={(e) =>
              saveSettings({ paper: e.target.value as PaperWidth })
            }
          >
            <option value="80">{t.servicePrintPaper80}</option>
            <option value="58">{t.servicePrintPaper58}</option>
          </select>
        </label>
        <Button
          onClick={() => {
            if (!local) void auditPrint(order.id, "receipt", reprint);
            void printDocument(
              <ReceiptDocument
                order={order}
                session={session}
                locale={locale}
                kind={kind}
                reprint={reprint}
                label={label}
                labelHint={labelHint}
                header={header}
                footer={footer}
              />,
              settings.paper,
            );
          }}
        >
          {t.print}
        </Button>
        {state === "paid" && onRelease && (
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await onRelease();
              } catch (e) {
                setError(translateError((e as Error).message, locale));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t.serviceReleaseTable}
          </Button>
        )}
        {noteActions}
        {extraActions}
        <Button
          variant="primary"
          disabled={busy}
          onClick={state === "open" ? onBack : onNext}
        >
          {state === "open" ? t.back : t.nextSale}
        </Button>
      </div>
    </Modal>
  );
}
