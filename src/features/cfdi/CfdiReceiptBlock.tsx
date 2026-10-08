/**
 * The printed ticket's self-invoicing block (spec §2.12), rendered in fiscal's footer `extra` slot
 * (setFiscalFooterExtra, cfdi-rebase S32). It REPLACES fiscal's line "¿Necesitas factura? Pídela
 * con el folio {folio}." only when CFDI is enabled; the slot function returns null otherwise (and
 * for pre-bills), so fiscal's own line survives. Pure render from the cached status: it prints
 * offline. Printed text is Spanish regardless of the UI language (fiscal D10).
 *
 * The printed deadline is the one the portal enforces (LD-51 F1): the restaurant's policy, or,
 * while the portal does not reissue globals, the moment the ticket's global is built (its period's
 * close + the worker's grace) when that comes first, with the time whenever it is not the policy's
 * end of day (LD-55 CFDIFIX-FISCAL-1) or falls on the purchase day or the next; a self-invoicing
 * change that waits counts as the portal counts it (effectiveSelfInvoiceDeadline's pending,
 * CFDIFIX-FISCAL-5). A deadline already past when the receipt prints (a check of yesterday's business
 * date paid after its daily global was built, or a reprint) is not printed: the portal would
 * refuse the code, so the receipt says to ask at the counter (CFDIFIX-11).
 */
import type { ReactNode } from "react";
import type { Locale, Order } from "../../../shared/domain";
import {
  effectiveSelfInvoiceDeadline,
  formatTicketCode,
  globalBuildAt,
  type CfdiStatusView,
} from "../../../shared/cfdi";
import type { FiscalTicketView } from "../../../shared/fiscal";
import type { ReceiptKind } from "../Receipt";
import { getCfdiStatus } from "./status";
import { deadlineText, t } from "./format";
import { SelfInvoiceQr } from "./SelfInvoiceQr";
import "./cfdi.css";

/** Printed comprobantes are Spanish (fiscal D10). */
const PRINT: Locale = "es";

export function CfdiReceiptBlock({
  ticket,
  status,
  kind,
  origin,
  now = Date.now(),
}: {
  ticket: FiscalTicketView | null;
  status: CfdiStatusView;
  kind: ReceiptKind;
  /** The app's origin ("https://pos.example.com"): the QR opens {origin}/f/{CODE}. */
  origin: string;
  /** The print instant (ms): a deadline already past prints "Pídela en caja". */
  now?: number;
}) {
  const host = origin.replace(/^https?:\/\//, "");
  const test =
    status.mode === "test" ? ` ${t(PRINT, "cfdiReceiptTestMode")}` : "";
  if (kind === "local" || !ticket)
    return (
      <div className="cfdi-receipt-block">
        <p>{t(PRINT, "cfdiReceiptOffline")}</p>
      </div>
    );
  // The QR only where the portal offers self-invoicing: an organization that is ready, as in
  // selfInvoiceOffered (CFDI-UX-12); otherwise "Pídela en caja". selfInvoiceOffered also checks the
  // certificate (CFDI-INT-4): it answers a live status page, while a printed ticket outlives a
  // certificate renewal.
  const askCashier = (
    <div className="cfdi-receipt-block">
      <p>
        {t(PRINT, "cfdiReceiptAskCashier", { folio: ticket.folio })}
        {test}
      </p>
    </div>
  );
  if (!status.selfInvoice?.enabled || !status.ready) return askCashier;
  const bound = status.selfInvoice.globalBound;
  const pending = status.selfInvoice.pending;
  const { deadline } = effectiveSelfInvoiceDeadline(ticket.businessDate, {
    policy: status.selfInvoice.policy,
    days: status.selfInvoice.days,
    timezone: status.timezone,
    global: bound
      ? {
          globalAt: globalBuildAt(ticket.businessDate, bound, status.timezone),
        }
      : null,
    pending: pending
      ? {
          policy: pending.policy,
          days: pending.days,
          global: pending.globalBound
            ? {
                globalAt: globalBuildAt(
                  ticket.businessDate,
                  pending.globalBound,
                  status.timezone,
                ),
              }
            : null,
          fromAt: pending.fromAt,
        }
      : null,
  });
  if (Date.parse(deadline) <= now) return askCashier;
  const url = `${host}/factura`;
  return (
    <div className="cfdi-receipt-block">
      <SelfInvoiceQr
        value={`${origin}/f/${ticket.selfInvoiceCode}`}
        title={t(PRINT, "cfdiQrTitle")}
      />
      <div className="cfdi-receipt-text">
        <strong>
          {t(PRINT, "cfdiReceiptNeedInvoice")}
          {test}
        </strong>
        <span>{t(PRINT, "cfdiReceiptScan", { url })}</span>
        <span>
          {t(PRINT, "cfdiReceiptCode", {
            code: formatTicketCode(ticket.selfInvoiceCode),
          })}
        </span>
        <span>
          {t(PRINT, "cfdiReceiptDeadline", {
            date: deadlineText(
              deadline,
              ticket.businessDate,
              status.timezone,
              PRINT,
            ),
          })}
        </span>
      </div>
    </div>
  );
}

/**
 * The footer `extra` slot. Returns null (never an element that renders nothing) when CFDI is not
 * available or enabled, or for a pre-bill, so fiscal prints its own "Pídela con el folio" line.
 */
export function cfdiReceiptExtra(p: {
  order: Order;
  kind: ReceiptKind;
  reprint: boolean;
  locale: Locale;
}): ReactNode {
  const status = getCfdiStatus();
  if (!status?.available || !status.enabled || p.kind === "check") return null;
  const ticket = p.order.fiscal?.ticket ?? null;
  if (p.kind !== "local" && !ticket) return null;
  const origin =
    typeof location === "undefined"
      ? "https://pos.example.com"
      : location.origin;
  return (
    <CfdiReceiptBlock
      ticket={ticket}
      status={status}
      kind={p.kind}
      origin={origin}
    />
  );
}
