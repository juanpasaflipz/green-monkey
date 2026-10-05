import { z } from "zod";
import type { Tx } from "./db.js";
import { permit } from "./auth.js";
import { audit, once } from "./orders.js";
import { refreshOrderState } from "./voids.js";
import { bumpKitchenFeed } from "./compat/offline-service.js";
import { DomainError, id, type Session } from "../shared/domain.js";

/** Round state for rounds created by offline sync until the kitchen decides (OFF-4). */
export const OFFLINE_REVIEW_STATE = "offline_review";

/**
 * Moves the rounds of one order round into the kitchen review lane. The
 * offline_sync_records row for `operationId` must already exist (FK).
 */
export async function placeRoundsInOfflineReview(
  tx: Tx,
  s: Session,
  p: { orderId: string; roundNumber: number; operationId: string },
): Promise<number> {
  const rounds =
    await tx`update rounds set state=${OFFLINE_REVIEW_STATE} where order_id=${p.orderId} and number=${p.roundNumber} returning id`;
  for (const round of rounds)
    await tx`insert into offline_kitchen_reviews(tenant_id,round_id,operation_id) values(${s.tenantId},${round.id},${p.operationId})`;
  return rounds.length;
}

/** Pending offline-sold rounds, oldest sale first, at most 100. */
export async function listOfflineKitchen(tx: Tx, s: Session) {
  permit(s, ["owner", "manager", "kitchen", "server", "cashier"]);
  const rows = await tx`select k.round_id,r.order_id,o.number as order_number,
      sr.provisional_number,r.station,r.number as round,sr.sold_at,sr.synced_at,
      sr.kitchen_delivery,d.name as device_name,o.mode,t.name as table_name,o.name,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'id',l.id,'quantity',(l.data->>'quantity')::int,
          'voidedQuantity',coalesce((select sum(cardinality(v.units)) from line_voids v
             where v.tenant_id=l.tenant_id and v.line_id=l.id),0),
          'name',l.data->'name','optionNames',coalesce(l.data->'optionNames','[]'::jsonb),
          'note',coalesce(l.data->>'note','')) order by l.id),'[]'::jsonb)
        from order_lines l where l.tenant_id=r.tenant_id and l.order_id=r.order_id
          and l.round=r.number and l.data->>'station'=r.station) as lines
    from offline_kitchen_reviews k
    join rounds r on r.tenant_id=k.tenant_id and r.id=k.round_id
    join orders o on o.tenant_id=r.tenant_id and o.id=r.order_id
    join offline_sync_records sr on sr.tenant_id=k.tenant_id and sr.operation_id=k.operation_id
    left join devices d on d.tenant_id=sr.tenant_id and d.id=sr.device_id
    left join dining_tables t on t.tenant_id=o.tenant_id and t.id=o.table_id
    where k.state='pending'
    order by sr.sold_at, k.round_id
    limit 100`;
  return {
    items: rows.map((r) => ({
      roundId: r.round_id,
      orderId: r.order_id,
      orderNumber: r.order_number,
      provisionalNumber: r.provisional_number,
      station: r.station,
      round: r.round,
      soldAt: r.sold_at.toISOString(),
      syncedAt: r.synced_at.toISOString(),
      kitchenDelivery: r.kitchen_delivery,
      deviceName: r.device_name ?? null,
      mode: r.mode,
      tableName: r.table_name ?? null,
      name: r.name,
      lines: r.lines,
    })),
  };
}

const decisionInput = z
  .object({ operationId: id, decision: z.enum(["prepare", "already_served"]) })
  .strict();

/**
 * Records the kitchen's decision for one offline-sold round. The first decision
 * wins; a later one receives the current outcome with alreadyDecided=true.
 */
export async function decideOfflineKitchen(
  tx: Tx,
  s: Session,
  roundId: string,
  raw: unknown,
) {
  permit(s, ["owner", "manager", "kitchen", "server"]);
  const p = decisionInput.parse(raw);
  if (s.role === "server" && p.decision !== "already_served")
    throw new DomainError("forbidden", 403);
  return once(
    tx,
    s,
    p.operationId,
    "offline.kitchen_decision",
    { roundId, ...p },
    async () => {
      const [pointer] =
        await tx`select order_id from rounds where id=${roundId}`;
      if (!pointer) throw new DomainError("not_found", 404);
      // Same lock order as service: parent order, then round, then review.
      const [order] =
        await tx`select id from orders where id=${pointer.order_id} for update`;
      const [round] =
        await tx`select id,state,number,station from rounds where id=${roundId} for update`;
      const [review] =
        await tx`select state from offline_kitchen_reviews where round_id=${roundId} for update`;
      if (!order || !round || !review) throw new DomainError("not_found", 404);
      if (review.state !== "pending") {
        const [current] =
          await tx`select state from orders where id=${pointer.order_id}`;
        return {
          roundId,
          state: round.state,
          orderState: current.state,
          alreadyDecided: true,
        };
      }
      const roundState = p.decision === "prepare" ? "active" : "completed";
      await tx`update offline_kitchen_reviews set state=${p.decision},decided_by=${s.employeeId},decided_at=now() where round_id=${roundId}`;
      await tx`update rounds set state=${roundState},seen_at=coalesce(seen_at,now()) where id=${roundId}`;
      if (p.decision === "already_served")
        // Food already served: that round's pending void tickets are moot.
        await tx`update line_voids v set kitchen_acknowledged_at=now(),kitchen_acknowledged_by=${s.employeeId}
          from order_lines l
          where l.tenant_id=v.tenant_id and l.id=v.line_id and v.order_id=${pointer.order_id}
            and l.round=${round.number} and l.data->>'station'=${round.station}
            and v.kitchen_ack_required and v.kitchen_acknowledged_at is null`;
      await refreshOrderState(tx, pointer.order_id);
      const [current] =
        await tx`select state from orders where id=${pointer.order_id}`;
      await audit(tx, s, "offline.kitchen_decision", roundId, {
        decision: p.decision,
        orderId: pointer.order_id,
      });
      // Last lock-taking statement: "Preparar ahora" shows on the next KDS poll.
      await bumpKitchenFeed(tx, s);
      return {
        roundId,
        state: roundState,
        orderState: current.state,
        alreadyDecided: false,
      };
    },
  );
}
