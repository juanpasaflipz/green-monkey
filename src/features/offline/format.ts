import type { Locale } from "../../../shared/domain";
import { strings, type Key } from "../../i18n";

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
 * began offline, and "#142" otherwise.
 */
export function orderLabel(order: {
  number: number;
  id: string;
  offline?: { provisionalNumber?: string | null } | null;
}): string {
  const provisional = order.offline?.provisionalNumber ?? null;
  if (provisional && order.number) return `${provisional} → #${order.number}`;
  if (provisional) return provisional;
  return "#" + (order.number || order.id.slice(0, 8));
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
