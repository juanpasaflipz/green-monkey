import { api } from "../../api";
import {
  LIMITS,
  type AuditRow,
  type Breakdown,
  type BreakdownResponse,
  type CorteDocument,
  type DateRange,
  type DayCorteDocument,
  type DrawerRow,
  type ExceptionPage,
  type OrderReportRow,
  type Page,
  type SalesSummary,
  type TenderReportRow,
  type TodaySummary,
} from "../../../shared/reports";

/**
 * Report reads and prints wait up to 40 s (LD-15 reports Q1): the server's own limit is 30 s and
 * answers reports_timeout (422), a domain answer that is never retried. Report outcomes count as
 * reachability only in src/connectivity.ts, so a slow report never makes a device look offline.
 */
export const REPORT_TIMEOUT_MS = 40_000;

type Query = Record<string, string | number | undefined | null>;
function query(q: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(q))
    if (value !== undefined && value !== null && value !== "")
      params.set(key, String(value));
  const text = params.toString();
  return text ? "?" + text : "";
}
const get = <T>(path: string, q: Query = {}) =>
  api<T>(path + query(q), undefined, { timeoutMs: REPORT_TIMEOUT_MS });
/** Print and remote-close commands carry an operationId, so a lost response is retried safely. */
const post = <T>(path: string, body: unknown) =>
  api<T>(path, body, { timeoutMs: REPORT_TIMEOUT_MS, idempotent: true });

export type ReportFilters = {
  employees: { id: string; name: string; role: string; active: boolean }[];
  devices: { id: string; name: string; active: boolean; revoked: boolean }[];
};

export const fetchSummary = (range: DateRange) =>
  get<SalesSummary>("/reports/summary", range);
/** The BreakdownResponse member whose `by` includes B ("channel" and "mode" share one). */
export type BreakdownOf<B extends Breakdown> = BreakdownResponse extends infer R
  ? R extends { by: infer K }
    ? B extends K
      ? R
      : never
    : never
  : never;
export const fetchBreakdown = <B extends Breakdown>(range: DateRange, by: B) =>
  get<BreakdownOf<B>>("/reports/breakdown", { ...range, by });
export const fetchOrders = (q: Query) =>
  get<Page<OrderReportRow>>("/reports/orders", q);
export const fetchTenders = (q: Query) =>
  get<Page<TenderReportRow>>("/reports/tenders", q);
export const fetchExceptions = (q: Query) =>
  get<ExceptionPage>("/reports/exceptions", q);
export const fetchAudit = (q: Query) =>
  get<Page<AuditRow>>("/reports/audit", q);
export const fetchDrawers = (range: DateRange) =>
  get<DrawerRow[]>("/reports/drawers", range);
export const fetchDrawerCorte = (drawerId: string) =>
  get<CorteDocument>(`/reports/drawers/${drawerId}/corte`);
export const printDrawerCorte = (
  drawerId: string,
  body: { operationId: string; kind: "x" | "z" },
) => post<CorteDocument>(`/reports/drawers/${drawerId}/corte`, body);
export const fetchDayCorte = (date: string) =>
  get<DayCorteDocument>(`/reports/days/${date}/corte`);
export const printDayCorte = (date: string, body: { operationId: string }) =>
  post<DayCorteDocument>(`/reports/days/${date}/corte`, body);
export const remoteClose = (
  drawerId: string,
  body: {
    operationId: string;
    counted: number;
    reason: string;
    externalReported: number | null;
  },
) => post<CorteDocument>(`/reports/drawers/${drawerId}/close`, body);
export const fetchToday = () => get<TodaySummary>("/reports/today");
export const fetchFilters = () => get<ReportFilters>("/reports/filters");

/**
 * Every row of a paged dataset, 500 per page, stopping at `max` rows (the CSV export cap).
 * `truncated` is true when rows were left out.
 */
export async function fetchAllPages<T>(
  fetchPage: (cursor: string | undefined, limit: number) => Promise<Page<T>>,
  max: number = LIMITS.exportRows,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor, LIMITS.pageMax);
    rows.push(...page.rows);
    if (rows.length >= max)
      return {
        rows: rows.slice(0, max),
        truncated: rows.length > max || page.next !== null,
      };
    if (!page.next) return { rows, truncated: false };
    cursor = page.next;
  }
}
