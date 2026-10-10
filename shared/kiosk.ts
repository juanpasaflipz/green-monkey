// Kiosk self-checkout (039; specs/kiosk-w4.md with the Wave 4 critic's resolutions binding):
// constants, input schemas, wire views and the pure rules the server and the kiosk share.
// LD-72: the kiosk fires to the kitchen on payment only (no fire-before-payment).
import { z } from "zod";
import { id, money, type Label } from "./domain.js";
import {
  DINER_NAME_FORBIDDEN,
  DINER_NOTE_FORBIDDEN,
  PUBLIC_LIMITS,
  PUBLIC_TOKEN,
  publicLineInput,
} from "./public-ordering.js";
import type { LoyaltyCountry } from "./loyalty.js";
import type { DinerHoldView } from "./public-ordering.js";

export const KIOSK_LIMITS = {
  /** Card attempts per kiosk hold (§2.5), then only "Pagar en caja". */
  attempts: 3,
  /** A pairing code lives 10 minutes, is single use and dies after 5 wrong tries. */
  pairingMinutes: 10,
  pairingTries: 5,
  pairingDigits: 8,
  /** Member lookups per bound device per 5 minutes (R20). */
  memberLookups: 5,
  memberWindowMs: 5 * 60_000,
  /** Per-product and cart-level curated suggestions; at most 6 shown. */
  productSuggestions: 4,
  cartSuggestions: 6,
  shownSuggestions: 6,
  /** "Lo más pedido a esta hora": ±2 h over the last 30 business days, cached 15 minutes. */
  popularWindowHours: 2,
  popularDays: 30,
  popularCacheMs: 15 * 60_000,
  /** A heartbeat older than this shows "Sin señal desde …". */
  silentAfterMs: 5 * 60_000,
  heartbeatMs: 60_000,
  /** A heartbeat writes at most once per 50 s per device. */
  heartbeatWriteSeconds: 50,
} as const;

/** The device binding cookie (HttpOnly; Secure; SameSite=Strict; 400 days, Chrome's cap). */
export const KIOSK_COOKIE = "gm_kiosk";
export const KIOSK_COOKIE_PATH = "/api/public/kiosk";
export const KIOSK_COOKIE_MAX_AGE_SECONDS = 34_560_000;
/**
 * A binding older than this gets its cookie re-sent (same secret, a fresh 400 days) on each
 * heartbeat, so Chrome's cap never unbinds a tablet in service (KIOSK-SECURITY-3).
 */
export const KIOSK_COOKIE_REFRESH_DAYS = 30;

/** Kiosk-screen timing (§2.12; WCAG 2.2.1 needs at least 20 s to answer "¿Sigues ahí?"). */
export const KIOSK_IDLE = {
  warnAfterMs: 70_000,
  resetAfterMs: 95_000,
  /** The checkout screens (pay, «¿Para aquí…?», declined, unavailable) warn 25 s before their
   * 120 s reset (KIOSK-UX-05; WCAG 2.2.1). */
  payWarnAfterMs: 95_000,
  payResetMs: 120_000,
  donePaidMs: 30_000,
  doneCounterMs: 20_000,
  /** The idle reset is suspended while a charge is pending, at most this long. */
  chargeSuspendMaxMs: 300_000,
  /** The kiosk polls its checkout every 2 s while charging. */
  pollMs: 2_000,
  /** «Cancelar cobro» appears on «Sigue las instrucciones en la terminal» after 20 s (KIOSK-UX-03). */
  cancelOfferMs: 20_000,
  /** No final status after 3 minutes: the kiosk asks payments to cancel. */
  chargeTimeoutMs: 180_000,
  /** "La terminal sigue procesando": 2 more minutes of polling, then reset. */
  inProgressExtraMs: 120_000,
  /** Join panel for non-members after a paid order. */
  joinPanelMs: 20_000,
} as const;

/** Requests per minute (per IP / per (IP, link)) for the kiosk diner routes (§4.2). */
export const KIOSK_RATES = {
  chargePerIp: 20,
  chargePerIpLink: 6,
  counterPerIp: 30,
  counterPerIpLink: 10,
  checkoutPerIp: 240,
  checkoutPerIpKey: 60,
  pairPerIp: 5,
  pairWindowMs: 15 * 60_000,
  heartbeatPerIp: 4,
} as const;

export const PAYMENT_MODES = [
  "counter",
  "card_and_counter",
  "card_first",
] as const;
export type KioskPaymentMode = (typeof PAYMENT_MODES)[number];

/** Codes a kiosk hold attempt carries in payments' review (critic R9). */
export const KIOSK_SETTLE_CODES = [
  "kiosk_settle_unavailable",
  "kiosk_settle_price_changed",
  "kiosk_settle_invalid_modifier",
  "kiosk_settle_insufficient_stock",
  "kiosk_settle_pro_required",
  "kiosk_settle_hold_closed",
  "kiosk_settle_other",
] as const;
export type KioskSettleCode = (typeof KIOSK_SETTLE_CODES)[number];

/** The kiosk code a domain error of the hold settle becomes (critic R9). */
export function kioskSettleCode(code: string): KioskSettleCode {
  switch (code) {
    case "unavailable":
    case "required_modifier":
    case "forbidden":
    case "open_amount_exceeds":
    case "invalid_amount":
      return "kiosk_settle_unavailable";
    case "public_hold_price_changed":
    case "public_price_changed":
    case "kiosk_settle_price_changed":
      return "kiosk_settle_price_changed";
    case "invalid_modifier":
      return "kiosk_settle_invalid_modifier";
    case "insufficient_stock":
    case "stock_insufficient":
      return "kiosk_settle_insufficient_stock";
    case "pro_required":
      return "kiosk_settle_pro_required";
    case "public_order_not_pending":
    case "public_order_expired":
    case "kiosk_settle_hold_closed":
      return "kiosk_settle_hold_closed";
    default:
      return (KIOSK_SETTLE_CODES as readonly string[]).includes(code)
        ? (code as KioskSettleCode)
        : "kiosk_settle_other";
  }
}

/**
 * «Aceptar con el pago del kiosco» (critic R13): how the hold's total, as its card includes it
 * now, fits the approved charge. v1 has no partial refund, so a total below the charge cannot be
 * accepted (restore lines, or «Rechazar y reembolsar»); a total above it collects the rest.
 */
export type KioskChargeFit =
  | { kind: "unknown" }
  | { kind: "below"; missing: number }
  | { kind: "fits"; rest: number };
export function kioskChargeFit(
  total: number | null,
  charge: number,
): KioskChargeFit {
  if (total === null) return { kind: "unknown" };
  return total < charge
    ? { kind: "below", missing: charge - total }
    : { kind: "fits", rest: total - charge };
}

/** «Rechazar y reembolsar»'s reject reason: an item that ran out is "unavailable". */
export function kioskRejectReason(
  reviewCode: string | null,
): "unavailable" | "other" {
  return reviewCode === "kiosk_settle_unavailable" ||
    reviewCode === "kiosk_settle_insufficient_stock" ||
    reviewCode === "kiosk_settle_invalid_modifier"
    ? "unavailable"
    : "other";
}

// ---- inputs ----------------------------------------------------------------------------------

/** A kiosk line may say it came from a suggestion (report attribution only, §2.8). */
export const kioskLineInput = publicLineInput
  .extend({ origin: z.literal("suggestion").optional() })
  .strict();
export type KioskLine = z.infer<typeof kioskLineInput>;
const statusKey = z.string().regex(PUBLIC_TOKEN);

export const kioskOrderInput = z
  .object({
    operationId: id,
    statusKey,
    lines: z.array(kioskLineInput).min(1).max(PUBLIC_LIMITS.maxLines),
    name: z
      .string()
      .trim()
      .max(40)
      .refine((v) => !DINER_NAME_FORBIDDEN.test(v))
      .default(""),
    note: z
      .string()
      .trim()
      .max(200)
      .refine((v) => !DINER_NOTE_FORBIDDEN.test(v))
      .default(""),
    expectedTotal: money,
    /** "Para aquí" (dine in, no table) or "Para llevar"; takeaway when the kiosk does not ask. */
    fulfillment: z.enum(["here", "to_go"]).default("to_go"),
    /** Loyalty's sealed member token from "Soy del club" (R22); never a member id. */
    memberToken: z.string().min(1).max(1000).optional(),
  })
  .strict();
export type KioskOrderInput = z.infer<typeof kioskOrderInput>;

export const kioskChargeInput = z
  .object({ operationId: id, statusKey })
  .strict();
export const kioskStatusInput = z.object({ statusKey }).strict();
export const kioskCancelChargeInput = z
  .object({ operationId: id, statusKey })
  .strict();
export const kioskPairInput = z
  .object({
    operationId: id,
    code: z.string().regex(/^[0-9]{8}$/),
  })
  .strict();
export const kioskHeartbeatInput = z
  .object({
    build: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
    viewport: z.enum(["landscape", "portrait"]),
  })
  .strict();
export const kioskMemberInput = z
  .object({
    phone: z.string().regex(/^[0-9]{10}$/),
    country: z.enum(["MX", "US"]).default("MX"),
  })
  .strict();

export const kioskSettingsInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(0),
    paymentMode: z.enum(PAYMENT_MODES),
    askFulfillment: z.boolean(),
    suggestions: z.boolean(),
    loyaltyAtKiosk: z.boolean(),
  })
  .strict();
export const kioskStationInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(1),
    terminalId: id.nullable(),
    registerDeviceId: id.nullable(),
  })
  .strict();
export const kioskRevokeDeviceInput = z.object({ operationId: id }).strict();
export const suggestionsInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(0),
    productIds: z.array(id).max(KIOSK_LIMITS.cartSuggestions),
  })
  .strict()
  .refine((p) => new Set(p.productIds).size === p.productIds.length, {
    message: "duplicate",
    path: ["productIds"],
  });

// ---- wire views ------------------------------------------------------------------------------

/** The `kiosk` block of GET /api/public/menu for a kiosk link (§4.2). */
export type KioskMenuBlock = {
  bound: boolean;
  /** Self-checkout available: flag, device bound to this station, receiving till open. */
  selfCheckout: boolean;
  card: boolean;
  paymentMode: KioskPaymentMode;
  askFulfillment: boolean;
  suggestions: {
    cart: string[];
    byProduct: Record<string, string[]>;
    popular: string[];
  };
  loyalty: { enabled: true; stampsRequired: number; reward: string } | null;
  stationLabel: string;
};

/** The diner's view of an attempt, without provider detail (critic R11). */
export type KioskPaymentState =
  | "none"
  | "pending"
  | "approved"
  | "declined"
  | "cancelled"
  | "expired"
  | "review"
  | "settled";

export type KioskCheckoutView = {
  label: string;
  holdState: "pending" | "accepted" | "rejected" | "cancelled" | "expired";
  orderNumber: number | null;
  total: number;
  paymentChoice: "card" | "counter" | null;
  payment: {
    state: KioskPaymentState;
    attempts: number;
    /** The attempt may still be taken on the reader after a cancel request ("sigue procesando"). */
    cancelRequested: boolean;
    amount: number | null;
  };
  /** The order is paid in full. */
  paid: boolean;
  /** Approved at the reader, but the order could not be created: "Pasa a caja con tu código". */
  paidNoOrder: boolean;
  folio: string | null;
  selfInvoiceCode: string | null;
  loyalty: null | {
    member: boolean;
    stampsEarned: number;
    stamps: number;
    required: number;
    rewards: number;
  };
  joinOffer: null | { url: string; expiresAt: string };
};

export type KioskSubmitResult = {
  /** The hold as the diner pages show it (the counter-code screen reads its label and policy). */
  hold: DinerHoldView;
  checkout: KioskCheckoutView;
  /** Why the kiosk could not take the payment itself: the guest pays at the counter. */
  counterOnly:
    null | "unbound" | "till_closed" | "disabled" | "no_terminal" | "mode";
  /** The order carries the member the guest identified (the counter screen's stamp line). */
  member: boolean;
};

/**
 * Why a kiosk station cannot take the card (KIOSK-UX-10; critic R14: "card: false plus a settings
 * warning"). The kiosk's own counterOnly reasons (kioskState), with the terminal's provider split
 * out as /capabilities reports it (worker_not_configured, not_connected, verifying, a failure code).
 */
export type KioskCardOff =
  | {
      reason:
        | "disabled"
        | "unbound"
        | "no_till"
        | "till_closed"
        | "mode"
        | "no_terminal";
    }
  | { reason: "provider"; provider: "mercadopago" | "clip"; detail: string };

/**
 * The station row's card warning (pure; tests/kiosk.test.ts), in kioskState's order: the server
 * switch, the paired tablet, the receiving till, the payment mode, then the terminal (active, not
 * archived, integrated) and its provider (served by the worker, account active).
 */
export function stationCardOff(s: {
  enabled: boolean;
  paymentMode: KioskPaymentMode;
  paired: boolean;
  till: "none" | "open" | "closed";
  terminal: null | {
    usable: boolean;
    provider: "mercadopago" | "clip" | null;
  };
  providers: Record<
    "mercadopago" | "clip",
    { enabled: boolean; reason?: string }
  >;
}): KioskCardOff | null {
  if (!s.enabled) return { reason: "disabled" };
  if (!s.paired) return { reason: "unbound" };
  if (s.till === "none") return { reason: "no_till" };
  if (s.till === "closed") return { reason: "till_closed" };
  if (s.paymentMode === "counter") return { reason: "mode" };
  if (!s.terminal?.usable || !s.terminal.provider)
    return { reason: "no_terminal" };
  const cap = s.providers[s.terminal.provider];
  if (!cap.enabled)
    return {
      reason: "provider",
      provider: s.terminal.provider,
      detail: cap.reason ?? "not_connected",
    };
  return null;
}

export type KioskStationView = {
  id: string;
  version: number;
  linkId: string | null;
  label: string;
  terminalId: string | null;
  registerDeviceId: string | null;
  tillOpen: boolean;
  /** Why this station's kiosk offers only «Pagar en caja» (KIOSK-UX-10); null: it takes cards. */
  cardOff: KioskCardOff | null;
  device: null | {
    id: string;
    state: "pending" | "paired";
    pairingExpiresAt: string | null;
    lastSeenAt: string | null;
    build: string | null;
    viewport: "landscape" | "portrait" | null;
  };
};

export type KioskSettingsView = {
  settings: {
    paymentMode: KioskPaymentMode;
    askFulfillment: boolean;
    suggestions: boolean;
    loyaltyAtKiosk: boolean;
    version: number;
  };
  stations: KioskStationView[];
  terminals: { id: string; name: string; kind: string; integrated: boolean }[];
  tills: { id: string; name: string; open: boolean }[];
  cartSuggestions: { productIds: string[]; version: number };
  loyaltyAvailable: boolean;
  selfCheckoutEnabled: boolean;
};

export type KioskUnpaidView = never;

export type KioskMemberResult =
  | { found: false }
  | {
      found: true;
      memberToken: string;
      maskedPhone: string;
      stamps: number;
      required: number;
      rewards: number;
    };

export type KioskMemberCountry = LoyaltyCountry;

// ---- pure rules ------------------------------------------------------------------------------

/** What the diner sees of a payments attempt state (critic R9 names; never provider detail). */
export function kioskPaymentState(
  state: string | null | undefined,
): KioskPaymentState {
  switch (state) {
    case undefined:
    case null:
      return "none";
    case "created":
    case "sending":
    case "pending":
    case "unknown":
      return "pending";
    case "approved":
      return "approved";
    case "settled":
      return "settled";
    case "declined":
      return "declined";
    case "cancelled":
    case "dismissed":
      return "cancelled";
    case "expired":
      return "expired";
    case "review":
      return "review";
    default:
      return "pending";
  }
}

/** Whether the kiosk may offer card, and which buttons the pay screen shows. */
export function payButtons(o: {
  selfCheckout: boolean;
  card: boolean;
  paymentMode: KioskPaymentMode;
  attempts: number;
  failedOnce: boolean;
}): { card: boolean; counter: boolean } {
  const card =
    o.selfCheckout &&
    o.card &&
    o.paymentMode !== "counter" &&
    o.attempts < KIOSK_LIMITS.attempts;
  // card_first: the counter appears only after a card failure (or when card cannot run).
  const counter = !card || o.paymentMode !== "card_first" || o.failedOnce;
  return { card, counter };
}

/**
 * Suggestions to show (§2.8): curated before popular, never a product already in the cart, an
 * unavailable, archived or open-price one, or the source product itself; at most `max`.
 */
export function pickSuggestions(
  candidates: readonly string[],
  o: {
    inCart: ReadonlySet<string>;
    sellable: ReadonlySet<string>;
    exclude?: string;
    max?: number;
  },
): string[] {
  const out: string[] = [];
  for (const id of candidates) {
    if (out.length >= (o.max ?? KIOSK_LIMITS.shownSuggestions)) break;
    if (id === o.exclude || o.inCart.has(id) || !o.sellable.has(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** The kiosk's idle deadline for the current screen (ms after the last touch). */
export function idleDeadline(
  screen:
    "welcome" | "menu" | "pay" | "charging" | "done_paid" | "done_counter",
  o: { cartEmpty: boolean },
): { warnAt: number | null; resetAt: number | null } {
  if (screen === "welcome") return { warnAt: null, resetAt: null };
  if (screen === "charging")
    return { warnAt: null, resetAt: KIOSK_IDLE.chargeSuspendMaxMs };
  if (screen === "pay")
    return { warnAt: KIOSK_IDLE.payWarnAfterMs, resetAt: KIOSK_IDLE.payResetMs };
  if (screen === "done_paid")
    return { warnAt: null, resetAt: KIOSK_IDLE.donePaidMs };
  if (screen === "done_counter")
    return { warnAt: null, resetAt: KIOSK_IDLE.doneCounterMs };
  return o.cartEmpty
    ? { warnAt: null, resetAt: KIOSK_IDLE.resetAfterMs }
    : { warnAt: KIOSK_IDLE.warnAfterMs, resetAt: KIOSK_IDLE.resetAfterMs };
}

/**
 * The «Soy del club» keypad's display (KIOSK-UX-16): one dot per digit typed, the last four shown
 * from the fourth digit on (never the number in full), and a count of 10: "••• · 3/10",
 * "•••••• 45 21 · 10/10". Every tap changes it.
 */
export function typedPhoneDisplay(digits: string): string {
  const d = digits.replace(/\D/g, "").slice(0, 10);
  const shown =
    d.length < 4
      ? "•".repeat(d.length)
      : `${"•".repeat(d.length - 4)} ${d.slice(-4, -2)} ${d.slice(-2)}`.trim();
  return `${shown} · ${d.length}/10`;
}

/** "•• •• •• 45 21": the last four digits of the typed phone, never echoed in full. */
export function maskTypedPhone(digits: string): string {
  const d = digits.replace(/\D/g, "");
  if (d.length < 4) return "•• •• ••";
  return `•• •• •• ${d.slice(-4, -2)} ${d.slice(-2)}`;
}

/** The kiosk's label for a hold-target attempt everywhere staff see it (payments' holdLabel). */
export const kioskReasonLabel: Record<KioskSettleCode, Label> = {
  kiosk_settle_unavailable: {
    es: "un producto ya no está disponible",
    en: "an item is no longer available",
  },
  kiosk_settle_price_changed: {
    es: "cambió un precio",
    en: "a price changed",
  },
  kiosk_settle_invalid_modifier: {
    es: "una opción ya no está disponible",
    en: "an option is no longer available",
  },
  kiosk_settle_insufficient_stock: {
    es: "no alcanza el inventario",
    en: "not enough stock",
  },
  kiosk_settle_pro_required: {
    es: "el plan ya no incluye el kiosco",
    en: "the plan no longer includes the kiosk",
  },
  kiosk_settle_hold_closed: {
    es: "el pedido ya estaba cerrado",
    en: "the order was already closed",
  },
  kiosk_settle_other: {
    es: "otro motivo",
    en: "another reason",
  },
};
