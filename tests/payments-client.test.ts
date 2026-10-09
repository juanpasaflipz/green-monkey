// Payments (037) client unit tests, phase P1: tender labels on receipts and lists, the offline
// drawer totals, Excepciones text, the tender CSV and the corte of a drawer with terminals and
// platforms. Pure: no database, no browser.
import { describe, expect, it } from "vitest";
import { tenderLabel, tenderMethodLabel } from "../src/labels";
import { archivedDrawerAmounts } from "../src/features/offline/format";
import { exceptionDetail } from "../src/features/reports/exception-text";
import {
  attemptStatus,
  canRetrySettle,
  resolveOptions,
} from "../src/features/payments/attempt-text";
import type { AttemptView } from "../shared/payments";
import { tenderColumns, toCsv } from "../src/features/reports/csv";
import { exceptionKindLabel, money } from "../src/features/reports/format";
import {
  buildCorteDocument,
  drawerRow,
  otherDayDrawerCollections,
  type DrawerFacts,
  type ExceptionRow,
  type TenderReportRow,
} from "../shared/reports";

describe("tender labels (receipts, Órdenes, Caja)", () => {
  it("names the platform, the terminal and the card; recovered and unknown methods keep their labels", () => {
    expect(
      tenderLabel({ method: "platform", platform: "uber_eats" }, "es"),
    ).toBe("Pagado en Uber Eats");
    expect(
      tenderLabel(
        { method: "platform", platform: "other", platform_label: "Pedidos Ya" },
        "en",
      ),
    ).toBe("Paid on Pedidos Ya");
    expect(
      tenderLabel({ method: "external", terminal_label: "BBVA" }, "es"),
    ).toBe("Tarjeta · BBVA");
    expect(
      tenderLabel(
        {
          method: "external",
          terminal_label: "Clip Mostrador",
          card_brand: "visa",
          card_last4: "4242",
        },
        "es",
      ),
    ).toBe("Tarjeta · Clip Mostrador · VISA •••• 4242");
    expect(tenderLabel({ method: "external" }, "es")).toBe(
      tenderMethodLabel("external", undefined, "es"),
    );
    expect(tenderLabel({ method: "cash" }, "es")).toBe("Efectivo");
    expect(
      tenderLabel(
        { method: "platform", platform: "rappi", source: "offline_recovery" },
        "es",
      ),
    ).toBe(tenderMethodLabel("platform", "offline_recovery", "es"));
    // Never cash: an unknown method prints as "Otro".
    expect(tenderMethodLabel("platform", undefined, "es")).toBe("Plataforma");
    expect(tenderLabel({ method: "card" }, "es")).toBe(
      tenderMethodLabel("card", undefined, "es"),
    );
    expect(tenderLabel({ method: "card" }, "es")).not.toBe("Efectivo");
  });
});

describe("offline drawer totals (OFFLINE-RECOVERY-08)", () => {
  it("an archived platform sale is neither cash nor terminal money", () => {
    const drawer = "d1";
    const v3 = (method: string, amount: number, tip = 0) => ({
      kind: "sale",
      cashSessionId: drawer,
      expectedTotal: amount,
      payment: { method, amount, tip },
    });
    const rows = [
      { scope: "t:d:e1", status: "archived", body: v3("platform", 50_000) },
      { scope: "t:d:e1", status: "archived", body: v3("cash", 15_000, 500) },
      { scope: "t:d:e1", status: "archived", body: v3("external", 20_000) },
    ];
    expect(archivedDrawerAmounts(rows, "t:d:", drawer)).toEqual({
      cash: 15_500,
      terminal: 20_000,
    });
  });
});

describe("Excepciones and the tender CSV", () => {
  const m = money("MXN", "es");
  const row = (kind: string, amount: number, detail: object): ExceptionRow =>
    ({
      kind,
      id: "x",
      amount,
      detail,
      note: "",
      reasonCode: null,
      actorName: "Ana",
      approverName: null,
      accountName: null,
    }) as unknown as ExceptionRow;
  it("a per-terminal batch difference names its terminal; a refund shows its platform part", () => {
    expect(
      exceptionDetail(
        row("terminal_difference", -100, {
          terminalId: "t1",
          terminal: "BBVA",
        }),
        "es",
        m,
      ),
    ).toBe("BBVA · Faltante");
    expect(
      exceptionDetail(
        row("terminal_difference", 100, { terminalId: null, terminal: null }),
        "en",
        m,
      ),
    ).toMatch(/^Other terminal · /);
    expect(
      exceptionDetail(row("terminal_difference", -1_200, {}), "es", m),
    ).toBe("Faltante");
    expect(
      exceptionDetail(
        row("refund", 1500, {
          mode: "amount",
          cash: 0,
          external: 0,
          platform: 1500,
        }),
        "es",
        m,
      ),
    ).toContain("Reembolso por plataforma (sin efectivo) " + m(1500));
  });
  it("terminal charges in Excepciones (P2): the terminal, and a manager's resolution in words; the kinds are labelled in both languages", () => {
    expect(
      exceptionDetail(
        row("terminal_attempt_review", 4500, { terminal: "MP Caja" }),
        "es",
        m,
      ),
    ).toBe("MP Caja");
    expect(
      exceptionDetail(
        row("terminal_attempt_dismissed", 4500, {
          terminal: "Clip Caja",
          resolution: "refunded_at_provider",
        }),
        "es",
        m,
      ),
    ).toBe("Clip Caja · reembolsado en el proveedor");
    expect(
      exceptionDetail(
        row("terminal_attempt_dismissed", 4500, {
          terminal: "MP Caja",
          resolution: "not_charged",
        }),
        "en",
        m,
      ),
    ).toBe("MP Caja · not charged");
    expect(
      exceptionDetail(
        row("terminal_attempt_unknown_open", 4500, { terminal: null }),
        "en",
        m,
      ),
    ).toBe("");
    expect(exceptionKindLabel("terminal_attempt_review", "es")).toBe(
      "Cobro en terminal por revisar",
    );
    expect(exceptionKindLabel("terminal_attempt_dismissed", "en")).toBe(
      "Terminal charge resolved by a manager",
    );
    expect(exceptionKindLabel("terminal_attempt_unknown_open", "es")).toBe(
      "Cobro en terminal sin confirmar",
    );
  });
  it("the tender CSV carries terminal, provider, card, platform and fee columns", () => {
    const tender: TenderReportRow = {
      id: "1",
      at: "2026-10-09T18:00:00.000Z",
      collectionDate: "2026-10-09",
      orderId: "o",
      orderNumber: 14,
      orderDate: "2026-10-09",
      method: "platform",
      amount: 23_600,
      tip: 0,
      reference: "4F2A",
      drawerId: null,
      deviceName: "Caja",
      refunded: 0,
      offline: false,
      source: "normal",
      terminalId: null,
      terminal: null,
      provider: null,
      providerReference: null,
      cardBrand: null,
      cardLast4: null,
      platform: "didi_food",
      platformLabel: null,
      fee: 5900,
      feeSource: "estimated",
    };
    const csv = toCsv(tenderColumns("es"), [tender], {
      locale: "es",
      currency: "MXN",
      timezone: "America/Mexico_City",
    });
    const [header, line] = csv.replace(/^\uFEFF/, "").split(/\r\n/);
    expect(header).toContain("Terminal");
    expect(header).toContain("Plataforma");
    expect(header).toContain("Comisiones");
    expect(line).toContain("DiDi Food");
    expect(line).toContain("59.00");
    expect(line).toContain("estimadas");
  });
});

describe("a drawer with named terminals and platforms (corte X/Z)", () => {
  const facts = (over: Partial<DrawerFacts> = {}): DrawerFacts => ({
    id: "d1",
    businessDate: "2026-10-09",
    zNumber: 12,
    deviceId: "dev",
    deviceName: "Caja",
    deviceActive: true,
    deviceRevoked: false,
    openedAt: "2026-10-09T14:00:00.000Z",
    openedByName: "Ana",
    closedAt: null,
    closedByName: null,
    opening: 100_000,
    cash: {
      count: 1,
      amount: 3000,
      tips: 0,
      refunds: 0,
      lateCount: 0,
      lateAmount: 0,
      lateTips: 0,
    },
    external: {
      count: 2,
      amount: 6000,
      tips: 300,
      refunds: 0,
      lateCount: 0,
      lateAmount: 0,
      lateTips: 0,
    },
    platform: {
      count: 1,
      amount: 3000,
      refunds: 0,
      lateCount: 0,
      lateAmount: 0,
    },
    terminals: [
      {
        terminalId: "t1",
        label: "BBVA",
        kind: "manual",
        count: 1,
        amount: 3000,
        tips: 300,
        refunds: 0,
        lateCount: 0,
        lateAmount: 0,
        lateTips: 0,
        feeProvider: 0,
        feeEstimated: 58,
        kioskCount: 0,
        kioskAmount: 0,
        expected: null,
        reported: null,
      },
      {
        terminalId: null,
        label: null,
        kind: null,
        count: 1,
        amount: 3000,
        tips: 0,
        refunds: 0,
        lateCount: 0,
        lateAmount: 0,
        lateTips: 0,
        feeProvider: 0,
        feeEstimated: 0,
        kioskCount: 0,
        kioskAmount: 0,
        expected: null,
        reported: null,
      },
    ],
    platforms: [
      {
        platform: "didi_food",
        label: null,
        count: 1,
        amount: 3000,
        refunds: 0,
        lateCount: 0,
        lateAmount: 0,
        commission: 750,
      },
    ],
    paidOuts: { count: 0, amount: 0 },
    payIns: 0,
    stored: {
      expected: null,
      counted: null,
      reason: null,
      countMode: null,
      externalExpected: null,
      externalReported: null,
    },
    review: null,
    zPrints: 0,
    ...over,
  });
  const ctx = (visibility: "full" | "blind") => ({
    visibility,
    restaurant: { name: "R", currency: "MXN", timezone: "America/Mexico_City" },
    printedAt: "2026-10-09T20:00:00.000Z",
    printedByName: "Ana",
    controls: {
      discounts: { count: 0, amount: 0 },
      refunds: { count: 0, amount: 0 },
      paidOuts: { count: 0, amount: 0 },
    },
    folios: [],
  });
  it("platform money never enters expected cash; the corte lists terminals and platforms, with fees only in the full variant", () => {
    const row = drawerRow(facts(), {
      canSeeExpected: true,
      currentBusinessDate: "2026-10-09",
    });
    expect(row.expected).toBe(100_000 + 3000);
    expect(row.platformSales).toBe(3000);
    expect(row.payments).toBe(4);
    const doc = buildCorteDocument(facts(), ctx("full"));
    expect(doc.terminals.map((x) => [x.label, x.net, x.fees])).toEqual([
      ["BBVA", 3300, 58],
      [null, 3000, 0],
    ]);
    expect(doc.platforms).toEqual([
      {
        platform: "didi_food",
        label: null,
        count: 1,
        sales: 3000,
        refunds: 0,
        net: 3000,
        commission: 750,
      },
    ]);
    expect(doc.payments).toBe(4);
    const closed = facts({
      closedAt: "2026-10-09T21:00:00.000Z",
      stored: {
        expected: 103_000,
        counted: 103_000,
        reason: null,
        countMode: "blind",
        externalExpected: 6300,
        externalReported: 6200,
      },
    });
    const blind = buildCorteDocument(closed, ctx("blind"));
    expect(blind.terminals.every((x) => !("fees" in x))).toBe(true);
    expect(blind.platforms.every((x) => !("commission" in x))).toBe(true);
    // The day corte counts platform sales as collected by that day's drawers.
    expect(otherDayDrawerCollections(12_000, [row], "2026-10-09")).toBe(0);
  });
});

describe("integrated charges (P2): what the waiting panel says and offers", () => {
  const attempt = (o: Partial<AttemptView> = {}): AttemptView => ({
    id: "a1",
    state: "pending",
    target: "order",
    origin: "pos",
    orderId: "o1",
    holdId: null,
    orderNumber: 12,
    holdLabel: null,
    terminalId: "t1",
    terminalLabel: "MP Caja",
    provider: "mercadopago",
    amount: 9000,
    tip: 0,
    paidAmount: null,
    providerReference: "ORD1",
    providerStatus: "created",
    cardType: null,
    cardBrand: null,
    cardLast4: null,
    errorCode: null,
    cancelRequested: false,
    resolution: null,
    createdAt: "2026-10-09T18:00:00.000Z",
    decidedAt: null,
    ...o,
  });
  const cashier = { manager: false, online: true };
  const manager = { manager: true, online: true };
  it("waiting: the terminal's name, Cancelar cobro and Cambiar de terminal; once a cancel is asked, only Volver a consultar", () => {
    const s = attemptStatus(attempt(), "es", cashier);
    expect(s.message).toBe("Esperando el pago en MP Caja…");
    expect(s.actions).toEqual(["cancel", "switch"]);
    expect(s.live).toBe(true);
    expect(
      attemptStatus(attempt({ cancelRequested: true }), "en", cashier),
    ).toMatchObject({
      message: expect.stringMatching(/^Cancelling/),
      actions: ["recheck"],
    });
    expect(
      attemptStatus(
        attempt({ errorCode: "payments_cancel_on_terminal" }),
        "es",
        cashier,
      ),
    ).toMatchObject({
      message: "La terminal ya tomó el cobro. Cancélalo en la terminal.",
      actions: ["recheck"],
    });
  });
  it("unknown never offers a blind retry: Volver a consultar for anyone, Resolver for managers", () => {
    const unknown = attempt({ state: "unknown" });
    expect(attemptStatus(unknown, "es", cashier).actions).toEqual(["recheck"]);
    expect(attemptStatus(unknown, "es", manager).actions).toEqual([
      "recheck",
      "resolve",
    ]);
    expect(attemptStatus(unknown, "es", manager).message).toMatch(
      /^No sabemos si el cobro se completó/,
    );
  });
  it("a decline names its reason; «Cobrar sin integración» only when the integration itself failed", () => {
    const refused = attemptStatus(
      attempt({ state: "declined", errorCode: "payments_provider_rejected" }),
      "es",
      cashier,
    );
    expect(refused.message).toMatch(/^La terminal rechazó el cobro \(/);
    expect(refused.actions).toEqual(["retry", "otherMethod"]);
    expect(
      attemptStatus(
        attempt({ state: "declined", errorCode: "payments_terminal_offline" }),
        "es",
        cashier,
      ).actions,
    ).toEqual(["retry", "otherMethod", "manualFallback"]);
  });
  it("review: any operator records an approved charge that now fits (R13); a flagged approval is the manager's only", () => {
    const fits = attempt({
      state: "review",
      paidAmount: 9000,
      errorCode: "payments_settle_order_changed",
    });
    expect(canRetrySettle(fits)).toBe(true);
    expect(attemptStatus(fits, "es", cashier).actions).toEqual(["retrySettle"]);
    const flagged = { ...fits, errorCode: "payments_provider_mismatch" };
    expect(canRetrySettle(flagged)).toBe(false);
    expect(attemptStatus(flagged, "es", cashier).actions).toEqual([]);
    expect(attemptStatus(flagged, "es", manager).actions).toEqual(["resolve"]);
    expect(resolveOptions(flagged)).toEqual(["refunded_at_provider", "record"]);
    expect(resolveOptions(attempt({ state: "unknown" }))).toEqual([
      "record",
      "not_charged",
    ]);
    expect(resolveOptions(attempt({ state: "settled" }))).toEqual([]);
  });
  it("offline, a live charge only waits (recording it another way could charge twice)", () => {
    expect(
      attemptStatus(attempt(), "es", { manager: true, online: false }),
    ).toMatchObject({
      message:
        "Sin conexión: el cobro sigue en la terminal; se confirmará al reconectar.",
      actions: [],
    });
  });
});
