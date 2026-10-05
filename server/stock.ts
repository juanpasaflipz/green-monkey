// Stock ledger writes (DB-4, DB-5). Leaf module: orders.ts re-exports stock().
// The BEFORE INSERT trigger on stock_movements (migration 025) is the only
// writer of stock_items.on_hand, negative_since and stock_movements.balance_after.
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type { Tx } from "./db.js";
import { DomainError, type Session } from "../shared/domain.js";
import type { NegativeStockPolicy } from "../shared/menu.js";

export type { NegativeStockPolicy };

/** Causes that a restaurant's `block` policy may refuse when they go negative. */
export const BLOCKABLE_CAUSES = new Set(["sale", "waste", "prep_input"]);
/**
 * Movements a manager records by hand (POST /inventory/movement, /inventory/
 * prep, /receiving). They are refused on an archived item, which has left
 * Existencias (§2.9, MENU-R2). Sales, void returns and opening balances are
 * not: they follow recipes and orders recorded before the archive.
 */
export const MANUAL_CAUSES = new Set([
  "receipt",
  "waste",
  "count_adjust",
  "prep_input",
  "prep_output",
]);

export async function negativeStockPolicy(
  tx: Tx,
): Promise<NegativeStockPolicy> {
  const [r] =
    await tx`select negative_stock_policy from restaurants where id=current_setting('app.tenant_id')::uuid`;
  return (r?.negative_stock_policy ?? "allow") as NegativeStockPolicy;
}

/**
 * Locks every listed stock row in one global (uuid) order before any movement,
 * so commands touching the same ingredients in a different line order cannot
 * deadlock. SELECT … ORDER BY … FOR UPDATE sorts before it locks.
 */
export async function lockStockItems(
  tx: Tx,
  ids: Iterable<string>,
): Promise<void> {
  const unique = [...new Set(ids)].sort();
  if (!unique.length) return;
  await tx`select id from stock_items where id=any(${tx.array(unique)}::uuid[]) order by id for update`;
}

/**
 * Appends one movement unless the same (stock, cause, causeId) already exists.
 * Reads the cached balance from the row it locks (no SUM over history). A
 * decrease past zero is refused only for blockable causes under the `block`
 * policy; pass "allow" to skip the policy (increases, offline cash collected).
 */
export async function stock(
  tx: Tx,
  s: Session,
  stockId: string,
  quantity: string,
  cause: string,
  causeId: string,
  reason: string,
  policy?: NegativeStockPolicy,
): Promise<void> {
  const [item] =
    await tx`select id,on_hand::text as on_hand,archived_at is not null as archived from stock_items where id=${stockId} for update`;
  if (!item) throw new DomainError("not_found", 404);
  const [existing] =
    await tx`select id from stock_movements where stock_id=${stockId} and cause=${cause} and cause_id=${causeId}`;
  if (existing) return;
  if (item.archived && MANUAL_CAUSES.has(cause))
    throw new DomainError("stock_archived", 409);
  const delta = new Decimal(quantity);
  if (
    delta.isNegative() &&
    new Decimal(item.on_hand).add(delta).isNegative() &&
    BLOCKABLE_CAUSES.has(cause) &&
    (policy ?? (await negativeStockPolicy(tx))) === "block"
  )
    throw new DomainError("insufficient_stock", 409);
  await tx`insert into stock_movements(tenant_id,id,stock_id,quantity,cause,cause_id,reason,actor_id) values(${s.tenantId},${randomUUID()},${stockId},${quantity},${cause},${causeId},${reason},${s.employeeId})`;
  // Still bumped per movement: count adjustments detect concurrent movement.
  await tx`update stock_items set version=version+1 where id=${stockId}`;
}
