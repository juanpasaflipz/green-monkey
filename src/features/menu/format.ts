import {
  currencyExponent,
  DomainError,
  minor,
  type Group,
  type Locale,
} from "../../../shared/domain";
import { groupRuleParts } from "../../../shared/menu";
import { strings, type Key } from "../../i18n";

/** Replaces {name}-style placeholders in a translated template. */
export function fill(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

export function translator(locale: Locale) {
  return (key: Key, values?: Record<string, string | number>) =>
    values ? fill(strings[locale][key], values) : strings[locale][key];
}
export type Translate = ReturnType<typeof translator>;

/** Formats integer minor units as currency (es-MX / en-US). */
export function moneyFormatter(locale: Locale, currency: string) {
  const scale = 10 ** currencyExponent(currency);
  const format = new Intl.NumberFormat(locale === "es" ? "es-MX" : "en-US", {
    style: "currency",
    currency,
  });
  return (minor: number) => format.format(minor / scale);
}

/**
 * Typed decimal → plain decimal text, or null when it is not a number.
 * es-MX and en-US both use "," for thousands and "." for decimals, so a
 * well-formed grouping ("1,200", "12,500.50") drops its commas. Any other
 * comma ("25,50", "1,20") is ambiguous and rejected; it is never read as a
 * decimal point, so "1,200" can never become 1.20.
 */
export function decimalInput(text: string): string | null {
  const value = text.trim();
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(value)) return value.replace(/,/g, "");
  return /^\d+(\.\d+)?$/.test(value) ? value : null;
}

/** Typed amount in currency units → integer minor units; throws invalid_amount. */
export function moneyInput(text: string, exponent: number): number {
  const value = decimalInput(text);
  if (value === null) throw new DomainError("invalid_amount");
  return minor(value, exponent);
}

/** Minor units → plain decimal text for an input ("25.5" → "25.50"). */
export function amountText(minor: number | null | undefined, currency: string) {
  if (minor === null || minor === undefined) return "";
  const exponent = currencyExponent(currency);
  return (minor / 10 ** exponent).toFixed(exponent);
}

/** "Obligatorio · elige 3 · puedes repetir" and similar. */
export function groupRuleText(
  g: Pick<Group, "min" | "max" | "repeat">,
  t: Translate,
): string {
  const r = groupRuleParts(g);
  const base =
    r.kind === "optional"
      ? t("menuRuleOptional", { max: r.max })
      : r.min === r.max
        ? r.min === 1
          ? t("menuRuleRequiredOne")
          : t("menuRuleRequiredExact", { n: r.min })
        : t("menuRuleRequiredRange", { min: r.min, max: r.max });
  return r.repeat ? `${base} · ${t("menuRuleRepeat")}` : base;
}

/** Decimal text in plain notation with trailing zeros removed. */
export function trimDecimal(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}
