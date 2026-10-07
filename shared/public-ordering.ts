// Public QR/kiosk ordering (032): constants, request schemas, wire views and
// pure helpers shared by the diner page, the staff screens and the server.
// Leaf module: zod and ./domain.js only.
import { z } from "zod";
import { id, money, type Label, type Product } from "./domain.js";

/** A link token or a diner's status key: 16 random bytes, base64url (128 bits). */
export const PUBLIC_TOKEN = /^[A-Za-z0-9_-]{22}$/;
/** Request headers that carry the tokens ("token" matches the log redaction rule). */
export const LINK_HEADER = "x-gm-link-token";
export const STATUS_HEADER = "x-gm-status-token";
export const HOLD_MINUTES = [10, 15, 20, 30, 45, 60, 90, 120] as const;
/**
 * How long after expires_at a pay-first hold can still be accepted with its
 * payment ("Cobrar y enviar a cocina", target "new"). The cashier charges an
 * external terminal before the accept is sent, so a hold that expires while
 * the payment dialog is open must not leave a charged diner with no order
 * (LD-41, PUBLIC-MONEY-2 option a). Every other decision, and the diner's
 * cancel, still stops at expires_at.
 */
export const PAID_ACCEPT_GRACE_SECONDS = 300;
/**
 * A pending hold reads as expired to its diner only this long after
 * expires_at: an accept that locked the hold just before expiry may commit a
 * moment after it (CONCURRENCY-2), and a pay-first hold can still be collected
 * for PAID_ACCEPT_GRACE_SECONDS, so the diner must not see "vencido" while
 * staff can still accept it (LD-41).
 */
export const HOLD_EXPIRY_GRACE_SECONDS = PAID_ACCEPT_GRACE_SECONDS;
export const PUBLIC_LIMITS = {
  /** Per scope (a table across its links, or a link): pending holds, holds
   * created per window, and diner cancellations per window (churn). */
  table: { pending: 3, perWindow: 8, cancelsPerWindow: 4 },
  counter: { pending: 10, perWindow: 30, cancelsPerWindow: 10 },
  kiosk: { pending: 5, perWindow: 30, cancelsPerWindow: 10 },
  windowMinutes: 15,
  tenantPending: 40,
  maxLines: 40,
  maxQuantity: 20,
  activeLinks: { counter: 5, kiosk: 10 },
  staffOnlineSeconds: 300,
  bulkTables: 100,
  minOrderTotal: 10_000,
  maxOrderTotal: 10_000_000,
} as const;
export const KIOSK_TIMING = {
  warnAfterMs: 75_000,
  resetAfterMs: 90_000,
  doneResetMs: 20_000,
} as const;
export const STATUS_POLL = {
  fastMs: 5_000,
  fastForMs: 120_000,
  slowMs: 15_000,
  acceptedMs: 20_000,
  maxMs: 3 * 3600_000,
} as const;
/** Defaults used while a restaurant has no public_ordering_settings row. */
export const ORDERING_DEFAULTS = {
  paused: false,
  tablePolicy: "accept",
  counterPolicy: "accept",
  holdMinutes: 30,
  maxOrderTotal: 1_000_000,
} as const;

export type LinkKind = "table" | "counter" | "kiosk";
export type HoldPolicy = "accept" | "pay_first";
export type HoldState =
  "pending" | "accepted" | "rejected" | "cancelled" | "expired";
export const REJECT_REASONS = [
  "unavailable",
  "duplicate",
  "not_present",
  "closed",
  "abuse",
  "other",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** One diner line: no note and no open amount (open-price items are POS only). */
export const publicLineInput = z
  .object({
    id,
    productId: id,
    quantity: z.number().int().min(1).max(PUBLIC_LIMITS.maxQuantity),
    options: z.array(id).max(30).default([]),
  })
  .strict();
export type PublicLine = z.infer<typeof publicLineInput>;
/**
 * Characters a diner's name never carries: C0 controls, DEL, C1 controls and
 * the bidi overrides and isolates (U+202A-U+202E, U+2066-U+2069). A NUL would
 * reach Postgres as a 500 (22021), and an override can make the call name
 * "Q-14 · …" read as another diner's label on the KDS and the receipt
 * (PUBLIC-SECURITY-1; cfdi's portal rejects the same controls).
 */
/* eslint-disable no-control-regex */
export const DINER_NAME_FORBIDDEN =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
/** The note is a textarea: the same set, except line feed and tab. */
export const DINER_NOTE_FORBIDDEN =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
/* eslint-enable no-control-regex */
export const publicOrderInput = z
  .object({
    operationId: id,
    statusKey: z.string().regex(PUBLIC_TOKEN),
    lines: z.array(publicLineInput).min(1).max(PUBLIC_LIMITS.maxLines),
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
  })
  .strict();
export type PublicOrderInput = z.infer<typeof publicOrderInput>;

export const linkCreateInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("table"), tableId: id }).strict(),
  z
    .object({
      kind: z.literal("counter"),
      label: z.string().trim().min(1).max(60),
    })
    .strict(),
  z
    .object({
      kind: z.literal("kiosk"),
      label: z.string().trim().min(1).max(60),
    })
    .strict(),
]);
export const tableLinksInput = z
  .object({
    tableIds: z.array(id).min(1).max(PUBLIC_LIMITS.bulkTables),
    replaceExisting: z.boolean().default(false),
  })
  .strict();
export const linkRevokeInput = z.object({ operationId: id }).strict();
export const settingsInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(0),
    tablePolicy: z.enum(["accept", "pay_first"]),
    counterPolicy: z.enum(["accept", "pay_first"]),
    holdMinutes: z
      .number()
      .int()
      .refine((v) => (HOLD_MINUTES as readonly number[]).includes(v)),
    maxOrderTotal: money
      .min(PUBLIC_LIMITS.minOrderTotal)
      .max(PUBLIC_LIMITS.maxOrderTotal),
  })
  .strict();
export const pauseInput = z
  .object({ operationId: id, paused: z.boolean() })
  .strict();
/**
 * Service's paymentInput without items and without operationId: acceptHold
 * passes a server-fresh operationId (lock order LO-R5) and recordPayment
 * re-parses the result. The accept's own operationId makes the payment
 * idempotent.
 */
export const holdPaymentInput = z
  .object({
    amount: money.refine((n) => n > 0),
    tip: money.default(0),
    received: money,
    method: z.enum(["cash", "external"]),
    externalConfirmed: z.boolean().default(false),
    reference: z.string().max(120).default(""),
  })
  .strict();
export const acceptInput = z
  .object({
    operationId: id,
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("new") }).strict(),
      z
        .object({
          kind: z.literal("append"),
          orderId: id,
          expectedVersion: z.number().int(),
        })
        .strict(),
    ]),
    excludeLineIds: z.array(id).max(PUBLIC_LIMITS.maxLines).default([]),
    /**
     * The current total of the included lines that the card showed (MONEY-1).
     * The server refuses with public_hold_price_changed when it differs from
     * the total it would charge; it is required when that total differs from
     * the diner's.
     */
    acknowledgedTotal: money.nullable().default(null),
    /** Staff verified a hold whose code was deactivated for abuse (ABUSE-1). */
    abuseAcknowledged: z.boolean().default(false),
    payment: holdPaymentInput.optional(),
  })
  .strict();
export const rejectInput = z
  .object({
    operationId: id,
    reason: z.enum(REJECT_REASONS),
    revokeLink: z.boolean().default(false),
  })
  .strict();

// ---- wire views ---------------------------------------------------------

export type PricedHoldLine = {
  id: string;
  quantity: number;
  name: Label;
  optionNames: Label[];
  unitPrice: number;
  total: number;
};
export type OrderingState = {
  open: boolean;
  reason: null | "paused" | "table_unavailable";
  policy: HoldPolicy;
  holdMinutes: number;
  maxTotal: number;
};
export type PublicMenuView = {
  link: {
    kind: LinkKind;
    channel: "qr" | "kiosk";
    tableName: string | null;
    label: string;
  };
  restaurant: {
    name: string;
    currency: string;
    timezone: string;
    privacyNoticeUrl: string | null;
  };
  ordering: OrderingState;
  revision: number;
  /** publicCatalog: no recipe, cost, open-price or archived products. */
  catalog: Product[];
};
export type DinerHoldView = {
  /** Lets the status page render even when its link was replaced since. */
  restaurant: { name: string; currency: string; timezone: string };
  label: string;
  state: HoldState;
  kind: LinkKind;
  policy: HoldPolicy;
  createdAt: string;
  expiresAt: string;
  /** Accepted: the prices acceptance charged (PRIVACY-1); otherwise the submitted ones. */
  lines: (PricedHoldLine & { excluded: boolean })[];
  total: number;
  /** Accepted at a total that differs from the one the diner sent. */
  priceChanged: boolean;
  rejectReason: Exclude<RejectReason, "abuse"> | null;
  order: null | {
    number: number;
    target: "new" | "append";
    progress: "preparing" | "ready" | "served";
    /** null for a round appended to a table's check (other diners' items). */
    money: null | { total: number; paid: number; balance: number };
    fiscal: null | { folio: string; selfInvoiceCode: string | null };
  };
};
export type PublicLinkView = {
  id: string;
  kind: LinkKind;
  channel: "qr" | "kiosk";
  tableId: string | null;
  tableName: string | null;
  tableArchived: boolean;
  label: string;
  ref: string;
  createdAt: string;
  createdByName: string;
  revokedAt: string | null;
  lastHoldAt: string | null;
  pendingHolds: number;
  /** Diner cancellations in the last window (churn, ABUSE-2). */
  recentCancelled: number;
};
export type RevealedLink = PublicLinkView & {
  token: string;
  path: string;
  baseUrl: string | null;
};
export type PublicLinksResponse = {
  links: PublicLinkView[];
  tables: {
    id: string;
    name: string;
    areaName: string | null;
    archived: boolean;
  }[];
};
export type PublicSettingsView = {
  available: boolean;
  pro: boolean;
  canEdit: boolean;
  canPause: boolean;
  paused: boolean;
  acceptingNow: boolean;
  reason: null | "paused" | "no_staff" | "plan";
  tablePolicy: HoldPolicy;
  counterPolicy: HoldPolicy;
  holdMinutes: number;
  maxOrderTotal: number;
  /** 0 = no settings row yet (defaults). */
  version: number;
  limits: { counter: number; kiosk: number };
};
export type InboxHold = {
  id: string;
  label: string;
  kind: LinkKind;
  channel: "qr" | "kiosk";
  tableId: string | null;
  tableName: string | null;
  linkLabel: string;
  /** Why the hold's code is no longer active; "abuse" needs an acknowledgement to accept. */
  linkRevoked: null | "revoked" | "rotated" | "abuse";
  name: string;
  note: string;
  policy: HoldPolicy;
  createdAt: string;
  expiresAt: string;
  lines: (PricedHoldLine & {
    issue: null | "unavailable" | "price_changed";
    currentTotal: number | null;
  })[];
  quotedTotal: number;
  /** null when any line is unavailable. */
  currentTotal: number | null;
  openChecks: {
    id: string;
    number: number;
    version: number;
    checkState: "open" | "paid";
    total: number;
    paid: number;
    waiterName: string;
  }[];
};
export type InboxResponse = {
  available: boolean;
  /** A link of any kind is active (the inbox shows even with nothing pending). */
  active: boolean;
  acceptingNow: boolean;
  reason: null | "paused" | "no_staff";
  paused: boolean;
  holds: InboxHold[];
  recentlyExpired: number;
  /** Codes whose diner cancellations reached the churn budget (ABUSE-2). */
  churning: { kind: LinkKind; name: string }[];
  serverTime: string;
};
export type InboxSummary = {
  available: boolean;
  active: boolean;
  pending: number;
  oldestAt: string | null;
};

// ---- pure helpers -------------------------------------------------------

export const holdLabel = (channel: "qr" | "kiosk", n: number) =>
  (channel === "kiosk" ? "K-" : "Q-") + n;

/** A pending hold past its expiry reads as expired (computed, never stored). */
export function effectiveHoldState(
  h: { state: string; expiresAt: string },
  nowMs: number,
): HoldState {
  if (h.state === "pending")
    return new Date(h.expiresAt).getTime() <= nowMs ? "expired" : "pending";
  return h.state as HoldState;
}

/** No rounds or any active/offline_review → preparing; all completed → served; else ready. */
export function roundProgress(
  states: readonly string[],
): "preparing" | "ready" | "served" {
  if (
    !states.length ||
    states.some((s) => s === "active" || s === "offline_review")
  )
    return "preparing";
  if (states.every((s) => s === "completed")) return "served";
  return "ready";
}

/**
 * Which decisions a hold offers. A hold whose included lines are free has
 * nothing to collect: anyone accepts it and it is never an override.
 */
export function holdActions(
  policy: HoldPolicy,
  role: string,
  currentTotal: number | null,
): { accept: boolean; payAndSend: boolean; override: boolean } {
  const free = currentTotal === 0;
  return {
    accept: policy === "accept" || free,
    payAndSend: !free,
    override:
      policy === "pay_first" && !free && ["owner", "manager"].includes(role),
  };
}

/** The diner never learns that staff flagged the order as abuse. */
export const dinerRejectReason = (
  r: RejectReason | null,
): Exclude<RejectReason, "abuse"> | null => (r === "abuse" ? "other" : r);

/** The page path of a link; the token travels in the fragment, never in a path. */
export function linkPath(kind: LinkKind, token: string): string {
  return (kind === "kiosk" ? "/kiosk#" : "/qr#") + token;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sorted((value as Record<string, unknown>)[k])]),
    );
  return value;
}
/** JSON with sorted keys, for request_hash (stable across key order). */
export function canonicalRequest(p: PublicOrderInput): string {
  return JSON.stringify(sorted(p));
}
