import { describe, expect, it } from "vitest";
import {
  normalizePaymentAttempt,
  offlineSale,
  recoveryBackup,
  evidenceKey,
} from "../shared/offline-recovery.js";

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const v1 = {
  operationId: id(1),
  order: {
    operationId: id(2),
    lines: [
      {
        id: id(3),
        productId: id(4),
        quantity: 1,
        options: [],
        note: "",
      },
    ],
    mode: "takeaway",
    tableId: null,
    name: "Legacy",
    note: "",
    channel: "pos",
  },
  expectedTotal: 100,
  received: 100,
  tip: 0,
  recordedAt: "2026-09-19T12:00:00.000Z",
  sessionId: id(5),
  cashSessionId: id(6),
};

describe("offline recovery contracts", () => {
  it("compares backup evidence independent of object key order without losing values", () => {
    expect(evidenceKey({ b: [{ x: 1, y: 2 }], a: 3 })).toBe(
      evidenceKey({ a: 3, b: [{ y: 2, x: 1 }] }),
    );
    expect(evidenceKey({ a: [1, 2] })).not.toBe(evidenceKey({ a: [2, 1] }));
    expect(evidenceKey({ a: 100 })).not.toBe(evidenceKey({ a: 101 }));
  });
  it("preserves the exact v1 shape used by existing operation fingerprints", () => {
    expect(offlineSale.parse(v1)).toEqual(v1);
  });

  it("accepts v1 backups and evidence-rich v2 backups", () => {
    expect(
      recoveryBackup.parse({
        format: "green-monkey-offline-v1",
        tenantId: id(7),
        sales: [{ id: id(1), scope: `${id(7)}:${id(8)}:${id(9)}`, body: v1 }],
      }).format,
    ).toBe("green-monkey-offline-v1");
    expect(
      recoveryBackup.parse({
        format: "green-monkey-recovery-v2",
        tenantId: id(7),
        exportedAt: "2026-09-19T12:01:00.000Z",
        sales: [],
        paymentAttempts: [],
      }).format,
    ).toBe("green-monkey-recovery-v2");
  });

  it("normalizes legacy uncertain-payment cache entries without inventing proof", () => {
    const attempt = normalizePaymentAttempt(
      {
        orderId: id(10),
        payload: {
          operationId: id(11),
          amount: 100,
          tip: 0,
          received: 100,
          method: "cash",
          externalConfirmed: false,
          reference: "",
        },
      },
      `${id(7)}:${id(8)}:${id(9)}:payment`,
    );
    expect(attempt).toMatchObject({
      tenantId: id(7),
      deviceId: id(8),
      employeeId: id(9),
      sessionId: null,
      cashSessionId: null,
      createdAt: null,
    });
  });
});
