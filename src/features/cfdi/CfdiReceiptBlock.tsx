/**
 * The printed ticket's self-invoicing block (spec §2.12), rendered in fiscal's footer `extra` slot
 * (setFiscalFooterExtra, cfdi-rebase S32). It REPLACES fiscal's line "¿Necesitas factura? Pídela
 * con el folio {folio}." only when CFDI is enabled; the slot function returns null otherwise (and
 * for pre-bills), so fiscal's own line survives. Pure render from the cached status: it prints
 * offline. Printed text is Spanish regardless of the UI language (fiscal D10).
 */
import type { ReactNode } from "react";
import type { Locale, Order } from "../../../shared/domain";
import {
  formatTicketCode,
  selfInvoiceDeadline,
  type CfdiStatusView,
} from "../../../shared/cfdi";
import type { FiscalTicketView } from "../../../shared/fiscal";
import type { ReceiptKind } from "../Receipt";
import { getCfdiStatus } from "./status";
import { shortDate, t } from "./format";
import { SelfInvoiceQr } from "./SelfInvoiceQr";
import "./cfdi.css";

/** Printed comprobantes are Spanish (fiscal D10). */
const PRINT: Locale = "es";

export function CfdiReceiptBlock({
  ticket,
  status,
  kind,
  origin,
}: {
  ticket: FiscalTicketView | null;
  status: CfdiStatusView;
  kind: ReceiptKind;
  /** The app's origin ("https://pos.example.com"): the QR opens {origin}/f/{CODE}. */
  origin: string;
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
  if (!status.selfInvoice?.enabled)
    return (
      <div className="cfdi-receipt-block">
        <p>
          {t(PRINT, "cfdiReceiptAskCashier", { folio: ticket.folio })}
          {test}
        </p>
      </div>
    );
  const deadline = selfInvoiceDeadline(
    ticket.businessDate,
    status.selfInvoice.policy,
    status.selfInvoice.days,
    status.timezone,
  );
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
            date: shortDate(deadline, status.timezone, PRINT),
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
