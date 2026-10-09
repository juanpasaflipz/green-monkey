/**
 * Clip PinPad adapter (spec §4.8). Pure: it imports nothing from server/ but ./http.ts
 * (import-graph rule 3) and holds no state; the worker passes the restaurant's opened API key and
 * secret per call and never logs them.
 *
 * Contract facts (developer.clip.mx "API de PinPad" reference pages, read 2026-10-09; Context7 has
 * no Clip library, so the reference pages and pos-lite's live adapter, in production since
 * 2026-09-29, are the sources):
 *   - Base https://api.payclip.io/f2f/pinpad/v1, Authorization: Basic base64(api_key:secret_key),
 *     production only (no sandbox).
 *   - POST /payment {amount, tip_amount?, reference, serial_number_pos, webhook_url?, preferences:
 *     {is_tip_enabled, is_split_payment_enabled}} in decimal pesos → {pinpad_request_id, …}. There
 *     is no idempotency key and no lookup by reference: a create whose answer is lost is an
 *     unknown outcome, never re-sent.
 *   - GET /payment?pinpadRequestId=… with Pinpad-Include-Detail: true → {status, amount,
 *     amount_paid, tip_amount, detail.results[{status, paid_amount, payment_method{id, type,
 *     card{last_digits}}, device{id}}]}.
 *   - DELETE /payment/{pinpad_request_id} and DELETE /payment/serial-number/{serial} work only
 *     before the reader picks the request up; afterwards Clip answers 400 PAYMENT_REQUEST_ISSUE and
 *     the charge can only be stopped on the reader.
 *   - GET /devices/status → [{serial_number, status active|inactive|expired|unknown, updated_at}].
 *   - Webhooks carry {id, origin, event_type} and no signature: only a hint to re-read.
 *   - Clip pads a missing cardholder name with NUL characters (pos-lite, 2026-09-29): stripped.
 */
import {
  decimalToMinor,
  minorToPesos,
  ProviderError,
  providerRequest,
  sanitizeCode,
  transientError,
  type HttpResponse,
} from "./http.js";
import { DEVICE_ID, type CardType } from "../../../shared/payments.js";
import type { Expected, ProviderRead } from "./mercadopago.js";

export type ClipClient = {
  baseUrl: string;
  apiKey: string;
  secretKey: string;
  signal?: AbortSignal;
};

const auth = (c: ClipClient) => ({
  Authorization: `Basic ${Buffer.from(`${c.apiKey}:${c.secretKey}`).toString("base64")}`,
});
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown) =>
  typeof v === "string" || typeof v === "number" ? String(v) : null;

/** Clip's own error code of a non-2xx answer (raw, upper case as Clip sends it). */
function clipCode(r: HttpResponse): string | null {
  const c = obj(r.body).code;
  return typeof c === "string" && c.length <= 100 ? c : null;
}

/** Reader unreachable: PINPAD_TERMINAL_TIMEOUT_EXCEPTION (create) and the health check ERR10_04. */
const OFFLINE_CODES = new Set([
  "PINPAD_TERMINAL_TIMEOUT_EXCEPTION",
  "ERR10_04",
]);

function failure(r: HttpResponse): ProviderError {
  const t = transientError(r);
  if (t) return t;
  if (r.status === 401 || r.status === 403)
    return new ProviderError("payments_credentials_rejected", r.status);
  const code = clipCode(r);
  if (code && OFFLINE_CODES.has(code))
    return new ProviderError(
      "payments_terminal_offline",
      r.status,
      sanitizeCode(code),
    );
  return new ProviderError(
    "payments_provider_rejected",
    r.status,
    sanitizeCode(code),
  );
}

/**
 * POST /payment. The amount and tip go as decimal pesos (pos-lite's pre-docs scaffold sent cents:
 * 100× the bill). Preferences that change what is charged are pinned, never left to the account's
 * defaults (developer.clip.mx post_payment-1 documents none; P2-PROVIDERS-4): the reader's own tip
 * screen is off (the tip is chosen at the POS), split payments are off (one charge = one attempt),
 * installments with interest (MCI) and dynamic currency conversion (DCC) are off (either would make
 * amount_paid more than the bill, read as a tip), and retries on the reader are off (one request =
 * one card outcome). Interest-free installments (MSI) stay the account's choice (the restaurant
 * pays them; the amount is unchanged). Throws ProviderError: a retryable one (network, 5xx, 429)
 * or a 2xx without pinpad_request_id means the outcome is UNKNOWN for Clip.
 */
export async function createPinPadPayment(
  c: ClipClient,
  o: {
    amount: number;
    tip: number;
    reference: string;
    serial: string;
    webhookUrl: string | null;
  },
): Promise<{ pinpadRequestId: string }> {
  const body: Record<string, unknown> = {
    amount: minorToPesos(o.amount),
    reference: o.reference,
    serial_number_pos: o.serial,
    preferences: {
      is_tip_enabled: false,
      is_split_payment_enabled: false,
      is_mci_enabled: false,
      is_dcc_enabled: false,
      is_retry_enabled: false,
    },
  };
  if (o.tip > 0) body.tip_amount = minorToPesos(o.tip);
  if (o.webhookUrl) body.webhook_url = o.webhookUrl;
  const r = await providerRequest({
    method: "POST",
    url: `${c.baseUrl}/payment`,
    headers: auth(c),
    body,
    signal: c.signal,
  });
  if (r.status < 200 || r.status > 299) throw failure(r);
  const id = str(obj(r.body).pinpad_request_id);
  if (!id || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
    throw new ProviderError(
      "payments_clip_create_outcome_unknown",
      r.status,
      null,
      true,
    );
  return { pinpadRequestId: id };
}

/** GET /payment?pinpadRequestId=… with the detail header; null on 404. NULs stripped. */
export async function getPinPadPayment(
  c: ClipClient,
  pinpadRequestId: string,
): Promise<Record<string, unknown> | null> {
  const r = await providerRequest({
    method: "GET",
    url: `${c.baseUrl}/payment?pinpadRequestId=${encodeURIComponent(pinpadRequestId)}`,
    headers: { ...auth(c), "Pinpad-Include-Detail": "true" },
    signal: c.signal,
  });
  if (r.status === 404) return null;
  if (r.status < 200 || r.status > 299) throw failure(r);
  return obj(stripNulChars(r.body));
}

export type CancelResult =
  | {
      cancelled: true;
      /** The withdrawn request (Clip's 200 body: pinpad_request_id, reference); null if absent. */
      pinpadRequestId: string | null;
      reference: string | null;
    }
  | { cancelled: false; code: string | null };

async function cancel(c: ClipClient, path: string): Promise<CancelResult> {
  const r = await providerRequest({
    method: "DELETE",
    url: `${c.baseUrl}${path}`,
    headers: auth(c),
    signal: c.signal,
  });
  if (r.status >= 200 && r.status <= 299) {
    const b = obj(r.body);
    const id = str(b.pinpad_request_id);
    return {
      cancelled: true,
      pinpadRequestId: id && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null,
      reference: str(b.reference),
    };
  }
  if (r.status === 400 || r.status === 404)
    return { cancelled: false, code: clipCode(r) };
  throw failure(r);
}

/**
 * DELETE /payment/{id}. {cancelled:false, code} when Clip refuses (400 PAYMENT_REQUEST_ISSUE: the
 * reader already took it): the caller keeps the attempt pending and re-reads. 5xx throws.
 */
export function cancelPinPadPayment(
  c: ClipClient,
  pinpadRequestId: string,
): Promise<CancelResult> {
  return cancel(c, `/payment/${encodeURIComponent(pinpadRequestId)}`);
}

/**
 * DELETE /payment/serial-number/{serial}: withdraws a request whose id is unknown (spec §2.5).
 * developer.clip.mx reference: 200 {pinpad_request_id, reference, amount, serial_number_pos,
 * current_payment_on_transaction}; 400 PAYMENT_PENDING "El dispositivo tiene un pago pendiente en
 * curso" when the reader already holds a payment.
 */
export function cancelBySerial(
  c: ClipClient,
  serial: string,
): Promise<CancelResult> {
  return cancel(c, `/payment/serial-number/${encodeURIComponent(serial)}`);
}

/** GET /devices/status, normalized (expired = no heartbeat for 20 s; unknown = PinPad off). */
export async function listPinPadDevices(
  c: ClipClient,
): Promise<{ serial: string; status: string; updatedAt: string | null }[]> {
  const r = await providerRequest({
    method: "GET",
    url: `${c.baseUrl}/devices/status`,
    headers: auth(c),
    signal: c.signal,
  });
  if (r.status < 200 || r.status > 299) throw failure(r);
  const list = Array.isArray(r.body)
    ? r.body
    : Array.isArray(obj(r.body).devices)
      ? (obj(r.body).devices as unknown[])
      : [];
  return list.flatMap((d) => {
    const x = obj(d);
    const serial = str(x.serial_number);
    if (!serial || !DEVICE_ID.test(serial)) return [];
    const status = (str(x.status) ?? "unknown").toLowerCase();
    return [
      {
        serial,
        status: ["active", "inactive", "expired", "unknown"].includes(status)
          ? status
          : "unknown",
        updatedAt: str(x.updated_at),
      },
    ];
  });
}

/**
 * paid / failed / pending. Final statuses per Clip support (2026-09-28): Approved, Canceled,
 * Rejected and TIMEOUT_CANCELED; the docs also show COMPLETED / PENDING / FAILED. Anything
 * undocumented stays pending: a wrong "failed" would free the order for a second charge.
 */
export function mapClipStatus(
  payment: unknown,
): "paid" | "failed" | "cancelled" | "pending" {
  const raw = typeof payment === "string" ? payment : obj(payment).status;
  if (typeof raw !== "string" || !raw) return "pending";
  const s = raw.toUpperCase();
  if (s === "COMPLETED" || s === "APPROVED" || s === "PAID") return "paid";
  if (
    s === "CANCELLED" ||
    s === "CANCELED" ||
    s === "TIMEOUT_CANCELED" ||
    s === "DELETED"
  )
    return "cancelled";
  if (
    s === "FAILED" ||
    s === "DECLINED" ||
    s === "REJECTED" ||
    s === "ERROR" ||
    s === "EXPIRED"
  )
    return "failed";
  return "pending";
}

const KNOWN = new Set([
  "COMPLETED",
  "APPROVED",
  "PAID",
  "FAILED",
  "DECLINED",
  "REJECTED",
  "ERROR",
  "CANCELLED",
  "CANCELED",
  "TIMEOUT_CANCELED",
  "EXPIRED",
  "DELETED",
  "PENDING",
  "IN_PROGRESS",
  "IN_PROCESS",
  "PROCESSING",
  "CREATED",
]);
/** True when mapClipStatus did not fall through on an undocumented value. */
export function isKnownClipStatus(payment: unknown): boolean {
  const s = str(obj(payment).status);
  return s !== null && KNOWN.has(s.toUpperCase());
}

const CARD_TYPES: Record<string, CardType> = {
  credit_card: "credit",
  debit_card: "debit",
  prepaid_card: "prepaid",
  credit: "credit",
  debit: "debit",
  prepaid: "prepaid",
};

/**
 * Bill / tip / gross of a completed payment, in minor units, plus the card. The fee is NEVER
 * derived from the detail's net_amount (Clip support 2026-09-28: it is sale + tip, not net of
 * fees): it is estimated from the terminal's rate, or null when no rate is set, never guessed.
 */
export function summarizeClipPayment(
  payment: unknown,
  o: { billAmount: number; feeBp: number | null },
): {
  gross: number;
  bill: number;
  tip: number;
  fee: number | null;
  card: {
    brand: string | null;
    type: CardType | null;
    last4: string | null;
  } | null;
} {
  const p = obj(payment);
  const requested = decimalToMinor(p.amount) ?? o.billAmount;
  const results = Array.isArray(obj(p.detail).results)
    ? (obj(p.detail).results as unknown[]).map(obj)
    : [];
  const approved = results.filter(
    (r) => (str(r.status) ?? "").toLowerCase() === "approved",
  );
  const fromDetail = approved.reduce(
    (sum, r) =>
      sum + (decimalToMinor(r.paid_amount) ?? decimalToMinor(r.amount) ?? 0),
    0,
  );
  const gross = decimalToMinor(p.amount_paid) ?? (fromDetail || requested);
  const tip = Math.max(0, decimalToMinor(p.tip_amount) ?? gross - requested);
  const fee =
    o.feeBp === null
      ? null
      : Number((BigInt(gross) * BigInt(o.feeBp) + 5000n) / 10000n);
  const method = obj(approved[0]?.payment_method);
  const card = approved[0]
    ? {
        brand: brand(method.id),
        type: CARD_TYPES[(str(method.type) ?? "").toLowerCase()] ?? null,
        last4: last4(obj(method.card).last_digits),
      }
    : null;
  return { gross, bill: gross - tip, tip, fee, card };
}

function brand(v: unknown): string | null {
  const s =
    str(v)
      ?.toLowerCase()
      .replace(/[^a-z0-9_]/g, "") ?? "";
  return /^[a-z0-9_]{1,20}$/.test(s) ? s : null;
}
function last4(v: unknown): string | null {
  const s = str(v)?.trim() ?? "";
  return /^[0-9]{4}$/.test(s) ? s : null;
}

/** Maps a GET /payment answer to the attempt and runs the identity checks (spec §4.8). */
export function mapClipPayment(
  payment: Record<string, unknown>,
  e: Expected,
  feeBp: number | null,
): ProviderRead & { fee: number | null } {
  const status = (str(payment.status) ?? "").toUpperCase();
  const mapped = mapClipStatus(payment);
  const base = {
    providerStatus: status
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "")
      .slice(0, 64),
    undocumented: !isKnownClipStatus(payment),
    atTerminal: false,
    paidAmount: null,
    providerPaymentId: null,
    cardType: null,
    cardBrand: null,
    cardLast4: null,
    mismatch: null,
    fee: null,
  };
  if (mapped === "pending") return { ...base, outcome: "pending" };
  if (mapped === "failed") return { ...base, outcome: "declined" };
  if (mapped === "cancelled")
    return {
      ...base,
      outcome: status === "TIMEOUT_CANCELED" ? "expired" : "cancelled",
    };
  const s = summarizeClipPayment(payment, { billAmount: e.amount, feeBp });
  const results = Array.isArray(obj(payment.detail).results)
    ? (obj(payment.detail).results as unknown[]).map(obj)
    : [];
  const approved = results.find(
    (r) => (str(r.status) ?? "").toLowerCase() === "approved",
  );
  const serial =
    str(payment.serial_number_pos) ?? str(obj(approved?.device).id) ?? null;
  const currency = str(approved?.currency);
  let mismatch: string | null = null;
  if (str(payment.reference) !== e.attemptId) mismatch = "reference";
  else if (serial !== null && serial !== e.deviceId) mismatch = "terminal";
  else if (currency !== null && currency.toUpperCase() !== "MXN")
    mismatch = "currency";
  else if (s.gross < e.amount + e.tip) mismatch = "paid_short";
  const txn = str(approved?.transaction_id) ?? str(approved?.id);
  return {
    ...base,
    outcome: "approved",
    paidAmount: s.gross,
    providerPaymentId: txn && txn.length <= 100 ? txn : null,
    cardType: s.card?.type ?? null,
    cardBrand: s.card?.brand ?? null,
    cardLast4: s.card?.last4 ?? null,
    mismatch,
    fee: s.fee,
  };
}

/** Deep copy with NUL characters removed from every string (Postgres rejects U+0000). */
export function stripNulChars<T>(value: T): T {
  if (typeof value === "string") return value.split("\u0000").join("") as T;
  if (Array.isArray(value)) return value.map(stripNulChars) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, stripNulChars(v)]),
    ) as T;
  return value;
}
