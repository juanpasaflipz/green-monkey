// Histórico POS Lite (040): the export schema, pesos → centavos, the per-order rejections and the
// day / method / product aggregation, against the fictional fixture
// (tests/fixtures/poslite-sales-export.json; no real pos-lite data).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Decimal } from "decimal.js";
import {
  aggregateSalesHistory,
  channelTotals,
  decimalOf,
  historyMethod,
  methodTotals,
  monthTotals,
  normalizeSalesHistory,
  salesHistoryExport,
  toCentavos,
  type SalesHistoryExport,
} from "../shared/sales-history";

const raw = JSON.parse(
  readFileSync(new URL("./fixtures/poslite-sales-export.json", import.meta.url), "utf8"),
);
const file = salesHistoryExport.parse(raw);
/** America/Mexico_City (UTC−6, no DST since 2022) with a 04:00 cutoff, as the fixture tenant. */
const dateOf = (at: string) =>
  new Date(Date.parse(at) - 6 * 3600_000 - 240 * 60_000).toISOString().slice(0, 10);

describe("pos-lite sales export file", () => {
  it("parses the fixture; refuses another source, a missing currency or a bad target", () => {
    expect(file.orders).toHaveLength(13);
    expect(salesHistoryExport.safeParse({ ...raw, source: "pos-lite-loyalty" }).success).toBe(false);
    const { currency: _c, ...noCurrency } = raw;
    expect(salesHistoryExport.safeParse(noCurrency).success).toBe(false);
    expect(salesHistoryExport.safeParse({ ...raw, targetTenantId: "juanbertos" }).success).toBe(false);
  });

  it("drops any field it does not know (a stray personal field never reaches the server's rows)", () => {
    const f = salesHistoryExport.parse({
      ...raw,
      orders: [{ ...raw.orders[0], customer_call_name: "Nombre Ficticio", invoice_token: "x" }],
    });
    expect(Object.keys(f.orders[0]!)).not.toContain("customer_call_name");
    expect(Object.keys(f.orders[0]!)).not.toContain("invoice_token");
  });
});

describe("pesos → centavos", () => {
  it("is exact for pos-lite's two decimals and rounds half away from zero beyond them", () => {
    expect(toCentavos(decimalOf("116.00")!)).toBe(11600);
    expect(toCentavos(decimalOf(104.4)!)).toBe(10440);
    expect(toCentavos(decimalOf("0.105")!)).toBe(11);
    expect(toCentavos(decimalOf("0.104")!)).toBe(10);
    expect(toCentavos(decimalOf("1e2")!)).toBe(10000);
    // 0.1 + 0.2 as floats is not 0.3; as decimals it is.
    expect(toCentavos(new Decimal("0.1").plus("0.2"))).toBe(30);
  });

  it("null is zero (pos-lite's optional amounts); text that is not a number is invalid", () => {
    expect(decimalOf(null)!.toNumber()).toBe(0);
    expect(decimalOf(undefined)!.toNumber()).toBe(0);
    expect(decimalOf("")).toBeNull();
    expect(decimalOf("12,50")).toBeNull();
    expect(decimalOf(Number.NaN)).toBeNull();
  });

  it("maps pos-lite's methods (mp_terminal is a card terminal); unknown ones are 'other'", () => {
    expect(historyMethod("cash")).toBe("cash");
    expect(historyMethod("mp_terminal")).toBe("card");
    expect(historyMethod("transfer")).toBe("transfer");
    expect(historyMethod("vale")).toBe("other");
    expect(historyMethod(null)).toBe("other");
  });
});

describe("normalizeSalesHistory", () => {
  const n = normalizeSalesHistory(file);

  it("accepts kiosk and POS sales and rejects the rest with a reason", () => {
    expect(n.accepted.map((s) => s.legacyId)).toEqual([
      "9001", "9002", "9003", "9004", "9005", "9006", "9012", "9013",
    ]);
    expect(n.rejected).toEqual([
      { legacyId: "9007", reason: "channel" },
      { legacyId: "9008", reason: "totals" },
      { legacyId: "9009", reason: "payments" },
      { legacyId: "9001", reason: "duplicate" },
      { legacyId: "9011", reason: "money" },
    ]);
  });

  it("dates a sale by paid_at, else created_at", () => {
    const at = Object.fromEntries(n.accepted.map((s) => [s.legacyId, s.at]));
    expect(at["9001"]).toBe("2026-05-01T19:01:00.000Z");
    expect(at["9002"]).toBe("2026-05-01T20:00:00.000Z");
  });

  it("splits by the settled payment rows (a pending row is ignored); tip stays outside the total", () => {
    const split = n.accepted.find((s) => s.legacyId === "9003")!;
    expect(split.parts).toEqual([
      { method: "card", amount: 13200, tip: 2000 },
      { method: "cash", amount: 10000, tip: 0 },
    ]);
    expect(split).toMatchObject({ total: 23200, tip: 2000, subtotal: 20000, tax: 3200 });
  });

  it("line discounts: gross before discounts, the line amount after them", () => {
    const d = n.accepted.find((s) => s.legacyId === "9004")!;
    expect(d).toMatchObject({ gross: 11600, discount: 1160, total: 10440 });
    expect(d.lines).toEqual([{ name: "Torta Ejemplo", quantity: 1, amount: 10440 }]);
  });

  it("reconciles the exact source sums with the converted centavos; the file's summary checks", () => {
    expect(n.reconciliation).toEqual({
      source: { total: "916.40", tax: "126.40", tip: "50.50", refunds: "0.00" },
      converted: { total: 91640, tax: 12640, tip: 5050, refunds: 0 },
      matches: true,
      rounded: 0,
      summaryOk: true,
      linesMismatch: 0,
    });
    const tampered = normalizeSalesHistory({ ...file, summary: { ...file.summary, total: "1.00" } });
    expect(tampered.reconciliation.summaryOk).toBe(false);
  });

  it("counts sub-centavo values and lines that disagree with the total without rejecting them", () => {
    const f: SalesHistoryExport = {
      ...file,
      orders: [
        { ...file.orders[1]!, id: 1, subtotal: "50.004", tax: "8.00", total: "58.004" },
        { ...file.orders[1]!, id: 2, lines: [{ name: "Agua de Prueba", quantity: 1, unit_price: "50.00", discount_amount: null }] },
      ],
    };
    const r = normalizeSalesHistory(f);
    expect(r.accepted.map((s) => s.legacyId)).toEqual(["1", "2"]);
    expect(r.reconciliation.rounded).toBe(2);
    expect(r.reconciliation.matches).toBe(false);
    expect(r.reconciliation.linesMismatch).toBe(1);
  });

  it("refunds above the total and a split without settled rows are rejected", () => {
    const r = normalizeSalesHistory({
      ...file,
      orders: [
        { ...file.orders[1]!, id: 1, refund_total: "58.01" },
        { ...file.orders[2]!, id: 2, payments: [] },
        { ...file.orders[1]!, id: 3, created_at: "not a date", paid_at: null },
      ],
    });
    expect(r.rejected.map((x) => x.reason)).toEqual(["refund", "payments", "instant"]);
  });
});

describe("aggregateSalesHistory", () => {
  const n = normalizeSalesHistory(file);
  const at = new Map(n.accepted.map((s) => [s.legacyId, s.at]));
  const a = aggregateSalesHistory(n.accepted, (id) => dateOf(at.get(id)!));

  it("buckets by business date and channel: 03:30 local before a 04:00 cutoff is the day before", () => {
    expect(a.coverage).toEqual({ from: "2026-05-01", to: "2026-05-03" });
    expect(a.days.map((d) => [d.date, d.channel, d.orders, d.total, d.tip])).toEqual([
      ["2026-05-01", "kiosk", 2, 22040, 1000],
      ["2026-05-01", "pos", 4, 40600, 2500],
      ["2026-05-03", "pos", 2, 29000, 1550],
    ]);
  });

  it("payments per method count each split part; the sum equals the sales total", () => {
    const m = methodTotals(a.payments);
    expect(m).toEqual({
      cash: { payments: 3, amount: 21600, tip: 0 },
      card: { payments: 5, amount: 52640, tip: 5050 },
      transfer: { payments: 1, amount: 17400, tip: 0 },
      other: { payments: 0, amount: 0, tip: 0 },
    });
    const c = channelTotals(a.days);
    expect(c.kiosk.total + c.pos.total).toBe(91640);
    expect(m.cash.amount + m.card.amount + m.transfer.amount + m.other.amount).toBe(91640);
  });

  it("products per day and channel with quantity and amount", () => {
    expect(
      a.products.filter((p) => p.date === "2026-05-01" && p.channel === "pos").map((p) => [p.name, p.quantity, p.amount]),
    ).toEqual([
      ["Agua de Prueba", 1, 5800],
      ["Burrito Demo", 2, 23200],
      ["Taco Ficticio", 2, 11600],
    ]);
  });

  it("monthly totals", () => {
    expect(monthTotals(a.days)).toEqual([
      { month: "2026-05", orders: 8, total: 91640, tax: 12640, tip: 5050 },
    ]);
  });

  it("an empty file aggregates to nothing", () => {
    expect(aggregateSalesHistory([], () => "2026-01-01")).toEqual({
      days: [],
      payments: [],
      products: [],
      coverage: null,
    });
  });
});
