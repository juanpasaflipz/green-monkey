import postgres from "postgres";
import { MEXICO_CITY } from "../fixtures/business-date-zones.js";

/** The demo organization the fixture seed creates (scripts/demo-fixtures.ts). */
const DEMO_ORGANIZATION = "10000000-0000-4000-8000-000000000000";
/** The seed's zone (the restaurants table's defaults): Mexico City, business day from 04:00. */
const DEFAULT_TIMEZONE = MEXICO_CITY.timezone;
const DEFAULT_CUTOFF = MEXICO_CITY.cutoff;
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
 *
 * Every demo restaurant starts the run in the seed's zone (CFDIFIX-R3-3):
 * America/Mexico_City, with the 04:00 cutoff (10:00 near the rollover, as
 * above). A run killed while tests/browser/cfdi.spec.ts had pinned the demo
 * restaurant's business date elsewhere (Pacific/Kiritimati at 00:00, or a
 * cutoff an hour later), or while business-day.spec had moved its cutoff,
 * never reached the spec's finally or afterEach; without this, later local
 * runs would keep that zone.
 *
 * It also delivers the kitchen rounds earlier runs left open on the demo
 * restaurants and decides the kitchen reviews of offline sales they left
 * pending (W3-2), so a reused fixture starts each run with an empty KDS and
 * review lane, as a fresh one does (tests/browser/kitchen-hygiene.ts cleans
 * up after each test; this catches anything left behind by an interrupted
 * run or a test that failed before its cleanup).
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
    !/^\/green_monkey(_[a-z][a-z0-9]*)?_dev$/.test(runtime.pathname) ||
    !["localhost", "127.0.0.1"].includes(base.hostname)
  )
    return;
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1 });
  try {
    const [hour, minute] = new Intl.DateTimeFormat("en-GB", {
      timeZone: DEFAULT_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .format(new Date())
      .split(":")
      .map(Number);
    const local = hour * 60 + minute;
    const untilRollover = (DEFAULT_CUTOFF - local + 1440) % 1440;
    const cutoff =
      untilRollover < MARGIN_MINUTES ? SHIFTED_CUTOFF : DEFAULT_CUTOFF;
    const restaurants = await sql<
      { id: string; timezone: string; cutoff: number }[]
    >`
      select id, timezone, cutoff from restaurants
      where organization_id = ${DEMO_ORGANIZATION}`;
    for (const r of restaurants) {
      if (r.timezone === DEFAULT_TIMEZONE && r.cutoff === cutoff) continue;
      // The business-day settings trigger (029) records the old zone in the restaurant's tenant.
      await sql.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${r.id}, true)`;
        await tx`update restaurants set timezone = ${DEFAULT_TIMEZONE}, cutoff = ${cutoff}
          where id = ${r.id}`;
      });
    }
    const demo = await sql<{ id: string }[]>`
      select id from restaurants where organization_id = ${DEMO_ORGANIZATION}`;
    for (const { id } of demo)
      await sql.begin((tx) => deliverOpenRounds(tx, id));
  } finally {
    await sql.end();
  }
}

/**
 * Fixture reset, not a business command (no audit row): what the kitchen
 * would do for every open round of one restaurant. Kitchen reviews of
 * offline sales still pending are decided "already served" by the
 * restaurant's owner (as decideOfflineKitchen records that decision), pending
 * cancellations of those rounds and of every open one are acknowledged by the
 * owner (the single acknowledgement the void and refund triggers allow), every
 * such round is delivered, and an order whose rounds are all delivered reads
 * completed, as refreshOrderState sets it.
 *
 * Every statement names the restaurant itself (FLK-R2): global setup connects
 * with the migration role, which bypasses row-level security, so app.tenant_id
 * alone would reach every restaurant in the database. Exported for the DB
 * check in tests/service-db.ts.
 */
export async function deliverOpenRounds(
  tx: postgres.TransactionSql,
  tenantId: string,
) {
  await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
  const [owner] = await tx<{ id: string }[]>`
    select id from employees
    where tenant_id = ${tenantId} and role = 'owner' order by id limit 1`;
  if (!owner) return;
  // FLK-R8: offline sales the kitchen never reviewed would otherwise stay in
  // the review lane run after run.
  const reviewed = (
    await tx<{ round_id: string }[]>`
      update offline_kitchen_reviews
        set state = 'already_served', decided_by = ${owner.id}, decided_at = now()
      where tenant_id = ${tenantId} and state = 'pending'
      returning round_id`
  ).map((r) => r.round_id);
  const open = tx`r.tenant_id = ${tenantId} and (
    (r.state <> 'completed' and r.state <> 'offline_review')
    or (r.state = 'offline_review' and r.id = any(${tx.array(reviewed)}::uuid[])))`;
  for (const table of ["line_voids", "refund_lines"] as const)
    await tx`update ${tx(table)} v
      set kitchen_acknowledged_at = now(), kitchen_acknowledged_by = ${owner.id}
      from order_lines l, rounds r
      where v.tenant_id = ${tenantId}
        and l.tenant_id = v.tenant_id and l.id = v.line_id
        and r.tenant_id = v.tenant_id and r.order_id = v.order_id
        and r.number = l.round and r.station = l.data->>'station' and ${open}
        and v.kitchen_ack_required and v.kitchen_acknowledged_at is null`;
  const delivered = await tx<{ order_id: string }[]>`
    update rounds r set state = 'completed', seen_at = coalesce(r.seen_at, now())
    where ${open} returning r.order_id`;
  if (!delivered.length) return;
  await tx`update orders o set state = 'completed'
    where o.tenant_id = ${tenantId}
      and o.id = any(${tx.array([...new Set(delivered.map((d) => d.order_id))])}::uuid[])
      and o.state not like 'recovery%' and o.state <> 'cancelled'
      and not exists (select 1 from rounds r
        where r.tenant_id = o.tenant_id and r.order_id = o.id and r.state <> 'completed')`;
  await tx`update kitchen_feed_versions set version = version + 1, updated_at = now()
    where tenant_id = ${tenantId}`;
}
