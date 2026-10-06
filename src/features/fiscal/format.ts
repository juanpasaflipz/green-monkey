// Formatting helpers of the fiscal screens and of the printed ticket (comprobantes print in
// Spanish: callers pass the locale of the document, never assume the UI's).
import type { Locale } from "../../../shared/domain";
import { groupSelfInvoiceCode, type TaxCategory } from "../../../shared/fiscal";
import { strings, type Key } from "../../i18n";

const categoryKeys: Record<TaxCategory, Key> = {
  iva16: "fiscalCategoryIva16",
  iva8: "fiscalCategoryIva8",
  iva0: "fiscalCategoryIva0",
  exempt: "fiscalCategoryExempt",
};

/** "IVA 16%", "IVA 8% (región fronteriza)", "IVA 0%", "Exento de IVA". */
export function categoryLabel(category: TaxCategory, locale: Locale): string {
  return strings[locale][categoryKeys[category]];
}

/** "16%" from basis points; "" for exempt (null). */
export function rateLabel(rateBps: number | null): string {
  return rateBps === null ? "" : `${rateBps / 100}%`;
}

/** Replaces {name} placeholders. */
export function fill(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    String(values[key] ?? ""),
  );
}

/** Currency formatter for centavos (es-MX or en-US grouping). */
export function fiscalMoney(currency: string, locale: Locale) {
  const format = new Intl.NumberFormat(locale === "es" ? "es-MX" : "en-US", {
    style: "currency",
    currency,
  });
  const scale = 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2);
  return (n: number) => format.format(n / scale);
}

/** dd/MM/yyyy HH:mm (24 h) in the restaurant's timezone, for any locale. */
export function fiscalDateTime(
  iso: string,
  timezone: string,
  locale: Locale,
): string {
  const parts = new Intl.DateTimeFormat(locale === "es" ? "es-MX" : "en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}`;
}

/** dd/MM/yyyy of a business date (yyyy-MM-dd). */
export function fiscalDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

/** The printed self-invoice code: "XXXX-XXXX-XXXX". */
export const groupCode = groupSelfInvoiceCode;
