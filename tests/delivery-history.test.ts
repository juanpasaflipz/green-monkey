// Histórico de plataformas (041): the gm-delivery-sales schema, pesos → centavos, the per-row
// rejections and the totals, against the fictional fixture (tests/fixtures/delivery-sales.json),
// and the operator builder's parse and merge (scripts/history/delivery-sales-build.ts) on
// fictional portal and pos-lite rows (no platform data).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  deliveryHistoryFile,
  deliveryMonthTotals,
  deliveryTotals,
  isCalendarDate,
  normalizeDeliveryHistory,
  platformTotals,
  storeTotals,
} from "../shared/delivery-history";
import {
  buildDeliveryFile,
  mergeDeliverySources,
  monthSummary,
  parsePortalFile,
  parsePosLiteDelivery,
  type BuildRow,
} from "../scripts/history/delivery-sales-build";

const raw = JSON.parse(readFileSync(new URL("./fixtures/delivery-sales.json", import.meta.url), "utf8"));
const file = deliveryHistoryFile.parse(raw);

describe("gm-delivery-sales file", () => {
  it("parses the fixture; refuses another format or version, a missing currency or a bad target", () => {
    expect(file.days).toHaveLength(14);
    expect(deliveryHistoryFile.safeParse({ ...raw, format: "pos-lite-sales" }).success).toBe(false);
    expect(deliveryHistoryFile.safeParse({ ...raw, version: 2 }).success).toBe(false);
    const { currency: _c, ...noCurrency } = raw;
    expect(deliveryHistoryFile.safeParse(noCurrency).success).toBe(false);
    expect(deliveryHistoryFile.safeParse({ ...raw, targetTenantId: "taqueria-demo" }).success).toBe(false);
    expect(deliveryHistoryFile.safeParse({ ...raw, sources: [{ platform: "ifood", origin: "portal", from: "2026-05-01", to: "2026-05-01" }] }).success).toBe(false);
  });

  it("drops any field it does not know (a stray order id or customer never reaches the server's rows)", () => {
    const f = deliveryHistoryFile.parse({
      ...raw,
      days: [{ ...raw.days[0], customer_name: "Nombre Ficticio", external_order_id: "X-1" }],
    });
    expect(Object.keys(f.days[0]!)).not.toContain("customer_name");
    expect(Object.keys(f.days[0]!)).not.toContain("external_order_id");
  });

  it("calendar dates are real dates", () => {
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-5-1")).toBe(false);
  });
});

describe("normalizeDeliveryHistory", () => {
  const n = normalizeDeliveryHistory(file);

  it("accepts valid rows and rejects the rest with a reason and its row number", () => {
    expect(n.accepted.map((d) => [d.date, d.platform, d.store])).toEqual([
      ["2026-05-01", "rappi", "Taquería Demo"],
      ["2026-05-01", "uber_eats", "Taquería Demo"],
      ["2026-05-02", "rappi", "Taquería Demo"],
      ["2026-05-02", "uber_eats", "Taquería Demo"],
      ["2026-05-03", "didi_food", "Rollos Demo"],
      // The store label is trimmed and its inner spaces collapsed.
      ["2026-05-03", "uber_eats", "Taquería Demo"],
    ]);
    expect(n.rejected.map((r) => [r.row, r.reason])).toEqual([
      [7, "platform"],
      [8, "date"],
      [9, "store"],
      [10, "money"],
      [11, "orders"],
      [12, "commission"],
      [13, "net"],
      [14, "duplicate"],
    ]);
  });

  it("converts pesos to centavos; unknown commission and net stay null; net may be negative", () => {
    const rappi = n.accepted.filter((d) => d.platform === "rappi");
    expect(rappi[0]).toMatchObject({ gross: 10000, commission: null, net: null });
    expect(rappi[1]).toMatchObject({ gross: 25000, commission: 5000, net: -2000, chargebacks: 22000 });
    const lastUber = n.accepted.find((d) => d.platform === "uber_eats" && d.date === "2026-05-03")!;
    expect(lastUber).toMatchObject({ orders: 3, unsettledOrders: 1, cancelled: 0 });
  });

  it("coverage per platform: first to last accepted date", () => {
    expect(n.coverage).toEqual({
      rappi: { from: "2026-05-01", to: "2026-05-02" },
      uber_eats: { from: "2026-05-01", to: "2026-05-03" },
      didi_food: { from: "2026-05-03", to: "2026-05-03" },
    });
  });

  it("reconciles the exact source sums with the converted centavos; the file's summary checks", () => {
    expect(n.reconciliation).toEqual({
      source: { gross: "1300.00", commission: "285.00", net: "695.00", chargebacks: "220.00" },
      converted: { gross: 130000, commission: 28500, net: 69500, chargebacks: 22000 },
      matches: true,
      rounded: 0,
      summaryOk: true,
    });
    const bad = normalizeDeliveryHistory({ ...file, summary: { ...file.summary, orders: 19 } });
    expect(bad.reconciliation.summaryOk).toBe(false);
  });

  it("rounds more than 2 decimals half away from zero, and counts them", () => {
    const r = normalizeDeliveryHistory({
      ...file,
      days: [{ ...file.days[0]!, gross: "100.005", commission: "0.004", net: "99.995" }],
      summary: { days: 1, orders: 4, gross: "100.005", commission: "0.004", net: "99.995" },
    });
    expect(r.accepted[0]).toMatchObject({ gross: 10001, commission: 0, net: 10000 });
    expect(r.reconciliation.rounded).toBe(3);
    expect(r.reconciliation.matches).toBe(false);
  });

  it("totals by platform, store and month; commission and net leave unknown rows out and say so", () => {
    const t = deliveryTotals(n.accepted);
    expect(t).toMatchObject({ days: 6, orders: 13, gross: 130000, commission: 28500, net: 69500, unsettledOrders: 1, commissionUnknown: 1, netUnknown: 1 });
    const p = platformTotals(n.accepted);
    expect(p.uber_eats).toMatchObject({ orders: 9, gross: 90000, commission: 22500, net: 67500, cancelled: 1 });
    expect(p.didi_food.orders).toBe(1);
    expect(storeTotals(n.accepted).map((s) => [s.platform, s.store, s.totals.orders])).toEqual([
      ["uber_eats", "Taquería Demo", 9],
      ["rappi", "Taquería Demo", 3],
      ["didi_food", "Rollos Demo", 1],
    ]);
    expect(deliveryMonthTotals(n.accepted).map((m) => [m.month, m.orders, m.gross])).toEqual([["2026-05", 13, 130000]]);
  });
});

describe("delivery-sales-build: portal files", () => {
  const header = "date|store|orders|gross|commission|net|unsettled|cancelled|chargebacks";
  it("parses PSV (and CSV) with comments, blank lines, empty commission and net", () => {
    const rows = parsePortalFile(
      [
        "# portal export, ficticio",
        header,
        "2026-06-01|Taquería Demo|3|300.00|75.00|225.00|0|1|",
        "",
        "2026-06-02|Taquería Demo|1|99.9|||1||0",
      ].join("\n"),
      "uber_eats",
    );
    expect(rows).toEqual([
      { date: "2026-06-01", platform: "uber_eats", store: "Taquería Demo", orders: 3, gross: "300.00", commission: "75.00", net: "225.00", unsettledOrders: 0, cancelled: 1, chargebacks: "0.00" },
      { date: "2026-06-02", platform: "uber_eats", store: "Taquería Demo", orders: 1, gross: "99.90", commission: null, net: null, unsettledOrders: 1, cancelled: 0, chargebacks: "0.00" },
    ]);
    const csv = parsePortalFile(header.replaceAll("|", ",") + "\n2026-06-01,Taquería Demo,2,20.00,5.00,15.00,0,0,0", "rappi");
    expect(csv[0]).toMatchObject({ platform: "rappi", orders: 2, gross: "20.00" });
  });

  it("refuses a wrong header, centavos with too many decimals, negative gross, zero orders, bad dates, quoted CSV", () => {
    expect(() => parsePortalFile("date|store|orders\n", "rappi")).toThrow(/header/);
    expect(() => parsePortalFile(`${header}\n2026-06-01|T|1|1.234|||0|0|0`, "rappi")).toThrow(/gross/);
    expect(() => parsePortalFile(`${header}\n2026-06-01|T|1|-1.00|||0|0|0`, "rappi")).toThrow(/negative/);
    expect(() => parsePortalFile(`${header}\n2026-06-01|T|0|1.00|||0|0|0`, "rappi")).toThrow(/orders > 0/);
    expect(() => parsePortalFile(`${header}\n2026-06-31|T|1|1.00|||0|0|0`, "rappi")).toThrow(/date/);
    expect(() => parsePortalFile(`${header.replaceAll("|", ",")}\n2026-06-01,"T, Demo",1,1.00,,,0,0,0`, "rappi")).toThrow(/PSV/);
    expect(() => parsePortalFile("", "rappi")).toThrow(/header/);
    // A negative net is a portal fact (chargebacks), not an error.
    expect(parsePortalFile(`${header}\n2026-06-01|T|1|10.00|2.00|-5.00|0|0|13.00`, "rappi")[0]!.net).toBe("-5.00");
  });
});

describe("delivery-sales-build: pos-lite export and merge", () => {
  const posDoc = {
    format: "pos-lite-delivery",
    sourceTenantId: "taqueria-demo",
    sourceName: "Taquería Demo",
    timezone: "America/Mexico_City",
    exportedAt: "2026-06-03T00:00:00.000Z",
    rows: [
      { date: "2026-05-30", source: "uber_eats", platform: "uber_eats", store: "Taquería Demo", orders: 2, gross: "200.00", commission: "50.00", net: "150.00" },
      { date: "2026-06-01", source: "uber_eats", platform: "uber_eats", store: "Taquería Demo", orders: 1, gross: "100.00", commission: "25.00", net: "75.00" },
      { date: "2026-05-31", source: "rappi", platform: "rappi", store: "Taquería Demo", orders: 1, gross: "80.00", commission: "20.00", net: "60.00" },
      { date: "2026-05-31", source: "didi_food_rollbertos", platform: "didi_food", store: "Rollos Demo", orders: 1, gross: "40.00", commission: "8.00", net: "32.00" },
    ],
  };
  const portalUber: BuildRow[] = parsePortalFile(
    [
      "date|store|orders|gross|commission|net|unsettled|cancelled|chargebacks",
      "2026-05-31|Taquería Demo|9|900.00|225.00|675.00|0|0|0",
      "2026-06-01|Taquería Demo|3|310.00|77.50|232.50|0|0|0",
      "2026-06-02|Taquería Demo|2|200.00|50.00||2|0|0",
      "2026-06-01|Otra Sucursal Demo|5|500.00|125.00|375.00|0|0|0",
    ].join("\n"),
    "uber_eats",
  );

  it("pos-lite rows before the cutover, portal rows from it on; other stores excluded and listed", () => {
    const pos = parsePosLiteDelivery(posDoc);
    const m = mergeDeliverySources({
      poslite: pos.rows,
      portals: { uber_eats: portalUber },
      cutovers: { uber_eats: "2026-06-01" },
      stores: ["Taquería Demo", "Rollos Demo"],
    });
    expect(m.days.map((d) => [d.date, d.platform, d.store, d.orders, d.gross])).toEqual([
      ["2026-05-30", "uber_eats", "Taquería Demo", 2, "200.00"],
      ["2026-05-31", "didi_food", "Rollos Demo", 1, "40.00"],
      ["2026-05-31", "rappi", "Taquería Demo", 1, "80.00"],
      ["2026-06-01", "uber_eats", "Taquería Demo", 3, "310.00"],
      ["2026-06-02", "uber_eats", "Taquería Demo", 2, "200.00"],
    ]);
    expect(m.sources).toEqual([
      { platform: "uber_eats", origin: "pos-lite", from: "2026-05-30", to: "2026-05-30" },
      { platform: "uber_eats", origin: "portal", from: "2026-06-01", to: "2026-06-02" },
      { platform: "rappi", origin: "pos-lite", from: "2026-05-31", to: "2026-05-31" },
      { platform: "didi_food", origin: "pos-lite", from: "2026-05-31", to: "2026-05-31" },
    ]);
    expect(m.excluded).toEqual([
      { platform: "uber_eats", origin: "pos-lite", store: "Taquería Demo", rows: 1, reason: "cutover" },
      { platform: "uber_eats", origin: "portal", store: "Taquería Demo", rows: 1, reason: "cutover" },
      { platform: "uber_eats", origin: "portal", store: "Otra Sucursal Demo", rows: 1, reason: "store" },
    ]);
  });

  it("a platform with both inputs needs a cutover; an unmapped pos-lite source, an empty allow-list or a repeated day fail", () => {
    const pos = parsePosLiteDelivery(posDoc);
    expect(() =>
      mergeDeliverySources({ poslite: pos.rows, portals: { uber_eats: portalUber }, cutovers: {}, stores: ["Taquería Demo"] }),
    ).toThrow(/--cutover uber_eats/);
    expect(() =>
      parsePosLiteDelivery({ ...posDoc, rows: [{ ...posDoc.rows[0], source: "glovo", platform: null, store: null }] }),
    ).toThrow(/glovo/);
    expect(() => parsePosLiteDelivery({ rows: [] })).toThrow(/poslite-delivery-export/);
    expect(() => mergeDeliverySources({ poslite: pos.rows, portals: {}, cutovers: {}, stores: [] })).toThrow(/--store/);
    expect(() =>
      mergeDeliverySources({ poslite: [...pos.rows, pos.rows[0]!], portals: {}, cutovers: {}, stores: ["Taquería Demo", "Rollos Demo"] }),
    ).toThrow(/repeated day/);
  });

  it("builds a gm-delivery-sales v1 file the server accepts whole (summary exact, nothing rejected)", () => {
    const m = mergeDeliverySources({
      poslite: parsePosLiteDelivery(posDoc).rows,
      portals: { uber_eats: portalUber },
      cutovers: { uber_eats: "2026-06-01" },
      stores: ["Taquería Demo", "Rollos Demo"],
      notes: { uber_eats: "ficticio" },
    });
    const doc = buildDeliveryFile({
      targetTenantId: "00000000-0000-4000-8000-0000000000aa",
      sourceName: "Taquería Demo",
      exportedAt: "2026-06-03T12:00:00Z",
      merged: m,
    });
    expect(doc.summary).toEqual({ days: 5, orders: 9, gross: "830.00", commission: "205.50", net: "474.50" });
    expect(doc.exportedAt).toBe("2026-06-03T12:00:00.000Z");
    const n = normalizeDeliveryHistory(deliveryHistoryFile.parse(JSON.parse(JSON.stringify(doc))));
    expect(n.rejected).toEqual([]);
    expect(n.reconciliation.matches).toBe(true);
    expect(n.reconciliation.summaryOk).toBe(true);
    expect(n.accepted.find((d) => d.date === "2026-06-02")).toMatchObject({ net: null, unsettledOrders: 2 });
    expect(monthSummary(doc.days)).toEqual([
      { platform: "didi_food", month: "2026-05", days: 1, orders: 1, gross: "40.00", commission: "8.00", net: "32.00", unsettled: 0 },
      { platform: "rappi", month: "2026-05", days: 1, orders: 1, gross: "80.00", commission: "20.00", net: "60.00", unsettled: 0 },
      { platform: "uber_eats", month: "2026-05", days: 1, orders: 2, gross: "200.00", commission: "50.00", net: "150.00", unsettled: 0 },
      { platform: "uber_eats", month: "2026-06", days: 2, orders: 5, gross: "510.00", commission: "127.50", net: "232.50", unsettled: 2 },
    ]);
    expect(() => buildDeliveryFile({ targetTenantId: "taqueria", sourceName: "x", exportedAt: "2026-06-03T12:00:00Z", merged: m })).toThrow(/uuid/);
    expect(() =>
      buildDeliveryFile({ targetTenantId: "00000000-0000-4000-8000-0000000000aa", sourceName: "x", exportedAt: "2026-06-03T12:00:00Z", merged: { days: [], sources: [], excluded: [] } }),
    ).toThrow(/nothing to write/);
  });
});
