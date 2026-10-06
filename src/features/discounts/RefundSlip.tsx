import type { Locale, Order, Session } from "../../../shared/domain";
import type { RefundBatchView } from "../../../shared/discounts";
import { strings } from "../../i18n";
import { moneyFormatter } from "../Receipt";
import { fill, lineLabel, reasonLabel } from "./format";

/**
 * "Comprobante de reembolso" (§2.5), printed through printDocument at 58/80 mm.
 * A customer-facing comprobante: every print call passes locale="es" whatever
 * the UI language. For a público-en-general ticket it carries what LIVA art. 7
 * asks of a restitution (amount and IVA apart, and the original ticket); for
 * an invoiced sale the formal document is the CFDI de egreso (cfdi 030). The
 * folio and IVA lines come from fiscal's order.fiscal (027) and are left out
 * when it has none (a non-MXN restaurant).
 */
export function RefundSlip({
  order,
  batch,
  session,
  locale,
}: {
  order: Order;
  batch: RefundBatchView;
  session: Session;
  locale: Locale;
}) {
  const t = strings[locale];
  const restaurant = order.restaurantSnapshot ?? session.restaurant;
  const money = moneyFormatter(restaurant.currency, locale);
  const fiscal = order.fiscal;
  const refundIds = new Set(batch.rows.map((r) => r.refundId));
  const taxes = (fiscal?.refunds ?? [])
    .filter((r) => refundIds.has(r.refundId))
    .flatMap((r) => r.groups);
  const base = taxes.reduce((n, g) => n + g.base, 0);
  const tax = taxes.reduce((n, g) => n + g.tax, 0);
  const when = new Date(batch.createdAt).toLocaleString(
    locale === "es" ? "es-MX" : "en-US",
    {
      timeZone: restaurant.timezone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    },
  );
  const cash = batch.rows.filter((r) => r.method === "cash");
  return (
    <div className="receipt-doc refund-slip">
      <h2 className="doc-title">{restaurant.name}</h2>
      <p className="doc-flag">{t.discountsSlipTitle}</p>
      <p>
        {fill(t.discountsSlipOrder, { n: order.number, date: when })}
        {fiscal?.ticket?.folio && (
          <>
            <br />
            {fill(t.discountsSlipOriginalFolio, { folio: fiscal.ticket.folio })}
          </>
        )}
      </p>
      {batch.lines.map((l) => {
        const line = order.lines.find((x) => x.id === l.lineId);
        return (
          <div className="row between" key={l.id}>
            <span>
              {fill(t.discountsRefundUnits, {
                n: l.units.length,
                name: lineLabel(line, locale),
              })}
            </span>
            <span>{money(l.amount)}</span>
          </div>
        );
      })}
      <hr />
      {cash.length > 0 && (
        <div className="row between">
          <span>{t.cashMethod}</span>
          <span>{money(cash.reduce((n, r) => n + r.amount, 0))}</span>
        </div>
      )}
      {batch.rows
        .filter((r) => r.method === "external")
        .map((r) => (
          <div className="row between" key={r.refundId}>
            <span>
              {r.reference
                ? fill(t.discountsSlipTerminalRef, { ref: r.reference })
                : t.external}
            </span>
            <span>{money(r.amount)}</span>
          </div>
        ))}
      <div className="row between doc-total">
        <span>{t.discountsSlipTotal}</span>
        <strong>{money(batch.amount)}</strong>
      </div>
      {taxes.length > 0 && (
        <p>
          {fill(t.discountsSlipTax, { base: money(base), tax: money(tax) })}
        </p>
      )}
      <p>
        {fill(t.discountsSlipReason, {
          reason: reasonLabel("refund", batch.reasonCode, locale),
        })}
        {batch.note && ` · "${batch.note}"`}
      </p>
      <p>
        {fill(t.discountsSlipBy, {
          actor: batch.actorName,
          approver: batch.approverName,
        })}
      </p>
      <p>{t.discountsSlipSignature}</p>
      <p className="tiny">{t.discountsSlipNotCfdi}</p>
    </div>
  );
}
