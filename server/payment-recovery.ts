import type { Tx } from "./db.js";
import { hash, permit, operators } from "./auth.js";
import { paymentInput, recordPayment } from "./orders.js";
import { DomainError, type Session } from "../shared/domain.js";
import { paymentAttemptV1 } from "../shared/offline-recovery.js";

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
    attempt.sessionId === s.id &&
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
