/** Loyalty club labels and text helpers (038, specs/loyalty-w4.md §5.4). */
import type { Locale } from "../../../shared/domain";
import type {
  JoinResult,
  LedgerKind,
  MemberDetail,
  MemberSummary,
} from "../../../shared/loyalty";
import { dateTime } from "../../datetime";
import { strings, type Key } from "../../i18n";
import { fill } from "../discounts/format";
import { moneyFormatter } from "../Receipt";

export { fill };
export const tr = (locale: Locale) => (k: Key) => strings[locale][k];

const KIND_LABELS: Record<LedgerKind, Key> = {
  earn: "loyaltyKindEarn",
  earn_reversal: "loyaltyKindEarnReversal",
  reward_earned: "loyaltyKindRewardEarned",
  reward_unearned: "loyaltyKindRewardUnearned",
  reward_redeemed: "loyaltyKindRewardRedeemed",
  reward_restored: "loyaltyKindRewardRestored",
  adjustment: "loyaltyKindAdjustment",
  import: "loyaltyKindImport",
};
export const ledgerKindLabel = (kind: LedgerKind, locale: Locale) =>
  strings[locale][KIND_LABELS[kind]];

const VIA_LABELS: Record<string, Key> = {
  pos: "loyaltyViaPos",
  join_qr: "loyaltyViaJoin",
  kiosk: "loyaltyViaKiosk",
  import: "loyaltyViaImport",
};
export const viaLabel = (via: string, locale: Locale) =>
  strings[locale][VIA_LABELS[via] ?? "loyaltyViaPos"];

const CONSENT_VIA: Record<string, string> = {
  staff_attested: "pos",
  self_service: "join_qr",
  pos_lite_import: "import",
};
export const consentChannelLabel = (channel: string, locale: Locale) =>
  viaLabel(CONSENT_VIA[channel] ?? "pos", locale);

/**
 * A date without the time, in the restaurant's timezone: "07/10/2026" / "Oct 7, 2026" (never a
 * slice of a localized date-time, LOYALTY-UX-12).
 */
export function dateOnly(at: string | number | Date, timezone: string, locale: Locale) {
  const parts = new Intl.DateTimeFormat(locale === "es" ? "es-MX" : "en-US", {
    day: locale === "es" ? "2-digit" : "numeric",
    month: locale === "es" ? "2-digit" : "short",
    year: "numeric",
    timeZone: timezone,
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return locale === "es"
    ? `${part("day")}/${part("month")}/${part("year")}`
    : `${part("month")} ${part("day")}, ${part("year")}`;
}

/**
 * The member's consent line. pos-lite showed no privacy notice, so an imported member's line says
 * so instead of "Aceptó el aviso" (LOYALTY-PRIVACY-5).
 */
export function consentText(
  m: Pick<MemberDetail, "consentChannel" | "consentAt">,
  timezone: string,
  locale: Locale,
) {
  const t = strings[locale];
  const date = dateTime(m.consentAt, timezone, locale);
  return m.consentChannel === "pos_lite_import"
    ? fill(t.loyaltyConsentImported, { date })
    : fill(t.loyaltyConsentLine, {
        channel: consentChannelLabel(m.consentChannel, locale),
        date,
      });
}

/** "1 premio disponible" / "{n} premios disponibles". */
export function rewardsText(n: number, locale: Locale) {
  const t = strings[locale];
  return n === 1 ? t.loyaltyRewardOne : fill(t.loyaltyRewardMany, { n });
}

/**
 * The /club result (LOYALTY-UX-7, UX-8): pending payment, a completed card (never "0 de 10" alone),
 * a purchase that earned nothing, or 1 / n stamps.
 */
export function joinDoneText(done: JoinResult, locale: Locale) {
  const t = strings[locale];
  if (done.pending) return t.loyaltyJoinPending;
  if (done.completed > 0)
    return fill(t.loyaltyJoinCompleted, { rewards: rewardsText(done.rewards, locale) });
  if (done.stampsAdded <= 0) return t.loyaltyNoStamps;
  return fill(done.stampsAdded === 1 ? t.loyaltyJoinDoneOne : t.loyaltyJoinDone, {
    n: done.stampsAdded,
    stamps: done.stamps,
    required: done.required,
  });
}

/** "7/10", or "−2 · Ajuste pendiente" for a negative card (never color alone). */
export function stampsText(m: Pick<MemberSummary, "stamps" | "required">, locale: Locale) {
  return m.stamps < 0
    ? `${m.stamps} · ${strings[locale].loyaltyPendingAdjust}`
    : `${m.stamps}/${m.required}`;
}

export const money = (amount: number, locale: Locale, currency = "MXN") =>
  moneyFormatter(currency, locale)(amount);

/** A business date "2026-10-07" as "07/10/2026" (es) or "Oct 7, 2026" (en). */
export function dayText(date: string, locale: Locale) {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale === "es" ? "es-MX" : "en-US", {
    day: locale === "es" ? "2-digit" : "numeric",
    month: locale === "es" ? "2-digit" : "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}
