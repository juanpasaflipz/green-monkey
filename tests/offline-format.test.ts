/**
 * How orders are named on receipts and in the cart (§2.4, OFF-R22): the
 * provisional number and its "assigned when it syncs" hint only while the
 * device alone knows the order; afterwards "B-07 → #142".
 */
import { describe, expect, it } from "vitest";
import {
  archivedDrawerAmounts,
  orderLabel,
  provisionalOnly,
  rowErrorCode,
  rowErrorNotice,
} from "../src/features/offline/format";
import { errorText, translateError } from "../src/i18n";

const id = "00000000-0000-4000-8000-000000000142";

describe("order labels (OFF-R22)", () => {
  it("a local receipt shows its provisional number and the hint", () => {
    const local = { id, number: 0, offline: { provisionalNumber: "B-07" } };
    expect(orderLabel(local)).toBe("B-07");
    expect(provisionalOnly(local)).toBe(true);
  });

  it("a synced order shows both numbers and never the hint", () => {
    const synced = { id, number: 142, offline: { provisionalNumber: "B-07" } };
    expect(orderLabel(synced)).toBe("B-07 → #142");
    expect(provisionalOnly(synced)).toBe(false);
  });

  it("an online order shows its server number only", () => {
    expect(orderLabel({ id, number: 142, offline: null })).toBe("#142");
    expect(provisionalOnly({ number: 142, offline: null })).toBe(false);
    // A legacy record without a number falls back to its id prefix.
    expect(orderLabel({ id, number: 0 })).toBe("#00000000");
  });
});

describe("sync row explanations (OFFLINE-RECOVERY-03)", () => {
  it("never tells a manager to sign in for a conflict, and gives orders and rounds their own way out", () => {
    // offline_conflict (E3-E5) is an eligibility problem, not "connect and
    // sign in with an open drawer".
    for (const kind of ["sale", "order", "round", "payment"] as const)
      expect(rowErrorCode("offline_conflict", kind)).toBe(
        "offline_why_conflict",
      );
    // settings_changed is permanent for the lease: refreshing never fixes it.
    expect(rowErrorCode("settings_changed", "sale")).toBe(
      "offline_why_settings_changed",
    );
    expect(rowErrorCode("settings_changed", "round")).toBe(
      "offline_why_settings_items",
    );
    // An order or round carries no money: it is archived, never reconciled.
    expect(rowErrorCode("price_conflict", "order")).toBe(
      "offline_why_price_items",
    );
    expect(rowErrorCode("offline_catalog_changed", "round")).toBe(
      "offline_why_catalog_items",
    );
    expect(rowErrorCode("price_conflict", "sale")).toBe("price_conflict");
    expect(rowErrorCode("duplicate_line", "sale")).toBe(
      "offline_record_conflict",
    );
    expect(rowErrorCode("offline_payment_exceeds_due", "payment")).toBe(
      "offline_payment_exceeds_due",
    );
    for (const code of [
      "offline_why_conflict",
      "offline_why_settings_changed",
      "offline_why_settings_items",
      "offline_why_price_items",
      "offline_why_catalog_items",
      "offline_why_session_revoked",
      "offline_why_employee_inactive",
      "offline_why_device_inactive",
      "offline_why_selling_not_authorized",
      "offline_record_conflict",
    ]) {
      expect(errorText[code], code).toBeDefined();
      expect(errorText[code]![0]).not.toMatch(/Conecta|Actualiza antes/);
    }
  });

  it("LD-48: an unresolved row whose last attempt failed on the server, or with a 4xx the app has no text for, shows the support reference (POLISH-OFFLINE-4)", () => {
    const ref = "Referencia de soporte: 3F2A9C1B";
    // A record retrying a server failure forever.
    expect(
      rowErrorNotice(
        {
          status: "pending",
          error: "internal_error",
          errorStatus: 500,
          requestId: "3f2a9c1b-0001",
        },
        "sale",
        "es",
      ),
    ).toBe(`${translateError("internal_error", "es")} ${ref}`);
    // A conflict with a code the app cannot explain: rowErrorCode's text, then the reference.
    const unknown = {
      status: "conflict",
      error: "some_new_code",
      errorStatus: 409,
      requestId: "3f2a9c1b-0002",
    };
    expect(rowErrorNotice(unknown, "sale", "es")).toBe(
      `${translateError(rowErrorCode("some_new_code", "sale"), "es")} ${ref}`,
    );
    expect(rowErrorNotice(unknown, "sale", "en")).toMatch(
      / Support reference: 3F2A9C1B$/,
    );
    // A refusal the screen explains, a failure that never reached the server, a row stored
    // before the request id was kept, and a resolved row show no reference.
    for (const row of [
      {
        status: "conflict",
        error: "price_conflict",
        errorStatus: 409,
        requestId: "3f2a9c1b-0003",
      },
      { status: "pending", error: "network_unavailable", errorStatus: 0 },
      { status: "pending", error: "internal_error" },
      {
        status: "archived",
        error: "internal_error",
        errorStatus: 500,
        requestId: "3f2a9c1b-0004",
      },
      {
        status: "synced",
        error: "internal_error",
        errorStatus: 500,
        requestId: "3f2a9c1b-0005",
      },
    ])
      expect(rowErrorNotice(row, "sale", "es")).toBe(
        translateError(rowErrorCode(row.error, "sale"), "es"),
      );
  });
});

describe("archived records at drawer close (OFFLINE-RECOVERY-08)", () => {
  it("only archived cash may show up as an overage; terminal payments are apart", () => {
    const prefix = "t:d:";
    const drawer = "drawer-1";
    const v3 = (method: "cash" | "external", amount: number, tip = 0) => ({
      kind: "sale",
      cashSessionId: drawer,
      payment: { method, amount, tip },
    });
    const rows = [
      { scope: "t:d:e1", status: "archived", body: v3("external", 120_000) },
      { scope: "t:d:e1", status: "archived", body: v3("cash", 15_000, 500) },
      // A legacy v1 cash sale (no kind): expectedTotal and tip.
      {
        scope: "t:d:e2",
        status: "archived",
        body: { expectedTotal: 2_000, tip: 0, cashSessionId: drawer },
      },
      // Not archived, another drawer, another device: never counted.
      { scope: "t:d:e1", status: "conflict", body: v3("cash", 9_999) },
      {
        scope: "t:d:e1",
        status: "archived",
        body: { ...v3("cash", 9_999), cashSessionId: "drawer-2" },
      },
      { scope: "t:x:e1", status: "archived", body: v3("cash", 9_999) },
    ];
    expect(archivedDrawerAmounts(rows, prefix, drawer)).toEqual({
      cash: 17_500,
      terminal: 120_000,
    });
  });
});
