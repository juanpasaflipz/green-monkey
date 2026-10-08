import type { Tx } from "./db.js";
import { hash, permit, operators } from "./auth.js";
import { paymentInput, recordPayment } from "./orders.js";
import { DomainError, type Session } from "../shared/domain.js";
import { paymentAttemptV1 } from "../shared/offline-recovery.js";

/**
 * The attempt's session, or a successor of it: the same employee on the same
 * device after that session ended normally or expired (logout, switch back,
 * renewal, PIN reset, role change, the 16 h cap), as with OFF-7 evidence. A
 * revoked session (deactivation, unpaired device) or one still live elsewhere
 * goes to review instead (ACC-FLOOR-1).
 */
async function sameSessionLine(tx: Tx, s: Session, sessionId: string | null) {
  if (sessionId === s.id) return true;
  if (!sessionId) return false;
  const [prior] = await tx`select employee_id,device_id,revoked,
      (ended_at is not null or expires_at<=now()) as finished
    from sessions where id=${sessionId}`;
  return Boolean(
    prior &&
    prior.employee_id === s.employeeId &&
    prior.device_id === s.deviceId &&
    !prior.revoked &&
    prior.finished,
  );
}

export async function paymentRecoveryStatus(tx: Tx, s: Session, raw: unknown) {
  permit(s, operators);
  const attempt = paymentAttemptV1.parse(raw);
  if (attempt.tenantId !== s.tenantId) throw new DomainError("forbidden", 403);
  const manager = ["owner", "manager"].includes(s.role);
  if (
    !manager &&
    (attempt.employeeId !== s.employeeId || attempt.deviceId !== s.deviceId)
  )
    throw new DomainError("forbidden", 403);
  const [operation] =
    await tx`select kind,hash,result from operations where id=${attempt.payload.operationId}`;
  if (operation) {
    const same =
      operation.hash ===
      hash(
        JSON.stringify({
          orderId: attempt.orderId,
          ...paymentInput.parse(attempt.payload),
        }),
      );
    // A manager verified the guest was not charged (OFFLINE-RECOVERY-05).
    if (same && operation.kind === "payment_attempt_discarded")
      return { state: "discarded" as const, retryAllowed: false };
    if (operation.kind !== "payment" || !same)
      throw new DomainError("operation_conflict", 409);
    return { state: "committed" as const, result: operation.result };
  }
  const [order] = await tx`select id from orders where id=${attempt.orderId}`;
  if (!order) return { state: "order_missing" as const, retryAllowed: false };
  const [cash] = attempt.cashSessionId
    ? await tx`select id,device_id,closed_at from cash_sessions where id=${attempt.cashSessionId}`
    : [];
  const retryAllowed = Boolean(
    (await sameSessionLine(tx, s, attempt.sessionId)) &&
    attempt.employeeId === s.employeeId &&
    attempt.deviceId === s.deviceId &&
    cash &&
    cash.device_id === s.deviceId &&
    !cash.closed_at,
  );
  return {
    state: "missing" as const,
    retryAllowed,
    reviewRequired: !retryAllowed,
  };
}

export async function retryPaymentRecovery(tx: Tx, s: Session, raw: unknown) {
  const attempt = paymentAttemptV1.parse(raw);
  const status = await paymentRecoveryStatus(tx, s, attempt);
  if (status.state === "committed") return status.result;
  if (!status.retryAllowed)
    throw new DomainError("payment_review_required", 409);
  return recordPayment(
    tx,
    s,
    attempt.orderId,
    attempt.payload,
    null,
    attempt.cashSessionId!,
  );
}
