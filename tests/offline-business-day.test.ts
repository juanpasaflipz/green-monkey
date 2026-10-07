// LD-48 (POLISH-MONEY-2, POLISH-UX-8, POLISH-OFFLINE-2): the offline screens where staff
// pick or verify an order by its number date one from another business day, as Órdenes
// and the KDS do (LD-29): the kitchen's offline review lane, the manager's offline payment
// review (the check the money would go to) and the offline "Órdenes abiertas" pick list.
// An offline sale synced after the cutoff continues the numbers of the day it was sold,
// and the open-orders snapshot includes the previous business day's open checks, so these
// are the screens most likely to show two "#10".
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../shared/domain";

vi.mock("../src/offline", async () => ({
  db: (await import("./offline-fake-db")).fakeDb,
}));

import type { Pending } from "../src/offline";
import type { LocalOrderView } from "../src/offline-records";
import { offlineReviewOrderLabel } from "../src/features/offline/format";
import { OfflineOrderRow } from "../src/features/offline/OfflineOrdersModal";
import {
  OfflineReviewPanel,
  type OfflineReviewDetail,
} from "../src/features/offline/OfflineReviewPanel";

const yesterday = "2026-10-05";
const today = "2026-10-06";
const D = " ";
/** Visible text of server-rendered markup (tags removed, spaces collapsed, U+00A0 kept). */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t\n\r]+/g, " ")
    .trim();

const restaurant = {
  name: "Fixture",
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
  configVersion: 3,
};

beforeEach(() => {
  // 12:00 in Mexico City on 6 oct: the current business day is 2026-10-06.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T18:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

describe("offline screens date an order from another business day (LD-48)", () => {
  it("the KDS offline review lane names yesterday's #46 with its date; today's stays #46 (POLISH-MONEY-2, POLISH-OFFLINE-2)", () => {
    const held = (businessDate: string, provisionalNumber: string | null) => ({
      orderNumber: 46,
      provisionalNumber,
      businessDate,
    });
    expect(offlineReviewOrderLabel(held(yesterday, null), today, "es")).toBe(
      `#46${D}·${D}5${D}oct`,
    );
    expect(offlineReviewOrderLabel(held(yesterday, null), today, "en")).toBe(
      `#46${D}·${D}Oct${D}5`,
    );
    expect(offlineReviewOrderLabel(held(today, null), today, "es")).toBe(
      "#46",
    );
    expect(offlineReviewOrderLabel(held(yesterday, "B-07"), today, "es")).toBe(
      `B-07 → #46${D}·${D}5${D}oct`,
    );
    expect(offlineReviewOrderLabel(held(today, "B-07"), today, "es")).toBe(
      "B-07 → #46",
    );
    // A feed without the date (an older server) keeps the plain number.
    expect(
      offlineReviewOrderLabel(
        { orderNumber: 46, provisionalNumber: null },
        today,
        "es",
      ),
    ).toBe("#46");
  });

  it("the offline Órdenes abiertas list names yesterday's #10 apart from today's #10 (POLISH-UX-8, POLISH-OFFLINE-2)", () => {
    const view = (
      businessDate: string,
      over: Partial<LocalOrderView> = {},
    ): LocalOrderView =>
      ({
        id: crypto.randomUUID(),
        number: 10,
        businessDate,
        tableName: null,
        name: "",
        total: 15000,
        paid: 0,
        offline: {
          provisionalNumber: null,
          soldAt: "2026-10-05T20:00:00.000Z",
          localOperationId: null,
          cachedAt: "2026-10-06T17:00:00.000Z",
          serverOrderId: null,
        },
        ...over,
      }) as LocalOrderView;
    const row = (order: LocalOrderView, locale: "es" | "en" = "es") =>
      text(
        renderToStaticMarkup(
          createElement(OfflineOrderRow, {
            order,
            today,
            locale,
            due: "$150.00",
            onPick: () => {},
          }),
        ),
      );
    expect(row(view(yesterday, { tableName: "Mesa 4" }))).toBe(
      `#10${D}·${D}5${D}oct · Mesa 4 $150.00`,
    );
    expect(row(view(yesterday), "en")).toBe(`#10${D}·${D}Oct${D}5 $150.00`);
    expect(row(view(today, { name: "Barra" }))).toBe("#10 · Barra $150.00");
    // A local order that synced, and a provisional number of another business day.
    const mapped = view(yesterday, {
      number: 142,
      offline: {
        provisionalNumber: "B-07",
        soldAt: "2026-10-05T20:00:00.000Z",
        localOperationId: null,
        cachedAt: null,
        serverOrderId: null,
      },
    });
    expect(row(mapped)).toBe(`B-07 → #142${D}·${D}5${D}oct $150.00`);
    expect(row({ ...mapped, number: 0 })).toBe(
      `B-07${D}·${D}5${D}oct $150.00`,
    );
  });

  it("the offline payment review names the check the money would go to with its date (POLISH-MONEY-2, POLISH-UX-8)", () => {
    const session = {
      id: "s",
      tenantId: "t",
      employeeId: "e",
      deviceId: "d",
      role: "manager",
      restaurant,
    } as unknown as Session;
    const detail = (businessDate: string): OfflineReviewDetail => ({
      authentic: true,
      problems: [],
      kind: "payment",
      collected: 5000,
      tip: 0,
      method: "cash",
      reference: null,
      recordedAt: "2026-10-06T09:50:00.000Z",
      recordedAtDevice: null,
      clockOffsetMs: null,
      soldAt: null,
      provisionalNumber: null,
      currentTotal: null,
      originalEmployee: null,
      originalDrawerId: null,
      drawerClosed: null,
      sessionRevoked: null,
      prior: null,
      archived: false,
      target: { orderId: "o", number: 46, businessDate, due: 5000 },
      reconcilable: true,
      reconcileAs: "order",
    });
    const panel = (businessDate: string, locale: "es" | "en" = "es") =>
      text(
        renderToStaticMarkup(
          createElement(OfflineReviewPanel, {
            row: {
              id: "r",
              scope: "t:d:e",
              body: { recordedAt: "2026-10-06T09:50:00.000Z" },
              status: "conflict",
              attempts: 1,
              nextAt: 0,
            } as unknown as Pending,
            detail: detail(businessDate),
            rows: [],
            locale,
            session,
            busy: false,
            waiting: false,
            kindLabel: "Cobro",
            format: (minor: number) => `$${(minor / 100).toFixed(2)}`,
            run: () => {},
            onArchive: () => {},
            onClose: () => {},
          }),
        ),
      );
    const old = panel(yesterday);
    // The order line of the evidence, and the reconcile copy that names it.
    expect(old).toContain(`#46${D}·${D}5${D}oct · $50.00`);
    expect(old).toContain(`la orden #46${D}·${D}5${D}oct, en la caja original`);
    expect(old).not.toMatch(/#46 · \$50\.00/);
    expect(panel(yesterday, "en")).toContain(`order #46${D}·${D}Oct${D}5`);
    const fresh = panel(today);
    expect(fresh).toContain("#46 · $50.00");
    expect(fresh).not.toContain(`#46${D}·`);
  });
});
