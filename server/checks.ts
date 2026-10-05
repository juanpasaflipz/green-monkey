import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import type { Tx } from "./db.js";
import { randomUUID } from "node:crypto";
import { permit, operators } from "./auth.js";
import { audit, getOrder, once, recordPayment } from "./orders.js";
import { bumpKitchenFeed } from "./kitchen.js";
import {
  DomainError,
  businessDate,
  id,
  money,
  type Order,
  type Session,
} from "../shared/domain.js";
import {
  ORDER_PAGE_MAX,
  decodeCursor,
  encodeCursor,
  holdsTable,
  type CheckState,
  type CloseReason,
  type OrderListResponse,
  type OrderSummary,
  type TableOccupancy,
} from "../shared/service.js";

/**
 * Commands that change a check call this on the locked order row. Recovery
 * orders keep their historical stale_order code; closed checks (and legacy
 * cancelled orders) reject with check_closed.
 */
export function assertCheckWritable(o: { check_state: string; state: string }) {
  if (o.state === "recovery_pending" || o.state === "recovery_reviewed")
    throw new DomainError("stale_order", 409);
  if (o.check_state === "closed" || o.state === "cancelled")
    throw new DomainError("check_closed", 409);
}

const today = (s: Session) =>
  businessDate(
    new Date().toISOString(),
    s.restaurant.timezone,
    s.restaurant.cutoff,
  );

async function close(
  tx: Tx,
  s: Session,
  orderId: string,
  reason: CloseReason,
  money: { total: number; paid: number },
) {
  await tx`update orders set check_state='closed',closed_at=clock_timestamp(),
    closed_by=${s.employeeId},close_reason=${reason} where id=${orderId}`;
  await audit(tx, s, "check.closed", orderId, { reason, ...money });
}

/**
 * Recomputes the financial state after any write that changes the total,
 * tenders, lines, voids, mode or table. The caller already holds FOR UPDATE on
 * the order row.
 */
export async function refreshCheckState(
  tx: Tx,
  s: Session,
  orderId: string,
): Promise<CheckState> {
  const [o] =
    await tx`select o.mode,o.table_id,o.channel,o.total,o.state,o.check_state,
      coalesce((select sum(t.amount) from tenders t where t.tenant_id=o.tenant_id and t.order_id=o.id),0)::int as paid,
      (select count(*) from order_lines l where l.tenant_id=o.tenant_id and l.order_id=o.id)::int as lines,
      (select count(*) from order_lines l where l.tenant_id=o.tenant_id and l.order_id=o.id
         and (l.data->>'quantity')::int <= coalesce((select sum(cardinality(v.units)) from line_voids v
           where v.tenant_id=l.tenant_id and v.line_id=l.id),0))::int as voided_lines
    from orders o where o.id=${orderId}`;
  if (!o) throw new DomainError("not_found", 404);
  if (o.check_state === "closed" || String(o.state).startsWith("recovery"))
    return "closed";
  const money = { total: o.total as number, paid: o.paid as number };
  if (o.lines > 0 && o.voided_lines === o.lines && o.paid === 0) {
    await close(tx, s, orderId, "voided", money);
    return "closed";
  }
  if (o.lines > 0 && o.total - o.paid <= 0) {
    if (
      holdsTable(
        o as { mode: string; table_id: string | null; channel: string },
      )
    ) {
      if (o.check_state !== "paid")
        await tx`update orders set check_state='paid' where id=${orderId}`;
      return "paid";
    }
    await close(tx, s, orderId, "settled", money);
    return "closed";
  }
  if (o.check_state === "paid") {
    await tx`update orders set check_state='open' where id=${orderId}`;
    return "open";
  }
  return o.check_state as CheckState;
}

const closeInput = z.object({ operationId: id }).strict();
/** Cerrar cuenta / Liberar mesa: closes a check whose balance is zero. */
export async function closeCheck(
  tx: Tx,
  s: Session,
  orderId: string,
  raw: unknown,
): Promise<Order> {
  permit(s, operators);
  const p = closeInput.parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "check.close",
    { orderId, ...p },
    async () => {
      const [o] = await tx`select * from orders where id=${orderId} for update`;
      if (!o) throw new DomainError("not_found", 404);
      if (o.check_state === "closed") return getOrder(tx, orderId);
      if (String(o.state).startsWith("recovery"))
        throw new DomainError("stale_order", 409);
      const [m] =
        await tx`select coalesce(sum(amount),0)::int as paid from tenders where order_id=${orderId}`;
      if (o.total - m.paid > 0) throw new DomainError("balance_due", 409);
      await close(tx, s, orderId, "released", { total: o.total, paid: m.paid });
      return getOrder(tx, orderId);
    },
  );
}

const settlementInput = z
  .object({
    operationId: id,
    orders: z
      .array(z.object({ id, amount: money.refine((n) => n > 0) }))
      .min(2)
      .max(20),
    received: money,
  })
  .strict();
/**
 * Grouped cash settlement ("Cobrar juntas"), moved from index.ts. Every order
 * row is locked up front, sorted by id, before any drawer lock: interleaving
 * order and drawer locks deadlocked against single payments (global lock
 * order: orders, then the drawer).
 */
export async function recordSettlement(tx: Tx, s: Session, raw: unknown) {
  permit(s, operators);
  const p = settlementInput.parse(raw);
  return once(tx, s, p.operationId, "settlement", p, async () => {
    if (new Set(p.orders.map((o) => o.id)).size !== p.orders.length)
      throw new DomainError("invalid_split");
    const total = p.orders.reduce((a, o) => a + o.amount, 0);
    if (total > p.received) throw new DomainError("insufficient_cash");
    await tx`select id from orders where id = any(${tx.array(p.orders.map((o) => o.id))}::uuid[]) order by id for update`;
    const result = [];
    for (const o of [...p.orders].sort((a, b) => a.id.localeCompare(b.id)))
      result.push(
        await recordPayment(
          tx,
          s,
          o.id,
          {
            operationId: randomUUID(),
            amount: o.amount,
            tip: 0,
            received: o.amount,
            method: "cash",
          },
          p.operationId,
        ),
      );
    await audit(tx, s, "settlement.recorded", p.operationId, {
      orders: p.orders,
      received: p.received,
      total,
      change: p.received - total,
    });
    return result;
  });
}

const noteInput = z
  .object({ operationId: id, note: z.string().trim().max(500) })
  .strict();
/** Edits the order note after sending; the kitchen feed shows it on open tickets. */
export async function updateOrderNote(
  tx: Tx,
  s: Session,
  orderId: string,
  raw: unknown,
): Promise<Order> {
  permit(s, operators);
  const p = noteInput.parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "order.note",
    { orderId, ...p },
    async () => {
      const [o] = await tx`select * from orders where id=${orderId} for update`;
      if (!o) throw new DomainError("not_found", 404);
      assertCheckWritable(o as { check_state: string; state: string });
      await tx`update orders set note=${p.note} where id=${orderId}`;
      await audit(tx, s, "order.note", orderId, {
        before: o.note,
        after: p.note,
      });
      await bumpKitchenFeed(tx, s);
      return getOrder(tx, orderId);
    },
  );
}

/**
 * FOH-11: the order that a Selling send (new order or round) with this
 * operation id produced, as it is now. Selling asks after operation_conflict,
 * when an earlier send committed but its response was lost. Only order sends
 * are visible here; other operations stay manager-only (/operations/:id).
 */
export async function orderForOperation(
  tx: Tx,
  s: Session,
  operationId: string,
): Promise<Order> {
  permit(s, operators);
  const [op] =
    await tx`select result->>'id' as order_id from operations where id=${operationId} and kind in ('create_order','round')`;
  const orderId = id.safeParse(op?.order_id);
  if (!orderId.success) throw new DomainError("not_found", 404);
  return getOrder(tx, orderId.data);
}

const printInput = z
  .object({
    operationId: id,
    document: z.enum(["receipt", "check"]),
    reprint: z.boolean(),
  })
  .strict();
/** Records a browser print of a receipt or pre-bill in the audit trail. */
export async function recordPrint(
  tx: Tx,
  s: Session,
  orderId: string,
  raw: unknown,
): Promise<{ ok: true }> {
  permit(s, operators);
  const p = printInput.parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "receipt.print",
    { orderId, ...p },
    async () => {
      const [o] = await tx`select id from orders where id=${orderId}`;
      if (!o) throw new DomainError("not_found", 404);
      await audit(
        tx,
        s,
        p.document === "check"
          ? "check.printed"
          : p.reprint
            ? "receipt.reprinted"
            : "receipt.printed",
        orderId,
        { document: p.document, reprint: p.reprint },
      );
      return { ok: true as const };
    },
  );
}

export const orderListQuery = z
  .object({
    status: z.enum(["current", "open", "closed", "all"]).default("current"),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    table: id.optional(),
    q: z.string().trim().min(1).max(80).optional(),
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(ORDER_PAGE_MAX).default(50),
  })
  .strict();

const iso = (v: unknown) =>
  v instanceof Date ? v.toISOString() : v === null ? null : String(v);

/**
 * Orders list for the Órdenes screen: one statement per page. Partial-index
 * predicates (check_state <> 'closed') are written literally so the planner
 * can use orders_open_checks; never parameterize them.
 */
export async function listOrders(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<OrderListResponse> {
  permit(s, operators);
  const q = orderListQuery.parse(raw ?? {});
  const now = today(s);
  const date = q.date ?? now;
  try {
    Temporal.PlainDate.from(date);
  } catch {
    throw new DomainError("invalid_input");
  }
  // The cursor time travels as text (created_at::text) and is cast in SQL:
  // a timestamptz parameter would pass through a JS Date and drop the
  // microseconds, skipping rows that share a millisecond.
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  const scope =
    q.status === "open"
      ? tx`o.check_state <> 'closed' ${q.date ? tx`and o.business_date = ${date}` : tx``}`
      : q.status === "closed"
        ? tx`o.check_state = 'closed' and o.business_date = ${date}`
        : q.status === "all"
          ? tx`o.business_date = ${date}`
          : tx`(o.check_state <> 'closed' or o.business_date = ${now})`;
  const term = q.q ? "%" + q.q.replace(/[\\%_]/g, (c) => "\\" + c) + "%" : null;
  const num = q.q && /^\d{1,6}$/.test(q.q) ? Number(q.q) : null;
  const rows =
    await tx`select o.id,o.number,o.business_date::text as business_date,o.created_at,
      o.created_at::text as cursor_t,o.mode,o.channel,o.table_id,t.name as table_name,
      o.name,o.note,e.name as waiter_name,o.state,o.check_state,o.closed_at,o.close_reason,
      o.total,p.paid,p.refunded,p.refundable_cash,k.open_rounds,k.ready_rounds,
      li.items,li.preview,
      exists(select 1 from offline_recoveries r where r.tenant_id=o.tenant_id and r.order_id=o.id) as recovery,
      exists(select 1 from line_voids v where v.tenant_id=o.tenant_id and v.order_id=o.id
             and v.kitchen_ack_required and v.kitchen_acknowledged_at is null) as void_ack_pending
    from orders o
    join employees e on e.tenant_id=o.tenant_id and e.id=coalesce(o.assigned_employee_id,o.employee_id)
    left join dining_tables t on t.tenant_id=o.tenant_id and t.id=o.table_id
    left join lateral (
      select coalesce(sum(tn.amount),0)::int as paid,
             coalesce(sum(rf.refunded),0)::int as refunded,
             coalesce(sum(tn.amount-rf.refunded) filter (where tn.method='cash'),0)::int as refundable_cash
      from tenders tn
      left join lateral (select coalesce(sum(r.amount),0)::int as refunded from refunds r
                         where r.tenant_id=tn.tenant_id and r.tender_id=tn.id) rf on true
      where tn.tenant_id=o.tenant_id and tn.order_id=o.id) p on true
    left join lateral (
      select count(*) filter (where r.state <> 'completed')::int as open_rounds,
             count(*) filter (where r.state = 'ready')::int as ready_rounds
      from rounds r where r.tenant_id=o.tenant_id and r.order_id=o.id) k on true
    left join lateral (
      select coalesce(sum(q.remaining),0)::int as items,
             coalesce(jsonb_agg(jsonb_build_object('quantity',q.remaining,'name',q.name)
               order by q.round, q.id) filter (where q.remaining > 0),'[]') as preview
      from (select l.id, l.round, l.data->'name' as name,
              (l.data->>'quantity')::int - coalesce((select sum(cardinality(v.units)) from line_voids v
                 where v.tenant_id=l.tenant_id and v.line_id=l.id),0) as remaining
            from order_lines l where l.tenant_id=o.tenant_id and l.order_id=o.id) q) li on true
    where ${scope}
      ${q.table ? tx`and o.table_id = ${q.table}` : tx``}
      ${
        term
          ? tx`and (o.name ilike ${term} escape '\\' or t.name ilike ${term} escape '\\'
                    or e.name ilike ${term} escape '\\' ${num !== null ? tx`or o.number = ${num}` : tx``})`
          : tx``
      }
      ${cursor ? tx`and (o.created_at, o.id) < (${cursor.t}::text::timestamptz, ${cursor.i}::uuid)` : tx``}
    order by o.created_at desc, o.id desc
    limit ${q.limit + 1}`.catch((e: { code?: string }) => {
      // A forged cursor can carry an impossible timestamp (for example Feb 30).
      if (e?.code === "22007" || e?.code === "22008")
        throw new DomainError("invalid_input");
      throw e;
    });
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    items: page.map((r): OrderSummary => {
      const preview = r.preview as OrderSummary["preview"];
      return {
        id: r.id,
        number: r.number,
        businessDate: r.business_date,
        createdAt: iso(r.created_at)!,
        mode: r.mode,
        channel: r.channel,
        tableId: r.table_id,
        tableName: r.table_name,
        name: r.name,
        note: r.note,
        waiterName: r.waiter_name,
        serviceState: r.state,
        checkState: r.check_state,
        closedAt: iso(r.closed_at),
        closeReason: r.close_reason,
        total: r.total,
        paid: r.paid,
        refunded: r.refunded,
        balance: r.total - r.paid,
        refundableCash: r.refundable_cash,
        itemCount: r.items,
        preview: preview.slice(0, 6),
        previewMore: Math.max(0, preview.length - 6),
        openRounds: r.open_rounds,
        readyRounds: r.ready_rounds,
        recovery: r.recovery,
        voidAckPending: r.void_ack_pending,
      };
    }),
    nextCursor:
      rows.length > q.limit && last
        ? encodeCursor({ t: last.cursor_t, i: last.id })
        : null,
    businessDate: now,
  };
}

/** Table occupancy from checks that are not closed, in one statement. */
export async function tableOccupancy(
  tx: Tx,
  s: Session,
): Promise<TableOccupancy[]> {
  permit(s, operators);
  const rows =
    await tx`select t.id,t.name,coalesce(jsonb_agg(jsonb_build_object(
        'id',o.id,'number',o.number,'name',o.name,'createdAt',o.created_at,
        'businessDate',o.business_date,'waiterName',e.name,'total',o.total,'paid',p.paid,
        'balance',o.total-p.paid,'checkState',o.check_state,
        'openRounds',k.open_rounds,'readyRounds',k.ready_rounds) order by o.created_at)
      filter (where o.id is not null),'[]'::jsonb) as checks
    from dining_tables t
    left join orders o on o.tenant_id=t.tenant_id and o.table_id=t.id and o.check_state <> 'closed'
    left join employees e on e.tenant_id=o.tenant_id and e.id=coalesce(o.assigned_employee_id,o.employee_id)
    left join lateral (select coalesce(sum(tn.amount),0)::int as paid from tenders tn
                       where tn.tenant_id=o.tenant_id and tn.order_id=o.id) p on true
    left join lateral (select count(*) filter (where r.state <> 'completed')::int as open_rounds,
                              count(*) filter (where r.state='ready')::int as ready_rounds
                       from rounds r where r.tenant_id=o.tenant_id and r.order_id=o.id) k on true
    group by t.tenant_id,t.id,t.name
    order by t.name`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    checks: r.checks,
  }));
}
