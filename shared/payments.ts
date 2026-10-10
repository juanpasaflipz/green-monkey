// Payments (Wave 4, migration 037): tender methods, terminals, platforms and
// platform price lists, attempt states, request schemas and pure helpers shared
// by the server and the client. Leaf module: zod and ./domain.js only.
import { z } from "zod";
import {
  id,
  listPrice,
  money,
  PRICE_PLATFORMS,
  type Label,
  type PricePlatform,
} from "./domain.js";

/**
 * Every value of tenders.method (037's tenders_method_check). Readers map these
 * exhaustively and never default an unknown value to cash (spec §11.2;
 * tests/payments-shared.test.ts scans server/ and shared/ for that pattern).
 * Integrated terminal tenders are "external". Loyalty's stamp base imports this
 * list (critic R15).
 */
export const TENDER_METHODS = ["cash", "external", "platform"] as const;
export type TenderMethod = (typeof TENDER_METHODS)[number];
export function isTenderMethod(value: unknown): value is TenderMethod {
  return (TENDER_METHODS as readonly unknown[]).includes(value);
}
export const PROVIDERS = ["mercadopago", "clip"] as const;
export type Provider = (typeof PROVIDERS)[number];
/** Delivery platforms (and their price lists, LD-72); declared in shared/domain.ts. */
export const PLATFORMS = PRICE_PLATFORMS;
export type PlatformCode = PricePlatform;
export const TERMINAL_KINDS = [
  "manual",
  "mercadopago_point",
  "clip_pinpad",
] as const;
export type TerminalKind = (typeof TERMINAL_KINDS)[number];
export const CARD_TYPES = ["credit", "debit", "prepaid"] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const PAYMENTS_LIMITS = {
  /** Active (not archived) terminals per restaurant. */
  terminals: 20,
  /** Minor units, MXN 5.00 (pos-lite MP_POINT_MIN_AMOUNT, observed API 400). */
  mpMinAmount: 500,
  /** MP Orders expiration_time by attempt origin (critic R10; MP accepts 30 s to 3 h). */
  mpExpiration: { pos: "PT10M", kiosk: "PT5M" },
  /**
   * The worker's reads of a fresh charge (the first pollFastForMs), per provider (P2-PROVIDERS-8).
   * MP every 5 s: its signed notifications already make the worker read at once, and its rate
   * limit (429) is per access token, shared by every live charge of the restaurant (pos-lite
   * throttled to one read per 5 s per payment after hitting it). Clip every 2 s.
   */
  pollFastMs: { mercadopago: 5000, clip: 2000 },
  pollFastForMs: 180_000,
  pollSlowMs: 10_000,
  unknownAfterExpiryMs: 120_000,
  /**
   * An MP create answered only with 429 made no order (P2-PROVIDERS-8): the push waits these
   * (or MP's Retry-After when longer) between its three tries, about 30 s in all, and then
   * declines it (payments_provider_unavailable: the cashier's manual fallback). A wait that
   * would take the whole back-off past mpRateLimitBudgetMs declines at once.
   */
  mpRateLimitWaitsMs: [10_000, 20_000],
  mpRateLimitBudgetMs: 40_000,
  /**
   * Clip requests never expire (developer.clip.mx documents no lifetime; wave4 R10): after this
   * long the worker withdraws the request (DELETE /payment/{id}); if the reader already holds it,
   * the attempt is unknown and read every clipWatchMs until the reader settles it.
   */
  clipDeadlineMs: { pos: 600_000, kiosk: 300_000 },
  clipWatchMs: 60_000,
  /**
   * A delete by serial number counts as «nothing of this attempt waits on the reader» only when
   * sent this long after the create (P2V-FIXES-2): longer than the worker's 15 s provider timeout
   * plus the time Clip's create may still spend reaching the reader (its create waits on the
   * reader: 400 PINPAD_TERMINAL_TIMEOUT_EXCEPTION). An earlier one queues a second, settled one.
   */
  clipSerialSettleMs: 60_000,
  /**
   * After a manager's «No se cobró» of a charge with a provider reference, the worker keeps
   * reading it this often for this long (P2V-FIXES-2/-3): a payment the provider takes later is
   * a late approval (event, critical alert, Excepciones), never silently lost.
   */
  lateWatchMs: 300_000,
  lateWatchForMs: 86_400_000,
  /**
   * A worker that serves no provider (PAYMENTS_PROVIDERS unset while charges are live) still
   * carries each pending charge to its deadline, one poll link this often (P2V-GATE-4).
   */
  providersOffPollMs: 60_000,
  dialogSyncMs: 1500,
  webhookPerIpPerMinute: 120,
  webhookPerHookPerMinute: 600,
  webhookBodyBytes: 16_384,
  /** Basis points: 20 % (card fee) and 50 % (platform commission). */
  feeBpMax: 2000,
  commissionBpMax: 5000,
  /** A platform order number typed at payment (tenders.external_reference). */
  platformReferenceMax: 40,
} as const;

export const ATTEMPT_STATES = [
  "created",
  "sending",
  "pending",
  "approved",
  "settled",
  "declined",
  "cancelled",
  "expired",
  "unknown",
  "review",
  "dismissed",
] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];
/** The terminal may be showing a charge (037 payment_attempts_terminal_live). */
export const LIVE_FOR_TERMINAL = [
  "created",
  "sending",
  "pending",
  "unknown",
] as const satisfies readonly AttemptState[];
/** Money may be in flight for the order or hold and its drawer (037 *_live indexes). */
export const LIVE_FOR_ORDER = [
  ...LIVE_FOR_TERMINAL,
  "approved",
  "review",
] as const satisfies readonly AttemptState[];
export const FINAL_ATTEMPT_STATES = [
  "settled",
  "declined",
  "cancelled",
  "expired",
  "dismissed",
] as const satisfies readonly AttemptState[];
/**
 * The transitions 037's payment_attempts_transition trigger allows, by actor
 * (tests/payments-shared.test.ts parses the migration and compares).
 */
export const ATTEMPT_TRANSITIONS: {
  worker: readonly (readonly [AttemptState, AttemptState])[];
  web: readonly (readonly [AttemptState, AttemptState])[];
} = {
  worker: [
    ["created", "sending"],
    ["sending", "pending"],
    ["sending", "declined"],
    ["sending", "unknown"],
    ["pending", "approved"],
    ["pending", "declined"],
    ["pending", "cancelled"],
    ["pending", "expired"],
    ["pending", "unknown"],
    ["unknown", "pending"],
    ["unknown", "approved"],
    ["unknown", "declined"],
    ["unknown", "cancelled"],
    ["unknown", "expired"],
  ],
  web: [
    ["created", "cancelled"],
    ["approved", "settled"],
    ["approved", "review"],
    ["review", "settled"],
    ["review", "dismissed"],
    ["unknown", "settled"],
    ["unknown", "dismissed"],
  ],
};
export function isLiveForOrder(state: string): boolean {
  return (LIVE_FOR_ORDER as readonly string[]).includes(state);
}
export function isLiveForTerminal(state: string): boolean {
  return (LIVE_FOR_TERMINAL as readonly string[]).includes(state);
}
/**
 * Kiosk's synchronous view of a cancel request (critic R10): withdrawn when the
 * provider confirmed it, in_progress when the reader took the charge, any other
 * final state already_final, otherwise pending_cancel (keep polling).
 */
export function cancelOutcome(attempt: {
  state: string;
  error_code?: string | null;
}): "withdrawn" | "in_progress" | "already_final" | "pending_cancel" {
  if (attempt.state === "cancelled") return "withdrawn";
  if (
    attempt.state === "pending" &&
    attempt.error_code === "payments_cancel_on_terminal"
  )
    return "in_progress";
  if (
    (FINAL_ATTEMPT_STATES as readonly string[]).includes(attempt.state) ||
    attempt.state === "approved" ||
    attempt.state === "review"
  )
    return "already_final";
  return "pending_cancel";
}

/** Card fees apply to what was charged (amount + tip); platform commissions to the amount. */
export function estimateFee(base: number, bp: number | null): number | null {
  if (bp === null) return null;
  // half-up, integer minor units (exact in BigInt for any money value)
  return Number((BigInt(base) * BigInt(bp) + 5000n) / 10000n);
}
/** Minor units to the provider's 2-decimal string ("236.00"). */
export function minorToDecimal(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0) throw new Error("invalid_amount");
  const units = Math.floor(minor / 100);
  const cents = String(minor % 100).padStart(2, "0");
  return `${units}.${cents}`;
}
/** A percentage typed in Configuración ("4.18") as basis points (418), or null when empty. */
export function percentToBp(text: string, max: number): number | null {
  const t = text.trim().replace(",", ".");
  if (!t) return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) throw new Error("invalid_percent");
  const [whole, frac = ""] = t.split(".");
  const bp = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (bp > max) throw new Error("invalid_percent");
  return bp;
}
export function bpToPercent(bp: number | null | undefined): string {
  if (bp === null || bp === undefined) return "";
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  return frac ? `${whole}.${String(frac).padStart(2, "0")}` : String(whole);
}

/**
 * LD-75 (PAYMENTS-SECURITY-1): Uber Eats, Rappi and DiDi tenders carry the platform's order
 * number; «Otra» names its platform instead, and its number stays optional.
 */
export const PLATFORMS_WITH_ORDER_NUMBER: readonly PlatformCode[] = [
  "uber_eats",
  "rappi",
  "didi_food",
];
/** A light format check of a platform order number: letters, digits, spaces, # and -. */
const PLATFORM_ORDER_NUMBER = /^#?[\p{L}\p{N}][\p{L}\p{N} #-]*$/u;
/**
 * The problem with a platform tender's order number, or null: required (2 to 40 characters of
 * the format above) for the platforms that issue one; for «Otra» only the 40-character limit.
 */
export function platformReferenceProblem(
  platform: PlatformCode,
  reference: string,
): "payments_platform_reference_required" | null {
  const value = reference.trim();
  if (value.length > PAYMENTS_LIMITS.platformReferenceMax)
    return "payments_platform_reference_required";
  if (!PLATFORMS_WITH_ORDER_NUMBER.includes(platform)) return null;
  return value.length >= 2 && PLATFORM_ORDER_NUMBER.test(value)
    ? null
    : "payments_platform_reference_required";
}

/**
 * PAYMENTS-UX-15: the platform order number inside an order name such as «DiDi 4F2A» or
 * «Uber #4F2A1» (the name the kitchen and the courier use): the name without the platform's
 * word, when what is left reads as an order number; else "".
 */
export function referenceFromName(name: string): string {
  const rest = name
    .replace(/\b(uber\s*eats|uber|rappi|didi\s*food|didi)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return rest &&
    rest !== name.trim() &&
    !platformReferenceProblem("didi_food", rest)
    ? rest
    : "";
}

export const PLATFORM_NAMES: Record<PlatformCode, Label> = {
  uber_eats: { es: "Uber Eats", en: "Uber Eats" },
  rappi: { es: "Rappi", en: "Rappi" },
  didi_food: { es: "DiDi Food", en: "DiDi Food" },
  other: { es: "Otra", en: "Other" },
};
/** The platform's display name: "Otra" shows its typed label when there is one. */
export function platformLabel(
  platform: string | null | undefined,
  label: string | null | undefined,
  locale: "es" | "en",
): string {
  if (platform === "other" && label?.trim()) return label.trim();
  const known = PLATFORM_NAMES[platform as PlatformCode];
  return known ? known[locale] : String(platform ?? "");
}

/** Platform prices of one product (LD-72): absent = the POS price. */
export type PlatformPrices = Partial<Record<PlatformCode, number>>;
export { listPrice };

export const paymentMethodInput = z.enum(TENDER_METHODS);
/**
 * New optional payment fields have NO .default(): JSON.stringify omits
 * undefined, so the hash of an old payload (once(), payment recovery
 * fingerprints) is unchanged (spec G9).
 */
export const tenderExtras = {
  terminalId: id.optional(),
  platform: z.enum(PLATFORMS).optional(),
  platformLabel: z.string().trim().min(1).max(40).optional(),
};

/** Integrated start (P2). */
export const startChargeInput = z
  .object({
    operationId: id,
    orderId: id,
    terminalId: id,
    amount: money.refine((n) => n > 0),
    tip: money.default(0),
    items: z
      .array(z.string().regex(/^[0-9a-f-]{36}:\d{1,2}$/i))
      .min(1)
      .max(9900)
      .optional(),
  })
  .strict();
/** Manager resolution of an unknown or review attempt (P2; critic R13 adds retry). */
export const resolveAttemptInput = z
  .object({
    operationId: id,
    outcome: z.enum([
      "check",
      "retry",
      "record",
      "not_charged",
      "refunded_at_provider",
    ]),
    reference: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .optional(),
    note: z.string().trim().min(10).max(500).optional(),
    confirmed: z.literal(true).optional(),
    /** record from unknown: the amount the provider's history shows (minor units, tip included);
     *  it must equal the attempt's amount + tip (spec §4.3 step 3). */
    charged: z.number().int().min(1).max(100_000_000).optional(),
  })
  .strict();

/**
 * Provider credentials typed by the owner (spec §9.1): loose, length-bounded format checks only;
 * the provider's own verification (in the worker) decides validity. A parse failure is reported
 * as payments_credentials_invalid_format and never echoes a value.
 */
export const mpCredentialsInput = z
  .object({
    accessToken: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{20,400}$/),
    webhookSecret: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{16,128}$/),
  })
  .strict();
export const clipCredentialsInput = z
  .object({
    apiKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{8,200}$/),
    secretKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{8,200}$/),
  })
  .strict();
export const deviceModeInput = z
  .object({ operationId: id, mode: z.enum(["PDV", "STANDALONE"]) })
  .strict();
/** A provider account as Configuración shows it (never a secret, a token or its hash). */
export type ProviderAccountView = {
  provider: Provider;
  /** The worker serves this provider (PAYMENTS_PROVIDERS). */
  available: boolean;
  state: "not_connected" | "verifying" | "active" | "failed" | "disabled";
  label: string | null;
  verifiedAt: string | null;
  errorCode: string | null;
};
export type ProviderDeviceView = {
  provider: Provider;
  deviceId: string;
  operatingMode: "PDV" | "STANDALONE" | null;
  status: string | null;
  seenAt: string;
  /** The active terminal configured on this device, if any. */
  terminalId: string | null;
};
export type ProvidersView = {
  accounts: ProviderAccountView[];
  devices: ProviderDeviceView[];
};
/** POST …/credentials reply: the notification URL is shown once (no-store). */
export type CredentialsSaved = {
  provider: Provider;
  state: "verifying";
  webhookUrl: string;
};
/** Connectivity dot of an integrated terminal chip (spec §5.1 TerminalPicker). */
export type TerminalStatus = "online" | "offline" | "no_data";

const terminalName = z.string().trim().min(1).max(40);
const feeBp = z.number().int().min(0).max(PAYMENTS_LIMITS.feeBpMax).nullable();
/**
 * An integrated device id (MP terminal id, Clip serial): never "." or "..", which a URL path
 * would collapse (Clip's DELETE /payment/serial-number/{serial}; P2-SECURITY-5).
 */
export const DEVICE_ID = /^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,100}$/;

/** Manual terminals in P1; integrated kinds need an active provider account (P2). */
export const saveTerminalInput = z
  .object({
    operationId: id,
    terminalId: id.optional(),
    expectedVersion: z.number().int().min(1).optional(),
    name: terminalName,
    kind: z.enum(TERMINAL_KINDS).default("manual"),
    providerDeviceId: z.string().regex(DEVICE_ID).optional(),
    feeBp,
    active: z.boolean().default(true),
  })
  .strict();
export const archiveTerminalInput = z
  .object({ operationId: id, expectedVersion: z.number().int().min(1) })
  .strict();
export const savePlatformsInput = z
  .object({
    operationId: id,
    platforms: z
      .array(
        z
          .object({
            platform: z.enum(PLATFORMS),
            enabled: z.boolean(),
            commissionBp: z
              .number()
              .int()
              .min(0)
              .max(PAYMENTS_LIMITS.commissionBpMax)
              .nullable(),
            expectedVersion: z.number().int().min(0),
          })
          .strict(),
      )
      .min(1)
      .max(PLATFORMS.length),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.platforms.map((p) => p.platform)).size === v.platforms.length,
    { message: "duplicate_platform" },
  );
export const savePlatformPricesInput = z
  .object({
    operationId: id,
    prices: z
      .array(
        z
          .object({
            productId: id,
            platform: z.enum(PLATFORMS),
            /** null clears it: the product sells at its POS price on that platform. */
            price: money.nullable(),
            expectedVersion: z.number().int().min(0),
          })
          .strict(),
      )
      .min(1)
      .max(400),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.prices.map((p) => `${p.productId}:${p.platform}`)).size ===
      v.prices.length,
    { message: "duplicate_price" },
  );
export const setDeviceTerminalInput = z
  .object({ operationId: id, terminalId: id.nullable() })
  .strict();

/** An integrated charge attempt as the dialog, banner and resolve dialog see it (P2). */
export type AttemptView = {
  id: string;
  state: AttemptState;
  target: "order" | "kiosk_hold";
  origin: "pos" | "kiosk";
  orderId: string | null;
  holdId: string | null;
  /** The order's number, or null for a hold target (labelled by holdLabel). */
  orderNumber: number | null;
  /** "Kiosco · K-14" for a hold target (critic R8). */
  holdLabel: string | null;
  terminalId: string;
  terminalLabel: string;
  provider: Provider;
  amount: number;
  tip: number;
  /** Total the provider reports charged (tip included), once approved. */
  paidAmount: number | null;
  providerReference: string | null;
  providerStatus: string | null;
  cardType: CardType | null;
  cardBrand: string | null;
  cardLast4: string | null;
  errorCode: string | null;
  cancelRequested: boolean;
  resolution: string | null;
  createdAt: string;
  decidedAt: string | null;
};
/** Attempt states the payment dialog stops waiting on. */
export function isAttemptFinal(state: string): boolean {
  return (FINAL_ATTEMPT_STATES as readonly string[]).includes(state);
}

/** A terminal as the payment dialog sees it (fees only for managers). */
export type TerminalOption = {
  id: string;
  name: string;
  kind: TerminalKind;
  feeBp?: number | null;
  /** Integrated charging available now (P2); false in P1 and offline. */
  integrated: boolean;
  /** Integrated terminals: the provider's last device report (P2). */
  status?: TerminalStatus;
};
export type PlatformOption = {
  platform: PlatformCode;
  commissionBp?: number | null;
  /**
   * The platform has a price of its own for some product (LD-75): its tender is accepted only on
   * an order rung at its price list. Absent on an options cache older than this field.
   */
  hasPrices?: boolean;
};
/** GET /payments/options: what PaymentDialog needs (cached per tenant for offline use). */
export type PaymentOptions = {
  terminals: TerminalOption[];
  platforms: PlatformOption[];
  defaultTerminalId: string | null;
  integratedAvailable: boolean;
};
export type TerminalSettingsRow = {
  id: string;
  name: string;
  kind: TerminalKind;
  providerDeviceId: string | null;
  feeBp: number | null;
  active: boolean;
  archivedAt: string | null;
  version: number;
  defaultOn: string[];
};
export type PlatformSettingsRow = {
  platform: PlatformCode;
  enabled: boolean;
  commissionBp: number | null;
  version: number;
};
export type PlatformPriceRow = {
  productId: string;
  platform: PlatformCode;
  price: number | null;
  version: number;
};
/** GET /payments/settings (managers). */
export type PaymentSettingsView = {
  terminals: TerminalSettingsRow[];
  platforms: PlatformSettingsRow[];
  prices: PlatformPriceRow[];
  devices: { id: string; name: string; terminalId: string | null }[];
};
