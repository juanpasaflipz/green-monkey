// shared/csv.ts — RFC 4180 CSV text for every report export (reports 029; cfdi 030 reuses it),
// with the OWASP formula-injection guard. Pure: the browser download (Blob + <a download>) and
// the per-dataset column lists live in the client (src/features/reports/csv.ts, next wave).
// Format (§2.9): UTF-8 with BOM, comma separator, CRLF after every record, headers in the UI
// language, money as dot decimals with the currency exponent, dates as AAAA-MM-DD and date-times
// as AAAA-MM-DD HH:mm in the restaurant zone.
import { Temporal } from "@js-temporal/polyfill";
import { currencyExponent, type Label, type Locale } from "./domain.js";

export const CSV_BOM = "﻿";
export const CSV_EOL = "\r\n";

/**
 * Column types: `t` text (formula guard), `m` money in minor units, `i` integer, `p` percent with
 * one decimal from basis points, `d` business date, `dt` instant shown in the restaurant zone.
 */
export type CsvType = "t" | "m" | "i" | "p" | "d" | "dt";
export type CsvValue = string | number | null | undefined;
export type CsvColumn<T> = {
  /** A ready string, or a Label resolved with the context's locale. */
  header: string | Label;
  type: CsvType;
  value: (row: T) => CsvValue;
};
export type CsvContext = { locale: Locale; currency: string; timezone: string };

/** OWASP CSV injection: `= + - @`, TAB, CR, LF and the full-width `＝＋－＠` start a formula. */
const FORMULA_START = /^[=+\-@\t\r\n＝＋－＠]/;
/**
 * Quoted: a comma, quote, CR or LF, and a `;` or TAB followed by a formula start. Excel opened
 * by double-click splits on the system list separator, which is `;` in many locales; quoting
 * keeps the field whole, so the part after the separator can never become a live formula cell
 * (REPORTS-SECURITY-2). Other `;` text (fiscal's "Efectivo 200.00; Terminal …") stays as is.
 */
const NEEDS_QUOTES = /[",\r\n]|[;\t]\s*[=+\-@＝＋－＠]/;
/** What a formatted non-text cell may look like; anything else is written as guarded text. */
const TYPED_CELL: Record<Exclude<CsvType, "t">, RegExp> = {
  m: /^-?\d+(?:\.\d+)?$/,
  i: /^-?\d+$/,
  p: /^-?\d+\.\d$/,
  d: /^\d{4}-\d{2}-\d{2}$/,
  dt: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
};

const quote = (text: string) => '"' + text.replace(/"/g, '""') + '"';

/**
 * One serialized cell from an already formatted value. Text that could start a formula is
 * prefixed with an apostrophe and quoted; a field with a comma, quote, CR or LF, or a `;` or TAB
 * before a formula start (NEEDS_QUOTES), is quoted with its quotes doubled. Numeric and date cells are written as they are, never prefixed, but only
 * when they really have their type's shape: anything else falls back to guarded text.
 *
 * A raw number in a money (`m`) or percent (`p`) column is a TypeError("csv_unformatted"): it is
 * minor units or basis points, and writing it as is would put 2000 for MXN 20.00 in the file.
 * Format it first with moneyCsv / percentCsv, or let toCsv do it.
 */
export function csvCell(value: CsvValue, type: CsvType): string {
  if (typeof value === "number" && (type === "m" || type === "p"))
    throw new TypeError("csv_unformatted");
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (text === "") return "";
  if (type !== "t" && TYPED_CELL[type].test(text)) return text;
  if (FORMULA_START.test(text)) return quote("'" + text);
  return NEEDS_QUOTES.test(text) ? quote(text) : text;
}

function integer(n: number): number {
  if (!Number.isSafeInteger(n)) throw new RangeError("invalid_amount");
  return n;
}

/** Minor units as a dot-decimal string with the currency exponent: MXN 123450 → "1234.50". */
export function moneyCsv(n: number, currency: string): string {
  const value = integer(n);
  const exponent = currencyExponent(currency);
  const digits = String(Math.abs(value));
  if (exponent === 0) return String(value);
  const padded = digits.padStart(exponent + 1, "0");
  return (
    (value < 0 ? "-" : "") +
    padded.slice(0, -exponent) +
    "." +
    padded.slice(-exponent)
  );
}

/** Basis points as a percent with one decimal, half away from zero: 1235 → "12.4". */
export function percentCsv(bps: number): string {
  const value = integer(bps);
  const tenths = Math.floor((Math.abs(value) + 5) / 10);
  return (
    (value < 0 && tenths > 0 ? "-" : "") +
    Math.floor(tenths / 10) +
    "." +
    (tenths % 10)
  );
}

/** An instant (ISO or PostgreSQL timestamptz text) as "AAAA-MM-DD HH:mm" in `zone`. */
export function dateTimeCsv(instant: string, zone: string): string {
  const local = Temporal.Instant.from(instant).toZonedDateTimeISO(zone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${local.toPlainDate()} ${pad(local.hour)}:${pad(local.minute)}`;
}

function format(value: CsvValue, type: CsvType, ctx: CsvContext): CsvValue {
  if (value === null || value === undefined || value === "") return value;
  if (typeof value === "number")
    switch (type) {
      case "m":
        return moneyCsv(value, ctx.currency);
      case "i":
        return String(integer(value));
      case "p":
        return percentCsv(value);
      default:
        return String(value);
    }
  if (type !== "dt" || TYPED_CELL.dt.test(value)) return value;
  try {
    return dateTimeCsv(value, ctx.timezone);
  } catch {
    return value; // not an instant: csvCell writes it as guarded text
  }
}

/** The whole file: BOM, the header record, one record per row, CRLF after each record. */
export function toCsv<T>(
  columns: readonly CsvColumn<T>[],
  rows: readonly T[],
  ctx: CsvContext,
): string {
  const header = columns.map((c) =>
    csvCell(
      typeof c.header === "string" ? c.header : c.header[ctx.locale],
      "t",
    ),
  );
  const records = rows.map((row) =>
    columns.map((c) => csvCell(format(c.value(row), c.type, ctx), c.type)),
  );
  return (
    CSV_BOM +
    [header, ...records].map((cells) => cells.join(",") + CSV_EOL).join("")
  );
}

/** `{dataset}_{from}_{to}.csv`, or `{dataset}_{date}.csv` for a single day. */
export function csvFileName(
  dataset: string,
  range: { from: string; to: string },
): string {
  return range.from === range.to
    ? `${dataset}_${range.from}.csv`
    : `${dataset}_${range.from}_${range.to}.csv`;
}
