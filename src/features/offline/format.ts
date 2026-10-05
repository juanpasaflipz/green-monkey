import type { Locale } from "../../../shared/domain";
import { strings, type Key } from "../../i18n";

/** Replaces {name} placeholders in a translated string. */
export function fmt(text: string, vars: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ""));
}

/** Translator for one locale with placeholder support. */
export function translator(locale: Locale) {
  return (key: Key, vars?: Record<string, string | number>) =>
    vars ? fmt(strings[locale][key], vars) : strings[locale][key];
}

/** HH:mm in the restaurant's timezone. */
export function clockTime(at: number | string, timeZone: string, locale: Locale) {
  return new Date(at).toLocaleTimeString(locale === "es" ? "es-MX" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
}

export function moneyFormatter(locale: Locale, currency: string, exponent: number) {
  const format = new Intl.NumberFormat(locale === "es" ? "es-MX" : "en-US", {
    style: "currency",
    currency,
  });
  return (minor: number) => format.format(minor / 10 ** exponent);
}
