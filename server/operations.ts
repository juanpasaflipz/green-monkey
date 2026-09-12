import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tx } from "./db.js";
import { id, money, DomainError, type Session } from "../shared/domain.js";
import { once, audit, drawer, getOrder } from "./orders.js";
import { permit, managers } from "./auth.js";
export async function cashSummary(tx: Tx, s: Session) {
  const [d] =
    await tx`select * from cash_sessions where device_id=${s.deviceId} order by opened_at desc limit 1`;
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
    expected,
    tenders,
    refunds,
    movements,
    discrepancy: d.counted === null ? null : d.counted - expected,
  };
}
export async function refund(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
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
