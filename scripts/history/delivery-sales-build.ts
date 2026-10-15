// scripts/history/delivery-sales-build.ts — builds the gm-delivery-sales file that the owner
// uploads in Finanzas › Histórico de plataformas (041, docs/DELIVERY_HISTORY.md runbook). Operator
// tool, not part of the server: it reads local files only and never connects to a database.
//
//   npx tsx scripts/history/delivery-sales-build.ts \
//     --target <green-monkey restaurant id> --name "<restaurant name shown in the preview>" \
//     --store "<store label>" [--store "<another label>"] \
//     [--poslite <poslite-delivery.json>] \
//     [--portal uber_eats=<file>] [--portal rappi=<file>] [--portal didi_food=<file>] \
//     [--cutover uber_eats=YYYY-MM-DD] [--cutover rappi=YYYY-MM-DD] [--cutover didi_food=YYYY-MM-DD] \
//     [--note platform=<text>] [--exported-at <ISO instant>] [--currency MXN] \
//     --out <private scratchpad>/delivery-sales.json
//
// Inputs:
// 1. --poslite: scripts/history/poslite-delivery-export.sql's output (pos-lite's manual batches,
//    daily per source; read-only export).
// 2. --portal platform=file: the platform portal's daily totals, normalised by the operator to a
//    pipe-separated (PSV) or comma-separated (CSV) file with exactly this header line:
//
//      date|store|orders|gross|commission|net|unsettled|cancelled|chargebacks
//
//    date YYYY-MM-DD (the platform's local calendar date); store the label shown in Green Monkey;
//    orders, unsettled (orders whose payout is not known yet) and cancelled whole numbers (empty =
//    0); gross, commission, net and chargebacks in PESOS with at most 2 decimals ("1234.50"),
//    commission and net empty when the portal does not say, chargebacks empty = 0. Blank lines and
//    lines starting with # are ignored. A CSV field cannot be quoted: use PSV when a store has a
//    comma. Any other line fails the build with its line number.
// 3. --cutover platform=date: when a platform has both inputs, pos-lite's rows BEFORE the date and
//    the portal's rows FROM it on (required then; a platform with one input uses all of it).
//    --store is the allow-list: rows of any other store (e.g. a second restaurant on the same
//    platform account) are left out and listed, never imported.
//
// Writes the JSON file (mode 0600) and prints a per-platform and month summary for the operator to
// compare with the portals before handing the file to the owner. The pure parts (parse, merge,
// build, summary) are exported for tests/delivery-history.test.ts.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Decimal } from "decimal.js";
import {
  DELIVERY_HISTORY_FORMAT,
  DELIVERY_PLATFORMS,
  isCalendarDate,
  isDeliveryPlatform,
  storeLabel,
  type DeliveryPlatform,
} from "../../shared/delivery-history.js";

/** One day row as the file carries it (money as pesos text, 2 decimals). */
export type BuildRow = {
  date: string;
  platform: DeliveryPlatform;
  store: string;
  orders: number;
  gross: string;
  commission: string | null;
  net: string | null;
  unsettledOrders: number;
  cancelled: number;
  chargebacks: string;
};
export type Origin = "portal" | "pos-lite";

export const PORTAL_HEADER = [
  "date",
  "store",
  "orders",
  "gross",
  "commission",
  "net",
  "unsettled",
  "cancelled",
  "chargebacks",
] as const;
const PESOS = /^-?\d+(\.\d{1,2})?$/;

/** Pesos text with at most 2 decimals → "123.40"; anything else throws `what`. */
function pesos(v: string, what: string, opts: { negative?: boolean } = {}) {
  const t = v.trim();
  if (!PESOS.test(t)) throw new Error(`${what}: "${v}" is not pesos with at most 2 decimals`);
  const d = new Decimal(t);
  if (d.isNegative() && !opts.negative) throw new Error(`${what}: "${v}" is negative`);
  return d.toFixed(2);
}
function whole(v: string, what: string) {
  const t = v.trim();
  if (t === "") return 0;
  if (!/^\d+$/.test(t)) throw new Error(`${what}: "${v}" is not a whole number`);
  return Number(t);
}

/** A portal PSV/CSV file (header above) as rows of `platform`. */
export function parsePortalFile(text: string, platform: DeliveryPlatform, name: string = platform): BuildRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let header: number | null = null;
  let sep = "|";
  const rows: BuildRow[] = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const at = `${name}:${i + 1}`;
    if (!line || line.startsWith("#")) return;
    if (header === null) {
      sep = line.includes("|") ? "|" : ",";
      const cols = line.split(sep).map((c) => c.trim().toLowerCase());
      if (cols.join("|") !== PORTAL_HEADER.join("|"))
        throw new Error(`${at}: the header must be ${PORTAL_HEADER.join("|")}`);
      header = i;
      return;
    }
    if (sep === "," && line.includes('"')) throw new Error(`${at}: quoted CSV fields are not supported; use PSV`);
    const f = raw.split(sep);
    if (f.length !== PORTAL_HEADER.length)
      throw new Error(`${at}: ${f.length} fields, expected ${PORTAL_HEADER.length}`);
    const [date, store, orders, gross, commission, net, unsettled, cancelled, chargebacks] = f.map((x) => x.trim()) as [
      string, string, string, string, string, string, string, string, string,
    ];
    if (!isCalendarDate(date)) throw new Error(`${at}: "${date}" is not a YYYY-MM-DD date`);
    const label = storeLabel(store);
    if (!label || label.length > 80) throw new Error(`${at}: the store must be 1 to 80 characters`);
    const n = whole(orders, `${at} orders`);
    if (n === 0) throw new Error(`${at}: a row needs orders > 0`);
    rows.push({
      date,
      platform,
      store: label,
      orders: n,
      gross: pesos(gross, `${at} gross`),
      commission: commission === "" ? null : pesos(commission, `${at} commission`),
      net: net === "" ? null : pesos(net, `${at} net`, { negative: true }),
      unsettledOrders: whole(unsettled, `${at} unsettled`),
      cancelled: whole(cancelled, `${at} cancelled`),
      chargebacks: chargebacks === "" ? "0.00" : pesos(chargebacks, `${at} chargebacks`),
    });
  });
  if (header === null) throw new Error(`${name}: no header line`);
  return rows;
}

/** poslite-delivery-export.sql's document as rows; a source without a platform fails the build. */
export function parsePosLiteDelivery(doc: unknown): { rows: BuildRow[]; sourceName: string | null } {
  const d = doc as {
    format?: unknown;
    sourceName?: unknown;
    rows?: {
      date: string;
      source: string;
      platform: string | null;
      store: string | null;
      orders: number;
      gross: string;
      commission: string | null;
      net: string | null;
    }[];
  };
  if (!d || d.format !== "pos-lite-delivery" || !Array.isArray(d.rows))
    throw new Error("--poslite: not a poslite-delivery-export.sql document");
  const unknown = [...new Set(d.rows.filter((r) => !isDeliveryPlatform(r.platform)).map((r) => r.source))];
  if (unknown.length) throw new Error(`--poslite: sources without a platform: ${unknown.join(", ")}`);
  const rows = d.rows.map((r, i): BuildRow => {
    const at = `poslite row ${i + 1}`;
    if (!isCalendarDate(r.date)) throw new Error(`${at}: bad date`);
    if (!Number.isInteger(r.orders) || r.orders <= 0) throw new Error(`${at}: bad orders`);
    return {
      date: r.date,
      platform: r.platform as DeliveryPlatform,
      store: storeLabel(r.store ?? ""),
      orders: r.orders,
      // pos-lite numeric(10,2): exact text; Decimal keeps it exact.
      gross: new Decimal(r.gross).toFixed(2),
      commission: r.commission === null ? null : new Decimal(r.commission).toFixed(2),
      net: r.net === null ? null : new Decimal(r.net).toFixed(2),
      unsettledOrders: 0,
      cancelled: 0,
      chargebacks: "0.00",
    };
  });
  return { rows, sourceName: typeof d.sourceName === "string" ? d.sourceName : null };
}

export type MergeInput = {
  poslite: BuildRow[];
  portals: Partial<Record<DeliveryPlatform, BuildRow[]>>;
  cutovers: Partial<Record<DeliveryPlatform, string>>;
  /** The allow-list of store labels; every other store is excluded. */
  stores: string[];
  notes?: Partial<Record<DeliveryPlatform, string>>;
};
export type MergeResult = {
  days: BuildRow[];
  sources: { platform: DeliveryPlatform; origin: Origin; from: string; to: string; note?: string }[];
  /** Rows left out: a store not in the allow-list, or the other side of a cutover. */
  excluded: { platform: DeliveryPlatform; origin: Origin; store: string; rows: number; reason: "store" | "cutover" }[];
};

/**
 * Per platform: pos-lite rows before its cutover and portal rows from it on (a platform with one
 * input uses all of it; with both, a cutover is required). Rows of a store outside the allow-list
 * are excluded. A repeated (date, platform, store) after the merge fails the build.
 */
export function mergeDeliverySources(input: MergeInput): MergeResult {
  const allow = new Set(input.stores.map(storeLabel));
  if (!allow.size) throw new Error("--store: at least one store label is required");
  const days: BuildRow[] = [];
  const sources: MergeResult["sources"] = [];
  const excluded = new Map<string, MergeResult["excluded"][number]>();
  const exclude = (platform: DeliveryPlatform, origin: Origin, store: string, reason: "store" | "cutover") => {
    const k = [platform, origin, store, reason].join("|");
    const e = excluded.get(k) ?? excluded.set(k, { platform, origin, store, rows: 0, reason }).get(k)!;
    e.rows++;
  };
  for (const p of Object.keys(input.cutovers))
    if (!isDeliveryPlatform(p)) throw new Error(`--cutover: unknown platform ${p}`);
  for (const platform of DELIVERY_PLATFORMS) {
    const fromPos = input.poslite.filter((r) => r.platform === platform);
    const fromPortal = input.portals[platform] ?? [];
    const cutover = input.cutovers[platform];
    if (cutover !== undefined && !isCalendarDate(cutover)) throw new Error(`--cutover ${platform}: bad date`);
    if (fromPos.length && fromPortal.length && !cutover)
      throw new Error(`--cutover ${platform}=YYYY-MM-DD is required: both pos-lite and the portal have rows`);
    for (const [origin, rows] of [
      ["pos-lite", fromPos],
      ["portal", fromPortal],
    ] as const) {
      const kept: BuildRow[] = [];
      for (const r of rows) {
        if (cutover && (origin === "pos-lite" ? r.date >= cutover : r.date < cutover))
          exclude(platform, origin, r.store, "cutover");
        else if (!allow.has(r.store)) exclude(platform, origin, r.store, "store");
        else kept.push(r);
      }
      if (!kept.length) continue;
      const dates = kept.map((r) => r.date).sort();
      const note = input.notes?.[platform];
      sources.push({ platform, origin, from: dates[0]!, to: dates[dates.length - 1]!, ...(note ? { note } : {}) });
      days.push(...kept);
    }
  }
  days.sort(
    (a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform) || a.store.localeCompare(b.store),
  );
  const seen = new Set<string>();
  for (const r of days) {
    const k = `${r.date}|${r.platform}|${r.store}`;
    if (seen.has(k)) throw new Error(`repeated day ${k}: each (date, platform, store) must appear once`);
    seen.add(k);
  }
  return { days, sources, excluded: [...excluded.values()] };
}

/** The gm-delivery-sales v1 document, its summary computed exactly from the rows. */
export function buildDeliveryFile(o: {
  targetTenantId: string;
  sourceName: string;
  exportedAt: string;
  currency?: string;
  merged: MergeResult;
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(o.targetTenantId))
    throw new Error("--target must be the Green Monkey restaurant id (a uuid)");
  if (Number.isNaN(Date.parse(o.exportedAt))) throw new Error("--exported-at must be an ISO instant");
  if (!o.merged.days.length) throw new Error("nothing to write: no row passed the merge");
  const sum = (k: "gross" | "commission" | "net") =>
    o.merged.days.reduce((a, r) => a.plus(r[k] ?? 0), new Decimal(0)).toFixed(2);
  return {
    format: DELIVERY_HISTORY_FORMAT,
    version: 1 as const,
    exportedAt: new Date(o.exportedAt).toISOString(),
    currency: o.currency ?? "MXN",
    targetTenantId: o.targetTenantId,
    sourceName: o.sourceName,
    sources: o.merged.sources,
    days: o.merged.days,
    summary: {
      days: o.merged.days.length,
      orders: o.merged.days.reduce((a, r) => a + r.orders, 0),
      gross: sum("gross"),
      commission: sum("commission"),
      net: sum("net"),
    },
  };
}

/** Per platform and month: rows, orders, gross, commission and net (pesos text), unsettled orders. */
export function monthSummary(days: readonly BuildRow[]) {
  const out = new Map<
    string,
    { platform: string; month: string; days: number; orders: number; gross: Decimal; commission: Decimal; net: Decimal; unsettled: number }
  >();
  for (const r of days) {
    const k = r.platform + "|" + r.date.slice(0, 7);
    const m =
      out.get(k) ??
      out
        .set(k, {
          platform: r.platform,
          month: r.date.slice(0, 7),
          days: 0,
          orders: 0,
          gross: new Decimal(0),
          commission: new Decimal(0),
          net: new Decimal(0),
          unsettled: 0,
        })
        .get(k)!;
    m.days++;
    m.orders += r.orders;
    m.gross = m.gross.plus(r.gross);
    m.commission = m.commission.plus(r.commission ?? 0);
    m.net = m.net.plus(r.net ?? 0);
    m.unsettled += r.unsettledOrders;
  }
  return [...out.values()]
    .sort((a, b) => a.platform.localeCompare(b.platform) || a.month.localeCompare(b.month))
    .map((m) => ({
      ...m,
      gross: m.gross.toFixed(2),
      commission: m.commission.toFixed(2),
      net: m.net.toFixed(2),
    }));
}

/** "platform=value" options as a record (one per platform). */
function perPlatform(values: string[] | undefined, flag: string) {
  const out: Partial<Record<DeliveryPlatform, string>> = {};
  for (const v of values ?? []) {
    const i = v.indexOf("=");
    const p = v.slice(0, i);
    if (i <= 0 || !isDeliveryPlatform(p)) throw new Error(`--${flag} ${v}: expected platform=value (${DELIVERY_PLATFORMS.join(", ")})`);
    if (out[p] !== undefined) throw new Error(`--${flag} ${p} given twice`);
    out[p] = v.slice(i + 1);
  }
  return out;
}

function main() {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      name: { type: "string" },
      store: { type: "string", multiple: true },
      poslite: { type: "string" },
      portal: { type: "string", multiple: true },
      cutover: { type: "string", multiple: true },
      note: { type: "string", multiple: true },
      "exported-at": { type: "string" },
      currency: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
  });
  if (!values.target || !values.out || !values.store?.length)
    throw new Error("usage: --target <restaurant id> --store <label> [--store …] --out <file> (see the header)");
  const pos = values.poslite ? parsePosLiteDelivery(JSON.parse(readFileSync(values.poslite, "utf8"))) : null;
  const portals: MergeInput["portals"] = {};
  for (const [platform, file] of Object.entries(perPlatform(values.portal, "portal")))
    portals[platform as DeliveryPlatform] = parsePortalFile(readFileSync(file, "utf8"), platform as DeliveryPlatform, file as string);
  const merged = mergeDeliverySources({
    poslite: pos?.rows ?? [],
    portals,
    cutovers: perPlatform(values.cutover, "cutover"),
    stores: values.store,
    notes: perPlatform(values.note, "note"),
  });
  const doc = buildDeliveryFile({
    targetTenantId: values.target,
    sourceName: values.name ?? pos?.sourceName ?? "",
    exportedAt: values["exported-at"] ?? new Date().toISOString(),
    currency: values.currency,
    merged,
  });
  writeFileSync(values.out, JSON.stringify(doc), { mode: 0o600 });
  console.log(`wrote ${values.out}: ${doc.summary.days} days, ${doc.summary.orders} orders, gross ${doc.summary.gross}`);
  for (const s of merged.sources) console.log(`source ${s.platform} ${s.origin} ${s.from}..${s.to}`);
  for (const e of merged.excluded)
    console.log(`excluded ${e.platform} ${e.origin} "${e.store}" ${e.rows} rows (${e.reason})`);
  console.table(monthSummary(doc.days));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
