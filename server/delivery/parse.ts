import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { Decimal } from "decimal.js";

export class DeliveryError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export function minor(value: unknown): number {
  if (typeof value !== "string" || !/^-?\d+(\.\d{1,2})?$/.test(value.trim()))
    throw new DeliveryError("delivery_report_invalid");
  const n = new Decimal(value.trim()).mul(100).toNumber();
  if (!Number.isSafeInteger(n))
    throw new DeliveryError("delivery_report_invalid");
  return n;
}
export interface ParsedDeliveryReport {
  orderCount: number;
  gross: number;
  adjusted: number;
  payout: number;
  currency: "MXN";
  hash: string;
}
const required = [
  "Store Name",
  "Store UUID",
  "Workflow ID",
  "Order Date",
  "Order Status",
  "Currency Code",
  "Sales (incl. VAT)",
  "Total Sales after Adjustments (incl. VAT)",
  "Total payout",
];
/** Original two-header Uber CSV; no customer data is persisted. */
export function parseUberReport(
  bytes: Uint8Array,
  day: string,
  store: string,
): ParsedDeliveryReport {
  if (bytes.byteLength > 10_000_000)
    throw new DeliveryError("delivery_report_too_large");
  const rows = parse(Buffer.from(bytes), {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: false,
  }) as string[][];
  const headerIndex = rows.findIndex((r) =>
    required.every((k) => r.map((x) => x.trim()).includes(k)),
  );
  if (headerIndex < 0 || headerIndex > 2)
    throw new DeliveryError("delivery_report_schema");
  const headers = rows[headerIndex].map((x) => x.trim());
  if (new Set(headers).size !== headers.length)
    throw new DeliveryError("delivery_report_schema");
  const orders = new Set<string>(),
    storeIds = new Set<string>();
  let gross = 0,
    adjusted = 0,
    payout = 0;
  // Header-only reports cannot prove the selected store/date, so fail closed.
  if (rows.length === headerIndex + 1)
    throw new DeliveryError("delivery_empty_report");
  for (const raw of rows.slice(headerIndex + 1)) {
    if (raw.length !== headers.length)
      throw new DeliveryError("delivery_report_schema");
    const r = Object.fromEntries(headers.map((key, i) => [key, raw[i].trim()]));
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(r["Order Date"]);
    const date = m
      ? `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`
      : "";
    if (
      date !== day ||
      r["Store Name"] !== store ||
      r["Currency Code"] !== "MXN" ||
      !r["Store UUID"]
    )
      throw new DeliveryError("delivery_report_scope");
    storeIds.add(r["Store UUID"]);
    const status = r["Order Status"],
      id = r["Workflow ID"];
    if (
      !["", "Completed", "Cancelled", "Refund", "Unfulfilled"].includes(status)
    )
      throw new DeliveryError("delivery_report_schema");
    if (status === "Completed") {
      if (!id || orders.has(id))
        throw new DeliveryError("delivery_duplicate_order");
      orders.add(id);
    }
    gross += minor(r["Sales (incl. VAT)"]);
    adjusted += minor(r["Total Sales after Adjustments (incl. VAT)"]);
    payout += minor(r["Total payout"]);
    if (![gross, adjusted, payout].every(Number.isSafeInteger))
      throw new DeliveryError("delivery_report_invalid");
  }
  if (storeIds.size !== 1) throw new DeliveryError("delivery_report_scope");
  return {
    orderCount: orders.size,
    gross,
    adjusted,
    payout,
    currency: "MXN",
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
}
