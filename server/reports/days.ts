// Reports (029): business-day bucketing in SQL with the versioned settings of migration 029.
import type { Tx } from "../db.js";
import {
  wideWindow,
  type BusinessDaySettings,
  type DateRange,
} from "../../shared/reports.js";

/**
 * The CTE body `cfg(valid_from, valid_until, timezone, cutoff)`: the settings history of the
 * tenant plus the current restaurants row, as half-open validity intervals. Use it as
 * `with cfg as (${businessDayCte(tx, tenantId)})` and bucket an instant X with
 *
 *   join cfg c on X >= c.valid_from and X < c.valid_until
 *   ((X at time zone c.timezone) - make_interval(mins => c.cutoff))::date      -- its day
 *   extract(hour from (X at time zone c.timezone))::int                        -- its hour
 *
 * which equals business_date_at(tenant, X) (029) for every instant (DB test 33), and is the
 * formula shared/reports.ts wallClockBusinessDate() mirrors.
 */
export function businessDayCte(tx: Tx, tenantId: string) {
  return tx`
    select coalesce(lag(s.valid_until) over (order by s.valid_until), '-infinity'::timestamptz) as valid_from,
           s.valid_until, s.timezone, s.cutoff
      from (select h.valid_until, h.timezone, h.cutoff
              from business_day_settings h where h.tenant_id = ${tenantId}
            union all
            select 'infinity'::timestamptz, r.timezone, r.cutoff
              from restaurants r where r.id = ${tenantId}) s`;
}

/** The index-friendly instant window of a business-date range (see shared wideWindow). */
export function windowOf(
  range: DateRange,
  settings: BusinessDaySettings,
): { ws: string; we: string } {
  const w = wideWindow(range, settings);
  return { ws: w.start, we: w.end };
}

/** A Date or timestamptz text from postgres.js as an ISO instant; null stays null. */
export function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

/** Like iso(), for NOT NULL columns. */
export function isoRequired(value: unknown): string {
  const v = iso(value);
  if (v === null) throw new RangeError("missing_instant");
  return v;
}
