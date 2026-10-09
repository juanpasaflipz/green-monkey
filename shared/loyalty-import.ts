/**
 * Importing Juanberto's pos-lite members (038, specs/loyalty-w4.md §6). Pure: the export file's
 * schema (scripts/loyalty/poslite-export.sql emits it), the preview the owner sees and the pages
 * the browser commits. The browser runs the preview on the file; the server re-validates every
 * row of every page. The file holds personal data and never leaves the owner's import screen.
 *
 * Rewards policy (lead question Q4, default "recent"): pos-lite never reliably recorded
 * redemptions (P6), so a completed card becomes a reward only when it was completed within
 * RECENT_DAYS and the member has not visited since (no stamps on the next card). "all" grants
 * every completed card not marked redeemed; "none" grants nothing. Cards the policy did not grant
 * are listed as "Premios por confirmar" for a manager's "Ajustar › Saldo de POS Lite".
 */
import { z } from "zod";
import {
  cleanName,
  maskPhone,
  normalizeRows,
  parsePhone,
  type LoyaltyCountry,
} from "./loyalty.js";

export const POS_LITE_SOURCE = "pos-lite-loyalty";
export const IMPORT_PAGE_SIZE = 500;
export const RECENT_DAYS = 90;
export const STALE_MONTHS = 24;
export const IMPORT_POLICIES = ["recent", "all", "none"] as const;
export type ImportPolicy = (typeof IMPORT_POLICIES)[number];

const count = z.coerce.number().int().min(0).max(10_000_000);
const instant = z.string().min(10).max(40).refine((v) => !Number.isNaN(Date.parse(v)));
const posLiteMember = z
  .object({
    id: z.union([z.string().min(1).max(64), z.number().int().min(0)]),
    phone: z.string().max(40),
    country_code: z.string().max(4).nullable().default("MX"),
    name: z.string().max(500).nullable().default(""),
    sms_opt_in: z.boolean().nullable().default(null),
    created_at: instant,
    last_visit: instant.nullable().default(null),
    orders_count: count.nullable().default(0),
    total_spent: z.union([z.number(), z.string()]).nullable().default(0),
    active_card: z
      .object({ stamps_earned: count, stamps_required: count })
      .nullable()
      .default(null),
    completed_cards: z
      .array(
        z.object({
          completed_at: instant.nullable(),
          redeemed: z.boolean().nullable().default(false),
        }),
      )
      .max(1000)
      .default([]),
    next_card_stamps: count.nullable().default(0),
  })
  .passthrough();
export const posLiteExport = z
  .object({
    source: z.literal(POS_LITE_SOURCE),
    sourceTenantId: z.string().min(1).max(100),
    /** pos-lite's restaurant name and subdomain, shown before Importar (LOYALTY-OPS-8). */
    sourceName: z.string().max(200).nullable().optional(),
    sourceSubdomain: z.string().max(200).nullable().optional(),
    targetTenantId: z.string().uuid(),
    exportedAt: instant,
    config: z
      .object({
        stamps_required: z.coerce.number().int().optional(),
        reward_description: z.string().max(500).optional(),
        stamp_bonus_threshold: z.coerce.number().optional(),
        referral_bonus_stamps: z.coerce.number().optional(),
        sms_enabled: z.union([z.boolean(), z.string()]).optional(),
        google_review_target: z.string().max(500).optional(),
      })
      .passthrough()
      .default({}),
    summary: z.object({
      members: count,
      activeCardStamps: count,
      completedCards: count,
      completedUnredeemed: count,
    }),
    members: z.array(posLiteMember).max(100_000),
  })
  .passthrough();
export type PosLiteExport = z.infer<typeof posLiteExport>;

/** One member as a commit page carries it (no pos-lite field beyond what 038 stores). */
export const importRow = z
  .object({
    legacyId: z.string().min(1).max(64),
    phone: z.string().regex(/^\+(52[0-9]{10}|1[2-9][0-9]{9})$/),
    name: z.string().min(1).max(60),
    smsOptIn: z.boolean().nullable(),
    joinedAt: instant,
    lastVisitAt: instant.nullable(),
    visits: z.number().int().min(0).max(10_000_000),
    spend: z.number().int().min(0).max(1e12),
    stamps: z.number().int().min(0).max(1000),
    rewards: z.number().int().min(0).max(100),
    /**
     * Completed pos-lite cards the policy did not grant ("Premios por confirmar"), as their
     * completion dates (YYYY-MM-DD, "" when pos-lite has none). The server keeps them on the
     * member's import row (no personal data) so they outlive the file (LOYALTY-OPS-2).
     */
    toConfirm: z
      .array(z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/))
      .max(20)
      .optional(),
  })
  .strict();
export type ImportRow = z.infer<typeof importRow>;
/** The import row's note for cards to confirm (Clientes filters on it). */
export const TO_CONFIRM_NOTE = "Premios de POS Lite por confirmar: ";
/** The note for the dates, within the ledger's 200 characters. */
export const toConfirmNote = (dates: readonly string[]) =>
  dates.length
    ? (TO_CONFIRM_NOTE + dates.map((d) => d || "sin fecha").join(", ")).slice(0, 200)
    : "";
export const importPageInput = z
  .object({
    batchHash: z.string().regex(/^[0-9a-f]{64}$/),
    sourceTenantId: z.string().min(1).max(100),
    targetTenantId: z.string().uuid(),
    policy: z.enum(IMPORT_POLICIES),
    /**
     * The club's stamps per card the preview converted balances at: the server refuses a page
     * when the saved setting differs (settings_changed, LOYALTY-OPS-3).
     */
    stampsRequired: z.number().int().min(2).max(50),
    page: z.number().int().min(0).max(999),
    pages: z.number().int().min(1).max(1000),
    rows: z.array(importRow).min(1).max(IMPORT_PAGE_SIZE),
  })
  .strict()
  .refine((p) => p.page < p.pages);
export type ImportPageInput = z.infer<typeof importPageInput>;

export type ImportRejection = {
  legacyId: string;
  name: string;
  maskedPhone: string;
  reason: "phone" | "country" | "name" | "duplicate";
};
export type ImportPreview = {
  sourceTenantId: string;
  /** The pos-lite restaurant the file came from ("Archivo de POS Lite: …"); null in old files. */
  sourceName: string | null;
  targetTenantId: string;
  policy: ImportPolicy;
  accepted: ImportRow[];
  rejected: ImportRejection[];
  /** Completed cards the policy did not grant ("Premios por confirmar"). */
  toConfirm: { legacyId: string; name: string; maskedPhone: string; completedAt: string | null }[];
  /** The file's own summary checks against its member rows. */
  fileSummaryOk: boolean;
  fileSummary: PosLiteExport["summary"];
  /** What the server totals must show after the commit, at this stamps_required. */
  expected: {
    members: number;
    importStamps: number;
    importRewards: number;
    stamps: number;
    rewards: number;
  };
  /** Members whose last pos-lite visit is older than 24 months (redacted at the next cleanup). */
  stale: number;
  suggested: {
    stampsRequired: number | null;
    stampThreshold: number | null;
    rewardDescription: string | null;
  };
};

const toMinor = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};
const countryOf = (c: string | null): LoyaltyCountry | null => {
  const v = (c ?? "MX").toUpperCase();
  return v === "MX" ? "MX" : v === "US" || v === "CA" ? "US" : null;
};

/**
 * The preview the owner confirms, from the parsed file: accepted rows (phones in E.164, names
 * trimmed to 60), rejected rows with a reason, the reward policy applied, the file's summary
 * checksum, the stale count and the totals the server must report after the commit.
 */
export function previewLoyaltyImport(
  file: PosLiteExport,
  o: { policy: ImportPolicy; now: number; stampsRequired: number },
): ImportPreview {
  const accepted: ImportRow[] = [];
  const rejected: ImportRejection[] = [];
  const toConfirm: ImportPreview["toConfirm"] = [];
  const phones = new Set<string>();
  const recentFrom = o.now - RECENT_DAYS * 86_400_000;
  const staleFrom = new Date(o.now);
  staleFrom.setUTCMonth(staleFrom.getUTCMonth() - STALE_MONTHS);
  let stale = 0;
  for (const m of file.members) {
    const legacyId = String(m.id);
    const name = cleanName(m.name ?? "");
    const country = countryOf(m.country_code);
    const phone = country ? parsePhone(m.phone, country) : null;
    const masked = phone ? maskPhone(phone) : "···· " + String(m.phone).replace(/\D/g, "").slice(-4);
    const reject = (reason: ImportRejection["reason"]) =>
      rejected.push({ legacyId, name, maskedPhone: masked, reason });
    if (!country) {
      reject("country");
      continue;
    }
    if (!phone) {
      reject("phone");
      continue;
    }
    if (!name) {
      reject("name");
      continue;
    }
    if (phones.has(phone)) {
      reject("duplicate");
      continue;
    }
    phones.add(phone);
    const completed = [...m.completed_cards].sort(
      (a, b) => Date.parse(a.completed_at ?? "") - Date.parse(b.completed_at ?? ""),
    );
    let rewards = 0;
    if (o.policy === "all")
      rewards = completed.filter((c) => !c.redeemed).length;
    else if (o.policy === "recent") {
      const last = completed.at(-1);
      if (
        last?.completed_at &&
        !last.redeemed &&
        Date.parse(last.completed_at) >= recentFrom &&
        (m.next_card_stamps ?? 0) === 0
      )
        rewards = 1;
    }
    const granted = o.policy === "all" ? completed.filter((c) => !c.redeemed) : completed.slice(completed.length - rewards);
    const mine: string[] = [];
    for (const c of completed)
      if (!granted.includes(c) && !c.redeemed) {
        toConfirm.push({ legacyId, name, maskedPhone: masked, completedAt: c.completed_at });
        mine.push(c.completed_at ? new Date(c.completed_at).toISOString().slice(0, 10) : "");
      }
    const lastVisitAt = m.last_visit ? new Date(m.last_visit).toISOString() : null;
    if (lastVisitAt ? Date.parse(lastVisitAt) < staleFrom.getTime() : Date.parse(m.created_at) < staleFrom.getTime())
      stale++;
    accepted.push({
      legacyId,
      phone,
      name,
      smsOptIn: m.sms_opt_in ?? null,
      joinedAt: new Date(m.created_at).toISOString(),
      lastVisitAt,
      visits: m.orders_count ?? 0,
      spend: toMinor(m.total_spent),
      stamps: Math.min(m.active_card?.stamps_earned ?? 0, 1000),
      rewards: Math.min(rewards, 100),
      ...(mine.length ? { toConfirm: mine.slice(-20) } : {}),
    });
  }
  const fileStamps = file.members.reduce((a, m) => a + (m.active_card?.stamps_earned ?? 0), 0);
  const fileCompleted = file.members.reduce((a, m) => a + m.completed_cards.length, 0);
  const fileUnredeemed = file.members.reduce(
    (a, m) => a + m.completed_cards.filter((c) => !c.redeemed).length,
    0,
  );
  let stamps = 0,
    rewards = 0,
    importStamps = 0,
    importRewards = 0;
  for (const r of accepted) {
    importStamps += r.stamps;
    importRewards += r.rewards;
    const overflow = normalizeRows("x", r.stamps, r.rewards, o.stampsRequired, false).length;
    stamps += r.stamps - overflow * o.stampsRequired;
    rewards += r.rewards + overflow;
  }
  const threshold = file.config.stamp_bonus_threshold;
  return {
    sourceTenantId: file.sourceTenantId,
    sourceName: file.sourceName
      ? file.sourceName + (file.sourceSubdomain ? ` (${file.sourceSubdomain})` : "")
      : null,
    targetTenantId: file.targetTenantId,
    policy: o.policy,
    accepted,
    rejected,
    toConfirm,
    fileSummaryOk:
      file.summary.members === file.members.length &&
      file.summary.activeCardStamps === fileStamps &&
      file.summary.completedCards === fileCompleted &&
      file.summary.completedUnredeemed === fileUnredeemed,
    fileSummary: file.summary,
    expected: {
      members: accepted.length,
      importStamps,
      importRewards,
      stamps,
      rewards,
    },
    stale,
    suggested: {
      stampsRequired:
        file.config.stamps_required && file.config.stamps_required >= 2 && file.config.stamps_required <= 50
          ? file.config.stamps_required
          : null,
      stampThreshold:
        threshold !== undefined && Number.isFinite(threshold) && threshold >= 0
          ? Math.round(threshold * 100)
          : null,
      rewardDescription: file.config.reward_description
        ? file.config.reward_description.trim().slice(0, 80) || null
        : null,
    },
  };
}

/** The accepted rows in commit pages of IMPORT_PAGE_SIZE (about 80 KB each). */
export function importPages(rows: readonly ImportRow[], size = IMPORT_PAGE_SIZE): ImportRow[][] {
  const pages: ImportRow[][] = [];
  for (let i = 0; i < rows.length; i += size) pages.push(rows.slice(i, i + size));
  return pages;
}

/** GET /import/:batchId: what the server holds for the batch. */
export type ImportStatus = {
  batchId: string;
  members: number;
  importStamps: number;
  importRewards: number;
  stamps: number;
  rewards: number;
};

/** "Verificado" when the server totals equal the preview's expectation and the file checks. */
export function importVerified(preview: ImportPreview, status: ImportStatus): string[] {
  const diffs: string[] = [];
  if (!preview.fileSummaryOk) diffs.push("summary");
  for (const k of ["members", "importStamps", "importRewards", "stamps", "rewards"] as const)
    if (preview.expected[k] !== status[k]) diffs.push(`${k} ${status[k]}≠${preview.expected[k]}`);
  return diffs;
}
