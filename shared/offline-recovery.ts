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

// ---------------------------------------------------------------------------
// Format v3. v1/v2 above are frozen: their parsed shape is part of durable
// idempotency fingerprints. A v3 record is immutable once it is written to the
// device, and its operationId is the server idempotency key.

/** A record may claim a sale time this far after server now (device clock ahead). */
export const OFFLINE_FUTURE_TOLERANCE_MS = 120_000;
/** A record may claim a sale time this far before its lease window or drawer started. */
export const OFFLINE_PAST_TOLERANCE_MS = 300_000;

/** Device-prefixed provisional order number, e.g. "B-07" or "A1-123". */
export const provisionalNumber = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{0,2}-\d{2,4}$/);

/** The offline lease the record was made under (never live settings). */
export const leaseRef = z
  .object({
    contractVersion: z.number().int().positive(),
    configurationVersion: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const offlinePayment = z
  .object({
    method: z.enum(["cash", "external"]),
    amount: money.refine((n) => n > 0),
    tip: money,
    received: money,
    reference: z.string().trim().max(120),
    externalConfirmed: z.boolean(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.method === "external" && (!p.externalConfirmed || !p.reference))
      ctx.addIssue({ code: "custom", message: "external_confirmation" });
    if (p.method === "external" && p.received !== p.amount + p.tip)
      ctx.addIssue({ code: "custom", message: "external_received" });
    if (p.method === "cash" && p.received < p.amount + p.tip)
      ctx.addIssue({ code: "custom", message: "insufficient_cash" });
  });
export type OfflinePayment = z.infer<typeof offlinePayment>;

export const v3Base = {
  formatVersion: z.literal(3),
  operationId: id,
  tenantId: id,
  employeeId: id,
  deviceId: id,
  sessionId: id,
  lease: leaseRef,
  currency: z.string().regex(/^[A-Z]{3}$/),
  currencyExponent: z.number().int().min(0).max(3),
  recordedAt: z.string().datetime(),
  recordedAtDevice: z.string().datetime(),
  clockOffsetMs: z
    .number()
    .int()
    .min(-2_592_000_000)
    .max(2_592_000_000)
    .nullable(),
  sequence: z.number().int().positive(),
  provisionalNumber: provisionalNumber.nullable(),
  kitchenDelivery: z.enum(["print_requested", "device_list", "not_applicable"]),
};

/** New order paid in full offline (cash or external terminal). */
export const offlineSaleV3 = z
  .object({
    ...v3Base,
    kind: z.literal("sale"),
    cashSessionId: id,
    order: orderInput,
    expectedTotal: money.refine((n) => n > 0),
    payment: offlinePayment,
    receiptSnapshot: offlineReceiptSnapshot,
  })
  .strict()
  .refine(
    (p) => p.payment.amount === p.expectedTotal && p.provisionalNumber !== null,
    { message: "sale_amount_or_number" },
  );
export type OfflineSaleV3 = z.infer<typeof offlineSaleV3>;

export const offlineRecordV3 = z.discriminatedUnion("kind", [offlineSaleV3]);
export type OfflineRecordV3 = z.infer<typeof offlineRecordV3>;

/** Every record format a device may hold. v1/v2 are legacy cash sales. */
export const offlineRecord = z.union([
  offlineRecordV3,
  offlineSaleV2,
  offlineSaleV1,
]);
export type OfflineRecord = z.infer<typeof offlineRecord>;
export type OfflineRecordKind = "sale" | "order" | "round" | "payment";
export const recordKind = (p: OfflineRecord): OfflineRecordKind =>
  "kind" in p ? p.kind : "sale";
export const formatVersionOf = (p: OfflineRecord): 1 | 2 | 3 =>
  "formatVersion" in p ? p.formatVersion : 1;

/** Money a record collected (0 when it collected none). */
export function recordAmounts(p: OfflineRecord): { amount: number; tip: number } {
  if (!("kind" in p)) return { amount: p.expectedTotal, tip: p.tip };
  return "payment" in p
    ? { amount: p.payment.amount, tip: p.payment.tip }
    : { amount: 0, tip: 0 };
}

/** One offline window of a lease: sequence 0 is the base lease, then renewals. */
export type EvidenceWindow = { issuedAt: Date; validUntil: Date };

/**
 * Validates a claimed sale instant against server time, the lease windows and
 * the drawer. `future` when it is more than 2 min ahead of the server; `ok`
 * when some window (and the drawer) covers it within -5 min/+2 min; otherwise
 * `too_early`/`too_late`. `soldAt` is the claim clamped into the covering (or
 * nearest) window, the drawer's life and server now.
 */
export function evaluateRecordedAt(input: {
  recordedAt: string;
  serverNow: Date;
  windows: EvidenceWindow[];
  drawer?: { openedAt: Date; closedAt: Date | null } | null;
}): { verdict: "ok" | "future" | "too_early" | "too_late"; soldAt: Date } {
  const claim = Date.parse(input.recordedAt);
  const now = input.serverNow.getTime();
  const windows = [...input.windows].sort(
    (a, b) => a.issuedAt.getTime() - b.issuedAt.getTime(),
  );
  const covering = windows.find(
    (w) =>
      claim >= w.issuedAt.getTime() - OFFLINE_PAST_TOLERANCE_MS &&
      claim <= w.validUntil.getTime() + OFFLINE_FUTURE_TOLERANCE_MS,
  );
  const window =
    covering ??
    (windows.length && claim < windows[0]!.issuedAt.getTime()
      ? windows[0]
      : windows.at(-1));
  const opened = input.drawer?.openedAt.getTime();
  const closed = input.drawer?.closedAt?.getTime();
  const lower = Math.max(
    window ? window.issuedAt.getTime() : -Infinity,
    opened ?? -Infinity,
  );
  const upper = Math.min(
    now,
    window ? window.validUntil.getTime() : Infinity,
    closed ?? Infinity,
  );
  const soldAt = new Date(
    lower > upper ? lower : Math.min(Math.max(claim, lower), upper),
  );
  if (claim > now + OFFLINE_FUTURE_TOLERANCE_MS)
    return { verdict: "future", soldAt };
  if (!covering)
    return {
      verdict:
        windows.length && claim < windows[0]!.issuedAt.getTime()
          ? "too_early"
          : "too_late",
      soldAt,
    };
  if (opened !== undefined && claim < opened - OFFLINE_PAST_TOLERANCE_MS)
    return { verdict: "too_early", soldAt };
  if (closed !== undefined && claim > closed + OFFLINE_FUTURE_TOLERANCE_MS)
    return { verdict: "too_late", soldAt };
  return { verdict: "ok", soldAt };
}

export const recoveryBackupV3 = z
  .object({
    format: z.literal("green-monkey-recovery-v3"),
    tenantId: id,
    exportedAt: z.string().datetime(),
    records: z
      .array(
        z
          .object({
            id,
            scope: z.string().min(1).max(300),
            body: offlineRecord,
            receipt: offlineReceiptSnapshot.optional(),
          })
          .strict(),
      )
      .max(10000),
    paymentAttempts: z
      .array(
        z
          .object({
            key: z.string().min(1).max(400),
            attempt: paymentAttemptV1,
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();

export const recoveryBackup = z.union([
  recoveryBackupV3,
  recoveryBackupV2,
  recoveryBackupV1,
]);
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
