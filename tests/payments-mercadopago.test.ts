// Mercado Pago Point adapter (spec §4.8, §12.1), mocked fetch: request shape (idempotency key =
// attempt id, identical across retries, unlike pos-lite P1), the status table, tip and paid-amount
// derivation, the fee through the reference id, identity checks, error mapping, the cancel header,
// and the webhook signature (fails closed, unlike pos-lite P2).
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelPointOrder,
  createPointOrder,
  getAccount,
  getPaymentDetail,
  getPointOrder,
  listTerminals,
  mapPointOrder,
  mpManifest,
  parseMpSignature,
  provesNoOrder,
  setTerminalMode,
  verifyMpSignature,
  type MpClient,
} from "../server/payments/worker/mercadopago";
import { ProviderError } from "../server/payments/worker/http";

const BASE = "https://api.mercadopago.com";
const c: MpClient = {
  baseUrl: BASE,
  accessToken: "TEST-mp-access-token-not-real",
};
const attemptId = "6f1c1a52-8d0e-4c1e-9b0a-3a3c1d2e4f50";
const expected = {
  attemptId,
  deviceId: "NEWLAND_N950__FAKE0001",
  accountId: "1000001",
  amount: 20000,
  tip: 3600,
};

function mockFetch(...answers: [number, unknown][]) {
  let i = 0;
  const fn = vi.fn(async () => {
    const [status, body] = answers[Math.min(i++, answers.length - 1)];
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const call = (fn: ReturnType<typeof mockFetch>, i = 0) =>
  fn.mock.calls[i] as unknown as [string, RequestInit];
const headers = (init: RequestInit) => init.headers as Record<string, string>;
afterEach(() => {
  vi.unstubAllGlobals();
});

const order = (
  over: Record<string, unknown> = {},
  payment: Record<string, unknown> = {},
) => ({
  id: "ORD01JS2V6CM8KJ0EC4H502TGK1WP",
  type: "point",
  user_id: "1000001",
  external_reference: attemptId,
  status: "processed",
  status_detail: "accredited",
  config: { point: { terminal_id: expected.deviceId } },
  transactions: {
    payments: [
      {
        id: "PAY01JS2V6CM8KJ0EC4H504R7YE34",
        amount: "236.00",
        paid_amount: "236.00",
        status: "processed",
        status_detail: "accredited",
        reference_id: "92937960454",
        payment_method: { id: "visa", type: "credit_card", installments: 1 },
        ...payment,
      },
    ],
  },
  ...over,
});

describe("createPointOrder: request shape", () => {
  it("POST /v1/orders with the attempt id as idempotency key and external_reference, a 2-decimal total, no_ticket, the expiration and no default_type", async () => {
    const fetchMock = mockFetch([
      201,
      {
        id: "ORD1",
        status: "created",
        external_reference: attemptId,
        config: { point: { terminal_id: expected.deviceId } },
      },
    ]);
    const out = await createPointOrder(c, {
      attemptId,
      total: 23600,
      terminalId: expected.deviceId,
      expiration: "PT10M",
      description: "Orden 14",
    });
    // The order names its attempt and device: a recovery adopts it only then (P2-MONEY-2).
    expect(out).toEqual({
      id: "ORD1",
      status: "created",
      externalReference: attemptId,
      terminalId: expected.deviceId,
    });
    const [url, init] = call(fetchMock);
    expect(url).toBe(`${BASE}/v1/orders`);
    expect(init.method).toBe("POST");
    expect(headers(init).Authorization).toBe(
      "Bearer TEST-mp-access-token-not-real",
    );
    expect(headers(init)["X-Idempotency-Key"]).toBe(attemptId);
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      type: "point",
      external_reference: attemptId,
      expiration_time: "PT10M",
      description: "Orden 14",
      transactions: { payments: [{ amount: "236.00" }] },
      config: {
        point: {
          terminal_id: expected.deviceId,
          print_on_terminal: "no_ticket",
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("default_type");
  });

  it("the idempotency key is identical across retries (pos-lite P1 used Date.now())", async () => {
    const fetchMock = mockFetch([503, {}], [201, { id: "ORD1" }]);
    const args = {
      attemptId,
      total: 500,
      terminalId: expected.deviceId,
      expiration: "PT10M",
      description: "x",
    };
    const first = await createPointOrder(c, args).catch((e: unknown) => e);
    expect((first as ProviderError).retryable).toBe(true);
    await createPointOrder(c, args);
    expect(headers(call(fetchMock, 0)[1])["X-Idempotency-Key"]).toBe(
      headers(call(fetchMock, 1)[1])["X-Idempotency-Key"],
    );
  });

  it("maps 2205 'queued intent', the minimum-amount property error, 401 and 429", async () => {
    mockFetch([
      409,
      {
        errors: [
          {
            code: "2205",
            message: "There is already a queued intent for the device",
          },
        ],
      },
    ]);
    const args = {
      attemptId,
      total: 300,
      terminalId: "T",
      expiration: "PT10M",
      description: "x",
    };
    expect(
      ((await createPointOrder(c, args).catch((e) => e)) as ProviderError).code,
    ).toBe("payments_terminal_queue_busy");
    mockFetch([
      400,
      {
        errors: [
          {
            code: "property_value",
            message: "invalid property value",
            details: [
              "'$.transactions.payments[0].amount' must be greater than or equal to 5",
            ],
          },
        ],
      },
    ]);
    expect(
      ((await createPointOrder(c, args).catch((e) => e)) as ProviderError).code,
    ).toBe("payments_amount_below_min");
    mockFetch([401, { message: "invalid_token" }]);
    expect(
      ((await createPointOrder(c, args).catch((e) => e)) as ProviderError).code,
    ).toBe("payments_credentials_rejected");
    // The Orders API's names (MP MX create-order reference): the queued order and the terminal of
    // another account (the 403 keeps MP's code so the worker can tell it from a bad token).
    mockFetch([
      409,
      {
        errors: [
          {
            code: "already_queued_order_for_terminal",
            message: "The terminal already has an order waiting.",
          },
        ],
      },
    ]);
    expect(
      ((await createPointOrder(c, args).catch((e) => e)) as ProviderError).code,
    ).toBe("payments_terminal_queue_busy");
    mockFetch([
      403,
      { errors: [{ code: "forbidden_checking_terminal_owner", message: "x" }] },
    ]);
    const owner = (await createPointOrder(c, args).catch(
      (e) => e,
    )) as ProviderError;
    expect([owner.code, owner.status, owner.providerCode]).toEqual([
      "payments_credentials_rejected",
      403,
      "forbidden_checking_terminal_owner",
    ]);
    mockFetch([429, {}]);
    const limited = (await createPointOrder(c, args).catch(
      (e) => e,
    )) as ProviderError;
    expect(limited.code).toBe("payments_provider_rate_limited");
    expect(limited.retryAfterMs).toBe(3500);
  });
});

describe("provesNoOrder: which create refusals prove MP made no order (P2-PROVIDERS-2)", () => {
  it("only a 400 validation error (the identical body was invalid the first time too)", () => {
    const e = (status: number, code: string, providerCode: string | null) =>
      new ProviderError(code, status, providerCode);
    expect(
      provesNoOrder(e(400, "payments_provider_rejected", "property_value")),
    ).toBe(true);
    expect(
      provesNoOrder(e(400, "payments_amount_below_min", "property_value")),
    ).toBe(true);
    expect(
      provesNoOrder(
        e(400, "payments_provider_rejected", "required_properties"),
      ),
    ).toBe(true);
    expect(
      provesNoOrder(
        e(
          409,
          "payments_terminal_queue_busy",
          "already_queued_order_for_terminal",
        ),
      ),
    ).toBe(false);
    expect(
      provesNoOrder(
        e(409, "payments_provider_rejected", "idempotency_key_already_used"),
      ),
    ).toBe(false);
    expect(provesNoOrder(e(401, "payments_credentials_rejected", null))).toBe(
      false,
    );
    expect(
      provesNoOrder(
        e(
          403,
          "payments_credentials_rejected",
          "forbidden_checking_terminal_owner",
        ),
      ),
    ).toBe(false);
    expect(provesNoOrder(e(400, "payments_provider_rejected", null))).toBe(
      false,
    );
  });
});

describe("mapPointOrder: the status table (§4.8)", () => {
  it("processed → approved with paid amount, tip surplus, reference id and card", () => {
    const r = mapPointOrder(order(), expected);
    expect(r).toMatchObject({
      outcome: "approved",
      paidAmount: 23600,
      providerPaymentId: "92937960454",
      cardType: "credit",
      cardBrand: "visa",
      mismatch: null,
      providerStatus: "processed/accredited",
    });
  });

  it("a tip added on the terminal: paid_amount carries it (tender tip = paid − amount ≥ the POS tip)", () => {
    const r = mapPointOrder(
      order(
        {},
        { amount: "236.00", tip_amount: "10.00", paid_amount: "246.00" },
      ),
      expected,
    );
    expect(r.paidAmount).toBe(24600);
    // No paid_amount: amount + tip_amount.
    const noPaid = mapPointOrder(
      order(
        {},
        { amount: "236.00", tip_amount: "10.00", paid_amount: undefined },
      ),
      expected,
    );
    expect(noPaid.paidAmount).toBe(24600);
  });

  it("the reference id may come as payments[0].reference.id (MP's webhook example)", () => {
    const r = mapPointOrder(
      order({}, { reference_id: undefined, reference: { id: "777" } }),
      expected,
    );
    expect(r.providerPaymentId).toBe("777");
  });

  it("canceled (incl. canceled_on_terminal) → cancelled; failed / rejected → declined; expired → expired", () => {
    expect(
      mapPointOrder(
        order(
          { status: "canceled", status_detail: "canceled" },
          { status: "canceled", status_detail: "canceled_on_terminal" },
        ),
        expected,
      ),
    ).toMatchObject({
      outcome: "cancelled",
      providerStatus: "canceled/canceled_on_terminal",
    });
    expect(mapPointOrder(order({ status: "failed" }), expected).outcome).toBe(
      "declined",
    );
    expect(mapPointOrder(order({ status: "rejected" }), expected).outcome).toBe(
      "declined",
    );
    expect(mapPointOrder(order({ status: "expired" }), expected).outcome).toBe(
      "expired",
    );
  });

  it("created, at_terminal, action_required, processing and in_process stay pending; at_terminal is flagged for the cancel header", () => {
    for (const status of [
      "created",
      "at_terminal",
      "action_required",
      "processing",
      "in_process",
    ])
      expect(mapPointOrder(order({ status }), expected)).toMatchObject({
        outcome: "pending",
        undocumented: false,
      });
    expect(
      mapPointOrder(order({ status: "at_terminal" }), expected).atTerminal,
    ).toBe(true);
  });

  it("anything undocumented stays pending, flagged (never failed: pos-lite's rule)", () => {
    expect(
      mapPointOrder(order({ status: "brand_new_state" }), expected),
    ).toMatchObject({
      outcome: "pending",
      undocumented: true,
    });
  });

  it("refunded before settle is reported apart (the settle sends it to review)", () => {
    expect(mapPointOrder(order({ status: "refunded" }), expected).outcome).toBe(
      "refunded",
    );
  });

  it("identity: external_reference, terminal, account and the paid amount must match, else a mismatch", () => {
    expect(
      mapPointOrder(order({ external_reference: "other" }), expected).mismatch,
    ).toBe("external_reference");
    expect(
      mapPointOrder(
        order({ config: { point: { terminal_id: "OTHER" } } }),
        expected,
      ).mismatch,
    ).toBe("terminal");
    expect(mapPointOrder(order({ user_id: "999" }), expected).mismatch).toBe(
      "account",
    );
    expect(
      mapPointOrder(order({}, { paid_amount: "200.00" }), expected).mismatch,
    ).toBe("paid_short");
    expect(
      mapPointOrder(
        order({}, { paid_amount: undefined, amount: undefined }),
        expected,
      ).mismatch,
    ).toBe("paid_amount_unknown");
  });
});

describe("cancel, fee, account, terminals", () => {
  it("every cancel sends x-allow-cancelable-status: at_terminal (ignored for created) and its own operation key (MP MX cancel-order; P2-PROVIDERS-6)", async () => {
    const fetchMock = mockFetch(
      [200, { id: "ORD1", status: "canceled" }],
      [200, { id: "ORD1", status: "canceled" }],
    );
    const k1 = "0b9f3c1e-5d1a-4e2b-9c3d-7a1b2c3d4e5f";
    const k2 = "1c8e2d0f-4e2b-4f3c-8d4e-6b2c3d4e5f60";
    expect(await cancelPointOrder(c, { orderId: "ORD1", key: k1 })).toEqual({
      cancelled: true,
    });
    await cancelPointOrder(c, { orderId: "ORD1", key: k2 });
    const [url, first] = call(fetchMock, 0);
    expect(url).toBe(`${BASE}/v1/orders/ORD1/cancel`);
    expect(first.method).toBe("POST");
    expect(headers(first)["x-allow-cancelable-status"]).toBe("at_terminal");
    expect(headers(first)["X-Idempotency-Key"]).toBe(k1);
    const second = call(fetchMock, 1)[1];
    expect(headers(second)["x-allow-cancelable-status"]).toBe("at_terminal");
    expect(headers(second)["X-Idempotency-Key"]).toBe(k2);
  });

  it("202 for an order on the device is a request, never a cancel; a refused cancel is not a cancel; 5xx throws for a retry", async () => {
    mockFetch([202, { id: "O", status: "at_terminal" }]);
    expect(await cancelPointOrder(c, { orderId: "O", key: "k" })).toEqual({
      cancelled: false,
      requested: true,
      code: null,
    });
    mockFetch([409, { errors: [{ code: "cannot_cancel_order" }] }]);
    expect(await cancelPointOrder(c, { orderId: "O", key: "k" })).toEqual({
      cancelled: false,
      requested: false,
      code: "cannot_cancel_order",
    });
    mockFetch([409, { errors: [{ code: "order_already_canceled" }] }]);
    expect(await cancelPointOrder(c, { orderId: "O", key: "k" })).toEqual({
      cancelled: false,
      requested: false,
      code: "order_already_canceled",
    });
    mockFetch([502, {}]);
    await expect(
      cancelPointOrder(c, { orderId: "O", key: "k" }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("the fee is Σ fee_details from /v1/payments/{reference id}, never the PAY… order payment id", async () => {
    const fetchMock = mockFetch([
      200,
      {
        id: 92937960454,
        fee_details: [
          { type: "mercadopago_fee", amount: 8.86 },
          { type: "financing_fee", amount: 1.0 },
        ],
        card: { last_four_digits: "4242" },
        payment_type_id: "credit_card",
      },
    ]);
    const read = mapPointOrder(order(), expected);
    const detail = await getPaymentDetail(c, read.providerPaymentId!);
    expect(call(fetchMock)[0]).toBe(`${BASE}/v1/payments/92937960454`);
    expect(call(fetchMock)[0]).not.toContain("PAY01");
    expect(detail).toEqual({ fee: 986, last4: "4242", cardType: "credit" });
  });

  it("getPointOrder is null on 404; /users/me gives id, nickname and site; terminals list every mode; a refused mode switch maps to payments_device_mode_rejected", async () => {
    mockFetch([404, {}]);
    expect(await getPointOrder(c, "ORD-x")).toBeNull();
    mockFetch([
      200,
      { id: 1000001, nickname: "RESTAURANTE_FICTICIO", site_id: "MLM" },
    ]);
    expect(await getAccount(c)).toEqual({
      id: "1000001",
      nickname: "RESTAURANTE_FICTICIO",
      siteId: "MLM",
    });
    const fetchMock = mockFetch([
      200,
      {
        data: {
          terminals: [
            {
              id: "NEWLAND_N950__1",
              pos_id: 23545678,
              store_id: "1235",
              operating_mode: "PDV",
            },
            { id: "NEWLAND_N950__2", operating_mode: "UNDEFINED" },
          ],
        },
      },
    ]);
    expect(await listTerminals(c)).toEqual([
      {
        id: "NEWLAND_N950__1",
        operatingMode: "PDV",
        storeId: "1235",
        posId: "23545678",
      },
      {
        id: "NEWLAND_N950__2",
        operatingMode: null,
        storeId: null,
        posId: null,
      },
    ]);
    expect(call(fetchMock)[0]).toBe(
      `${BASE}/terminals/v1/list?limit=50&offset=0`,
    );
    const patch = mockFetch([
      400,
      { message: "only one PDV terminal per pos" },
    ]);
    await expect(
      setTerminalMode(c, "NEWLAND_N950__2", "PDV"),
    ).rejects.toMatchObject({
      code: "payments_device_mode_rejected",
    });
    expect(call(patch)[0]).toBe(`${BASE}/terminals/v1/setup`);
    expect(JSON.parse(String(call(patch)[1].body))).toEqual({
      terminals: [{ id: "NEWLAND_N950__2", operating_mode: "PDV" }],
    });
  });
});

describe("webhook signature (§9.2)", () => {
  const secret = "testWebhookSecretNotReal0000";
  const sign = (manifest: string) =>
    createHmac("sha256", secret).update(manifest).digest("hex");

  it("manifest uses the query data.id lower-cased and omits absent parts", () => {
    expect(
      mpManifest({ dataId: "ORD01ABC", requestId: "req-1", ts: "1704908010" }),
    ).toBe("id:ord01abc;request-id:req-1;ts:1704908010;");
    expect(mpManifest({ dataId: "ORD01ABC", ts: "1" })).toBe(
      "id:ord01abc;ts:1;",
    );
    expect(mpManifest({ requestId: "r", ts: "1" })).toBe("request-id:r;ts:1;");
  });

  it("a valid signature verifies; any change, a malformed header or an absent secret fails closed", () => {
    const ts = "1704908010";
    const v1 = sign(`id:ord01abc;request-id:req-1;ts:${ts};`);
    const parsed = parseMpSignature(`ts=${ts},v1=${v1}`);
    expect(parsed).toEqual({ ts, v1 });
    expect(
      verifyMpSignature({
        secret,
        dataId: "ORD01ABC",
        requestId: "req-1",
        ...parsed!,
      }),
    ).toBe(true);
    expect(
      verifyMpSignature({
        secret,
        dataId: "ORD01ABD",
        requestId: "req-1",
        ...parsed!,
      }),
    ).toBe(false);
    expect(
      verifyMpSignature({
        secret,
        dataId: "ORD01ABC",
        requestId: "req-2",
        ...parsed!,
      }),
    ).toBe(false);
    expect(
      verifyMpSignature({
        secret: "",
        dataId: "ORD01ABC",
        requestId: "req-1",
        ...parsed!,
      }),
    ).toBe(false);
    expect(
      verifyMpSignature({
        secret: null,
        dataId: "ORD01ABC",
        requestId: "req-1",
        ...parsed!,
      }),
    ).toBe(false);
    expect(parseMpSignature("v1=abc")).toBeNull();
    expect(parseMpSignature(`ts=${ts},v1=zz`)).toBeNull();
    expect(parseMpSignature("")).toBeNull();
    expect(parseMpSignature(undefined)).toBeNull();
    expect(
      verifyMpSignature({
        secret,
        dataId: "ORD01ABC",
        requestId: "req-1",
        ts,
        v1: v1.slice(0, 63),
      }),
    ).toBe(false);
  });
});
