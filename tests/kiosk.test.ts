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
  kioskOrderInput,
  kioskPaymentState,
  kioskSettleCode,
  maskTypedPhone,
  payButtons,
  pickSuggestions,
  suggestionsInput,
  type KioskCheckoutView,
} from "../shared/kiosk";
import { stepFor } from "../src/features/public/kiosk/KioskCheckout";
import {
  keepAwake,
  viewportClass,
  watchDevice,
} from "../src/features/public/kiosk/kioskDevice";
import kiosk from "../src/i18n/kiosk";

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
    paidNoOrder: false,
    folio: null,
    selfInvoiceCode: null,
    loyalty: null,
    joinOffer: null,
    ...o,
  });
  it("paid, approved without an order, declined (or after the reader held it: ask at the counter), else keep polling", () => {
    expect(stepFor(view({ paid: true, state: "settled" }), "charging")).toBe(
      "paid",
    );
    expect(
      stepFor(view({ paidNoOrder: true, state: "review" }), "charging"),
    ).toBe("paidNoOrder");
    expect(stepFor(view({ state: "declined" }), "charging")).toBe("declined");
    expect(stepFor(view({ state: "cancelled" }), "charging")).toBe("declined");
    expect(stepFor(view({ state: "expired" }), "still")).toBe("askCounter");
    expect(stepFor(view({ state: "pending" }), "charging")).toBe(null);
    expect(stepFor(view({ state: "approved" }), "charging")).toBe(null);
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
