import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type postgres from "postgres";
import { z } from "zod";
import { tenant, type Tx } from "./db.js";
import { managers, matches, operators, permit } from "./auth.js";
import { audit, getOrder, once, stock } from "./orders.js";
import { DomainError, id, type Session } from "../shared/domain.js";
import { assertCheckWritable, refreshCheckState } from "./checks.js";
import { bumpKitchenFeed } from "./kitchen.js";

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 5;

type SecretCheck =
  | { outcome: "ok"; employee: { id: string; role: string; name: string } }
  | { outcome: "invalid" }
  | { outcome: "locked" };

/**
 * Checks an employee login and secret, maintaining the per-employee lockout.
 * Never throws for a wrong secret: callers must let the transaction commit so the
 * failed-attempt counter persists, then reject outside the transaction.
 */
export async function checkEmployeeSecret(
  tx: Tx,
  login: string,
  secret: string,
): Promise<SecretCheck> {
  const [e] =
    await tx`select id,role,name,secret_hash,coalesce(locked_until>now(),false) as locked
      from employees where login=${login} and active for update`;
  if (!e) return { outcome: "invalid" };
  if (e.locked) return { outcome: "locked" };
  if (!matches(secret, e.secret_hash)) {
    await tx`update employees set
        failed_attempts=failed_attempts+1,
        locked_until=case when failed_attempts+1>=${MAX_FAILED_ATTEMPTS}
          then now()+make_interval(mins=>${LOCK_MINUTES}) else locked_until end
      where id=${e.id}`;
    return { outcome: "invalid" };
  }
  await tx`update employees set failed_attempts=0,locked_until=null where id=${e.id} and (failed_attempts>0 or locked_until is not null)`;
  return { outcome: "ok", employee: { id: e.id, role: e.role, name: e.name } };
}

export const approvalInput = z
  .object({
    login: z.string().min(1).max(100),
    secret: z.string().min(4).max(200),
  })
  .strict();

/**
 * Verifies a manager's credentials for one sensitive command, in its own
 * transaction so failed attempts are recorded even though the command is refused.
 * Returns the approver's employee id. The approval is not stored or reusable.
 */
export async function verifyApproval(
  sql: postgres.Sql,
  s: Session,
  raw: unknown,
): Promise<string> {
  if (managers.includes(s.role)) return s.employeeId;
  const approval = approvalInput.safeParse(raw);
  if (!approval.success) throw new DomainError("approval_required", 403);
  const result = await tenant(sql, s.tenantId, (tx) =>
    checkEmployeeSecret(tx, approval.data.login, approval.data.secret),
  );
  if (result.outcome === "locked") throw new DomainError("pin_locked", 423);
  if (result.outcome === "invalid" || !managers.includes(result.employee.role))
    throw new DomainError("approval_denied", 403);
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
  const state = all.every((r) => r.state === "completed")
    ? "completed"
    : all.every((r) => r.state !== "active")
      ? "ready"
      : "active";
  await tx`update orders set state=${state} where id=${orderId} and state not like 'recovery%'`;
}

/** Completes rounds whose every line has been voided and acknowledged. */
async function closeFullyVoidedRounds(tx: Tx, orderId: string) {
  await tx`update rounds r set state='completed',seen_at=coalesce(seen_at,now())
    where r.order_id=${orderId} and r.state<>'completed'
      and not exists (
        select 1 from line_voids v join order_lines l on l.tenant_id=v.tenant_id and l.id=v.line_id
        where v.order_id=r.order_id and l.round=r.number and l.data->>'station'=r.station
          and v.kitchen_ack_required and v.kitchen_acknowledged_at is null)
      and not exists (
        select 1 from order_lines l
        where l.order_id=r.order_id and l.round=r.number and l.data->>'station'=r.station
          and (l.data->>'quantity')::int >
            coalesce((select sum(cardinality(v.units)) from line_voids v
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
  const { approval, ...rest } = input;
  // The fingerprint names the approver but never includes the secret.
  const fingerprint = { orderId, ...rest, approver: approval?.login ?? null };
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

    let voided = 0;
    for (const request of input.lines) {
      const line = order.lines.find((l) => l.id === request.lineId);
      if (!line || line.round === undefined)
        throw new DomainError("not_found", 404);
      // Void the highest-numbered unpaid units; paid units require a refund.
      const unpaid = order
        .paymentUnits!.filter((u) => u.lineId === line.id && u.paid === 0)
        .sort((a, b) => b.unit - a.unit);
      if (unpaid.length < request.quantity)
        throw new DomainError("void_exceeds_unpaid", 409);
      const units = unpaid.slice(0, request.quantity);
      const amount = units.reduce((a, u) => a + u.total, 0);

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
      });
      voided += amount;
    }
    await tx`update orders set total=total-${voided},version=version+1 where id=${orderId}`;
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
      await closeFullyVoidedRounds(tx, r.order_id);
      await refreshOrderState(tx, r.order_id);
      await audit(tx, s, "kitchen.void_ack", r.id, {
        voids: acknowledged.map((v) => v.id),
      });
      await bumpKitchenFeed(tx, s);
      return { ok: true, acknowledged: acknowledged.length };
    },
  );
}
