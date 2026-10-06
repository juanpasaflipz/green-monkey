import postgres from "postgres";

/** The demo organization the fixture seed creates (scripts/demo-fixtures.ts). */
const DEMO_ORGANIZATION = "10000000-0000-4000-8000-000000000000";
const DEFAULT_CUTOFF = 240;
const SHIFTED_CUTOFF = 600;
const MARGIN_MINUTES = 180;

/**
 * Keeps the demo restaurants' business day from rolling over during a run.
 * Order numbers restart each business day, so a suite that crosses the 04:00
 * cutoff sees two open "#10" orders and its locators become ambiguous (CI run
 * 37445309932 started at 03:54 Mexico City time). When the next rollover is
 * less than three hours away, the cutoff moves to 10:00 for this run: the
 * current business date stays the same and the rollover is at least six hours
 * away. Rollover behaviour itself is covered by DB tests with explicit times.
 * Only the isolated local fixture database is touched (as the specs' own
 * fixture guards require); any other target is left alone.
 */
export default async function globalSetup() {
  const runtime = new URL(process.env.DATABASE_URL ?? "http://invalid"),
    migration = new URL(process.env.MIGRATION_DATABASE_URL ?? "http://invalid"),
    base = new URL(process.env.TEST_BASE_URL ?? "http://127.0.0.1:5173");
  if (
    !["localhost", "127.0.0.1"].includes(runtime.hostname) ||
    runtime.hostname !== migration.hostname ||
    runtime.port !== migration.port ||
    runtime.pathname !== migration.pathname ||
    !/^\/green_monkey(_[a-z]+)?_dev$/.test(runtime.pathname) ||
    !["localhost", "127.0.0.1"].includes(base.hostname)
  )
    return;
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1 });
  try {
    const restaurants = await sql<{ id: string; timezone: string }[]>`
      select id, timezone from restaurants
      where organization_id = ${DEMO_ORGANIZATION} and cutoff = ${DEFAULT_CUTOFF}`;
    for (const { id, timezone } of restaurants) {
      const [hour, minute] = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .format(new Date())
        .split(":")
        .map(Number);
      const local = hour * 60 + minute;
      const untilRollover = (DEFAULT_CUTOFF - local + 1440) % 1440;
      if (untilRollover >= MARGIN_MINUTES) continue;
      await sql.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${id}, true)`;
        await tx`update restaurants set cutoff = ${SHIFTED_CUTOFF} where id = ${id}`;
      });
    }
  } finally {
    await sql.end();
  }
}
