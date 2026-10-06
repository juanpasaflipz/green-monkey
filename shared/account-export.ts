import { CSV_BOM, CSV_EOL, csvCell as textCell } from "./csv.js";

/**
 * Owner data export (account 031, GAP-5): every public table with a tenant_id
 * column, discovered at request time, minus these tables and secret columns.
 * Contract for every area: name a secret column with a hash/secret/token/csrf
 * segment, or list it here.
 */
export const EXPORT_TABLE_DENYLIST: ReadonlySet<string> = new Set([
  // Security state, credentials and account-scoped rows (a tenant-only
  // export transaction would read them empty or expose credentials).
  "sessions",
  "operations",
  "offline_leases",
  "owner_browser_devices",
  "owner_memberships",
  "owner_location_commands",
  "restaurant_invitations",
  "signup_billing_intents",
  "billing_locations",
  "jobs",
  // cfdi 030: provider credential ciphertext, and the XML/PDF binaries (the
  // CFDI register offers its own downloads).
  "cfdi_secrets",
  "cfdi_files",
]);
/** Column names with one of these segments are never exported. */
export const EXPORT_COLUMN_DENY = /(^|_)(hash|secret|token|csrf)(_|$)/;
export { CSV_BOM };

/** Restaurant columns in the export header block (restaurants has no tenant_id). */
export const EXPORT_RESTAURANT_COLUMNS = [
  "id",
  "organization_id",
  "name",
  "currency",
  "timezone",
  "cutoff",
  "opening_days",
  "config_version",
  "free_location",
  "activation_pending",
  "negative_stock_policy",
  "offline_table_service",
] as const;

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
/**
 * One CSV cell of a raw table value: null/undefined → empty, Date → ISO, objects
 * and arrays → JSON, numbers (and numeric strings, as PostgreSQL sends numeric)
 * as they are; any other text goes through the shared OWASP guard (shared/csv.ts):
 * a leading = + - @ TAB CR LF gets an apostrophe, and commas, quotes and line
 * breaks are quoted.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object")
    return textCell(JSON.stringify(v, jsonReplacer), "t");
  const text = String(v);
  return PLAIN_NUMBER.test(text) ? text : textCell(text, "t");
}
/** Cells joined by commas, CRLF line end. */
export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",") + CSV_EOL;
}
/** JSON.stringify replacer for exported rows: bigint as a string (the server adds binary handling). */
export function jsonReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

/** green-monkey-<slug>-<YYYYMMDD>.json / green-monkey-<slug>-<table>-<YYYYMMDD>.csv */
export function exportFilename(
  restaurantName: string,
  dateYmd: string,
  table?: string,
): string {
  const slug =
    restaurantName
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "restaurante";
  const date = dateYmd.replace(/-/g, "");
  return table
    ? `green-monkey-${slug}-${table}-${date}.csv`
    : `green-monkey-${slug}-${date}.json`;
}
