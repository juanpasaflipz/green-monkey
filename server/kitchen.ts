import { z } from "zod";
import type { Tx } from "./db.js";
import { permit, managers } from "./auth.js";
import { audit, once } from "./orders.js";
import { refreshOrderState } from "./voids.js";
import {
  DomainError,
  businessDate,
  id,
  type Session,
} from "../shared/domain.js";
import {
  KITCHEN_FEED_LIMIT,
  recallPreparation,
  type KitchenFeed,
  type KitchenRecent,
  type KitchenRound,
} from "../shared/service.js";

/**
 * Bumps the tenant kitchen feed version so polling screens refetch.
 *
 * Global lock order (docs/ARCHITECTURE.md, level 10; platform §6.2): call it only after the
 * command has locked every order, round, void or discount row and stock item it will touch,
 * and before the drawer (cash_sessions) and before refreshCheckState, which may take the
 * fiscal folio counter last. Holding this tenant row while waiting on an order would
 * deadlock with every KDS command.
 */
export async function bumpKitchenFeed(tx: Tx, s: Session): Promise<void> {
  await tx`insert into kitchen_feed_versions(tenant_id,version,updated_at)
    values(${s.tenantId},1,now())
    on conflict(tenant_id) do update
      set version=kitchen_feed_versions.version+1,updated_at=now()`;
}

export const kitchenQuery = z
  .object({
    station: z.enum(["kitchen", "bar", "all"]).default("all"),
    version: z.coerce.number().int().min(0).optional(),
  })
  .strict();

const iso = (v: unknown) =>
  v instanceof Date
    ? v.toISOString()
    : v === null || v === undefined
      ? null
      : String(v);

/**
 * Kitchen display feed. The version is read before the data, so a concurrent
 * change is either included or detected on the next poll (at-least-once). An
 * unchanged poll is a single one-row read.
 */
export async function kitchenFeed(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<KitchenFeed> {
  permit(s, ["owner", "manager", "kitchen", "server", "cashier"]);
  const q = kitchenQuery.parse(raw ?? {});
  const [row] = await tx`select version from kitchen_feed_versions`;
  const version = row ? Number(row.version) : 0;
  const serverTime = new Date().toISOString();
  if (q.version !== undefined && q.version === version)
    return { version, unchanged: true, serverTime };
  const station = q.station === "all" ? tx`` : tx`and r.station = ${q.station}`;
  // rounds_open serves this: the predicates stay literal. Rounds held for
  // offline review never reach the live KDS until a manager decides (offline 026).
  const rounds =
    await tx`select r.id,r.order_id,r.number,r.station,r.state,r.seen_at,r.ready_at,r.created_at,r.note as round_note,
      o.number as order_number,o.name as call_name,o.mode,o.channel,o.note as order_note,
      o.created_at as order_created_at,o.business_date::text as business_date,o.service_version,
      t.name as table_name,e.name as waiter_name,
      (select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'quantity',(l.data->>'quantity')::int,
          'voidedQuantity',coalesce((select sum(cardinality(v.units)) from kitchen_removals v
             where v.tenant_id=l.tenant_id and v.line_id=l.id),0),
          'name',l.data->'name','optionNames',coalesce(l.data->'optionNames','[]'::jsonb),
          'note',coalesce(l.data->>'note','')) order by l.data->'name'->>'es', l.id),'[]'::jsonb)
       from order_lines l where l.tenant_id=r.tenant_id and l.order_id=r.order_id
         and l.round=r.number and l.data->>'station'=r.station) as lines,
      (select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'lineId',v.line_id,'quantity',cardinality(v.units),
          'name',l.data->'name','reason',v.reason,'createdAt',v.created_at,'kind',v.kind) order by v.created_at),'[]'::jsonb)
       from kitchen_removals v join order_lines l on l.tenant_id=v.tenant_id and l.id=v.line_id
       where v.tenant_id=r.tenant_id and v.order_id=r.order_id and l.round=r.number and l.data->>'station'=r.station
         and v.kitchen_ack_required and v.kitchen_acknowledged_at is null) as pending_voids
    from rounds r
    join orders o on o.tenant_id=r.tenant_id and o.id=r.order_id
    join employees e on e.tenant_id=o.tenant_id and e.id=coalesce(o.assigned_employee_id,o.employee_id)
    left join dining_tables t on t.tenant_id=o.tenant_id and t.id=o.table_id
    where r.state <> 'completed' and r.state <> 'offline_review' ${station}
    order by r.created_at, r.id
    limit ${KITCHEN_FEED_LIMIT + 1}`;
  const currentBusinessDate = businessDate(
    serverTime,
    s.restaurant.timezone,
    s.restaurant.cutoff,
  );
  // rounds_recent_completed serves this; only rounds with items left recall.
  // Previous business days stay out, so tickets a manager retired with
  // clear-stale never come back.
  const recent =
    await tx`select r.id,r.number,r.station,r.completed_at,o.number as order_number,o.name as call_name,t.name as table_name
    from rounds r join orders o on o.tenant_id=r.tenant_id and o.id=r.order_id
    left join dining_tables t on t.tenant_id=o.tenant_id and t.id=o.table_id
    where r.completed_at is not null and r.completed_at > now() - interval '120 minutes'
      and o.business_date >= ${currentBusinessDate}::date
      ${station}
      and exists (select 1 from order_lines l where l.tenant_id=r.tenant_id and l.order_id=r.order_id
        and l.round=r.number and l.data->>'station'=r.station
        and (l.data->>'quantity')::int > coalesce((select sum(cardinality(v.units)) from kitchen_removals v
             where v.tenant_id=l.tenant_id and v.line_id=l.id),0))
    order by r.completed_at desc limit 10`;
  return {
    version,
    unchanged: false,
    serverTime,
    currentBusinessDate,
    truncated: rounds.length > KITCHEN_FEED_LIMIT,
    rounds: rounds.slice(0, KITCHEN_FEED_LIMIT).map((r): KitchenRound => ({
      id: r.id,
      orderId: r.order_id,
      orderNumber: r.order_number,
      roundNumber: r.number,
      station: r.station,
      state: r.state,
      seenAt: iso(r.seen_at),
      readyAt: iso(r.ready_at),
      createdAt: iso(r.created_at)!,
      orderCreatedAt: iso(r.order_created_at)!,
      businessDate: r.business_date,
      mode: r.mode,
      channel: r.channel,
      callName: r.call_name,
      tableName: r.table_name,
      waiterName: r.waiter_name,
      serviceUpdated: r.service_version > 0,
      orderNote: r.order_note,
      roundNote: r.round_note,
      lines: r.lines,
      pendingVoids: r.pending_voids,
    })),
    recent: recent.map((r): KitchenRecent => ({
      id: r.id,
      orderNumber: r.order_number,
      callName: r.call_name,
      tableName: r.table_name,
      roundNumber: r.number,
      station: r.station,
      completedAt: iso(r.completed_at)!,
    })),
  };
}

const operationInput = z.object({ operationId: id }).strict();
/** SVC-K9: the clear acts on the station the manager sees (default all). */
const clearInput = z
  .object({
    operationId: id,
    station: z.enum(["all", "kitchen", "bar"]).default("all"),
  })
  .strict();

/** Returns a round bumped in the last two hours to the screen as ready. */
export async function recallRound(
  tx: Tx,
  s: Session,
  roundId: string,
  raw: unknown,
): Promise<{ ok: true }> {
  permit(s, ["owner", "manager", "kitchen", "server"]);
  const p = operationInput.parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "kitchen.recall",
    { ...p, roundId },
    async () => {
      const [pointer] =
        await tx`select order_id from rounds where id=${roundId}`;
      if (!pointer) throw new DomainError("not_found", 404);
      // Lock the parent before the round, matching every other order command.
      const [order] =
        await tx`select business_date::text as business_date from orders where id=${pointer.order_id} for update`;
      // Rounds of previous business days (including those retired with
      // clear-stale) never return to the screen.
      const today = businessDate(
        new Date().toISOString(),
        s.restaurant.timezone,
        s.restaurant.cutoff,
      );
      const [r] = await tx`select r.*,
        coalesce(r.completed_at > now() - interval '120 minutes',false) as in_window,
        exists (select 1 from order_lines l where l.tenant_id=r.tenant_id and l.order_id=r.order_id
          and l.round=r.number and l.data->>'station'=r.station
          and (l.data->>'quantity')::int > coalesce((select sum(cardinality(v.units)) from kitchen_removals v
               where v.tenant_id=l.tenant_id and v.line_id=l.id),0)) as has_items
      from rounds r where r.id=${roundId} for update of r`;
      if (
        !r.completed_at ||
        !r.in_window ||
        !r.has_items ||
        order.business_date < today
      )
        throw new DomainError("round_not_recallable", 409);
      const next = recallPreparation(r.state);
      await tx`update rounds set state=${next} where id=${roundId}`;
      await refreshOrderState(tx, r.order_id);
      await audit(tx, s, "kitchen.recall", roundId, { orderId: r.order_id });
      await bumpKitchenFeed(tx, s);
      return { ok: true as const };
    },
  );
}

/**
 * Manager command: completes rounds left open from previous business days and
 * acknowledges their pending voids on the manager's behalf. Audited.
 */
export async function clearStaleRounds(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<{ cleared: number }> {
  permit(s, managers);
  const p = clearInput.parse(raw);
  return once(tx, s, p.operationId, "kitchen.clear_stale", p, async () => {
    const before = businessDate(
      new Date().toISOString(),
      s.restaurant.timezone,
      s.restaurant.cutoff,
    );
    const station =
      p.station === "all" ? tx`` : tx`and r.station = ${p.station}`;
    const ids = (
      await tx`select distinct r.order_id from rounds r
        join orders o on o.tenant_id=r.tenant_id and o.id=r.order_id
        where r.state <> 'completed' and r.state <> 'offline_review' and o.business_date < ${before}
          ${station}
        order by 1 limit 500`
    ).map((r) => r.order_id as string);
    if (!ids.length) return { cleared: 0 };
    // Orders first, sorted by id, before any round (see bumpKitchenFeed).
    await tx`select id from orders where id = any(${tx.array(ids)}::uuid[]) order by id for update`;
    const cleared =
      await tx`update rounds r set state='completed',seen_at=coalesce(r.seen_at,now())
      from orders o
      where o.tenant_id=r.tenant_id and o.id=r.order_id and r.order_id = any(${tx.array(ids)}::uuid[])
        and r.state <> 'completed' and r.state <> 'offline_review' and o.business_date < ${before}
        ${station}
      returning r.id,r.order_id,r.number,r.station`;
    if (cleared.length) {
      await tx`update line_voids v set kitchen_acknowledged_at=now(),kitchen_acknowledged_by=${s.employeeId}
        from order_lines l, rounds r
        where l.tenant_id=v.tenant_id and l.id=v.line_id
          and r.tenant_id=v.tenant_id and r.order_id=v.order_id
          and r.id = any(${tx.array(cleared.map((c) => c.id as string))}::uuid[])
          and l.round=r.number and l.data->>'station'=r.station
          and v.kitchen_ack_required and v.kitchen_acknowledged_at is null`;
      // discounts (028): refund cancellations of the cleared tickets too.
      await tx`update refund_lines v set kitchen_acknowledged_at=now(),kitchen_acknowledged_by=${s.employeeId}
        from order_lines l, rounds r
        where l.tenant_id=v.tenant_id and l.id=v.line_id
          and r.tenant_id=v.tenant_id and r.order_id=v.order_id
          and r.id = any(${tx.array(cleared.map((c) => c.id as string))}::uuid[])
          and l.round=r.number and l.data->>'station'=r.station
          and v.kitchen_ack_required and v.kitchen_acknowledged_at is null`;
    }
    for (const orderId of ids) await refreshOrderState(tx, orderId);
    await audit(tx, s, "kitchen.cleared", s.tenantId, {
      rounds: cleared.map((c) => c.id),
      before,
      station: p.station,
    });
    await bumpKitchenFeed(tx, s);
    return { cleared: cleared.length };
  });
}
