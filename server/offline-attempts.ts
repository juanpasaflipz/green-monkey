/**
 * Manager resolution of a parked payment attempt (OFFLINE-RECOVERY-05): an
 * online charge whose answer the device never received, that the server did
 * not record, and that the device may not resend (another session, another
 * drawer, or the order gone). Without this the attempt blocked its order on
 * the device forever and its money stayed outside the books.
 *
 * - `recorded`: the manager verified the money the guest handed over. It goes
 *   into the order, in the attempt's original drawer (open or closed), with
 *   the allocations the payment command would make. No recovery order: the
 *   order stays a normal order.
 * - `discarded`: the manager verified the guest was not charged.
 *
 * Either way the attempt's own operation id is closed for good, so the
 * original request can never also apply (exactly once): `recorded` stores the
 * same `payment` operation the original would have stored (a status check
 * then says committed and a retry returns it); `discarded` stores a
 * `payment_attempt_discarded` operation that refuses it.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tx } from "./db.js";
import { DomainError, id, type Order, type Session } from "../shared/domain.js";
import {
  offlinePaymentIssue,
  paymentAttemptV1,
} from "../shared/offline-recovery.js";
import { evidenceExtras, insertTender } from "./payments/tenders.js";
import { allocatePayment } from "../shared/settlement.js";
import { hash, managers, permit } from "./auth.js";
import { audit, getOrder, once, paymentInput } from "./orders.js";
import { requireRecentAuth } from "./access.js";
import { refreshCheckState } from "./checks.js";
import { dueOf, moneyRefusal, moneyTarget } from "./offline-sync.js";

export const DISCARDED_ATTEMPT = "payment_attempt_discarded";

const resolveInput = z
  .object({
    operationId: id,
    attempt: z.unknown(),
    outcome: z.enum(["recorded", "discarded"]),
    reason: z.string().trim().min(10).max(500),
    confirmed: z.literal(true),
  })
  .strict();

export type AttemptResolution =
  { state: "recorded" | "committed"; order: Order } | { state: "discarded" };

export async function resolvePaymentAttempt(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<AttemptResolution> {
  permit(s, managers);
  requireRecentAuth(s); // D23: money-affecting manager command
  const input = resolveInput.parse(raw);
  const attempt = paymentAttemptV1.parse(input.attempt);
  if (attempt.tenantId !== s.tenantId) throw new DomainError("forbidden", 403);
  const payload = paymentInput.parse(attempt.payload);
  return once(
    tx,
    s,
    input.operationId,
    "offline.payment_attempt",
    { attempt, outcome: input.outcome, reason: input.reason },
    async () => {
      // The attempt's own key: serialized with the original request (once()
      // takes the same lock), and decided here once and for all.
      await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + payload.operationId},0))`;
      const fingerprint = hash(
        JSON.stringify({ orderId: attempt.orderId, ...payload }),
      );
      const [prior] =
        await tx`select kind,hash,result from operations where id=${payload.operationId}`;
      if (prior) {
        if (prior.hash !== fingerprint)
          throw new DomainError("operation_conflict", 409);
        // The original charge did reach the server: nothing to record.
        if (prior.kind === "payment")
          return { state: "committed" as const, order: prior.result as Order };
        if (prior.kind === DISCARDED_ATTEMPT && input.outcome === "discarded")
          return { state: "discarded" as const };
        throw new DomainError("operation_conflict", 409);
      }
      if (input.outcome === "discarded") {
        await tx`insert into operations(tenant_id,id,kind,hash,result) values(${s.tenantId},${payload.operationId},${DISCARDED_ATTEMPT},${fingerprint},${tx.json({ discarded: true, orderId: attempt.orderId })})`;
        await audit(
          tx,
          s,
          "offline.payment_attempt_discarded",
          attempt.orderId,
          {
            reason: input.reason,
            operationId: payload.operationId,
            amount: payload.amount,
            tip: payload.tip,
            method: payload.method,
            originalEmployeeId: attempt.employeeId,
            originalDeviceId: attempt.deviceId,
            originalDrawerId: attempt.cashSessionId,
          },
        );
        return { state: "discarded" as const };
      }
      // Evidence the payment command itself would have required (payments 037: per method,
      // platform included; nothing defaults to cash).
      if (
        offlinePaymentIssue(payload) ||
        (payload.method === "platform" && payload.items)
      )
        throw new DomainError("invalid_input", 400);
      // Global lock order (§4.4.1): the order, then the drawer.
      const found = await moneyTarget(tx, attempt.orderId, true);
      if (found.state === "unresolvable")
        throw new DomainError(found.code, 409);
      if (found.state === "closed" || payload.amount > dueOf(found.order))
        throw new DomainError(moneyRefusal(payload.amount, found.order), 409);
      const [cash] = attempt.cashSessionId
        ? await tx`select id,device_id from cash_sessions where id=${attempt.cashSessionId} for update`
        : [];
      if (!cash || cash.device_id !== attempt.deviceId)
        throw new DomainError("payment_review_required", 409);
      const order = found.order;
      if (payload.items && !order.itemSplitAvailable)
        throw new DomainError("unallocated_history", 409);
      const allocations = order.itemSplitAvailable
        ? allocatePayment(order.paymentUnits!, payload.amount, payload.items)
        : [];
      const extras = await evidenceExtras(tx, payload);
      const tenderId = await insertTender(tx, s, {
        orderId: order.id,
        drawerId: cash.id,
        method: payload.method,
        amount: payload.amount,
        tip: payload.tip,
        received: payload.received,
        reference: payload.reference || null,
        source: { kind: "offline_recovery", id: payload.operationId },
        clock: true,
        terminal: extras.terminal,
        platform: extras.platform,
      });
      for (const allocation of allocations)
        await tx`insert into tender_allocations(tenant_id,order_id,tender_id,line_id,unit_index,amount)
          values(${s.tenantId},${order.id},${tenderId},${allocation.lineId},${allocation.unit},${allocation.amount})`;
      await audit(tx, s, "offline.payment_attempt_recorded", order.id, {
        reason: input.reason,
        operationId: payload.operationId,
        tenderId,
        amount: payload.amount,
        tip: payload.tip,
        method: payload.method,
        ...(extras.terminal ? { terminalId: extras.terminal.id } : {}),
        ...(extras.platform ? { platform: extras.platform.row.platform } : {}),
        ...(extras.droppedTerminalId
          ? {
              droppedTerminalId: extras.droppedTerminalId,
              note: "payments_terminal_unknown",
            }
          : {}),
        originalEmployeeId: attempt.employeeId,
        originalDeviceId: attempt.deviceId,
        originalDrawerId: cash.id,
      });
      await refreshCheckState(tx, s, order.id);
      const result = await getOrder(tx, order.id);
      // The operation the original request would have stored.
      await tx`insert into operations(tenant_id,id,kind,hash,result) values(${s.tenantId},${payload.operationId},'payment',${fingerprint},${tx.json(result as any)})`;
      return { state: "recorded" as const, order: result };
    },
  );
}
