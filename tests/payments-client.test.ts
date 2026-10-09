// Payments (037) client unit tests, phase P1: tender labels on receipts and lists, the offline
// drawer totals, Excepciones text, the tender CSV and the corte of a drawer with terminals and
// platforms. Pure: no database, no browser.
import { describe, expect, it } from "vitest";
import {
  offlineMethodKey,
  tenderLabel,
  tenderMethodLabel,
} from "../src/labels";
import { archivedDrawerAmounts } from "../src/features/offline/format";
import { exceptionDetail } from "../src/features/reports/exception-text";
import {
  dayColumns,
  drawerColumns,
  tenderColumns,
  toCsv,
} from "../src/features/reports/csv";
import { money } from "../src/features/reports/format";
import { referenceFromName } from "../shared/payments";
import { refundParts } from "../src/features/RefundDialog";
import {
  buildCorteDocument,
  drawerRow,
  otherDayDrawerCollections,
  type DayRow,
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
    // PAYMENTS-MONEY-4: a recovered platform or card payment keeps its method; only recovered
    // cash reads «Efectivo recuperado».
    expect(
      tenderLabel(
        { method: "platform", platform: "rappi", source: "offline_recovery" },
        "es",
      ),
    ).toBe("Pagado en Rappi (recuperado)");
    expect(
      tenderLabel(
        {
          method: "external",
          terminal_label: "BBVA",
          source: "offline_recovery",
        },
        "en",
      ),
    ).toBe("Card · BBVA (recovered)");
    expect(
      tenderLabel({ method: "cash", source: "offline_recovery" }, "es"),
    ).toBe("Efectivo recuperado");
    expect(tenderMethodLabel("platform", "offline_recovery", "es")).toBe(
      "Plataforma (recuperado)",
    );
    expect(tenderMethodLabel("external", "offline_recovery", "es")).not.toMatch(
      /Efectivo/,
    );
    expect(offlineMethodKey("platform")).toBe("payMethodPlatform");
    expect(offlineMethodKey("cash")).toBe("offlineMethodCash");
    expect(offlineMethodKey("card")).toBe("serviceTenderOther");
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
  it("LD-75: a platform tender to review names the platform («Otra» by its name), why, the order's price list and its number", () => {
    const pt = (reasonCode: string, detail: object) =>
      ({
        ...row("platform_tender", 38_000, detail),
        reasonCode,
      }) as ExceptionRow;
    expect(
      exceptionDetail(
        pt("payments_platform_other", {
          platform: "other",
          label: "App",
          priceList: null,
          reference: null,
        }),
        "es",
        m,
      ),
    ).toBe("App · Plataforma «Otra» · Precios de mostrador");
    expect(
      exceptionDetail(
        pt("payments_platform_no_price_list", {
          platform: "rappi",
          label: null,
          priceList: null,
          reference: "88123",
        }),
        "en",
        m,
      ),
    ).toBe(
      "Rappi · Order without the platform's price list · Counter prices · #88123",
    );
    expect(
      exceptionDetail(
        pt("payments_platform_rule_skipped", {
          platform: "didi_food",
          label: null,
          priceList: "didi_food",
          reference: "4F2A",
        }),
        "es",
        m,
      ),
    ).toBe(
      "DiDi Food · Registrado sin conexión fuera de las reglas · Precios: DiDi Food · #4F2A",
    );
  });
  it("PAYMENTS-UX-15: the order name prefills the platform order number", () => {
    expect(referenceFromName("DiDi 4F2A")).toBe("4F2A");
    expect(referenceFromName("Uber Eats #4F2A1")).toBe("#4F2A1");
    expect(referenceFromName("rappi 88123")).toBe("88123");
    expect(referenceFromName("Mesa 4")).toBe("");
    expect(referenceFromName("DiDi")).toBe("");
    expect(referenceFromName("")).toBe("");
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
  it("PAYMENTS-MONEY-5: the day CSV has a Plataformas column, so cash + terminal + platforms add up; the drawers CSV carries platform sales and refunds", () => {
    const day = {
      date: "2026-10-09",
      orders: 3,
      grossSales: 300_000,
      discounts: 0,
      salesTotal: 300_000,
      refunds: 0,
      cash: 150_000,
      external: 50_000,
      platform: 100_000,
      tips: 0,
      paidOuts: 0,
    } as unknown as DayRow;
    const opts = {
      locale: "es" as const,
      currency: "MXN",
      timezone: "America/Mexico_City",
    };
    const [header, line] = toCsv(dayColumns, [day], opts)
      .replace(/^\uFEFF/, "")
      .split(/\r\n/);
    const cells = (row: string) => row.split(",");
    const column = cells(header).indexOf("Plataformas");
    expect(column).toBeGreaterThan(cells(header).indexOf("Terminal"));
    expect(cells(line)[column]).toBe("1000.00");
    const drawerHeader = toCsv(drawerColumns("es"), [], opts)
      .replace(/^\uFEFF/, "")
      .split(/\r\n/)[0];
    expect(drawerHeader).toContain("Plataformas");
    expect(drawerHeader).toContain("Reembolsos de plataformas");
  });
});

describe("refund dialog breakdown (PAYMENTS-UX-8)", () => {
  it("a platform portion is its own part, never cash", () => {
    expect(
      refundParts([
        { method: "cash", amount: 1000 },
        { method: "external", amount: 500 },
        { method: "platform", amount: 12_900 },
        { method: "card", amount: 7 },
      ]),
    ).toEqual({ cash: 1000, external: 500, platform: 12_900 });
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
