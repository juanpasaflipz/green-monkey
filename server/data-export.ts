import { once } from "node:events";
import type express from "express";
import type postgres from "postgres";
import { tenant, type Tx } from "./db.js";
import { permit } from "./auth.js";
import { requireRecentAuth } from "./access.js";
import { audit } from "./orders.js";
import { log } from "./logging.js";
import { DomainError, type Session } from "../shared/domain.js";
import {
  CSV_BOM,
  EXPORT_COLUMN_DENY,
  EXPORT_RESTAURANT_COLUMNS,
  EXPORT_TABLE_DENYLIST,
  csvRow,
  exportFilename,
} from "../shared/account-export.js";

/**
 * Owner data export (account 031, GAP-5): JSON with every tenant table, or one
 * table as CSV, streamed from a repeatable-read snapshot. Discovery is dynamic,
 * so tables other areas add are exported automatically (contract: secret
 * columns are named *_hash, *_secret, *_token or *csrf*, or denylisted).
 */
export type ExportTable = {
  name: string;
  columns: string[];
  orderBy: string[];
};

/** Tenant tables and their exportable columns, in name order (the role's visible columns only). */
export async function exportTables(tx: Tx): Promise<ExportTable[]> {
  const rows = await tx`select c.table_name::text as name,
      array_agg(c.column_name::text order by c.ordinal_position) as columns,
      (select array_agg(a.attname::text order by array_position(i.indkey::int2[], a.attnum))
         from pg_index i
         join pg_class cl on cl.oid=i.indrelid
         join pg_namespace n on n.oid=cl.relnamespace and n.nspname='public'
         join pg_attribute a on a.attrelid=cl.oid and a.attnum=any(i.indkey)
        where i.indisprimary and cl.relname=c.table_name) as primary_key
    from information_schema.columns c
    join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name
      and t.table_type='BASE TABLE'
    where c.table_schema='public'
      and exists(select 1 from information_schema.columns k
        where k.table_schema='public' and k.table_name=c.table_name and k.column_name='tenant_id')
    group by c.table_name
    order by c.table_name`;
  return rows
    .filter((r) => !EXPORT_TABLE_DENYLIST.has(r.name))
    .map((r) => {
      const columns = (r.columns as string[]).filter(
        (col) => !EXPORT_COLUMN_DENY.test(col),
      );
      const pk = ((r.primary_key as string[] | null) ?? []).filter((c) =>
        columns.includes(c),
      );
      return {
        name: r.name as string,
        columns,
        orderBy: pk.length ? pk : columns.slice(0, 1),
      };
    })
    .filter((t) => t.columns.length > 0);
}

/** The export's first statement (heavy-read convention): 60 s limits and the tenant scope. */
export async function exportScope(tx: Tx, tenantId: string) {
  await tx`select set_config('statement_timeout','60s',true),
                  set_config('idle_in_transaction_session_timeout','60s',true),
                  set_config('app.tenant_id',${tenantId},true)`;
}

/** At most one export per tenant and two per process (export_busy). */
const running = new Set<string>();
export const MAX_CONCURRENT_EXPORTS = 2;
/** Whether an export for this tenant would be refused as export_busy now. */
export function exportBusy(tenantId: string) {
  return running.has(tenantId) || running.size >= MAX_CONCURRENT_EXPORTS;
}
function claim(tenantId: string) {
  if (exportBusy(tenantId)) throw new DomainError("export_busy", 429);
  running.add(tenantId);
  return () => running.delete(tenantId);
}

/** Abandons the export when the client stops reading for 50 s (the transaction allows 60). */
export const DRAIN_TIMEOUT_MS = 50_000;
/**
 * The drain timeout in use. EXPORT_DRAIN_TIMEOUT_MS (1000..50000 ms) may
 * shorten it on a local or CI server only: any Railway environment, or
 * APP_ENV staging or production, keeps 50 s. tests/account-http.ts uses it
 * to wait a drain wait out in seconds (FLK-R10).
 */
export function drainTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.EXPORT_DRAIN_TIMEOUT_MS ?? "", 10);
  const deployed =
    Boolean(env.RAILWAY_ENVIRONMENT_NAME?.trim()) ||
    ["staging", "production"].includes(env.APP_ENV?.trim().toLowerCase() ?? "");
  return deployed || !Number.isFinite(raw)
    ? DRAIN_TIMEOUT_MS
    : Math.min(DRAIN_TIMEOUT_MS, Math.max(1000, raw));
}
async function write(
  res: express.Response,
  chunk: string,
  signal: AbortSignal,
) {
  if (res.write(chunk)) return;
  try {
    await once(res, "drain", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(drainTimeoutMs())]),
    });
  } catch {
    throw new DomainError("export_aborted", 499);
  }
}

/** Binary values as base64 and bigint as a string; everything else as JSON. */
function rowJson(row: Record<string, unknown>) {
  return JSON.stringify(row, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (
      value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === "Buffer" &&
      Array.isArray((value as { data?: unknown }).data)
    )
      return Buffer.from((value as { data: number[] }).data).toString("base64");
    return value;
  });
}

function localDate(timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

type Format = { format: "json" } | { format: "csv"; table: string };

/**
 * Reads one table in batches of 500 rows and hands each batch to `emit`.
 * The async-iterator cursor awaits every batch, the table's final one
 * included: postgres.js calls a `.cursor(n, fn)` callback for the final
 * batch without awaiting or catching it, so a write refused after the client
 * left became an unhandled rejection that ended the process, and that batch
 * ignored backpressure. Here a throw reaches the caller and leaving the loop
 * closes the portal.
 */
async function streamTable(
  sql: postgres.Sql,
  tx: Tx,
  table: ExportTable,
  signal: AbortSignal,
  emit: (rows: Record<string, unknown>[]) => Promise<void>,
) {
  for await (const rows of tx`select ${sql(table.columns)} from ${sql(table.name)} order by ${sql(table.orderBy)}`.cursor(
    500,
  )) {
    await emit(rows);
    if (signal.aborted) break;
  }
  if (signal.aborted) throw new DomainError("export_aborted", 499);
}

/**
 * Streams the export. Errors before the first byte go to the caller (standard
 * JSON error); after it the response is ended early and the client's file is
 * truncated (a partial JSON never parses), logged as export_aborted.
 */
async function streamExport(
  sql: postgres.Sql,
  s: Session,
  f: Format,
  res: express.Response,
  signal: AbortSignal,
) {
  const release = claim(s.tenantId);
  try {
    await tenant(sql, s.tenantId, (tx) =>
      audit(tx, s, "account.data_export", s.tenantId, {
        format: f.format,
        table: f.format === "csv" ? f.table : null,
      }),
    );
    await sql.begin(
      "isolation level repeatable read read only",
      async (raw) => {
        const tx = raw as Tx;
        await exportScope(tx, s.tenantId);
        const tables = await exportTables(tx);
        const [restaurant] =
          await tx`select ${sql([...EXPORT_RESTAURANT_COLUMNS])}
        from restaurants where id=${s.tenantId}`;
        const date = localDate(restaurant.timezone);
        if (f.format === "csv") {
          const table = tables.find((t) => t.name === f.table);
          if (!table) throw new DomainError("export_table_unknown", 404);
          res.attachment(exportFilename(restaurant.name, date, table.name));
          res.set("Content-Type", "text/csv; charset=utf-8");
          res.set("Cache-Control", "no-store");
          await write(res, CSV_BOM + csvRow(table.columns), signal);
          await streamTable(sql, tx, table, signal, (rows) =>
            write(
              res,
              rows.map((r) => csvRow(table.columns.map((c) => r[c]))).join(""),
              signal,
            ),
          );
          return;
        }
        res.attachment(exportFilename(restaurant.name, date));
        res.set("Content-Type", "application/json; charset=utf-8");
        res.set("Cache-Control", "no-store");
        await write(
          res,
          `{"format":"green-monkey-export","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},` +
            `"restaurant":${rowJson(restaurant)},"units":{"money":"minor (centavos)"},"tables":{`,
          signal,
        );
        for (const [index, table] of tables.entries()) {
          await write(
            res,
            (index ? "]," : "") + JSON.stringify(table.name) + ":[",
            signal,
          );
          let first = true;
          await streamTable(sql, tx, table, signal, async (rows) => {
            const chunk = rows.map(rowJson).join(",");
            await write(res, (first ? "" : ",") + chunk, signal);
            first = false;
          });
        }
        await write(res, (tables.length ? "]" : "") + "}}", signal);
      },
    );
  } finally {
    release();
  }
}

/**
 * Every /api/account-data route: owners (primary or co-owner) only, and on a
 * shared terminal a PIN entered recently (access step-up). Personal owner
 * browsers entered with Google always pass requireRecentAuth.
 */
export function requireExportAccess(s: Session) {
  permit(s, ["owner"]);
  requireRecentAuth(s);
}

/** requireExportAccess + the ?tenant guard, before the rate limiter (R-20). */
export function exportGuard(): express.RequestHandler {
  return (req, _res, next) => {
    try {
      const s = (req as express.Request & { session: Session }).session;
      requireExportAccess(s);
      if (req.query.tenant !== undefined && req.query.tenant !== s.tenantId)
        throw new DomainError("session_changed", 409);
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** The streaming route handler for one format. */
export function exportHandler(
  sql: postgres.Sql,
  format: "json" | "csv",
): express.RequestHandler {
  return async (req, res, next) => {
    const s = (req as express.Request & { session: Session }).session;
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on("close", abort);
    try {
      if (req.query.tenant !== s.tenantId)
        throw new DomainError("session_changed", 409);
      await streamExport(
        sql,
        s,
        format === "json"
          ? { format }
          : { format, table: String(req.params.table ?? "") },
        res,
        controller.signal,
      );
      res.end();
    } catch (e) {
      if (!res.headersSent) return next(e);
      log.warn("export_aborted", {
        code: e instanceof DomainError ? e.code : "export_failed",
        format,
      });
      res.destroy();
    } finally {
      res.off("close", abort);
    }
  };
}
