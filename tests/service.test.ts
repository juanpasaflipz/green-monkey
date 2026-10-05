import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { LineInput, Product } from "../shared/domain";
import {
  cashSuggestions,
  changeDue,
  decodeCursor,
  encodeCursor,
  holdsTable,
  kitchenStatus,
  mergeLine,
  parseMoneyInput,
  paymentStatus,
  priceCart,
  recallPreparation,
  roundNotes,
  tipFromPercent,
  validatePayment,
  ALLERGY_PATTERN,
} from "../shared/service";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "no error";
};

function product(extra: Partial<Product> = {}): Product {
  return {
    id: randomUUID(),
    name: { es: "Taco", en: "Taco" },
    category: { es: "Tacos", en: "Tacos" },
    price: 3500,
    available: true,
    station: "kitchen",
    groups: [],
    cost: null,
    version: 1,
    ...extra,
  };
}
const line = (p: Product, extra: Partial<LineInput> = {}): LineInput => ({
  id: randomUUID(),
  productId: p.id,
  quantity: 1,
  options: [],
  note: "",
  ...extra,
});
const payment = (extra: Partial<Parameters<typeof validatePayment>[0]> = {}) =>
  validatePayment({
    amountText: "100",
    tipText: "",
    receivedText: "100",
    method: "cash",
    reference: "",
    confirmed: false,
    due: 10000,
    exponent: 2,
    drawerOpen: true,
    online: true,
    ...extra,
  });

describe("service money input", () => {
  it("parseMoneyInput accepts es-MX thousands separators and rejects ambiguous commas", () => {
    expect(parseMoneyInput("1,000", 2)).toBe(100000);
    expect(parseMoneyInput("1,250.50", 2)).toBe(125050);
    expect(parseMoneyInput("$ 80", 2)).toBe(8000);
    expect(parseMoneyInput("$\u00a01,000", 2)).toBe(100000);
    expect(parseMoneyInput(" 123,456.7 ", 2)).toBe(12345670);
    expect(code(() => parseMoneyInput("10,5", 2))).toBe("invalid_amount");
    expect(code(() => parseMoneyInput("1,00", 2))).toBe("invalid_amount");
    expect(code(() => parseMoneyInput("1.000,50", 2))).toBe("invalid_amount");
    expect(code(() => parseMoneyInput("abc", 2))).toBe("invalid_amount");
    expect(code(() => parseMoneyInput("99999999", 2))).toBe("invalid_amount");
  });

  it("parseMoneyInput treats an empty tip as zero only when allowed", () => {
    expect(parseMoneyInput("", 2, { emptyAsZero: true })).toBe(0);
    expect(parseMoneyInput("  ", 2, { emptyAsZero: true })).toBe(0);
    expect(code(() => parseMoneyInput("", 2))).toBe("invalid_amount");
    expect(code(() => parseMoneyInput("", 2, { emptyAsZero: false }))).toBe(
      "invalid_amount",
    );
  });

  it("cashSuggestions offers exact and next MXN bill amounts", () => {
    expect(cashSuggestions(8750, "MXN", 2)).toEqual([
      8750, 10000, 20000, 50000,
    ]);
    expect(cashSuggestions(20000, "MXN", 2)).toEqual([
      20000, 22000, 25000, 30000,
    ]);
    expect(cashSuggestions(8750, "USD", 2)).toEqual([8750]);
  });

  it("changeDue uses this payment's amount, not the full balance", () => {
    // FOH-12: a partial cash payment of 300 on a 900 balance gives no change.
    const due = 90000;
    expect(changeDue(30000, 30000, 0)).toBe(0);
    expect(changeDue(50000, 30000, 0)).toBe(20000);
    expect(changeDue(30000, due, 0)).toBe(0);
  });

  it("tipFromPercent rounds to whole currency units", () => {
    expect(tipFromPercent(12345, 10, 2)).toBe(1200);
    expect(tipFromPercent(12345, 15, 2)).toBe(1900);
    expect(tipFromPercent(1000, 15, 0)).toBe(150);
  });
});

describe("payment validation", () => {
  it("validatePayment requires an open drawer before anything is sent", () => {
    // MON-8: the drawer is checked first, before any field or kitchen send.
    expect(payment({ drawerOpen: false, amountText: "x" })).toEqual({
      ok: false,
      problem: { field: "drawer", key: "servicePayDrawer" },
    });
    // Offline sales keep their own local drawer checks.
    expect(payment({ drawerOpen: false, online: false }).ok).toBe(true);
  });

  it("validatePayment ignores cash received for external payments and requires reference and confirmation", () => {
    // FOH-3 and the FOH-12 card-tip case: received 0 with a tip is fine.
    const base = {
      method: "external" as const,
      receivedText: "0",
      tipText: "5",
    };
    expect(payment(base)).toEqual({
      ok: false,
      problem: { field: "reference", key: "servicePayReferenceRequired" },
    });
    expect(payment({ ...base, reference: "4821" })).toEqual({
      ok: false,
      problem: { field: "confirmed", key: "servicePayConfirmRequired" },
    });
    const ok = payment({ ...base, reference: " 4821 ", confirmed: true });
    expect(ok).toEqual({
      ok: true,
      values: {
        amount: 10000,
        tip: 500,
        received: 10500,
        method: "external",
        reference: "4821",
        confirmed: true,
      },
    });
  });

  it("validatePayment reports the first invalid field in order", () => {
    const field = (r: ReturnType<typeof payment>) =>
      r.ok ? "ok" : `${r.problem.field}:${r.problem.key}`;
    expect(field(payment({ amountText: "1,0", tipText: "x" }))).toBe(
      "amount:servicePayAmountInvalid",
    );
    expect(field(payment({ amountText: "0" }))).toBe(
      "amount:servicePayAmountZero",
    );
    expect(field(payment({ amountText: "100.01" }))).toBe(
      "amount:servicePayAmountExceeds",
    );
    expect(field(payment({ tipText: "abc", receivedText: "" }))).toBe(
      "tip:servicePayTipInvalid",
    );
    expect(field(payment({ tipText: "10", receivedText: "105" }))).toBe(
      "received:servicePayReceivedShort",
    );
    expect(field(payment({ receivedText: "" }))).toBe(
      "received:servicePayReceivedShort",
    );
    const ok = payment({ amountText: "1,00", due: 1000000 });
    expect(field(ok)).toBe("amount:servicePayAmountInvalid");
    const cash = payment({
      amountText: "50",
      tipText: "",
      receivedText: "1,000",
    });
    expect(cash).toEqual({
      ok: true,
      values: {
        amount: 5000,
        tip: 0,
        received: 100000,
        method: "cash",
        reference: "",
        confirmed: false,
      },
    });
  });
});

describe("cart pricing and merging", () => {
  it("priceCart prices each line independently and flags unavailable lines", () => {
    // FOH-8: one sold-out product no longer blanks the whole cart.
    const a = product({ price: 3500 });
    const b = product({ price: 2000, available: false });
    const c = product({ price: 4000 });
    const lines = [line(a), line(b), line(c, { quantity: 2 })];
    const cart = priceCart(lines, [a, b, c], false);
    expect(cart.lines.filter((l) => l.priced).length).toBe(2);
    expect(cart.lines.map((l) => l.error)).toEqual([null, "unavailable", null]);
    expect(cart.blocked).toBe(true);
    expect(cart.total).toBe(3500 + 8000);
    expect(priceCart([line(a)], [a], false)).toMatchObject({
      blocked: false,
      total: 3500,
    });
    const missing = priceCart([line(product())], [a], false);
    expect(missing.lines[0].error).toBe("unavailable");
  });

  it("mergeLine increments identical plain lines and appends lines with options, notes or open amounts", () => {
    const option = randomUUID();
    const p = product({
      groups: [
        {
          id: randomUUID(),
          name: { es: "Salsa", en: "Sauce" },
          min: 0,
          max: 1,
          options: [
            {
              id: option,
              name: { es: "Verde", en: "Green" },
              price: 0,
              available: true,
            },
          ],
        },
      ],
    });
    const first = mergeLine([], p, { options: [] });
    expect(first.lines).toHaveLength(1);
    const second = mergeLine(first.lines, p, { options: [] });
    expect(second.lineId).toBe(first.lineId);
    expect(second.lines).toEqual([{ ...first.lines[0], quantity: 2 }]);
    const withOption = mergeLine(second.lines, p, { options: [option] });
    expect(withOption.lines).toHaveLength(2);
    expect(withOption.lineId).not.toBe(first.lineId);
    const sameOption = mergeLine(withOption.lines, p, { options: [option] });
    expect(sameOption.lineId).toBe(withOption.lineId);
    expect(sameOption.lines[1].quantity).toBe(2);
    const noted = sameOption.lines.map((l) =>
      l.id === first.lineId ? { ...l, note: "Sin cebolla" } : l,
    );
    const afterNote = mergeLine(noted, p, { options: [] });
    expect(afterNote.lines).toHaveLength(3);
    const full = [{ ...first.lines[0], quantity: 99 }];
    expect(mergeLine(full, p, { options: [] }).lines).toHaveLength(2);
    const open = product({ openAmount: true });
    const o1 = mergeLine([], open, { options: [], openAmount: 5000 });
    expect(o1.lines[0].openAmount).toBe(5000);
    const o2 = mergeLine(o1.lines, open, { options: [], openAmount: 5000 });
    expect(o2.lines).toHaveLength(2);
  });
});

describe("service lifecycle rules", () => {
  it("recallPreparation allows only completed to ready", () => {
    expect(recallPreparation("completed")).toBe("ready");
    for (const state of ["active", "ready", "offline_review"])
      expect(code(() => recallPreparation(state))).toBe("round_not_recallable");
  });

  it("holdsTable keeps dine-in table checks and releases takeaway, tableless and offline", () => {
    const table = randomUUID();
    expect(
      holdsTable({ mode: "dine_in", tableId: table, channel: "pos" }),
    ).toBe(true);
    expect(
      holdsTable({ mode: "dine_in", table_id: table, channel: "qr" }),
    ).toBe(true);
    expect(holdsTable({ mode: "dine_in", tableId: null, channel: "pos" })).toBe(
      false,
    );
    expect(
      holdsTable({ mode: "takeaway", tableId: table, channel: "pos" }),
    ).toBe(false);
    expect(
      holdsTable({ mode: "delivery", tableId: null, channel: "pos" }),
    ).toBe(false);
    expect(
      holdsTable({ mode: "dine_in", tableId: table, channel: "offline" }),
    ).toBe(false);
  });

  it("order cursor round-trips microsecond timestamps and rejects tampering", () => {
    const c = { t: "2026-10-04 23:47:38.123456-06", i: randomUUID() };
    const encoded = encodeCursor(c);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual(c);
    const tampered = (s: string) => code(() => decodeCursor(s));
    expect(tampered(encoded.slice(0, -2) + "!!")).toBe("invalid_input");
    expect(tampered("bm90IGpzb24")).toBe("invalid_input");
    const forge = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    expect(tampered(forge({ ...c, x: 1 }))).toBe("invalid_input");
    expect(tampered(forge({ ...c, i: "1" }))).toBe("invalid_input");
    expect(tampered(forge({ ...c, t: "now(); drop table orders" }))).toBe(
      "invalid_input",
    );
    expect(tampered(forge({ ...c, t: "2026-13-40 25:61:00+00" }))).toBe(
      "invalid_input",
    );
  });

  it("paymentStatus and kitchenStatus derive badges", () => {
    expect(paymentStatus({ total: 1000, paid: 0, refunded: 0 })).toBe("unpaid");
    expect(paymentStatus({ total: 1000, paid: 400, refunded: 0 })).toBe(
      "partial",
    );
    expect(paymentStatus({ total: 1000, paid: 1000, refunded: 0 })).toBe(
      "paid",
    );
    expect(paymentStatus({ total: 1000, paid: 1000, refunded: 100 })).toBe(
      "refunded",
    );
    expect(paymentStatus({ total: 0, paid: 0, refunded: 0 })).toBe("unpaid");
    expect(kitchenStatus({ openRounds: 2, readyRounds: 1 })).toBe("preparing");
    expect(kitchenStatus({ openRounds: 2, readyRounds: 2 })).toBe("ready");
    expect(kitchenStatus({ openRounds: 0, readyRounds: 0 })).toBe("served");
  });

  it("flags allergy notes in Spanish and English", () => {
    for (const note of [
      "ALERGIA: cacahuate",
      "alérgico al maní",
      "Allergy: nuts",
    ])
      expect(ALLERGY_PATTERN.test(note)).toBe(true);
    expect(ALLERGY_PATTERN.test("Sin cebolla")).toBe(false);
  });
});

describe("notes and lost sends", () => {
  it("lists round notes once per round, in order, without the order note", () => {
    expect(
      roundNotes({
        note: "ALERGIA: cacahuate",
        rounds: [
          { number: 3, note: "Postres al final" },
          { number: 1, note: "" },
          { number: 2, note: "Para llevar" },
          { number: 2, note: "Para llevar" },
          { number: 3, note: "Postres al final" },
          { number: 4, note: " ALERGIA: cacahuate " },
          { number: 5, note: null },
        ],
      }),
    ).toEqual([
      { round: 2, note: "Para llevar" },
      { round: 3, note: "Postres al final" },
    ]);
    expect(roundNotes({ note: "", rounds: undefined })).toEqual([]);
  });
});
