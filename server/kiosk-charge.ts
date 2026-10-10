// Card payment at the kiosk (039; specs/kiosk-w4.md §2.5, §4.4–4.5; critic R10–R12, R24): start,
// cancel and sync of a hold-target payments attempt. Provider calls are the payments worker's,
// after commit; nothing here talks to a provider. Every payments_* refusal reaches the diner as a
// kiosk_* code with no detail (critic R11: payments' busy error names another order).
//
// Lock order (ARCHITECTURE rows 57 and 59):
//   kioskStartCharge   1 (the diner's attempt key) → 2 → 2b (hold → checkout) → startCharge (3: 933,
//                      terminal row FOR SHARE; 11: the receiving till's drawer; attempt insert) →
//                      checkout update
//   kioskCancelCharge  payments' requestCancel: 1 → 2 → 2c (the checkout is read, not locked)
import type postgres from "postgres";
import { tenant, type Tx } from "./db.js";
import { DomainError } from "../shared/domain.js";
import { audit } from "./orders.js";
import {
  startCharge,
  requestCancel,
  syncAttemptCore,
} from "./payments/terminal.js";
import { liveAttemptForHold } from "./payments/guards.js";
import { catalog } from "./menu-read.js";
import { quote, sum } from "../shared/domain.js";
import { cancelOutcome } from "../shared/payments.js";
import { reconcileOrder } from "./loyalty/ledger.js";
import { kioskActor } from "./kiosk-accept.js";
import {
  checkoutView,
  kioskHoldByKey,
  kioskMinimum,
  lockKioskHold,
  requireDevice,
} from "./kiosk-diner.js";
import {
  KIOSK_LIMITS,
  kioskCancelChargeInput,
  kioskChargeInput,
  kioskStatusInput,
  type KioskCheckoutView,
} from "../shared/kiosk.js";

/** Codes a re-quote turns into "Ya no disponible" (the inbox's set). */
const UNAVAILABLE = new Set([
  "unavailable",
  "invalid_modifier",
  "required_modifier",
  "forbidden",
  "open_amount_exceeds",
  "invalid_amount",
]);

/** A payments refusal as the diner sees it (critic R11). */
export function dinerChargeError(e: unknown): unknown {
  if (!(e instanceof DomainError)) return e;
  if (e.code === "payments_terminal_busy")
    return new DomainError("kiosk_terminal_busy", 409);
  if (e.code === "payments_amount_below_min")
    return new DomainError("kiosk_amount_below_min", 409);
  if (
    e.code.startsWith("payments_") ||
    e.code === "pro_required" ||
    e.code === "no_open_drawer" ||
    e.code === "drawer_closed"
  )
    return new DomainError("kiosk_card_unavailable", 409);
  return e;
}

/**
 * POST /api/public/kiosk/charge: "Pagar aquí con tarjeta". Re-quotes the hold against the menu
 * now (public_price_changed / unavailable: the kiosk refreshes and marks the lines), then starts
 * one payments attempt for the exact quote on the station's terminal, bound to the hold. A replay
 * of the same operationId returns that attempt; a different one while an attempt is live is
 * kiosk_charge_pending. At most 3 attempts per hold.
 */
export async function kioskStartCharge(
  tx: Tx,
  linkId: string,
  raw: unknown,
  secret: string | null,
): Promise<KioskCheckoutView> {
  const p = kioskChargeInput.parse(raw);
  // LO-1: the diner's attempt key (disjoint from staff once() keys).
  await tx`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id')||':public-op:'||${p.operationId},0))`;
  const { station, device, state } = await requireDevice(tx, linkId, secret);
  const [prior] =
    await tx`select hold_id from payment_attempts where operation_id=${p.operationId} and origin='kiosk'`;
  // LO-2 then LO-2b: the restaurant row, the hold, then its checkout.
  await tx`select id from restaurants where id=current_setting('app.tenant_id')::uuid for share`;
  const { h, c } = await lockKioskHold(tx, linkId, p.statusKey);
  if (prior) {
    if (prior.hold_id !== h.id)
      throw new DomainError("operation_conflict", 409);
    return checkoutView(tx, h, c);
  }
  if (c.station_id !== station.id || (c.device_id && c.device_id !== device.id))
    throw new DomainError("kiosk_device_required", 403);
  if (!state.card || !state.terminal)
    throw new DomainError("kiosk_card_unavailable", 409);
  if (h.state !== "pending")
    throw new DomainError("public_order_not_pending", 409);
  if (h.expired) throw new DomainError("public_order_expired", 409);
  if (c.payment_choice === "counter")
    throw new DomainError("kiosk_card_unavailable", 409);
  if (await liveAttemptForHold(tx, h.id))
    throw new DomainError("kiosk_charge_pending", 409);
  if (c.attempt_count >= KIOSK_LIMITS.attempts)
    throw new DomainError("kiosk_charge_attempts", 409);
  // §2.5 step 2: the exact amount the order would be created at now.
  let current: number;
  try {
    current = sum(
      quote(
        h.lines.map(({ origin: _origin, ...l }) => ({ ...l, note: "" })),
        await catalog(tx),
        false,
      ).map((l) => l.total),
    );
  } catch (e) {
    if (e instanceof DomainError && UNAVAILABLE.has(e.code))
      throw new DomainError("unavailable", 409);
    throw e;
  }
  if (current !== h.quoted_total)
    throw new DomainError("public_price_changed", 409);
  if (current <= 0) throw new DomainError("invalid_input");
  if (current < kioskMinimum(state.terminal.provider))
    throw new DomainError("kiosk_amount_below_min", 409);
  const actor = await kioskActor(tx, station, device.id);
  let attemptId: string;
  try {
    const a = await startCharge(tx, actor, {
      operationId: p.operationId,
      target: { kind: "kiosk_hold", holdId: h.id },
      terminalId: state.terminal.id,
      amount: current,
      tip: 0,
      origin: "kiosk",
    });
    attemptId = a.id;
  } catch (e) {
    throw dinerChargeError(e);
  }
  await tx`update kiosk_checkouts set payment_choice='card',attempt_id=${attemptId},
      attempt_count=attempt_count+1,updated_at=now()
    where hold_id=${h.id}`;
  await audit(tx, actor, "kiosk.charge_started", h.id, {
    attemptId,
    amount: current,
    via: { kind: "kiosk", stationId: station.id },
  });
  return checkoutView(tx, h, {
    ...c,
    payment_choice: "card",
    attempt_id: attemptId,
    attempt_count: c.attempt_count + 1,
  });
}

/**
 * POST /api/public/kiosk/charge/cancel: the kiosk's timeout or "Cancelar" on the charging screen.
 * Payments' requestCancel (created → cancelled at once; in flight → the worker cancels if the
 * provider still allows it). The outcome follows payments' cancelOutcome: withdrawn, in_progress
 * (cancel on the reader), already_final, or pending_cancel (keep polling).
 */
export async function kioskCancelCharge(
  tx: Tx,
  linkId: string,
  raw: unknown,
  secret: string | null,
): Promise<{
  outcome: ReturnType<typeof cancelOutcome>;
  checkout: KioskCheckoutView;
}> {
  const p = kioskCancelChargeInput.parse(raw);
  const { station, device } = await requireDevice(tx, linkId, secret);
  const { h, c } = await kioskHoldByKey(tx, linkId, p.statusKey);
  if (c.station_id !== station.id)
    throw new DomainError("kiosk_device_required", 403);
  if (!c.attempt_id) throw new DomainError("not_found", 404);
  const actor = await kioskActor(tx, station, device.id).catch((e: unknown) => {
    throw dinerChargeError(e);
  });
  const view = await requestCancel(tx, actor, c.attempt_id, {
    operationId: p.operationId,
  }).catch((e: unknown) => {
    // Approved meanwhile: nothing to cancel; the kiosk shows the payment.
    if (e instanceof DomainError && e.code === "payments_not_cancellable")
      return null;
    throw dinerChargeError(e);
  });
  const [a] =
    await tx`select state,error_code from payment_attempts where id=${c.attempt_id}`;
  return {
    outcome: view
      ? cancelOutcome({
          state: a.state as string,
          error_code: (a.error_code as string | null) ?? null,
        })
      : "already_final",
    checkout: await checkoutView(tx, h, c),
  };
}

/**
 * POST /api/public/kiosk/checkout/sync (critic R24): payments' syncAttemptCore for the hold's
 * attempt (settles an approved one through the kiosk_hold settler, or wakes the worker), then the
 * club reconcile of the new order in its own transaction (R23), then the read-only view.
 */
export async function kioskSync(
  sql: postgres.Sql,
  tenantId: string,
  linkId: string,
  raw: unknown,
  secret: string | null,
): Promise<KioskCheckoutView> {
  const p = kioskStatusInput.parse(raw);
  const head = await tenant(sql, tenantId, async (tx) => {
    const { station } = await requireDevice(tx, linkId, secret);
    const { h, c } = await kioskHoldByKey(tx, linkId, p.statusKey);
    if (c.station_id !== station.id)
      throw new DomainError("kiosk_device_required", 403);
    return { attemptId: c.attempt_id, state: h.state };
  });
  if (head.attemptId) await syncAttemptCore(sql, tenantId, head.attemptId);
  const after = await tenant(sql, tenantId, async (tx) => {
    const { h, c } = await kioskHoldByKey(tx, linkId, p.statusKey);
    return { h, c };
  });
  if (after.h.state === "accepted" && after.h.order_id) {
    const orderId = after.h.order_id;
    await tenant(sql, tenantId, async (tx) => {
      const [link] =
        await tx`select member_id from loyalty_order_links where order_id=${orderId}`;
      if (link?.member_id) await reconcileOrder(tx, tenantId, orderId);
    }).catch(() => undefined);
  }
  return tenant(sql, tenantId, async (tx) => {
    const { h, c } = await kioskHoldByKey(tx, linkId, p.statusKey);
    return checkoutView(tx, h, c);
  });
}
