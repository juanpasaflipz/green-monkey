import { describe, expect, it } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { boundaries, businessDate, DomainError } from "../shared/domain";
import {
  addDays,
  aggregateInt,
  AUDIT_GROUP_KEYS,
  AUDIT_GROUPS,
  auditGroupPrefixes,
  auditGroupsOf,
  auditQuery,
  averageTicket,
  bps,
  buildCorteDocument,
  buildDayCorteDocument,
  CHECK_CODES,
  composeSalesSummary,
  corteAccess,
  cortePrintInput,
  cortePrintKind,
  currentBusinessDate,
  DATE_BOUNDS,
  decodeReportCursor,
  DIFFERENCE_KINDS,
  differenceKind,
  drawerRow,
  drawerSummary,
  drawersUpTo,
  encodeReportCursor,
  escapeLike,
  EXCEPTION_KINDS,
  exceptionQuery,
  exceptionSummary,
  exceptionTotals,
  failedCheckCodes,
  FISCAL_CHUNK_DAYS,
  fiscalTotals,
  folioRanges,
  hourRows,
  isBusinessDate,
  LIMITS,
  liveExpectedCash,
  mergeFiscalSummaries,
  orderListQuery,
  otherDayDrawerCollections,
  parseExceptionKinds,
  parseRange,
  QUICK_RANGES,
  quickRange,
  rangeChunks,
  rangeDates,
  rangeLength,
  reconciliationChecks,
  remoteCloseInput,
  summaryQuery,
  wallClockBusinessDate,
  wallClockHour,
  wideWindow,
  type CorteControls,
  type DateRange,
  type DrawerFacts,
  type ExceptionKind,
  type ExceptionRow,
  type QuickRange,
  type CheckCode,
  type ReconciliationInput,
  type SalesDayAggregate,
  type SalesSummary,
  type SummaryInput,
} from "../shared/reports";
import {
  CSV_BOM,
  csvCell,
  csvFileName,
  dateTimeCsv,
  moneyCsv,
  percentCsv,
  toCsv,
  type CsvColumn,
} from "../shared/csv";
import type { CategoryTotals, FiscalSummary } from "../shared/fiscal";
import { labelledOperations } from "../src/labels";
import { fakeId, rng } from "./fixtures/fiscal";
import {
  aggregateWorld,
  lineDiscount,
  lineGross,
  orderPaid,
  orderTotal,
  randomWorld,
  worldFiscalTotals,
  type World,
} from "./fixtures/reports";

function domainError(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
  throw new Error("expected a DomainError");
}
const code = (fn: () => unknown) => {
  const e = domainError(fn);
  return `${e.code}:${e.status}`;
};

// ---------------------------------------------------------------------------------------------
// Ranges and business dates
// ---------------------------------------------------------------------------------------------

describe("parseRange (FIT-7, D9)", () => {
  it("1. parseRange accepts a single day and rejects to < from, 2026-02-30, more than 92 days (aggregate) and more than 31 days (list)", () => {
    expect(
      parseRange({ from: "2026-10-05", to: "2026-10-05" }, LIMITS.listDays),
    ).toEqual({ from: "2026-10-05", to: "2026-10-05" });
    expect(
      code(() => parseRange({ from: "2026-10-06", to: "2026-10-05" }, 92)),
    ).toBe("reports_range_invalid:400");
    expect(
      code(() => parseRange({ from: "2026-02-30", to: "2026-03-01" }, 92)),
    ).toBe("reports_range_invalid:400");
    // 92 days fit the aggregate limit, 93 do not.
    expect(
      parseRange(
        { from: "2026-07-01", to: "2026-09-30" },
        LIMITS.aggregateDays,
      ),
    ).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(
      code(() =>
        parseRange(
          { from: "2026-07-01", to: "2026-10-01" },
          LIMITS.aggregateDays,
        ),
      ),
    ).toBe("reports_range_invalid:400");
    // 31 days fit the list limit, 32 do not.
    expect(
      parseRange({ from: "2026-10-01", to: "2026-10-31" }, LIMITS.listDays),
    ).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(
      code(() =>
        parseRange({ from: "2026-10-01", to: "2026-11-01" }, LIMITS.listDays),
      ),
    ).toBe("reports_range_invalid:400");
  });

  it("accepts leap days only in leap years and every month length", () => {
    expect(parseRange({ from: "2028-02-29", to: "2028-02-29" }, 1).from).toBe(
      "2028-02-29",
    );
    for (const bad of ["2027-02-29", "2026-04-31", "2026-13-01", "2026-00-10"])
      expect(code(() => parseRange({ from: bad, to: bad }, 1))).toBe(
        "reports_range_invalid:400",
      );
  });

  it("rejects malformed, missing, non-string and out-of-bounds dates with reports_range_invalid", () => {
    for (const raw of [
      {},
      { from: "2026-10-05" },
      { from: "2026-10-5", to: "2026-10-05" },
      { from: " 2026-10-05", to: "2026-10-05" },
      { from: "2026-10-05T00:00", to: "2026-10-05" },
      { from: 20261005, to: "2026-10-05" },
      { from: ["2026-10-05"], to: "2026-10-05" },
      { from: null, to: "2026-10-05" },
      // Temporal accepts year 0 but PostgreSQL has none: never a SQL error.
      { from: "0000-01-01", to: "0000-01-02" },
      { from: "1999-12-31", to: "2000-01-01" },
      { from: "2999-12-31", to: "3000-01-01" },
    ])
      expect(code(() => parseRange(raw, 92))).toBe("reports_range_invalid:400");
    expect(
      parseRange({ from: DATE_BOUNDS.min, to: DATE_BOUNDS.min }, 1).from,
    ).toBe("2000-01-01");
    expect(
      parseRange({ from: DATE_BOUNDS.max, to: DATE_BOUNDS.max }, 1).to,
    ).toBe("2999-12-31");
  });

  it("refuses a nonsensical limit as a programming error", () => {
    expect(() =>
      parseRange({ from: "2026-10-05", to: "2026-10-05" }, 0),
    ).toThrow(RangeError);
    expect(() =>
      parseRange({ from: "2026-10-05", to: "2026-10-05" }, 1.5),
    ).toThrow(RangeError);
  });

  it("enumerates and counts the dates of a range across month, year and leap-day ends", () => {
    expect(rangeDates({ from: "2026-12-30", to: "2027-01-02" })).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
    expect(rangeDates({ from: "2028-02-28", to: "2028-03-01" })).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
    expect(rangeLength({ from: "2026-07-01", to: "2026-09-30" })).toBe(92);
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(isBusinessDate("2026-10-05")).toBe(true);
    expect(isBusinessDate("2026-02-30")).toBe(false);
    expect(isBusinessDate(undefined)).toBe(false);
  });
});

describe("quickRange (FIT-7)", () => {
  const all = (today: string) =>
    Object.fromEntries(QUICK_RANGES.map((k) => [k, quickRange(k, today)]));

  it("2. quickRange: Hoy, Ayer, Esta semana (Monday start), Semana pasada, Este mes and Mes pasado for 2026-10-05, across 2027-01-01 and on 2028-02-29", () => {
    // 2026-10-05 is a Monday.
    expect(all("2026-10-05")).toEqual({
      today: { from: "2026-10-05", to: "2026-10-05" },
      yesterday: { from: "2026-10-04", to: "2026-10-04" },
      this_week: { from: "2026-10-05", to: "2026-10-05" },
      last_week: { from: "2026-09-28", to: "2026-10-04" },
      this_month: { from: "2026-10-01", to: "2026-10-05" },
      last_month: { from: "2026-09-01", to: "2026-09-30" },
    });
    // 2027-01-01 is a Friday: the week and the previous month cross the year end.
    expect(all("2027-01-01")).toEqual({
      today: { from: "2027-01-01", to: "2027-01-01" },
      yesterday: { from: "2026-12-31", to: "2026-12-31" },
      this_week: { from: "2026-12-28", to: "2027-01-01" },
      last_week: { from: "2026-12-21", to: "2026-12-27" },
      this_month: { from: "2027-01-01", to: "2027-01-01" },
      last_month: { from: "2026-12-01", to: "2026-12-31" },
    });
    // 2028-02-29 is a Tuesday in a leap year.
    expect(all("2028-02-29")).toEqual({
      today: { from: "2028-02-29", to: "2028-02-29" },
      yesterday: { from: "2028-02-28", to: "2028-02-28" },
      this_week: { from: "2028-02-28", to: "2028-02-29" },
      last_week: { from: "2028-02-21", to: "2028-02-27" },
      this_month: { from: "2028-02-01", to: "2028-02-29" },
      last_month: { from: "2028-01-01", to: "2028-01-31" },
    });
    expect(quickRange("last_month", "2028-03-31")).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
    expect(quickRange("yesterday", "2028-03-01")).toEqual({
      from: "2028-02-29",
      to: "2028-02-29",
    });
    expect(quickRange("this_week", "2026-10-11")).toEqual({
      from: "2026-10-05",
      to: "2026-10-11",
    });
  });

  it("property: every quick range fits the 31-day list limit, never ends after today and weeks start on Monday", () => {
    const random = rng(29);
    for (let n = 0; n < 1500; n++) {
      const today = addDays("2025-01-01", random.int(0, 4 * 366));
      for (const kind of QUICK_RANGES) {
        const r = quickRange(kind, today);
        expect(parseRange(r, LIMITS.listDays)).toEqual(r);
        expect(r.to <= today).toBe(true);
        if (kind === "this_week" || kind === "last_week")
          expect(Temporal.PlainDate.from(r.from).dayOfWeek).toBe(1);
        if (kind === "last_week") expect(rangeLength(r)).toBe(7);
        if (kind === "last_month")
          expect(Temporal.PlainDate.from(r.to).add({ days: 1 }).day).toBe(1);
      }
    }
  });

  it("refuses an invalid today or an unknown kind", () => {
    expect(code(() => quickRange("today", "2026-02-30"))).toBe(
      "reports_range_invalid:400",
    );
    expect(
      code(() => quickRange("fortnight" as QuickRange, "2026-10-05")),
    ).toBe("reports_range_invalid:400");
  });
});

describe("business-day formula (FIN-04, DB-7, OFF-9)", () => {
  const zones = ["America/Mexico_City", "America/Tijuana"] as const;
  const cutoffs = [0, 240, 1439] as const;
  const at = (iso: string, minutes: number) =>
    Temporal.Instant.from(iso).add({ minutes }).toString();

  it("3. FIN-04: the SQL day formula (local wall clock minus cutoff) equals businessDate() for 10,000 random instants in America/Mexico_City and America/Tijuana with cutoffs 0, 240 and 1439, including the 2026-03-08 and 2026-11-01 DST transitions", () => {
    const random = rng(2026);
    const start = Temporal.Instant.from("2025-12-01T00:00:00Z");
    const instants: string[] = [];
    for (let n = 0; n < 10_000; n++) {
      // A third of the instants fall within a day of a Tijuana DST transition.
      const near = random.next() < 1 / 3;
      const base = near
        ? Temporal.Instant.from(
            random.pick(["2026-03-08T10:00:00Z", "2026-11-01T09:00:00Z"]),
          ).subtract({ hours: 24 })
        : start;
      const spanSeconds = near ? 48 * 3600 : 400 * 86400;
      instants.push(
        base
          .add({
            seconds: random.int(0, spanSeconds),
            milliseconds: random.int(0, 999),
          })
          .toString(),
      );
    }
    for (const instant of instants) {
      const zone = random.pick(zones);
      const cutoff = random.pick(cutoffs);
      expect(wallClockBusinessDate(instant, zone, cutoff), instant).toBe(
        businessDate(instant, zone, cutoff),
      );
    }
    // Every minute across both transitions, for every zone and cutoff.
    for (const transition of ["2026-03-08T10:00:00Z", "2026-11-01T09:00:00Z"])
      for (let m = -180; m <= 180; m++)
        for (const zone of zones)
          for (const cutoff of cutoffs) {
            const instant = at(transition, m);
            expect(wallClockBusinessDate(instant, zone, cutoff)).toBe(
              businessDate(instant, zone, cutoff),
            );
          }
  });

  it("an event at exactly the cutoff instant belongs to the new day; one millisecond earlier to the previous day", () => {
    for (const zone of zones)
      for (const cutoff of cutoffs)
        for (const date of [
          "2026-03-08",
          "2026-11-01",
          "2026-12-31",
          "2028-02-29",
        ]) {
          const { start, end } = boundaries(date, zone, cutoff);
          expect(wallClockBusinessDate(start, zone, cutoff)).toBe(date);
          const before = Temporal.Instant.from(start)
            .subtract({ milliseconds: 1 })
            .toString();
          expect(wallClockBusinessDate(before, zone, cutoff)).toBe(
            addDays(date, -1),
          );
          const last = Temporal.Instant.from(end)
            .subtract({ milliseconds: 1 })
            .toString();
          expect(wallClockBusinessDate(last, zone, cutoff)).toBe(date);
        }
  });

  it("the repeated 01:00 hour of 2026-11-01 in Tijuana is one wall-clock hour on one business date", () => {
    const first = "2026-11-01T08:30:00Z"; // 01:30 PDT
    const second = "2026-11-01T09:30:00Z"; // 01:30 PST
    expect(wallClockHour(first, "America/Tijuana")).toBe(1);
    expect(wallClockHour(second, "America/Tijuana")).toBe(1);
    expect(wallClockBusinessDate(first, "America/Tijuana", 240)).toBe(
      "2026-10-31",
    );
    expect(wallClockBusinessDate(second, "America/Tijuana", 240)).toBe(
      "2026-10-31",
    );
    expect(wallClockBusinessDate(second, "America/Tijuana", 0)).toBe(
      "2026-11-01",
    );
  });

  it("rejects a cutoff outside 0–1439", () => {
    expect(() =>
      wallClockBusinessDate("2026-10-05T12:00:00Z", zones[0], 1440),
    ).toThrow(RangeError);
    expect(() =>
      wallClockBusinessDate("2026-10-05T12:00:00Z", zones[0], -1),
    ).toThrow(RangeError);
  });

  it("currentBusinessDate follows the current settings (after the cutoff a new day starts)", () => {
    const settings = { timezone: "America/Mexico_City", cutoff: 240 };
    // 2026-10-06 03:59 local is still the business day of the 5th; 04:00 starts the 6th.
    expect(
      currentBusinessDate(settings, new Date("2026-10-06T09:59:00Z")),
    ).toBe("2026-10-05");
    expect(
      currentBusinessDate(settings, new Date("2026-10-06T10:00:00Z")),
    ).toBe("2026-10-06");
  });

  it("property: wideWindow contains every event of the range under any historical settings", () => {
    const random = rng(4242);
    const anyZone = [
      "America/Mexico_City",
      "America/Tijuana",
      "America/Cancun",
      "America/Hermosillo",
      "America/Ciudad_Juarez",
      "Pacific/Kiritimati",
      "Pacific/Pago_Pago",
    ];
    for (let n = 0; n < 2000; n++) {
      const from = addDays("2026-01-01", random.int(0, 800));
      const range = { from, to: addDays(from, random.int(0, 91)) };
      const current = {
        timezone: random.pick(anyZone),
        cutoff: random.int(0, 1439),
      };
      const past = {
        timezone: random.pick(anyZone),
        cutoff: random.int(0, 1439),
      };
      const date = random.pick([range.from, range.to]);
      const day = boundaries(date, past.timezone, past.cutoff);
      const instant = random.pick([
        day.start,
        Temporal.Instant.from(day.end).subtract({ milliseconds: 1 }).toString(),
      ]);
      expect(wallClockBusinessDate(instant, past.timezone, past.cutoff)).toBe(
        date,
      );
      const w = wideWindow(range, current);
      expect(
        Temporal.Instant.compare(
          Temporal.Instant.from(w.start),
          Temporal.Instant.from(instant),
        ),
      ).toBeLessThanOrEqual(0);
      expect(
        Temporal.Instant.compare(
          Temporal.Instant.from(instant),
          Temporal.Instant.from(w.end),
        ),
      ).toBeLessThan(0);
    }
  });

  it("wideWindow needs its full ±3 days: the far-apart worst cases (UTC+14 vs UTC−12, cutoff 0 vs 23:59) fall outside ±2 days", () => {
    const east = { timezone: "Pacific/Kiritimati", cutoff: 0 }; // UTC+14, no DST
    const west = { timezone: "Etc/GMT+12", cutoff: 1439 }; // UTC−12, no DST
    const range = { from: "2026-10-05", to: "2026-10-07" };
    const instant = (s: string) => Temporal.Instant.from(s);
    const minus1ms = (s: string) =>
      instant(s).subtract({ milliseconds: 1 }).toString();
    const inside = (at: string, w: { start: string; end: string }) =>
      Temporal.Instant.compare(instant(w.start), instant(at)) <= 0 &&
      Temporal.Instant.compare(instant(at), instant(w.end)) < 0;
    const narrow = (settings: typeof east, days: number) => ({
      start: boundaries(
        addDays(range.from, -days),
        settings.timezone,
        settings.cutoff,
      ).start,
      end: boundaries(
        addDays(range.to, days),
        settings.timezone,
        settings.cutoff,
      ).end,
    });
    for (const [current, past] of [
      [west, east],
      [east, west],
    ]) {
      const w = wideWindow(range, current);
      expect(w).toEqual(narrow(current, 3));
      // Every edge instant of both range ends under the past settings is inside the window.
      for (const date of [range.from, range.to]) {
        const day = boundaries(date, past.timezone, past.cutoff);
        for (const at of [day.start, minus1ms(day.end)]) {
          expect(wallClockBusinessDate(at, past.timezone, past.cutoff)).toBe(
            date,
          );
          expect(inside(at, w), `${current.timezone} ${at}`).toBe(true);
        }
      }
    }
    // A ±2-day window would drop the first instant of the range (current west, past east) and the
    // last one (current east, past west).
    const firstEast = boundaries(range.from, east.timezone, east.cutoff).start;
    const lastWest = minus1ms(
      boundaries(range.to, west.timezone, west.cutoff).end,
    );
    expect(firstEast).toBe("2026-10-04T10:00:00Z");
    expect(lastWest).toBe("2026-10-09T11:58:59.999Z");
    expect(inside(firstEast, narrow(west, 2))).toBe(false);
    expect(inside(lastWest, narrow(east, 2))).toBe(false);
    expect(inside(firstEast, wideWindow(range, west))).toBe(true);
    expect(inside(lastWest, wideWindow(range, east))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Catalogs, schemas and cursors
// ---------------------------------------------------------------------------------------------

describe("arithmetic helpers", () => {
  it("4. averageTicket rounds half up and is 0 without orders; bps floors and is 0 for an empty whole", () => {
    expect(averageTicket(1001, 2)).toBe(501); // 500.5 → 501
    expect(averageTicket(1000, 3)).toBe(333); // 333.33
    expect(averageTicket(1001, 3)).toBe(334); // 333.67
    expect(averageTicket(5, 2)).toBe(3); // 2.5 → 3
    expect(averageTicket(2_478_000, 98)).toBe(25_286); // §2.6.3 sample: $252.86
    expect(averageTicket(0, 0)).toBe(0);
    expect(averageTicket(12_345, 0)).toBe(0);
    expect(bps(1, 3)).toBe(3333);
    expect(bps(2, 3)).toBe(6666);
    expect(bps(3, 3)).toBe(10_000);
    expect(bps(5, 0)).toBe(0);
    expect(bps(-1, 3)).toBe(-3334); // floor, toward −∞
    expect(() => averageTicket(1.5, 2)).toThrow(RangeError);
    expect(() => bps(1, Number.NaN)).toThrow(RangeError);
  });

  it("property: averageTicket and bps are exact for large totals (BigInt reference)", () => {
    const random = rng(4);
    for (let n = 0; n < 5000; n++) {
      const total = random.int(0, 2 ** 40);
      const orders = random.int(1, 2_000_000);
      const reference = Number(
        (2n * BigInt(total) + BigInt(orders)) / (2n * BigInt(orders)),
      );
      expect(averageTicket(total, orders)).toBe(reference);
      expect(bps(total % (orders * 7 + 1), orders * 7 + 1)).toBe(
        Number(
          (BigInt(total % (orders * 7 + 1)) * 10_000n) / BigInt(orders * 7 + 1),
        ),
      );
    }
  });
});

describe("aggregateInt (postgres.js int8 → number)", () => {
  it("accepts int8 text, bigint and safe numbers, and refuses anything that is not an exact safe integer", () => {
    expect(aggregateInt("2540000")).toBe(2_540_000);
    expect(aggregateInt("-2000")).toBe(-2_000);
    expect(aggregateInt("0")).toBe(0);
    expect(Object.is(aggregateInt(-0), 0)).toBe(true);
    expect(aggregateInt(12n)).toBe(12);
    expect(aggregateInt(77)).toBe(77);
    expect(aggregateInt(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(aggregateInt(String(-Number.MAX_SAFE_INTEGER))).toBe(
      -Number.MAX_SAFE_INTEGER,
    );
    expect(aggregateInt(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    for (const bad of [
      "9007199254740992",
      "-9007199254740992",
      "99999999999999999",
      9007199254740992n,
      -9007199254740993n,
      "1.5",
      "1e3",
      " 12",
      "12 ",
      "",
      "0x10",
      "-",
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      null,
      undefined,
      true,
      {},
    ])
      expect(() => aggregateInt(bad), String(bad)).toThrow("invalid_amount");
  });

  it("maps an int8-as-text S1 row so the core accepts it, where the raw strings are refused", () => {
    const date = "2026-10-05";
    // S1's ::int8 sums as postgres.js returns them.
    const raw = { total: "9500", discounts: "500" };
    const input = (total: number | string, discounts: number | string) => ({
      range: { from: date, to: date },
      currency: "MXN",
      generatedAt: "2026-10-06T00:00:00Z",
      currentBusinessDate: "2026-10-06",
      sales: [
        {
          date,
          orders: 1,
          cancelled: 0,
          recoveryCount: 0,
          recoveryTotal: 0,
          ticketedRecoveryGross: 0,
          discounts,
          total,
          paid: total,
          tips: 0,
          openChecks: 0,
          overpaid: 0,
          ticketed: 0,
          ticketedGross: 0,
          ticketedOrderTotal: 0,
          unticketedOpen: 0,
          unticketedPaid: total,
          offlineCount: 0,
          offlineTotal: 0,
          offlineTips: 0,
        } as SalesDayAggregate,
      ],
      lines: [],
      collections: [],
      refunds: [],
      restocks: [],
      paidOuts: [],
      drawers: [],
      fiscal: null,
    });
    expect(() => composeSalesSummary(input(raw.total, raw.discounts))).toThrow(
      "invalid_amount",
    );
    const s = composeSalesSummary(
      input(aggregateInt(raw.total), aggregateInt(raw.discounts)),
    );
    expect(s.sales).toMatchObject({
      grossSales: 10_000,
      discounts: 500,
      salesTotal: 9_500,
    });
  });
});

describe("audit groups and exception kinds (GAP-3)", () => {
  /** A minimal LIKE matcher (default escape `\`), to prove the patterns behave in SQL terms. */
  function like(pattern: string, text: string): boolean {
    let source = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "\\")
        source += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      else if (c === "%") source += "[\\s\\S]*";
      else if (c === "_") source += "[\\s\\S]";
      else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp("^" + source + "$").test(text);
  }

  it("10. auditGroupPrefixes escapes LIKE wildcards and ends every prefix with %", () => {
    expect(escapeLike("a_b%c\\d")).toBe("a\\_b\\%c\\\\d");
    for (const group of AUDIT_GROUP_KEYS) {
      const patterns = auditGroupPrefixes(group);
      expect(patterns).toHaveLength(AUDIT_GROUPS[group].length);
      patterns.forEach((p, i) => {
        expect(p.endsWith("%")).toBe(true);
        expect(p.slice(0, -1)).toBe(escapeLike(AUDIT_GROUPS[group][i]));
        // No unescaped wildcard before the final %.
        expect(/(^|[^\\])(\\\\)*[_%]/.test(p.slice(0, -1))).toBe(false);
        const prefix = AUDIT_GROUPS[group][i];
        expect(like(p, prefix)).toBe(true);
        expect(like(p, prefix + "anything")).toBe(true);
      });
    }
    expect(like(auditGroupPrefixes("menu")[3], "prep")).toBe(true); // "prep%"
    expect(like(escapeLike("a_b") + "%", "aXb")).toBe(false);
    expect(like(escapeLike("a_b") + "%", "a_b.c")).toBe(true);
    expect(code(() => auditGroupPrefixes("toString" as never))).toBe(
      "invalid_input:400",
    );
  });

  it("matches each operation to the groups of the activity filter", () => {
    const groupsOf = (operation: string) =>
      AUDIT_GROUP_KEYS.filter((g) =>
        auditGroupPrefixes(g).some((p) => like(p, operation)),
      );
    expect(groupsOf("payment.recorded")).toEqual(["sales"]);
    expect(groupsOf("cash.paidout")).toEqual(["cash"]);
    expect(groupsOf("order.void")).toEqual(["corrections"]);
    expect(groupsOf("discount.controls.saved")).toEqual(["settings"]);
    expect(groupsOf("fiscal.profile.saved")).toEqual(["settings", "fiscal"]);
    expect(groupsOf("reports.corte_z.reprinted")).toEqual(["reports"]);
    expect(groupsOf("reports.count_slip.printed")).toEqual(["reports"]);
    expect(groupsOf("offline.kitchen.review")).toEqual(["kitchen"]);
    // Offline (026), menu floor (025) and forward entries (LD-16 L7, LD-18 LD-P4).
    expect(groupsOf("offline.synced")).toEqual(["sales"]);
    expect(groupsOf("offline.payment_attempt_recorded")).toEqual(["sales"]);
    expect(groupsOf("offline.reconciled")).toEqual(["corrections"]);
    expect(groupsOf("offline.payment_reconciled")).toEqual(["corrections"]);
    expect(groupsOf("offline.archived")).toEqual(["corrections"]);
    expect(groupsOf("offline.stock_reviewed")).toEqual(["menu"]);
    expect(groupsOf("offline.settings_changed")).toEqual(["settings"]);
    expect(groupsOf("floor.table.saved")).toEqual(["menu"]);
    expect(groupsOf("cfdi.invoice.stamped")).toEqual(["fiscal"]);
    expect(groupsOf("account.owner.transferred")).toEqual(["access"]);
    expect(groupsOf("public.hold_decided")).toEqual(["sales"]);
    // loyalty (038, R27): its own Bitácora group.
    expect(groupsOf("loyalty.reward.redeemed")).toEqual(["loyalty"]);
    expect(groupsOf("loyalty.member.deleted")).toEqual(["loyalty"]);
    expect(groupsOf("loyalty.settings.saved")).toEqual(["loyalty"]);
    for (const op of [
      "public.link_created",
      "public.settings_saved",
      "public.paused",
      "public.resumed",
      // LD-21: the platform's job operator commands (POST /api/jobs/:id/cancel, /requeue).
      "job.cancelled",
      "job.requeued",
    ])
      expect(groupsOf(op)).toEqual(["settings"]);
    // auditGroupsOf is the same matching in JS.
    for (const op of ["payment.recorded", "fiscal.profile.saved", "x.y"])
      expect(auditGroupsOf(op)).toEqual(groupsOf(op));
  });

  it("every operation src/labels.ts names belongs to an activity group, so the Bitácora filter reaches it", () => {
    const ungrouped = labelledOperations.filter(
      (op) => auditGroupsOf(op).length === 0,
    );
    expect(ungrouped).toEqual([]);
    expect(labelledOperations.length).toBeGreaterThanOrEqual(80);
  });

  it("parseExceptionKinds: absent means all, known kinds in catalog order, unknown kinds are invalid_input", () => {
    expect(parseExceptionKinds(undefined)).toEqual([...EXCEPTION_KINDS]);
    expect(parseExceptionKinds("")).toEqual([...EXCEPTION_KINDS]);
    expect(parseExceptionKinds("refund,void,refund")).toEqual([
      "void",
      "refund",
    ]);
    expect(parseExceptionKinds(" paid_out , drawer_difference")).toEqual([
      "paid_out",
      "drawer_difference",
    ]);
    for (const bad of ["void,bogus", "void,,refund", "VOID", "__proto__"])
      expect(code(() => parseExceptionKinds(bad))).toBe("invalid_input:400");
  });
});

describe("query schemas (zod 4, strict)", () => {
  it("parses the query strings of every list route and rejects unknown keys", () => {
    expect(
      summaryQuery.parse({ from: "2026-10-01", to: "2026-10-05" }),
    ).toEqual({
      from: "2026-10-01",
      to: "2026-10-05",
    });
    expect(
      summaryQuery.safeParse({ from: "2026-10-01", to: "2026-10-05", x: "1" })
        .success,
    ).toBe(false);
    expect(orderListQuery.parse({ from: "a", to: "b" }).limit).toBe(200);
    expect(
      orderListQuery.parse({ from: "a", to: "b", limit: "50" }).limit,
    ).toBe(50);
    expect(
      orderListQuery.safeParse({ from: "a", to: "b", limit: "501" }).success,
    ).toBe(false);
    expect(
      orderListQuery.safeParse({ from: "a", to: "b", limit: "0" }).success,
    ).toBe(false);
    expect(
      orderListQuery.safeParse({ from: "a", to: "b", state: "void" }).success,
    ).toBe(false);
    expect(exceptionQuery.parse({ from: "a", to: "b" }).limit).toBe(100);
    expect(
      auditQuery.parse({ from: "a", to: "b", order: "142", group: "cash" }),
    ).toEqual({
      from: "a",
      to: "b",
      order: 142,
      group: "cash",
      limit: 100,
    });
    expect(
      auditQuery.safeParse({ from: "a", to: "b", group: "toString" }).success,
    ).toBe(false);
    expect(
      summaryQuery.safeParse({ from: "x".repeat(41), to: "2026-10-05" })
        .success,
    ).toBe(false);
  });

  it("parses the print and remote-close commands", () => {
    const operationId = fakeId();
    expect(cortePrintInput.parse({ operationId, kind: "z" })).toEqual({
      operationId,
      kind: "z",
    });
    expect(cortePrintInput.safeParse({ operationId, kind: "y" }).success).toBe(
      false,
    );
    const fingerprint = "10000.1.4500.0.0.0.0.0.0.0.0.0";
    expect(
      remoteCloseInput.parse({
        operationId,
        fingerprint,
        counted: 1500,
        reason: "  dispositivo robado  ",
      }),
    ).toEqual({
      operationId,
      fingerprint,
      counted: 1500,
      reason: "dispositivo robado",
    });
    // REPORTS-CORTES-1: the close carries what the dialog showed; without it there is no close.
    expect(
      remoteCloseInput.safeParse({
        operationId,
        counted: 1500,
        reason: "motivo",
      }).success,
    ).toBe(false);
    expect(
      remoteCloseInput.safeParse({
        operationId,
        fingerprint,
        counted: 1500,
        reason: " ab ",
      }).success,
    ).toBe(false);
    expect(
      remoteCloseInput.safeParse({
        operationId,
        fingerprint,
        counted: -1,
        reason: "motivo",
      }).success,
    ).toBe(false);
    expect(
      remoteCloseInput.parse({
        operationId,
        fingerprint,
        counted: 0,
        reason: "motivo",
        externalReported: null,
      }).externalReported,
    ).toBeNull();
  });
});

describe("report cursors", () => {
  it("9. report cursors round-trip microsecond timestamp text and kind; forged cursors fail with invalid_input", () => {
    const i = fakeId();
    for (const c of [
      { t: "2026-10-05 15:40:12.123456+00", i },
      { t: "2026-10-05 15:40:12.123457+00", i, k: "void" as const },
      { t: "2026-10-05 09:40:12+05:30", i, k: "offline_reconcile" as const },
      { t: "2026-10-05T15:40:12.123Z", i },
    ]) {
      const s = encodeReportCursor(c);
      expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeReportCursor(s)).toEqual(c);
    }
    // Two rows in the same millisecond keep distinct cursors (no rounding to ms).
    expect(
      encodeReportCursor({ t: "2026-10-05 15:40:12.123456+00", i }),
    ).not.toBe(encodeReportCursor({ t: "2026-10-05 15:40:12.123457+00", i }));

    const forge = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const forged of [
      "",
      "not base64!",
      "a",
      Buffer.from("not json").toString("base64url"),
      forge(null),
      forge(["2026-10-05 15:40:12+00", i]),
      forge({ t: "2026-10-05 15:40:12+00" }),
      forge({ t: "2026-10-05 15:40:12+00", i: "nope" }),
      forge({ t: "2026-10-05 15:40:12+00", i, extra: 1 }),
      forge({ t: "2026-13-45 99:99:99+00", i }),
      forge({ t: "2026-10-05 15:40:12", i }),
      forge({ t: "yesterday", i }),
      forge({ t: "2026-10-05 15:40:12+00", i, k: "bogus" }),
      forge({ t: "2026-10-05 15:40:12+00'); drop table audit; --", i }),
      "A".repeat(401),
    ])
      expect(code(() => decodeReportCursor(forged))).toBe("invalid_input:400");
    expect(() => encodeReportCursor({ t: "soon", i })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Reconciliation checks and the metric contract
// ---------------------------------------------------------------------------------------------

const consistent: ReconciliationInput = {
  salesTotal: 2_478_000,
  discounts: 62_000,
  lineNet: 2_458_000,
  recoveryTotal: 20_000,
  allocatedDiscounts: 62_000,
  ticketedOrderTotal: 2_454_000,
  ticketedGross: 2_454_000,
  paidOnSales: 2_454_000,
  outstanding: 24_000,
  overpaidOrders: 0,
  byMethod: [
    { amount: 1_421_000, tips: 82_000 },
    { amount: 1_033_000, tips: 114_000 },
  ],
  collected: 2_454_000,
  tips: 196_000,
  fiscalRefunds: 9_000,
  fiscal: { gross: 2_454_000, refundGross: 9_000 },
};

describe("reconciliationChecks (§2.2)", () => {
  it("5. reconciliationChecks: all ok on consistent inputs, each code fails on its own mismatch, fiscal codes skipped when tax is null", () => {
    const checks = reconciliationChecks(consistent);
    expect(checks.map((c) => c.code)).toEqual([...CHECK_CODES]);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(failedCheckCodes(checks)).toEqual([]);

    const failing = (patch: Partial<ReconciliationInput>) =>
      failedCheckCodes(reconciliationChecks({ ...consistent, ...patch }));
    expect(failing({ lineNet: consistent.lineNet + 1 })).toEqual([
      "lines_vs_orders",
    ]);
    expect(failing({ recoveryTotal: 0 })).toEqual(["lines_vs_orders"]);
    expect(failing({ allocatedDiscounts: 61_999 })).toEqual([
      "discounts_vs_allocations",
    ]);
    expect(failing({ ticketedGross: 2_453_999 })).toEqual([
      "tickets_vs_orders",
    ]);
    expect(
      failing({ fiscal: { gross: 2_454_001, refundGross: 9_000 } }),
    ).toEqual(["tickets_vs_orders"]);
    expect(failing({ outstanding: 23_999 })).toEqual(["paid_identity"]);
    expect(failing({ overpaidOrders: 1 })).toEqual(["paid_identity"]);
    expect(
      failing({
        byMethod: [
          { amount: 1_421_000, tips: 82_000 },
          { amount: 1_032_999, tips: 114_000 },
        ],
      }),
    ).toEqual(["methods_sum"]);
    expect(failing({ tips: 196_001 })).toEqual(["methods_sum"]);
    expect(failing({ fiscal: { gross: 2_454_000, refundGross: 0 } })).toEqual([
      "refunds_vs_fiscal",
    ]);
    expect(failing({ fiscalRefunds: 9_001 })).toEqual(["refunds_vs_fiscal"]);

    const withoutFiscal = reconciliationChecks({ ...consistent, fiscal: null });
    expect(withoutFiscal.map((c) => c.code)).toEqual([
      "lines_vs_orders",
      "discounts_vs_allocations",
      "paid_identity",
      "methods_sum",
    ]);
    expect(withoutFiscal.every((c) => c.ok)).toBe(true);
    // Without fiscal data a ticket or refund mismatch cannot be judged.
    expect(
      failedCheckCodes(
        reconciliationChecks({
          ...consistent,
          fiscal: null,
          ticketedGross: 0,
          fiscalRefunds: 1,
        }),
      ),
    ).toEqual([]);
  });

  it("reports the record side as expected and the derived side as actual", () => {
    const [lines] = reconciliationChecks({ ...consistent, lineNet: 2_457_000 });
    expect(lines).toEqual({
      code: "lines_vs_orders",
      ok: false,
      expected: 2_478_000,
      actual: 2_477_000,
    });
    const tickets = reconciliationChecks({
      ...consistent,
      fiscal: { gross: 2_453_000, refundGross: 9_000 },
    }).find((c) => c.code === "tickets_vs_orders");
    expect(tickets).toEqual({
      code: "tickets_vs_orders",
      ok: false,
      expected: 2_454_000,
      actual: 2_453_000,
    });
  });
});

function summaryOf(
  world: World,
  range: DateRange,
  extra: Partial<SummaryInput> = {},
) {
  return composeSalesSummary({
    range,
    currency: "MXN",
    generatedAt: "2026-10-06T06:12:00.000Z",
    currentBusinessDate: range.to,
    ...aggregateWorld(world, range),
    drawers: [],
    fiscal: worldFiscalTotals(world, range),
    ...extra,
  });
}

/**
 * The whole SalesSummary that summaryOf(world, range) must return, computed straight from the
 * world's records with the §2.2 definitions: no S1–S5 aggregate, no aggregateWorld and no
 * composeSalesSummary helper is involved. Only the fiscal totals (fiscal's input, not a reports
 * figure) come from worldFiscalTotals, and the drawers are none.
 */
function summaryFromRecords(world: World, range: DateRange): SalesSummary {
  type Order = World["orders"][number];
  type Line = Order["lines"][number];
  type Tender = Order["tenders"][number];
  const inRange = (date: string) => date >= range.from && date <= range.to;
  const sum = <T>(rows: readonly T[], f: (row: T) => number) =>
    rows.reduce((a, row) => a + f(row), 0);
  const count = <T>(rows: readonly T[], p: (row: T) => boolean) =>
    rows.filter(p).length;

  const orders = world.orders.filter((o) => inRange(o.date));
  const recovery = (o: Order) => o.state === "recovery_pending";
  const discountOf = (o: Order) => sum(o.lines, lineDiscount);
  // Ventas brutas of one order: the remaining line gross after voids, or a recovery's total.
  const grossOf = (o: Order) =>
    recovery(o) ? o.recoveryTotal : sum(o.lines, lineGross);
  const paidOf = (o: Order) => sum(o.tenders, (t) => t.amount);
  const tipsOf = (o: Order) => sum(o.tenders, (t) => t.tip);
  const remaining = (l: Line) => l.quantity - l.voidedUnits;
  const costOf = (l: Line) => (l.cost === null ? 0 : l.cost);
  const costed = (l: Line) => l.cost !== null;
  const ticketed = orders.filter((o) => o.ticketed);
  const unticketed = orders.filter((o) => !o.ticketed);
  const offline = orders.filter((o) => o.channel === "offline");
  const allLines = orders.flatMap((o) => o.lines);
  const ticketedLines = ticketed.flatMap((o) => o.lines);

  const salesTotal = sum(orders, orderTotal);
  const discounts = sum(orders, discountOf);
  const orderCount = count(orders, (o) => orderTotal(o) > 0);
  const paidOnSales = sum(orders, paidOf);
  const cogs = sum(
    ticketedLines.filter(costed),
    (l) => costOf(l) * remaining(l),
  );
  // Recovery orders have no lines: their gross counts in the denominator as uncovered.
  const coverageWhole = sum(ticketed, grossOf);
  const coveredGross = sum(ticketedLines.filter(costed), lineGross);

  const refunds = world.refunds.filter((r) => inRange(r.date));
  const refundsOf = (method: string) =>
    refunds.filter((r) => r.method === method);
  const restockedCost = sum(refunds, (r) => r.restockedCost);
  const tenders: Tender[] = world.orders
    .flatMap((o) => o.tenders)
    .filter((t) => inRange(t.collectionDate));
  const late = tenders.filter((t) => t.collectionDate < t.recordedDate);
  const paidOuts = world.paidOuts.filter((p) => inRange(p.date));
  const fiscal = worldFiscalTotals(world, range);

  // payments (037): the metric contract has one row per tender method, platform included.
  const byMethod = (["cash", "external", "platform"] as const).map((method) => {
    const own = tenders.filter((t) => t.method === method);
    const amount = sum(own, (t) => t.amount);
    const tips = sum(own, (t) => t.tip);
    const refunded = sum(refundsOf(method), (r) => r.amount);
    return {
      method,
      count: own.length,
      amount,
      tips,
      refunds: refunded,
      refundCount: refundsOf(method).length,
      net: amount + tips - refunded,
    };
  });
  const collected = sum(tenders, (t) => t.amount);
  const tips = sum(tenders, (t) => t.tip);
  const refundTotal = sum(refunds, (r) => r.amount);
  const ok = (code: CheckCode, expected: number, actual: number) => ({
    code,
    ok: true,
    expected,
    actual,
  });

  return {
    range,
    currency: "MXN",
    generatedAt: "2026-10-06T06:12:00.000Z",
    currentBusinessDate: range.to,
    requestId: "",
    sales: {
      orders: orderCount,
      cancelledOrders: count(orders, (o) => o.state === "cancelled"),
      cancelledAmount: sum(
        orders.filter((o) => o.state === "cancelled"),
        (o) => sum(o.lines, (l) => l.voidedUnits * l.unitPrice),
      ),
      grossSales: sum(orders, grossOf),
      discounts,
      courtesies: sum(
        allLines.filter((l) => l.comp),
        lineDiscount,
      ),
      salesTotal,
      // round_half_up(salesTotal / orders); every total here is ≥ 0 and far below 2^53.
      averageTicket: orderCount ? Math.round(salesTotal / orderCount) : 0,
      offlineSales: {
        count: count(offline, (o) => orderTotal(o) > 0),
        total: sum(offline, orderTotal),
        tips: sum(offline, tipsOf),
      },
      voids: {
        amount: sum(allLines, (l) => l.voidedUnits * l.unitPrice),
        units: sum(allLines, (l) => l.voidedUnits),
      },
      ticketed: { count: ticketed.length, gross: sum(ticketed, orderTotal) },
      unticketed: {
        openBalance: sum(
          unticketed.filter((o) => paidOf(o) < orderTotal(o)),
          orderTotal,
        ),
        paidWithoutTicket: sum(
          unticketed.filter(
            (o) => orderTotal(o) > 0 && paidOf(o) >= orderTotal(o),
          ),
          orderTotal,
        ),
      },
      paidOnSales,
      outstanding: sum(orders, (o) => orderTotal(o) - paidOf(o)),
      openChecks: count(orders, (o) => orderTotal(o) > paidOf(o)),
      tipsOnSales: sum(orders, tipsOf),
      cogs,
      cogsAllOrders: sum(
        allLines.filter(costed),
        (l) => costOf(l) * remaining(l),
      ),
      costCoverageBps: coverageWhole
        ? Math.floor((10_000 * coveredGross) / coverageWhole)
        : 0,
      wasteCost: sum(allLines.filter(costed), (l) => costOf(l) * l.wasteUnits),
      recovery: {
        count: count(orders, recovery),
        total: sum(orders.filter(recovery), (o) => o.recoveryTotal),
      },
    },
    refunds: {
      count: refunds.length,
      total: refundTotal,
      cash: sum(refundsOf("cash"), (r) => r.amount),
      external: sum(refundsOf("external"), (r) => r.amount),
      platform: sum(refundsOf("platform"), (r) => r.amount),
      restockedCost,
    },
    collections: {
      byMethod,
      // The worlds pass no S6/S7 aggregates (unit fixtures).
      byTerminal: [],
      byPlatform: [],
      collected,
      tips,
      refunds: refundTotal,
      paidOuts: sum(paidOuts, (p) => p.amount),
      paidOutCount: paidOuts.length,
      late: { count: late.length, amount: sum(late, (t) => t.amount) },
    },
    // The worlds fix fiscal's totals only (SummaryInput.fiscal), never a full FiscalSummary.
    tax: null,
    margin: {
      netSalesExTax: fiscal ? fiscal.base : null,
      netAfterRefundsExTax: fiscal ? fiscal.netBase : null,
      salesAfterRefunds: fiscal ? fiscal.netGross : null,
      cogs,
      restockedCost,
      estimatedMargin: fiscal ? fiscal.netBase - cogs + restockedCost : null,
      processorFees: 0,
      platformCommissions: 0,
      feesEstimated: false,
      marginAfterFees: fiscal ? fiscal.netBase - cogs + restockedCost : null,
    },
    drawers: {
      open: 0,
      closed: 0,
      differenceNet: 0,
      shortages: 0,
      overages: 0,
      unreviewed: 0,
      openFromEarlierDays: 0,
    },
    days:
      range.from === range.to
        ? []
        : rangeDates(range).map((date) => {
            const own = orders.filter((o) => o.date === date);
            const collectedOn = tenders.filter(
              (t) => t.collectionDate === date,
            );
            const on = (method: string) =>
              sum(
                collectedOn.filter((t) => t.method === method),
                (t) => t.amount,
              );
            return {
              date,
              orders: count(own, (o) => orderTotal(o) > 0),
              grossSales: sum(own, grossOf),
              discounts: sum(own, discountOf),
              salesTotal: sum(own, orderTotal),
              refunds: sum(
                refunds.filter((r) => r.date === date),
                (r) => r.amount,
              ),
              cash: on("cash"),
              external: on("external"),
              platform: on("platform"),
              tips: sum(collectedOn, (t) => t.tip),
              paidOuts: sum(
                paidOuts.filter((p) => p.date === date),
                (p) => p.amount,
              ),
            };
          }),
    // Consistent records: every check passes, each comparing the record side with the derived side.
    checks: [
      ok(
        "lines_vs_orders",
        salesTotal,
        sum(allLines, (l) => lineGross(l) - lineDiscount(l)) +
          sum(orders.filter(recovery), (o) => o.recoveryTotal),
      ),
      ok("discounts_vs_allocations", discounts, sum(allLines, lineDiscount)),
      ...(fiscal
        ? [ok("tickets_vs_orders", sum(ticketed, orderTotal), fiscal.gross)]
        : []),
      ok(
        "paid_identity",
        salesTotal,
        paidOnSales + sum(orders, (o) => orderTotal(o) - paidOf(o)),
      ),
      ok(
        "methods_sum",
        tips,
        sum(byMethod, (m) => m.tips),
      ),
      ...(fiscal
        ? [
            ok(
              "refunds_vs_fiscal",
              sum(
                refunds.filter((r) => r.afterEpoch),
                (r) => r.amount,
              ),
              fiscal.refundGross,
            ),
          ]
        : []),
    ],
  };
}

describe("metric contract composition (MON-6, FIN-02)", () => {
  it("reproduces the §2.6.3 corte del día sample to the centavo", () => {
    const date = "2026-10-05";
    const summary = composeSalesSummary({
      range: { from: date, to: date },
      currency: "MXN",
      generatedAt: "2026-10-06T06:12:00.000Z",
      currentBusinessDate: "2026-10-06",
      requestId: "req-123",
      sales: [
        {
          date,
          orders: 98,
          cancelled: 1,
          recoveryCount: 0,
          recoveryTotal: 0,
          ticketedRecoveryGross: 0,
          discounts: 62_000,
          total: 2_478_000,
          paid: 2_454_000,
          tips: 196_000,
          openChecks: 2,
          overpaid: 0,
          ticketed: 96,
          ticketedGross: 2_454_000,
          ticketedOrderTotal: 2_454_000,
          unticketedOpen: 24_000,
          unticketedPaid: 0,
          offlineCount: 3,
          offlineTotal: 42_000,
          offlineTips: 2_000,
        },
      ],
      lines: [
        {
          date,
          lineNet: 2_478_000,
          voided: 64_000,
          voidedUnits: 9,
          cancelledAmount: 8_000,
          lineDiscounts: 62_000,
          courtesies: 18_000,
          cogs: 810_000,
          cogsAll: 818_000,
          coveredGross: 2_257_680,
          ticketedLineGross: 2_454_000,
          wasteCost: 3_000,
        },
      ],
      collections: [
        {
          date,
          method: "cash",
          count: 61,
          amount: 1_421_000,
          tips: 82_000,
          lateCount: 0,
          lateAmount: 0,
        },
        {
          date,
          method: "external",
          count: 37,
          amount: 1_033_000,
          tips: 114_000,
          lateCount: 0,
          lateAmount: 0,
        },
      ],
      refunds: [
        { date, method: "cash", count: 1, amount: 9_000, fiscalAmount: 9_000 },
      ],
      restocks: [],
      paidOuts: [{ date, count: 1, amount: 50_000 }],
      drawers: [],
      fiscal: {
        gross: 2_454_000,
        base: 2_115_517,
        refundGross: 9_000,
        netGross: 2_445_000,
        netBase: 2_107_758,
      },
    });
    expect(summary.sales).toMatchObject({
      grossSales: 2_540_000,
      discounts: 62_000,
      courtesies: 18_000,
      salesTotal: 2_478_000,
      orders: 98,
      averageTicket: 25_286,
      voids: { amount: 64_000, units: 9 },
      cancelledOrders: 1,
      cancelledAmount: 8_000,
      offlineSales: { count: 3, total: 42_000, tips: 2_000 },
      outstanding: 24_000,
      openChecks: 2,
      cogs: 810_000,
    });
    expect(summary.collections.byMethod).toEqual([
      {
        method: "cash",
        count: 61,
        amount: 1_421_000,
        tips: 82_000,
        refunds: 9_000,
        refundCount: 1,
        net: 1_494_000,
      },
      {
        method: "external",
        count: 37,
        amount: 1_033_000,
        tips: 114_000,
        refunds: 0,
        refundCount: 0,
        net: 1_147_000,
      },
      // payments (037): the platform row is always present (zero in this sample).
      {
        method: "platform",
        count: 0,
        amount: 0,
        tips: 0,
        refunds: 0,
        refundCount: 0,
        net: 0,
      },
    ]);
    expect(summary.collections).toMatchObject({
      collected: 2_454_000,
      tips: 196_000,
      refunds: 9_000,
      paidOuts: 50_000,
      paidOutCount: 1,
    });
    expect(summary.margin).toEqual({
      netSalesExTax: 2_115_517,
      netAfterRefundsExTax: 2_107_758,
      salesAfterRefunds: 2_445_000,
      cogs: 810_000,
      restockedCost: 0,
      estimatedMargin: 2_107_758 - 810_000,
      // payments (037): no fees or commissions in this sample (no S6/S7 rows).
      processorFees: 0,
      platformCommissions: 0,
      feesEstimated: false,
      marginAfterFees: 2_107_758 - 810_000,
    });
    expect(summary.refunds).toEqual({
      count: 1,
      total: 9_000,
      cash: 9_000,
      external: 0,
      platform: 0,
      restockedCost: 0,
    });
    expect(summary.sales.costCoverageBps).toBe(9200);
    expect(summary.days).toEqual([]);
    expect(summary.requestId).toBe("req-123");
    expect(failedCheckCodes(summary.checks)).toEqual([]);
  });

  it("property: in 400 random worlds every summary figure equals the records to the centavo, and gross, discounts, net, tips, refunds and tenders by type reconcile", () => {
    const random = rng(29029);
    // How often each figure differs from the figure a miswired sum would most likely use, so that
    // the whole-summary comparison below cannot pass vacuously.
    const seen = {
      waste: 0,
      tipsBeyondOffline: 0,
      cogsBeyondTicketed: 0,
      recoveryVsCancelled: 0,
      ticketedVsOrders: 0,
      courtesiesBelowDiscounts: 0,
      late: 0,
      restocked: 0,
      paidOuts: 0,
      openChecks: 0,
      voids: 0,
      cancelledAmount: 0,
    };
    // Fiscal adjusts refunds of orders without a ticket too (fiscal §4.7 step 4, provisional
    // groups), so refunds_vs_fiscal must pass with them in range (only fiscal worlds count).
    let refundOnUnticketed = 0;
    for (let n = 0; n < 400; n++) {
      const from = addDays("2026-10-01", random.int(0, 120));
      const range = { from, to: addDays(from, random.pick([0, 0, 1, 6, 30])) };
      const world = randomWorld(random, range);
      const s = summaryOf(world, range);

      // Every figure of the summary (sales, refunds, collections, margin, days and checks) against
      // the ground truth computed from the records alone.
      expect(s, JSON.stringify(range)).toEqual(
        summaryFromRecords(world, range),
      );
      if (s.sales.wasteCost > 0) seen.waste++;
      if (s.sales.tipsOnSales !== s.sales.offlineSales.tips)
        seen.tipsBeyondOffline++;
      if (s.sales.cogsAllOrders !== s.sales.cogs) seen.cogsBeyondTicketed++;
      if (s.sales.recovery.count !== s.sales.cancelledOrders)
        seen.recoveryVsCancelled++;
      if (s.sales.ticketed.count !== s.sales.orders) seen.ticketedVsOrders++;
      if (s.sales.courtesies > 0 && s.sales.courtesies < s.sales.discounts)
        seen.courtesiesBelowDiscounts++;
      if (s.collections.late.count > 0) seen.late++;
      if (s.refunds.restockedCost > 0) seen.restocked++;
      if (s.collections.paidOutCount > 0) seen.paidOuts++;
      if (s.sales.openChecks > 0) seen.openChecks++;
      if (s.sales.voids.units > 0) seen.voids++;
      if (s.sales.cancelledAmount > 0) seen.cancelledAmount++;
      const unticketedTenders = new Set(
        world.orders
          .filter((o) => !o.ticketed)
          .flatMap((o) => o.tenders.map((t) => t.id)),
      );
      if (
        world.fiscal &&
        world.refunds.some(
          (r) =>
            r.afterEpoch &&
            r.date >= range.from &&
            r.date <= range.to &&
            unticketedTenders.has(r.tenderId),
        )
      )
        refundOnUnticketed++;
      const inRange = (d: string) => d >= range.from && d <= range.to;
      const orders = world.orders.filter((o) => inRange(o.date));
      const tenders = world.orders
        .flatMap((o) => o.tenders)
        .filter((t) => inRange(t.collectionDate));
      const refunds = world.refunds.filter((r) => inRange(r.date));
      const sum = <T>(rows: T[], f: (r: T) => number) =>
        rows.reduce((a, r) => a + f(r), 0);

      // Sales lens against the records. Ventas brutas is the line gross after voids (the 028 DB
      // identity total + discount = Σ lines − Σ voids) plus the recovery totals, and Descuentos
      // the active allocations; Ventas brutas − Descuentos = Ventas totales.
      const recovery = (o: World["orders"][number]) =>
        o.state === "recovery_pending";
      const grossOf = (o: World["orders"][number]) =>
        recovery(o) ? o.recoveryTotal : sum(o.lines, lineGross);
      expect(s.sales.salesTotal).toBe(sum(orders, orderTotal));
      expect(s.sales.grossSales).toBe(sum(orders, grossOf));
      expect(s.sales.discounts).toBe(
        sum(orders, (o) => sum(o.lines, lineDiscount)),
      );
      expect(s.sales.grossSales - s.sales.discounts).toBe(s.sales.salesTotal);
      expect(s.sales.orders).toBe(
        orders.filter((o) => orderTotal(o) > 0).length,
      );
      expect(s.sales.paidOnSales + s.sales.outstanding).toBe(
        s.sales.salesTotal,
      );
      expect(s.sales.outstanding).toBe(
        sum(orders, (o) => orderTotal(o) - orderPaid(o)),
      );
      expect(s.sales.outstanding).toBeGreaterThanOrEqual(0);
      expect(
        s.sales.unticketed.openBalance +
          s.sales.unticketed.paidWithoutTicket +
          s.sales.ticketed.gross,
      ).toBe(s.sales.salesTotal);
      expect(s.sales.courtesies).toBeLessThanOrEqual(s.sales.discounts);
      expect(s.sales.offlineSales.total).toBeLessThanOrEqual(
        s.sales.salesTotal,
      );
      expect(s.sales.costCoverageBps).toBeGreaterThanOrEqual(0);
      expect(s.sales.costCoverageBps).toBeLessThanOrEqual(10_000);
      expect(s.sales.averageTicket).toBe(
        averageTicket(s.sales.salesTotal, s.sales.orders),
      );
      expect(s.sales.cogs).toBeLessThanOrEqual(s.sales.cogsAllOrders);

      // Refund lens.
      expect(s.refunds.total).toBe(sum(refunds, (r) => r.amount));
      expect(s.refunds.cash + s.refunds.external).toBe(s.refunds.total);
      expect(s.refunds.count).toBe(refunds.length);

      // Collection lens: tenders by type.
      expect(s.collections.collected).toBe(sum(tenders, (t) => t.amount));
      expect(s.collections.tips).toBe(sum(tenders, (t) => t.tip));
      for (const m of s.collections.byMethod) {
        const own = tenders.filter((t) => t.method === m.method);
        expect(m.amount).toBe(sum(own, (t) => t.amount));
        expect(m.tips).toBe(sum(own, (t) => t.tip));
        expect(m.count).toBe(own.length);
        expect(m.refunds).toBe(
          sum(
            refunds.filter((r) => r.method === m.method),
            (r) => r.amount,
          ),
        );
        expect(m.net).toBe(m.amount + m.tips - m.refunds);
      }
      expect(sum(s.collections.byMethod, (m) => m.net)).toBe(
        s.collections.collected + s.collections.tips - s.collections.refunds,
      );
      expect(s.collections.refunds).toBe(s.refunds.total);
      expect(s.collections.late.amount).toBe(
        sum(
          tenders.filter((t) => t.collectionDate < t.recordedDate),
          (t) => t.amount,
        ),
      );

      // Margin.
      if (world.fiscal) {
        const f = worldFiscalTotals(world, range)!;
        expect(s.margin.estimatedMargin).toBe(
          f.netBase - s.sales.cogs + s.refunds.restockedCost,
        );
        expect(s.margin.salesAfterRefunds).toBe(f.netGross);
      } else {
        expect(s.margin.estimatedMargin).toBeNull();
        expect(s.margin.netSalesExTax).toBeNull();
      }

      // Per-day rows add up to the range totals.
      if (range.from === range.to) expect(s.days).toEqual([]);
      else {
        expect(s.days.map((d) => d.date)).toEqual(rangeDates(range));
        for (const d of s.days) {
          const own = orders.filter((o) => o.date === d.date);
          expect(d.grossSales).toBe(sum(own, grossOf));
          expect(d.salesTotal).toBe(sum(own, orderTotal));
          expect(d.grossSales - d.discounts).toBe(d.salesTotal);
        }
        expect(sum(s.days, (d) => d.orders)).toBe(s.sales.orders);
        expect(sum(s.days, (d) => d.grossSales)).toBe(s.sales.grossSales);
        expect(sum(s.days, (d) => d.discounts)).toBe(s.sales.discounts);
        expect(sum(s.days, (d) => d.salesTotal)).toBe(s.sales.salesTotal);
        expect(sum(s.days, (d) => d.refunds)).toBe(s.refunds.total);
        expect(sum(s.days, (d) => d.cash + d.external)).toBe(
          s.collections.collected,
        );
        expect(sum(s.days, (d) => d.cash)).toBe(
          s.collections.byMethod[0].amount,
        );
        expect(sum(s.days, (d) => d.tips)).toBe(s.collections.tips);
        expect(sum(s.days, (d) => d.paidOuts)).toBe(s.collections.paidOuts);
      }

      // Every check passes on consistent records.
      expect(failedCheckCodes(s.checks), JSON.stringify(range)).toEqual([]);
      expect(s.checks.length).toBe(world.fiscal ? 6 : 4);
    }
    for (const [figure, worlds] of Object.entries(seen))
      expect(worlds, figure).toBeGreaterThan(100);
    expect(refundOnUnticketed).toBeGreaterThan(40);
  });

  // 200 worlds × every drift: about 2 s alone, but up to 9 s while the whole
  // unit suite runs in parallel on a loaded machine (CI parity runs), past
  // vitest's 5 s default. Only the time limit is set; nothing else changes.
  it("property: a one-centavo drift (+1 or −1) in a guarded aggregate fails its own check, plus paid_identity only when a lower S1 total makes outstanding negative, and Ventas brutas − Descuentos = Ventas totales holds under any drift", () => {
    const random = rng(7);
    let tried = 0;
    let withRefunds = 0;
    let fullyPaid = 0;
    for (let n = 0; n < 200; n++) {
      const range = { from: "2026-10-05", to: "2026-10-07" };
      const world = randomWorld(random, range, { fiscal: true });
      const agg = aggregateWorld(world, range);
      if (!agg.sales.length || !agg.lines.length || !agg.collections.length)
        continue;
      tried++;
      const base: SummaryInput = {
        range,
        currency: "MXN",
        generatedAt: "2026-10-08T00:00:00Z",
        currentBusinessDate: "2026-10-08",
        ...agg,
        drawers: [],
        fiscal: worldFiscalTotals(world, range),
      };
      const summary = (patch: Partial<SummaryInput>) =>
        composeSalesSummary({ ...base, ...patch });
      const fails = (patch: Partial<SummaryInput>) =>
        failedCheckCodes(summary(patch).checks);
      const bump = <T extends object>(
        rows: readonly T[],
        key: keyof T,
        delta = 1,
      ) =>
        rows.map((r, i) =>
          i === 0 ? { ...r, [key]: (r[key] as number) + delta } : r,
        );
      const identityHolds = (patch: Partial<SummaryInput>) => {
        const s = summary(patch);
        expect(s.sales.grossSales - s.sales.discounts).toBe(s.sales.salesTotal);
        for (const d of s.days)
          expect(d.grossSales - d.discounts).toBe(d.salesTotal);
      };
      expect(fails({})).toEqual([]);
      const outstanding = summary({}).sales.outstanding;

      // The guarded aggregates: a drift of either sign fails its own check. The one exception is
      // lowering the S1 total of a fully paid range: outstanding (total − paid) turns −1, so
      // paid_identity fails too (the drift is caught twice, never missed).
      for (const delta of [1, -1]) {
        const totalFails =
          delta < 0 && outstanding === 0
            ? ["lines_vs_orders", "paid_identity"]
            : ["lines_vs_orders"];
        const guarded: [Partial<SummaryInput>, string[]][] = [
          [{ sales: bump(agg.sales, "total", delta) }, totalFails],
          [
            { sales: bump(agg.sales, "recoveryTotal", delta) },
            ["lines_vs_orders"],
          ],
          [{ lines: bump(agg.lines, "lineNet", delta) }, ["lines_vs_orders"]],
          [
            { sales: bump(agg.sales, "discounts", delta) },
            ["discounts_vs_allocations"],
          ],
          [
            { lines: bump(agg.lines, "lineDiscounts", delta) },
            ["discounts_vs_allocations"],
          ],
          [
            { sales: bump(agg.sales, "ticketedGross", delta) },
            ["tickets_vs_orders"],
          ],
          [
            { sales: bump(agg.sales, "ticketedOrderTotal", delta) },
            ["tickets_vs_orders"],
          ],
          [
            { fiscal: { ...base.fiscal!, gross: base.fiscal!.gross + delta } },
            ["tickets_vs_orders"],
          ],
          [{ sales: bump(agg.sales, "overpaid", delta) }, ["paid_identity"]],
          [
            {
              fiscal: {
                ...base.fiscal!,
                refundGross: base.fiscal!.refundGross + delta,
              },
            },
            ["refunds_vs_fiscal"],
          ],
        ];
        if (agg.refunds.length)
          guarded.push([
            { refunds: bump(agg.refunds, "fiscalAmount", delta) },
            ["refunds_vs_fiscal"],
          ]);
        for (const [patch, checks] of guarded) {
          expect(fails(patch), `${checks[0]} ${delta}`).toEqual(checks);
          identityHolds(patch);
        }
      }
      if (agg.refunds.length) withRefunds++;

      // The same records with every order paid in full (outstanding 0): +1 on the S1 total fails
      // lines_vs_orders alone, −1 fails lines_vs_orders and paid_identity.
      const paidUp = agg.sales.map((r) => ({ ...r, paid: r.total }));
      expect(fails({ sales: paidUp })).toEqual([]);
      expect(summary({ sales: paidUp }).sales.outstanding).toBe(0);
      expect(fails({ sales: bump(paidUp, "total", 1) })).toEqual([
        "lines_vs_orders",
      ]);
      expect(fails({ sales: bump(paidUp, "total", -1) })).toEqual([
        "lines_vs_orders",
        "paid_identity",
      ]);
      if (outstanding === 0) fullyPaid++;

      // Not guarded by the checks (the DB suite of the next wave compares them with the records):
      // a drift leaves every check green, and the gross identity still holds.
      const unguarded: Partial<SummaryInput>[] = [
        { sales: bump(agg.sales, "tips") },
        { sales: bump(agg.sales, "orders") },
        { lines: bump(agg.lines, "cogs") },
        { collections: bump(agg.collections, "amount") },
        { collections: bump(agg.collections, "tips") },
        {
          paidOuts: [
            ...agg.paidOuts,
            { date: range.from, count: 1, amount: 1 },
          ],
        },
      ];
      if (agg.refunds.length)
        unguarded.push({ refunds: bump(agg.refunds, "amount") });
      for (const patch of unguarded) {
        expect(fails(patch)).toEqual([]);
        identityHolds(patch);
      }
      // A non-fiscal refund drift is not seen either: without fiscal data there is no refund check.
      if (agg.refunds.length)
        expect(
          fails({ fiscal: null, refunds: bump(agg.refunds, "fiscalAmount") }),
        ).toEqual([]);

      // Moving a tender between methods keeps every check green: the split is not double counted.
      const moved = agg.collections.map((c) => ({
        ...c,
        method: c.method === "cash" ? ("external" as const) : ("cash" as const),
      }));
      expect(fails({ collections: moved })).toEqual([]);
    }
    expect(tried).toBeGreaterThan(50);
    expect(withRefunds).toBeGreaterThan(10);
    // The natural worlds reach the outstanding = 0 branch of the −1 total drift too.
    expect(fullyPaid).toBeGreaterThan(0);
  }, 30_000);

  it("Ventas brutas cannot disagree with Ventas totales + Descuentos: a stale S1 gross column is ignored", () => {
    const date = "2026-10-05";
    const day = (p: Partial<SalesDayAggregate>): SalesDayAggregate => ({
      date,
      orders: 2,
      cancelled: 0,
      recoveryCount: 0,
      recoveryTotal: 0,
      ticketedRecoveryGross: 0,
      discounts: 1_000,
      total: 19_000,
      paid: 19_000,
      tips: 0,
      openChecks: 0,
      overpaid: 0,
      ticketed: 0,
      ticketedGross: 0,
      ticketedOrderTotal: 0,
      unticketedOpen: 0,
      unticketedPaid: 19_000,
      offlineCount: 0,
      offlineTotal: 0,
      offlineTips: 0,
      ...p,
    });
    const lines = (d: string, lineNet: number, lineDiscounts: number) => ({
      date: d,
      lineNet,
      voided: 0,
      voidedUnits: 0,
      cancelledAmount: 0,
      lineDiscounts,
      courtesies: 0,
      cogs: 0,
      cogsAll: 0,
      coveredGross: 0,
      ticketedLineGross: 0,
      wasteCost: 0,
    });
    // The integration wave may spread a whole S1 row, `gross` included: a wrong one changes nothing.
    const stale = { ...day({}), gross: 20_001 } as SalesDayAggregate;
    const next = addDays(date, 1);
    const range = { from: date, to: next };
    const s = composeSalesSummary({
      range,
      currency: "MXN",
      generatedAt: "2026-10-07T00:00:00Z",
      currentBusinessDate: "2026-10-07",
      sales: [
        stale,
        day({
          date: next,
          discounts: 0,
          total: 5,
          paid: 5,
          unticketedPaid: 5,
        }),
      ],
      lines: [lines(date, 19_000, 1_000), lines(next, 5, 0)],
      collections: [],
      refunds: [],
      restocks: [],
      paidOuts: [],
      drawers: [],
      fiscal: null,
    });
    expect(s.sales).toMatchObject({
      grossSales: 20_005,
      discounts: 1_000,
      salesTotal: 19_005,
    });
    expect(
      s.days.map((d) => [d.grossSales, d.discounts, d.salesTotal]),
    ).toEqual([
      [20_000, 1_000, 19_000],
      [5, 0, 5],
    ]);
    expect(failedCheckCodes(s.checks)).toEqual([]);
  });

  it("a check paid the next day is a Monday sale and a Tuesday collection; a later refund leaves the sale day unchanged", () => {
    const monday = "2026-10-05";
    const tuesday = "2026-10-06";
    const wednesday = "2026-10-07";
    const world: World = {
      fiscal: true,
      paidOuts: [],
      orders: [
        {
          date: monday,
          state: "paid",
          channel: "pos",
          recoveryTotal: 0,
          ticketed: true,
          lines: [
            {
              quantity: 2,
              unitPrice: 5_000,
              cost: 1_000,
              voidedUnits: 0,
              wasteUnits: 0,
              unitDiscounts: [0, 0],
              comp: false,
            },
          ],
          tenders: [
            {
              id: 1,
              method: "external",
              amount: 10_000,
              tip: 1_000,
              collectionDate: tuesday,
              recordedDate: tuesday,
            },
          ],
        },
      ],
      refunds: [
        {
          tenderId: 1,
          method: "external",
          amount: 5_000,
          date: wednesday,
          afterEpoch: true,
          restockedCost: 1_000,
        },
      ],
    };
    const day = (d: string) => summaryOf(world, { from: d, to: d });
    expect(day(monday).sales.salesTotal).toBe(10_000);
    expect(day(monday).collections.collected).toBe(0);
    expect(day(monday).sales.outstanding).toBe(0); // paid, on another day
    expect(day(tuesday).sales.salesTotal).toBe(0);
    expect(day(tuesday).collections.byMethod[1]).toMatchObject({
      amount: 10_000,
      tips: 1_000,
      net: 11_000,
    });
    expect(day(wednesday).refunds).toMatchObject({
      total: 5_000,
      external: 5_000,
      restockedCost: 1_000,
    });
    expect(day(wednesday).collections.byMethod[1].net).toBe(-5_000);
    const week = summaryOf(world, { from: monday, to: wednesday });
    expect(
      week.days.map((d) => [d.date, d.salesTotal, d.external, d.refunds]),
    ).toEqual([
      [monday, 10_000, 0, 0],
      [tuesday, 0, 10_000, 0],
      [wednesday, 0, 0, 5_000],
    ]);
    expect(failedCheckCodes(week.checks)).toEqual([]);
  });

  it("an offline sale synced the next morning counts on the sale day and is disclosed as late", () => {
    const sunday = "2026-10-04";
    const world: World = {
      fiscal: false,
      paidOuts: [],
      refunds: [],
      orders: [
        {
          date: sunday,
          state: "paid",
          channel: "offline",
          recoveryTotal: 0,
          ticketed: false,
          lines: [
            {
              quantity: 1,
              unitPrice: 8_500,
              cost: null,
              voidedUnits: 0,
              wasteUnits: 0,
              unitDiscounts: [0],
              comp: false,
            },
          ],
          tenders: [
            {
              id: 1,
              method: "cash",
              amount: 8_500,
              tip: 500,
              collectionDate: sunday,
              recordedDate: "2026-10-05",
            },
          ],
        },
      ],
    };
    const s = summaryOf(world, { from: sunday, to: sunday });
    expect(s.collections.collected).toBe(8_500);
    expect(s.collections.late).toEqual({ count: 1, amount: 8_500 });
    expect(s.sales.offlineSales).toEqual({ count: 1, total: 8_500, tips: 500 });
    expect(s.sales.unticketed.paidWithoutTicket).toBe(8_500);
    expect(s.margin.estimatedMargin).toBeNull();
    expect(s.checks.map((c) => c.code)).not.toContain("tickets_vs_orders");
    expect(
      summaryOf(world, { from: "2026-10-05", to: "2026-10-05" }).collections
        .collected,
    ).toBe(0);
  });

  it("refuses aggregates dated outside the range and non-integer amounts", () => {
    const range = { from: "2026-10-05", to: "2026-10-05" };
    const empty = aggregateWorld(
      { orders: [], refunds: [], paidOuts: [], fiscal: false },
      range,
    );
    const input: SummaryInput = {
      range,
      currency: "MXN",
      generatedAt: "x",
      currentBusinessDate: "2026-10-05",
      ...empty,
      drawers: [],
      fiscal: null,
    };
    expect(composeSalesSummary(input).sales.salesTotal).toBe(0);
    expect(failedCheckCodes(composeSalesSummary(input).checks)).toEqual([]);
    expect(() =>
      composeSalesSummary({
        ...input,
        paidOuts: [{ date: "2026-10-06", count: 1, amount: 5 }],
      }),
    ).toThrow("aggregate_outside_range");
    expect(() =>
      composeSalesSummary({
        ...input,
        paidOuts: [{ date: "2026-10-05", count: 1, amount: 0.5 }],
      }),
    ).toThrow(RangeError);
    expect(
      code(() =>
        composeSalesSummary({
          ...input,
          range: { from: "2026-10-06", to: "2026-10-05" },
        }),
      ),
    ).toBe("reports_range_invalid:400");
  });
});

// ---------------------------------------------------------------------------------------------
// Hours and exceptions
// ---------------------------------------------------------------------------------------------

describe("hourRows", () => {
  it("7. hourRows starts at the cutoff hour and fills zero rows between the first and last active hour", () => {
    const rows = hourRows(
      [
        { hour: 1, orders: 1, salesTotal: 900 }, // after midnight: end of the business day
        { hour: 9, orders: 3, salesTotal: 1_000 },
        { hour: 5, orders: 2, salesTotal: 301 },
      ],
      240,
    );
    expect(rows.map((r) => r.hour)).toEqual([
      5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0,
      1,
    ]);
    expect(rows[0]).toEqual({
      hour: 5,
      orders: 2,
      salesTotal: 301,
      averageTicket: 151,
    });
    expect(rows[1]).toEqual({
      hour: 6,
      orders: 0,
      salesTotal: 0,
      averageTicket: 0,
    });
    expect(rows[4]).toEqual({
      hour: 9,
      orders: 3,
      salesTotal: 1_000,
      averageTicket: 333,
    });
    expect(rows.at(-1)).toEqual({
      hour: 1,
      orders: 1,
      salesTotal: 900,
      averageTicket: 900,
    });
    expect(rows.reduce((a, r) => a + r.salesTotal, 0)).toBe(2_201);
  });

  it("handles cutoffs 0 and 1439, merges duplicate hours, ignores empty hours at the edges and refuses bad hours", () => {
    expect(hourRows([], 240)).toEqual([]);
    expect(hourRows([{ hour: 7, orders: 0, salesTotal: 0 }], 240)).toEqual([]);
    expect(
      hourRows(
        [
          { hour: 23, orders: 1, salesTotal: 100 },
          { hour: 0, orders: 1, salesTotal: 50 },
        ],
        0,
      ).map((r) => r.hour),
    ).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      21, 22, 23,
    ]);
    expect(
      hourRows(
        [
          { hour: 0, orders: 1, salesTotal: 50 },
          { hour: 23, orders: 1, salesTotal: 100 },
          { hour: 23, orders: 2, salesTotal: 200 },
          { hour: 20, orders: 0, salesTotal: 0 },
        ],
        1439,
      ),
    ).toEqual([
      { hour: 23, orders: 3, salesTotal: 300, averageTicket: 100 },
      { hour: 0, orders: 1, salesTotal: 50, averageTicket: 50 },
    ]);
    expect(() => hourRows([{ hour: 24, orders: 1, salesTotal: 1 }], 0)).toThrow(
      RangeError,
    );
    expect(() => hourRows([], 1440)).toThrow(RangeError);
  });
});

describe("exceptionSummary (GAP-3)", () => {
  const ana = fakeId(9001);
  const beto = fakeId(9002);
  const mara = fakeId(9003); // manager
  const wen = fakeId(9004); // server of the open-price check
  let n = 0;
  const row = (
    kind: ExceptionKind,
    amount: number,
    p: Partial<ExceptionRow> = {},
  ): ExceptionRow => ({
    id: fakeId(9100 + ++n),
    kind,
    at: "2026-10-05 15:00:00+00",
    businessDate: "2026-10-05",
    actorId: null,
    actorName: null,
    approverId: null,
    approverName: null,
    accountId: null,
    accountName: null,
    amount,
    orderId: null,
    orderNumber: null,
    orderDate: null,
    reasonCode: null,
    note: "",
    deviceName: null,
    detail: {},
    ...p,
  });
  const A = { actorId: ana, actorName: "Ana" };
  const B = { actorId: beto, actorName: "Beto" };
  const M = { approverId: mara, approverName: "Mara" };
  const rows = [
    row("void", 8_000, { ...A, ...M }),
    row("discount", 1_200, A),
    row("refund", 9_000, { ...B, ...M }),
    row("drawer_difference", -2_000, { ...A, ...M }),
    row("drawer_difference", 500, B),
    row("open_price", 4_500, { accountId: wen, accountName: "Wendy" }),
    row("reprint", 0, A),
    row("refund", 300), // legacy refund: no actor recorded
  ];

  it("8. exceptionSummary separates acted and approved per employee, shortages and overages, and attributes open-price lines to the check's server", () => {
    const s = exceptionSummary(rows);
    expect(s.byKind).toEqual([
      { kind: "void", count: 1, amount: 8_000 },
      { kind: "discount", count: 1, amount: 1_200 },
      { kind: "refund", count: 2, amount: 9_300 },
      // A $20.00 shortage and a $5.00 overage do not net to $15.00: the tile shows $25.00.
      {
        kind: "drawer_difference",
        count: 2,
        amount: 2_500,
        shortages: 2_000,
        overages: 500,
      },
      { kind: "reprint", count: 1, amount: 0 },
      { kind: "open_price", count: 1, amount: 4_500 },
    ]);
    expect(s.byEmployee).toEqual([
      {
        employeeId: ana,
        name: "Ana",
        acted: {
          void: { count: 1, amount: 8_000 },
          discount: { count: 1, amount: 1_200 },
          drawer_difference: { count: 1, amount: 2_000 },
          reprint: { count: 1, amount: 0 },
        },
        shortages: 2_000,
        overages: 0,
        approved: { count: 0, amount: 0 },
      },
      {
        employeeId: beto,
        name: "Beto",
        acted: {
          refund: { count: 1, amount: 9_000 },
          drawer_difference: { count: 1, amount: 500 },
        },
        shortages: 0,
        overages: 500,
        approved: { count: 0, amount: 0 },
      },
      {
        employeeId: mara,
        name: "Mara",
        acted: {},
        shortages: 0,
        overages: 0,
        approved: { count: 3, amount: 8_000 + 9_000 + 2_000 },
      },
      {
        employeeId: wen,
        name: "Wendy",
        acted: { open_price: { count: 1, amount: 4_500 } },
        shortages: 0,
        overages: 0,
        approved: { count: 0, amount: 0 },
      },
    ]);
  });

  it("property: the per-employee summary equals the listed rows (acted, approved, shortages, overages)", () => {
    const random = rng(8);
    const people = [ana, beto, mara, wen];
    for (let k = 0; k < 300; k++) {
      const list = Array.from({ length: random.int(0, 40) }, () => {
        const kind = random.pick(EXCEPTION_KINDS);
        const amount =
          kind === "drawer_difference" || kind === "terminal_difference"
            ? random.int(-5_000, 5_000)
            : random.int(0, 20_000);
        const actor = random.next() < 0.9 ? random.pick(people) : null;
        const approver = random.next() < 0.4 ? random.pick(people) : null;
        return row(kind, amount, {
          actorId: kind === "open_price" ? null : actor,
          actorName: actor ? "n" + actor.slice(-2) : null,
          accountId: kind === "open_price" ? actor : null,
          accountName:
            kind === "open_price" && actor ? "n" + actor.slice(-2) : null,
          approverId: approver,
          approverName: approver ? "n" + approver.slice(-2) : null,
        });
      });
      const s = exceptionSummary(list);
      const acting = list.filter((r) =>
        r.kind === "open_price" ? r.accountId : r.actorId,
      );
      const actedCount = s.byEmployee.reduce(
        (a, e) => a + Object.values(e.acted).reduce((b, x) => b + x!.count, 0),
        0,
      );
      expect(actedCount).toBe(acting.length);
      // LD-16 L3: a self-approval (approver = the row's actor) is not an approval given.
      const actorOf = (r: ExceptionRow) =>
        r.kind === "open_price" ? r.accountId : r.actorId;
      expect(s.byEmployee.reduce((a, e) => a + e.approved.count, 0)).toBe(
        list.filter((r) => r.approverId && r.approverId !== actorOf(r)).length,
      );
      const diffs = acting.filter((r) => r.kind === "drawer_difference");
      expect(s.byEmployee.reduce((a, e) => a + e.shortages, 0)).toBe(
        diffs.filter((r) => r.amount < 0).reduce((a, r) => a - r.amount, 0),
      );
      expect(s.byEmployee.reduce((a, e) => a + e.overages, 0)).toBe(
        diffs.filter((r) => r.amount > 0).reduce((a, r) => a + r.amount, 0),
      );
      expect(s.byKind.reduce((a, x) => a + x.count, 0)).toBe(list.length);
      const magnitude = (r: ExceptionRow) =>
        DIFFERENCE_KINDS.includes(r.kind) ? Math.abs(r.amount) : r.amount;
      expect(s.byKind.reduce((a, x) => a + x.amount, 0)).toBe(
        list.reduce((a, r) => a + magnitude(r), 0),
      );
      for (const t of s.byKind) {
        const of = list.filter((r) => r.kind === t.kind);
        if (DIFFERENCE_KINDS.includes(t.kind)) {
          // Shortages and overages never cancel out.
          expect(t.shortages).toBe(
            of.filter((r) => r.amount < 0).reduce((a, r) => a - r.amount, 0),
          );
          expect(t.overages).toBe(
            of.filter((r) => r.amount > 0).reduce((a, r) => a + r.amount, 0),
          );
          expect(t.amount).toBe(t.shortages! + t.overages!);
        } else {
          expect(t).not.toHaveProperty("shortages");
          expect(t).not.toHaveProperty("overages");
        }
      }
      for (const e of s.byEmployee)
        for (const [kind, acted] of Object.entries(e.acted))
          expect(acted!.amount).toBe(
            acting
              .filter(
                (r) =>
                  r.kind === kind &&
                  (r.kind === "open_price" ? r.accountId : r.actorId) ===
                    e.employeeId,
              )
              .reduce((a, r) => a + magnitude(r), 0),
          );
      expect(exceptionTotals(list)).toEqual(s.byKind);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Drawers and cortes
// ---------------------------------------------------------------------------------------------

const restaurant = {
  name: "Taquería El Güero",
  currency: "MXN",
  timezone: "America/Mexico_City",
};
function facts(p: Partial<DrawerFacts> = {}): DrawerFacts {
  return {
    id: fakeId(7001),
    businessDate: "2026-10-05",
    zNumber: 128,
    deviceId: fakeId(7002),
    deviceName: "Caja mostrador",
    deviceActive: true,
    deviceRevoked: false,
    openedAt: "2026-10-05T15:02:00Z",
    openedByName: "Ana",
    closedAt: null,
    closedByName: null,
    opening: 100_000,
    cash: {
      count: 18,
      amount: 425_000,
      tips: 31_000,
      refunds: 9_000,
      lateCount: 0,
      lateAmount: 0,
      lateTips: 0,
    },
    external: {
      count: 23,
      amount: 612_000,
      tips: 64_000,
      refunds: 0,
      lateCount: 0,
      lateAmount: 0,
      lateTips: 0,
    },
    paidOuts: { count: 1, amount: 50_000 },
    payIns: 0,
    stored: {
      expected: null,
      counted: null,
      reason: null,
      countMode: null,
      externalExpected: null,
      externalReported: null,
    },
    review: null,
    zPrints: 0,
    ...p,
  };
}
const closedFacts = (p: Partial<DrawerFacts> = {}) =>
  facts({
    closedAt: "2026-10-06T05:30:00Z",
    closedByName: "Luis",
    cash: {
      count: 19,
      amount: 430_000,
      tips: 31_500,
      refunds: 9_000,
      lateCount: 1,
      lateAmount: 5_000,
      lateTips: 500,
    },
    // An offline terminal sale synced after the close (LD-7): $60.00 + $3.00 tip.
    external: {
      count: 24,
      amount: 618_000,
      tips: 64_300,
      refunds: 0,
      lateCount: 1,
      lateAmount: 6_000,
      lateTips: 300,
    },
    stored: {
      expected: 497_000,
      counted: 495_000,
      reason: " Faltó cambio ",
      countMode: "blind",
      externalExpected: 676_000,
      externalReported: 676_500,
    },
    ...p,
  });
const print: {
  restaurant: typeof restaurant;
  printedAt: string;
  printedByName: string;
  controls: CorteControls;
  folios: { series: string; first: number; last: number; count: number }[];
} = {
  restaurant,
  printedAt: "2026-10-05T21:40:00Z",
  printedByName: "Luis",
  controls: {
    discounts: { count: 2, amount: 12_000 },
    refunds: { count: 1, amount: 9_000 },
    paidOuts: { count: 1, amount: 50_000 },
  },
  folios: [{ series: "A", first: 101, last: 141, count: 41 }],
};

describe("corte documents (FIT-10)", () => {
  it("builds the §2.6.1 corte X sample: expected cash, terminal net and controls", () => {
    const doc = buildCorteDocument(facts(), { ...print, visibility: "full" });
    expect(doc.kind).toBe("x");
    expect(doc.zNumber).toBeNull();
    expect(doc.printNumber).toBeNull();
    expect(doc.cash).toEqual({
      opening: 100_000,
      sales: 425_000,
      tips: 31_000,
      refunds: 9_000,
      paidOuts: 50_000,
      payIns: 0,
      expected: 497_000,
      counted: null,
      difference: null,
      reason: null,
    });
    expect(doc.terminal).toEqual({
      sales: 612_000,
      count: 23,
      tips: 64_000,
      refunds: 0,
      net: 676_000,
      reported: null,
      difference: null,
    });
    expect(doc.payments).toBe(41);
    expect(doc.folios).toEqual([
      { series: "A", first: "A-000101", last: "A-000141", count: 41 },
    ]);
    expect(doc.controls).toEqual(print.controls);
    expect(doc.counted).toBeNull();
    expect(doc.lateCash).toBe(0);
    expect(doc.lateTerminal).toBe(0);
  });

  it("builds a corte Z as of close: late cash and late terminal sales excluded from sales, tips, net and payments, stored expected, signed difference and terminal batch difference", () => {
    const doc = buildCorteDocument(
      closedFacts({
        review: {
          reviewerName: "Mara",
          note: "ok",
          at: "2026-10-06T16:00:00Z",
        },
      }),
      {
        ...print,
        visibility: "full",
        printNumber: 2,
      },
    );
    expect(doc.kind).toBe("z");
    expect(doc.zNumber).toBe(128);
    expect(doc.printNumber).toBe(2);
    expect(doc.cash).toEqual({
      opening: 100_000,
      sales: 425_000,
      tips: 31_000,
      refunds: 9_000,
      paidOuts: 50_000,
      payIns: 0,
      expected: 497_000,
      counted: 495_000,
      difference: -2_000,
      reason: "Faltó cambio",
    });
    expect(differenceKind(doc.cash!.difference!)).toBe("short");
    expect(doc.counted).toBe(495_000);
    expect(doc.lateCash).toBe(5_500);
    // The terminal section is as of close too: the late $63.00 is disclosed, not added, so the
    // printed net, the reported batch total and the difference agree on one document.
    expect(doc.terminal).toEqual({
      sales: 612_000,
      count: 23,
      tips: 64_000,
      refunds: 0,
      net: 676_000,
      reported: 676_500,
      difference: 500,
    });
    expect(doc.terminal.reported! - doc.terminal.net).toBe(
      doc.terminal.difference,
    );
    expect(doc.lateTerminal).toBe(6_300);
    expect(doc.payments).toBe(18 + 23);
    // Without a stored external expected (legacy close), the difference uses the as-of-close net.
    const legacy = closedFacts();
    legacy.stored = { ...legacy.stored, externalExpected: null };
    expect(
      buildCorteDocument(legacy, { ...print, visibility: "full" }).terminal
        .difference,
    ).toBe(500);
    expect(
      drawerRow(legacy, {
        canSeeExpected: true,
        currentBusinessDate: "2026-10-06",
      }).terminalDifference,
    ).toBe(500);
    expect(doc.drawer).toMatchObject({
      closedByName: "Luis",
      countMode: "blind",
      businessDate: "2026-10-05",
    });
    expect(doc.review).toEqual({
      reviewerName: "Mara",
      note: "ok",
      at: "2026-10-06T16:00:00Z",
    });
  });

  it("FIT-10: the blind count slip carries no expected cash, cash sales, refunds, paid-outs, difference, controls, folios, late cash or review", () => {
    const doc = buildCorteDocument(
      closedFacts({
        payIns: 12_345,
        review: {
          reviewerName: "Mara",
          note: "faltaron 20",
          at: "2026-10-06T16:00:00Z",
        },
      }),
      { ...print, visibility: "blind" },
    );
    expect(doc).toMatchObject({
      kind: "z",
      visibility: "blind",
      cash: null,
      controls: null,
      folios: [],
      lateCash: 0,
      review: null,
      counted: 495_000,
      payments: 41,
      lateTerminal: 6_300,
    });
    const text = JSON.stringify(doc);
    for (const hidden of [
      "497000",
      "430000",
      "425000",
      "9000",
      "50000",
      "-2000",
      "faltaron",
      "A-000101",
      "5500",
      "12345",
    ])
      expect(text).not.toContain(hidden);
    // Every operator sees the terminal figures (discounts §2.7).
    expect(doc.terminal.net).toBe(676_000);
    // There is no blind corte X.
    expect(() =>
      buildCorteDocument(facts(), { ...print, visibility: "blind" }),
    ).toThrow("blind_corte_x");
  });

  it("property: corte and drawer row figures agree, and the cash section adds up to expected", () => {
    const random = rng(1010);
    for (let n = 0; n < 1000; n++) {
      const amount = random.int(0, 900_000);
      const lateAmount = random.next() < 0.2 ? random.int(0, amount) : 0;
      const tips = random.int(0, 50_000);
      const lateTips = lateAmount ? random.int(0, tips) : 0;
      const closed = random.next() < 0.5;
      const cashCount = random.int(0, 80);
      const lateCashCount = closed && lateAmount ? random.int(1, 3) : 0;
      const extAmount = random.int(0, 900_000);
      const extTips = random.int(0, 50_000);
      const extLate =
        closed && random.next() < 0.3 ? random.int(0, extAmount) : 0;
      const extLateTips = extLate ? random.int(0, extTips) : 0;
      const extCount = random.int(0, 80);
      const extLateCount = extLate ? random.int(1, 3) : 0;
      const f = facts({
        opening: random.int(0, 300_000),
        cash: {
          count: cashCount + lateCashCount,
          amount,
          tips,
          refunds: random.int(0, amount),
          lateCount: lateCashCount,
          lateAmount: closed ? lateAmount : 0,
          lateTips: closed ? lateTips : 0,
        },
        external: {
          count: extCount + extLateCount,
          amount: extAmount,
          tips: extTips,
          refunds: random.int(0, 50_000),
          lateCount: extLateCount,
          lateAmount: extLate,
          lateTips: extLateTips,
        },
        paidOuts: { count: 1, amount: random.int(0, 100_000) },
        payIns: random.next() < 0.3 ? random.int(1, 50_000) : 0,
      });
      const live = liveExpectedCash(f);
      const asOfClose = live - lateAmount - lateTips;
      const extNetAsOfClose =
        f.external.amount +
        f.external.tips -
        f.external.refunds -
        extLate -
        extLateTips;
      const counted = random.int(0, 1_000_000);
      const g: DrawerFacts = closed
        ? {
            ...f,
            closedAt: "2026-10-06T05:30:00Z",
            closedByName: "Luis",
            stored: {
              expected: asOfClose,
              counted,
              reason: "",
              countMode: random.pick(["blind", "visible"] as const),
              externalExpected: random.next() < 0.8 ? extNetAsOfClose : null,
              externalReported:
                random.next() < 0.5 ? random.int(0, 1_000_000) : null,
            },
          }
        : f;
      const doc = buildCorteDocument(g, { ...print, visibility: "full" });
      const row = drawerRow(g, {
        canSeeExpected: true,
        currentBusinessDate: "2026-10-05",
      });
      const c = doc.cash!;
      expect(
        c.opening + c.sales + c.tips - c.refunds - c.paidOuts + c.payIns,
      ).toBe(c.expected);
      expect(c.payIns).toBe(f.payIns);
      expect(row.payIns).toBe(f.payIns);
      // The row's components add up to its expected cash too (late cash is in the row's figures but
      // not in the stored as-of-close expected).
      expect(
        row.opening +
          row.cashSales +
          row.cashTips -
          row.cashRefunds -
          row.paidOuts +
          row.payIns -
          row.lateCash,
      ).toBe(row.expected);
      expect(c.expected).toBe(closed ? asOfClose : live);
      expect(row.expected).toBe(c.expected);
      expect(row.difference).toBe(closed ? counted - asOfClose : null);
      expect(c.difference).toBe(row.difference);
      expect(c.reason).toBeNull();
      // The terminal section is as of close; the row discloses the late part separately.
      expect(doc.terminal.net).toBe(row.terminalNet - row.lateTerminal);
      expect(doc.terminal.net).toBe(closed ? extNetAsOfClose : row.terminalNet);
      expect(doc.terminal.net).toBe(
        doc.terminal.sales + doc.terminal.tips - doc.terminal.refunds,
      );
      expect(doc.terminal.count).toBe(extCount);
      expect(doc.terminal.difference).toBe(row.terminalDifference);
      const reported = g.stored.externalReported;
      expect(doc.terminal.difference).toBe(
        closed && reported !== null ? reported - extNetAsOfClose : null,
      );
      expect(doc.lateCash).toBe(row.lateCash);
      expect(doc.lateTerminal).toBe(row.lateTerminal);
      expect(row.lateTerminal).toBe(closed ? extLate + extLateTips : 0);
      expect(doc.payments).toBe(cashCount + extCount);
      expect(row.payments).toBe(
        cashCount + lateCashCount + extCount + extLateCount,
      );
      expect(row.cashSales - (closed ? lateAmount : 0)).toBe(c.sales);
      if (closed) {
        const blind = buildCorteDocument(g, { ...print, visibility: "blind" });
        expect(blind.counted).toBe(counted);
        expect(blind.cash).toBeNull();
        expect(blind.terminal).toEqual(doc.terminal);
        expect(blind.lateTerminal).toBe(doc.lateTerminal);
        expect(blind.payments).toBe(doc.payments);
      }
    }
  });

  it("drawer rows: expected hidden from viewers who may not see it during the shift, orphan and earlier-day flags, review state", () => {
    const today = { canSeeExpected: true, currentBusinessDate: "2026-10-05" };
    const open = drawerRow(facts(), today);
    expect(open).toMatchObject({
      status: "open",
      expected: 497_000,
      orphan: false,
      openSinceEarlierDay: false,
      zNumber: null,
      lateCash: 0,
      lateTerminal: 0,
    });
    expect(
      drawerRow(facts(), { ...today, canSeeExpected: false }).expected,
    ).toBeNull();
    expect(drawerRow(facts({ deviceRevoked: true }), today).orphan).toBe(true);
    expect(drawerRow(facts({ deviceActive: false }), today).orphan).toBe(true);
    const earlier = drawerRow(facts(), {
      ...today,
      currentBusinessDate: "2026-10-06",
    });
    expect(earlier).toMatchObject({ orphan: true, openSinceEarlierDay: true });
    const closed = drawerRow(closedFacts(), {
      ...today,
      canSeeExpected: false,
    });
    // Closed drawers always show stored figures to managers, who review differences.
    expect(closed).toMatchObject({
      status: "closed",
      expected: 497_000,
      counted: 495_000,
      difference: -2_000,
      needsReview: true,
      orphan: false,
      zNumber: 128,
      lateCash: 5_500,
      lateTerminal: 6_300,
      terminalSales: 618_000,
      terminalNet: 682_300,
      payments: 43,
      terminalDifference: 500,
    });
    expect(
      drawerRow(
        closedFacts({
          review: {
            reviewerName: "Mara",
            note: "",
            at: "2026-10-06T16:00:00Z",
          },
        }),
        today,
      ).needsReview,
    ).toBe(false);
    expect(
      drawerRow(
        closedFacts({ stored: { ...closedFacts().stored, counted: 497_000 } }),
        today,
      ).needsReview,
    ).toBe(false);
  });

  it("drawerSummary splits differences into shortage and overage amounts and counts unreviewed and earlier-day drawers", () => {
    const ctx = { canSeeExpected: true, currentBusinessDate: "2026-10-06" };
    const review = {
      reviewerName: "Mara",
      note: "sobró cambio",
      at: "2026-10-06T16:00:00Z",
    };
    const rows = [
      drawerRow(closedFacts(), ctx), // −2,000, unreviewed
      drawerRow(
        closedFacts({ stored: { ...closedFacts().stored, counted: 497_700 } }),
        ctx,
      ), // +700, unreviewed
      drawerRow(
        closedFacts({ stored: { ...closedFacts().stored, counted: 497_000 } }),
        ctx,
      ), // exact
      // +300, reviewed: in the difference amounts, not in "diferencias sin revisar".
      drawerRow(
        closedFacts({
          stored: { ...closedFacts().stored, counted: 497_300 },
          review,
        }),
        ctx,
      ),
      drawerRow(facts(), ctx), // open since the 5th
      drawerRow(facts({ businessDate: "2026-10-06" }), ctx),
    ];
    expect(rows[3]).toMatchObject({ difference: 300, needsReview: false });
    expect(drawerSummary(rows)).toEqual({
      open: 2,
      closed: 4,
      differenceNet: -1_000,
      shortages: 2_000,
      overages: 1_000,
      unreviewed: 2,
      openFromEarlierDays: 1,
    });
    expect(differenceKind(700)).toBe("over");
    expect(differenceKind(0)).toBe("exact");
  });

  it("a past range's Cajas card leaves out drawers opened after the range (drawerList also returns every open drawer)", () => {
    const ctx = { canSeeExpected: true, currentBusinessDate: "2026-10-12" };
    const rows = [
      drawerRow(closedFacts(), ctx), // opened on the 5th, closed
      drawerRow(facts({ businessDate: "2026-10-04" }), ctx), // still open since the 4th
      drawerRow(facts({ businessDate: "2026-10-12" }), ctx), // opened today, after the range
    ];
    expect(drawersUpTo(rows, "2026-10-05").map((r) => r.businessDate)).toEqual([
      "2026-10-05",
      "2026-10-04",
    ]);
    expect(() => drawersUpTo(rows, "2026-10-5")).toThrow("invalid_date");
    const day = (date: string) =>
      composeSalesSummary({
        range: { from: date, to: date },
        currency: "MXN",
        generatedAt: "2026-10-12T18:00:00Z",
        currentBusinessDate: "2026-10-12",
        sales: [],
        lines: [],
        collections: [],
        refunds: [],
        restocks: [],
        paidOuts: [],
        drawers: rows,
        fiscal: null,
      }).drawers;
    expect(day("2026-10-05")).toEqual({
      open: 1,
      closed: 1,
      differenceNet: -2_000,
      shortages: 2_000,
      overages: 0,
      unreviewed: 1,
      openFromEarlierDays: 1,
    });
    // Today's report still counts today's drawer.
    expect(day("2026-10-12").open).toBe(2);
  });

  it("formats folio runs per series with fiscal's formatFolio", () => {
    expect(
      folioRanges([
        { series: "B", first: 7, last: 9, count: 3 },
        { series: "", first: 1, last: 1_234_567, count: 1_234_567 },
        { series: "A", first: 101, last: 196, count: 96 },
      ]),
    ).toEqual([
      { series: "", first: "000001", last: "1234567", count: 1_234_567 },
      { series: "A", first: "A-000101", last: "A-000196", count: 96 },
      { series: "B", first: "B-000007", last: "B-000009", count: 3 },
    ]);
  });
});

describe("corte access (§4.7, D7)", () => {
  const own = fakeId(7002);
  const other = fakeId(7099);
  const now = "2026-10-06T12:00:00Z";
  const open = { deviceId: own, closedAt: null, latestOnDevice: true };
  const closedAt = (minutesAgo: number, latestOnDevice = true) => ({
    deviceId: own,
    closedAt: Temporal.Instant.from(now)
      .subtract({ minutes: minutesAgo })
      .toString(),
    latestOnDevice,
  });
  const access = (
    role: string,
    drawer: {
      deviceId: string;
      closedAt: string | null;
      latestOnDevice: boolean;
    },
    canSeeExpected: boolean,
    deviceId = own,
  ) => corteAccess({ role, deviceId, canSeeExpected, drawer, now });
  const err = (fn: () => unknown) => domainError(fn).code;

  it("kitchen and unknown roles are forbidden", () => {
    for (const role of ["kitchen", "", "admin"]) {
      expect(err(() => access(role, open, true))).toBe("forbidden");
      expect(err(() => access(role, closedAt(60), true))).toBe("forbidden");
    }
    expect(domainError(() => access("kitchen", open, true)).status).toBe(403);
  });

  it("owners and managers: corte X only when expected cash is visible; every corte Z in full", () => {
    expect(access("owner", open, false)).toEqual({
      kind: "x",
      visibility: "full",
    });
    expect(access("manager", open, true)).toEqual({
      kind: "x",
      visibility: "full",
    });
    expect(err(() => access("manager", open, false))).toBe(
      "reports_corte_hidden",
    );
    expect(
      access(
        "manager",
        {
          deviceId: other,
          closedAt: "2026-01-01T00:00:00Z",
          latestOnDevice: false,
        },
        false,
      ),
    ).toEqual({
      kind: "z",
      visibility: "full",
    });
    // Any closed drawer, not only the device's last one.
    for (const role of ["owner", "manager"])
      expect(access(role, closedAt(60, false), false)).toEqual({
        kind: "z",
        visibility: "full",
      });
  });

  it("cashiers and servers: own device only; corte X needs expected cash; corte Z within 12 h, blind unless they may see expected", () => {
    for (const role of ["cashier", "server"]) {
      expect(access(role, open, true)).toEqual({
        kind: "x",
        visibility: "full",
      });
      expect(err(() => access(role, open, false))).toBe("reports_corte_hidden");
      expect(err(() => access(role, open, true, other))).toBe("forbidden");
      expect(err(() => access(role, open, false, other))).toBe("forbidden");
      expect(access(role, closedAt(60), false)).toEqual({
        kind: "z",
        visibility: "blind",
      });
      expect(access(role, closedAt(60), true)).toEqual({
        kind: "z",
        visibility: "full",
      });
      expect(access(role, closedAt(720), false)).toEqual({
        kind: "z",
        visibility: "blind",
      });
      expect(err(() => access(role, closedAt(721), false))).toBe("forbidden");
      expect(err(() => access(role, closedAt(60), false, other))).toBe(
        "forbidden",
      );
    }
  });

  it("§2.12: cashiers and servers print only the corte Z of their device's last drawer, so the next shift on a shared device cannot print the previous shift's count slip", () => {
    for (const role of ["cashier", "server"]) {
      // Shift A closed 60 min ago; shift B has since opened a drawer on the same device.
      expect(err(() => access(role, closedAt(60, false), false))).toBe(
        "forbidden",
      );
      expect(err(() => access(role, closedAt(60, false), true))).toBe(
        "forbidden",
      );
      expect(
        domainError(() => access(role, closedAt(60, false), true)).status,
      ).toBe(403);
      // The last drawer itself stays printable within the 12 h window.
      expect(access(role, closedAt(60, true), false)).toEqual({
        kind: "z",
        visibility: "blind",
      });
    }
  });

  it("RPT-R11: the blind count slip is its own printed document, numbered apart from the full corte Z", () => {
    // A blind cashier closes and prints the slip; the manager then prints the official Z. They
    // land in different report_prints sequences, so the manager's first Z is print 1.
    const cashierSlip = access("cashier", closedAt(5), false);
    const managerZ = access("manager", closedAt(5), false);
    expect(cortePrintKind(cashierSlip)).toBe("count_slip");
    expect(cortePrintKind(managerZ)).toBe("corte_z");
    // A cashier allowed to see expected cash prints the full Z itself: the same document as the
    // manager's, so the manager's print after it is a reprint.
    expect(cortePrintKind(access("cashier", closedAt(5), true))).toBe(
      "corte_z",
    );
    expect(cortePrintKind(access("manager", open, true))).toBe("corte_x");
    expect(cortePrintKind({ kind: "x", visibility: "full" })).toBe("corte_x");
  });
});

describe("corte del día", () => {
  const date = "2026-10-05";
  const summary = composeSalesSummary({
    range: { from: date, to: date },
    currency: "MXN",
    generatedAt: "2026-10-06T06:12:00Z",
    currentBusinessDate: "2026-10-06",
    sales: [],
    lines: [],
    collections: [
      {
        date,
        method: "cash",
        count: 3,
        amount: 30_000,
        tips: 0,
        lateCount: 0,
        lateAmount: 0,
      },
      {
        date,
        method: "external",
        count: 2,
        amount: 20_000,
        tips: 0,
        lateCount: 0,
        lateAmount: 0,
      },
    ],
    refunds: [],
    restocks: [],
    paidOuts: [],
    drawers: [],
    fiscal: null,
  });
  const ctx = { canSeeExpected: true, currentBusinessDate: "2026-10-06" };
  const sameDay = drawerRow(
    facts({
      cash: { ...facts().cash, amount: 25_000 },
      external: { ...facts().external, amount: 20_000 },
    }),
    ctx,
  );
  const earlier = drawerRow(
    facts({
      businessDate: "2026-10-04",
      cash: { ...facts().cash, amount: 999 },
    }),
    ctx,
  );

  it("a past day's corte leaves out drawers opened after that day: no open-drawer warning, no row, no effect on other-day collections", () => {
    // Printed on the 12th for the 5th: the drawer of the 5th is closed; today's drawer is open.
    const later = { canSeeExpected: true, currentBusinessDate: "2026-10-12" };
    const closedFifth = drawerRow(
      closedFacts({
        cash: { ...closedFacts().cash, amount: 25_000, lateAmount: 0 },
        external: { ...closedFacts().external, amount: 20_000, lateAmount: 0 },
      }),
      later,
    );
    const today = drawerRow(
      facts({
        id: fakeId(7003),
        businessDate: "2026-10-12",
        cash: { ...facts().cash, amount: 7_777 },
      }),
      later,
    );
    const doc = buildDayCorteDocument({
      date,
      restaurant,
      printedAt: "2026-10-12T18:00:00Z",
      printedByName: "Luis",
      summary,
      drawers: [closedFifth, today],
      exceptions: [],
    });
    expect(doc.drawers.map((d) => d.id)).toEqual([closedFifth.id]);
    expect(doc.drawersOpen).toBe(0);
    expect(doc.otherDayDrawerCollections).toBe(5_000);
    // A drawer opened before the date and still open stays: the day's corte can still change.
    const stillOpen = drawerRow(
      facts({ id: fakeId(7004), businessDate: "2026-10-04" }),
      later,
    );
    const withOpen = buildDayCorteDocument({
      date,
      restaurant,
      printedAt: "2026-10-12T18:00:00Z",
      printedByName: "Luis",
      summary,
      drawers: [closedFifth, stillOpen, today],
      exceptions: [],
    });
    expect(withOpen.drawers.map((d) => d.id)).toEqual([
      closedFifth.id,
      stillOpen.id,
    ]);
    expect(withOpen.drawersOpen).toBe(1);
  });

  it("otherDayDrawerCollections is the day's collections minus the sales of drawers opened that day", () => {
    expect(otherDayDrawerCollections(50_000, [sameDay, earlier], date)).toBe(
      5_000,
    );
    expect(otherDayDrawerCollections(45_000, [sameDay], date)).toBe(0);
  });

  it("builds the document: open drawers, exception totals in catalog order, empty cfdi slot", () => {
    const doc = buildDayCorteDocument({
      date,
      restaurant,
      printedAt: "2026-10-06T06:12:00Z",
      printedByName: "Luis",
      summary,
      drawers: [sameDay, earlier],
      exceptions: [
        { kind: "refund", count: 1, amount: 9_000 },
        { kind: "void", count: 5, amount: 64_000 },
        { kind: "paid_out", count: 0, amount: 0 },
      ],
    });
    expect(doc).toMatchObject({
      date,
      printNumber: null,
      drawersOpen: 2,
      otherDayDrawerCollections: 5_000,
      extra: {},
    });
    expect(doc.exceptions.map((e) => e.kind)).toEqual(["void", "refund"]);
    expect(() =>
      buildDayCorteDocument({
        date: "2026-10-06",
        restaurant,
        printedAt: "x",
        printedByName: "Luis",
        summary,
        drawers: [],
        exceptions: [],
      }),
    ).toThrow("day_corte_range");
  });
});

// ---------------------------------------------------------------------------------------------
// CSV (D10)
// ---------------------------------------------------------------------------------------------

describe("CSV export (FIT-7, D10)", () => {
  type Row = {
    product: string;
    units: number;
    total: number;
    share: number;
    date: string;
    at: string | null;
  };
  const columns: CsvColumn<Row>[] = [
    {
      header: { es: "Producto", en: "Item" },
      type: "t",
      value: (r) => r.product,
    },
    {
      header: { es: "Unidades", en: "Units" },
      type: "i",
      value: (r) => r.units,
    },
    {
      header: { es: "Ventas (IVA incl.)", en: "Sales (VAT incl.)" },
      type: "m",
      value: (r) => r.total,
    },
    {
      header: { es: "% de ventas", en: "% of sales" },
      type: "p",
      value: (r) => r.share,
    },
    { header: { es: "Fecha", en: "Date" }, type: "d", value: (r) => r.date },
    { header: "Fecha y hora", type: "dt", value: (r) => r.at },
  ];
  const ctx = {
    locale: "es" as const,
    currency: "MXN",
    timezone: "America/Mexico_City",
  };
  const rows: Row[] = [
    {
      product: "Taco, pastor",
      units: 3,
      total: 123_450,
      share: 1235,
      date: "2026-10-05",
      at: "2026-10-05 15:40:12.123456+00",
    },
    {
      product: 'Agua "fresca"',
      units: 1,
      total: -2_000,
      share: 0,
      date: "2026-10-05",
      at: null,
    },
    {
      product: "Línea 1\nLínea 2",
      units: 0,
      total: 0,
      share: 10_000,
      date: "2026-10-05",
      at: "2026-10-06T05:59:59Z",
    },
  ];

  it("11. FIT-7: toCsv writes a BOM, CRLF line ends, UI-language headers, quotes fields with comma, quote or newline and doubles quotes", () => {
    const csv = toCsv(columns, rows, ctx);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv).toBe(
      CSV_BOM +
        "Producto,Unidades,Ventas (IVA incl.),% de ventas,Fecha,Fecha y hora\r\n" +
        '"Taco, pastor",3,1234.50,12.4,2026-10-05,2026-10-05 09:40\r\n' +
        '"Agua ""fresca""",1,-20.00,0.0,2026-10-05,\r\n' +
        '"Línea 1\nLínea 2",0,0.00,100.0,2026-10-05,2026-10-05 23:59\r\n',
    );
    // Every record ends in CRLF; the only bare LF is inside the quoted field.
    expect(csv.split("\r\n")).toHaveLength(5);
    expect(toCsv(columns, [], { ...ctx, locale: "en" })).toBe(
      CSV_BOM + "Item,Units,Sales (VAT incl.),% of sales,Date,Fecha y hora\r\n",
    );
  });

  it("12. csvCell formula guard prefixes text starting with = + - @ TAB CR LF or full-width ＝＋－＠ with an apostrophe and leaves money like -20.00 numeric", () => {
    for (const text of [
      "=SUM(A1:A9)",
      "+52 55",
      "-20.00",
      "@cmd",
      "\tx",
      "\rx",
      "\nx",
      "＝1+1",
      "＋1",
      "－1",
      "＠x",
    ])
      expect(csvCell(text, "t")).toBe(
        '"' + "'" + text.replace(/"/g, '""') + '"',
      );
    expect(csvCell('=HYPERLINK("http://x","y")', "t")).toBe(
      '"\'=HYPERLINK(""http://x"",""y"")"',
    );
    expect(csvCell("-20.00", "m")).toBe("-20.00");
    expect(csvCell("-5", "i")).toBe("-5");
    expect(csvCell("12.3", "p")).toBe("12.3");
    expect(csvCell("2026-10-05", "d")).toBe("2026-10-05");
    expect(csvCell("2026-10-05 09:40", "dt")).toBe("2026-10-05 09:40");
    // A mistyped numeric cell is never written raw: it falls back to guarded text.
    expect(csvCell("=1+1", "m")).toBe('"\'=1+1"');
    expect(csvCell("-1+1", "i")).toBe('"\'-1+1"');
    expect(csvCell("1,5", "m")).toBe('"1,5"');
    expect(csvCell("Taquería El Güero", "t")).toBe("Taquería El Güero");
    expect(csvCell("a=b", "t")).toBe("a=b");
    expect(csvCell(null, "t")).toBe("");
    expect(csvCell(undefined, "m")).toBe("");
    expect(csvCell("", "t")).toBe("");
    // A raw number in a money or percent column is minor units or basis points: csvCell refuses it
    // rather than write 2000 for MXN 20.00 (toCsv formats numbers first).
    expect(() => csvCell(2_000, "m")).toThrow("csv_unformatted");
    expect(() => csvCell(-2_000, "m")).toThrow(TypeError);
    expect(() => csvCell(1_235, "p")).toThrow("csv_unformatted");
    expect(() => csvCell(0, "m")).toThrow("csv_unformatted");
    expect(csvCell(moneyCsv(2_000, "MXN"), "m")).toBe("20.00");
    expect(csvCell(percentCsv(1_235), "p")).toBe("12.4");
    expect(csvCell(41, "i")).toBe("41");
    // Through toCsv a negative amount is a number, a negative-looking name is guarded text.
    expect(
      toCsv(
        [
          {
            header: "a",
            type: "t",
            value: (r: { n: string; m: number }) => r.n,
          },
          {
            header: "b",
            type: "m",
            value: (r: { n: string; m: number }) => r.m,
          },
        ],
        [{ n: "-Ana", m: -2_000 }],
        ctx,
      ),
    ).toBe(CSV_BOM + 'a,b\r\n"\'-Ana",-20.00\r\n');
    // Headers are text too.
    expect(toCsv([{ header: "=x", type: "t", value: () => "" }], [], ctx)).toBe(
      CSV_BOM + '"\'=x"\r\n',
    );
  });

  it("13. moneyCsv uses dot decimals with the currency exponent (MXN 2, JPY 0)", () => {
    expect(moneyCsv(123_450, "MXN")).toBe("1234.50");
    expect(moneyCsv(-2_000, "MXN")).toBe("-20.00");
    expect(moneyCsv(5, "MXN")).toBe("0.05");
    expect(moneyCsv(-5, "MXN")).toBe("-0.05");
    expect(moneyCsv(0, "MXN")).toBe("0.00");
    expect(moneyCsv(100_000_000, "MXN")).toBe("1000000.00");
    expect(moneyCsv(1_234, "JPY")).toBe("1234");
    expect(moneyCsv(-5, "JPY")).toBe("-5");
    expect(moneyCsv(1_234, "KWD")).toBe("1.234");
    expect(moneyCsv(12, "USD")).toBe("0.12");
    expect(() => moneyCsv(1.5, "MXN")).toThrow(RangeError);
    expect(() => moneyCsv(100, "NOPE")).toThrow(RangeError);
  });

  it("percent, date-time and file-name helpers", () => {
    expect(percentCsv(1234)).toBe("12.3");
    expect(percentCsv(1235)).toBe("12.4");
    expect(percentCsv(10_000)).toBe("100.0");
    expect(percentCsv(4)).toBe("0.0");
    expect(percentCsv(5)).toBe("0.1");
    expect(percentCsv(-1235)).toBe("-12.4");
    expect(percentCsv(-4)).toBe("0.0");
    // Tijuana observes DST in 2026: 15:40Z is 08:40 PDT in October and 07:40 PST in December.
    expect(dateTimeCsv("2026-10-05 15:40:00+00", "America/Tijuana")).toBe(
      "2026-10-05 08:40",
    );
    expect(dateTimeCsv("2026-12-05T15:40:00Z", "America/Tijuana")).toBe(
      "2026-12-05 07:40",
    );
    expect(
      csvFileName("ventas_por_producto", {
        from: "2026-10-05",
        to: "2026-10-05",
      }),
    ).toBe("ventas_por_producto_2026-10-05.csv");
    expect(
      csvFileName("payments", { from: "2026-10-01", to: "2026-10-05" }),
    ).toBe("payments_2026-10-01_2026-10-05.csv");
  });
});

// ---------------------------------------------------------------------------------------------
// Fiscal figures over long ranges (§4.5 fiscalForRange, unit test 6)
// ---------------------------------------------------------------------------------------------

describe("fiscal summaries over chunks", () => {
  const cat = (
    category: CategoryTotals["category"],
    gross: number,
    tax: number,
    discount = 0,
  ): CategoryTotals => ({
    category,
    rateBps:
      category === "iva16"
        ? 1600
        : category === "iva8"
          ? 800
          : category === "iva0"
            ? 0
            : null,
    grossBeforeDiscount: gross + discount,
    discount,
    gross,
    base: gross - tax,
    tax,
  });
  const minus = (a: CategoryTotals[], b: CategoryTotals[]) =>
    a.map((x) => {
      const y = b.find((r) => r.category === x.category);
      return y
        ? {
            ...x,
            grossBeforeDiscount: x.grossBeforeDiscount - y.grossBeforeDiscount,
            discount: x.discount - y.discount,
            gross: x.gross - y.gross,
            base: x.base - y.base,
            tax: x.tax - y.tax,
          }
        : x;
    });
  function summary(
    from: string,
    to: string,
    sales: CategoryTotals[],
    refunds: CategoryTotals[],
    series: FiscalSummary["tickets"]["series"],
    missingTickets = 0,
  ): FiscalSummary {
    const sum = (rows: CategoryTotals[], k: "gross" | "base" | "tax") =>
      rows.reduce((a, r) => a + r[k], 0);
    const net = minus(sales, refunds);
    return {
      from,
      to,
      tickets: { count: series.reduce((a, s) => a + s.count, 0), series },
      sales,
      refunds,
      net,
      totals: {
        gross: sum(sales, "gross"),
        base: sum(sales, "base"),
        tax: sum(sales, "tax"),
        tips: 1_000,
        refundGross: sum(refunds, "gross"),
        refundTax: sum(refunds, "tax"),
        netGross: sum(sales, "gross") - sum(refunds, "gross"),
        netBase: sum(sales, "base") - sum(refunds, "base"),
        netTax: sum(sales, "tax") - sum(refunds, "tax"),
      },
      missingTickets,
    };
  }

  it("6. mergeFiscalSummaries sums categories and keeps fiscal's contiguous folio runs: a run split at a chunk boundary joins, a gap stays a gap (REPORTS-SQL-1)", () => {
    const range = { from: "2026-08-01", to: "2026-09-29" };
    const chunks = rangeChunks(range);
    expect(chunks).toEqual([
      { from: "2026-08-01", to: "2026-08-31" },
      { from: "2026-09-01", to: "2026-09-29" },
    ]);
    const a = summary(
      "2026-08-01",
      "2026-08-31",
      [cat("iva16", 116_000, 16_000, 2_000), cat("iva0", 5_000, 0)],
      [cat("iva16", 11_600, 1_600)],
      [
        // A late offline sync put folio A-000260 (issued in September) into August.
        { series: "A", first: 101, last: 187, count: 87 },
        { series: "A", first: 260, last: 260, count: 1 },
        { series: "B", first: 1, last: 4, count: 4 },
      ],
      2,
    );
    const b = summary(
      "2026-09-01",
      "2026-09-29",
      [
        cat("iva16", 58_000, 8_000),
        cat("iva8", 10_800, 800),
        cat("exempt", 900, 0),
      ],
      [cat("iva8", 1_080, 80)],
      [{ series: "A", first: 188, last: 250, count: 63 }],
      1,
    );
    const m = mergeFiscalSummaries([a, b]);
    expect(m.from).toBe("2026-08-01");
    expect(m.to).toBe("2026-09-29");
    // Fiscal order iva16, iva8, iva0, exempt, whatever order the chunks list them.
    expect(m.sales.map((c) => c.category)).toEqual([
      "iva16",
      "iva8",
      "iva0",
      "exempt",
    ]);
    expect(m.sales[0]).toEqual({
      category: "iva16",
      rateBps: 1600,
      grossBeforeDiscount: 176_000,
      discount: 2_000,
      gross: 174_000,
      base: 150_000,
      tax: 24_000,
    });
    expect(m.refunds.map((c) => [c.category, c.gross, c.tax])).toEqual([
      ["iva16", 11_600, 1_600],
      ["iva8", 1_080, 80],
    ]);
    expect(m.net.find((c) => c.category === "iva16")).toMatchObject({
      gross: 174_000 - 11_600,
      tax: 24_000 - 1_600,
    });
    // 188..250 continues 101..187 across the chunk boundary; 251..259 belong to other dates.
    expect(m.tickets).toEqual({
      count: 87 + 1 + 4 + 63,
      series: [
        { series: "A", first: 101, last: 250, count: 150 },
        { series: "A", first: 260, last: 260, count: 1 },
        { series: "B", first: 1, last: 4, count: 4 },
      ],
    });
    // One chunk with two runs of a series keeps both: never one min..max range.
    expect(mergeFiscalSummaries([a]).tickets.series).toEqual(a.tickets.series);
    expect(m.missingTickets).toBe(3);
    expect(m.totals).toEqual({
      gross: a.totals.gross + b.totals.gross,
      base: a.totals.base + b.totals.base,
      tax: a.totals.tax + b.totals.tax,
      tips: 2_000,
      refundGross: 12_680,
      refundTax: 1_680,
      netGross: a.totals.netGross + b.totals.netGross,
      netBase: a.totals.netBase + b.totals.netBase,
      netTax: a.totals.netTax + b.totals.netTax,
    });
    // Net per category equals sales minus refunds after the merge too.
    for (const n of m.net) {
      const sale = m.sales.find((c) => c.category === n.category)!;
      const refund = m.refunds.find((c) => c.category === n.category);
      expect(n.gross).toBe(sale.gross - (refund?.gross ?? 0));
      expect(n.tax).toBe(sale.tax - (refund?.tax ?? 0));
    }
    // One chunk merges to itself.
    expect(mergeFiscalSummaries([a])).toEqual(a);
  });

  it("rangeChunks covers any range with consecutive chunks of at most 31 days", () => {
    const random = rng(61);
    for (let k = 0; k < 300; k++) {
      const from = addDays("2026-01-01", random.int(0, 900));
      const to = addDays(from, random.int(0, 200));
      const chunks = rangeChunks({ from, to });
      expect(chunks[0].from).toBe(from);
      expect(chunks[chunks.length - 1].to).toBe(to);
      for (let i = 0; i < chunks.length; i++) {
        expect(rangeLength(chunks[i])).toBeLessThanOrEqual(FISCAL_CHUNK_DAYS);
        if (i > 0) expect(chunks[i].from).toBe(addDays(chunks[i - 1].to, 1));
      }
      expect(chunks.reduce((a, c) => a + rangeLength(c), 0)).toBe(
        rangeLength({ from, to }),
      );
    }
    expect(rangeChunks({ from: "2026-10-05", to: "2026-10-05" })).toEqual([
      { from: "2026-10-05", to: "2026-10-05" },
    ]);
    expect(() =>
      rangeChunks({ from: "2026-10-05", to: "2026-10-05" }, 0),
    ).toThrow("invalid_chunk_days");
  });

  it("mergeFiscalSummaries refuses an empty list, gaps or overlaps between chunks and conflicting rates", () => {
    const a = summary(
      "2026-08-01",
      "2026-08-31",
      [cat("iva16", 1_160, 160)],
      [],
      [],
    );
    const gap = summary("2026-09-02", "2026-09-10", [], [], []);
    const overlap = summary("2026-08-31", "2026-09-10", [], [], []);
    expect(() => mergeFiscalSummaries([])).toThrow("no_fiscal_parts");
    expect(() => mergeFiscalSummaries([a, gap])).toThrow(
      "fiscal_parts_not_consecutive",
    );
    expect(() => mergeFiscalSummaries([a, overlap])).toThrow(
      "fiscal_parts_not_consecutive",
    );
    const odd = summary(
      "2026-09-01",
      "2026-09-02",
      [{ ...cat("iva16", 1_160, 160), rateBps: 800 }],
      [],
      [],
    );
    expect(() => mergeFiscalSummaries([a, odd])).toThrow(
      "fiscal_rate_mismatch",
    );
  });

  it("the summary carries fiscal's figures as tax and takes the margin from them; totals given twice must agree", () => {
    const tax = summary(
      "2026-10-05",
      "2026-10-05",
      [cat("iva16", 11_600, 1_600)],
      [cat("iva16", 1_160, 160)],
      [{ series: "A", first: 1, last: 1, count: 1 }],
    );
    const base: SummaryInput = {
      range: { from: "2026-10-05", to: "2026-10-05" },
      currency: "MXN",
      generatedAt: "2026-10-05T20:00:00.000Z",
      currentBusinessDate: "2026-10-05",
      sales: [],
      lines: [],
      collections: [],
      refunds: [],
      restocks: [],
      paidOuts: [],
      drawers: [],
      tax,
    };
    const s = composeSalesSummary(base);
    expect(s.tax).toEqual(tax);
    expect(s.margin.netSalesExTax).toBe(10_000);
    expect(s.margin.salesAfterRefunds).toBe(10_440);
    expect(s.margin.netAfterRefundsExTax).toBe(9_000);
    expect(s.checks.map((c) => c.code)).toContain("tickets_vs_orders");
    expect(
      composeSalesSummary({ ...base, fiscal: fiscalTotals(tax) }).tax,
    ).toEqual(tax);
    expect(() =>
      composeSalesSummary({
        ...base,
        fiscal: { ...fiscalTotals(tax), gross: 1 },
      }),
    ).toThrow("fiscal_totals_mismatch");
    expect(() => composeSalesSummary({ ...base, fiscal: null })).toThrow(
      "fiscal_totals_mismatch",
    );
    const none = composeSalesSummary({ ...base, tax: null });
    expect(none.tax).toBeNull();
    expect(none.margin.estimatedMargin).toBeNull();
    expect(none.checks.map((c) => c.code)).not.toContain("refunds_vs_fiscal");
  });
});

describe("approvals (LD-16 L3)", () => {
  it("a self-approved row keeps the approver's name but is not counted as an approval given", () => {
    const mara = fakeId(9201);
    const ana = fakeId(9202);
    const row = (p: Partial<ExceptionRow>): ExceptionRow => ({
      id: fakeId(9210 + Math.floor(Math.random() * 1000)),
      kind: "void",
      at: "2026-10-05 15:00:00+00",
      businessDate: "2026-10-05",
      actorId: null,
      actorName: null,
      approverId: null,
      approverName: null,
      accountId: null,
      accountName: null,
      amount: 4_500,
      orderId: null,
      orderNumber: null,
      orderDate: null,
      reasonCode: null,
      note: "",
      deviceName: null,
      detail: {},
      ...p,
    });
    const self = row({
      actorId: mara,
      actorName: "Marisol Vega",
      approverId: mara,
      approverName: "Marisol Vega",
    });
    const crossed = row({
      kind: "refund",
      amount: 9_000,
      actorId: ana,
      actorName: "Ana",
      approverId: mara,
      approverName: "Marisol Vega",
    });
    expect(self.approverName).toBe("Marisol Vega");
    const s = exceptionSummary([self, crossed]);
    const m = s.byEmployee.find((e) => e.employeeId === mara)!;
    expect(m.acted).toEqual({ void: { count: 1, amount: 4_500 } });
    expect(m.approved).toEqual({ count: 1, amount: 9_000 });
  });
});
