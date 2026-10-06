/**
 * The CFDI actions of a paid order (spec §2.5): the ticket's invoice chip, **Facturar** and the
 * InvoiceDialog. Rendered by service's OrderDetail (variant "detail") and the receipt modal after
 * payment (variant "receipt"). Nothing renders unless the cached status says this employee can
 * invoice and fiscal's view of the order is present. Online comes from the `online` prop (wave
 * rule 0.8) or, when the caller does not pass it, the connectivity store; never navigator.onLine.
 */
import { useCallback, useEffect, useState } from "react";
import { FileText } from "lucide-react";
import type { Locale, Order, Session } from "../../../shared/domain";
import type { CfdiTicketView } from "../../../shared/cfdi";
import { api } from "../../api";
import { useConnectivity } from "../../connectivity";
import { strings } from "../../i18n";
import { Badge, Button } from "../../components/ui";
import { useCfdiStatus } from "./status";
import { InvoiceDialog } from "./InvoiceDialog";
import { periodKeyLabel, t as tr } from "./format";

/** The chip text and tone for a ticket view (spec §2.5 table). */
export function ticketChip(
  v: CfdiTicketView,
  locale: Locale,
): { text: string; tone: string } {
  const c = v.covering;
  if (c?.status === "valid" && c.kind === "invoice")
    return {
      text: tr(locale, "cfdiChipInvoiced", { doc: c.label }),
      tone: "green",
    };
  if (c?.status === "valid" && c.kind === "global")
    return {
      text: tr(locale, "cfdiChipGlobal", {
        period: periodKeyLabel(c.periodKey, locale),
      }),
      tone: "green",
    };
  if (v.eligibility === "invoicing")
    return { text: tr(locale, "cfdiChipInvoicing"), tone: "amber" };
  if (v.eligibility === "global_in_progress")
    return { text: tr(locale, "cfdiChipGlobalProgress"), tone: "amber" };
  if (v.eligibility === "fully_refunded")
    return { text: tr(locale, "cfdiChipRefunded"), tone: "neutral" };
  return { text: tr(locale, "cfdiChipNone"), tone: "neutral" };
}

/**
 * The ticket's invoice chip. ARIA 1.2 prohibits naming a generic span (screen readers ignore an
 * aria-label there), so its label is visually hidden text read before the badge (CFDI-R2-7).
 */
export function TicketChip({
  view,
  locale,
}: {
  view: CfdiTicketView;
  locale: Locale;
}) {
  const chip = ticketChip(view, locale);
  return (
    <span>
      <span className="sr-only">{strings[locale].cfdiChipLabel}: </span>
      <Badge tone={chip.tone}>{chip.text}</Badge>
    </span>
  );
}

export function CfdiOrderActions({
  order,
  session,
  locale,
  variant,
  online,
}: {
  order: Order;
  session: Session;
  locale: Locale;
  variant: "detail" | "receipt";
  online?: boolean;
}) {
  const status = useCfdiStatus();
  const connectivity = useConnectivity();
  const canUseServer = online ?? connectivity.canUseServer;
  const ticket = order.fiscal?.ticket ?? null;
  const visible = !!status?.canInvoice && order.state !== "local";
  const ticketId = visible ? (ticket?.id ?? null) : null;
  const [view, setView] = useState<CfdiTicketView | null>(null);
  const [open, setOpen] = useState(false);
  const t = strings[locale];

  const load = useCallback(
    (signal?: AbortSignal) => {
      if (!ticketId) return;
      api<CfdiTicketView>(
        `/cfdi/tickets/${encodeURIComponent(ticketId)}`,
        undefined,
        {
          signal,
        },
      )
        .then((v) => {
          if (!signal?.aborted) setView(v);
        })
        .catch(() => {
          // The chip is informative only; the dialog shows errors.
          if (!signal?.aborted) setView(null);
        });
    },
    [ticketId],
  );
  useEffect(() => {
    if (!ticketId || !canUseServer) return;
    const abort = new AbortController();
    load(abort.signal);
    return () => abort.abort();
  }, [ticketId, canUseServer, load]);

  if (!visible || !order.fiscal) return null;
  if (!ticket)
    return order.paid > 0 ? (
      <p className={`muted tiny cfdi-order-actions ${variant}`}>
        {t.cfdiNoTicket}
      </p>
    ) : null;
  return (
    <div className={`cfdi-order-actions ${variant}`}>
      {view && <TicketChip view={view} locale={locale} />}
      {view?.mode === "test" && <Badge tone="amber">{t.cfdiTestBadge}</Badge>}
      <Button
        disabled={!canUseServer}
        aria-describedby={canUseServer ? undefined : `cfdi-offline-${order.id}`}
        onClick={() => setOpen(true)}
      >
        <FileText size={16} />
        {t.cfdiInvoice}
      </Button>
      {!canUseServer && (
        <span id={`cfdi-offline-${order.id}`} className="muted tiny">
          {t.cfdiNeedsConnection}
        </span>
      )}
      {open && (
        <InvoiceDialog
          ticketId={ticket.id}
          session={session}
          locale={locale}
          close={() => {
            setOpen(false);
            load();
          }}
          done={() => load()}
        />
      )}
    </div>
  );
}
