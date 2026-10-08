// CFDIFIX-R2-6: checks whose rule needs the business date somewhere in a month (not its last day,
// or day 3 or later) pin it with the restaurant's timezone and cutoff instead of skipping on the
// other days. Used by tests/cfdi-db.ts and tests/browser/cfdi.spec.ts; tests/cfdi-shared.test.ts
// proves a zone is found at every moment around month boundaries.
import { boundaries, businessDate } from "../../shared/domain.js";
import { selfInvoiceDeadline } from "../../shared/cfdi.js";

export type Zone = { timezone: string; cutoff: number };

/** The demo and test restaurants' zone: Mexico City, business day from 04:00. */
export const MEXICO_CITY: Zone = {
  timezone: "America/Mexico_City",
  cutoff: 240,
};
/**
 * UTC+14 at 00:00: one business day after Mexico City at 04:00 (two at most for a later cutoff,
 * as tests/browser/global-setup.ts may set), never the same one.
 */
export const KIRITIMATI: Zone = { timezone: "Pacific/Kiritimati", cutoff: 0 };
/** UTC−12 at 23:59: one or two business days before Mexico City at 04:00. */
export const GMT_MINUS_12: Zone = { timezone: "Etc/GMT+12", cutoff: 1439 };

/** How long a pinned rule must keep holding, so a check never crosses a cutoff that breaks it. */
export const PIN_HOLD_MS = 30 * 60_000;

/**
 * The first zone whose business date satisfies `ok` now and PIN_HOLD_MS later, or null. With
 * [MEXICO_CITY, KIRITIMATI, GMT_MINUS_12] one exists at every moment for either rule below.
 */
export function zoneWhere(
  ok: (date: string, zone: Zone) => boolean,
  o: { zones?: readonly Zone[]; now?: number; holdMs?: number } = {},
): Zone | null {
  const zones = o.zones ?? [MEXICO_CITY, KIRITIMATI, GMT_MINUS_12];
  const now = o.now ?? Date.now();
  const hold = o.holdMs ?? PIN_HOLD_MS;
  const at = (ms: number, z: Zone) =>
    businessDate(new Date(ms).toISOString(), z.timezone, z.cutoff);
  return (
    zones.find((z) => ok(at(now, z), z) && ok(at(now + hold, z), z)) ?? null
  );
}

/**
 * A daily global of the date (its close + `graceMinutes`) ends its self-invoicing before the month
 * window does: any day but the month's last at Mexico City's 04:00 or Kiritimati's 00:00, up to the
 * second-to-last at Etc/GMT+12's 23:59.
 */
export const dailyEndsFirst = (date: string, z: Zone, graceMinutes = 60) =>
  Date.parse(boundaries(date, z.timezone, z.cutoff).end) +
    graceMinutes * 60_000 <
  Date.parse(selfInvoiceDeadline(date, "month", 30, z.timezone));

/**
 * The zone a browser check that needs a daily global to end first runs the demo restaurant in: its
 * own; else the same timezone with a cutoff an hour later (in the half hour before the cutoff that
 * starts a month's last day, it keeps the day before); else Kiritimati (on a month's last day, the
 * 1st or 2nd of the next). Never a date before the demo's own: activation dated CFDI's start with
 * it, and an earlier ticket would not count.
 */
export function browserZoneWhereDailyEndsFirst(
  demo: Zone,
  now = Date.now(),
  graceMinutes = 60,
): Zone | null {
  const own = businessDate(
    new Date(now).toISOString(),
    demo.timezone,
    demo.cutoff,
  );
  return zoneWhere(
    (date, z) => date >= own && dailyEndsFirst(date, z, graceMinutes),
    {
      zones: [
        demo,
        { timezone: demo.timezone, cutoff: Math.min(demo.cutoff + 60, 1439) },
        KIRITIMATI,
      ],
      now,
    },
  );
}

/** A business date with two earlier days in its month. */
export const dayThreeOrLater = (date: string) => Number(date.slice(8, 10)) >= 3;
