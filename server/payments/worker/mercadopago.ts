/**
 * Mercado Pago Point adapter (Orders API; spec §4.8). Pure: it imports nothing from server/ but
 * ./http.ts (import-graph rule 3) and holds no state; the worker handlers pass the restaurant's
 * opened credentials per call and never log them.
 *
 * Contract facts (MP developers, "MP Point – payment processing", "Migrate payment intent to
 * Orders", "Webhooks"; verified through Context7 2026-10-09, and in production by pos-lite since
 * 2026-07 on Juanberto's MLM account):
 *   - POST /v1/orders {type:"point", external_reference, expiration_time, transactions.payments[0]
 *     .amount (2-decimal string), config.point.terminal_id, print_on_terminal} with a required
 *     X-Idempotency-Key. Here the key is the attempt id, identical on every retry (pos-lite added
 *     Date.now(), which defeated it: P1).
 *   - GET /v1/orders/{id}; statuses created, at_terminal, processed, canceled, failed, expired,
 *     refunded, action_required (anything else stays pending, never failed).
 *   - POST /v1/orders/{id}/cancel; an at_terminal order needs x-allow-cancelable-status: at_terminal.
 *   - Fees live on the classic payment: GET /v1/payments/{reference id} fee_details (the Orders
 *     PAY… id 404s there; pos-lite verified 2026-09-26). The processed order carries that id as
 *     payments[0].reference_id (pos-lite) or payments[0].reference.id (MP's webhook example).
 *   - GET /terminals/v1/list (data.terminals[]: id, operating_mode PDV|STANDALONE|UNDEFINED,
 *     store_id, pos_id); PATCH /terminals/v1/setup {terminals:[{id, operating_mode}]} (the device
 *     must restart to apply it).
 *   - Webhook x-signature "ts=…,v1=…": HMAC-SHA256(secret, "id:{data.id};request-id:{x-request-id};
 *     ts:{ts};") with data.id from the query string, lower-cased, absent parts omitted.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  decimalToMinor,
  ProviderError,
  providerRequest,
  sanitizeCode,
  transientError,
  type HttpResponse,
} from "./http.js";
import {
  DEVICE_ID,
  minorToDecimal,
  type CardType,
} from "../../../shared/payments.js";

export type MpClient = {
  baseUrl: string;
  accessToken: string;
  signal?: AbortSignal;
};

/** What a provider read means for an attempt (shared shape with clip.ts). */
export type ProviderRead = {
  outcome:
    "pending" | "approved" | "declined" | "cancelled" | "expired" | "refunded";
  /** Redacted status for the attempt and its events (e.g. "processed/accredited"). */
  providerStatus: string;
  /** A status this adapter does not document: stays pending, plus an event. */
  undocumented: boolean;
  /** The order sits on the device (MP at_terminal): cancel needs the header. */
  atTerminal: boolean;
  /** Total charged, tip included (minor units); null when unknown. */
  paidAmount: number | null;
  providerPaymentId: string | null;
  cardType: CardType | null;
  cardBrand: string | null;
  cardLast4: string | null;
  /** Identity or amount check that failed on an approval (spec §4.8); null when it passed. */
  mismatch: string | null;
};

export type Expected = {
  attemptId: string;
  /** payment_attempts.provider_device_id (MP terminal id or Clip serial). */
  deviceId: string;
  /** payment_provider_accounts.provider_account_id; null skips the check. */
  accountId: string | null;
  amount: number;
  tip: number;
};

const auth = (c: MpClient) => ({ Authorization: `Bearer ${c.accessToken}` });
const str = (v: unknown) =>
  typeof v === "string" || typeof v === "number" ? String(v) : null;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** The provider's error text (codes and messages only) for classification; never stored. */
function errorText(r: HttpResponse): string {
  try {
    return JSON.stringify(r.body ?? "").slice(0, 2000);
  } catch {
    return "";
  }
}
function providerCodeOf(r: HttpResponse): string | null {
  const b = obj(r.body);
  const first = obj(Array.isArray(b.errors) ? b.errors[0] : undefined);
  const cause = obj(Array.isArray(b.cause) ? b.cause[0] : undefined);
  return (
    sanitizeCode(first.code) ??
    sanitizeCode(cause.code) ??
    sanitizeCode(b.error) ??
    sanitizeCode(b.code)
  );
}

/**
 * Order-create validation errors (MP MX reference, in-person-payments/point/orders, create-order,
 * "400"): the request itself is invalid, so an identical re-POST could never have created an order
 * either. Every other refusal of a re-POST leaves the outcome unknown (P2-PROVIDERS-2).
 */
export const MP_VALIDATION_CODES = new Set([
  "empty_required_header",
  "required_properties",
  "unsupported_properties",
  "minimum_properties",
  "property_type",
  "minimum_items",
  "maximum_items",
  "property_value",
  "json_syntax_error",
]);
/** True when this create refusal proves no order exists (a 400 validation error). */
export function provesNoOrder(e: ProviderError): boolean {
  return (
    e.status === 400 &&
    (e.code === "payments_amount_below_min" ||
      (e.providerCode !== null && MP_VALIDATION_CODES.has(e.providerCode)))
  );
}

/** Maps a non-2xx answer of a charge-creating or reading call. */
function failure(r: HttpResponse): ProviderError {
  const t = transientError(r);
  if (t) return t;
  if (r.status === 401 || r.status === 403)
    return new ProviderError(
      "payments_credentials_rejected",
      r.status,
      providerCodeOf(r),
    );
  const text = errorText(r);
  // Orders API: 409 already_queued_order_for_terminal ("The terminal already has an order
  // waiting", MP MX create-order reference); 2205 / "queued intent" is the legacy Payment Intent
  // code, kept for safety (P2-PROVIDERS-7).
  if (
    providerCodeOf(r) === "already_queued_order_for_terminal" ||
    /\b2205\b/.test(text) ||
    /queued intent/i.test(text)
  )
    return new ProviderError(
      "payments_terminal_queue_busy",
      r.status,
      providerCodeOf(r),
    );
  if (
    r.status === 400 &&
    /amount/i.test(text) &&
    /(min|property_value|less than|greater than)/i.test(text)
  )
    return new ProviderError(
      "payments_amount_below_min",
      r.status,
      providerCodeOf(r),
    );
  return new ProviderError(
    "payments_provider_rejected",
    r.status,
    providerCodeOf(r),
  );
}

/** POST /v1/orders: pushes amount + tip to the terminal. Returns MP's order id (ORD…). */
export async function createPointOrder(
  c: MpClient,
  o: {
    attemptId: string;
    /** amount + tip, minor units */
    total: number;
    terminalId: string;
    expiration: string;
    description: string;
  },
): Promise<{
  id: string;
  status: string | null;
  externalReference: string | null;
  terminalId: string | null;
}> {
  const r = await providerRequest({
    method: "POST",
    url: `${c.baseUrl}/v1/orders`,
    headers: { ...auth(c), "X-Idempotency-Key": o.attemptId },
    signal: c.signal,
    body: {
      type: "point",
      external_reference: o.attemptId,
      expiration_time: o.expiration,
      description: o.description.slice(0, 150),
      transactions: { payments: [{ amount: minorToDecimal(o.total) }] },
      config: {
        point: { terminal_id: o.terminalId, print_on_terminal: "no_ticket" },
      },
    },
  });
  if (r.status < 200 || r.status > 299) throw failure(r);
  const b = obj(r.body);
  const id = str(b.id);
  if (!id || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
    // A 2xx without an order id: the order may exist; same-key retry finds it.
    throw new ProviderError(
      "payments_provider_unreachable",
      r.status,
      null,
      true,
    );
  return {
    id,
    status: str(b.status),
    externalReference: str(b.external_reference),
    terminalId: str(obj(obj(b.config).point).terminal_id),
  };
}

/** GET /v1/orders/{id}; null on 404. */
export async function getPointOrder(
  c: MpClient,
  orderId: string,
): Promise<Record<string, unknown> | null> {
  const r = await providerRequest({
    method: "GET",
    url: `${c.baseUrl}/v1/orders/${encodeURIComponent(orderId)}`,
    headers: auth(c),
    signal: c.signal,
  });
  if (r.status === 404) return null;
  if (r.status < 200 || r.status > 299) throw failure(r);
  return obj(r.body);
}

const PENDING = new Set([
  "created",
  "at_terminal",
  "action_required",
  "processing",
  "in_process",
]);
const CARD_TYPES: Record<string, CardType> = {
  credit_card: "credit",
  debit_card: "debit",
  prepaid_card: "prepaid",
};

export function cardBrand(v: unknown): string | null {
  const s =
    str(v)
      ?.toLowerCase()
      .replace(/[^a-z0-9_]/g, "") ?? "";
  return /^[a-z0-9_]{1,20}$/.test(s) ? s : null;
}
export function cardLast4(v: unknown): string | null {
  const s = str(v)?.trim() ?? "";
  return /^[0-9]{4}$/.test(s) ? s : null;
}

/** Maps an Orders API order to the attempt (spec §4.8 table) and runs the identity checks. */
export function mapPointOrder(
  order: Record<string, unknown>,
  e: Expected,
): ProviderRead {
  const payment = obj(
    Array.isArray(obj(order.transactions).payments)
      ? (obj(order.transactions).payments as unknown[])[0]
      : undefined,
  );
  const orderStatus = (str(order.status) ?? "").toLowerCase();
  const paymentStatus = (str(payment.status) ?? "").toLowerCase();
  const status = orderStatus || paymentStatus;
  const detail = (
    str(payment.status_detail) ??
    str(order.status_detail) ??
    ""
  ).toLowerCase();
  const providerStatus =
    `${status}${detail && detail !== status ? `/${detail}` : ""}`
      .replace(/[^a-z0-9_/.-]/g, "")
      .slice(0, 64);
  const method = obj(payment.payment_method);
  const tipMinor = decimalToMinor(payment.tip_amount);
  const paid =
    decimalToMinor(payment.paid_amount) ??
    (decimalToMinor(payment.amount) !== null
      ? decimalToMinor(payment.amount)! + (tipMinor ?? 0)
      : decimalToMinor(order.total_paid_amount));
  const reference =
    str(payment.reference_id) ?? str(obj(payment.reference).id) ?? null;
  const base: ProviderRead = {
    outcome: "pending",
    providerStatus,
    undocumented: false,
    atTerminal: status === "at_terminal",
    paidAmount: null,
    providerPaymentId: reference && reference.length <= 100 ? reference : null,
    cardType: CARD_TYPES[str(method.type) ?? ""] ?? null,
    cardBrand: cardBrand(method.id),
    cardLast4: cardLast4(
      obj(method.card).last_four_digits ?? obj(payment.card).last_four_digits,
    ),
    mismatch: null,
  };
  if (status === "processed" || status === "refunded") {
    let mismatch: string | null = null;
    const terminal = str(obj(obj(order.config).point).terminal_id);
    const user = str(order.user_id);
    const currency = str(order.currency) ?? str(payment.currency);
    if (str(order.external_reference) !== e.attemptId)
      mismatch = "external_reference";
    else if (terminal !== null && terminal !== e.deviceId)
      mismatch = "terminal";
    else if (e.accountId && user !== null && user !== e.accountId)
      mismatch = "account";
    else if (currency !== null && currency.toUpperCase() !== "MXN")
      mismatch = "currency";
    else if (paid === null) mismatch = "paid_amount_unknown";
    else if (paid < e.amount + e.tip) mismatch = "paid_short";
    return {
      ...base,
      outcome: status === "refunded" ? "refunded" : "approved",
      paidAmount: paid,
      mismatch,
    };
  }
  if (status === "canceled" || status === "cancelled")
    return { ...base, outcome: "cancelled" };
  if (status === "failed" || status === "rejected")
    return { ...base, outcome: "declined" };
  if (status === "expired") return { ...base, outcome: "expired" };
  if (PENDING.has(status)) return base;
  return { ...base, undocumented: true };
}

export type MpCancelResult =
  | { cancelled: true }
  /** requested: MP accepted it for a device that holds the order (202); a read confirms it. */
  | { cancelled: false; requested: boolean; code: string | null };

/**
 * POST /v1/orders/{id}/cancel (MP MX reference, in-person-payments/point/orders cancel-order;
 * P2-PROVIDERS-6):
 * - x-allow-cancelable-status: at_terminal on every cancel: "required to cancel an order with
 *   status=at_terminal ... For orders with status=created, the header is ignored", and the device
 *   usually takes an order within a second of its creation;
 * - X-Idempotency-Key: one per cancel operation ("Clave única por solicitud"), stable across the
 *   retries of that operation (the caller passes its job id);
 * - 200: cancelled (an order still `created`); 202: MP asked the device, the order stays
 *   at_terminal "until a Webhook notification confirms" and the 202 "must not be interpreted as
 *   final confirmation": {cancelled:false, requested:true}, and a read decides;
 * - 4xx (409 cannot_cancel_order, order_already_canceled, ...): refused, {cancelled:false, code};
 *   the caller re-reads; 5xx, 429 and network failures throw (retry).
 */
export async function cancelPointOrder(
  c: MpClient,
  o: { orderId: string; key: string },
): Promise<MpCancelResult> {
  const r = await providerRequest({
    method: "POST",
    url: `${c.baseUrl}/v1/orders/${encodeURIComponent(o.orderId)}/cancel`,
    headers: {
      ...auth(c),
      "X-Idempotency-Key": o.key,
      "x-allow-cancelable-status": "at_terminal",
    },
    signal: c.signal,
  });
  if (r.status >= 200 && r.status <= 299) {
    const status = (str(obj(r.body).status) ?? "").toLowerCase();
    if (r.status === 202 || (status !== "" && status !== "canceled"))
      return { cancelled: false, requested: true, code: null };
    return { cancelled: true };
  }
  const t = transientError(r);
  if (t) throw t;
  if (r.status === 401 || r.status === 403)
    throw new ProviderError("payments_credentials_rejected", r.status);
  return { cancelled: false, requested: false, code: providerCodeOf(r) };
}

/**
 * GET /v1/payments/{reference id}: the processor fee (Σ fee_details[].amount) and the card's
 * last 4 digits. Best effort: the caller falls back to the estimate.
 */
export async function getPaymentDetail(
  c: MpClient,
  referenceId: string,
): Promise<{
  fee: number | null;
  last4: string | null;
  cardType: CardType | null;
}> {
  const r = await providerRequest({
    method: "GET",
    url: `${c.baseUrl}/v1/payments/${encodeURIComponent(referenceId)}`,
    headers: auth(c),
    signal: c.signal,
    timeoutMs: 3000,
  });
  if (r.status < 200 || r.status > 299) throw failure(r);
  const b = obj(r.body);
  let fee: number | null = null;
  if (Array.isArray(b.fee_details)) {
    fee = 0;
    for (const f of b.fee_details) {
      const m = decimalToMinor(obj(f).amount);
      if (m === null) {
        fee = null;
        break;
      }
      fee += m;
    }
  }
  return {
    fee,
    last4: cardLast4(obj(b.card).last_four_digits),
    cardType: CARD_TYPES[str(b.payment_type_id) ?? ""] ?? null,
  };
}

/** GET /users/me: the account behind the access token (credentials verification). */
export async function getAccount(
  c: MpClient,
): Promise<{ id: string; nickname: string | null; siteId: string | null }> {
  const r = await providerRequest({
    method: "GET",
    url: `${c.baseUrl}/users/me`,
    headers: auth(c),
    signal: c.signal,
  });
  if (r.status < 200 || r.status > 299) throw failure(r);
  const b = obj(r.body);
  const id = str(b.id);
  if (!id) throw new ProviderError("payments_provider_rejected", r.status);
  return { id, nickname: str(b.nickname), siteId: str(b.site_id) };
}

export type MpTerminal = {
  id: string;
  operatingMode: "PDV" | "STANDALONE" | null;
  storeId: string | null;
  posId: string | null;
};

/** GET /terminals/v1/list (every mode, so the owner can switch a STANDALONE device to PDV). */
export async function listTerminals(c: MpClient): Promise<MpTerminal[]> {
  const r = await providerRequest({
    method: "GET",
    url: `${c.baseUrl}/terminals/v1/list?limit=50&offset=0`,
    headers: auth(c),
    signal: c.signal,
  });
  if (r.status < 200 || r.status > 299) throw failure(r);
  const list = obj(obj(r.body).data).terminals;
  if (!Array.isArray(list)) return [];
  return list.flatMap((t) => {
    const x = obj(t);
    const id = str(x.id);
    if (!id || !DEVICE_ID.test(id)) return [];
    const mode = str(x.operating_mode);
    return [
      {
        id,
        operatingMode: mode === "PDV" || mode === "STANDALONE" ? mode : null,
        storeId: str(x.store_id)?.slice(0, 64) ?? null,
        posId: str(x.pos_id)?.slice(0, 64) ?? null,
      },
    ];
  });
}

/** PATCH /terminals/v1/setup: switch one device between PDV and STANDALONE. */
export async function setTerminalMode(
  c: MpClient,
  terminalId: string,
  mode: "PDV" | "STANDALONE",
): Promise<void> {
  const r = await providerRequest({
    method: "PATCH",
    url: `${c.baseUrl}/terminals/v1/setup`,
    headers: auth(c),
    signal: c.signal,
    body: { terminals: [{ id: terminalId, operating_mode: mode }] },
  });
  if (r.status >= 200 && r.status <= 299) return;
  const t = transientError(r);
  if (t) throw t;
  if (r.status === 401 || r.status === 403)
    throw new ProviderError("payments_credentials_rejected", r.status);
  // e.g. "only one PDV terminal per point of sale" (pos-lite's live observation).
  throw new ProviderError(
    "payments_device_mode_rejected",
    r.status,
    providerCodeOf(r),
  );
}

/** "ts=…,v1=…" → its parts; null when malformed (fails closed). */
export function parseMpSignature(
  header: string | null | undefined,
): { ts: string; v1: string } | null {
  if (!header || header.length > 512) return null;
  let ts: string | null = null,
    v1: string | null = null;
  for (const part of header.split(",")) {
    const [k, ...rest] = part.split("=");
    const v = rest.join("=").trim();
    if (k.trim() === "ts") ts = v;
    if (k.trim() === "v1") v1 = v;
  }
  if (!ts || !/^\d{1,20}$/.test(ts) || !v1 || !/^[0-9a-f]{64}$/i.test(v1))
    return null;
  return { ts, v1: v1.toLowerCase() };
}

/** The signed manifest: data.id lower-cased, absent parts omitted (MP "Webhooks"). */
export function mpManifest(o: {
  dataId?: string | null;
  requestId?: string | null;
  ts?: string | null;
}): string {
  return (
    (o.dataId ? `id:${o.dataId.toLowerCase()};` : "") +
    (o.requestId ? `request-id:${o.requestId};` : "") +
    (o.ts ? `ts:${o.ts};` : "")
  );
}

/**
 * Verifies a notification's x-signature with the restaurant's secret. Fails closed: no secret,
 * a malformed header or any mismatch is false (pos-lite skipped the check without a secret: P2).
 */
export function verifyMpSignature(o: {
  secret: string | null | undefined;
  dataId?: string | null;
  requestId?: string | null;
  ts?: string | null;
  v1?: string | null;
}): boolean {
  if (!o.secret || !o.ts || !o.v1 || !/^[0-9a-f]{64}$/i.test(o.v1))
    return false;
  const expected = createHmac("sha256", o.secret)
    .update(mpManifest(o))
    .digest();
  const got = Buffer.from(o.v1.toLowerCase(), "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}
