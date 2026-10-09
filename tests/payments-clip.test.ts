// Clip PinPad adapter (spec §4.8, §12.1): pos-lite's 19 clip-terminal.test.ts cases ported with
// their intent kept (rule 5.2.1), in minor units, plus identity by reference, delete-by-serial and
// the unknown-create rule. Clip has no sandbox, so these pin the wire contract:
//   1. createPinPadPayment sends decimal pesos + serial_number_pos + reference (a cents scaffold
//      would ask the reader for 100× the bill);
//   2. a cancel Clip refuses is "not cancelled" (not thrown, not success): the attempt stays
//      pending instead of freeing an order the reader may still charge;
//   3. an undocumented status never maps to a final one: a false final frees the order for a
//      second charge.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelBySerial,
  cancelPinPadPayment,
  createPinPadPayment,
  getPinPadPayment,
  isKnownClipStatus,
  listPinPadDevices,
  mapClipPayment,
  mapClipStatus,
  stripNulChars,
  summarizeClipPayment,
  type ClipClient,
} from "../server/payments/worker/clip";
import { ProviderError } from "../server/payments/worker/http";

const BASE = "https://api.payclip.io/f2f/pinpad/v1";
const client: ClipClient = { baseUrl: BASE, apiKey: "test", secretKey: "test" };
const AUTH = `Basic ${Buffer.from("test:test").toString("base64")}`;

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(
    async () =>
      new Response(body === undefined ? "" : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}
const call = (fn: ReturnType<typeof mockFetch>, i = 0) =>
  fn.mock.calls[i] as unknown as [string, RequestInit];
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPinPadPayment: request shape", () => {
  it("sends decimal pesos, serial_number_pos and reference to /f2f/pinpad/v1/payment", async () => {
    const fetchMock = mockFetch(200, {
      pinpad_request_id: "pinpad-6a405173-c661-414a-9a8f-ecc77a9afe3f",
      reference: "ten-42-1",
      amount: "200.50",
      serial_number_pos: "P8220724000042",
    });
    const out = await createPinPadPayment(client, {
      amount: 20050,
      tip: 2000,
      reference: "ten-42-1",
      serial: "P8220724000042",
      webhookUrl: "https://app.example.com/api/payments/webhooks/clip/tok",
    });
    expect(out.pinpadRequestId).toBe(
      "pinpad-6a405173-c661-414a-9a8f-ecc77a9afe3f",
    );
    const [url, init] = call(fetchMock);
    expect(url).toBe(`${BASE}/payment`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(AUTH);
    const body = JSON.parse(String(init.body));
    expect(body.amount).toBe(200.5);
    expect(body.tip_amount).toBe(20);
    expect(body.serial_number_pos).toBe("P8220724000042");
    expect(body.reference).toBe("ten-42-1");
    expect(body.webhook_url).toBe(
      "https://app.example.com/api/payments/webhooks/clip/tok",
    );
    // A second tip screen on the reader would let the customer tip twice.
    expect(body.preferences.is_tip_enabled).toBe(false);
    expect(body.preferences.is_split_payment_enabled).toBe(false);
    // Legacy guessed field names must be gone.
    expect(body.pinpad_id).toBeUndefined();
    expect(body.external_reference).toBeUndefined();
  });

  it("omits tip_amount when there is no tip, and sends whole centavos", async () => {
    const fetchMock = mockFetch(200, { pinpad_request_id: "pinpad-x" });
    await createPinPadPayment(client, {
      amount: 10000,
      tip: 0,
      reference: "r",
      serial: "S1",
      webhookUrl: null,
    });
    const body = JSON.parse(String(call(fetchMock)[1].body));
    expect(body.amount).toBe(100);
    expect("tip_amount" in body).toBe(false);
    expect("webhook_url" in body).toBe(false);
  });

  it("surfaces the offline-reader error code from a 400 as payments_terminal_offline", async () => {
    mockFetch(400, {
      code: "PINPAD_TERMINAL_TIMEOUT_EXCEPTION",
      message: "Unable to connect to pinpad terminal.",
    });
    const err = await createPinPadPayment(client, {
      amount: 1000,
      tip: 0,
      reference: "r",
      serial: "S1",
      webhookUrl: null,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("payments_terminal_offline");
    expect((err as ProviderError).providerCode).toBe(
      "pinpad_terminal_timeout_exception",
    );
    expect((err as ProviderError).status).toBe(400);
    expect((err as ProviderError).retryable).toBe(false);
  });

  it("surfaces the Health Check ERR10_04 (reader off / app closed / mid-charge)", async () => {
    mockFetch(400, {
      code: "ERR10_04",
      name: "STORING PAYMENT - DEVICE UNAVAILABLE",
      message:
        "The Clip terminal is either offline, powered off, or the Pinpad application is closed",
    });
    const err = await createPinPadPayment(client, {
      amount: 1000,
      tip: 0,
      reference: "r",
      serial: "S1",
      webhookUrl: null,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("payments_terminal_offline");
    expect((err as ProviderError).providerCode).toBe("err10_04");
  });

  it("rejects a 200 without pinpad_request_id instead of storing undefined: the outcome is unknown", async () => {
    mockFetch(200, { amount: "10.00" });
    const err = await createPinPadPayment(client, {
      amount: 1000,
      tip: 0,
      reference: "r",
      serial: "S1",
      webhookUrl: null,
    }).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe(
      "payments_clip_create_outcome_unknown",
    );
  });

  it("a network failure or 5xx is retryable for the caller to treat as unknown (Clip has no idempotency key)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const err = (await createPinPadPayment(client, {
      amount: 1000,
      tip: 0,
      reference: "r",
      serial: "S1",
      webhookUrl: null,
    }).catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe("payments_provider_unreachable");
    expect(err.retryable).toBe(true);
  });
});

describe("getPinPadPayment", () => {
  it("queries by pinpadRequestId with the detail header", async () => {
    const fetchMock = mockFetch(200, {
      pinpad_request_id: "pinpad-1",
      status: "PENDING",
    });
    const payment = await getPinPadPayment(client, "pinpad-1");
    expect(payment?.status).toBe("PENDING");
    const [url, init] = call(fetchMock);
    expect(url).toBe(`${BASE}/payment?pinpadRequestId=pinpad-1`);
    expect(
      (init.headers as Record<string, string>)["Pinpad-Include-Detail"],
    ).toBe("true");
  });

  it("returns null on 404", async () => {
    mockFetch(404, { code: "NOT_FOUND" });
    expect(await getPinPadPayment(client, "pinpad-gone")).toBeNull();
  });
});

describe("cancelPinPadPayment: never claims success Clip did not give", () => {
  it("200 → cancelled", async () => {
    const fetchMock = mockFetch(200, { pinpad_request_id: "pinpad-1" });
    expect(await cancelPinPadPayment(client, "pinpad-1")).toEqual({
      cancelled: true,
    });
    const [url, init] = call(fetchMock);
    expect(url).toBe(`${BASE}/payment/pinpad-1`);
    expect(init.method).toBe("DELETE");
  });

  it("400 PAYMENT_REQUEST_ISSUE (reader already took it) → not cancelled, with code", async () => {
    mockFetch(400, {
      code: "PAYMENT_REQUEST_ISSUE",
      message:
        "The payment requested was removed or was taken successfully by CLIP POS",
    });
    expect(await cancelPinPadPayment(client, "pinpad-1")).toEqual({
      cancelled: false,
      code: "PAYMENT_REQUEST_ISSUE",
    });
  });

  it("5xx throws so the caller keeps the attempt pending", async () => {
    mockFetch(503, { code: "UNAVAILABLE" });
    await expect(
      cancelPinPadPayment(client, "pinpad-1"),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("delete by serial number uses /payment/serial-number/{serial} (documented for an unknown create)", async () => {
    const fetchMock = mockFetch(200, { pinpad_request_id: "pinpad-9" });
    expect(await cancelBySerial(client, "P8220724000042")).toEqual({
      cancelled: true,
    });
    const [url, init] = call(fetchMock);
    expect(url).toBe(`${BASE}/payment/serial-number/P8220724000042`);
    expect(init.method).toBe("DELETE");
  });
});

describe("listPinPadDevices", () => {
  it("normalises the devices/status array", async () => {
    const fetchMock = mockFetch(200, [
      {
        merchant_id: "uuid",
        serial_number: "PP35542235000286",
        status: "active",
        updated_at: "2024-01-15T10:30:00Z",
      },
      {
        merchant_id: "uuid",
        serial_number: "PP35542235000287",
        status: "EXPIRED",
      },
      { merchant_id: "uuid" },
    ]);
    const devices = await listPinPadDevices(client);
    expect(call(fetchMock)[0]).toBe(`${BASE}/devices/status`);
    expect(devices).toEqual([
      {
        serial: "PP35542235000286",
        status: "active",
        updatedAt: "2024-01-15T10:30:00Z",
      },
      { serial: "PP35542235000287", status: "expired", updatedAt: null },
    ]);
  });

  it('empty array is a valid "no readers" answer', async () => {
    mockFetch(200, []);
    expect(await listPinPadDevices(client)).toEqual([]);
  });
});

describe("mapClipStatus", () => {
  it("COMPLETED → paid", () => {
    expect(mapClipStatus({ status: "COMPLETED" })).toBe("paid");
  });

  it("Approved (Clip support's spelling) → paid", () => {
    expect(mapClipStatus({ status: "Approved" })).toBe("paid");
  });

  it("FAILED / Rejected → failed; CANCELED / cancelled / TIMEOUT_CANCELED → cancelled: all final, nothing charged", () => {
    expect(mapClipStatus({ status: "FAILED" })).toBe("failed");
    expect(mapClipStatus({ status: "Rejected" })).toBe("failed");
    expect(mapClipStatus({ status: "CANCELED" })).toBe("cancelled");
    expect(mapClipStatus({ status: "cancelled" })).toBe("cancelled");
    // Kiosk-mode timeout: must not leave the order waiting forever.
    expect(mapClipStatus({ status: "TIMEOUT_CANCELED" })).toBe("cancelled");
  });

  it("PENDING and anything undocumented stay pending — never final", () => {
    expect(mapClipStatus({ status: "PENDING" })).toBe("pending");
    expect(mapClipStatus({ status: "SOMETHING_NEW" })).toBe("pending");
    expect(mapClipStatus({ status: "IN_PROCESS" })).toBe("pending");
    expect(mapClipStatus({})).toBe("pending");
    expect(mapClipStatus(null)).toBe("pending");
  });

  it("flags undocumented statuses for an event", () => {
    expect(isKnownClipStatus({ status: "COMPLETED" })).toBe(true);
    expect(isKnownClipStatus({ status: "SOMETHING_NEW" })).toBe(false);
  });
});

describe("summarizeClipPayment: bill / tip / fee split (minor units)", () => {
  // Shape copied from Clip's GET /payment example (Pinpad-Include-Detail: true).
  const completed = {
    pinpad_request_id: "pinpad-0d08e174",
    reference: "r",
    amount: "200.00",
    amount_paid: "220.00",
    tip_amount: "20.00",
    status: "COMPLETED",
    detail: {
      results: [
        {
          status: "approved",
          amount: 220,
          paid_amount: 220,
          net_amount: 0,
          currency: "MXN",
          payment_method: {
            id: "master",
            type: "credit_card",
            card: { last_digits: "4444", issuer: "BANCO FICTICIO" },
          },
          device: { id: "S1" },
        },
      ],
    },
  };

  it("estimates the fee from the configured rate", () => {
    // 4.18 % of $220.00 = $9.1960 → 920 centavos (half-up)
    const s = summarizeClipPayment(completed, {
      billAmount: 20000,
      feeBp: 418,
    });
    expect(s).toMatchObject({
      gross: 22000,
      bill: 20000,
      tip: 2000,
      fee: 920,
      card: { brand: "master", type: "credit", last4: "4444" },
    });
  });

  it("never derives a fee from net_amount — Clip says it is sale + tip, not net of fees", () => {
    const withNet = {
      ...completed,
      detail: {
        results: [{ ...completed.detail.results[0], net_amount: 210.5 }],
      },
    };
    expect(
      summarizeClipPayment(withNet, { billAmount: 20000, feeBp: 418 }).fee,
    ).toBe(920);
    expect(
      summarizeClipPayment(withNet, { billAmount: 20000, feeBp: null }).fee,
    ).toBeNull();
  });

  it("leaves the fee null when no rate is configured — never guesses", () => {
    const s = summarizeClipPayment(completed, {
      billAmount: 20000,
      feeBp: null,
    });
    expect(s.fee).toBeNull();
  });

  it("derives the tip from amount_paid when tip_amount is absent", () => {
    const noTipField = { ...completed, tip_amount: undefined };
    const s = summarizeClipPayment(noTipField, {
      billAmount: 20000,
      feeBp: null,
    });
    expect(s.tip).toBe(2000);
    expect(s.bill).toBe(20000);
  });

  it("identity: approved only when the reference is the attempt id, the reader matches and nothing is short", () => {
    const e = {
      attemptId: "r",
      deviceId: "S1",
      accountId: null,
      amount: 20000,
      tip: 0,
    };
    const ok = mapClipPayment(completed, e, 418);
    expect(ok).toMatchObject({
      outcome: "approved",
      paidAmount: 22000,
      mismatch: null,
      cardBrand: "master",
      cardLast4: "4444",
      fee: 920,
    });
    expect(
      mapClipPayment({ ...completed, reference: "other" }, e, null).mismatch,
    ).toBe("reference");
    expect(
      mapClipPayment(completed, { ...e, deviceId: "S2" }, null).mismatch,
    ).toBe("terminal");
    expect(
      mapClipPayment(completed, { ...e, amount: 23000 }, null).mismatch,
    ).toBe("paid_short");
    expect(
      mapClipPayment({ status: "TIMEOUT_CANCELED" }, e, null).outcome,
    ).toBe("expired");
    expect(mapClipPayment({ status: "SOMETHING_NEW" }, e, null)).toMatchObject({
      outcome: "pending",
      undocumented: true,
    });
  });
});

describe("stripNulChars: Postgres rejects U+0000", () => {
  it("removes NULs from nested strings (nameless tapped card) and keeps everything else", () => {
    const payment = {
      status: "APPROVED",
      amount: "49.00",
      detail: {
        results: [
          {
            payment_method: {
              id: "visa",
              card: { name: "\u0000".repeat(12), last_digits: "4242" },
            },
          },
        ],
      },
    };
    const clean = stripNulChars(payment);
    expect(clean.detail.results[0].payment_method.card).toEqual({
      name: "",
      last_digits: "4242",
    });
    expect(clean.amount).toBe("49.00");
    expect(JSON.stringify(clean)).not.toContain("\\u0000");
    // Input is not mutated
    expect(payment.detail.results[0].payment_method.card.name).toHaveLength(12);
  });
});
