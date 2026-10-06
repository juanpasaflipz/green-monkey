import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tx } from "./db.js";
import { id, money, type Session } from "../shared/domain.js";
import { once, audit, drawer } from "./orders.js";
import { permit, managers } from "./auth.js";
import { requireRecentAuth } from "./access.js";
import { requireSelling } from "./free-limits.js";
// discounts (028): the drawer reads and close live in cash.ts and the refunds
// (new and legacy) in refunds.ts; insertRefundBatch is the single caller of
// fiscal's recordRefundTax. These re-exports keep server/index.ts unchanged.
import { cashSummary, cashHistory, closeCash } from "./cash.js";
import { refund } from "./refunds.js";
export { cashSummary, cashHistory, closeCash, refund };

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
