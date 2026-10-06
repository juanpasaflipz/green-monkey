import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { businessDate, type LineInput, type Product } from "../shared/domain";
import {
  businessDayLabel,
  currentBusinessDate,
  orderNumberLabel,
  orderNumberText,
} from "../src/labels";
import { orderLabel } from "../src/features/offline/format";
import { resetConnectivityForTests } from "../src/connectivity";
import {
  cashSuggestions,
  changeDue,
  decodeCursor,
  encodeCursor,
  holdsTable,
  idSequence,
  kitchenStatus,
  mergeLine,
  orderNoteEditable,
  parseMoneyInput,
  paymentStatus,
  priceCart,
  recallPreparation,
  reconcileLostSend,
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

  it("mergeLine never merges into lines in flight and names a new line with newId (SVC-R7)", () => {
    const p = product();
    const sending = line(p);
    // The same product tapped while its line is being sent starts a new line.
    const opts = { newId: "tap-1", locked: new Set([sending.id]) };
    const tap = mergeLine([sending], p, { options: [] }, opts);
    expect(tap.lineId).toBe("tap-1");
    expect(tap.lines).toEqual([
      sending,
      { ...line(p), id: "tap-1", productId: p.id },
    ]);
    // Same inputs, same result: safe inside a React state updater.
    expect(mergeLine([sending], p, { options: [] }, opts)).toEqual(tap);
    // A second tap merges into the new, unlocked line.
    const again = mergeLine(
      tap.lines,
      p,
      { options: [] },
      {
        newId: "tap-2",
        locked: opts.locked,
      },
    );
    expect(again.lineId).toBe("tap-1");
    expect(again.lines.map((l) => [l.id, l.quantity])).toEqual([
      [sending.id, 1],
      ["tap-1", 2],
    ]);
    // Without a lock the D16 behaviour is unchanged.
    expect(mergeLine([sending], p, { options: [] }).lines).toEqual([
      { ...sending, quantity: 2 },
    ]);
  });

  it("idSequence gives every counter the same fresh ids in the same order", () => {
    let n = 0;
    const seq = idSequence(() => "id-" + ++n);
    const a = seq(),
      b = seq();
    expect([a(), a()]).toEqual(["id-1", "id-2"]);
    expect([b(), b(), b()]).toEqual(["id-1", "id-2", "id-3"]);
    expect(seq()()).toBe("id-1");
    const real = idSequence();
    const x = real(),
      y = real();
    expect(x()).toBe(y());
    expect(x()).not.toBe(real()());
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

  it("orderNoteEditable keeps the note open while a closed check's kitchen is (SVC-K3)", () => {
    for (const checkState of ["open", "paid"] as const)
      for (const state of ["active", "ready", "completed"])
        expect(orderNoteEditable({ checkState, state })).toBe(true);
    for (const closeReason of ["settled", "released"] as const) {
      expect(
        orderNoteEditable({
          checkState: "closed",
          state: "active",
          closeReason,
        }),
      ).toBe(true);
      expect(
        orderNoteEditable({
          checkState: "closed",
          state: "ready",
          closeReason,
        }),
      ).toBe(true);
      expect(
        orderNoteEditable({
          checkState: "closed",
          state: "completed",
          closeReason,
        }),
      ).toBe(false);
    }
    expect(
      orderNoteEditable({
        checkState: "closed",
        state: "active",
        closeReason: "voided",
      }),
    ).toBe(false);
    expect(
      orderNoteEditable({
        checkState: "closed",
        state: "cancelled",
        closeReason: "voided",
      }),
    ).toBe(false);
    expect(orderNoteEditable({ checkState: "open", state: "cancelled" })).toBe(
      false,
    );
    for (const state of ["recovery_pending", "recovery_reviewed"])
      expect(
        orderNoteEditable({
          checkState: "closed",
          state,
          closeReason: "recovery",
        }),
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

  const line = (id = randomUUID(), extra: object = {}) => ({
    id,
    productId: randomUUID(),
    quantity: 1,
    options: [] as string[],
    note: "",
    ...extra,
  });
  /** The stored order line for a draft line, as the server returns it. */
  const stored = (l: ReturnType<typeof line>, round: number, extra = {}) => ({
    ...l,
    round,
    ...extra,
  });
  const ids = () => {
    let n = 0;
    return () => "new-" + ++n;
  };

  it("drops lines the order already holds and replaces the operation id", () => {
    const sentLine = line(),
      added = line();
    const draft = {
      operationId: "consumed",
      lines: [sentLine, added],
      note: "Sin prisa",
      name: "Ana",
    };
    const order = {
      note: "Sin prisa",
      lines: [stored(sentLine, 2), stored(line(), 1)],
      rounds: [],
    };
    const next = reconcileLostSend(draft, order, "fresh");
    expect(next.sent).toBe(false);
    expect(next.changed).toBe(false);
    expect(next.rounds).toEqual([2]);
    expect(next.draft).toEqual({
      operationId: "fresh",
      lines: [added],
      note: "",
      name: "Ana",
    });
    expect(draft.lines).toHaveLength(2);
  });

  it("treats the send as done when every line landed unchanged", () => {
    const a = line(),
      b = line(randomUUID(), { options: ["o2", "o1"], note: "Sin cebolla" });
    const next = reconcileLostSend(
      { operationId: "k", lines: [a, b], note: "Postres al final" },
      {
        note: "",
        lines: [stored(a, 3), stored(b, 3, { options: ["o1", "o2"] })],
        rounds: [{ note: "Postres al final" }],
      },
      "n",
    );
    expect(next).toEqual({
      draft: { operationId: "n", lines: [], note: "" },
      sent: true,
      changed: false,
      rounds: [3],
    });
  });

  it("keeps the extra units when a landed line only grew (SVC-R3 scenario A)", () => {
    // 1 taco landed; the cashier tapped Taco again, so the same line became 2.
    const taco = line(randomUUID(), { quantity: 2 });
    const next = reconcileLostSend(
      { operationId: "k", lines: [taco], note: "" },
      { note: "", lines: [stored(taco, 1, { quantity: 1 })], rounds: [] },
      "n",
      ids(),
    );
    expect(next.sent).toBe(false);
    expect(next.changed).toBe(true);
    expect(next.rounds).toEqual([1]);
    expect(next.draft.lines).toEqual([{ ...taco, id: "new-1", quantity: 1 }]);
  });

  it("keeps a reviewable copy when a landed line's note changed (SVC-R3 scenario B)", () => {
    const taco = line(randomUUID(), { note: "Alergia: nuez" });
    const next = reconcileLostSend(
      { operationId: "k", lines: [taco], note: "" },
      { note: "", lines: [stored(taco, 1, { note: "" })], rounds: [] },
      "n",
      ids(),
    );
    expect(next.sent).toBe(false);
    expect(next.changed).toBe(true);
    expect(next.draft.lines).toEqual([{ ...taco, id: "new-1" }]);
  });

  it("keeps a reviewable copy for fewer units, other options or another open amount", () => {
    const fewer = line(randomUUID(), { quantity: 1 }),
      options = line(randomUUID(), { options: ["o1"] }),
      open = line(randomUUID(), { openAmount: 2500 }),
      same = line();
    const next = reconcileLostSend(
      { operationId: "k", lines: [fewer, options, open, same], note: "" },
      {
        note: "",
        lines: [
          stored(fewer, 1, { quantity: 3 }),
          stored(options, 1, { options: ["o2"] }),
          stored(open, 2, { openAmount: 2000 }),
          stored(same, 2),
        ],
        rounds: [],
      },
      "n",
      ids(),
    );
    expect(next.sent).toBe(false);
    expect(next.changed).toBe(true);
    expect(next.rounds).toEqual([1, 2]);
    expect(next.draft.lines).toEqual([
      { ...fewer, id: "new-1" },
      { ...options, id: "new-2" },
      { ...open, id: "new-3" },
    ]);
  });

  it("after a successful send keeps what changed while it was in flight (SVC-R7)", () => {
    // Sent: 1 taco with round note "Sin prisa". While the request was pending
    // the waiter added a Coca, tapped Taco again (a new line, the sent one is
    // locked), noted an allergy on it and typed the next round's note.
    const taco = line();
    const coca = line();
    const tacoAgain = line(randomUUID(), {
      productId: taco.productId,
      note: "Alergia: nuez",
    });
    const latest = {
      operationId: "sent-op",
      lines: [taco, coca, tacoAgain],
      note: "Que sea rápido",
    };
    const order = {
      note: "",
      lines: [stored(line(), 1), stored(taco, 2)],
      rounds: [{ note: "Sin prisa" }],
    };
    const next = reconcileLostSend(latest, order, "fresh", ids());
    expect(next).toEqual({
      draft: {
        operationId: "fresh",
        lines: [coca, tacoAgain],
        note: "Que sea rápido",
      },
      sent: false,
      changed: false,
      rounds: [2],
    });
    // An updater applied again to its own result (or to a cart already
    // reconciled) cannot bring the sent taco back or change anything else.
    expect(reconcileLostSend(next.draft, order, "fresh", ids()).draft).toEqual(
      next.draft,
    );
    // A cart that did not change empties exactly as before, note included.
    expect(
      reconcileLostSend(
        { operationId: "sent-op", lines: [taco], note: "Sin prisa" },
        order,
        "fresh",
      ),
    ).toEqual({
      draft: { operationId: "fresh", lines: [], note: "" },
      sent: true,
      changed: false,
      rounds: [2],
    });
  });

  it("gives identical results to the preview and the state updater with one idSequence", () => {
    const grown = line(randomUUID(), { quantity: 2 });
    const cart = { operationId: "k", lines: [grown], note: "" };
    const order = {
      note: "",
      lines: [stored(grown, 1, { quantity: 1 })],
      rounds: [],
    };
    const seq = idSequence();
    const preview = reconcileLostSend(cart, order, "n", seq());
    const updater = reconcileLostSend(cart, order, "n", seq());
    expect(updater).toEqual(preview);
    expect(preview.draft.lines[0].id).not.toBe(grown.id);
  });

  it("keeps a note that never reached the order", () => {
    const a = line();
    const next = reconcileLostSend(
      { operationId: "k", lines: [a], note: "Nota nueva" },
      { note: "Otra", lines: [], rounds: [{ note: "Vieja" }] },
      "n",
    );
    expect(next.sent).toBe(false);
    expect(next.changed).toBe(false);
    expect(next.rounds).toEqual([]);
    expect(next.draft.note).toBe("Nota nueva");
    expect(next.draft.lines).toEqual([a]);
    expect(next.draft.operationId).toBe("n");
  });
});

describe("LD-29: business-day labels after the cutoff rollover", () => {
  const mexico = { timezone: "America/Mexico_City", cutoff: 240 };
  // Mexico City is UTC−6 all year (no DST since 2022): 09:59Z is 03:59 local.
  const at = (iso: string) => Date.parse(iso);

  it("the current business date follows the restaurant's timezone and cutoff: 03:59 is still the day before, 04:00 is the new day", () => {
    expect(currentBusinessDate(mexico, at("2026-10-06T09:59:00Z"))).toBe(
      "2026-10-05",
    );
    expect(currentBusinessDate(mexico, at("2026-10-06T10:00:00Z"))).toBe(
      "2026-10-06",
    );
    // Same instant, another restaurant timezone (Tijuana, UTC−7 in October).
    expect(
      currentBusinessDate(
        { timezone: "America/Tijuana", cutoff: 240 },
        at("2026-10-06T10:59:00Z"),
      ),
    ).toBe("2026-10-05");
    // The server's own helper gives the same day for the same inputs.
    expect(currentBusinessDate(mexico, at("2026-10-06T10:00:00Z"))).toBe(
      businessDate("2026-10-06T10:00:00Z", mexico.timezone, mexico.cutoff),
    );
  });

  describe("without an instant", () => {
    afterEach(() => {
      vi.useRealTimers();
      resetConnectivityForTests();
    });

    it("the current business date reads the corrected server clock, not the raw device clock (POL-3)", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      // The tablet reads 03:58 local; the server is 3 minutes ahead (04:01).
      vi.setSystemTime(at("2026-10-06T09:58:00Z"));
      resetConnectivityForTests({}, 180_000);
      expect(currentBusinessDate(mexico)).toBe("2026-10-06");
      // With no measured offset the device clock is all there is.
      resetConnectivityForTests({}, null);
      expect(currentBusinessDate(mexico)).toBe("2026-10-05");
    });
  });

  it("a same-day order reads #10; one from the previous business day reads #10 · 5 oct (en: #10 · Oct 5)", () => {
    const order = { number: 10, businessDate: "2026-10-05" };
    const before = currentBusinessDate(mexico, at("2026-10-06T09:59:00Z"));
    const after = currentBusinessDate(mexico, at("2026-10-06T10:00:00Z"));
    expect(orderNumberLabel(order, before, "es")).toBe("#10");
    expect(orderNumberLabel(order, after, "es")).toBe("#10 · 5 oct");
    expect(orderNumberLabel(order, after, "en")).toBe("#10 · Oct 5");
    expect(orderNumberText(order, after, "es")).toBe("10 · 5 oct");
    expect(businessDayLabel("2026-01-31", "es")).toBe("31 ene");
    // Today's new #10 keeps the plain number; unknown dates never invent one.
    expect(
      orderNumberLabel({ number: 10, businessDate: after }, after, "es"),
    ).toBe("#10");
    expect(orderNumberLabel({ number: 10 }, after, "es")).toBe("#10");
    expect(orderNumberLabel(order, null, "es")).toBe("#10");
  });

  it("the cart heading names a numbered order's date; provisional numbers are unchanged", () => {
    const id = "00000000-0000-4000-8000-000000000010";
    const order = { id, number: 10, businessDate: "2026-10-05" };
    expect(orderLabel(order, "2026-10-06", "es")).toBe("#10 · 5 oct");
    expect(orderLabel(order, "2026-10-05", "es")).toBe("#10");
    expect(orderLabel(order)).toBe("#10");
    expect(
      orderLabel(
        { ...order, offline: { provisionalNumber: "B-07" } },
        "2026-10-06",
        "en",
      ),
    ).toBe("B-07 → #10 · Oct 5");
    expect(
      orderLabel(
        { id, number: 0, offline: { provisionalNumber: "B-07" } },
        "2026-10-06",
      ),
    ).toBe("B-07");
  });
});
