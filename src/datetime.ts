import type { Locale } from "../shared/domain";

/**
 * A date and time (24 h) in the restaurant's timezone: dd/MM/yyyy HH:mm in
 * Spanish and an unambiguous "Oct 5, 2026 21:48" in English. Screens use it
 * instead of toLocaleString(locale), which renders "7/10/2026, 4:53:12" in
 * Spanish (no padding, seconds; restaurant-day G3 dates rule, FOH-13).
 */
export function dateTime(
  at: string | number | Date,
  timezone: string | undefined,
  locale: Locale,
): string {
  const parts = new Intl.DateTimeFormat(locale === "es" ? "es-MX" : "en-US", {
    day: locale === "es" ? "2-digit" : "numeric",
    month: locale === "es" ? "2-digit" : "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timezone ? { timeZone: timezone } : {}),
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const time = `${part("hour")}:${part("minute")}`;
  return locale === "es"
    ? `${part("day")}/${part("month")}/${part("year")} ${time}`
    : `${part("month")} ${part("day")}, ${part("year")} ${time}`;
}
