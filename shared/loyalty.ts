/**
 * Loyalty club (038, specs/loyalty-w4.md, docs/LOYALTY.md). Pure: phone parsing, the stamp rule,
 * the reconciler's plan, the reward's discount request, zod inputs and wire views. The server and
 * the client run the same code, so a preview and the recorded result are identical.
 *
 * Personal data rules (LFPDPPP, §2.11): views for staff lists carry a first name and a masked
 * phone only; the full phone is for managers (MemberDetail); join and kiosk views carry counts.
 */
import { z } from "zod";
import { id, money, DomainError, type Order } from "./domain.js";
import { TENDER_METHODS } from "./payments.js";
import type { DiscountRequest } from "./discounts.js";

// ---- phones and names -----------------------------------------------------------------------

export const LOYALTY_COUNTRIES = { MX: "+52", US: "+1" } as const;
export type LoyaltyCountry = keyof typeof LOYALTY_COUNTRIES;
export const loyaltyCountry = z.enum(["MX", "US"]);

/**
 * "5550000001", "55 5000 0001", "52 55 5000 0001", "521 55 5000 0001" or "+52 1 55 5000 0001" (MX);
 * 10 digits or "1" + 10 digits whose area code starts 2-9 (US/CA) → E.164, else null. Spaces,
 * dashes, dots and parentheses are ignored. Mexico's "1" after 52 (pos-lite's carrier workaround)
 * is dropped: the stored number is plain E.164 (+52 + 10 digits).
 */
export function parsePhone(raw: string, country: LoyaltyCountry): string | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const cleaned = raw.trim().replace(/[\s\-.()]/g, "");
  if (!/^\+?[0-9]+$/.test(cleaned)) return null;
  const d = cleaned.replace(/^\+/, "");
  if (country === "MX") {
    let local: string | null = null;
    if (d.length === 10) local = d;
    else if (d.length === 12 && d.startsWith("52")) local = d.slice(2);
    else if (d.length === 13 && d.startsWith("521")) local = d.slice(3);
    return local && /^[0-9]{10}$/.test(local) ? "+52" + local : null;
  }
  let local: string | null = null;
  if (d.length === 10) local = d;
  else if (d.length === 11 && d.startsWith("1")) local = d.slice(1);
  return local && /^[2-9][0-9]{9}$/.test(local) ? "+1" + local : null;
}

/** "···· 9933": the last four digits only. */
export const maskPhone = (e164: string | null) =>
  e164 ? "···· " + e164.slice(-4) : "";

/** "+52 55 5000 0001" / "+1 212 555 0100" for the manager's detail and the ARCO sheet. */
export function formatPhone(e164: string | null): string {
  if (!e164) return "";
  const m = /^\+52([0-9]{2})([0-9]{4})([0-9]{4})$/.exec(e164);
  if (m) return `+52 ${m[1]} ${m[2]} ${m[3]}`;
  const u = /^\+1([0-9]{3})([0-9]{3})([0-9]{4})$/.exec(e164);
  if (u) return `+1 ${u[1]} ${u[2]} ${u[3]}`;
  return e164;
}

/** The country toggle of a stored phone. */
export const phoneCountry = (e164: string): LoyaltyCountry =>
  e164.startsWith("+1") ? "US" : "MX";

/** Lower case, accents folded (NFD, combining marks removed), spaces collapsed; at most 60. */
export function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/** Trimmed, inner spaces collapsed, at most 60 characters (the stored name). */
export const cleanName = (name: string) =>
  name.replace(/\s+/g, " ").trim().slice(0, 60);

/** The first word of a stored name (what the kitchen ticket and toasts show). */
export const firstName = (name: string) => cleanName(name).split(" ")[0] ?? "";

// ---- the program ----------------------------------------------------------------------------

export type ProgramRule = {
  /** Minor units; 0 = always exactly one stamp. */
  stampThreshold: number;
  maxStampsPerOrder: number | null;
};

/** §2.2.1: 0 for no base; else 1, plus 1 per full threshold paid; capped. */
export function stampsFor(base: number, r: ProgramRule): number {
  if (!(base > 0)) return 0;
  const n =
    r.stampThreshold === 0 ? 1 : 1 + Math.floor(base / r.stampThreshold);
  return r.maxStampsPerOrder ? Math.min(n, r.maxStampsPerOrder) : n;
}

/** Tender methods whose money earns stamps (R15: every method but "platform"). */
export const STAMP_TENDER_METHODS: readonly string[] = TENDER_METHODS.filter(
  (m) => m !== "platform",
);

/**
 * The stamp base of a settled order (§2.1): Σ non-platform tender amounts − Σ their refunds,
 * capped at the order's total and floored at 0. Tips are separate and never count.
 */
export function stampBase(o: {
  total: number;
  tenders: { method: string; amount: number; refunded: number }[];
}): number {
  const net = o.tenders
    .filter((t) => STAMP_TENDER_METHODS.includes(t.method))
    .reduce((a, t) => a + t.amount - t.refunded, 0);
  return Math.max(0, Math.min(o.total, net));
}

export type LedgerKind =
  | "earn"
  | "earn_reversal"
  | "reward_earned"
  | "reward_unearned"
  | "reward_redeemed"
  | "reward_restored"
  | "adjustment"
  | "import";
export const LEDGER_KINDS: readonly LedgerKind[] = [
  "earn",
  "earn_reversal",
  "reward_earned",
  "reward_unearned",
  "reward_redeemed",
  "reward_restored",
  "adjustment",
  "import",
];

export type PlannedLedgerRow = {
  memberId: string;
  kind: LedgerKind;
  stampsDelta: number;
  rewardsDelta: number;
  base?: number;
  stampsRequired?: number;
  discountId?: string;
};

/**
 * Completion and uncompletion after a posting (§2.2.5, §2.2.6): while stamps reach a card, a
 * reward is earned (overflow carries over); after a reversal, while stamps are negative and a
 * reward is still available, the reward is withdrawn. Pure: the rows to post, in order.
 */
export function normalizeRows(
  memberId: string,
  stamps: number,
  rewards: number,
  required: number,
  afterReversal: boolean,
): PlannedLedgerRow[] {
  const rows: PlannedLedgerRow[] = [];
  let s = stamps,
    r = rewards;
  if (afterReversal)
    while (s < 0 && r > 0) {
      rows.push({
        memberId,
        kind: "reward_unearned",
        stampsDelta: required,
        rewardsDelta: -1,
        stampsRequired: required,
      });
      s += required;
      r -= 1;
    }
  while (s >= required) {
    rows.push({
      memberId,
      kind: "reward_earned",
      stampsDelta: -required,
      rewardsDelta: 1,
      stampsRequired: required,
    });
    s -= required;
    r += 1;
  }
  return rows;
}

export type ReconcileInput = {
  enabled: boolean;
  stampsRequired: number;
  rule: ProgramRule;
  /** paid, or closed settled/released, and not in recovery (§2.1). */
  settled: boolean;
  base: number;
  linkMemberId: string | null;
  members: {
    id: string;
    deleted: boolean;
    stamps: number;
    rewards: number;
    /** Σ stamps_delta of this order's earn and earn_reversal rows for this member. */
    posted: number;
  }[];
  redemptions: {
    memberId: string;
    discountId: string;
    restored: boolean;
    discountReversed: boolean;
    activeAmount: number;
    orderClosed: boolean;
  }[];
};

/**
 * §2.2, the single statement of the stamp rules. Per member (sorted by id): the order's target
 * (its stamps when it is the linked, non-deleted member of a settled order, else 0; with the club
 * off never more than what is posted), the earn or earn_reversal of the difference, then
 * completion or uncompletion; then the restorations of reward discounts that were reversed or
 * whose units were all voided on a closed order (once each). Running it again on the state it
 * produced plans nothing.
 */
export function planReconcile(i: ReconcileInput): PlannedLedgerRow[] {
  const rows: PlannedLedgerRow[] = [];
  const members = [...i.members].sort((a, b) => (a.id < b.id ? -1 : 1));
  const state = new Map(members.map((m) => [m.id, { ...m }]));
  for (const m of members) {
    if (m.deleted) continue;
    let target =
      i.settled && m.id === i.linkMemberId ? stampsFor(i.base, i.rule) : 0;
    if (!i.enabled) target = Math.min(target, Math.max(0, m.posted));
    const delta = target - m.posted;
    if (delta === 0) continue;
    rows.push({
      memberId: m.id,
      kind: delta > 0 ? "earn" : "earn_reversal",
      stampsDelta: delta,
      rewardsDelta: 0,
      base: i.base,
    });
    const s = state.get(m.id)!;
    s.stamps += delta;
    const more = normalizeRows(
      m.id,
      s.stamps,
      s.rewards,
      i.stampsRequired,
      delta < 0,
    );
    for (const r of more) {
      s.stamps += r.stampsDelta;
      s.rewards += r.rewardsDelta;
    }
    rows.push(...more);
  }
  for (const r of i.redemptions) {
    if (r.restored) continue;
    const m = state.get(r.memberId);
    if (!m || m.deleted) continue;
    if (r.discountReversed || (r.activeAmount === 0 && r.orderClosed))
      rows.push({
        memberId: r.memberId,
        kind: "reward_restored",
        stampsDelta: 0,
        rewardsDelta: 1,
        discountId: r.discountId,
      });
  }
  return rows;
}

// ---- settings -------------------------------------------------------------------------------

export const LOYALTY_DEFAULTS = {
  enabled: false,
  programName: "",
  stampsRequired: 10,
  stampThreshold: 40000,
  maxStampsPerOrder: null as number | null,
  rewardKind: "item" as "item" | "amount",
  rewardDescription: "Un producto gratis",
  rewardAmount: null as number | null,
  /** LD-72: one free product up to an owner-set cap, $150.00 by default. */
  rewardMaxAmount: 15000 as number | null,
  maxRewardsPerOrder: 1,
  promptAtCheckout: true,
  receiptJoinQr: true,
  linkWindowDays: 7,
};
export type LoyaltyProgram = typeof LOYALTY_DEFAULTS;

export const loyaltySettingsInput = z
  .object({
    operationId: id,
    /** 0 when nothing was saved yet. */
    expectedVersion: z.number().int().min(0),
    enabled: z.boolean(),
    programName: z.string().trim().max(40),
    stampsRequired: z.number().int().min(2).max(50),
    stampThreshold: z
      .number()
      .int()
      .refine((n) => n === 0 || (n >= 1000 && n <= 10_000_000)),
    maxStampsPerOrder: z.number().int().min(1).max(20).nullable(),
    rewardKind: z.enum(["item", "amount"]),
    rewardDescription: z.string().trim().min(1).max(80),
    rewardAmount: z.number().int().min(100).max(1_000_000).nullable(),
    rewardMaxAmount: z.number().int().min(100).max(1_000_000).nullable(),
    maxRewardsPerOrder: z.number().int().min(1).max(3),
    promptAtCheckout: z.boolean(),
    receiptJoinQr: z.boolean(),
    linkWindowDays: z.number().int().min(1).max(30),
    privacyAttested: z.boolean(),
  })
  .strict()
  .refine((p) => (p.rewardKind === "amount") === (p.rewardAmount !== null))
  .refine((p) => p.rewardKind === "item" || p.rewardMaxAmount === null);
export type LoyaltySettingsInput = z.infer<typeof loyaltySettingsInput>;

/** GET /api/loyalty/settings for managers. */
export type LoyaltySettingsView = LoyaltyProgram & {
  version: number;
  privacyAttestedAt: string | null;
  privacyAttestedByName: string | null;
  privacyUrl: string | null;
  plan: "free" | "pro";
  /** The import is offered only while the club is off. */
  importAllowed: boolean;
  canEdit: boolean;
};
/** What operators read (Vender's prompt, chips, receipts). */
export type LoyaltyClubView = {
  enabled: boolean;
  promptAtCheckout: boolean;
  programName: string;
  stampsRequired: number;
  rewardDescription: string;
  rewardKind: "item" | "amount";
  rewardAmount: number | null;
  rewardMaxAmount: number | null;
  maxRewardsPerOrder: number;
  /** The restaurant's privacy notice (031), shown as a QR when staff enroll a member. */
  privacyUrl: string | null;
};
export const programTitle = (programName: string, restaurant: string) =>
  programName.trim() || `Club ${restaurant}`.slice(0, 40);

// ---- members --------------------------------------------------------------------------------

const phoneText = z.string().max(40);
export const enrollInput = z
  .object({
    operationId: id,
    phone: phoneText,
    country: loyaltyCountry,
    name: z.string().max(200),
    consent: z.boolean(),
    marketingOptIn: z.boolean().default(false),
  })
  .strict();
export const memberUpdateInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(1),
    name: z.string().max(200).optional(),
    phone: phoneText.optional(),
    country: loyaltyCountry.optional(),
    marketingOptIn: z.boolean().optional(),
  })
  .strict();
export const memberDeleteInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(1),
    confirm: z.literal("ELIMINAR"),
  })
  .strict();
export const ADJUST_REASONS = [
  "correction",
  "goodwill",
  "pos_lite_balance",
  "other",
] as const;
export const memberAdjustInput = z
  .object({
    operationId: id,
    stamps: z.number().int().min(-50).max(50).default(0),
    rewards: z.number().int().min(-5).max(5).default(0),
    reason: z.enum(ADJUST_REASONS),
    note: z.string().trim().min(3).max(200),
  })
  .strict()
  .refine((p) => p.stamps !== 0 || p.rewards !== 0);
export const orderLinkInput = z
  .object({ operationId: id, memberId: id })
  .strict();
export const orderChangeInput = z
  .object({
    operationId: id,
    memberId: id.nullable(),
    expectedMemberId: id.nullable(),
  })
  .strict();

/** Name, phone and consent checks with the area's own codes (§4.12). */
export function enrollmentIssue(p: {
  phone: string;
  country: LoyaltyCountry;
  name: string;
  consent: boolean;
}): string | null {
  if (!parsePhone(p.phone, p.country)) return "loyalty_invalid_phone";
  if (!cleanName(p.name)) return "loyalty_name_required";
  if (p.consent !== true) return "loyalty_consent_required";
  return null;
}

/** Staff lists, lookup, Vender's chip and Detalle de orden: no full phone. */
export type MemberSummary = {
  id: string;
  firstName: string;
  maskedPhone: string;
  stamps: number;
  required: number;
  rewards: number;
  deleted: boolean;
};
export type LedgerRowView = {
  id: string;
  kind: LedgerKind;
  stampsDelta: number;
  rewardsDelta: number;
  orderId: string | null;
  orderNumber: number | null;
  orderBusinessDate: string | null;
  discountId: string | null;
  reason: string | null;
  note: string;
  actorName: string | null;
  createdAt: string;
};
export type MemberOrderView = {
  orderId: string;
  number: number;
  businessDate: string;
  total: number;
  stamps: number;
  linkedAt: string;
};
/** Managers only (Clientes, the ARCO sheet). */
export type MemberDetail = MemberSummary & {
  name: string;
  phone: string | null;
  country: LoyaltyCountry;
  version: number;
  joinedAt: string;
  joinedVia: "pos" | "join_qr" | "import";
  joinedByName: string | null;
  consentChannel: "staff_attested" | "self_service" | "pos_lite_import";
  consentAt: string;
  consentNoticeUrl: string | null;
  marketingOptIn: boolean;
  marketingChangedAt: string | null;
  lifetimeStamps: number;
  rewardsEarned: number;
  rewardsRedeemed: number;
  lastVisitAt: string | null;
  legacy: {
    visits: number;
    spend: number;
    lastVisitAt: string | null;
    smsOptIn: boolean | null;
  } | null;
  redactedAt: string | null;
  redactionReason: "arco" | "retention" | null;
  history: LedgerRowView[];
  orders: MemberOrderView[];
};
export type MemberListRow = MemberSummary & {
  name: string;
  lastVisitAt: string | null;
  joinedAt: string;
  imported: boolean;
};
export type MemberListResponse = {
  rows: MemberListRow[];
  nextCursor: string | null;
};
export type EnrollResult = { member: MemberSummary; created: boolean };

// ---- orders ---------------------------------------------------------------------------------

export type OrderLoyaltyView = {
  orderId: string;
  member: MemberSummary | null;
  via: "pos" | "join_qr" | "kiosk" | null;
  /** Net stamps this order posted for the linked member. */
  earned: number;
  /** Cards this order completed for the linked member (reward_earned − reward_unearned rows). */
  completed: number;
  redemptions: { discountId: string; amount: number; restored: boolean }[];
  /** Staff may add or change the member now (open, or settled within the window). */
  linkable: boolean;
  settled: boolean;
  windowEndsAt: string | null;
  /** A reconcile job for this order is waiting ("Sellos en proceso"). */
  pending: boolean;
};

export type ReceiptLoyaltyView =
  | { kind: "none" }
  | {
      kind: "join";
      token: string;
      programName: string;
      stampsRequired: number;
      rewardDescription: string;
    }
  | {
      kind: "member";
      programName: string;
      stamps: number;
      required: number;
      rewards: number;
      rewardDescription: string;
    };

// ---- rewards --------------------------------------------------------------------------------

export const redeemInput = z
  .object({
    operationId: id,
    memberId: id,
    expectedVersion: z.number().int().min(1),
    lineId: id.optional(),
    expectedAmount: money.refine((n) => n > 0),
    expectedBase: money.refine((n) => n > 0),
    expectedAllocations: z
      .array(
        z
          .object({
            lineId: id,
            units: z.array(z.number().int().min(0).max(999)).min(1).max(99),
            amounts: z.array(money).min(1).max(99),
          })
          .strict()
          .refine((l) => l.units.length === l.amounts.length),
      )
      .min(1)
      .max(1000),
    expectedDue: money,
    expectedCloses: z.boolean(),
  })
  .strict();
export type RedeemInput = z.infer<typeof redeemInput>;

/**
 * The discount request a reward makes (§2.6). "item": one unpaid unit of the line the cashier
 * picked: a comp when its due is within the cap (or there is none), else an amount discount equal
 * to the cap. "amount": a check discount of min(reward amount, Σ due), refused with
 * loyalty_reward_conflict when the check already has an active check discount.
 */
export function rewardDiscountRequest(
  program: Pick<LoyaltyProgram, "rewardKind" | "rewardAmount" | "rewardMaxAmount">,
  order: Pick<Order, "paymentUnits" | "discounts">,
  lineId?: string,
): DiscountRequest {
  const units = order.paymentUnits ?? [];
  if (program.rewardKind === "amount") {
    if (lineId !== undefined) throw new DomainError("invalid_input", 400);
    if ((order.discounts ?? []).some((d) => d.scope === "order" && !d.reversal))
      throw new DomainError("loyalty_reward_conflict", 409);
    const due = units.reduce((a, u) => a + Math.max(0, u.due), 0);
    if (due <= 0) throw new DomainError("discount_nothing_due", 409);
    return {
      scope: "order",
      kind: "amount",
      amount: Math.min(program.rewardAmount ?? 0, due),
    };
  }
  if (!lineId) throw new DomainError("invalid_input", 400);
  const unit = units
    .filter((u) => u.lineId === lineId && u.due > 0 && !u.lineDiscounted)
    .sort((a, b) => a.unit - b.unit)[0];
  if (!unit) throw new DomainError("discount_units_unavailable", 409);
  if (program.rewardMaxAmount === null || unit.due <= program.rewardMaxAmount)
    return { scope: "line", lineId, quantity: 1, kind: "comp" };
  return {
    scope: "line",
    lineId,
    quantity: 1,
    kind: "amount",
    amount: program.rewardMaxAmount,
  };
}

// ---- diner join page and kiosk --------------------------------------------------------------

export const JOIN_HEADER = "x-gm-join-token";
/** A sealed token's shape (server/keyring.ts signToken): screened before any database work. */
export const SEALED_TOKEN = /^v2\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]{2,2000}\.[A-Za-z0-9_-]{43}$/;

export const joinInput = z
  .object({
    phone: phoneText,
    country: loyaltyCountry,
    name: z.string().max(200),
    privacyAccepted: z.boolean(),
    marketingOptIn: z.boolean().default(false),
  })
  .strict();
/** GET /api/club/join: no member data, ever. */
export type JoinView = {
  restaurantName: string;
  programName: string;
  orderNumber: number;
  businessDate: string;
  stampsRequired: number;
  rewardDescription: string;
  privacyUrl: string | null;
  /** The order already has a member ("Esta compra ya sumó sellos."). */
  linked: boolean;
};
/** POST /api/club/join: counts only, never the stored name. */
export type JoinResult = {
  stampsAdded: number;
  stamps: number;
  required: number;
  rewards: number;
  /** The order is not paid yet: its stamps post when it settles. */
  pending: boolean;
};

export const kioskLookupInput = z
  .object({ phone: phoneText, country: loyaltyCountry })
  .strict();
/** R20/R21 and LD-72: counts and a masked phone; no name, history or repeat order. */
export type KioskMemberView =
  | { found: false }
  | {
      found: true;
      memberToken: string;
      maskedPhone: string;
      stamps: number;
      required: number;
      rewards: number;
    };
export type LoyaltyKioskConfig = {
  enabled: boolean;
  stampsRequired: number;
  rewardLabel: string;
};

// ---- report ---------------------------------------------------------------------------------

export type LoyaltyReport = {
  from: string;
  to: string;
  members: { total: number; new: number; imported: number; active: number };
  stamps: { earned: number; reversed: number; adjusted: number };
  rewards: {
    earned: number;
    redeemed: number;
    /** Redeemed ÷ earned in the period, in basis points; null when none were earned. */
    rateBps: number | null;
    value: number;
  };
  sales: { members: number; total: number; shareBps: number | null };
  top: {
    memberId: string;
    name: string;
    maskedPhone: string;
    visits: number;
    spend: number;
  }[];
  /** loyalty_ledger_vs_members: members whose cached balances differ from their ledger. */
  mismatches: number;
};

/** Every error code the area owns (§4.12), for tests and the i18n module. */
export const LOYALTY_ERROR_CODES = [
  "loyalty_disabled",
  "loyalty_privacy_notice_required",
  "loyalty_privacy_attestation_required",
  "loyalty_invalid_phone",
  "loyalty_name_required",
  "loyalty_consent_required",
  "loyalty_member_not_found",
  "loyalty_member_deleted",
  "loyalty_phone_taken",
  "loyalty_order_linked",
  "loyalty_order_not_eligible",
  "loyalty_link_window_closed",
  "loyalty_no_reward",
  "loyalty_reward_limit",
  "loyalty_reward_conflict",
  "loyalty_adjust_below_zero",
  "loyalty_lookup_limited",
  "loyalty_join_unavailable",
  "loyalty_join_expired",
  "loyalty_member_token_invalid",
  "loyalty_import_after_enable",
  "loyalty_import_rejected",
  "loyalty_import_scope",
  "loyalty_retry",
  "loyalty_settings_invalid",
] as const;
