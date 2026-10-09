// Payments (037) unit tests (spec §12.1, phase P1): shared/payments.ts, the platform branch of
// validatePayment, price lists in quote(), the CFDI payment form of platform and typed card
// tenders, offline evidence, fingerprint stability of pre-037 payloads, and the "no default to
// cash" source scan. Pure: no database, no network.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATTEMPT_TRANSITIONS,
  bpToPercent,
  cancelOutcome,
  estimateFee,
  LIVE_FOR_ORDER,
  LIVE_FOR_TERMINAL,
  minorToDecimal,
  PAYMENTS_LIMITS,
  percentToBp,
  PLATFORMS,
  platformLabel,
  platformReferenceProblem,
  TENDER_METHODS,
} from "../shared/payments";
import { listPrice, orderInput, quote, type Product } from "../shared/domain";
import { validatePayment, priceCart } from "../shared/service";
import { needsCardForm, paymentFormFor, PAYMENT_FORMS } from "../shared/cfdi";
import {
  offlinePayment,
  offlinePaymentIssue,
  paymentAttemptV1,
} from "../shared/offline-recovery";
import { holdPaymentInput } from "../shared/public-ordering";
import { methodOf, TENDER_METHODS as REPORT_METHODS } from "../shared/reports";
import { paymentInput } from "../server/orders";
import {
  buildEgresoRequest,
  buildGlobalRequests,
  buildInvoiceRequest,
} from "../server/cfdi/build";
import { errorText } from "../src/i18n";
import {
  cfdiPayload,
  ISSUER_POSTAL_CODE,
  RECEPTOR_MORAL,
  taxedLine,
} from "./fixtures/cfdi";

const migration = readFileSync(
  new URL("../migrations/037_payments.sql", import.meta.url),
  "utf8",
);

describe("shared/payments constants and helpers", () => {
  it("TENDER_METHODS is cash, external, platform, and reports use the same list (critic R15)", () => {
    expect([...TENDER_METHODS]).toEqual(["cash", "external", "platform"]);
    expect(REPORT_METHODS).toBe(TENDER_METHODS);
    expect(methodOf("platform")).toBe("platform");
    expect(() => methodOf("card")).toThrow("report_method_unknown");
    expect(() => methodOf(null)).toThrow("report_method_unknown");
  });

  it("estimateFee rounds half up in integer minor units, and null means not tracked", () => {
    expect(estimateFee(10_000, 418)).toBe(418);
    expect(estimateFee(23_600, 418)).toBe(986); // 986.48
    expect(estimateFee(1, 5000)).toBe(1); // exactly half: up
    expect(estimateFee(1, 4999)).toBe(0);
    expect(estimateFee(100_000_000, 2000)).toBe(20_000_000);
    expect(estimateFee(5000, null)).toBeNull();
    expect(estimateFee(0, 2500)).toBe(0);
  });

  it("minorToDecimal prints MXN minor units with two decimals", () => {
    expect(minorToDecimal(23_600)).toBe("236.00");
    expect(minorToDecimal(5)).toBe("0.05");
    expect(minorToDecimal(500)).toBe("5.00");
    expect(() => minorToDecimal(-1)).toThrow();
    expect(() => minorToDecimal(1.5)).toThrow();
  });

  it("percentToBp and bpToPercent round-trip the Configuración fields", () => {
    expect(percentToBp("4.18", PAYMENTS_LIMITS.feeBpMax)).toBe(418);
    expect(percentToBp("3,6", PAYMENTS_LIMITS.feeBpMax)).toBe(360);
    expect(percentToBp("30", PAYMENTS_LIMITS.commissionBpMax)).toBe(3000);
    expect(percentToBp("  ", PAYMENTS_LIMITS.feeBpMax)).toBeNull();
    expect(() => percentToBp("21", PAYMENTS_LIMITS.feeBpMax)).toThrow();
    expect(() => percentToBp("1.234", PAYMENTS_LIMITS.feeBpMax)).toThrow();
    expect(bpToPercent(418)).toBe("4.18");
    expect(bpToPercent(360)).toBe("3.60");
    expect(bpToPercent(3000)).toBe("30");
    expect(bpToPercent(null)).toBe("");
  });

  it("MP expiration is PT10M at the POS and PT5M at the kiosk (critic R10)", () => {
    expect(PAYMENTS_LIMITS.mpExpiration).toEqual({
      pos: "PT10M",
      kiosk: "PT5M",
    });
  });

  it("platformLabel names known platforms and a typed Otra", () => {
    expect(platformLabel("uber_eats", null, "es")).toBe("Uber Eats");
    expect(platformLabel("didi_food", null, "en")).toBe("DiDi Food");
    expect(platformLabel("other", " Pedidos Ya ", "es")).toBe("Pedidos Ya");
    expect(platformLabel("other", null, "es")).toBe("Otra");
  });

  it("the transition table equals 037's trigger, by actor", () => {
    const body = migration.slice(
      migration.indexOf("CREATE FUNCTION payment_attempts_transition()"),
    );
    const worker = body.slice(
      body.indexOf("WHEN w THEN"),
      body.indexOf("ELSE (OLD.state"),
    );
    const web = body.slice(
      body.indexOf("ELSE (OLD.state"),
      body.indexOf("END;"),
    );
    const pairs = (text: string) =>
      [...text.matchAll(/\('([a-z]+)','([a-z]+)'\)/g)].map((m) => [m[1], m[2]]);
    expect(pairs(worker)).toEqual(
      ATTEMPT_TRANSITIONS.worker.map((p) => [...p]),
    );
    expect(pairs(web)).toEqual(ATTEMPT_TRANSITIONS.web.map((p) => [...p]));
  });

  it("the live-state sets equal 037's partial unique indexes and the guards' SQL", () => {
    const states = (index: string) => {
      const at = migration.indexOf(`CREATE UNIQUE INDEX ${index}`);
      const where = migration.slice(at, migration.indexOf(";", at));
      return [
        ...where.slice(where.indexOf("state IN")).matchAll(/'([a-z]+)'/g),
      ].map((m) => m[1]);
    };
    expect(states("payment_attempts_terminal_live")).toEqual([
      ...LIVE_FOR_TERMINAL,
    ]);
    expect(states("payment_attempts_order_live")).toEqual([...LIVE_FOR_ORDER]);
    expect(states("payment_attempts_hold_live")).toEqual([...LIVE_FOR_ORDER]);
    const guards = readFileSync(
      new URL("../server/payments/guards.ts", import.meta.url),
      "utf8",
    );
    const lists = [...guards.matchAll(/state in \(([^)]*)\)/g)].map((m) =>
      [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]),
    );
    expect(lists.length).toBe(3);
    for (const list of lists) expect(list).toEqual([...LIVE_FOR_ORDER]);
  });

  it("cancelOutcome maps an attempt to the kiosk's synchronous answer (critic R10)", () => {
    expect(cancelOutcome({ state: "cancelled" })).toBe("withdrawn");
    expect(
      cancelOutcome({
        state: "pending",
        error_code: "payments_cancel_on_terminal",
      }),
    ).toBe("in_progress");
    expect(cancelOutcome({ state: "settled" })).toBe("already_final");
    expect(cancelOutcome({ state: "approved" })).toBe("already_final");
    expect(cancelOutcome({ state: "declined" })).toBe("already_final");
    expect(cancelOutcome({ state: "pending" })).toBe("pending_cancel");
    expect(cancelOutcome({ state: "unknown" })).toBe("pending_cancel");
  });

  it("every payments error code of the spec (§4.9, critic R11 names) has Spanish and English text", () => {
    const codes = [
      "payments_provider_unavailable",
      "payments_provider_not_configured",
      "payments_terminal_not_found",
      "payments_terminal_inactive",
      "payments_terminal_not_integrated",
      "payments_terminal_busy",
      "payments_terminal_limit",
      "payments_terminal_name_taken",
      "payments_device_taken",
      "payments_order_attempt_live",
      "payments_attempt_unresolved",
      "payments_attempts_live",
      "payments_amount_below_min",
      "payments_currency_unsupported",
      "payments_attempt_not_found",
      "payments_not_cancellable",
      "payments_cancel_on_terminal",
      "payments_not_approved",
      "payments_settle_order_changed",
      "payments_paid_short",
      "payments_allocation_changed",
      "payments_provider_mismatch",
      "payments_provider_says_paid",
      "payments_reference_required",
      "payments_note_required",
      "payments_platform_required",
      "payments_platform_disabled",
      "payments_platform_full_balance",
      "payments_platform_no_tip",
      "payments_platform_confirm_required",
      "payments_platform_refund_requires_batch",
      "payments_credentials_invalid_format",
      "payments_credentials_rejected",
      "payments_account_country",
      "payments_upload_unavailable",
      "payments_provider_unreachable",
      "payments_provider_rejected",
      "payments_terminal_offline",
      "payments_terminal_queue_busy",
      "payments_device_mode_rejected",
      "payments_clip_create_outcome_unknown",
      "payments_refunded_before_settle",
    ];
    for (const code of codes) {
      expect(errorText[code]?.[0]?.trim(), code).toBeTruthy();
      expect(errorText[code]?.[1]?.trim(), code).toBeTruthy();
    }
    expect(errorText.platform_refund_requires_batch).toBeUndefined();
    expect(errorText.clip_create_outcome_unknown).toBeUndefined();
  });
});

describe("validatePayment (PaymentDialog) platform and terminal branches", () => {
  const base = {
    amountText: "236",
    tipText: "",
    receivedText: "",
    reference: "",
    confirmed: false,
    due: 23_600,
    exponent: 2,
    drawerOpen: true,
    online: true,
  };
  it("a platform tender covers the whole balance, names its platform, has no tip and is confirmed", () => {
    const platform = { ...base, method: "platform" as const };
    expect(validatePayment(platform)).toMatchObject({
      ok: false,
      problem: { field: "platform", key: "payProblemPlatformRequired" },
    });
    expect(
      validatePayment({ ...platform, platform: "other", platformLabel: " " }),
    ).toMatchObject({ ok: false, problem: { key: "payProblemPlatformName" } });
    expect(
      validatePayment({ ...platform, platform: "rappi", amountText: "200" }),
    ).toMatchObject({
      ok: false,
      problem: { field: "amount", key: "payProblemPlatformFullBalance" },
    });
    expect(
      validatePayment({ ...platform, platform: "rappi", reference: "88123" }),
    ).toMatchObject({
      ok: false,
      problem: { field: "confirmed", key: "payProblemPlatformConfirm" },
    });
    expect(
      validatePayment({
        ...platform,
        platform: "rappi",
        confirmed: true,
        reference: "x".repeat(41),
      }),
    ).toMatchObject({
      ok: false,
      problem: { key: "payProblemPlatformReference" },
    });
    expect(
      validatePayment({
        ...platform,
        platform: "didi_food",
        tipText: "50",
        reference: " 4F2A ",
        confirmed: true,
      }),
    ).toEqual({
      ok: true,
      values: {
        amount: 23_600,
        tip: 0,
        received: 23_600,
        method: "platform",
        reference: "4F2A",
        confirmed: true,
        platform: "didi_food",
      },
    });
    expect(
      validatePayment({
        ...platform,
        platform: "other",
        platformLabel: " Pedidos Ya ",
        confirmed: true,
      }),
    ).toMatchObject({
      ok: true,
      values: { platform: "other", platformLabel: "Pedidos Ya" },
    });
  });
  it("LD-75 (PAYMENTS-SECURITY-1): Uber Eats, Rappi and DiDi need their order number; never a dine-in order; a platform with its own prices pays only its list's orders", () => {
    const ok = {
      ...base,
      method: "platform" as const,
      confirmed: true,
      reference: "4F2A",
    };
    for (const platform of ["uber_eats", "rappi", "didi_food"] as const) {
      for (const reference of ["", "  ", "x", "4F2A/3", "x".repeat(41)])
        expect(validatePayment({ ...ok, platform, reference })).toMatchObject({
          ok: false,
          problem: { field: "reference" },
        });
      expect(
        validatePayment({ ...ok, platform, reference: "#4F2A 1" }).ok,
      ).toBe(true);
    }
    // «Otra»'s number stays optional.
    expect(
      validatePayment({
        ...ok,
        platform: "other",
        platformLabel: "PedidosYa",
        reference: "",
      }).ok,
    ).toBe(true);
    expect(
      validatePayment({ ...ok, platform: "rappi", dineIn: true }),
    ).toMatchObject({
      ok: false,
      problem: { field: "platform", key: "payProblemPlatformDineIn" },
    });
    expect(
      validatePayment({ ...ok, platform: "rappi", pricePlatform: "didi_food" }),
    ).toMatchObject({
      ok: false,
      problem: { field: "platform", key: "payProblemPlatformPriceList" },
    });
    expect(
      validatePayment({ ...ok, platform: "rappi", platformHasPrices: true }),
    ).toMatchObject({
      ok: false,
      problem: { field: "platform", key: "payProblemPlatformNeedsPriceList" },
    });
    expect(
      validatePayment({
        ...ok,
        platform: "rappi",
        platformHasPrices: true,
        pricePlatform: "rappi",
      }).ok,
    ).toBe(true);
    expect(platformReferenceProblem("uber_eats", " 4F2A1 ")).toBeNull();
    expect(platformReferenceProblem("didi_food", "")).toBe(
      "payments_platform_reference_required",
    );
  });
  it("PAYMENTS-UX-4: with terminals to choose from, a card record names one (or «Otra terminal») deliberately", () => {
    const ext = {
      ...base,
      method: "external" as const,
      reference: "AUT-1",
      confirmed: true,
      terminalChoice: true,
    };
    expect(validatePayment({ ...ext, terminalId: undefined })).toMatchObject({
      ok: false,
      problem: { field: "terminal", key: "payProblemTerminalRequired" },
    });
    expect(validatePayment({ ...ext, terminalId: null })).toMatchObject({
      ok: true,
      values: { method: "external" },
    });
    expect(validatePayment({ ...ext, terminalChoice: false }).ok).toBe(true);
  });
  it("an external record carries its named terminal; cash never does", () => {
    const ext = validatePayment({
      ...base,
      method: "external",
      reference: "AUT-1",
      confirmed: true,
      terminalId: "6b0e0a4e-1b7a-4c5e-9d71-0d8d9f1f2a3b",
    });
    expect(ext).toMatchObject({
      ok: true,
      values: {
        method: "external",
        terminalId: "6b0e0a4e-1b7a-4c5e-9d71-0d8d9f1f2a3b",
      },
    });
    const other = validatePayment({
      ...base,
      method: "external",
      reference: "AUT-1",
      confirmed: true,
      terminalId: null,
    });
    expect(other.ok && "terminalId" in other.values).toBe(false);
    const cash = validatePayment({
      ...base,
      method: "cash",
      receivedText: "300",
      terminalId: "6b0e0a4e-1b7a-4c5e-9d71-0d8d9f1f2a3b",
    });
    expect(cash.ok && "terminalId" in cash.values).toBe(false);
  });
});

describe("platform price lists (LD-72)", () => {
  const taco: Product = {
    id: "6b0e0a4e-1b7a-4c5e-9d71-0d8d9f1f2a3b",
    name: { es: "Taco", en: "Taco" },
    category: { es: "Tacos", en: "Tacos" },
    price: 4500,
    available: true,
    station: "kitchen",
    groups: [
      {
        id: "7b0e0a4e-1b7a-4c5e-9d71-0d8d9f1f2a3b",
        name: { es: "Extra", en: "Extra" },
        min: 0,
        max: 1,
        options: [
          {
            id: "8b0e0a4e-1b7a-4c5e-9d71-0d8d9f1f2a3b",
            name: { es: "Queso", en: "Cheese" },
            price: 1000,
            available: true,
          },
        ],
      } as never,
    ],
    cost: null,
    version: 1,
    platformPrices: { uber_eats: 5900, rappi: 0 },
  };
  const line = (options: string[] = []) => ({
    id: "9b0e0a4e-1b7a-4c5e-9d71-0d8d9f1f2a3b",
    productId: taco.id,
    quantity: 2,
    options,
    note: "",
  });
  it("listPrice takes the platform price when set, else the POS price", () => {
    expect(listPrice(taco, null)).toBe(4500);
    expect(listPrice(taco, "uber_eats")).toBe(5900);
    expect(listPrice(taco, "rappi")).toBe(0);
    expect(listPrice(taco, "didi_food")).toBe(4500);
    expect(listPrice({ price: 100 }, "other")).toBe(100);
  });
  it("quote prices the base at the list and keeps POS modifier prices; no list = POS prices", () => {
    expect(quote([line()], [taco], true)[0].total).toBe(9000);
    expect(
      quote([line()], [taco], true, undefined, "uber_eats")[0],
    ).toMatchObject({
      unitPrice: 5900,
      total: 11_800,
    });
    expect(
      quote(
        [line([taco.groups[0].options[0].id])],
        [taco],
        true,
        undefined,
        "uber_eats",
      )[0].unitPrice,
    ).toBe(6900);
    expect(quote([line()], [taco], true, undefined, "didi_food")[0].total).toBe(
      9000,
    );
    expect(priceCart([line()], [taco], true, "uber_eats").total).toBe(11_800);
    expect(priceCart([line()], [taco], true).total).toBe(9000);
  });
  it("orderInput takes an optional price list with no default (older bodies parse unchanged)", () => {
    const body = {
      operationId: "9c0e0a4e-1b7a-4c5e-9d71-0d8d9f1f2a3b",
      lines: [line()],
      mode: "takeaway",
    };
    expect(Object.keys(orderInput.parse(body))).toEqual([
      "operationId",
      "lines",
      "mode",
      "tableId",
      "name",
      "note",
      "channel",
    ]);
    expect(
      orderInput.parse({ ...body, pricePlatform: "rappi" }).pricePlatform,
    ).toBe("rappi");
    expect(() =>
      orderInput.parse({ ...body, pricePlatform: "ubereats" }),
    ).toThrow();
  });
});

describe("fingerprint stability of pre-037 payloads (G9)", () => {
  const op = "9c0e0a4e-1b7a-4c5e-9d71-0d8d9f1f2a3b";
  it("paymentInput parses an old body to exactly the pre-037 shape (once() and recovery hashes)", () => {
    expect(
      JSON.stringify(
        paymentInput.parse({
          operationId: op,
          amount: 100,
          received: 100,
          method: "cash",
        }),
      ),
    ).toBe(
      `{"operationId":"${op}","amount":100,"tip":0,"received":100,"method":"cash","externalConfirmed":false,"reference":""}`,
    );
    expect(
      Object.keys(
        paymentAttemptV1.shape.payload.parse({
          operationId: op,
          amount: 100,
          tip: 0,
          received: 100,
          method: "external",
          externalConfirmed: true,
          reference: "A",
        }),
      ),
    ).toEqual([
      "operationId",
      "amount",
      "tip",
      "received",
      "method",
      "externalConfirmed",
      "reference",
    ]);
    expect(
      Object.keys(
        offlinePayment.parse({
          method: "cash",
          amount: 1,
          tip: 0,
          received: 1,
          reference: "",
          externalConfirmed: false,
        }),
      ),
    ).toEqual([
      "method",
      "amount",
      "tip",
      "received",
      "reference",
      "externalConfirmed",
    ]);
  });
  it("holdPaymentInput keeps its pre-037 key order and refuses platform (critic R13)", () => {
    expect(
      JSON.stringify(
        holdPaymentInput.parse({ amount: 1, received: 1, method: "cash" }),
      ),
    ).toBe(
      '{"amount":1,"tip":0,"received":1,"method":"cash","externalConfirmed":false,"reference":""}',
    );
    expect(() =>
      holdPaymentInput.parse({ amount: 1, received: 1, method: "platform" }),
    ).toThrow();
    expect(() =>
      holdPaymentInput.parse({
        amount: 1,
        received: 1,
        method: "cash",
        terminalId: op,
      }),
    ).toThrow();
    expect(
      holdPaymentInput.parse({
        amount: 1,
        received: 1,
        method: "external",
        externalConfirmed: true,
        reference: "A",
        terminalId: op,
      }),
    ).toMatchObject({ terminalId: op });
  });
});

describe("offline evidence per method (OFF-8, payments 037)", () => {
  const p = (o: object) => ({
    method: "platform",
    amount: 1000,
    tip: 0,
    received: 1000,
    reference: "",
    externalConfirmed: true,
    platform: "uber_eats",
    ...o,
  });
  it("offlinePaymentIssue judges cash, terminal and platform evidence; nothing defaults to cash", () => {
    expect(offlinePaymentIssue(p({}))).toBeNull();
    expect(offlinePaymentIssue(p({ platform: undefined }))).toBe(
      "payments_platform_required",
    );
    expect(offlinePaymentIssue(p({ platform: "other" }))).toBe(
      "payments_platform_required",
    );
    expect(
      offlinePaymentIssue(p({ platform: "other", platformLabel: "X" })),
    ).toBeNull();
    expect(offlinePaymentIssue(p({ externalConfirmed: false }))).toBe(
      "payments_platform_confirm_required",
    );
    expect(offlinePaymentIssue(p({ tip: 100, received: 1100 }))).toBe(
      "payments_platform_no_tip",
    );
    expect(offlinePaymentIssue(p({ received: 900 }))).toBe("invalid_input");
    expect(offlinePaymentIssue(p({ method: "cash", platform: "rappi" }))).toBe(
      "invalid_input",
    );
    expect(
      offlinePaymentIssue(
        p({ method: "cash", platform: undefined, terminalId: "x" }),
      ),
    ).toBe("invalid_input");
    expect(
      offlinePaymentIssue(
        p({
          method: "external",
          platform: undefined,
          reference: "A",
          terminalId: "x",
        }),
      ),
    ).toBeNull();
    expect(
      offlinePaymentIssue(p({ method: "card", platform: undefined })),
    ).toBe("invalid_input");
    expect(() => offlinePayment.parse(p({ received: 900 }))).toThrow();
  });
});

describe("CFDI FormaPago of platform and typed card tenders (§7.2, Q3/Q4)", () => {
  it("paymentFormFor: platform takes the restaurant's form (default 31); a typed card takes 04/28", () => {
    expect(PAYMENT_FORMS["31"]).toBe("Intermediario pagos");
    expect(PAYMENT_FORMS["03"]).toBe("Transferencia electrónica de fondos");
    const platform = [{ method: "platform", amount: 500 }];
    expect(paymentFormFor(platform, "04")).toBe("31");
    expect(paymentFormFor(platform, { card: "04" })).toBe("31");
    for (const form of ["31", "03", "04", "28"] as const)
      expect(paymentFormFor(platform, { card: "28", platform: form })).toBe(
        form,
      );
    expect(
      paymentFormFor(
        [{ method: "external", amount: 1, cardType: "credit" }],
        "28",
      ),
    ).toBe("04");
    expect(
      paymentFormFor(
        [{ method: "external", amount: 1, cardType: "debit" }],
        "04",
      ),
    ).toBe("28");
    expect(
      paymentFormFor(
        [{ method: "external", amount: 1, cardType: "prepaid" }],
        "04",
      ),
    ).toBe("28");
    // Mixed: the largest amount wins; ties take the earliest tender.
    expect(
      paymentFormFor(
        [
          { method: "cash", amount: 100 },
          { method: "platform", amount: 300 },
        ],
        { card: "04", platform: "03" },
      ),
    ).toBe("03");
    expect(
      paymentFormFor(
        [
          { method: "platform", amount: 100 },
          { method: "cash", amount: 100 },
        ],
        "04",
      ),
    ).toBe("31");
    expect(() => paymentFormFor([{ method: "card", amount: 1 }], "04")).toThrow(
      "cfdi_payment_method_unknown",
    );
  });
  it("needsCardForm only when an untyped card tender decides the form", () => {
    expect(needsCardForm([{ method: "platform", amount: 500 }], "31")).toBe(
      false,
    );
    expect(
      needsCardForm(
        [{ method: "external", amount: 500, cardType: "credit" }],
        "31",
      ),
    ).toBe(false);
    expect(needsCardForm([{ method: "external", amount: 500 }], "31")).toBe(
      true,
    );
    expect(
      needsCardForm(
        [
          { method: "platform", amount: 500 },
          { method: "external", amount: 100 },
        ],
        "31",
      ),
    ).toBe(false);
  });
  it("needsCardForm counts the restaurant's platform form (PAYMENTS-FISCAL-3 / MONEY-9)", () => {
    // cash 100, untyped card 60, platform 50: with 31 cash wins both ways; with 04 the platform
    // joins credit (04: 110 > 01: 100) but not debit (01 wins), so the card answer decides.
    const mixed = [
      { method: "cash", amount: 100 },
      { method: "external", amount: 60 },
      { method: "platform", amount: 50 },
    ];
    expect(needsCardForm(mixed, "31")).toBe(false);
    expect(needsCardForm(mixed, "04")).toBe(true);
    // cash 60, card 40, DiDi 50 with 28: credit -> 01 (60), debit -> 28 (90).
    expect(
      needsCardForm(
        [
          { method: "cash", amount: 60 },
          { method: "external", amount: 40 },
          { method: "platform", amount: 50 },
        ],
        "28",
      ),
    ).toBe(true);
  });
  const platformTicket = (folio = "A-000123") =>
    cfdiPayload({
      lines: [taxedLine(11_600, "iva16")],
      folio,
      payments: [{ method: "platform", amount: 11_600 }],
    });
  it("an individual invoice of a platform ticket uses the platform form", () => {
    const input = {
      docId: "0b6a1a8e-3f1e-4c55-9d1e-2f6d1c0a9b11",
      payload: platformTicket(),
      receptor: RECEPTOR_MORAL,
      settings: {
        conceptMode: "grouped" as const,
        conceptDescription: "Consumo de alimentos y bebidas",
      },
      issuerPostalCode: ISSUER_POSTAL_CODE,
      cardForm: "04" as const,
      timezone: "America/Mexico_City",
    };
    expect(buildInvoiceRequest(input).body.payment_form).toBe("31");
    expect(
      buildInvoiceRequest({ ...input, platformForm: "03" }).body.payment_form,
    ).toBe("03");
  });
  it("a global part takes the form of its largest ticket, platform included", () => {
    const ticket = (
      id: string,
      folio: string,
      method: "cash" | "platform",
      gross: number,
    ) => ({
      id,
      folio,
      groups: [
        {
          category: "iva16" as const,
          gross,
          tax: Math.round((gross * 16) / 116),
        },
      ],
      payments: [{ method, amount: gross }],
    });
    const parts = buildGlobalRequests({
      docIds: () => "0b6a1a8e-3f1e-4c55-9d1e-2f6d1c0a9b11",
      tickets: [
        ticket(
          "1b6a1a8e-3f1e-4c55-9d1e-2f6d1c0a9b11",
          "A-000001",
          "cash",
          1160,
        ),
        ticket(
          "2b6a1a8e-3f1e-4c55-9d1e-2f6d1c0a9b11",
          "A-000002",
          "platform",
          11_600,
        ),
      ],
      period: { periodicity: "month", months: "10", year: 2026 },
      issuerPostalCode: ISSUER_POSTAL_CODE,
      cardForm: "04",
      platformForm: "03",
    });
    expect(parts.map((p) => p.body.payment_form)).toEqual(["03"]);
  });
  it("the credit note of a platform refund uses the platform form, never 01", () => {
    const egreso = (
      method: string,
      platformForm?: "31" | "03",
      parentForm: string | null = "31",
    ) =>
      buildEgresoRequest({
        docId: "0b6a1a8e-3f1e-4c55-9d1e-2f6d1c0a9b11",
        folio: "A-000123",
        parent: {
          kind: "invoice",
          uuid: "39c85a3f-275b-4341-b259-e8971d9f8a94",
          receptor: RECEPTOR_MORAL,
          paymentForm: parentForm,
        },
        refund: {
          method,
          groups: [{ category: "iva16", gross: 5801, tax: 800 }],
        },
        issuerPostalCode: ISSUER_POSTAL_CODE,
        cardForm: "04",
        platformForm,
      }).body.payment_form;
    expect(egreso("platform")).toBe("31");
    // PAYMENTS-FISCAL-2: a parent stamped with a platform form keeps it on its credit note after
    // the setting changes (31 -> 03 and 03 -> 31), so the income and its refund match.
    expect(egreso("platform", "03")).toBe("31");
    expect(egreso("platform", "31", "03")).toBe("03");
    // A parent whose form is not a platform form (cash or card decided it) takes the setting.
    expect(egreso("platform", "03", "01")).toBe("03");
    expect(egreso("platform", "03", null)).toBe("03");
    expect(egreso("platform", undefined, "04")).toBe("31");
    expect(egreso("cash")).toBe("01");
    expect(egreso("external")).toBe("04");
    expect(() => egreso("card")).toThrow("cfdi_payment_method_unknown");
  });
});

describe("no reader defaults an unknown method to cash (spec §11.2)", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory()
        ? files(path)
        : /\.tsx?$/.test(name)
          ? [path]
          : [];
    });
  }
  it('server/ and shared/ have no `=== "external" ? … : "cash"` (or "01") mapping', () => {
    const offenders: string[] = [];
    for (const file of [...files("server"), ...files("shared")]) {
      const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
      if (
        /===\s*["']external["']\s*\?[^;:]{0,80}:\s*["'](cash|01)["']/.test(
          text,
        ) ||
        /!==\s*["']external["']\s*\?\s*["'](cash|01)["']/.test(text)
      )
        offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
  it("every platform code is a price list and a tender platform (one list)", () => {
    expect([...PLATFORMS]).toEqual([
      "uber_eats",
      "rappi",
      "didi_food",
      "other",
    ]);
  });
});
