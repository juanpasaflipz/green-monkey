// Reports (029): corte X / Z documents with their access rules (spec §4.7, §2.12), corte print
// records with consecutive reprint numbers per document (corte X, corte Z, blind count slip,
// corte del día), the corte del día, and the remote close of an orphaned drawer (§2.11). Lock
// order (docs/ARCHITECTURE.md row 28): the print's numbering transaction takes LO-1 (once) →
// LO-2 (restaurants FOR SHARE in once) → LO-3 (the report-print advisory key); the remote close
// takes LO-1 → LO-2 → LO-11 (the drawer row FOR UPDATE, then discounts' closeDrawerRow).
//
// A printed document is read in one REPEATABLE READ snapshot (snapshotTenant) before its print is
// numbered in a separate READ COMMITTED transaction (review REPORTS-CORTES-2): every figure on
// the paper comes from one instant, while max + 1 after the report-print key still sees every
// committed print. The remote close commits only the close; the corte Z it answers with is read
// afterwards (REPORTS-CORTES-5).
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { tenant, type Tx } from "../db.js";
import { permit, managers, operators } from "../auth.js";
import { audit, once } from "../orders.js";
import { requireRecentAuth } from "../access.js";
import { closeDrawerRow } from "../cash.js";
import { DomainError, type Session } from "../../shared/domain.js";
import {
  aggregateInt,
  buildCorteDocument,
  buildDayCorteDocument,
  corteAccess,
  cortePrintInput,
  cortePrintKind,
  currentBusinessDate,
  dayCortePrintInput,
  drawerFingerprint,
  remoteCloseInput,
  type CorteControls,
  type CorteDocument,
  type DayCorteDocument,
  type ReportPrintKind,
} from "../../shared/reports.js";
import { heavyStatementTimeout, snapshotTenant } from "./snapshot.js";
import { loadDrawers, type LoadedDrawer } from "./drawers.js";
import { exceptionDayTotals } from "./exceptions.js";
import { fiscalCurrency, type ReportsPorts } from "./ports.js";
import { restaurantOf, type ReportRestaurant } from "./restaurant.js";
import { summaryWithDrawers } from "./summary.js";
import { cfdiCoverage } from "../cfdi/hooks.js";

type Row = Record<string, unknown>;
const n = aggregateInt;

/** The advisory key that serializes the prints of one document (LO-3, spec §4.9). */
export function reportPrintKey(
  tenantId: string,
  kind: ReportPrintKind,
  subject: string,
) {
  return tenantId + ":report-print:" + kind + ":" + subject;
}

/**
 * The report-print key's hashtextextended class. A non-zero class makes it an LO-3 area key
 * (docs/ARCHITECTURE.md "Global lock order"; tests/lock-scan.ts reads class 0 as an LO-1
 * operation key), taken after once()'s LO-2 restaurants FOR SHARE. Classes 920–929 belong to
 * other areas (cfdi's per-ticket key is 926), so reports uses 930 (review REPORTS-CONTRACTS-5,
 * LD-31); the SQL below repeats it as a literal, which the lock scanner reads.
 */
export const REPORT_PRINT_CLASS = 930;

/** Takes the report-print key of one document (LO-3) for the rest of the transaction. */
export async function lockReportPrint(
  tx: Tx,
  tenantId: string,
  kind: ReportPrintKind,
  subject: string,
) {
  await tx`select pg_advisory_xact_lock(hashtextextended(${reportPrintKey(tenantId, kind, subject)}, 930))`;
}

/**
 * A drawer id as Postgres prints a uuid (lowercase): the print subject, its advisory key and
 * the audit entity match `cash_sessions.id::text` whatever case the request used (029's
 * subject CHECK accepts lowercase only).
 */
const canonicalId = (drawerId: string) => drawerId.toLowerCase();

/**
 * Discounts, refunds and paid-outs recorded on the drawer's device between its open and close.
 * A discount counts when it was active at the end of the window: one reversed after the close
 * stays on that drawer's corte Z, so a reprint matches the signed original (REPORTS-CORTES-3).
 */
async function corteControls(tx: Tx, d: LoadedDrawer): Promise<CorteControls> {
  const until = d.closedAt;
  const [c] = await tx<Row[]>`
    with w as (select ${d.openedAt}::timestamptz as since, coalesce(${until}::timestamptz, now()) as until)
    select
      (select count(*)::int from discounts x, w
        where x.device_id = ${d.deviceId} and (x.reversed_at is null or x.reversed_at > w.until)
          and x.created_at >= w.since and x.created_at <= w.until) as discount_count,
      (select coalesce(sum(x.amount), 0)::int8 from discounts x, w
        where x.device_id = ${d.deviceId} and (x.reversed_at is null or x.reversed_at > w.until)
          and x.created_at >= w.since and x.created_at <= w.until) as discount_amount,
      (select count(*)::int from refund_batches b, w
        where b.device_id = ${d.deviceId} and b.created_at >= w.since and b.created_at <= w.until)
      + (select count(*)::int from refunds r where r.session_id = ${d.id} and r.batch_id is null) as refund_count,
      (select coalesce(sum(b.amount), 0)::int8 from refund_batches b, w
        where b.device_id = ${d.deviceId} and b.created_at >= w.since and b.created_at <= w.until)
      + (select coalesce(sum(r.amount), 0)::int8 from refunds r where r.session_id = ${d.id} and r.batch_id is null)
        as refund_amount`;
  return {
    discounts: { count: n(c.discount_count), amount: n(c.discount_amount) },
    refunds: { count: n(c.refund_count), amount: n(c.refund_amount) },
    paidOuts: { count: d.paidOuts.count, amount: d.paidOuts.amount },
  };
}
/**
 * The contiguous folio runs of the fiscal tickets issued on the drawer's device while it was
 * open (027), by issue time only: a ticket's business date is its order's, so a check paid days
 * later, a repair ticket or a late offline sync issued here still counts on this drawer
 * (REPORTS-CORTES-4). Runs are computed as fiscal's summary computes them (gaps and islands,
 * REPORTS-CONTRACTS-1): folios that other devices issued in between are gaps, never part of a
 * range. Index fiscal_tickets_device_issued (029).
 */
async function corteFolios(
  tx: Tx,
  d: LoadedDrawer,
  restaurant: ReportRestaurant,
) {
  if (!fiscalCurrency(restaurant.currency)) return [];
  const rows = await tx<Row[]>`
    select series, min(number)::int8 as first, max(number)::int8 as last, count(*)::int as count
      from (select series, number,
                   number - row_number() over (partition by series order by number) as run
              from fiscal_tickets
             where device_id = ${d.deviceId}
               and issued_at >= ${d.openedAt}::timestamptz
               and issued_at <= coalesce(${d.closedAt}::timestamptz, now())) r
     group by series, run order by series, first`;
  return rows.map((r) => ({
    series: String(r.series),
    first: n(r.first),
    last: n(r.last),
    count: n(r.count),
  }));
}

/**
 * GET /api/reports/drawers/:id/corte: the corte X of an open drawer or the corte Z of a closed
 * one, as the viewer may see it (§4.7 with the §2.12 last-drawer rule, LD-15 Q6). The blind
 * variant is built without the hidden fields; the server never sends them.
 */
export async function drawerCorte(
  tx: Tx,
  s: Session,
  drawerId: string,
  ports: Pick<ReportsPorts, "moneyControls" | "canSeeExpected">,
  restaurant?: ReportRestaurant,
): Promise<CorteDocument> {
  permit(s, operators);
  const settings = restaurant ?? (await restaurantOf(tx, s));
  const [[d], controls] = await Promise.all([
    loadDrawers(tx, s, settings, { id: canonicalId(drawerId) }),
    ports.moneyControls(tx),
  ]);
  if (!d) throw new DomainError("not_found", 404);
  const now = new Date().toISOString();
  const access = corteAccess({
    role: s.role,
    deviceId: s.deviceId,
    canSeeExpected: ports.canSeeExpected(s.role, controls),
    drawer: {
      deviceId: d.deviceId,
      closedAt: d.closedAt,
      latestOnDevice: d.latestOnDevice,
    },
    now,
  });
  const full = access.visibility === "full";
  const [corteFigures, folios] = full
    ? await Promise.all([corteControls(tx, d), corteFolios(tx, d, settings)])
    : [
        {
          discounts: { count: 0, amount: 0 },
          refunds: { count: 0, amount: 0 },
          paidOuts: { count: 0, amount: 0 },
        },
        [],
      ];
  return buildCorteDocument(d, {
    visibility: access.visibility,
    restaurant: {
      name: settings.name,
      currency: settings.currency,
      timezone: settings.timezone,
    },
    printedAt: now,
    printedByName: s.name,
    controls: corteFigures,
    folios,
    // PAYMENTS-SECURITY-3: fees and commissions for owners and managers only.
    fees: full && managers.includes(s.role),
  });
}

/**
 * once()'s body for a drawer corte print: the document and the viewer it was built for. once()
 * fingerprints the body, so a replay by another employee, role or device is operation_conflict.
 */
export function corteOperationBody(
  s: Pick<Session, "employeeId" | "role" | "deviceId">,
  drawerId: string,
  kind: "x" | "z",
) {
  return {
    drawerId,
    kind,
    viewer: { employeeId: s.employeeId, role: s.role, deviceId: s.deviceId },
  };
}

/**
 * The document a print records, read in the caller's REPEATABLE READ snapshot, or null when
 * this operation id was already recorded: a replay then gets its stored document from once()
 * (or operation_conflict for another viewer) without reading the drawer again.
 */
async function unlessRecorded<T>(
  tx: Tx,
  operationId: string,
  build: () => Promise<T>,
): Promise<T | null> {
  const [done] = await tx<
    Row[]
  >`select 1 from operations where id = ${operationId}`;
  return done ? null : build();
}

/**
 * POST /api/reports/drawers/:id/corte: records a corte X, corte Z or count slip print and returns
 * the authoritative document with its print number (> 1 is a reprint). The document is read in
 * one REPEATABLE READ snapshot, then numbered in a READ COMMITTED transaction (REPORTS-CORTES-2).
 * Each document has its own sequence (cortePrintKind): a blind role's count slip and the full
 * corte Z of the same drawer are numbered apart, so the manager's first Z is print 1 and only
 * full Z reprints are audited as reports.corte_z.reprinted (the corte_reprint exception). Two
 * prints of one document with different operation ids are serialized on that document's
 * report-print key before numbering, so they get consecutive numbers (DB test 34); the same
 * viewer replaying an operation id gets the same document, any other viewer gets
 * operation_conflict (corteOperationBody).
 */
export async function printDrawerCorte(
  sql: postgres.Sql,
  s: Session,
  drawerId: string,
  raw: unknown,
  ports: Pick<ReportsPorts, "moneyControls" | "canSeeExpected">,
): Promise<CorteDocument> {
  // Kitchen never reaches a stored document. The per-drawer access rules run in drawerCorte on
  // the first print only; a replay returns the stored document without them. The operation body
  // therefore names the viewer (employee, role, device: everything corteAccess reads from the
  // session), so another viewer presenting the same operation id gets operation_conflict
  // instead of a document built for someone else.
  permit(s, operators);
  const p = cortePrintInput.parse(raw);
  const subject = canonicalId(drawerId);
  const snapshot = await snapshotTenant(sql, s.tenantId, (tx) =>
    unlessRecorded(tx, p.operationId, () => drawerCorte(tx, s, subject, ports)),
  );
  return tenant(sql, s.tenantId, (tx) =>
    once(
      tx,
      s,
      p.operationId,
      "reports.corte",
      corteOperationBody(s, subject, p.kind),
      async () => {
        // The snapshot is null only for an operation id recorded before it, which once() replays
        // without running this body; should that record be gone, the document is read here.
        const doc = snapshot ?? (await drawerCorte(tx, s, subject, ports));
        if (doc.kind !== p.kind)
          throw new DomainError("reports_corte_state", 409);
        const kind = cortePrintKind(doc);
        await lockReportPrint(tx, s.tenantId, kind, subject);
        const printNumber = await recordPrint(tx, s, kind, subject);
        const detail = { printNumber, zNumber: doc.zNumber };
        if (kind === "corte_x")
          await audit(tx, s, "reports.corte_x.printed", subject, detail);
        else if (kind === "count_slip")
          await audit(tx, s, "reports.count_slip.printed", subject, detail);
        else if (printNumber > 1)
          await audit(tx, s, "reports.corte_z.reprinted", subject, detail);
        else await audit(tx, s, "reports.corte_z.printed", subject, detail);
        return { ...doc, printNumber };
      },
    ),
  );
}

/** max + 1 after the report-print key, as its own statement, then the print row. */
async function recordPrint(
  tx: Tx,
  s: Session,
  kind: ReportPrintKind,
  subject: string,
): Promise<number> {
  const [last] = await tx<Row[]>`
    select coalesce(max(print_number), 0)::int + 1 as n
      from report_prints where kind = ${kind} and subject = ${subject}`;
  const printNumber = n(last.n);
  await tx`insert into report_prints(tenant_id, id, kind, subject, print_number, actor_id, device_id)
    values (${s.tenantId}, ${randomUUID()}, ${kind}, ${subject}, ${printNumber}, ${s.employeeId}, ${s.deviceId})`;
  return printNumber;
}

/**
 * GET /api/reports/days/:date/corte: one business date's summary (the same rows as Resumen),
 * its drawers and the exception totals.
 */
export async function dayCorte(
  tx: Tx,
  s: Session,
  date: string,
  requestId: string,
  ports: ReportsPorts,
): Promise<DayCorteDocument> {
  permit(s, managers);
  const restaurant = await restaurantOf(tx, s);
  const range = { from: date, to: date };
  const [{ summary, drawers }, exceptions] = await Promise.all([
    summaryWithDrawers(tx, s, range, requestId, ports),
    exceptionDayTotals(tx, s, range, restaurant),
  ]);
  const extra: Record<string, unknown> = {};
  // cfdi (030): the day's CFDI coverage (absent while CFDI is off).
  const cfdi = await cfdiCoverage(tx, range);
  if (cfdi) extra.cfdi = cfdi;
  return buildDayCorteDocument({
    date,
    restaurant: {
      name: restaurant.name,
      currency: restaurant.currency,
      timezone: restaurant.timezone,
    },
    printedAt: new Date().toISOString(),
    printedByName: s.name,
    summary,
    drawers,
    exceptions,
    extra,
  });
}

/**
 * POST /api/reports/days/:date/corte: records a corte del día print (consecutive per date). The
 * document comes from one REPEATABLE READ snapshot, the number from the READ COMMITTED
 * transaction that holds the report-print key (REPORTS-CORTES-2).
 */
export async function printDayCorte(
  sql: postgres.Sql,
  s: Session,
  date: string,
  raw: unknown,
  ports: ReportsPorts,
  requestId = "",
): Promise<DayCorteDocument> {
  permit(s, managers); // before once(), as in printDrawerCorte
  const p = dayCortePrintInput.parse(raw);
  const snapshot = await snapshotTenant(sql, s.tenantId, (tx) =>
    unlessRecorded(tx, p.operationId, () =>
      dayCorte(tx, s, date, requestId, ports),
    ),
  );
  return tenant(sql, s.tenantId, (tx) =>
    once(tx, s, p.operationId, "reports.day_corte", { date }, async () => {
      const doc = snapshot ?? (await dayCorte(tx, s, date, requestId, ports));
      await lockReportPrint(tx, s.tenantId, "day_corte", date);
      const printNumber = await recordPrint(tx, s, "day_corte", date);
      await audit(tx, s, "reports.day_corte.printed", date, { printNumber });
      return { ...doc, printNumber };
    }),
  );
}

/**
 * Minutes during which a device counts as in use after its last contact or its drawer's last
 * tender: a remote close of its drawer is refused then (REPORTS-CORTES-1), and the drawer is
 * closed on its device, where the pending-sync guard runs.
 */
export const DRAWER_IN_USE_MINUTES = 10;

/**
 * The remote close inside its own tenant() transaction: lock the drawer row (LO-11), check that
 * it is orphaned, that its device is not in use and that its money is what the manager's dialog
 * showed (the fingerprint of the corte X it last read: REPORTS-CORTES-1), then discounts'
 * closeDrawerRow. Returns only the drawer id: the corte Z is read after the commit
 * (REPORTS-CORTES-5), so the closed_at → commit window stays as short as the close itself.
 */
export async function remoteCloseDrawer(
  tx: Tx,
  s: Session,
  rawDrawerId: string,
  raw: unknown,
): Promise<{ drawerId: string }> {
  permit(s, managers);
  requireRecentAuth(s);
  const p = remoteCloseInput.parse(raw);
  const drawerId = canonicalId(rawDrawerId);
  await heavyStatementTimeout(tx);
  return once(
    tx,
    s,
    p.operationId,
    "reports.drawer_close",
    { drawerId, ...p },
    async () => {
      const [d] = await tx<Row[]>`
        select c.id, c.device_id, c.closed_at, business_date_at(c.tenant_id, c.opened_at)::text as day,
          dv.active, dv.revoked_at,
          (dv.last_seen_at > now() - make_interval(mins => ${DRAWER_IN_USE_MINUTES})
            or exists (select 1 from tenders t
                        where t.tenant_id = c.tenant_id and t.session_id = c.id
                          and t.created_at > now() - make_interval(mins => ${DRAWER_IN_USE_MINUTES})))
            as in_use
          from cash_sessions c join devices dv on dv.tenant_id = c.tenant_id and dv.id = c.device_id
         where c.id = ${drawerId} for update of c`;
      if (!d) throw new DomainError("not_found", 404);
      if (d.closed_at !== null)
        throw new DomainError("reports_drawer_closed", 409);
      // once() verified the session's settings against the restaurants row it holds FOR SHARE.
      const gone = d.active !== true || d.revoked_at !== null;
      const orphan = gone || String(d.day) < currentBusinessDate(s.restaurant);
      if (!orphan) throw new DomainError("reports_drawer_not_orphaned", 409);
      // A drawer from an earlier day whose device is still selling or in contact is closed there.
      if (!gone && d.in_use === true)
        throw new DomainError("reports_drawer_in_use", 409);
      const restaurant = await restaurantOf(tx, s);
      const [facts] = await loadDrawers(tx, s, restaurant, { id: drawerId });
      if (!facts || drawerFingerprint(facts) !== p.fingerprint)
        throw new DomainError("reports_drawer_changed", 409);
      await closeDrawerRow(
        tx,
        s,
        { id: drawerId },
        {
          counted: p.counted,
          reason: p.reason,
          externalReported: p.externalReported ?? null,
        },
        "visible",
        { remote: true, deviceId: String(d.device_id) },
      );
      return { drawerId };
    },
  );
}

/**
 * POST /api/reports/drawers/:id/close: a manager, with step-up, closes a drawer that its own
 * device can no longer close (revoked or inactive device, or open from an earlier business day
 * on a device that is not in use), with a visible count and a reason, through discounts'
 * closeDrawerRow; audited as cash.close with remote: true. Answers with the corte Z, read in a
 * snapshot after the close commits.
 */
export async function closeDrawerRemotely(
  sql: postgres.Sql,
  s: Session,
  rawDrawerId: string,
  raw: unknown,
  ports: Pick<ReportsPorts, "moneyControls" | "canSeeExpected">,
): Promise<CorteDocument> {
  const { drawerId } = await tenant(sql, s.tenantId, (tx) =>
    remoteCloseDrawer(tx, s, rawDrawerId, raw),
  );
  return snapshotTenant(sql, s.tenantId, (tx) =>
    drawerCorte(tx, s, drawerId, ports),
  );
}
