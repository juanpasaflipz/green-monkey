/**
 * Histórico POS Lite (040, docs/SALES_HISTORY.md): Juanberto's past pos-lite kiosk and POS-terminal
 * sales as report history only. The owner uploads the operator's export file (raw JSON body, read
 * only after authentication and the managers check: routes/sales-history.ts); the server hashes the
 * exact bytes, validates and converts every order (shared/sales-history.ts), dates each sale with
 * Green Monkey's own business day (business_date_at, 029: the restaurant's timezone and cutoff in
 * force at the sale's instant) and keeps only aggregates.
 *
 * Isolation: these functions write only the five sales_history_* tables and one audit row. They
 * never touch orders, tenders, cash, fiscal tickets, CFDI, discounts, refunds, stock, loyalty or
 * jobs, and no existing report reads sales_history_* (tests/sales-history-db.ts proves both).
 *
 * Import (one transaction): 1 (the import key, class 0: tenant + 'pos-lite-sales') → 2
 * (restaurants FOR SHARE: the timezone and cutoff the business dates use) → inserts. The same file
 * (sha256 of its bytes) is a replay. A newer export takes over the business dates its coverage
 * spans (first to last sale) through sales_history_coverage; dates outside it stay with their
 * batch. An export older than one already covering any of its dates is refused.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import { managers, permit } from "./auth.js";
import { requireRecentAuth } from "./access.js";
import { audit } from "./orders.js";
import { DomainError, type Session } from "../shared/domain.js";
import { parseRange } from "../shared/reports.js";
import {
  aggregateSalesHistory,
  channelTotals,
  methodTotals,
  normalizeSalesHistory,
  SALES_HISTORY_MAX_BYTES,
  SALES_HISTORY_MAX_DAYS,
  SALES_HISTORY_SOURCE,
  salesHistoryExport,
  type Aggregates,
  type Normalized,
  type SalesHistoryExport,
  type SalesHistoryImportResult,
  type SalesHistoryPreview,
  type SalesHistoryReport,
} from "../shared/sales-history.js";

/** Rows per multi-row insert (well under PostgreSQL's 65535 bind parameters). */
const INSERT_CHUNK = 1000;

type Prepared = {
  file: SalesHistoryExport;
  hash: string;
  normalized: Normalized;
  aggregates: Aggregates;
};

/** The upload's bytes as the export document and its sha256; anything else is refused. */
export function parseSalesHistoryFile(body: unknown): { file: SalesHistoryExport; hash: string } {
  if (!Buffer.isBuffer(body) || body.length === 0)
    throw new DomainError("sales_history_file_invalid", 422);
  if (body.length > SALES_HISTORY_MAX_BYTES)
    throw new DomainError("sales_history_file_too_large", 413);
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    throw new DomainError("sales_history_file_invalid", 422);
  }
  const parsed = salesHistoryExport.safeParse(json);
  if (!parsed.success) throw new DomainError("sales_history_file_invalid", 422);
  return { file: parsed.data, hash: createHash("sha256").update(body).digest("hex") };
}

/** Validates the file for this restaurant and buckets every accepted sale by business date. */
async function prepare(tx: Tx, s: Session, body: unknown): Promise<Prepared> {
  const { file, hash } = parseSalesHistoryFile(body);
  // The operator's -v target names the Green Monkey restaurant: another one's file is refused.
  if (file.targetTenantId !== s.tenantId)
    throw new DomainError("sales_history_scope", 403);
  const [restaurant] = await tx`select currency from restaurants where id=${s.tenantId}`;
  if (!restaurant || restaurant.currency !== file.currency)
    throw new DomainError("sales_history_currency", 422);
  const normalized = normalizeSalesHistory(file);
  const ids = normalized.accepted.map((x) => x.legacyId);
  const ats = normalized.accepted.map((x) => x.at);
  const dated = ids.length
    ? await tx`select x.id, business_date_at(${s.tenantId}::uuid, x.at)::text as date
        from unnest(${tx.array(ids)}::text[], ${tx.array(ats)}::timestamptz[]) as x(id, at)`
    : [];
  const dateOf = new Map<string, string>(dated.map((r: any) => [r.id, r.date]));
  const aggregates = aggregateSalesHistory(normalized.accepted, (id) => {
    const d = dateOf.get(id);
    if (!d) throw new DomainError("sales_history_file_invalid", 422);
    return d;
  });
  return { file, hash, normalized, aggregates };
}

/** Days of [from, to] already owned by a batch, and whether any of them is a newer export's. */
async function overlap(tx: Tx, coverage: Aggregates["coverage"], exportedAt: string) {
  if (!coverage) return { days: 0, newer: false, batches: [] as string[] };
  const rows = await tx`select c.batch_id, count(*)::int as days,
      bool_or(b.exported_at > ${exportedAt}::timestamptz) as newer
    from sales_history_coverage c
    join sales_history_batches b on b.tenant_id=c.tenant_id and b.id=c.batch_id
    where c.business_date between ${coverage.from}::date and ${coverage.to}::date
    group by c.batch_id order by c.batch_id`;
  return {
    days: rows.reduce((a: number, r: any) => a + r.days, 0),
    newer: rows.some((r: any) => r.newer),
    batches: rows.map((r: any) => r.batch_id as string),
  };
}

/** POST /api/sales-history/preview (owners and managers): what Importar would do. Writes nothing. */
export async function previewSalesHistory(
  tx: Tx,
  s: Session,
  body: unknown,
): Promise<SalesHistoryPreview> {
  permit(s, managers);
  const p = await prepare(tx, s, body);
  const [existing] =
    await tx`select id from sales_history_batches where source=${SALES_HISTORY_SOURCE} and file_hash=${p.hash}`;
  const o = await overlap(tx, p.aggregates.coverage, p.file.exportedAt);
  return {
    fileHash: p.hash,
    sourceTenantId: p.file.sourceTenantId,
    sourceName: p.file.sourceName ?? null,
    exportedAt: new Date(p.file.exportedAt).toISOString(),
    coverage: p.aggregates.coverage,
    orders: p.normalized.accepted.length,
    rejected: p.normalized.rejected,
    byChannel: channelTotals(p.aggregates.days),
    byMethod: methodTotals(p.aggregates.payments),
    reconciliation: p.normalized.reconciliation,
    alreadyImported: !!existing,
    replacesDays: existing ? 0 : o.days,
    olderThanImported: !existing && o.newer,
  };
}

/**
 * POST /api/sales-history/import (owners and managers, recent PIN): commits the file the preview
 * showed (x-gm-file-hash must equal the uploaded bytes' hash). The same file again is a replay.
 */
export async function importSalesHistory(
  tx: Tx,
  s: Session,
  body: unknown,
  expectedHash: unknown,
): Promise<SalesHistoryImportResult> {
  permit(s, managers);
  requireRecentAuth(s);
  // LO-1 (class 0) before the restaurants row (LO-2): one import at a time per restaurant.
  await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + SALES_HISTORY_SOURCE},0))`;
  const [restaurant] =
    await tx`select timezone,cutoff from restaurants where id=${s.tenantId} for share`;
  if (
    !restaurant ||
    restaurant.timezone !== s.restaurant.timezone ||
    restaurant.cutoff !== s.restaurant.cutoff
  )
    throw new DomainError("settings_changed", 409);
  const p = await prepare(tx, s, body);
  if (typeof expectedHash !== "string" || expectedHash !== p.hash)
    throw new DomainError("sales_history_file_changed", 409);
  const [existing] = await tx`select id, orders from sales_history_batches
    where source=${SALES_HISTORY_SOURCE} and file_hash=${p.hash}`;
  if (existing)
    return { batchId: existing.id, replayed: true, orders: existing.orders, days: 0, replacedDays: 0 };
  const coverage = p.aggregates.coverage;
  if (!coverage) throw new DomainError("sales_history_empty", 422);
  const o = await overlap(tx, coverage, p.file.exportedAt);
  if (o.newer) throw new DomainError("sales_history_older_export", 409);
  const batchId = randomUUID();
  const r = p.normalized;
  await tx`insert into sales_history_batches(tenant_id,id,source,source_tenant_id,source_name,file_hash,
      exported_at,coverage_from,coverage_to,orders,rejected,report,imported_by)
    values(${s.tenantId},${batchId},${SALES_HISTORY_SOURCE},${p.file.sourceTenantId},
      ${p.file.sourceName ?? null},${p.hash},${p.file.exportedAt},${coverage.from},${coverage.to},
      ${r.accepted.length},${r.rejected.length},
      ${tx.json({
        reconciliation: r.reconciliation,
        rejectedByReason: r.rejected.reduce<Record<string, number>>(
          (a, x) => ({ ...a, [x.reason]: (a[x.reason] ?? 0) + 1 }),
          {},
        ),
      } as any)},${s.employeeId})`;
  // Bulk inserts as jsonb record sets, INSERT_CHUNK rows a statement.
  const chunks = <T>(rows: readonly T[]) =>
    Array.from({ length: Math.ceil(rows.length / INSERT_CHUNK) }, (_, i) =>
      rows.slice(i * INSERT_CHUNK, (i + 1) * INSERT_CHUNK),
    );
  for (const rows of chunks(p.aggregates.days))
    await tx`insert into sales_history_days(tenant_id,batch_id,business_date,channel,orders,gross,
        discount,subtotal,tax,total,tip,refunds)
      select ${s.tenantId},${batchId},x.date,x.channel,x.orders,x.gross,x.discount,x.subtotal,x.tax,
        x.total,x.tip,x.refunds
      from jsonb_to_recordset(${tx.json(rows as any)}) as x(date date, channel text, orders int,
        gross bigint, discount bigint, subtotal bigint, tax bigint, total bigint, tip bigint,
        refunds bigint)`;
  for (const rows of chunks(p.aggregates.payments))
    await tx`insert into sales_history_payments(tenant_id,batch_id,business_date,channel,method,
        payments,amount,tip)
      select ${s.tenantId},${batchId},x.date,x.channel,x.method,x.payments,x.amount,x.tip
      from jsonb_to_recordset(${tx.json(rows as any)}) as x(date date, channel text, method text,
        payments int, amount bigint, tip bigint)`;
  for (const rows of chunks(p.aggregates.products))
    await tx`insert into sales_history_products(tenant_id,batch_id,business_date,channel,product_name,
        quantity,amount)
      select ${s.tenantId},${batchId},x.date,x.channel,x.name,x.quantity,x.amount
      from jsonb_to_recordset(${tx.json(rows as any)}) as x(date date, channel text, name text,
        quantity int, amount bigint)`;
  // Every business date of the coverage now belongs to this batch, sales or not (a day the newer
  // export shows without sales has none); dates outside it keep their batch.
  const days = await tx`insert into sales_history_coverage(tenant_id,business_date,batch_id)
    select ${s.tenantId}, d::date, ${batchId}
      from generate_series(${coverage.from}::date, ${coverage.to}::date, interval '1 day') d
    on conflict (tenant_id,business_date) do update set batch_id=excluded.batch_id, updated_at=now()
    returning business_date`;
  await audit(tx, s, "sales_history.import", batchId, {
    batchId,
    source: SALES_HISTORY_SOURCE,
    sourceTenantId: p.file.sourceTenantId,
    exportedAt: p.file.exportedAt,
    from: coverage.from,
    to: coverage.to,
    orders: r.accepted.length,
    rejected: r.rejected.length,
    total: r.reconciliation.converted.total,
    replacedDays: o.days,
    replacedBatches: o.batches,
  });
  return { batchId, replayed: false, orders: r.accepted.length, days: days.length, replacedDays: o.days };
}

const n = (v: unknown) => Number(v);

/**
 * GET /api/sales-history?from&to (owners and managers): the history in force for a business-date
 * range (at most SALES_HISTORY_MAX_DAYS): rows per day and channel, per day, channel and method,
 * the range's products by amount, and every import batch.
 */
export async function salesHistoryReport(
  tx: Tx,
  s: Session,
  raw: { from?: unknown; to?: unknown },
): Promise<SalesHistoryReport> {
  permit(s, managers);
  const range = parseRange(raw, SALES_HISTORY_MAX_DAYS);
  const days = await tx`select d.business_date::text as date, d.channel, d.orders, d.gross, d.discount,
      d.subtotal, d.tax, d.total, d.tip, d.refunds
    from sales_history_days d
    join sales_history_coverage c on c.tenant_id=d.tenant_id and c.business_date=d.business_date
      and c.batch_id=d.batch_id
    where d.business_date between ${range.from}::date and ${range.to}::date
    order by d.business_date, d.channel`;
  const payments = await tx`select p.business_date::text as date, p.channel, p.method, p.payments,
      p.amount, p.tip
    from sales_history_payments p
    join sales_history_coverage c on c.tenant_id=p.tenant_id and c.business_date=p.business_date
      and c.batch_id=p.batch_id
    where p.business_date between ${range.from}::date and ${range.to}::date
    order by p.business_date, p.channel, p.method`;
  const products = await tx`select p.product_name as name, sum(p.quantity)::bigint as quantity,
      sum(p.amount)::bigint as amount
    from sales_history_products p
    join sales_history_coverage c on c.tenant_id=p.tenant_id and c.business_date=p.business_date
      and c.batch_id=p.batch_id
    where p.business_date between ${range.from}::date and ${range.to}::date
    group by p.product_name order by sum(p.amount) desc, p.product_name limit 100`;
  const batches = await tx`select id, source_name, exported_at, coverage_from::text, coverage_to::text,
      orders, created_at from sales_history_batches order by created_at desc, id limit 50`;
  return {
    range,
    days: days.map((d: any) => ({
      date: d.date,
      channel: d.channel,
      orders: d.orders,
      gross: n(d.gross),
      discount: n(d.discount),
      subtotal: n(d.subtotal),
      tax: n(d.tax),
      total: n(d.total),
      tip: n(d.tip),
      refunds: n(d.refunds),
    })),
    payments: payments.map((p: any) => ({
      date: p.date,
      channel: p.channel,
      method: p.method,
      payments: p.payments,
      amount: n(p.amount),
      tip: n(p.tip),
    })),
    products: products.map((p: any) => ({ name: p.name, quantity: n(p.quantity), amount: n(p.amount) })),
    batches: batches.map((b: any) => ({
      id: b.id,
      sourceName: b.source_name,
      exportedAt: new Date(b.exported_at).toISOString(),
      coverageFrom: b.coverage_from,
      coverageTo: b.coverage_to,
      orders: b.orders,
      importedAt: new Date(b.created_at).toISOString(),
    })),
  };
}
