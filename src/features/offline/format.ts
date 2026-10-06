import type { Locale } from "../../../shared/domain";
import {
  recordAmounts,
  type OfflineRecord,
  type OfflineRecordKind,
} from "../../../shared/offline-recovery";
import { strings, type Key } from "../../i18n";
import { orderNumberText } from "../../labels";
import type { ParkedOrderTarget } from "../../offline-records";

/** Replaces {name} placeholders in a translated string. */
export function fmt(text: string, vars: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (_, key: string) =>
    String(vars[key] ?? ""),
  );
}

/** Translator for one locale with placeholder support. */
export function translator(locale: Locale) {
  return (key: Key, vars?: Record<string, string | number>) =>
    vars ? fmt(strings[locale][key], vars) : strings[locale][key];
}

/** HH:mm in the restaurant's timezone. */
export function clockTime(
  at: number | string,
  timeZone: string,
  locale: Locale,
) {
  return new Date(at).toLocaleTimeString(locale === "es" ? "es-MX" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
}

/**
 * How an order is named on screen and on receipts (§2.4): "B-07" while only
 * the device knows it, "B-07 → #142" once the server numbered an order that
 * began offline, and "#142" otherwise. Given the current business date (and
 * the locale), a numbered order from another business day also names its
 * date: "#142 · 5 oct" (LD-29).
 */
export function orderLabel(
  order: {
    number: number;
    id: string;
    businessDate?: string | null;
    offline?: { provisionalNumber?: string | null } | null;
  },
  today?: string | null,
  locale: Locale = "es",
): string {
  const provisional = order.offline?.provisionalNumber ?? null;
  const number = order.number
    ? "#" + orderNumberText(order, today, locale)
    : null;
  if (provisional && number) return `${provisional} → ${number}`;
  if (provisional) return provisional;
  return number ?? "#" + order.id.slice(0, 8);
}

/**
 * How Borradores names the order a parked round belongs to (LD-13 addendum):
 * as staff know it from the local projection or this device's cached copy
 * ("B-07", "B-07 → #142", "#12"); for a local order that synced with no cached
 * copy (for example closed online), from its record ("B-07 → #142"); else the
 * number stored when the round was parked. Null when nothing names it (a new
 * order's draft, or a local order that is gone).
 */
export function parkedOrderLabel(
  where: ParkedOrderTarget | null,
  stored: { number: number } | null,
  today: string | null | undefined,
  locale: Locale,
): string | null {
  if (where?.kind === "local") return orderLabel(where.order, today, locale);
  if (where?.kind === "server") {
    if (where.cached) return orderLabel(where.cached, today, locale);
    const synced = where.synced;
    if (synced && (synced.provisionalNumber || synced.number))
      return orderLabel(
        {
          id: where.orderId,
          number: synced.number ?? 0,
          offline: { provisionalNumber: synced.provisionalNumber },
        },
        today,
        locale,
      );
  }
  return stored?.number ? "#" + stored.number : null;
}

/** True while only this device knows the order's number (the hint applies). */
export const provisionalOnly = (order: {
  number: number;
  offline?: { provisionalNumber?: string | null } | null;
}) => !!order.offline?.provisionalNumber && !order.number;

export function moneyFormatter(
  locale: Locale,
  currency: string,
  exponent: number,
) {
  const format = new Intl.NumberFormat(locale === "es" ? "es-MX" : "en-US", {
    style: "currency",
    currency,
  });
  return (minor: number) => format.format(minor / 10 ** exponent);
}

/** Sales and payments carry money; orders and rounds do not. */
export const carriesMoney = (kind: OfflineRecordKind) =>
  kind === "sale" || kind === "payment";

/**
 * The explanation of a sync error for a record of this kind
 * (OFFLINE-RECOVERY-03): an order or round carries no money, so its way out
 * is archive, never "reconcile the payment"; offline_conflict is told as the
 * eligibility problem it is, never "connect and sign in".
 */
export function rowErrorCode(code: string, kind: OfflineRecordKind): string {
  const money = carriesMoney(kind);
  if (code === "offline_conflict") return "offline_why_conflict";
  // A line id repeated in the record (refused before it reaches the database).
  if (code === "duplicate_line") return "offline_record_conflict";
  if (code === "settings_changed")
    return money
      ? "offline_why_settings_changed"
      : "offline_why_settings_items";
  if (code === "price_conflict" && !money) return "offline_why_price_items";
  if (code === "offline_catalog_changed" && !money)
    return "offline_why_catalog_items";
  return code;
}

/**
 * What this device archived for one drawer (§2.8), split by method: only cash
 * can show up as an overage when the drawer is counted; a terminal payment
 * never put cash in it (OFFLINE-RECOVERY-08). v1/v2 sales are cash.
 */
export function archivedDrawerAmounts(
  rows: readonly { scope: string; status: string; body: unknown }[],
  devicePrefix: string,
  drawerId: string,
): { cash: number; terminal: number } {
  const totals = { cash: 0, terminal: 0 };
  for (const row of rows) {
    const body = row.body as OfflineRecord & {
      cashSessionId?: string | null;
      payment?: { method?: string };
    };
    if (
      row.status !== "archived" ||
      !row.scope.startsWith(devicePrefix) ||
      body.cashSessionId !== drawerId
    )
      continue;
    const { amount, tip } = recordAmounts(body);
    if (body.payment?.method === "external") totals.terminal += amount + tip;
    else totals.cash += amount + tip;
  }
  return totals;
}
