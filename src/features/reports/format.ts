import { Temporal } from "@js-temporal/polyfill";
import type { Locale } from "../../../shared/domain";
import {
  differenceKind,
  type AuditGroup,
  type ExceptionKind,
} from "../../../shared/reports";
import { strings, type Key } from "../../i18n";
import { moneyFormatter } from "../Receipt";

/** Fills `{name}` placeholders; unknown placeholders stay as written. */
export function fill(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}

/** Minor units in the restaurant currency (service's receipt formatter). */
export function money(currency: string, locale: Locale) {
  return moneyFormatter(currency, locale);
}

const intlLocale = (locale: Locale) => (locale === "es" ? "es-MX" : "en-US");

/** Basis points as a percent with at most one decimal: 9_250 → "92.5 %". */
export function pct(bps: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(bps / 10_000);
}

/** A signed percent change, "+12 %" / "−3 %". */
export function pctChange(bps: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "percent",
    maximumFractionDigits: 0,
    signDisplay: "exceptZero",
  }).format(bps / 10_000);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "04:00–04:59". */
export function hourLabel(hour: number): string {
  return `${pad(hour)}:00–${pad(hour)}:59`;
}

/** A business date "AAAA-MM-DD" as dd/mm/aaaa (es) or mm/dd/yyyy (en). */
export function dateLabel(date: string, locale: Locale): string {
  const d = Temporal.PlainDate.from(date);
  return locale === "es"
    ? `${pad(d.day)}/${pad(d.month)}/${d.year}`
    : `${pad(d.month)}/${pad(d.day)}/${d.year}`;
}

/** An instant's local HH:mm in the restaurant zone. */
export function timeLabel(instant: string, timezone: string): string {
  const z = Temporal.Instant.from(instant).toZonedDateTimeISO(timezone);
  return `${pad(z.hour)}:${pad(z.minute)}`;
}

/** An instant as "dd/mm/aaaa HH:mm" in the restaurant zone. */
export function dateTimeLabel(
  instant: string,
  timezone: string,
  locale: Locale,
): string {
  const z = Temporal.Instant.from(instant).toZonedDateTimeISO(timezone);
  return `${dateLabel(z.toPlainDate().toString(), locale)} ${pad(z.hour)}:${pad(z.minute)}`;
}

/** The weekday name of a business date ("lunes", "Monday"). */
export function weekdayLabel(date: string, locale: Locale): string {
  const d = Temporal.PlainDate.from(date);
  return new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(d.year, d.month - 1, d.day, 12)));
}

/** "HH:mm" of a cutoff in minutes. */
export function cutoffLabel(cutoff: number): string {
  return `${pad(Math.floor(cutoff / 60))}:${pad(cutoff % 60)}`;
}

const EXCEPTION_KEYS: Record<ExceptionKind, Key> = {
  void: "reportsExKindVoid",
  discount: "reportsExKindDiscount",
  discount_reversal: "reportsExKindDiscountReversal",
  refund: "reportsExKindRefund",
  paid_out: "reportsExKindPaidOut",
  drawer_difference: "reportsExKindDrawerDifference",
  terminal_difference: "reportsExKindTerminalDifference",
  reprint: "reportsExKindReprint",
  corte_reprint: "reportsExKindCorteReprint",
  open_price: "reportsExKindOpenPrice",
  offline_archive: "reportsExKindOfflineArchive",
  offline_reconcile: "reportsExKindOfflineReconcile",
  platform_tender: "payExKindPlatformTender",
};
export function exceptionKindLabel(kind: ExceptionKind, locale: Locale) {
  return strings[locale][EXCEPTION_KEYS[kind]];
}

const GROUP_KEYS: Record<AuditGroup, Key> = {
  sales: "reportsAuditGroupSales",
  kitchen: "reportsAuditGroupKitchen",
  cash: "reportsAuditGroupCash",
  corrections: "reportsAuditGroupCorrections",
  menu: "reportsAuditGroupMenu",
  access: "reportsAuditGroupAccess",
  settings: "reportsAuditGroupSettings",
  fiscal: "reportsAuditGroupFiscal",
  reports: "reportsAuditGroupReports",
  loyalty: "loyaltyAuditGroup",
};
export function auditGroupLabel(group: AuditGroup, locale: Locale) {
  return strings[locale][GROUP_KEYS[group]];
}

/** Sobrante / Faltante / Cuadra as text, never color alone. */
export function differenceLabel(n: number, locale: Locale): string {
  const t = strings[locale];
  const kind = differenceKind(n);
  return kind === "short"
    ? t.reportsShort
    : kind === "over"
      ? t.reportsOver
      : t.reportsBalanced;
}

/**
 * One folio run as printed: "Folios A-000101 a A-000140 (40 tickets)", "Folio A-000171 (1
 * ticket)", or a corte's summary of interleaved runs ("Folios A-000101 … A-000349: 120 tickets
 * en 37 tramos …"), never a range that reads as contiguous when it is not.
 */
export function folioText(
  run: { first: string; last: string; count: number; runs?: number },
  locale: Locale,
): string {
  const t = strings[locale];
  if (run.runs && run.runs > 1)
    return fill(t.reportsFoliosRuns, {
      first: run.first,
      last: run.last,
      n: run.count,
      runs: run.runs,
    });
  if (run.count === 1) return fill(t.reportsFolioOne, { first: run.first });
  return fill(t.reportsFolios, {
    first: run.first,
    last: run.last,
    n: run.count,
  });
}

/** A count text with its singular variant for n = 1 ("1 cobro", "3 cobros"; UI-14). */
export function countFill(
  locale: Locale,
  many: Key,
  one: Key,
  n: number,
  values: Record<string, string | number> = {},
): string {
  const t = strings[locale];
  return fill(n === 1 ? t[one] : t[many], { ...values, n });
}
