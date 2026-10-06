import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type postgres from "postgres";
import { z } from "zod";
import { tenant, type Tx } from "./db.js";
import { hash, managers, operators, permit } from "./auth.js";
import { checkPin, deviceScope, pinError, stepUpSeconds } from "./access.js";
import { ACCESS, isRecentAuth } from "../shared/access.js";
import { audit, getOrder, once, stock } from "./orders.js";
import { lockStockItems } from "./stock.js";
import { recipeStockIds } from "../shared/menu.js";
import { DomainError, id, type Session } from "../shared/domain.js";
import { assertCheckWritable, refreshCheckState } from "./checks.js";
import { bumpKitchenFeed } from "./kitchen.js";
import { voidCandidates } from "../shared/discounts.js";

/** First-stage throttle values (see shared/access.ts ACCESS.pin). */
export const MAX_FAILED_ATTEMPTS = ACCESS.pin.firstStage;
export const LOCK_MINUTES = ACCESS.pin.baseLockMinutes;

type SecretCheck =
  | { outcome: "ok"; employee: { id: string; role: string; name: string } }
  | { outcome: "invalid" }
  | { outcome: "locked" };

/**
 * Compatibility wrapper over checkPin (server/access.ts): throttling is per
 * employee and device scope. Never throws for a wrong secret: callers must let
 * the transaction commit so the counters persist, then reject outside.
 */
export async function checkEmployeeSecret(
  tx: Tx,
  login: string,
  secret: string,
  scope = "unpaired",
): Promise<SecretCheck> {
  const check = await checkPin(tx, { login }, secret, scope);
  if (check.outcome === "ok") return check;
  if (check.outcome === "locked" || check.outcome === "hard_locked")
    return { outcome: "locked" };
  return { outcome: "invalid" };
}

export const approvalInput = z.union([
  z.object({ employeeId: id, secret: z.string().min(4).max(200) }).strict(),
  z
    .object({
      login: z.string().min(1).max(100),
      secret: z.string().min(4).max(200),
    })
    .strict(),
]);

/** Rejected PIN approvals one session may make per minute (A5), per process. */
export const APPROVAL_FAILURES_PER_MINUTE = 10;
const approvalFailures = new Map<string, number[]>();
function recentApprovalFailures(sessionId: string, now: number) {
  const recent = (approvalFailures.get(sessionId) ?? []).filter(
    (at) => now - at < 60_000,
  );
  if (recent.length) approvalFailures.set(sessionId, recent);
  else approvalFailures.delete(sessionId);
  return recent;
}
/**
 * A per-session ceiling on rejected PIN approvals, on top of the per-device
 * throttle and the 100-failure hard lock, so one session cannot drive a
 * guessing loop across approvers. Successful approvals never count.
 */
function noteApprovalFailure(sessionId: string, now = Date.now()) {
  approvalFailures.set(sessionId, [
    ...recentApprovalFailures(sessionId, now),
    now,
  ]);
  if (approvalFailures.size > 5_000)
    for (const key of [...approvalFailures.keys()])
      recentApprovalFailures(key, now);
}

/**
 * What once() fingerprints for a void. It names the approver but never
 * includes the secret; legacy login fingerprints stay stable.
 */
function voidFingerprint(orderId: string, input: z.infer<typeof voidInput>) {
  const { approval, ...rest } = input;
  return {
    orderId,
    ...rest,
    approver: approval
      ? "employeeId" in approval
        ? approval.employeeId
        : approval.login
      : null,
  };
}

/**
 * True when this exact void (same operationId, kind and fingerprint, so the
 * same order, lines, version and approver) is already recorded. Only an exact
 * match counts: any other reuse of an operationId still gets the order check
 * before the PIN, then once()'s operation_conflict.
 */
async function recordedVoid(tx: Tx, orderId: string, raw: unknown) {
  const input = voidInput.safeParse(raw);
  if (!input.success) return false;
  const [prior] =
    await tx`select kind,hash from operations where id=${input.data.operationId}`;
  return (
    !!prior &&
    prior.kind === "void" &&
    prior.hash === hash(JSON.stringify(voidFingerprint(orderId, input.data)))
  );
}

/**
 * Verifies a manager's PIN for one sensitive command, in its own transaction so
 * failed attempts are recorded even though the command is refused. Attempts
 * count against the approver on the session's device only (SEC-2). Without a
 * payload, a manager may approve their own action only from a Google-entered
 * session on a personal device or with a recent PIN (SEC-6/A4). Returns the
 * approver's id. With orderId, the order must exist, pass assertCheckWritable
 * and still have an unpaid unit before any PIN is checked, so approvals cannot
 * be tried against made-up, closed or fully paid orders (A5/ACC-R-5). The read
 * takes no lock:
 * voidLines re-checks all of it under the order's FOR UPDATE. voidRequest is
 * the void's full body: when that exact void is already recorded (a retry
 * after a lost response), the order check is skipped so voidLines' once()
 * returns the stored result instead of refusing the order the first attempt
 * cancelled or fully voided (ACC-R6-1). The PIN is still checked.
 */
export async function verifyApproval(
  sql: postgres.Sql,
  s: Session,
  raw: unknown,
  orderId?: string,
  voidRequest?: unknown,
): Promise<string> {
  if (raw === undefined || raw === null) {
    if (
      managers.includes(s.role) &&
      isRecentAuth(s.access, Date.now(), stepUpSeconds())
    )
      return s.employeeId;
    throw new DomainError("approval_required", 403);
  }
  const approval = approvalInput.safeParse(raw);
  if (!approval.success) throw new DomainError("approval_required", 403);
  const target =
    "employeeId" in approval.data
      ? { employeeId: approval.data.employeeId }
      : { login: approval.data.login };
  if (
    recentApprovalFailures(s.id, Date.now()).length >=
    APPROVAL_FAILURES_PER_MINUTE
  )
    throw new DomainError("too_many_attempts", 429);
  const result = await tenant(sql, s.tenantId, async (tx) => {
    if (
      orderId &&
      !(
        voidRequest !== undefined &&
        (await recordedVoid(tx, orderId, voidRequest))
      )
    ) {
      const [order] =
        await tx`select state,check_state from orders where id=${orderId}`;
      if (!order) throw new DomainError("not_found", 404);
      // Exactly what voidLines refuses, with the same codes (service 024):
      // stale_order for recovery orders, check_closed for closed checks and
      // cancelled orders. Served (completed) orders stay voidable while open.
      assertCheckWritable(order as { check_state: string; state: string });
      const detail = await getOrder(tx, orderId);
      if (!detail.itemSplitAvailable)
        throw new DomainError("unallocated_history", 409);
      if (!detail.paymentUnits!.some((u) => u.paid === 0))
        throw new DomainError("void_exceeds_unpaid", 409);
    }
    const check = await checkPin(
      tx,
      target,
      approval.data.secret,
      deviceScope(s.deviceId),
    );
    if (check.outcome === "ok" && check.employee.id === s.employeeId)
      await tx`update sessions set authenticated_at=now() where id=${s.id}`;
    return check;
  });
  if (result.outcome !== "ok") {
    noteApprovalFailure(s.id);
    throw pinError(result, "approval");
  }
  if (!managers.includes(result.employee.role)) {
    noteApprovalFailure(s.id);
    throw new DomainError("approval_denied", 403);
  }
  return result.employee.id;
}

export const voidInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(1),
    lines: z
      .array(
        z
          .object({ lineId: id, quantity: z.number().int().min(1).max(99) })
          .strict(),
      )
      .min(1)
      .max(100),
    reason: z.string().trim().min(3).max(300),
    stockDisposition: z.enum(["return", "no_return"]),
    approval: approvalInput.optional(),
  })
  .strict();

/** Recomputes an order's preparation state from its rounds and voids. */
export async function refreshOrderState(tx: Tx, orderId: string) {
  const [counts] = await tx`select
      count(*)::int as lines,
      count(*) filter (where (l.data->>'quantity')::int <=
        coalesce((select sum(cardinality(v.units)) from line_voids v
                  where v.tenant_id=l.tenant_id and v.line_id=l.id),0))::int as voided
    from order_lines l where l.order_id=${orderId}`;
  if (counts.lines > 0 && counts.voided === counts.lines) {
    await tx`update orders set state='cancelled' where id=${orderId} and state not like 'recovery%'`;
    return;
  }
  const all = await tx`select state from rounds where order_id=${orderId}`;
  // Rounds awaiting the offline review decision keep the order active.
  const state = all.every((r) => r.state === "completed")
    ? "completed"
    : all.every((r) => r.state !== "active" && r.state !== "offline_review")
      ? "ready"
      : "active";
  await tx`update orders set state=${state} where id=${orderId} and state not like 'recovery%'`;
}

/**
 * Completes rounds whose every unit has been removed (voided, or refunded
 * before it was served: kitchen_removals, discounts 028) and acknowledged.
 */
async function closeFullyVoidedRounds(tx: Tx, orderId: string) {
  await tx`update rounds r set state='completed',seen_at=coalesce(seen_at,now())
    where r.order_id=${orderId} and r.state<>'completed'
      and not exists (
        select 1 from kitchen_removals v join order_lines l on l.tenant_id=v.tenant_id and l.id=v.line_id
        where v.order_id=r.order_id and l.round=r.number and l.data->>'station'=r.station
          and v.kitchen_ack_required and v.kitchen_acknowledged_at is null)
      and not exists (
        select 1 from order_lines l
        where l.order_id=r.order_id and l.round=r.number and l.data->>'station'=r.station
          and (l.data->>'quantity')::int >
            coalesce((select sum(cardinality(v.units)) from kitchen_removals v
                      where v.tenant_id=l.tenant_id and v.line_id=l.id),0))`;
}

/**
 * Voids unpaid units of order lines. The approver has already been verified by
 * verifyApproval; this re-checks that the approver is still an active manager
 * inside the command transaction.
 */
export async function voidLines(
  tx: Tx,
  s: Session,
  orderId: string,
  raw: unknown,
  approverId: string,
) {
  permit(s, operators);
  const input = voidInput.parse(raw);
  const fingerprint = voidFingerprint(orderId, input);
  return once(tx, s, input.operationId, "void", fingerprint, async () => {
    const [locked] =
      await tx`select state,check_state,version from orders where id=${orderId} for update`;
    if (!locked) throw new DomainError("not_found", 404);
    if (locked.version !== input.expectedVersion)
      throw new DomainError("stale_order", 409);
    // Served (completed) orders stay voidable while the check is open.
    assertCheckWritable(locked as { check_state: string; state: string });
    if (approverId !== s.employeeId) {
      const [approver] =
        await tx`select id from employees where id=${approverId} and active and role in ('owner','manager') for share`;
      if (!approver) throw new DomainError("approval_denied", 403);
    }
    if (new Set(input.lines.map((l) => l.lineId)).size !== input.lines.length)
      throw new DomainError("duplicate_line");

    const order = await getOrder(tx, orderId);
    if (!order.itemSplitAvailable)
      throw new DomainError("unallocated_history", 409);

    // DB-5: lock every stock row the returns touch, in one global order.
    if (input.stockDisposition === "return")
      await lockStockItems(
        tx,
        recipeStockIds(
          input.lines.flatMap((r) =>
            order.lines.filter((l) => l.id === r.lineId),
          ),
        ),
      );
    // discounts (028): the balance drops by each unit's net; line_voids.amount
    // stays gross and the discount on the voided units is released.
    let net = 0,
      released = 0;
    for (const request of input.lines) {
      const line = order.lines.find((l) => l.id === request.lineId);
      if (!line || line.round === undefined)
        throw new DomainError("not_found", 404);
      // Void unpaid units, undiscounted first, then the highest-numbered;
      // paid units require a refund (discounts 028).
      const unpaid = voidCandidates(order, line.id);
      if (unpaid.length < request.quantity)
        throw new DomainError("void_exceeds_unpaid", 409);
      const units = unpaid.slice(0, request.quantity);
      const amount = units.reduce((a, u) => a + u.total, 0);
      const lineNet = units.reduce((a, u) => a + u.total - u.discount, 0);

      const [round] =
        await tx`select state,seen_at from rounds where order_id=${orderId} and number=${line.round} and station=${line.station} for update`;
      const preparation = round
        ? round.state === "active" && !round.seen_at
          ? "not_started"
          : round.state
        : "completed";
      if (input.stockDisposition === "return" && preparation !== "not_started")
        throw new DomainError("stock_return_not_allowed", 409);

      const voidId = randomUUID();
      await tx`insert into line_voids(tenant_id,id,order_id,line_id,units,amount,reason,stock_disposition,preparation_state,actor_id,approver_id,kitchen_ack_required)
        values(${s.tenantId},${voidId},${orderId},${line.id},${units.map((u) => u.unit).sort((a, b) => a - b)},${amount},${input.reason},
          ${input.stockDisposition === "return" ? "returned" : "not_returned"},${preparation},${s.employeeId},${approverId},${preparation !== "completed"})`;
      if (input.stockDisposition === "return")
        for (const r of [...line.recipe].sort((a, b) =>
          a.stockId.localeCompare(b.stockId),
        ))
          await stock(
            tx,
            s,
            r.stockId,
            new Decimal(r.quantity).mul(units.length).toFixed(6),
            "void",
            voidId,
            "void_return",
            "allow",
          );
      await audit(tx, s, "order.void", orderId, {
        voidId,
        lineId: line.id,
        units: units.map((u) => u.unit),
        amount,
        reason: input.reason,
        approverId,
        stockDisposition: input.stockDisposition,
        preparation,
        net: lineNet,
        discountReleased: amount - lineNet,
      });
      net += lineNet;
      released += amount - lineNet;
    }
    await tx`update orders set total=total-${net},discount=discount-${released},version=version+1 where id=${orderId}`;
    await closeFullyVoidedRounds(tx, orderId);
    await refreshOrderState(tx, orderId);
    // Balance 0 settles or holds the table; every line voided closes as voided.
    await refreshCheckState(tx, s, orderId);
    await bumpKitchenFeed(tx, s);
    return getOrder(tx, orderId);
  });
}

/** Kitchen confirms it has seen the voids for one round ticket. */
export async function acknowledgeVoids(
  tx: Tx,
  s: Session,
  roundId: string,
  raw: unknown,
) {
  permit(s, ["owner", "manager", "kitchen"]);
  const p = z.object({ operationId: id }).strict().parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "kitchen.void_ack",
    { ...p, roundId },
    async () => {
      const [pointer] =
        await tx`select order_id from rounds where id=${roundId}`;
      if (!pointer) throw new DomainError("not_found", 404);
      await tx`select id from orders where id=${pointer.order_id} for update`;
      const [r] = await tx`select * from rounds where id=${roundId} for update`;
      const acknowledged = await tx`update line_voids v set
          kitchen_acknowledged_at=now(),kitchen_acknowledged_by=${s.employeeId}
        from order_lines l
        where l.tenant_id=v.tenant_id and l.id=v.line_id and v.order_id=${r.order_id}
          and l.round=${r.number} and l.data->>'station'=${r.station}
          and v.kitchen_ack_required and v.kitchen_acknowledged_at is null
        returning v.id`;
      // discounts (028): refund cancellations of this ticket, same machinery.
      const refunds = await tx`update refund_lines v set
          kitchen_acknowledged_at=now(),kitchen_acknowledged_by=${s.employeeId}
        from order_lines l
        where l.tenant_id=v.tenant_id and l.id=v.line_id and v.order_id=${r.order_id}
          and l.round=${r.number} and l.data->>'station'=${r.station}
          and v.kitchen_ack_required and v.kitchen_acknowledged_at is null
        returning v.id`;
      await closeFullyVoidedRounds(tx, r.order_id);
      await refreshOrderState(tx, r.order_id);
      await audit(tx, s, "kitchen.void_ack", r.id, {
        voids: acknowledged.map((v) => v.id),
        refunds: refunds.map((v) => v.id),
      });
      await bumpKitchenFeed(tx, s);
      return { ok: true, acknowledged: acknowledged.length + refunds.length };
    },
  );
}
