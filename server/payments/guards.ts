// Live-attempt guards (payments 037). Plain reads, no lock: callers already hold
// the order row (LO-5), the hold (LO-2b) or the drawer (LO-11), so the lock
// order of every guarded command is unchanged (spec §4.6, ARCHITECTURE rows 3,
// 13, 25-27). The state lists match 037's partial unique indexes and
// shared/payments.ts LIVE_FOR_ORDER (tests/payments-shared.test.ts).
import type { Tx } from "../db.js";
import { DomainError } from "../../shared/domain.js";

/**
 * Refuses a write that would change what an order can take while money may be
 * in flight for it at a terminal (payments_order_attempt_live, 409). Called
 * right after the order lock by recordPayment, voids, discounts, closeCheck and
 * the settlement; never by offline evidence (OFF-8 always applies money).
 */
export async function assertNoLiveAttempt(tx: Tx, orderId: string) {
  const [live] = await tx`select id from payment_attempts
    where order_id=${orderId}
      and state in ('created','sending','pending','unknown','approved','review') limit 1`;
  if (live) throw new DomainError("payments_order_attempt_live", 409);
}

/** Attempts that keep a drawer from closing (payments_attempt_unresolved). */
export async function liveAttemptsOnDrawer(tx: Tx, drawerId: string) {
  return tx<
    {
      id: string;
      state: string;
      target: string;
      order_id: string | null;
      hold_id: string | null;
      terminal_label: string;
      amount: number;
      tip: number;
      created_at: Date;
      order_number: number | null;
      hold_channel: "qr" | "kiosk" | null;
      hold_number: number | null;
    }[]
  >`select a.id,a.state,a.target,a.order_id,a.hold_id,a.terminal_label,a.amount,a.tip,a.created_at,
        o.number as order_number,h.channel as hold_channel,h.number as hold_number
      from payment_attempts a
      left join orders o on o.tenant_id=a.tenant_id and o.id=a.order_id
      left join public_order_holds h on h.tenant_id=a.tenant_id and h.id=a.hold_id
      where a.cash_session_id=${drawerId}
        and a.state in ('created','sending','pending','unknown','approved','review')
      order by a.created_at, a.id limit 50`;
}

/**
 * The live hold-target attempt of a public hold, if any (critic R12): the kiosk
 * refuses accept, reject, cancel and append while it exists.
 */
export async function liveAttemptForHold(tx: Tx, holdId: string) {
  const [live] = await tx<{ id: string; state: string }[]>`
    select id,state from payment_attempts
    where hold_id=${holdId}
      and state in ('created','sending','pending','unknown','approved','review') limit 1`;
  return live ?? null;
}
