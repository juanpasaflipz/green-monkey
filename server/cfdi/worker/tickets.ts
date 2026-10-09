/**
 * Fiscal tickets as the global builder reads them (spec §4.8.6 step 4.2): fiscal's per-category
 * figures (fiscal_ticket_taxes) net of the order's refund adjustments (fiscal_adjustments), never
 * recomputed. Batched, 1,000 tickets per statement. Worker only.
 */
import type { Tx } from "../../db.js";
import { DomainError } from "../../../shared/domain.js";
import { formatFolio, type TaxCategory } from "../../../shared/fiscal.js";
import { netGroups, type GlobalTicket } from "../build.js";

export type LoadedTicket = GlobalTicket & {
  orderId: string;
  gross: number;
  refundIds: string[];
};
export type ExcludedTicket = { id: string; folio: string; code: string };

const BATCH = 1000;

type Row = {
  id: string;
  order_id: string;
  series: string;
  number: string | number;
  gross: number;
  payments: { method: string; amount: number; at?: string; cardType?: string }[];
  groups: { category: TaxCategory; gross: number; tax: number }[];
  adjustments: {
    refundId: string;
    category: TaxCategory;
    gross: number;
    tax: number;
  }[];
};

/**
 * Tickets by id with their net groups. A ticket whose figures fiscal's rules refuse (for example
 * a pre-ticket refund that nets a category below zero) is returned in `excluded` with the code, so
 * one bad ticket never blocks a whole period's global invoice.
 */
export async function loadTickets(
  tx: Tx,
  ids: readonly string[],
): Promise<{ tickets: LoadedTicket[]; excluded: ExcludedTicket[] }> {
  const tickets: LoadedTicket[] = [];
  const excluded: ExcludedTicket[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const rows = await tx<Row[]>`
      select t.id, t.order_id, t.series, t.number, t.gross, t.payments,
        coalesce((select jsonb_agg(jsonb_build_object('category', c.category, 'gross', c.gross, 'tax', c.tax)
            order by c.category)
          from fiscal_ticket_taxes c where c.tenant_id = t.tenant_id and c.ticket_id = t.id), '[]') as groups,
        coalesce((select jsonb_agg(jsonb_build_object('refundId', a.refund_id, 'category', a.category,
            'gross', a.gross, 'tax', a.tax) order by a.created_at, a.refund_id, a.category)
          from fiscal_adjustments a where a.tenant_id = t.tenant_id and a.order_id = t.order_id), '[]') as adjustments
      from fiscal_tickets t where t.id = any(${batch as string[]}::uuid[])`;
    for (const r of rows) {
      const folio = formatFolio(r.series, Number(r.number));
      const byRefund = new Map<
        string,
        { category: TaxCategory; gross: number; tax: number }[]
      >();
      for (const a of r.adjustments) {
        const list = byRefund.get(a.refundId) ?? [];
        list.push({ category: a.category, gross: a.gross, tax: a.tax });
        byRefund.set(a.refundId, list);
      }
      try {
        const groups = netGroups(
          r.groups,
          [...byRefund].map(([refundId, groups]) => ({ refundId, groups })),
        );
        const payments = [...(r.payments ?? [])]
          .sort((a, b) =>
            (a.at ?? "") < (b.at ?? "")
              ? -1
              : (a.at ?? "") > (b.at ?? "")
                ? 1
                : 0,
          )
          .map((p) => ({
            method: p.method,
            amount: p.amount,
            // payments (037): the card type decides 04/28 when an integrated terminal knew it.
            ...(p.cardType ? { cardType: p.cardType } : {}),
          }));
        tickets.push({
          id: r.id,
          orderId: r.order_id,
          folio,
          gross: r.gross,
          groups,
          payments,
          refundIds: [...byRefund.keys()],
        });
      } catch (e) {
        if (!(e instanceof DomainError)) throw e;
        excluded.push({ id: r.id, folio, code: e.code });
      }
    }
  }
  return { tickets, excluded };
}
