// Finanzas › Kiosco (039, §6.3; critic R27): the period's kiosk orders and how they were paid,
// card charges approved without an order and how they ended, and the suggestion lines guests
// accepted. One statement per block, bounded by business date; read from reports' snapshot.
//
// KIOSK-OPS-3: «Pagados en el kiosco» and «Pagados en caja» count by payment, never by who
// accepted the hold: an order with a tender from a kiosk card charge (payment_attempts.target
// 'kiosk_hold') was paid at the kiosk; an order with any other tender (cash, a manual or POS
// terminal) was paid at the counter. An order paid partly each way («Aceptar con el pago del
// kiosco» with a rest) counts in both; an accepted order nobody collected counts in neither.
// «Pedidos del kiosco» are kiosk orders with a total above zero by the order's business date, as
// Por canal counts them.
import type { Tx } from "./db.js";
import { managers, permit } from "./auth.js";
import type { Session } from "../shared/domain.js";
import { LIMITS, parseRange } from "../shared/reports.js";

export type KioskReport = {
  from: string;
  to: string;
  orders: number;
  paidAtKiosk: number;
  paidAtCounter: number;
  review: {
    open: number;
    resolved: number;
    refunded: number;
    refundedAmount: number;
  };
  suggestions: { lines: number; amount: number };
};

export async function kioskReport(
  tx: Tx,
  s: Session,
  raw: { from?: unknown; to?: unknown },
): Promise<KioskReport> {
  permit(s, managers);
  const { from, to } = parseRange(raw, LIMITS.aggregateDays);
  const [holds] = await tx`select
      count(*) filter (where k.total>0)::int as orders,
      count(*) filter (where k.at_kiosk)::int as kiosk,
      count(*) filter (where k.at_counter)::int as counter
    from (select o.total,
        exists(select 1 from tenders t
          join payment_attempts a on a.tenant_id=t.tenant_id and a.id=t.attempt_id
          where t.tenant_id=o.tenant_id and t.order_id=o.id and a.target='kiosk_hold') as at_kiosk,
        exists(select 1 from tenders t
          left join payment_attempts a on a.tenant_id=t.tenant_id and a.id=t.attempt_id
          where t.tenant_id=o.tenant_id and t.order_id=o.id
            and a.target is distinct from 'kiosk_hold') as at_counter
      from orders o
      where o.channel='kiosk' and o.business_date between ${from}::date and ${to}::date) k`;
  const [review] = await tx`select
      count(*) filter (where a.state='review')::int as open,
      count(*) filter (where a.state in ('settled','dismissed')
        and exists(select 1 from payment_attempt_events e where e.tenant_id=a.tenant_id
          and e.attempt_id=a.id and e.kind='review'))::int as resolved,
      count(*) filter (where a.resolution='refunded_at_provider')::int as refunded,
      coalesce(sum(a.amount) filter (where a.resolution='refunded_at_provider'),0)::int as refunded_amount
    from payment_attempts a join public_order_holds h on h.tenant_id=a.tenant_id and h.id=a.hold_id
    where a.target='kiosk_hold' and h.business_date between ${from}::date and ${to}::date`;
  // Suggestion lines of accepted holds, priced from what acceptance charged, excluded lines out.
  const [sugg] =
    await tx`select count(*)::int as lines, coalesce(sum((al->>'total')::int),0)::int as amount
    from public_order_holds h
    cross join lateral jsonb_array_elements(h.lines) l
    join lateral jsonb_array_elements(h.accepted_lines) al on al->>'id' = l->>'id'
    where h.channel='kiosk' and h.state='accepted' and l->>'origin'='suggestion'
      and not ((l->>'id')::uuid = any(h.excluded_line_ids))
      and h.business_date between ${from}::date and ${to}::date`;
  return {
    from,
    to,
    orders: holds.orders,
    paidAtKiosk: holds.kiosk,
    paidAtCounter: holds.counter,
    review: {
      open: review.open,
      resolved: review.resolved,
      refunded: review.refunded,
      refundedAmount: review.refunded_amount,
    },
    suggestions: { lines: sugg.lines, amount: sugg.amount },
  };
}
