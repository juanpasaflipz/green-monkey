// Kiosk accepts (039; specs/kiosk-w4.md §4.1, §4.5; critic R4, R10, R12, R23): the kiosk actor,
// the zero-total accept and payments' `kiosk_hold` settler. LD-72: a kiosk order reaches the
// kitchen without a staff tap only when its card charge is approved (or it costs nothing).
//
// Lock order (docs/ARCHITECTURE.md rows 56 and 58, exception E8):
//   kioskAccept            1 (checkout.fire_operation_id) → 2 → 2b (hold → checkout) → 1′ (the
//                          hold's order key) → createOrder → linkFromKiosk → hold update
//   settleKioskHoldCharge  1 (attempt.settle_operation_id) → 2 → 2b (hold → checkout) → 2c
//                          (attempt) → 1′ (the hold's order key) → createOrder → linkFromKiosk →
//                          11 (the attempt's drawer) → tender → refresh [12] → receipt job
//   refused (second tx)    1 → 2 → 2b → 2c → attempt to review with a kiosk_settle_* code
import { createHash } from "node:crypto";
import type { Tx } from "./db.js";
import { DomainError, type Order, type Session } from "../shared/domain.js";
import { audit, getOrder, once } from "./orders.js";
import {
  chargeTakenInTime,
  createHoldOrder,
  finishHoldAccept,
  lockHold,
} from "./public-holds.js";
import { linkFromKiosk } from "./loyalty/links.js";
import {
  applyApprovedAttempt,
  jobSession,
  registerAttemptSettler,
  type AttemptRow,
  type ManagerRecord,
  type SettleOutcome,
  type SettleVia,
} from "./payments/terminal.js";
import { kioskSettleCode } from "../shared/kiosk.js";

/** The receiving till's open drawer and its opener, or null when the till is closed. */
export async function receivingDrawer(
  tx: Tx,
  registerDeviceId: string | null,
): Promise<{ id: string; employee_id: string } | null> {
  if (!registerDeviceId) return null;
  const [d] = await tx<{ id: string; employee_id: string }[]>`
    select id,employee_id from cash_sessions where device_id=${registerDeviceId} and closed_at is null`;
  return d ?? null;
}

/**
 * The kiosk actor (§4.1, decision Q3): the employee who opened the receiving till's current
 * drawer, on that till, so drawer() finds its drawer and reports keep kiosk orders in the
 * "QR / Kiosco" row. Authorizes nothing by itself: callers checked the device binding. No open
 * drawer: kiosk_till_closed.
 */
export async function kioskActor(
  tx: Tx,
  station: { id: string; register_device_id: string | null },
  kioskDeviceId: string | null,
): Promise<Session> {
  const d = await receivingDrawer(tx, station.register_device_id);
  if (!d) throw new DomainError("kiosk_till_closed", 409);
  const [r] =
    await tx`select id,name,currency,timezone,cutoff from restaurants where id=current_setting('app.tenant_id')::uuid`;
  if (!r) throw new DomainError("not_found", 404);
  const [e] = await tx`select name from employees where id=${d.employee_id}`;
  return {
    id: `kiosk:${kioskDeviceId ?? station.id}`,
    tenantId: r.id as string,
    employeeId: d.employee_id,
    name: `Kiosco · ${(e?.name as string | undefined) ?? ""}`.trim(),
    role: "cashier",
    deviceId: station.register_device_id!,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    offlineUntil: "",
    csrf: "",
    restaurant: {
      name: r.name as string,
      currency: r.currency as string,
      timezone: r.timezone as string,
      cutoff: r.cutoff as number,
    },
  };
}

/** The settle's attribution: the attempt's employee and till (payments' jobSession), as the kiosk. */
async function settleActor(tx: Tx, a: AttemptRow): Promise<Session> {
  const s = await jobSession(tx, a);
  const [c] =
    await tx`select device_id,station_id from kiosk_checkouts where hold_id=${a.hold_id}`;
  return {
    ...s,
    id: `kiosk:${(c?.device_id as string | null) ?? (c?.station_id as string | undefined) ?? a.id}`,
  };
}

/** The member the diner identified at the kiosk, linked right after createOrder (R23). */
async function linkMember(tx: Tx, s: Session, holdId: string, order: Order) {
  const [c] =
    await tx`select loyalty_member_id from kiosk_checkouts where hold_id=${holdId}`;
  if (c?.loyalty_member_id)
    await linkFromKiosk(tx, s, order.id, c.loyalty_member_id as string);
}

const fingerprint = (attemptId: string) =>
  createHash("sha256").update(JSON.stringify({ attemptId })).digest("hex");

/**
 * Payments' `kiosk_hold` settler (critic R10): an approved card charge becomes the hold's order
 * with the charge as its tender, in one transaction, as the kiosk. Exactly once under the
 * attempt's settle key (the job, the kiosk's sync, the staff sync and a retry race onto it). A
 * domain error rolls back and payments then runs `refused` (review) in a second transaction.
 * Never gated by PUBLIC_ORDERING_ENABLED or KIOSK_SELF_CHECKOUT_ENABLED (§2.14).
 */
export async function settleKioskHoldCharge(
  tx: Tx,
  s: Session,
  attempt: AttemptRow,
  via: SettleVia,
  manager?: ManagerRecord,
): Promise<SettleOutcome> {
  const key = attempt.settle_operation_id;
  await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + key},0))`;
  const [prior] =
    await tx`select kind,hash,result from operations where id=${key}`;
  if (prior) {
    if (prior.kind !== "payment" || prior.hash !== fingerprint(attempt.id))
      throw new DomainError("operation_conflict", 409);
    return { state: "settled", order: prior.result as Order };
  }
  const [restaurant] =
    await tx`select currency,timezone,cutoff from restaurants where id=${s.tenantId} for share`;
  if (
    !restaurant ||
    restaurant.currency !== s.restaurant.currency ||
    restaurant.timezone !== s.restaurant.timezone ||
    restaurant.cutoff !== s.restaurant.cutoff
  )
    throw new DomainError("settings_changed", 409);
  // LO-2b: the hold, then its checkout (lockHold). Money taken while the hold was valid passes
  // its expiry (critic R12), also on a retry from review long after it.
  const holdId = attempt.hold_id!;
  const h = await lockHold(tx, holdId, {
    paidInTime: await chargeTakenInTime(tx, holdId, attempt.id),
  });
  // LO-2c: the attempt row, fresh under its lock.
  const [a] = await tx<
    AttemptRow[]
  >`select * from payment_attempts where id=${attempt.id} for update`;
  if (a.state === "settled" && a.order_id)
    return { state: "settled", order: await getOrder(tx, a.order_id) };
  const body = {
    target: { kind: "new" as const },
    excludeLineIds: [],
    acknowledgedTotal: null,
    // The guest already paid: a code deactivated as abuse since still gets its order.
    abuseAcknowledged: true,
  };
  const r = await createHoldOrder(tx, s, h, body, true);
  await linkMember(tx, s, holdId, r.order);
  if (a.amount !== r.order.total - r.order.paid)
    throw new DomainError("kiosk_settle_price_changed", 409);
  const out = await applyApprovedAttempt(tx, s, a, via, manager, r.order.id);
  // A review here would leave an order without its money: roll everything back and let payments
  // record the review with its own code in the second transaction.
  if (out.state === "review") throw new DomainError(out.errorCode, 409);
  r.order = out.order;
  const result = await finishHoldAccept(tx, s, h, body, r, {
    paid: true,
    decisionSource: "kiosk",
  });
  await tx`insert into operations(tenant_id,id,kind,hash,result)
    values(${s.tenantId},${key},'payment',${fingerprint(attempt.id)},${tx.json(result.order as never)})`;
  return { state: "settled", order: result.order };
}

/**
 * The settle's second transaction (critic R10): 1 → 2 → 2b (hold → checkout) → 2c, and the
 * attempt, still approved, moves to review with the code (payments' own codes are kept; any other
 * becomes a kiosk_settle_* code, R9). Staff see the red card and resolve it.
 */
export async function kioskSettleRefused(
  tx: Tx,
  attempt: AttemptRow,
  code: string,
): Promise<void> {
  const s = await settleActor(tx, attempt);
  await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + attempt.settle_operation_id},0))`;
  await tx`select id from restaurants where id=${s.tenantId} for share`;
  await tx`select id from public_order_holds where id=${attempt.hold_id} for update`;
  await tx`select hold_id from kiosk_checkouts where hold_id=${attempt.hold_id} for update`;
  const [a] = await tx<
    AttemptRow[]
  >`select * from payment_attempts where id=${attempt.id} for update`;
  if (a.state !== "approved") return;
  const errorCode = code.startsWith("payments_") ? code : kioskSettleCode(code);
  await tx`update payment_attempts set state='review',error_code=${errorCode},version=version+1
    where id=${a.id}`;
  await tx`insert into payment_attempt_events(tenant_id,id,attempt_id,kind,actor,employee_id,detail)
    values(${s.tenantId},gen_random_uuid(),${a.id},'review','job',null,${tx.json({ code: errorCode, via: "kiosk" })})`;
  await audit(tx, s, "kiosk.settle_refused", attempt.hold_id!, {
    attemptId: a.id,
    code: errorCode,
    via: { kind: "kiosk" },
  });
}

/**
 * A zero-total kiosk order (§2.15): nothing to collect, so the kiosk accepts it itself when
 * self-checkout is available. Exactly once under the checkout's fire key.
 */
export async function kioskAccept(
  tx: Tx,
  holdId: string,
  station: { id: string; register_device_id: string | null },
  kioskDeviceId: string,
): Promise<{ orderNumber: number }> {
  const s = await kioskActor(tx, station, kioskDeviceId);
  const [c] =
    await tx`select fire_operation_id from kiosk_checkouts where hold_id=${holdId}`;
  if (!c) throw new DomainError("not_found", 404);
  return once(
    tx,
    s,
    c.fire_operation_id as string,
    "kiosk.accept",
    { holdId },
    async () => {
      const h = await lockHold(tx, holdId);
      if (
        h.lines.length === 0 ||
        Number(h.priced.reduce((n, l) => n + l.total, 0)) !== 0
      )
        throw new DomainError("invalid_input");
      const body = {
        target: { kind: "new" as const },
        excludeLineIds: [],
        acknowledgedTotal: null,
        abuseAcknowledged: false,
      };
      const r = await createHoldOrder(tx, s, h, body, false);
      await linkMember(tx, s, holdId, r.order);
      await finishHoldAccept(tx, s, h, body, r, {
        paid: false,
        decisionSource: "kiosk",
      });
      return { orderNumber: r.order.number };
    },
  );
}

let registered = false;
/** Registers the `kiosk_hold` settler with payments (server/index.ts and the DB suites). */
export function registerKioskSettler(): void {
  if (registered) return;
  registered = true;
  registerAttemptSettler("kiosk_hold", {
    actor: settleActor,
    settle: settleKioskHoldCharge,
    refused: kioskSettleRefused,
  });
}
