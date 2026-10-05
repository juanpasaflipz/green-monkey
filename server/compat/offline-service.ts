/**
 * In-wave fallback for service's (024) check lifecycle and kitchen feed (wave
 * contracts §3.3, §3.4, §6). Base semantics only. At offline's merge the
 * integrator imports from ../kitchen.js, ../checks.js and ../orders.js and
 * deletes this file.
 */
import type { Tx } from "../db.js";
import {
  DomainError,
  sum,
  type PricedLine,
  type Session,
} from "../../shared/domain.js";
import { append, audit, type AppendOptions } from "../orders.js";

/** service: bumps the KDS feed version (last lock-taking statement). No-op before service. */
export async function bumpKitchenFeed(_tx: Tx, _s: Session): Promise<void> {}

/** service: recomputes orders.check_state. Before service there is no check state. */
export async function refreshCheckState(
  _tx: Tx,
  _s: Session,
  _orderId: string,
): Promise<"open" | "paid" | "closed"> {
  return "open";
}

/** service: refuses writes to closed, cancelled or recovery checks. */
export function assertCheckWritable(row: {
  check_state?: string;
  state: string;
}): void {
  if (
    ["cancelled", "recovery_pending", "recovery_reviewed"].includes(row.state)
  )
    throw new DomainError("stale_order", 409);
}

/** service: the shared tail of every round. The caller holds FOR UPDATE on the order. */
export async function applyRound(
  tx: Tx,
  s: Session,
  order: { id: string; version: number; state: string; check_state?: string },
  lines: PricedLine[],
  opts: AppendOptions & { detail?: Record<string, unknown> } = {},
): Promise<number> {
  assertCheckWritable(order);
  const n = order.version + 1;
  await append(tx, s, order.id, lines, n, opts);
  await tx`update orders set total=total+${sum(lines.map((l) => l.total))},version=version+1,state='active' where id=${order.id}`;
  await audit(tx, s, "order.round", order.id, opts.detail ?? {});
  await refreshCheckState(tx, s, order.id);
  return n;
}
