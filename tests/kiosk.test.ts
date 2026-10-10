// Kiosk self-checkout (039, specs/kiosk-w4.md §8.1, LD-72 on payment only): the kiosk's pure
// rules (pay buttons, suggestions, idle deadlines, what the diner sees of an attempt, the settle
// codes), the checkout's next step, the input schemas, and the device helpers.
import { describe, expect, it, vi } from "vitest";
import {
  KIOSK_IDLE,
  KIOSK_LIMITS,
  KIOSK_SETTLE_CODES,
  idleDeadline,
  kioskLineInput,
  kioskChargeFit,
  kioskOrderInput,
  kioskPaymentState,
  kioskRejectReason,
  kioskSettleCode,
  maskTypedPhone,
  payButtons,
  pickSuggestions,
  stationCardOff,
  suggestionsInput,
  type KioskCheckoutView,
} from "../shared/kiosk";
import { cardOffText } from "../src/features/public/KioskSettings";
import { kioskReportTiles } from "../src/features/public/KioskReport";
import { moneyFormatter } from "../src/features/menu/format";
import {
  afterCancel,
  cancelsOnReset,
  checkoutIdle,
  memberLookupOpen,
  stepFor,
  terminalExits,
  type KioskStep,
} from "../src/features/public/kiosk/KioskCheckout";
import { cartInputs } from "../src/features/public/DinerApp";
import { createIdleController } from "../src/features/public/kioskIdle";
import { priceCart } from "../shared/service";
import {
  keepAwake,
  viewportClass,
  watchDevice,
} from "../src/features/public/kiosk/kioskDevice";
import kiosk from "../src/i18n/kiosk";
import { resolveChoices } from "../src/features/payments/attempt-text";
import type { AttemptView } from "../shared/payments";
import type { ExceptionRow } from "../shared/reports";
import {
  exceptionDetail,
  exceptionReason,
} from "../src/features/reports/exception-text";
import { strings, translateError } from "../src/i18n";
import {
  acceptInput,
  holdActions,
  inboxActions,
  kioskChargingExits,
  kioskInboxState,
  rejectInput,
  type InboxHold,
} from "../shared/public-ordering";

const id = () => crypto.randomUUID();

describe("pay buttons (§2.5)", () => {
  const base = {
    selfCheckout: true,
    card: true,
    paymentMode: "card_and_counter" as const,
    attempts: 0,
    failedOnce: false,
  };
  it("card and counter; card_first hides the counter until a card failure; counter mode never offers card", () => {
    expect(payButtons(base)).toEqual({ card: true, counter: true });
    expect(payButtons({ ...base, paymentMode: "card_first" })).toEqual({
      card: true,
      counter: false,
    });
    expect(
      payButtons({ ...base, paymentMode: "card_first", failedOnce: true }),
    ).toEqual({ card: true, counter: true });
    expect(payButtons({ ...base, paymentMode: "counter" })).toEqual({
      card: false,
      counter: true,
    });
  });
  it("no card without self-checkout, without a card reader, or after 3 attempts (then the counter shows)", () => {
    expect(payButtons({ ...base, selfCheckout: false })).toEqual({
      card: false,
      counter: true,
    });
    expect(payButtons({ ...base, card: false })).toEqual({
      card: false,
      counter: true,
    });
    expect(
      payButtons({ ...base, attempts: KIOSK_LIMITS.attempts - 1 }).card,
    ).toBe(true);
    expect(
      payButtons({
        ...base,
        paymentMode: "card_first",
        attempts: KIOSK_LIMITS.attempts,
      }),
    ).toEqual({ card: false, counter: true });
  });
});

describe("suggestions (§2.8)", () => {
  const [a, b, c, d, e, f, g, h] = Array.from({ length: 8 }, id);
  it("keeps order, skips the cart, the unsellable and the source, at most 6", () => {
    const sellable = new Set([a, b, c, d, e, f, g, h]);
    expect(
      pickSuggestions([a, b, c], {
        inCart: new Set([b]),
        sellable,
        exclude: c,
      }),
    ).toEqual([a]);
    expect(
      pickSuggestions([a, b, c, d, e, f, g, h], {
        inCart: new Set(),
        sellable,
      }),
    ).toHaveLength(6);
    expect(
      pickSuggestions([a, a, b], { inCart: new Set(), sellable: new Set([b]) }),
    ).toEqual([b]);
    expect(
      pickSuggestions([a, b, c, d, e], { inCart: new Set(), sellable, max: 4 }),
    ).toEqual([a, b, c, d]);
  });
  it("the save refuses duplicates and more than the cart's 6", () => {
    expect(
      suggestionsInput.safeParse({
        operationId: id(),
        expectedVersion: 0,
        productIds: [a, a],
      }).success,
    ).toBe(false);
    expect(
      suggestionsInput.safeParse({
        operationId: id(),
        expectedVersion: 0,
        productIds: [a, b, c, d, e, f, g],
      }).success,
    ).toBe(false);
  });
});

describe("idle (§2.12, WCAG 2.2.1)", () => {
  it("a cart warns at 70 s and resets at 95 s: at least 20 s to answer", () => {
    const d = idleDeadline("menu", { cartEmpty: false });
    expect(d).toEqual({ warnAt: 70_000, resetAt: 95_000 });
    expect(d.resetAt! - d.warnAt!).toBeGreaterThanOrEqual(20_000);
  });
  it("charging suspends the reset for at most 5 minutes; pay 120 s; done 30 s paid, 20 s at the counter", () => {
    expect(idleDeadline("charging", { cartEmpty: false })).toEqual({
      warnAt: null,
      resetAt: 300_000,
    });
    expect(idleDeadline("pay", { cartEmpty: false }).resetAt).toBe(120_000);
    expect(idleDeadline("done_paid", { cartEmpty: true }).resetAt).toBe(30_000);
    expect(idleDeadline("done_counter", { cartEmpty: true }).resetAt).toBe(
      20_000,
    );
    expect(idleDeadline("welcome", { cartEmpty: true })).toEqual({
      warnAt: null,
      resetAt: null,
    });
    expect(
      KIOSK_IDLE.chargeTimeoutMs + KIOSK_IDLE.inProgressExtraMs,
    ).toBeLessThanOrEqual(KIOSK_IDLE.chargeSuspendMaxMs);
  });
  it("KIOSK-UX-05: «¿Para aquí…?», pay, declined and unavailable ask «¿Sigues ahí?» 25 s before the 120 s reset", () => {
    const steps: KioskStep[] = [
      "fulfillment",
      "pay",
      "declined",
      "unavailable",
    ];
    for (const step of steps) {
      const d = checkoutIdle(step);
      expect(d, step).toEqual({ warnAt: 95_000, resetAt: 120_000 });
      expect(d.resetAt! - d.warnAt!, step).toBeGreaterThanOrEqual(20_000);
    }
    expect(checkoutIdle("paid")).toEqual({ warnAt: null, resetAt: 30_000 });
    for (const step of ["paidNoOrder", "askCounter"] as KioskStep[])
      expect(checkoutIdle(step), step).toEqual({
        warnAt: null,
        resetAt: 20_000,
      });
    // Charging and «sigue procesando» run on the poll's clock; the counter code on KioskDone's.
    for (const step of [
      "submitting",
      "charging",
      "still",
      "counter",
    ] as KioskStep[])
      expect(checkoutIdle(step), step).toEqual({ warnAt: null, resetAt: null });
  });
  it("KIOSK-UX-05: on the pay screen the warning comes at 95 s, a touch re-arms it, the reset at 120 s", () => {
    vi.useFakeTimers();
    try {
      const { warnAt, resetAt } = checkoutIdle("pay");
      const onWarn = vi.fn();
      const onReset = vi.fn();
      const c = createIdleController({
        warnAfterMs: warnAt,
        resetAfterMs: resetAt!,
        onWarn,
        onReset,
      });
      vi.advanceTimersByTime(94_999);
      expect(onWarn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onWarn).toHaveBeenCalledTimes(1);
      c.activity(); // «Sigo aquí»
      vi.advanceTimersByTime(119_999);
      expect(onWarn).toHaveBeenCalledTimes(2);
      expect(onReset).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onReset).toHaveBeenCalledTimes(1);
      c.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what the diner sees of a charge (critic R9/R11)", () => {
  it("maps every payments state", () => {
    expect(kioskPaymentState(null)).toBe("none");
    for (const s of ["created", "sending", "pending", "unknown"])
      expect(kioskPaymentState(s)).toBe("pending");
    expect(kioskPaymentState("approved")).toBe("approved");
    expect(kioskPaymentState("settled")).toBe("settled");
    expect(kioskPaymentState("declined")).toBe("declined");
    expect(kioskPaymentState("cancelled")).toBe("cancelled");
    expect(kioskPaymentState("dismissed")).toBe("cancelled");
    expect(kioskPaymentState("expired")).toBe("expired");
    expect(kioskPaymentState("review")).toBe("review");
  });
  it("settle refusals become kiosk_settle_* codes; unknown codes are 'other'", () => {
    expect(kioskSettleCode("unavailable")).toBe("kiosk_settle_unavailable");
    expect(kioskSettleCode("public_hold_price_changed")).toBe(
      "kiosk_settle_price_changed",
    );
    expect(kioskSettleCode("invalid_modifier")).toBe(
      "kiosk_settle_invalid_modifier",
    );
    expect(kioskSettleCode("insufficient_stock")).toBe(
      "kiosk_settle_insufficient_stock",
    );
    expect(kioskSettleCode("pro_required")).toBe("kiosk_settle_pro_required");
    expect(kioskSettleCode("public_order_expired")).toBe(
      "kiosk_settle_hold_closed",
    );
    expect(kioskSettleCode("whatever")).toBe("kiosk_settle_other");
    for (const c of KIOSK_SETTLE_CODES)
      expect(kiosk.errors[c]?.[0]).toBeTruthy();
  });
});

describe("the checkout's next step while charging", () => {
  const view = (
    o: Partial<KioskCheckoutView> & {
      state?: KioskCheckoutView["payment"]["state"];
    },
  ): KioskCheckoutView => ({
    label: "K-14",
    holdState: "pending",
    orderNumber: null,
    total: 24500,
    paymentChoice: "card",
    payment: {
      state: o.state ?? "pending",
      attempts: 1,
      cancelRequested: false,
      amount: 24500,
    },
    paid: false,
    // As server/kiosk-diner.ts checkoutView sends it: only a review is "paid, no order"
    // (KIOSK-MONEY-2, KIOSK-UX-09).
    paidNoOrder: o.state === "review",
    folio: null,
    selfInvoiceCode: null,
    loyalty: null,
    joinOffer: null,
    ...o,
  });
  it("paid, approved without an order, declined (also after the reader held it: retry, counter or cancel), else keep polling", () => {
    expect(stepFor(view({ paid: true, state: "settled" }), "charging")).toBe(
      "paid",
    );
    expect(
      stepFor(view({ paidNoOrder: true, state: "review" }), "charging"),
    ).toBe("paidNoOrder");
    expect(view({ state: "review" }).paidNoOrder).toBe(true);
    expect(stepFor(view({ state: "review" }), "charging")).toBe("paidNoOrder");
    // Approved is the short step before the settle: keep polling.
    expect(view({ state: "approved" }).paidNoOrder).toBe(false);
    expect(stepFor(view({ state: "declined" }), "charging")).toBe("declined");
    expect(stepFor(view({ state: "cancelled" }), "charging")).toBe("declined");
    // KIOSK-UX-03: an attempt that ended without money during «La terminal sigue procesando»
    // offers retry, «Pagar en caja» or cancel, never a dead end.
    for (const state of ["declined", "cancelled", "expired"] as const)
      expect(stepFor(view({ state }), "still"), state).toBe("declined");
    expect(stepFor(view({ state: "pending" }), "still")).toBe(null);
    expect(stepFor(view({ paid: true, state: "settled" }), "still")).toBe(
      "paid",
    );
    expect(stepFor(view({ state: "pending" }), "charging")).toBe(null);
    expect(stepFor(view({ state: "approved" }), "charging")).toBe(null);
  });

  it("the terminal screens' exits follow payments' cancel rules (KIOSK-UX-03)", () => {
    const live = view({ state: "pending" });
    const asked = view({
      state: "pending",
      payment: {
        state: "pending",
        attempts: 1,
        cancelRequested: true,
        amount: 24500,
      },
    });
    // «Cancelar cobro» only after the offer delay, while the attempt is live and not yet asked.
    expect(terminalExits("charging", live, false)).toEqual({
      cancel: false,
      help: false,
    });
    expect(terminalExits("charging", live, true)).toEqual({
      cancel: true,
      help: false,
    });
    // Once a cancel was requested the reader may still take the card: help, no second cancel.
    expect(terminalExits("charging", asked, true)).toEqual({
      cancel: false,
      help: true,
    });
    // Approved (the settle is coming), settled or final: nothing to cancel, keep polling.
    for (const state of [
      "approved",
      "settled",
      "review",
      "declined",
      "cancelled",
      "expired",
      "none",
    ] as const)
      expect(terminalExits("charging", view({ state }), true), state).toEqual({
        cancel: false,
        help: false,
      });
    expect(terminalExits("charging", null, true)).toEqual({
      cancel: false,
      help: false,
    });
    // «La terminal sigue procesando» always has «Pedir ayuda en caja».
    expect(terminalExits("still", asked, true)).toEqual({
      cancel: false,
      help: true,
    });
    for (const step of ["pay", "declined", "askCounter", "paid"] as const)
      expect(terminalExits(step, live, true), step).toEqual({
        cancel: false,
        help: false,
      });
    // A withdrawn charge offers retry, counter or cancel; a refused or pending cancel keeps the
    // guest on «sigue procesando» while polling; a final one is shown by the next sync.
    expect(afterCancel("withdrawn")).toBe("declined");
    expect(afterCancel("in_progress")).toBe("still");
    expect(afterCancel("pending_cancel")).toBe("still");
    expect(afterCancel("already_final")).toBe(null);
  });

  it("a reset from the pay, declined or unavailable screens cancels only an unpaid card checkout with no attempt live or approved (KIOSK-MONEY-3)", () => {
    for (const step of ["pay", "declined", "unavailable"] as const) {
      for (const state of ["none", "declined", "cancelled", "expired"] as const)
        expect(cancelsOnReset(step, view({ state })), `${step} ${state}`).toBe(
          true,
        );
      // A choice not made yet is the same walk-away.
      expect(
        cancelsOnReset(step, view({ state: "none", paymentChoice: null })),
      ).toBe(true);
      // Payments may still take it, or took it: never cancelled from the kiosk.
      for (const state of ["pending", "approved", "review", "settled"] as const)
        expect(cancelsOnReset(step, view({ state })), `${step} ${state}`).toBe(
          false,
        );
      expect(
        cancelsOnReset(step, view({ state: "declined", paid: true })),
      ).toBe(false);
      // «Pagar en caja»: the counter's hold now.
      expect(
        cancelsOnReset(
          step,
          view({ state: "declined", paymentChoice: "counter" }),
        ),
      ).toBe(false);
      // Already decided, or never created.
      for (const holdState of ["accepted", "cancelled", "expired"] as const)
        expect(cancelsOnReset(step, view({ state: "none", holdState }))).toBe(
          false,
        );
      expect(cancelsOnReset(step, null)).toBe(false);
    }
    // The other screens never cancel on reset (charging, the counter code, paid, ask at counter).
    for (const step of [
      "fulfillment",
      "submitting",
      "charging",
      "still",
      "askCounter",
      "paid",
      "paidNoOrder",
      "counter",
    ] as const)
      expect(cancelsOnReset(step, view({ state: "declined" })), step).toBe(
        false,
      );
  });
});

describe("«Soy del club» only while the member token still travels (KIOSK-UX-02, critic R20)", () => {
  it("on the menu and at «¿Para aquí o para llevar?»; never once the hold is placed", () => {
    expect(memberLookupOpen("menu", null)).toBe(true);
    expect(memberLookupOpen("checkout", "fulfillment")).toBe(true);
    for (const step of [
      "submitting",
      "pay",
      "charging",
      "declined",
      "unavailable",
      "still",
      "askCounter",
      "paid",
      "paidNoOrder",
      "counter",
    ] satisfies KioskStep[])
      expect(memberLookupOpen("checkout", step), step).toBe(false);
    // Before the checkout reports its first screen, and on the other views.
    expect(memberLookupOpen("checkout", null)).toBe(false);
    expect(memberLookupOpen("kiosk-done", null)).toBe(false);
    expect(memberLookupOpen("status", null)).toBe(false);
  });
});

describe("why a station takes no card, on Configuración's row (KIOSK-UX-10, critic R14)", () => {
  const ready = {
    enabled: true,
    paymentMode: "card_and_counter" as const,
    paired: true,
    till: "open" as const,
    terminal: { usable: true, provider: "clip" as const },
    providers: {
      mercadopago: { enabled: false, reason: "worker_not_configured" },
      clip: { enabled: true },
    },
  };
  it("kioskState's order: switch, tablet, till, mode, terminal, then the terminal's provider", () => {
    expect(stationCardOff(ready)).toBe(null);
    expect(stationCardOff({ ...ready, enabled: false, paired: false })).toEqual(
      { reason: "disabled" },
    );
    expect(stationCardOff({ ...ready, paired: false, till: "none" })).toEqual({
      reason: "unbound",
    });
    expect(stationCardOff({ ...ready, till: "none" })).toEqual({
      reason: "no_till",
    });
    expect(
      stationCardOff({ ...ready, till: "closed", paymentMode: "counter" }),
    ).toEqual({ reason: "till_closed" });
    expect(stationCardOff({ ...ready, paymentMode: "counter" })).toEqual({
      reason: "mode",
    });
    expect(stationCardOff({ ...ready, terminal: null })).toEqual({
      reason: "no_terminal",
    });
    // Inactive, archived or manual: the select shows «Sin terminal», the row says why.
    expect(
      stationCardOff({
        ...ready,
        terminal: { usable: false, provider: "clip" },
      }),
    ).toEqual({ reason: "no_terminal" });
    expect(
      stationCardOff({
        ...ready,
        terminal: { usable: true, provider: "mercadopago" },
      }),
    ).toEqual({
      reason: "provider",
      provider: "mercadopago",
      detail: "worker_not_configured",
    });
    expect(
      stationCardOff({
        ...ready,
        providers: { ...ready.providers, clip: { enabled: false } },
      }),
    ).toEqual({
      reason: "provider",
      provider: "clip",
      detail: "not_connected",
    });
  });
  it("the row's text names the cause", () => {
    expect(cardOffText("es", null, "")).toBe(null);
    expect(cardOffText("es", { reason: "till_closed" }, "Caja mostrador")).toBe(
      "El kiosco no cobra con tarjeta: la caja Caja mostrador está cerrada.",
    );
    expect(
      cardOffText(
        "es",
        { reason: "provider", provider: "clip", detail: "not_connected" },
        "",
      ),
    ).toBe("El kiosco no cobra con tarjeta: Clip no está conectado.");
    expect(
      cardOffText(
        "es",
        {
          reason: "provider",
          provider: "mercadopago",
          detail: "worker_not_configured",
        },
        "",
      ),
    ).toBe(
      "El kiosco no cobra con tarjeta: Mercado Pago no está activo en este servidor.",
    );
    for (const reason of [
      "disabled",
      "unbound",
      "no_till",
      "mode",
      "no_terminal",
    ] as const)
      expect(cardOffText("en", { reason }, ""), reason).toMatch(
        /^The kiosk doesn't take cards: .+\.$/,
      );
  });
});

describe("Excepciones rows of a kiosk charge (KIOSK-OPS-5)", () => {
  const row = (kind: string, reasonCode: string | null, detail: object) =>
    ({
      kind,
      reasonCode,
      note: "",
      amount: 3500,
      orderId: null,
      detail,
    }) as unknown as ExceptionRow;
  const kioskHold = {
    holdChannel: "kiosk",
    holdNumber: 14,
    terminal: "Clip Entrada",
  };
  it("name the hold, and the review says why the charge could not become the order", () => {
    const review = row(
      "terminal_attempt_review",
      "kiosk_settle_unavailable",
      kioskHold,
    );
    expect(exceptionDetail(review, "es", String)).toBe(
      "Kiosco · K-14 · Clip Entrada",
    );
    expect(exceptionDetail(review, "en", String)).toBe(
      "Kiosk · K-14 · Clip Entrada",
    );
    expect(exceptionReason(review, "es")).toBe(
      translateError("kiosk_settle_unavailable", "es"),
    );
    expect(exceptionReason(review, "es")).not.toBe(strings.es.error);
    expect(
      exceptionDetail(
        row("terminal_attempt_dismissed", "refunded_at_provider", {
          ...kioskHold,
          resolution: "refunded_at_provider",
        }),
        "es",
        String,
      ),
    ).toMatch(/^Kiosco · K-14 · Clip Entrada · /);
    for (const kind of [
      "terminal_attempt_unknown_open",
      "terminal_attempt_late_approval",
    ])
      expect(exceptionDetail(row(kind, null, kioskHold), "es", String)).toMatch(
        /^Kiosco · K-14 · Clip Entrada/,
      );
    // A POS charge (an order target) reads as before; a payments review code stays out of Motivo.
    expect(
      exceptionDetail(
        row("terminal_attempt_review", "payments_amount_mismatch", {
          holdChannel: null,
          holdNumber: null,
          terminal: "Clip Caja",
        }),
        "es",
        String,
      ),
    ).toBe("Clip Caja");
    expect(
      exceptionReason(
        row("terminal_attempt_review", "payments_amount_mismatch", {}),
        "es",
      ),
    ).toBe("");
  });
});

describe("a kiosk hold in the staff inbox (KIOSK-UX-04, KIOSK-MONEY-3)", () => {
  const kiosk = (
    o: Partial<NonNullable<InboxHold["kiosk"]>>,
  ): NonNullable<InboxHold["kiosk"]> => ({
    paymentChoice: null,
    attemptId: null,
    charging: false,
    unknown: false,
    review: null,
    ...o,
  });
  const review = {
    attemptId: "a",
    code: "kiosk_settle_unavailable",
    amount: 4500,
    terminalLabel: "Clip",
    provider: "clip" as const,
  };
  it("KIOSK-MONEY-4: a manager cancels a charge payments may still withdraw and resolves an unknown one; other roles get neither", () => {
    const live = kiosk({
      paymentChoice: "card",
      attemptId: "a",
      charging: true,
    });
    const unknown = { ...live, unknown: true };
    for (const role of ["owner", "manager"]) {
      expect(kioskChargingExits(live, role), role).toEqual({
        cancel: true,
        resolve: false,
      });
      expect(kioskChargingExits(unknown, role), role).toEqual({
        cancel: false,
        resolve: true,
      });
      expect(
        kioskChargingExits(kiosk({ paymentChoice: "card" }), role),
      ).toEqual({ cancel: false, resolve: false });
    }
    for (const role of ["cashier", "server"])
      for (const k of [live, unknown])
        expect(kioskChargingExits(k, role), role).toEqual({
          cancel: false,
          resolve: false,
        });
  });
  it("only «Pagar en caja» keeps Accept; a guest still at the kiosk or an abandoned card checkout is pay-first", () => {
    expect(kioskInboxState(null)).toBe(null);
    expect(kioskInboxState(kiosk({ paymentChoice: "counter" }))).toBe(
      "counter",
    );
    expect(kioskInboxState(kiosk({}))).toBe("at_kiosk");
    expect(kioskInboxState(kiosk({ paymentChoice: "card" }))).toBe(
      "card_unpaid",
    );
    expect(
      kioskInboxState(kiosk({ paymentChoice: "card", charging: true })),
    ).toBe("charging");
    expect(kioskInboxState(kiosk({ paymentChoice: "card", review }))).toBe(
      "review",
    );
    for (const policy of ["accept", "pay_first"] as const) {
      // A QR hold and a pre-039 kiosk hold: the policy's own actions.
      expect(inboxActions({ policy, kiosk: null }, "cashier", 4500)).toEqual(
        holdActions(policy, "cashier", 4500),
      );
      expect(
        inboxActions(
          { policy, kiosk: kiosk({ paymentChoice: "counter" }) },
          "cashier",
          4500,
        ),
      ).toEqual(holdActions(policy, "cashier", 4500));
      for (const k of [kiosk({}), kiosk({ paymentChoice: "card" })]) {
        expect(inboxActions({ policy, kiosk: k }, "cashier", 4500)).toEqual({
          accept: false,
          payAndSend: true,
          override: false,
        });
        // The manager's exception stays.
        expect(inboxActions({ policy, kiosk: k }, "manager", 4500)).toEqual({
          accept: false,
          payAndSend: true,
          override: true,
        });
        // Nothing to collect on a free order.
        expect(inboxActions({ policy, kiosk: k }, "cashier", 0).accept).toBe(
          true,
        );
      }
    }
    // Under the default policy a plain «Aceptar» would have fired the unpaid order.
    expect(holdActions("accept", "cashier", 4500).accept).toBe(true);
  });
});

describe("the kiosk cart", () => {
  it("a line added from a suggestion prices like any other (its origin is attribution only), so it never blocks the cart", () => {
    const productId = id();
    const catalog = [
      {
        id: productId,
        name: { es: "Papas de prueba", en: "Test fries" },
        category: { es: "Acompañantes", en: "Sides" },
        categoryId: id(),
        price: 4500,
        available: true,
        station: "kitchen",
        groups: [],
        cost: null,
        recipe: [],
        version: 1,
      },
    ] as never;
    const lines = [
      {
        id: id(),
        productId,
        quantity: 1,
        options: [],
        origin: "suggestion" as const,
      },
    ];
    expect(cartInputs(lines)[0]).not.toHaveProperty("origin");
    const priced = priceCart(cartInputs(lines), catalog, false);
    expect(priced.blocked).toBe(false);
    expect(priced.total).toBe(4500);
    // The raw line would not price: quote's line input is strict.
    expect(
      priceCart(
        lines.map((l) => ({ ...l, note: "" })),
        catalog,
        false,
      ).blocked,
    ).toBe(true);
  });
});

describe("inputs", () => {
  const line = { id: id(), productId: id(), quantity: 1, options: [] };
  it("a line may say it came from a suggestion; nothing else", () => {
    expect(
      kioskLineInput.safeParse({ ...line, origin: "suggestion" }).success,
    ).toBe(true);
    expect(kioskLineInput.safeParse({ ...line, origin: "ai" }).success).toBe(
      false,
    );
    expect(kioskLineInput.safeParse({ ...line, note: "x" }).success).toBe(
      false,
    );
  });
  it("the order takes fulfillment (takeaway by default) and refuses control and bidi characters in the name", () => {
    const body = {
      operationId: id(),
      statusKey: "A".repeat(22),
      lines: [line],
      expectedTotal: 100,
    };
    expect(kioskOrderInput.parse(body).fulfillment).toBe("to_go");
    expect(
      kioskOrderInput.safeParse({ ...body, fulfillment: "delivery" }).success,
    ).toBe(false);
    expect(kioskOrderInput.safeParse({ ...body, name: "Ana‮" }).success).toBe(
      false,
    );
  });
  it("the phone is never echoed in full", () => {
    expect(maskTypedPhone("5555550123")).toBe("•• •• •• 01 23");
    expect(maskTypedPhone("55")).toBe("•• •• ••");
  });
});

describe("a kiosk charge approved without an order (critic R13)", () => {
  const review = (o: Partial<AttemptView> = {}): AttemptView => ({
    id: "a1",
    state: "review",
    target: "kiosk_hold",
    origin: "kiosk",
    orderId: null,
    holdId: "h1",
    orderNumber: null,
    holdLabel: "Kiosco · K-14",
    terminalId: "t1",
    terminalLabel: "Clip Kiosco",
    provider: "clip",
    amount: 24500,
    tip: 0,
    paidAmount: 24500,
    providerReference: "ref-ficticia-1",
    providerStatus: "completed",
    cardType: "credit_card",
    cardBrand: "visa",
    cardLast4: "4242",
    errorCode: "kiosk_settle_unavailable",
    cancelRequested: false,
    resolution: null,
    createdAt: "2026-10-09T18:00:00.000Z",
    decidedAt: null,
    ...o,
  });
  it("the hold's total against the charge: no partial refund, a total above it leaves a rest", () => {
    expect(kioskChargeFit(null, 24500)).toEqual({ kind: "unknown" });
    expect(kioskChargeFit(20000, 24500)).toEqual({
      kind: "below",
      missing: 4500,
    });
    expect(kioskChargeFit(24500, 24500)).toEqual({ kind: "fits", rest: 0 });
    expect(kioskChargeFit(26000, 24500)).toEqual({ kind: "fits", rest: 1500 });
  });
  it("from its inbox card a manager accepts with the charge or rejects and refunds; a cashier only retries; the banner keeps payments' own outcomes", () => {
    const manager = { manager: true, viaHold: true };
    expect(resolveChoices(review(), manager)).toEqual([
      "kiosk_accept",
      "kiosk_reject",
    ]);
    expect(
      resolveChoices(
        review({ errorCode: "payments_refunded_before_settle" }),
        manager,
      ),
    ).toEqual(["kiosk_reject"]);
    expect(resolveChoices(review(), { manager: false, viaHold: true })).toEqual(
      [],
    );
    expect(resolveChoices(review(), { manager: true, viaHold: false })).toEqual(
      ["record", "refunded_at_provider"],
    );
    expect(
      resolveChoices(review({ target: "order", holdId: null }), manager),
    ).toEqual(["record", "refunded_at_provider"]);
  });
  it("an item that ran out rejects as unavailable; anything else as other", () => {
    expect(kioskRejectReason("kiosk_settle_unavailable")).toBe("unavailable");
    expect(kioskRejectReason("kiosk_settle_insufficient_stock")).toBe(
      "unavailable",
    );
    expect(kioskRejectReason("kiosk_settle_price_changed")).toBe("other");
    expect(kioskRejectReason(null)).toBe("other");
  });
  it("the accept's payment is a union on method: the charge with a note and an optional counter rest; the reject's refund is attested", () => {
    const base = { operationId: id(), target: { kind: "new" } };
    const charge = {
      method: "attempt",
      attemptId: id(),
      note: "Revisado en Clip",
    };
    expect(acceptInput.parse({ ...base, payment: charge }).payment).toEqual({
      ...charge,
      rest: null,
    });
    const cash = { amount: 1500, received: 2000, method: "cash" };
    expect(
      acceptInput.parse({ ...base, payment: { ...charge, rest: cash } })
        .payment,
    ).toMatchObject({ rest: { ...cash, tip: 0 } });
    for (const bad of [
      { ...charge, note: "corta" },
      { ...charge, rest: { ...charge } },
      { ...charge, rest: { ...cash, method: "platform" } },
      { ...charge, amount: 100 },
    ])
      expect(acceptInput.safeParse({ ...base, payment: bad }).success).toBe(
        false,
      );
    // A counter payment parses exactly as before 039 (the accept's once() fingerprint).
    expect(acceptInput.parse({ ...base, payment: cash }).payment).toEqual({
      amount: 1500,
      tip: 0,
      received: 2000,
      method: "cash",
      externalConfirmed: false,
      reference: "",
    });
    const reject = { operationId: id(), reason: "unavailable" };
    expect("refund" in rejectInput.parse(reject)).toBe(false);
    const refund = { attemptId: id(), note: "Reembolso completo en Clip" };
    expect(
      rejectInput.safeParse({
        ...reject,
        refund: { ...refund, confirmed: true },
      }).success,
    ).toBe(true);
    expect(rejectInput.safeParse({ ...reject, refund }).success).toBe(false);
  });
});

describe("device helpers (feature-detected, §2.11)", () => {
  it("viewport class", () => {
    expect(viewportClass(1280, 800)).toBe("landscape");
    expect(viewportClass(800, 1280)).toBe("portrait");
  });
  it("a wake lock is requested while visible and again after the page was hidden; none without the API", async () => {
    const listeners: Record<string, () => void> = {};
    const doc = {
      visibilityState: "visible",
      addEventListener: (e: string, f: () => void) => (listeners[e] = f),
      removeEventListener: vi.fn(),
    } as unknown as Document;
    const release = vi.fn(async () => {});
    const request = vi.fn(async () => ({ release }));
    const stop = keepAwake(
      () => true,
      { wakeLock: { request } } as unknown as Navigator,
      doc,
    );
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    listeners.visibilitychange();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    stop();
    expect(keepAwake(() => true, {} as Navigator, doc)).toBeTypeOf("function");
  });
  it("a new build reloads only when the kiosk is idle on its welcome screen", async () => {
    vi.useFakeTimers();
    let commit = "aaa";
    let idle = false;
    const reload = vi.fn();
    const doc = { visibilityState: "visible" } as Document;
    const stop = watchDevice({
      everyMs: 60_000,
      beat: async () => {},
      idle: () => idle,
      reload,
      fetchVersion: async () => commit,
      doc,
    });
    await vi.advanceTimersByTimeAsync(0);
    commit = "bbb";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reload).not.toHaveBeenCalled();
    idle = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
    vi.useRealTimers();
  });
});

describe("Finanzas › Kiosco (039 §6.3, KIOSK-OPS-4, KIOSK-UX-19)", () => {
  it("shows the charges refunded at the provider, count and amount, after the resolved ones", () => {
    const tiles = kioskReportTiles(
      {
        orders: 9,
        paidAtKiosk: 7,
        paidAtCounter: 2,
        review: { open: 1, resolved: 3, refunded: 2, refundedAmount: 18550 },
        suggestions: { lines: 4, amount: 18000 },
      },
      "es",
      moneyFormatter("es", "MXN"),
    );
    expect(tiles).toEqual([
      ["Pedidos del kiosco", "9"],
      ["Pagados en el kiosco", "7"],
      ["Pagados en caja", "2"],
      ["Cobros por resolver", "1"],
      ["Cobros resueltos", "3"],
      ["Reembolsados en el proveedor", "2"],
      ["Importe reembolsado", "$185.50"],
      ["Líneas sugeridas aceptadas", "4"],
      ["Importe de sugerencias", "$180.00"],
    ]);
    expect(
      kioskReportTiles(
        {
          orders: 0,
          paidAtKiosk: 0,
          paidAtCounter: 0,
          review: { open: 0, resolved: 0, refunded: 0, refundedAmount: 0 },
          suggestions: { lines: 0, amount: 0 },
        },
        "en",
        moneyFormatter("en", "MXN"),
      ).slice(5, 7),
    ).toEqual([
      ["Refunded at the provider", "0"],
      ["Amount refunded", "MX$0.00"],
    ]);
  });
});
