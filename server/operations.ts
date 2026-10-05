import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tx } from "./db.js";
import { id, money, DomainError, type Session } from "../shared/domain.js";
import { once, audit, drawer, getOrder } from "./orders.js";
import { permit, managers } from "./auth.js";
import { requireRecentAuth } from "./access.js";
import { requireSelling } from "./free-limits.js";
export async function cashSummary(tx: Tx, s: Session, drawerId?: string) {
  if (drawerId) permit(s, managers);
  const [d] = drawerId
    ? await tx`select * from cash_sessions where id=${drawerId}`
    : await tx`select * from cash_sessions where device_id=${s.deviceId} order by opened_at desc limit 1`;
  if (!d) return null;
  const tenders =
    await tx`select * from tenders where session_id=${d.id} order by created_at`;
  const refunds = await tx`select * from refunds where session_id=${d.id}`;
  const movements =
    await tx`select * from cash_movements where session_id=${d.id}`;
  const expected =
    d.opening +
    tenders
      .filter((t) => t.method === "cash")
      .reduce((a, t) => a + t.amount + t.tip, 0) -
    refunds.reduce((a, r) => a + r.amount, 0) +
    movements.reduce((a, m) => a + m.amount, 0);
  return {
    ...d,
    originalDiscrepancy: d.counted === null ? null : d.counted - d.expected,
    closedExpected: d.expected,
    lateRecovery: d.closed_at
      ? tenders
          .filter((t) => t.method === "cash" && t.created_at > d.closed_at)
          .reduce((sum, t) => sum + t.amount + t.tip, 0)
      : 0,
    expected,
    tenders,
    refunds,
    movements,
    discrepancy: d.counted === null ? null : d.counted - expected,
  };
}

export async function cashHistory(tx: Tx, s: Session, offset: number) {
  permit(s, managers);
  return tx`select c.id,c.opened_at,c.closed_at,d.name as device_name,
    c.expected,c.counted,c.reason,
    coalesce((select sum(t.amount+t.tip) from tenders t where t.session_id=c.id and t.method='cash' and t.created_at>c.closed_at),0)::int as late_recovery,
    (select jsonb_agg(distinct o.restaurant_snapshot->>'currency') from tenders t join orders o on o.tenant_id=t.tenant_id and o.id=t.order_id where t.session_id=c.id) as currencies
    from cash_sessions c join devices d on d.tenant_id=c.tenant_id and d.id=c.device_id
    where c.closed_at is not null order by c.closed_at desc,c.id limit 50 offset ${offset}`;
}
export async function refund(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  requireRecentAuth(s);
  const p = z
    .object({
      operationId: id,
      tenderId: id,
      amount: money.refine((n) => n > 0),
      reason: z.string().min(3).max(300),
      disposition: z.enum(["discard", "no_stock_return"]),
    })
    .strict()
    .parse(raw);
  return once(tx, s, p.operationId, "refund", p, async () => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + p.tenderId},0))`;
    const [t] = await tx`select * from tenders where id=${p.tenderId}`;
    if (!t) throw new DomainError("not_found", 404);
    const [r] =
      await tx`select coalesce(sum(amount),0)::int as amount from refunds where tender_id=${p.tenderId}`;
    if (p.amount > t.amount - r.amount)
      throw new DomainError("refund_exceeds", 409);
    if (t.method === "external")
      throw new DomainError("external_refund_unverified", 409);
    const d = await drawer(tx, s);
    await tx`insert into refunds(tenant_id,id,tender_id,session_id,amount,reason,disposition,actor_id) values(${s.tenantId},${randomUUID()},${t.id},${d.id},${p.amount},${p.reason},${p.disposition},${s.employeeId})`;
    await audit(tx, s, "refund.recorded", t.order_id, p);
    return getOrder(tx, t.order_id);
  });
}

export async function closeCash(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = z
    .object({ operationId: id, counted: money, reason: z.string().max(300) })
    .strict()
    .parse(raw);
  return once(tx, s, p.operationId, "cash.close", p, async () => {
    const d = await drawer(tx, s);
    const summary = await cashSummary(tx, s);
    if (summary!.expected !== p.counted && p.reason.trim().length < 3)
      throw new DomainError("reason_required");
    await tx`update cash_sessions set counted=${p.counted},expected=${summary!.expected},reason=${p.reason},closed_at=clock_timestamp() where id=${d.id}`;
    await audit(tx, s, "cash.close", d.id, p);
    return cashSummary(tx, s);
  });
}

/** Manager cash paid-out from this device's open drawer (moved verbatim from index.ts). */
export async function recordPaidOut(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  requireRecentAuth(s);
  const p = z
    .object({
      operationId: id,
      amount: money.refine((n) => n > 0),
      reason: z.string().min(3).max(300),
    })
    .strict()
    .parse(raw);
  return once(tx, s, p.operationId, "cash.paidout", p, async () => {
    await requireSelling(tx, s);
    const d = await drawer(tx, s);
    await tx`insert into cash_movements(tenant_id,id,session_id,amount,reason) values(${s.tenantId},${randomUUID()},${d.id},${-p.amount},${p.reason})`;
    await audit(tx, s, "cash.paidout", d.id, p);
    return cashSummary(tx, s);
  });
}
