/**
 * Device storage keys (pure: no Dexie, no DOM), shared by the offline store,
 * the sync loop and the record builders.
 */
import type { Session } from "../shared/domain";

/** One employee's queue on one device of one restaurant. */
export const scope = (
  s: Pick<Session, "tenantId" | "deviceId" | "employeeId">,
) => `${s.tenantId}:${s.deviceId}:${s.employeeId}`;

/** Every employee's rows on this device of this restaurant start with this. */
export const devicePrefix = (s: Pick<Session, "tenantId" | "deviceId">) =>
  `${s.tenantId}:${s.deviceId}:`;

/** The single in-flight online payment attempt of this scope. */
export const activeAttemptKey = (s: Session) => `${scope(s)}:payment`;

/** An unresolved attempt moved aside so it never blocks other orders (OFF-2). */
export const parkedAttemptKey = (s: Session, operationId: string) =>
  `${scope(s)}:payment:${operationId}`;

export const isAttemptKey = (key: string) =>
  /:payment(:[0-9a-f-]{36})?$/i.test(key);
