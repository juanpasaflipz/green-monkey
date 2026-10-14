/**
 * Histórico de plataformas (041, docs/DELIVERY_HISTORY.md): the restaurant's Uber Eats, Rappi and
 * DiDi Food sales as report history only. The owner uploads the operator's gm-delivery-sales file
 * (raw body, read only after authentication and the managers check: routes/delivery-history.ts);
 * the server hashes the exact bytes, validates and converts every row (shared/delivery-history.ts)
 * and stores the daily rows as they are: platform calendar dates, never re-bucketed by the cutoff.
 *
 * Isolation: these functions write only the three delivery_history_* tables and one audit row.
 * They never touch orders, tenders, cash, fiscal tickets, CFDI, discounts, refunds, stock, loyalty
 * or jobs, nor 040's sales_history_* tables, and no existing report reads delivery_history_*
 * (tests/delivery-history-db.ts proves both).
 *
 * Import (one transaction): 1 (the import key, class 0: tenant + 'delivery-platforms') → 2
 * (restaurants FOR SHARE: the currency the file is checked against) → inserts. The same file
 * (sha256 of its bytes) is a replay. For each platform it contains, a newer file takes over every
 * date from that platform's first to last row through delivery_history_coverage; other platforms
 * and dates stay with their batch. A file older than one already covering any of its
 * (platform, date) pairs is refused.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import { managers, permit } from "./auth.js";
import { requireRecentAuth } from "./access.js";
import { audit } from "./orders.js";
import { DomainError, type Session } from "../shared/domain.js";
import { parseRange } from "../shared/reports.js";
import {
  DELIVERY_HISTORY_MAX_BYTES,
  DELIVERY_HISTORY_MAX_DAYS,
  DELIVERY_HISTORY_SOURCE,
  deliveryHistoryFile,
  normalizeDeliveryHistory,
  platformTotals,
  type DeliveryCoverage,
  type DeliveryHistoryFile,
  type DeliveryHistoryImportResult,
  type DeliveryHistoryPreview,
  type DeliveryHistoryReport,
  type DeliveryNormalized,
} from "../shared/delivery-history.js";

/** Rows per multi-row insert (well under PostgreSQL's 65535 bind parameters). */
const INSERT_CHUNK = 1000;

type Prepared = { file: DeliveryHistoryFile; hash: string; normalized: DeliveryNormalized };

/** The upload's bytes as the gm-delivery-sales document and its sha256; anything else is refused. */
export function parseDeliveryHistoryFile(body: unknown): { file: DeliveryHistoryFile; hash: string } {
  if (!Buffer.isBuffer(body) || body.length === 0)
    throw new DomainError("delivery_history_file_invalid", 422);
  if (body.length > DELIVERY_HISTORY_MAX_BYTES)
    throw new DomainError("delivery_history_file_too_large", 413);
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    throw new DomainError("delivery_history_file_invalid", 422);
  }
  const parsed = deliveryHistoryFile.safeParse(json);
  if (!parsed.success) throw new DomainError("delivery_history_file_invalid", 422);
  return { file: parsed.data, hash: createHash("sha256").update(body).digest("hex") };
}

/** Validates the file for this restaurant and converts every row. */
async function prepare(tx: Tx, s: Session, body: unknown): Promise<Prepared> {
  const { file, hash } = parseDeliveryHistoryFile(body);
  // The builder's --target names the Green Monkey restaurant: another one's file is refused.
  if (file.targetTenantId !== s.tenantId) throw new DomainError("delivery_history_scope", 403);
  const [restaurant] = await tx`select currency from restaurants where id=${s.tenantId}`;
  if (!restaurant || restaurant.currency !== file.currency)
    throw new DomainError("delivery_history_currency", 422);
  return { file, hash, normalized: normalizeDeliveryHistory(file) };
}

/** Per-platform spans as parallel arrays (unnest) for the coverage queries. */
function spans(coverage: DeliveryCoverage) {
  const entries = Object.entries(coverage) as [string, { from: string; to: string }][];
  return {
    platforms: entries.map(([p]) => p),
    froms: entries.map(([, c]) => c.from),
    tos: entries.map(([, c]) => c.to),
  };
}

/** (platform, date) pairs of the coverage already owned by a batch, and whether any is newer. */
async function overlap(tx: Tx, coverage: DeliveryCoverage, exportedAt: string) {
  const sp = spans(coverage);
  if (!sp.platforms.length) return { days: 0, newer: false, batches: [] as string[] };
  const rows = await tx`select c.batch_id, count(*)::int as days,
      bool_or(b.exported_at > ${exportedAt}::timestamptz) as newer
    from delivery_history_coverage c
    join delivery_history_batches b on b.tenant_id=c.tenant_id and b.id=c.batch_id
    join unnest(${tx.array(sp.platforms)}::text[], ${tx.array(sp.froms)}::date[],
      ${tx.array(sp.tos)}::date[]) as x(platform, f, t)
      on x.platform=c.platform and c.business_date between x.f and x.t
    group by c.batch_id order by c.batch_id`;
  return {
    days: rows.reduce((a: number, r: any) => a + r.days, 0),
    newer: rows.some((r: any) => r.newer),
    batches: rows.map((r: any) => r.batch_id as string),
  };
}

/** POST /api/delivery-history/preview (owners and managers): what Importar would do. Writes nothing. */
export async function previewDeliveryHistory(
  tx: Tx,
  s: Session,
  body: unknown,
): Promise<DeliveryHistoryPreview> {
  permit(s, managers);
  const p = await prepare(tx, s, body);
  const [existing] =
    await tx`select id from delivery_history_batches where source=${DELIVERY_HISTORY_SOURCE} and file_hash=${p.hash}`;
  const o = await overlap(tx, p.normalized.coverage, p.file.exportedAt);
  const r = p.normalized;
  return {
    fileHash: p.hash,
    sourceName: p.file.sourceName ?? null,
    exportedAt: new Date(p.file.exportedAt).toISOString(),
    sources: p.file.sources,
    coverage: r.coverage,
    days: r.accepted.length,
    orders: r.accepted.reduce((a, d) => a + d.orders, 0),
    rejected: r.rejected,
    byPlatform: platformTotals(r.accepted),
    reconciliation: r.reconciliation,
    alreadyImported: !!existing,
    replacesDays: existing ? 0 : o.days,
    olderThanImported: !existing && o.newer,
  };
}

/**
 * POST /api/delivery-history/import (owners and managers, recent PIN): commits the file the
 * preview showed (x-gm-file-hash must equal the uploaded bytes' hash). The same file again is a
 * replay.
 */
export async function importDeliveryHistory(
  tx: Tx,
  s: Session,
  body: unknown,
  expectedHash: unknown,
): Promise<DeliveryHistoryImportResult> {
  permit(s, managers);
  requireRecentAuth(s);
  // LO-1 (class 0) before the restaurants row (LO-2): one import at a time per restaurant.
  await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + DELIVERY_HISTORY_SOURCE},0))`;
  // The currency prepare() checks the file against cannot change until this import commits.
  await tx`select currency from restaurants where id=${s.tenantId} for share`;
  const p = await prepare(tx, s, body);
  if (typeof expectedHash !== "string" || expectedHash !== p.hash)
    throw new DomainError("delivery_history_file_changed", 409);
  const [existing] = await tx`select id, days, orders from delivery_history_batches
    where source=${DELIVERY_HISTORY_SOURCE} and file_hash=${p.hash}`;
  if (existing)
    return { batchId: existing.id, replayed: true, days: 0, orders: existing.orders, replacedDays: 0 };
  const r = p.normalized;
  if (!r.accepted.length) throw new DomainError("delivery_history_empty", 422);
  const o = await overlap(tx, r.coverage, p.file.exportedAt);
  if (o.newer) throw new DomainError("delivery_history_older_export", 409);
  const batchId = randomUUID();
  const orders = r.accepted.reduce((a, d) => a + d.orders, 0);
  await tx`insert into delivery_history_batches(tenant_id,id,source,source_name,file_hash,exported_at,
      days,orders,rejected,report,imported_by)
    values(${s.tenantId},${batchId},${DELIVERY_HISTORY_SOURCE},${p.file.sourceName ?? null},${p.hash},
      ${p.file.exportedAt},${r.accepted.length},${orders},${r.rejected.length},
      ${tx.json({
        coverage: r.coverage,
        sources: p.file.sources,
        reconciliation: r.reconciliation,
        rejectedByReason: r.rejected.reduce<Record<string, number>>(
          (a, x) => ({ ...a, [x.reason]: (a[x.reason] ?? 0) + 1 }),
          {},
        ),
      } as any)},${s.employeeId})`;
  // Bulk inserts as jsonb record sets, INSERT_CHUNK rows a statement.
  for (let i = 0; i < r.accepted.length; i += INSERT_CHUNK)
    await tx`insert into delivery_history_days(tenant_id,batch_id,business_date,platform,store,orders,
        gross,commission,net,unsettled_orders,cancelled,chargebacks)
      select ${s.tenantId},${batchId},x.date,x.platform,x.store,x.orders,x.gross,x.commission,x.net,
        x."unsettledOrders",x.cancelled,x.chargebacks
      from jsonb_to_recordset(${tx.json(r.accepted.slice(i, i + INSERT_CHUNK) as any)}) as x(date date,
        platform text, store text, orders int, gross bigint, commission bigint, net bigint,
        "unsettledOrders" int, cancelled int, chargebacks bigint)`;
  // For each platform of the file, every date of its span now belongs to this batch, rows or not
  // (a day the newer file shows without sales has none); other platforms and dates keep theirs.
  const sp = spans(r.coverage);
  const days = await tx`insert into delivery_history_coverage(tenant_id,platform,business_date,batch_id)
    select ${s.tenantId}, x.platform, d::date, ${batchId}
      from unnest(${tx.array(sp.platforms)}::text[], ${tx.array(sp.froms)}::date[],
        ${tx.array(sp.tos)}::date[]) as x(platform, f, t),
        generate_series(x.f, x.t, interval '1 day') d
    on conflict (tenant_id,platform,business_date) do update
      set batch_id=excluded.batch_id, updated_at=now()
    returning business_date`;
  await audit(tx, s, "delivery_history.import", batchId, {
    batchId,
    source: DELIVERY_HISTORY_SOURCE,
    exportedAt: p.file.exportedAt,
    coverage: r.coverage,
    days: r.accepted.length,
    coveredDates: days.length,
    orders,
    rejected: r.rejected.length,
    gross: r.reconciliation.converted.gross,
    replacedDays: o.days,
    replacedBatches: o.batches,
  });
  return { batchId, replayed: false, days: r.accepted.length, orders, replacedDays: o.days };
}

const n = (v: unknown) => Number(v);
const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * GET /api/delivery-history?from&to (owners and managers): the rows in force for a calendar-date
 * range (at most DELIVERY_HISTORY_MAX_DAYS), and every import batch.
 */
export async function deliveryHistoryReport(
  tx: Tx,
  s: Session,
  raw: { from?: unknown; to?: unknown },
): Promise<DeliveryHistoryReport> {
  permit(s, managers);
  const range = parseRange(raw, DELIVERY_HISTORY_MAX_DAYS);
  const days = await tx`select d.business_date::text as date, d.platform, d.store, d.orders, d.gross,
      d.commission, d.net, d.unsettled_orders, d.cancelled, d.chargebacks
    from delivery_history_days d
    join delivery_history_coverage c on c.tenant_id=d.tenant_id and c.platform=d.platform
      and c.business_date=d.business_date and c.batch_id=d.batch_id
    where d.business_date between ${range.from}::date and ${range.to}::date
    order by d.business_date, d.platform, d.store`;
  const batches = await tx`select id, source_name, exported_at, report->'coverage' as coverage, days,
      orders, created_at from delivery_history_batches order by created_at desc, id limit 50`;
  return {
    range,
    days: days.map((d: any) => ({
      date: d.date,
      platform: d.platform,
      store: d.store,
      orders: d.orders,
      gross: n(d.gross),
      commission: nn(d.commission),
      net: nn(d.net),
      unsettledOrders: d.unsettled_orders,
      cancelled: d.cancelled,
      chargebacks: n(d.chargebacks),
    })),
    batches: batches.map((b: any) => ({
      id: b.id,
      sourceName: b.source_name,
      exportedAt: new Date(b.exported_at).toISOString(),
      coverage: b.coverage ?? {},
      days: b.days,
      orders: b.orders,
      importedAt: new Date(b.created_at).toISOString(),
    })),
  };
}
