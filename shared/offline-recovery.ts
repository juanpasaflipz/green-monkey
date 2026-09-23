import { z } from "zod";
import { id, money, orderInput } from "./domain.js";

export const offlineSaleV1 = z
  .object({
    operationId: id,
    order: orderInput,
    expectedTotal: money.refine((n) => n > 0),
    received: money,
    tip: money,
    recordedAt: z.string().datetime(),
    sessionId: id,
    cashSessionId: id,
  })
  .strict();

export const offlineReceiptSnapshot = z
  .object({
    lines: z.array(z.unknown()).max(1000),
    restaurant: z
      .object({
        name: z.string().min(1).max(200),
        currency: z.string().regex(/^[A-Z]{3}$/),
        timezone: z.string().min(1).max(100),
        cutoff: z.number().int().min(0).max(1439),
        configVersion: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();

export const offlineSaleV2 = offlineSaleV1.extend({
  formatVersion: z.literal(2),
  tenantId: id,
  employeeId: id,
  deviceId: id,
  leaseVersion: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  currencyExponent: z.number().int().min(0).max(3),
  configurationVersion: z.number().int().nonnegative().nullable(),
  receiptSnapshot: offlineReceiptSnapshot.optional(),
});

// Do not add defaults to v1: its exact parsed shape is part of the durable
// idempotency fingerprint for records already accepted by older clients.
export const offlineSale = z.union([offlineSaleV2, offlineSaleV1]);
export type OfflineSale = z.infer<typeof offlineSale>;

export const paymentAttemptV1 = z
  .object({
    formatVersion: z.literal(1),
    tenantId: id,
    employeeId: id,
    deviceId: id,
    sessionId: id.nullable(),
    cashSessionId: id.nullable(),
    orderId: id,
    createdAt: z.string().datetime().nullable(),
    payload: z
      .object({
        operationId: id,
        amount: money.refine((n) => n > 0),
        tip: money,
        received: money,
        method: z.enum(["cash", "external"]),
        externalConfirmed: z.boolean(),
        reference: z.string().max(120),
        items: z.array(z.string()).max(9900).optional(),
      })
      .strict(),
  })
  .strict();
export type PaymentAttempt = z.infer<typeof paymentAttemptV1>;

export const legacyPaymentAttempt = z
  .object({
    orderId: id,
    payload: paymentAttemptV1.shape.payload,
  })
  .strict();

export function normalizePaymentAttempt(
  value: unknown,
  cacheId: string,
): PaymentAttempt | null {
  const current = paymentAttemptV1.safeParse(value);
  if (current.success) return current.data;
  const legacy = legacyPaymentAttempt.safeParse(value);
  const parts = cacheId.split(":");
  if (!legacy.success || parts.length !== 4 || parts[3] !== "payment")
    return null;
  const [tenantId, deviceId, employeeId] = parts;
  const normalized = paymentAttemptV1.safeParse({
    formatVersion: 1,
    tenantId,
    employeeId,
    deviceId,
    sessionId: null,
    cashSessionId: null,
    orderId: legacy.data.orderId,
    createdAt: null,
    payload: legacy.data.payload,
  });
  return normalized.success ? normalized.data : null;
}

const backupSale = z
  .object({
    id,
    scope: z.string().min(1).max(300),
    body: offlineSale,
    receipt: offlineReceiptSnapshot.optional(),
  })
  .strict();

export const recoveryBackupV1 = z
  .object({
    format: z.literal("green-monkey-offline-v1"),
    tenantId: id,
    sales: z.array(backupSale).max(10000),
  })
  .strict();

export const recoveryBackupV2 = z
  .object({
    format: z.literal("green-monkey-recovery-v2"),
    tenantId: id,
    exportedAt: z.string().datetime(),
    sales: z.array(backupSale).max(10000),
    paymentAttempts: z.array(paymentAttemptV1).max(10000),
  })
  .strict();

export const recoveryBackup = z.union([recoveryBackupV2, recoveryBackupV1]);
export type RecoveryBackup = z.infer<typeof recoveryBackup>;

// Object property order is not evidence. Backups may be serialized by a different
// browser/version, but array order and every value must still match exactly.
export function evidenceKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(evidenceKey).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${evidenceKey(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
