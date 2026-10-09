// Loyalty club (038): the pure core (specs/loyalty-w4.md §9.1): phones, names, the stamp rule,
// the reconciler's plan and the reward's discount request.
import { describe, expect, it } from "vitest";
import {
  cleanName,
  enrollmentIssue,
  firstName,
  formatPhone,
  maskPhone,
  nameKey,
  normalizeRows,
  parsePhone,
  planReconcile,
  rewardDiscountRequest,
  stampBase,
  stampsFor,
  STAMP_TENDER_METHODS,
  type ReconcileInput,
} from "../shared/loyalty";
import { TENDER_METHODS } from "../shared/payments";
import { planDiscount } from "../shared/discounts";
import type { PayableUnit } from "../shared/settlement";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { consentText, dateOnly, joinDoneText, thresholdHint } from "../src/features/loyalty/format";
import { MemberSheet } from "../src/features/loyalty/Members";
import { CLUB_REFRESH_MS, clubReadDue } from "../src/features/loyalty/loyaltyApi";
import { customersVisible, type MemberDetail } from "../shared/loyalty";

describe("parsePhone", () => {
  it("accepts Mexican numbers as +52 and 10 digits, with or without prefixes and separators", () => {
    for (const raw of [
      "5550000001",
      "55 5000 0001",
      "55-5000-0001",
      "(55) 5000.0001",
      "525550000001",
      "52 55 5000 0001",
      "5215550000001",
      "+52 1 55 5000 0001",
      "+525550000001",
      " 55 5000 0001 ",
    ])
      expect(parsePhone(raw, "MX"), raw).toBe("+525550000001");
  });
  it("refuses 9 and 11 digits, letters and other country codes for Mexico", () => {
    for (const raw of [
      "554587993",
      "15550000001",
      "55500000011",
      "55 4587 99a3",
      "",
      "+44 20 7946 0958",
      "52155458799",
    ])
      expect(parsePhone(raw, "MX"), raw).toBeNull();
  });
  it("accepts US/Canada numbers as +1 and 10 digits whose area code starts 2-9", () => {
    expect(parsePhone("212 555 0100", "US")).toBe("+12125550100");
    expect(parsePhone("1 212 555 0100", "US")).toBe("+12125550100");
    expect(parsePhone("+1 (416) 555-0199", "US")).toBe("+14165550199");
    expect(parsePhone("012 555 0100", "US")).toBeNull();
    expect(parsePhone("112 555 0100", "US")).toBeNull();
    expect(parsePhone("212 555 010", "US")).toBeNull();
  });
  it("the stored form satisfies 038's CHECK", () => {
    const check = /^\+(52[0-9]{10}|1[2-9][0-9]{9})$/;
    expect(parsePhone("5550000001", "MX")).toMatch(check);
    expect(parsePhone("2125550100", "US")).toMatch(check);
  });
});

describe("names and masks", () => {
  it("maskPhone shows the last four digits only", () => {
    expect(maskPhone("+525550000001")).toBe("···· 9933");
    expect(maskPhone(null)).toBe("");
  });
  it("formatPhone groups Mexican and US numbers", () => {
    expect(formatPhone("+525550000001")).toBe("+52 55 5000 0001");
    expect(formatPhone("+12125550100")).toBe("+1 212 555 0100");
  });
  it("nameKey folds accents and case and collapses spaces", () => {
    expect(nameKey("  José   ÁNGEL  Núñez ")).toBe("jose angel nunez");
    expect(nameKey("Ana")).toBe(nameKey("ANA"));
    expect(nameKey("x".repeat(80))).toHaveLength(60);
  });
  it("cleanName and firstName", () => {
    expect(cleanName("  Ana   María ")).toBe("Ana María");
    expect(firstName(" Ana María López")).toBe("Ana");
  });
  it("enrollmentIssue names the field with the area's codes", () => {
    const ok = { phone: "5550000001", country: "MX" as const, name: "Ana", consent: true };
    expect(enrollmentIssue(ok)).toBeNull();
    expect(enrollmentIssue({ ...ok, phone: "123" })).toBe("loyalty_invalid_phone");
    expect(enrollmentIssue({ ...ok, name: "   " })).toBe("loyalty_name_required");
    expect(enrollmentIssue({ ...ok, consent: false })).toBe("loyalty_consent_required");
  });
});

describe("stampsFor and the stamp base", () => {
  const rule = { stampThreshold: 40000, maxStampsPerOrder: null };
  it("1 stamp per paid purchase plus 1 per full threshold", () => {
    expect(stampsFor(0, rule)).toBe(0);
    expect(stampsFor(-5, rule)).toBe(0);
    expect(stampsFor(1, rule)).toBe(1);
    expect(stampsFor(39999, rule)).toBe(1);
    expect(stampsFor(40000, rule)).toBe(2);
    expect(stampsFor(90000, rule)).toBe(3);
  });
  it("threshold 0 gives always one stamp; the cap applies", () => {
    expect(stampsFor(500000, { stampThreshold: 0, maxStampsPerOrder: null })).toBe(1);
    expect(stampsFor(90000, { stampThreshold: 40000, maxStampsPerOrder: 2 })).toBe(2);
  });
  it("platform tenders never count; refunds net out; capped at the total; tips are not amounts", () => {
    expect(TENDER_METHODS).toContain("platform");
    expect(STAMP_TENDER_METHODS).toEqual(["cash", "external"]);
    expect(
      stampBase({
        total: 30000,
        tenders: [
          { method: "cash", amount: 10000, refunded: 0 },
          { method: "external", amount: 20000, refunded: 5000 },
        ],
      }),
    ).toBe(25000);
    expect(
      stampBase({ total: 30000, tenders: [{ method: "platform", amount: 30000, refunded: 0 }] }),
    ).toBe(0);
    expect(
      stampBase({ total: 10000, tenders: [{ method: "cash", amount: 12000, refunded: 0 }] }),
    ).toBe(10000);
    expect(
      stampBase({ total: 10000, tenders: [{ method: "cash", amount: 10000, refunded: 10000 }] }),
    ).toBe(0);
  });
});

describe("normalizeRows", () => {
  it("overflow carries over: 12 of 10 is one reward and 2 stamps", () => {
    const rows = normalizeRows("m", 12, 0, 10, false);
    expect(rows).toEqual([
      { memberId: "m", kind: "reward_earned", stampsDelta: -10, rewardsDelta: 1, stampsRequired: 10 },
    ]);
  });
  it("two full cards at once", () => {
    expect(normalizeRows("m", 21, 0, 10, false).map((r) => r.kind)).toEqual([
      "reward_earned",
      "reward_earned",
    ]);
  });
  it("after a reversal a negative card withdraws an available reward, never one already used", () => {
    expect(normalizeRows("m", -2, 1, 10, true)).toEqual([
      { memberId: "m", kind: "reward_unearned", stampsDelta: 10, rewardsDelta: -1, stampsRequired: 10 },
    ]);
    expect(normalizeRows("m", -2, 0, 10, true)).toEqual([]);
    expect(normalizeRows("m", -2, 1, 10, false)).toEqual([]);
  });
});

describe("planReconcile (§2.2)", () => {
  const A = "00000000-0000-4000-8000-00000000000a";
  const B = "00000000-0000-4000-8000-00000000000b";
  const base = (o: Partial<ReconcileInput> = {}): ReconcileInput => ({
    enabled: true,
    stampsRequired: 10,
    rule: { stampThreshold: 40000, maxStampsPerOrder: null },
    settled: true,
    base: 15000,
    linkMemberId: A,
    members: [{ id: A, deleted: false, stamps: 3, rewards: 0, posted: 0 }],
    redemptions: [],
    ...o,
  });
  /** Applies a plan to the members, as the ledger trigger would. */
  const apply = (i: ReconcileInput): ReconcileInput => {
    const rows = planReconcile(i);
    return {
      ...i,
      members: i.members.map((m) => {
        const mine = rows.filter((r) => r.memberId === m.id);
        return {
          ...m,
          stamps: m.stamps + mine.reduce((a, r) => a + r.stampsDelta, 0),
          rewards: m.rewards + mine.reduce((a, r) => a + r.rewardsDelta, 0),
          posted:
            m.posted +
            mine
              .filter((r) => r.kind === "earn" || r.kind === "earn_reversal")
              .reduce((a, r) => a + r.stampsDelta, 0),
        };
      }),
      redemptions: i.redemptions.map((r) => ({
        ...r,
        restored:
          r.restored ||
          rows.some((x) => x.kind === "reward_restored" && x.discountId === r.discountId),
      })),
    };
  };
  it("first earn, then a repeat plans nothing", () => {
    const i = base();
    expect(planReconcile(i)).toEqual([
      { memberId: A, kind: "earn", stampsDelta: 1, rewardsDelta: 0, base: 15000 },
    ]);
    expect(planReconcile(apply(i))).toEqual([]);
  });
  it("$900 at a $400 threshold earns 3", () => {
    expect(planReconcile(base({ base: 90000 }))[0].stampsDelta).toBe(3);
  });
  it("an order that is not settled, or linked to nobody, earns nothing", () => {
    expect(planReconcile(base({ settled: false }))).toEqual([]);
    expect(planReconcile(base({ linkMemberId: null }))).toEqual([]);
    expect(planReconcile(base({ base: 0 }))).toEqual([]);
  });
  it("a partial refund below the threshold changes nothing; one crossing it reverses one stamp; a full refund reverses all", () => {
    const earned = apply(base({ base: 90000 })); // 3 posted
    expect(planReconcile({ ...earned, base: 85000 })).toEqual([]);
    expect(planReconcile({ ...earned, base: 70000 })).toEqual([
      { memberId: A, kind: "earn_reversal", stampsDelta: -1, rewardsDelta: 0, base: 70000 },
    ]);
    expect(planReconcile({ ...earned, base: 0 })).toEqual([
      { memberId: A, kind: "earn_reversal", stampsDelta: -3, rewardsDelta: 0, base: 0 },
    ]);
  });
  it("overflow carries over (9 + 3 → 1 reward, 2 stamps)", () => {
    const i = base({
      base: 90000,
      members: [{ id: A, deleted: false, stamps: 9, rewards: 0, posted: 0 }],
    });
    const after = apply(i);
    expect(after.members[0]).toMatchObject({ stamps: 2, rewards: 1, posted: 3 });
    expect(planReconcile(i).map((r) => r.kind)).toEqual(["earn", "reward_earned"]);
  });
  it("a lowered stamps_required completes on the next posting (9 + 1 at 8 → 1 reward, 2 stamps)", () => {
    const after = apply(
      base({
        stampsRequired: 8,
        members: [{ id: A, deleted: false, stamps: 9, rewards: 0, posted: 0 }],
      }),
    );
    expect(after.members[0]).toMatchObject({ stamps: 2, rewards: 1 });
  });
  it("a refund crossing a completed, unredeemed card withdraws the reward", () => {
    const completed = apply(
      base({ base: 90000, members: [{ id: A, deleted: false, stamps: 9, rewards: 0, posted: 0 }] }),
    ); // stamps 2, rewards 1, posted 3
    const rows = planReconcile({ ...completed, base: 0 });
    expect(rows.map((r) => r.kind)).toEqual(["earn_reversal", "reward_unearned"]);
    const back = apply({ ...completed, base: 0 });
    expect(back.members[0]).toMatchObject({ stamps: 9, rewards: 0, posted: 0 });
  });
  it("a refund after the reward was redeemed leaves negative stamps (Ajuste pendiente)", () => {
    const completed = apply(
      base({ base: 90000, members: [{ id: A, deleted: false, stamps: 9, rewards: 0, posted: 0 }] }),
    );
    const redeemed = {
      ...completed,
      members: completed.members.map((m) => ({ ...m, rewards: 0 })),
    };
    const back = apply({ ...redeemed, base: 0 });
    expect(back.members[0]).toMatchObject({ stamps: -1, rewards: 0 });
    expect(planReconcile({ ...redeemed, base: 0 }).map((r) => r.kind)).toEqual(["earn_reversal"]);
  });
  it("relink: the old member's stamps are reversed and the new member earns", () => {
    const earned = apply(
      base({
        members: [
          { id: A, deleted: false, stamps: 3, rewards: 0, posted: 0 },
          { id: B, deleted: false, stamps: 0, rewards: 0, posted: 0 },
        ],
      }),
    );
    const rows = planReconcile({ ...earned, linkMemberId: B });
    expect(rows).toEqual([
      { memberId: A, kind: "earn_reversal", stampsDelta: -1, rewardsDelta: 0, base: 15000 },
      { memberId: B, kind: "earn", stampsDelta: 1, rewardsDelta: 0, base: 15000 },
    ]);
  });
  it("club off: no new earnings, reversals still post", () => {
    expect(planReconcile(base({ enabled: false }))).toEqual([]);
    const earned = apply(base({ base: 90000 }));
    expect(planReconcile({ ...earned, enabled: false })).toEqual([]);
    expect(planReconcile({ ...earned, enabled: false, base: 0 })).toEqual([
      { memberId: A, kind: "earn_reversal", stampsDelta: -3, rewardsDelta: 0, base: 0 },
    ]);
  });
  it("a deleted member is skipped", () => {
    expect(
      planReconcile(base({ members: [{ id: A, deleted: true, stamps: 0, rewards: 0, posted: 0 }] })),
    ).toEqual([]);
  });
  const D = "00000000-0000-4000-8000-0000000000d1";
  const redemption = (o: Partial<ReconcileInput["redemptions"][number]>) => ({
    memberId: A,
    discountId: D,
    restored: false,
    discountReversed: false,
    activeAmount: 8500,
    orderClosed: false,
    ...o,
  });
  it("a reversed reward discount is restored once", () => {
    const i = base({ settled: false, redemptions: [redemption({ discountReversed: true })] });
    expect(planReconcile(i)).toEqual([
      { memberId: A, kind: "reward_restored", stampsDelta: 0, rewardsDelta: 1, discountId: D },
    ]);
    expect(planReconcile(apply(i))).toEqual([]);
  });
  it("a reward whose units were all voided is restored when the order is closed, not while it is open", () => {
    expect(
      planReconcile(base({ settled: false, redemptions: [redemption({ activeAmount: 0 })] })),
    ).toEqual([]);
    expect(
      planReconcile(
        base({ settled: false, redemptions: [redemption({ activeAmount: 0, orderClosed: true })] }),
      ).map((r) => r.kind),
    ).toEqual(["reward_restored"]);
    expect(
      planReconcile(
        base({
          settled: false,
          redemptions: [redemption({ activeAmount: 0, orderClosed: true, restored: true })],
        }),
      ),
    ).toEqual([]);
  });
});

describe("rewardDiscountRequest (§2.6)", () => {
  const L1 = "00000000-0000-4000-8000-0000000000e1";
  const L2 = "00000000-0000-4000-8000-0000000000e2";
  const unit = (lineId: string, unit: number, due: number, o: Partial<PayableUnit> = {}): PayableUnit => ({
    key: `${lineId}:${unit}`,
    lineId,
    unit,
    name: { es: "x", en: "x" },
    total: due,
    discount: 0,
    lineDiscounted: false,
    paid: 0,
    due,
    ...o,
  });
  const order = {
    paymentUnits: [unit(L1, 0, 8500), unit(L1, 1, 8500), unit(L2, 0, 21000)],
    discounts: [],
  };
  const item = { rewardKind: "item" as const, rewardAmount: null, rewardMaxAmount: 15000 };
  it("an item within the cap is a comp of one unit", () => {
    const r = rewardDiscountRequest(item, order, L1);
    expect(r).toEqual({ scope: "line", lineId: L1, quantity: 1, kind: "comp" });
    expect(planDiscount(order, r)).toMatchObject({ amount: 8500, base: 8500, units: 1 });
  });
  it("an item above the cap is an amount discount equal to the cap", () => {
    const r = rewardDiscountRequest(item, order, L2);
    expect(r).toEqual({ scope: "line", lineId: L2, quantity: 1, kind: "amount", amount: 15000 });
    expect(planDiscount(order, r)).toMatchObject({ amount: 15000, base: 21000 });
  });
  it("no cap: always the whole unit", () => {
    expect(rewardDiscountRequest({ ...item, rewardMaxAmount: null }, order, L2).kind).toBe("comp");
  });
  it("a paid or already discounted unit cannot take the reward", () => {
    const paid = { paymentUnits: [unit(L1, 0, 0, { paid: 8500 })], discounts: [] };
    expect(() => rewardDiscountRequest(item, paid, L1)).toThrow("discount_units_unavailable");
    const covered = { paymentUnits: [unit(L1, 0, 8500, { lineDiscounted: true })], discounts: [] };
    expect(() => rewardDiscountRequest(item, covered, L1)).toThrow("discount_units_unavailable");
    expect(() => rewardDiscountRequest(item, order)).toThrow("invalid_input");
  });
  it("an amount reward is a check discount of min(amount, due); a check discount already active conflicts", () => {
    const amount = { rewardKind: "amount" as const, rewardAmount: 50000, rewardMaxAmount: null };
    expect(rewardDiscountRequest(amount, order)).toEqual({ scope: "order", kind: "amount", amount: 38000 });
    expect(rewardDiscountRequest({ ...amount, rewardAmount: 10000 }, order).amount).toBe(10000);
    const withCheck = {
      ...order,
      discounts: [{ scope: "order", reversal: null } as never],
    };
    expect(() => rewardDiscountRequest(amount, withCheck)).toThrow("loyalty_reward_conflict");
  });
});

describe("the /club result text (LOYALTY-UX-7, UX-8)", () => {
  const done = { stampsAdded: 1, stamps: 4, required: 10, rewards: 0, completed: 0, pending: false };
  it("one stamp is singular, several plural", () => {
    expect(joinDoneText(done, "es")).toBe("¡Listo! Sumaste 1 sello. Llevas 4 de 10.");
    expect(joinDoneText({ ...done, stampsAdded: 3, stamps: 6 }, "es")).toBe("¡Listo! Sumaste 3 sellos. Llevas 6 de 10.");
    expect(joinDoneText(done, "en")).toBe("Done! You earned 1 stamp. You have 4 of 10.");
  });
  it("a completed card says so instead of 0 de 10", () => {
    const full = { ...done, stamps: 0, rewards: 1, completed: 1 };
    expect(joinDoneText(full, "es")).toBe("¡Completaste tu tarjeta! Tienes 1 premio disponible. Pídelo en caja.");
    expect(joinDoneText({ ...full, rewards: 2 }, "en")).toBe("You completed your card! You have 2 rewards available. Ask for it at the counter.");
  });
  it("a purchase that earned nothing never says Sumaste 0 sellos; an unpaid one is pending", () => {
    expect(joinDoneText({ ...done, stampsAdded: 0 }, "es")).toBe("Esta compra no suma sellos.");
    expect(joinDoneText({ ...done, stampsAdded: 0, pending: true }, "es")).toBe("¡Listo! Tus sellos se sumarán cuando se pague esta orden.");
  });
});

describe("Clientes and the ARCO sheet (LOYALTY-PRIVACY-3, PRIVACY-5, UX-12)", () => {
  it("Clientes shows while the club is on, or while a member's data is held with the club off", () => {
    expect(customersVisible({ enabled: true })).toBe(true);
    expect(customersVisible({ enabled: false, hasMembers: true })).toBe(true);
    expect(customersVisible({ enabled: false, hasMembers: false })).toBe(false);
    expect(customersVisible({ enabled: false })).toBe(false);
  });
  it("dates without the time are whole in both languages (never a slice of a date-time)", () => {
    const at = "2026-10-07T20:32:00Z";
    expect(dateOnly(at, "America/Mexico_City", "es")).toBe("07/10/2026");
    expect(dateOnly(at, "America/Mexico_City", "en")).toBe("Oct 7, 2026");
    expect(dateOnly("2026-10-17T05:00:00Z", "America/Mexico_City", "en")).toBe("Oct 16, 2026");
  });
  const imported: MemberDetail = {
    id: "00000000-0000-4000-8000-000000000001",
    firstName: "Ana",
    maskedPhone: "···· 9933",
    stamps: 3,
    required: 10,
    rewards: 0,
    deleted: false,
    name: "Ana López",
    phone: "+525550000001",
    country: "MX",
    version: 2,
    joinedAt: "2024-03-01T18:00:00Z",
    joinedVia: "import",
    joinedByName: null,
    consentChannel: "pos_lite_import",
    consentAt: "2024-03-01T18:00:00Z",
    consentNoticeUrl: null,
    marketingOptIn: false,
    marketingChangedAt: "2026-10-05T16:00:00Z",
    lifetimeStamps: 3,
    rewardsEarned: 0,
    rewardsRedeemed: 0,
    lastVisitAt: "2026-10-06T19:00:00Z",
    legacy: { visits: 12, spend: 345000, lastVisitAt: "2026-09-30T19:00:00Z", smsOptIn: true },
    redactedAt: null,
    redactionReason: null,
    history: [
      {
        id: "00000000-0000-4000-8000-000000000002",
        kind: "adjustment",
        stampsDelta: 2,
        rewardsDelta: 0,
        orderId: null,
        orderNumber: null,
        orderBusinessDate: null,
        discountId: null,
        reason: "goodwill",
        note: "Cortesía por la espera",
        actorName: "Gerente Uno",
        createdAt: "2026-10-05T16:00:00Z",
      },
    ],
    orders: [
      {
        orderId: "00000000-0000-4000-8000-000000000003",
        number: 42,
        businessDate: "2026-10-06",
        total: 18500,
        stamps: 1,
        linkedAt: "2026-10-06T19:00:00Z",
      },
    ],
  };
  it("an imported member's consent line says pos-lite showed no notice", () => {
    expect(consentText(imported, "America/Mexico_City", "es")).toBe(
      "Importado de POS Lite el 01/03/2024 12:00; sin aviso registrado en POS Lite",
    );
    expect(consentText({ ...imported, consentChannel: "staff_attested" }, "America/Mexico_City", "es")).toMatch(
      /^Aceptó el aviso en caja el /,
    );
  });
  it("the printed sheet holds every stored field: pos-lite figures and SMS flag, marketing change, notes, linked orders", () => {
    const html = renderToStaticMarkup(
      createElement(MemberSheet, { m: imported, locale: "es", tz: "America/Mexico_City", currency: "MXN" }),
    );
    for (const text of [
      "Ana López",
      "+52 55 5000 0001",
      "Importado de POS Lite el 01/03/2024",
      "sin aviso registrado en POS Lite",
      "cambiado el 05/10/2026",
      "Última visita en POS Lite",
      "30/09/2026",
      "Sí (pre-marcado en POS Lite; no es consentimiento)",
      "Cortesía por la espera",
      "Gerente Uno",
      "#42",
      "$185.00",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("Aceptó el aviso");
  });
});

describe("the stamp threshold hint follows what the owner typed (LOYALTY-UX-18)", () => {
  it("$0 is exactly one stamp; an amount is the typed one, not the saved one", () => {
    expect(thresholdHint("0", "es", "MXN")).toBe("Cada compra pagada da exactamente 1 sello.");
    expect(thresholdHint("0.00", "en", "MXN")).toBe("Each paid purchase earns exactly 1 stamp.");
    expect(thresholdHint("250", "es", "MXN")).toContain("$250.00");
    expect(thresholdHint("250", "es", "MXN")).not.toContain("$400.00");
    expect(thresholdHint("abc", "es", "MXN")).toContain("$400.00");
  });
});

describe("Vender re-reads the club (LOYALTY-UX-5)", () => {
  const t0 = 1_000_000;
  it("reads a restaurant it never read, and a good read again after five minutes", () => {
    expect(clubReadDue(null, "a", t0)).toBe(true);
    expect(clubReadDue({ tenant: "b", readAt: t0, failures: 0 }, "a", t0)).toBe(true);
    expect(clubReadDue({ tenant: "a", readAt: t0, failures: 0 }, "a", t0 + CLUB_REFRESH_MS - 1)).toBe(false);
    expect(clubReadDue({ tenant: "a", readAt: t0, failures: 0 }, "a", t0 + CLUB_REFRESH_MS)).toBe(true);
  });
  it("retries a failed read with backoff (5 s, 10 s, 20 s, … at most 5 min), never caching the failure for the shift", () => {
    expect(clubReadDue({ tenant: "a", readAt: t0, failures: 1 }, "a", t0 + 4_999)).toBe(false);
    expect(clubReadDue({ tenant: "a", readAt: t0, failures: 1 }, "a", t0 + 5_000)).toBe(true);
    expect(clubReadDue({ tenant: "a", readAt: t0, failures: 2 }, "a", t0 + 9_999)).toBe(false);
    expect(clubReadDue({ tenant: "a", readAt: t0, failures: 3 }, "a", t0 + 20_000)).toBe(true);
    expect(clubReadDue({ tenant: "a", readAt: t0, failures: 30 }, "a", t0 + CLUB_REFRESH_MS)).toBe(true);
  });
});
