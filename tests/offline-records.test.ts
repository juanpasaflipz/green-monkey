import { describe, expect, it } from "vitest";
import {
  evaluateRecordedAt,
  evidenceKey,
  offlineRecord,
  offlineRecordV3,
  offlineSale,
  provisionalNumber,
  recordKind,
  recoveryBackup,
  recoveryBackupV3,
} from "../shared/offline-recovery.js";

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const order = {
  operationId: id(2),
  lines: [
    { id: id(3), productId: id(4), quantity: 2, options: [], note: "" },
  ],
  mode: "takeaway" as const,
  tableId: null,
  name: "Mesa",
  note: "",
  channel: "pos" as const,
};
const v1 = {
  operationId: id(1),
  order,
  expectedTotal: 200,
  received: 200,
  tip: 0,
  recordedAt: "2026-09-19T12:00:00.000Z",
  sessionId: id(5),
  cashSessionId: id(6),
};
const v2 = {
  ...v1,
  formatVersion: 2 as const,
  tenantId: id(7),
  employeeId: id(8),
  deviceId: id(9),
  leaseVersion: 1,
  currency: "MXN",
  currencyExponent: 2,
  configurationVersion: 3,
};
const snapshot = {
  lines: [],
  restaurant: {
    name: "R",
    currency: "MXN",
    timezone: "America/Mexico_City",
    cutoff: 240,
  },
};
const base = {
  formatVersion: 3 as const,
  operationId: id(11),
  tenantId: id(7),
  employeeId: id(8),
  deviceId: id(9),
  sessionId: id(5),
  lease: { contractVersion: 1, configurationVersion: 3 },
  currency: "MXN",
  currencyExponent: 2,
  recordedAt: "2026-09-19T12:00:00.000Z",
  recordedAtDevice: "2026-09-19T11:58:00.000Z",
  clockOffsetMs: 120_000,
  sequence: 1,
  provisionalNumber: "B-07",
  kitchenDelivery: "device_list" as const,
};
const cash = {
  method: "cash" as const,
  amount: 200,
  tip: 0,
  received: 500,
  reference: "",
  externalConfirmed: false,
};
const sale = {
  ...base,
  kind: "sale" as const,
  cashSessionId: id(6),
  order,
  expectedTotal: 200,
  payment: cash,
  receiptSnapshot: snapshot,
};

describe("offline record v3 contracts", () => {
  it("v1 and v2 records still parse to identical fingerprints", () => {
    // Stability regression: stored operation hashes depend on these shapes.
    expect(offlineRecord.parse(v1)).toEqual(offlineSale.parse(v1));
    expect(JSON.stringify(offlineRecord.parse(v1))).toBe(
      JSON.stringify(offlineSale.parse(v1)),
    );
    expect(JSON.stringify(offlineRecord.parse(v2))).toBe(
      JSON.stringify(offlineSale.parse(v2)),
    );
    expect(recordKind(offlineRecord.parse(v1))).toBe("sale");
  });

  it("v3 sale requires payment.amount === expectedTotal and a provisional number", () => {
    expect(offlineRecordV3.parse(sale).kind).toBe("sale");
    expect(
      offlineRecordV3.safeParse({ ...sale, payment: { ...cash, amount: 199 } })
        .success,
    ).toBe(false);
    expect(
      offlineRecordV3.safeParse({ ...sale, provisionalNumber: null }).success,
    ).toBe(false);
    expect(offlineRecordV3.safeParse({ ...sale, extra: 1 }).success).toBe(false);
  });

  it("external payment requires reference, confirmation and received === amount + tip", () => {
    const external = {
      method: "external" as const,
      amount: 200,
      tip: 20,
      received: 220,
      reference: "AUTH-1",
      externalConfirmed: true,
    };
    expect(offlineRecordV3.safeParse({ ...sale, payment: external }).success).toBe(
      true,
    );
    for (const broken of [
      { ...external, reference: "" },
      { ...external, reference: "   " },
      { ...external, externalConfirmed: false },
      { ...external, received: 300 },
    ])
      expect(
        offlineRecordV3.safeParse({ ...sale, payment: broken }).success,
        JSON.stringify(broken),
      ).toBe(false);
  });

  it("cash payment requires received ≥ amount + tip", () => {
    expect(
      offlineRecordV3.safeParse({
        ...sale,
        payment: { ...cash, tip: 10, received: 209 },
      }).success,
    ).toBe(false);
    expect(
      offlineRecordV3.safeParse({
        ...sale,
        payment: { ...cash, tip: 10, received: 210 },
      }).success,
    ).toBe(true);
  });

  it("provisional regex rejects lowercase and long prefixes", () => {
    for (const ok of ["B-07", "A1-123", "ZAB-9999", "Y9-01"])
      expect(provisionalNumber.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["b-07", "ABCD-01", "B-7", "B-12345", "B07", "1A-01"])
      expect(provisionalNumber.safeParse(bad).success, bad).toBe(false);
  });

  it("backup v3 round-trips and backup v1/v2 still parse", () => {
    const backup = {
      format: "green-monkey-recovery-v3",
      tenantId: id(7),
      exportedAt: "2026-09-19T12:01:00.000Z",
      records: [
        { id: v1.operationId, scope: "a:b:c", body: v1 },
        { id: sale.operationId, scope: "a:b:c", body: sale, receipt: snapshot },
      ],
      paymentAttempts: [],
    };
    const parsed = recoveryBackupV3.parse(JSON.parse(JSON.stringify(backup)));
    expect(parsed.format).toBe("green-monkey-recovery-v3");
    expect(evidenceKey(parsed)).toBe(evidenceKey(recoveryBackupV3.parse(backup)));
    expect(
      recoveryBackup.parse({
        format: "green-monkey-offline-v1",
        tenantId: id(7),
        sales: [{ id: id(1), scope: "a:b:c", body: v1 }],
      }).format,
    ).toBe("green-monkey-offline-v1");
    expect(
      recoveryBackup.parse({
        format: "green-monkey-recovery-v2",
        tenantId: id(7),
        exportedAt: "2026-09-19T12:01:00.000Z",
        sales: [{ id: id(2), scope: "a:b:c", body: v2 }],
        paymentAttempts: [],
      }).format,
    ).toBe("green-monkey-recovery-v2");
  });

  it("evaluateRecordedAt: 90 s future ok; 5 min future → future; 4 min before drawer open ok and clamped; 6 min before → too_early; after lease valid_until + 2 min → too_late", () => {
    // Regression OFF-8: a device clock slightly ahead used to fail permanently.
    const now = new Date("2026-09-19T12:00:00.000Z");
    const lease = {
      issuedAt: new Date("2026-09-19T10:00:00.000Z"),
      validUntil: new Date("2026-09-19T14:00:00.000Z"),
    };
    const opened = new Date("2026-09-19T10:30:00.000Z");
    const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
    const check = (
      recordedAt: string,
      drawer: { openedAt: Date; closedAt: Date | null } = {
        openedAt: opened,
        closedAt: null,
      },
      serverNow = now,
      windows = [lease],
    ) => evaluateRecordedAt({ recordedAt, serverNow, windows, drawer });
    const ahead = check(at(90_000));
    expect(ahead.verdict).toBe("ok");
    expect(ahead.soldAt.toISOString()).toBe(now.toISOString());
    expect(check(at(300_000)).verdict).toBe("future");
    const early = check(new Date(opened.getTime() - 240_000).toISOString());
    expect(early.verdict).toBe("ok");
    expect(early.soldAt.toISOString()).toBe(opened.toISOString());
    expect(
      check(new Date(opened.getTime() - 360_000).toISOString()).verdict,
    ).toBe("too_early");
    // A late sync of a sale made after the lease ended (server now is later).
    const later = new Date("2026-09-19T18:00:00.000Z");
    expect(
      check(
        new Date(lease.validUntil.getTime() + 180_000).toISOString(),
        undefined,
        later,
      ).verdict,
    ).toBe("too_late");
    // Within 2 min after the window end is tolerated and clamped to the end.
    const tolerated = check(
      new Date(lease.validUntil.getTime() + 60_000).toISOString(),
      undefined,
      later,
    );
    expect(tolerated.verdict).toBe("ok");
    expect(tolerated.soldAt.toISOString()).toBe(lease.validUntil.toISOString());
    // Drawer closed at 11:00: 10:59 is fine, 11:03 is past the 2 min tolerance.
    const closed = { openedAt: opened, closedAt: new Date("2026-09-19T11:00:00.000Z") };
    expect(check(at(-3_660_000), closed).verdict).toBe("ok");
    expect(check(at(-3_420_000), closed).verdict).toBe("too_late");
    // A renewed window (access renewals) covers a sale after the base lease.
    const renewal = {
      issuedAt: new Date("2026-09-19T13:30:00.000Z"),
      validUntil: new Date("2026-09-19T17:30:00.000Z"),
    };
    const renewed = check(
      new Date("2026-09-19T16:00:00.000Z").toISOString(),
      undefined,
      later,
      [lease, renewal],
    );
    expect(renewed.verdict).toBe("ok");
    expect(renewed.soldAt.toISOString()).toBe("2026-09-19T16:00:00.000Z");
    expect(
      check(new Date("2026-09-19T09:50:00.000Z").toISOString(), null).verdict,
    ).toBe("too_early");
  });
});
