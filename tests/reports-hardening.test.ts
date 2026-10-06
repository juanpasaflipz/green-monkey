// Reports (029) second-opinion hardening (LD-27): regression tests for the client and shared
// findings that need no database or browser. Each names the review finding it covers.
import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "../shared/csv";
import {
  type AuditRow,
  composeSalesSummary,
  drawerFingerprint,
  folioRanges,
  type DrawerFacts,
  type DrawerRow,
  type ExceptionRow,
} from "../shared/reports";
import { dataFor, reportKey } from "../src/features/reports/useReport";
import { summarySections } from "../src/features/reports/summary-rows";
import {
  auditReason,
  exceptionApprover,
  exceptionDetail,
  exceptionEmployee,
  reasonLabel,
} from "../src/features/reports/exception-text";
import { countFill, folioText, money } from "../src/features/reports/format";
import { exceptionColumns } from "../src/features/reports/csv";

const m = money("MXN", "es");

function summaryWith(
  p: {
    drawers?: Partial<DrawerRow>[];
    refunds?: { method: "cash" | "external"; amount: number }[];
  } = {},
) {
  return composeSalesSummary({
    range: { from: "2026-10-05", to: "2026-10-05" },
    currency: "MXN",
    generatedAt: "2026-10-05T20:00:00.000Z",
    currentBusinessDate: "2026-10-05",
    sales: [],
    lines: [],
    collections: [],
    refunds: (p.refunds ?? []).map((r) => ({
      date: "2026-10-05",
      method: r.method,
      count: 1,
      amount: r.amount,
      fiscalAmount: r.amount,
    })),
    restocks: [],
    paidOuts: [],
    drawers: (p.drawers ?? []).map(
      (d) =>
        ({
          businessDate: "2026-10-05",
          status: "closed",
          needsReview: true,
          openSinceEarlierDay: false,
          ...d,
        }) as DrawerRow,
    ),
    tax: null,
  });
}

describe("reports second opinion (LD-27): client and shared regressions", () => {
  it("UI-1: a report's data belongs to the deps it was fetched for; another range or filter gets none", () => {
    const stored = {
      key: reportKey(["2026-10-05", "2026-10-05"]),
      data: { total: 1 },
    };
    expect(dataFor(stored, reportKey(["2026-10-05", "2026-10-05"]))).toEqual({
      total: 1,
    });
    expect(dataFor(stored, reportKey(["2026-09-01", "2026-09-30"]))).toBe(null);
    expect(dataFor(null, reportKey([]))).toBe(null);
  });

  it("UI-3: Resumen's Cajas card shows shortages and overages apart and words the net difference; no amount sits inside a label", () => {
    const s = summaryWith({
      drawers: [{ difference: -50_000 }, { difference: 50_000 }],
    });
    const lines = summarySections(s, "es").find(
      (x) => x.id === "drawers",
    )!.lines;
    const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
    expect(byId.shortages).toMatchObject({
      label: "Faltantes",
      amount: -50_000,
    });
    expect(byId.overages).toMatchObject({ label: "Sobrantes", amount: 50_000 });
    expect(byId.drawerDifferences).toMatchObject({
      label: "Diferencia neta de caja",
      display: "Cuadra",
    });
    expect(byId.unreviewed).toMatchObject({
      label: "Diferencias sin revisar",
      display: "2",
    });
    for (const l of summarySections(s, "es").flatMap((x) => x.lines))
      expect(l.label, l.id).not.toMatch(/\$\d/);
    const short = summaryWith({ drawers: [{ difference: -1_500 }] });
    expect(
      summarySections(short, "es")
        .find((x) => x.id === "drawers")!
        .lines.find((l) => l.id === "drawerDifferences")!.display,
    ).toBe("Faltante " + m(-1_500));
  });

  it("UI-4: a drawer or terminal difference in Excepciones (screen, CSV, sheet) starts with Faltante or Sobrante", () => {
    const row = (kind: string, amount: number): ExceptionRow =>
      ({
        kind,
        id: "x",
        amount,
        detail: { countMode: "visible" },
        note: "",
        reasonCode: null,
        actorName: "Ana",
        approverName: null,
        accountName: null,
      }) as unknown as ExceptionRow;
    expect(exceptionDetail(row("drawer_difference", 50_000), "es", m)).toMatch(
      /^Sobrante · /,
    );
    expect(exceptionDetail(row("drawer_difference", -50_000), "es", m)).toMatch(
      /^Faltante · /,
    );
    expect(exceptionDetail(row("terminal_difference", -1_200), "es", m)).toBe(
      "Faltante",
    );
    expect(exceptionDetail(row("terminal_difference", 1_200), "en", m)).toBe(
      "Over",
    );
  });

  it("UI-9: the refund split is two indented rows, never one wide composite value", () => {
    const s = summaryWith({
      refunds: [
        { method: "cash", amount: 125_000 },
        { method: "external", amount: 0 },
      ],
    });
    const sales = summarySections(s, "es").find((x) => x.id === "sales")!.lines;
    expect(sales.find((l) => l.id === "refunds")).toMatchObject({
      amount: -125_000,
    });
    expect(sales.find((l) => l.id === "refunds")!.display).toBeUndefined();
    expect(
      sales
        .filter((l) => l.id.startsWith("refunds."))
        .map((l) => [l.id, l.amount, l.indent]),
    ).toEqual([
      ["refunds.cash", -125_000, true],
      ["refunds.external", 0, true],
    ]);
  });

  it("UI-12: Excepciones' CSV writes the same Empleado and Autorizó as the screen", () => {
    const rows = [
      {
        kind: "open_price",
        actorName: null,
        accountName: "Sara",
        approverName: null,
      },
      {
        kind: "discount",
        actorName: "Carlos",
        accountName: null,
        approverName: null,
      },
    ].map((r) => ({
      id: "x",
      at: "2026-10-05T18:00:00.000Z",
      businessDate: "2026-10-05",
      amount: 1000,
      orderNumber: null,
      deviceName: null,
      detail: {},
      note: "",
      reasonCode: null,
      ...r,
    })) as unknown as ExceptionRow[];
    expect(rows.map((r) => exceptionEmployee(r, "es"))).toEqual([
      "Cuenta de Sara",
      "Carlos",
    ]);
    expect(rows.map((r) => exceptionApprover(r, "es"))).toEqual([
      "",
      "dentro de su límite",
    ]);
    const csv = toCsv(
      exceptionColumns(
        "es",
        () => "",
        () => "",
      ),
      rows,
      { locale: "es", currency: "MXN", timezone: "America/Mexico_City" },
    );
    expect(csv).toContain("Cuenta de Sara");
    expect(csv).toContain("dentro de su límite");
  });

  it("UI-14: counts read in the singular for 1", () => {
    expect(
      countFill("es", "reportsAlertUnreviewed", "reportsAlertUnreviewedOne", 1),
    ).toBe("1 diferencia de caja sin revisar en los últimos 31 días.");
    expect(
      countFill("es", "reportsAlertUnreviewed", "reportsAlertUnreviewedOne", 3),
    ).toBe("3 diferencias de caja sin revisar en los últimos 31 días.");
    expect(
      countFill("es", "reportsTodayPayments", "reportsTodayPaymentsOne", 1),
    ).toBe("1 cobro");
    expect(
      folioText({ first: "A-000171", last: "A-000171", count: 1 }, "es"),
    ).toBe("Folio A-000171 (1 ticket)");
  });

  it("C18: reason codes read with discounts' labels by kind, never as raw codes", () => {
    expect(reasonLabel("discount", "quality", "es")).toBe(
      "Producto con defecto",
    );
    expect(reasonLabel("refund", "quality", "es")).toBe(
      "Producto con defecto o queja",
    );
    expect(reasonLabel("refund", "unknown_code", "es")).toBe("Otro");
  });

  it("CONTRACTS-3: the Bitácora labels a discount's or refund's reason code by kind and never shows another operation's raw code", () => {
    const row = (operation: string, reasonCode: string | null, reason = "") =>
      ({
        operation,
        summary: { amount: 4500, reason: reason || null, reasonCode },
      }) as unknown as AuditRow;
    expect(auditReason(row("discount.applied", "staff_meal"), "es")).toBe(
      "Consumo de personal",
    );
    expect(
      auditReason(row("refund.recorded", "customer_cancelled", "Frío"), "es"),
    ).toBe("El cliente canceló · Frío");
    expect(auditReason(row("job.cancelled", "some_code"), "es")).toBe("");
  });

  it("CONTRACTS-1: a corte lists each contiguous folio run in order and summarizes interleaved runs, never one range across a gap", () => {
    expect(
      folioRanges([
        { series: "A", first: 8, last: 8, count: 1 },
        { series: "A", first: 2, last: 6, count: 5 },
      ]),
    ).toEqual([
      { series: "A", first: "A-000002", last: "A-000006", count: 5 },
      { series: "A", first: "A-000008", last: "A-000008", count: 1 },
    ]);
    const interleaved = Array.from({ length: 6 }, (_, i) => ({
      series: "A",
      first: 101 + 2 * i,
      last: 101 + 2 * i,
      count: 1,
    }));
    const [summary] = folioRanges(interleaved, 4);
    expect(summary).toEqual({
      series: "A",
      first: "A-000101",
      last: "A-000111",
      count: 6,
      runs: 6,
    });
    expect(folioText(summary, "es")).toBe(
      "Folios A-000101 … A-000111: 6 tickets en 6 tramos (los folios intermedios son de otras cajas)",
    );
  });

  it("CORTES-1: the drawer fingerprint changes with every tender, refund or cash movement", () => {
    const base: DrawerFacts = {
      id: "d",
      businessDate: "2026-10-05",
      zNumber: null,
      deviceId: "v",
      deviceName: "Caja",
      deviceActive: true,
      deviceRevoked: false,
      openedAt: "2026-10-05T14:00:00.000Z",
      openedByName: "Ana",
      closedAt: null,
      closedByName: null,
      opening: 50_000,
      cash: {
        count: 3,
        amount: 30_000,
        tips: 1_000,
        refunds: 0,
        lateCount: 0,
        lateAmount: 0,
        lateTips: 0,
      },
      external: {
        count: 1,
        amount: 10_000,
        tips: 0,
        refunds: 0,
        lateCount: 0,
        lateAmount: 0,
        lateTips: 0,
      },
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
    };
    const seen = drawerFingerprint(base);
    const changes: DrawerFacts[] = [
      { ...base, cash: { ...base.cash, count: 4, amount: 34_500 } },
      { ...base, cash: { ...base.cash, refunds: 4_500 } },
      { ...base, external: { ...base.external, count: 2, amount: 14_500 } },
      { ...base, external: { ...base.external, refunds: 1_000 } },
      { ...base, paidOuts: { count: 1, amount: 1_500 } },
      { ...base, payIns: 2_000 },
    ];
    for (const c of changes) expect(drawerFingerprint(c)).not.toBe(seen);
    expect(drawerFingerprint({ ...base })).toBe(seen);
  });

  it("SECURITY-2: text with a ; or TAB before a formula start is quoted, so a ;-separator Excel never splits it into a formula cell", () => {
    expect(csvCell("Error;=WEBSERVICE(A1)", "t")).toBe(
      '"Error;=WEBSERVICE(A1)"',
    );
    expect(csvCell("a\t=1+1", "t")).toBe('"a\t=1+1"');
    expect(csvCell("Error; -1+1", "t")).toBe('"Error; -1+1"');
    expect(csvCell("Sin separador", "t")).toBe("Sin separador");
    // A separator before plain text is harmless and stays unquoted (fiscal's formas_pago).
    expect(csvCell("Efectivo 200.00; Terminal 70.00", "t")).toBe(
      "Efectivo 200.00; Terminal 70.00",
    );
  });
});
