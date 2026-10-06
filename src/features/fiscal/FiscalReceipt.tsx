// The fiscal blocks of every receipt (fiscal 027, docs/FISCAL.md "The printed ticket"):
// the issuer, folio and date of issue at the top, the IVA breakdown and the legends at the
// bottom. Registered once with service's receipt slots (installFiscalReceipt), so the receipt
// modal, its print, the pre-bill, reprints and local receipts all carry them. Comprobantes
// print in Spanish: print call sites pass locale "es" (D10).
import type { ReactNode } from "react";
import type { Order } from "../../../shared/domain";
import type { TaxGroup } from "../../../shared/fiscal";
import { lineRemaining } from "../../../shared/settlement";
import { strings, type Key } from "../../i18n";
import { moneyFormatter, setReceiptSlots, type ReceiptSlot } from "../Receipt";
import { fiscalRestaurant, useFiscalContext } from "./context";
import { fill, fiscalDateTime, rateLabel } from "./format";
import "./fiscal.css";

export type FiscalReceiptProps = Parameters<ReceiptSlot>[0];

const restaurantOf = (order: Order) => ({
  currency:
    order.restaurantSnapshot?.currency ?? fiscalRestaurant()?.currency ?? "MXN",
  timezone:
    order.restaurantSnapshot?.timezone ??
    fiscalRestaurant()?.timezone ??
    "America/Mexico_City",
  name: order.restaurantSnapshot?.name ?? fiscalRestaurant()?.name ?? "",
});
/** Case- and accent-insensitive comparison of the razón social and the trade name. */
const sameName = (a: string, b: string) =>
  a.localeCompare(b, "es", { sensitivity: "base" }) === 0;

function Amount({ label, amount }: { label: string; amount: string }) {
  return (
    <div className="fiscal-row">
      <span>{label}</span>
      <span className="fiscal-amount">{amount}</span>
    </div>
  );
}

/**
 * Issuer, folio and date of issue, or why the receipt has no folio. Nothing on a pre-bill. A
 * synced offline sale names its provisional number and sale time, the only things on the
 * customer's local receipt (FISCAL-OFFLINE-1). A ticket whose order has no lines left (a
 * financial-only recovery) prints the ticket's frozen lines, so the comprobante always states
 * quantity and description (FISCAL-OFFLINE-2).
 */
export function FiscalReceiptHeader({
  order,
  kind,
  locale,
}: FiscalReceiptProps) {
  const context = useFiscalContext();
  if (kind === "check") return null;
  const t = strings[locale];
  const restaurant = restaurantOf(order);
  const ticket = order.fiscal?.ticket ?? null;
  if (!ticket && restaurant.currency !== "MXN") return null;
  const issuer = ticket ? ticket.issuer : (context?.issuer ?? null);
  // Without a ticket, the issuer comes from the context: unknown until it loads.
  const known = !!ticket || !!context;
  const tradeName = ticket?.issuer?.tradeName ?? restaurant.name;
  const status = ticket
    ? null
    : kind === "local"
      ? // A partial local payment (offline table service) issues no folio at sync.
        order.paid < order.total
        ? t.fiscalReceiptPartial
        : t.fiscalReceiptPending
      : order.total > 0 && order.paid >= order.total
        ? t.fiscalReceiptNoFolio
        : order.paid > 0
          ? t.fiscalReceiptPartial
          : null;
  const address = issuer
    ? [
        issuer.address.street,
        issuer.address.neighborhood,
        issuer.address.municipality,
        issuer.address.state,
      ]
        .filter((part) => part.trim())
        .join(", ")
    : "";
  const offline =
    kind !== "local" && order.offline?.provisionalNumber
      ? fill(t.fiscalOfflineSale, {
          number: order.offline.provisionalNumber,
          date: fiscalDateTime(
            order.offline.soldAt,
            restaurant.timezone,
            locale,
          ),
        })
      : null;
  const frozenLines =
    ticket &&
    ticket.lines.length > 0 &&
    !order.lines.some((l) => lineRemaining(l).quantity > 0)
      ? ticket.lines
      : [];
  const money = moneyFormatter(restaurant.currency, locale);
  if (!issuer && !known && !status && !offline) return null;
  return (
    <div className="fiscal-header">
      {issuer ? (
        <>
          {!sameName(issuer.legalName, tradeName) && (
            <p className="fiscal-legal-name">{issuer.legalName}</p>
          )}
          <p>{fill(t.fiscalReceiptRfc, { rfc: issuer.rfc })}</p>
          <p>
            {fill(t.fiscalReceiptRegime, {
              code: issuer.regime,
              name: issuer.regimeName[locale],
            })}
          </p>
          {address && <p>{address}</p>}
          <p>{fill(t.fiscalReceiptPlace, { cp: issuer.postalCode })}</p>
        </>
      ) : (
        known && <p className="fiscal-strong">{t.fiscalReceiptMissingIssuer}</p>
      )}
      {ticket && (
        <>
          <p className="fiscal-folio">
            {fill(t.fiscalReceiptFolio, { folio: ticket.folio })}
          </p>
          <p>
            {fill(t.fiscalReceiptIssued, {
              date: fiscalDateTime(
                ticket.issuedAt,
                restaurant.timezone,
                locale,
              ),
            })}
          </p>
        </>
      )}
      {offline && <p className="fiscal-offline-sale">{offline}</p>}
      {status && <p className="fiscal-status">{status}</p>}
      {frozenLines.length > 0 && (
        <div className="fiscal-lines">
          {frozenLines.map((l, i) => (
            <Amount
              key={l.lineId ?? i}
              label={`${l.quantity} × ${l.name[locale]}`}
              amount={money(l.gross)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One or two rows per tax category of the ticket (iva16, iva8, iva0, exempt). */
function groupRows(
  groups: TaxGroup[],
  t: Record<Key, string>,
  money: (n: number) => string,
) {
  return groups.flatMap((g) => {
    const rate = rateLabel(g.rateBps);
    if (g.category === "iva16" || g.category === "iva8")
      return [
        <Amount
          key={g.category + "-base"}
          label={fill(t.fiscalReceiptBase, { rate })}
          amount={money(g.base)}
        />,
        <Amount
          key={g.category + "-tax"}
          label={fill(t.fiscalReceiptTax, { rate })}
          amount={money(g.tax)}
        />,
      ];
    return [
      <Amount
        key={g.category}
        label={
          g.category === "iva0" ? t.fiscalReceiptZero : t.fiscalReceiptExempt
        }
        amount={money(g.gross)}
      />,
    ];
  });
}

/**
 * The IVA breakdown and legends: the ticket's frozen groups (and refunded IVA), the pre-bill's
 * provisional IVA, or only "Precios con IVA incluido" before the ticket. `extra` is cfdi's
 * block (setFiscalFooterExtra); without it the footer offers invoicing by folio.
 */
export function FiscalReceiptFooter({
  order,
  kind,
  locale,
  extra,
}: FiscalReceiptProps & { extra?: ReactNode }) {
  const t = strings[locale];
  const restaurant = restaurantOf(order);
  if (restaurant.currency !== "MXN") return null;
  const money = moneyFormatter(restaurant.currency, locale);
  const ticket = order.fiscal?.ticket ?? null;
  if (kind === "check") {
    const taxed = (order.fiscal?.provisional?.groups ?? []).filter(
      (g) => g.tax > 0,
    );
    return (
      <div className="fiscal-footer">
        {taxed.length > 0 && (
          <div className="fiscal-taxes">
            <p className="fiscal-strong">{t.fiscalReceiptCheckTax}</p>
            {taxed.map((g) => (
              <Amount
                key={g.category}
                label={fill(t.fiscalReceiptTax, { rate: rateLabel(g.rateBps) })}
                amount={money(g.tax)}
              />
            ))}
          </div>
        )}
        <p>{t.fiscalReceiptIncluded}</p>
      </div>
    );
  }
  if (!ticket)
    return (
      <div className="fiscal-footer">
        <p>{t.fiscalReceiptIncluded}</p>
        {/* cfdi (030): a local (offline) receipt's "ask for it once synced" line (CFDI-UX-6). */}
        {kind === "local" ? extra : null}
      </div>
    );
  const refunds = order.fiscal?.refunds ?? [];
  const refundedTax = refunds.reduce(
    (a, r) => a + r.groups.reduce((b, g) => b + g.tax, 0),
    0,
  );
  return (
    <div className="fiscal-footer">
      <div className="fiscal-taxes">
        {groupRows(ticket.groups, t, money)}
        {refunds.length > 0 && (
          <Amount
            label={t.fiscalReceiptRefundTax}
            amount={"−" + money(refundedTax)}
          />
        )}
      </div>
      <p>{t.fiscalReceiptIncluded}</p>
      {ticket.tip > 0 && <p>{t.fiscalReceiptTip}</p>}
      <p>{t.fiscalReceiptNotCfdi}</p>
      {extra ?? (
        <p>{fill(t.fiscalReceiptInvoiceHint, { folio: ticket.folio })}</p>
      )}
    </div>
  );
}

let footerExtra: ReceiptSlot | null = null;
/** cfdi (030) registers its ticket block here; it prints in Spanish. Null removes it. */
export function setFiscalFooterExtra(slot: ReceiptSlot | null) {
  footerExtra = slot;
}

/**
 * Registers the fiscal header and footer with service's receipt slots (idempotent). Fiscal is
 * the only area that calls setReceiptSlots, with both slots (LD-16 C7).
 */
export function installFiscalReceipt() {
  setReceiptSlots({
    header: (p) => <FiscalReceiptHeader {...p} />,
    footer: (p) => <FiscalReceiptFooter {...p} extra={footerExtra?.(p)} />,
  });
}
