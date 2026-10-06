// Reports (029): corte X / Z documents with their access rules (spec §4.7, §2.12), corte print
// records with consecutive reprint numbers per document (corte X, corte Z, blind count slip,
// corte del día), the corte del día, and the remote close of an orphaned drawer (§2.11). Lock order (docs/ARCHITECTURE.md row 28): prints take LO-1 (once)
// → LO-2 (restaurants FOR SHARE in once) → LO-3 (the report-print advisory key); the remote
// close takes LO-1 → LO-2 → LO-11 (the drawer row FOR UPDATE).
import { randomUUID } from "node:crypto";
import type { Tx } from "../db.js";
import { permit, managers, operators } from "../auth.js";
import { audit, once } from "../orders.js";
import { requireRecentAuth } from "../access.js";
import { DomainError, type Session } from "../../shared/domain.js";
import {
  addDays,
  aggregateInt,
  buildCorteDocument,
  buildDayCorteDocument,
  corteAccess,
  cortePrintInput,
  cortePrintKind,
  currentBusinessDate,
  dayCortePrintInput,
  remoteCloseInput,
  wallClockBusinessDate,
  type CorteControls,
  type CorteDocument,
  type DayCorteDocument,
  type ReportPrintKind,
} from "../../shared/reports.js";
import { heavyStatementTimeout } from "./snapshot.js";
import { loadDrawers, type LoadedDrawer } from "./drawers.js";
import { exceptionDayTotals } from "./exceptions.js";
import { fiscalCurrency, type ReportsPorts } from "./ports.js";
import { restaurantOf, type ReportRestaurant } from "./restaurant.js";
import { summaryWithDrawers } from "./summary.js";

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
 * A drawer id as Postgres prints a uuid (lowercase): the print subject, its advisory key and
 * the audit entity match `cash_sessions.id::text` whatever case the request used (029's
 * subject CHECK accepts lowercase only).
 */
const canonicalId = (drawerId: string) => drawerId.toLowerCase();

/** Discounts, refunds and paid-outs recorded on the drawer's device between its open and close. */
async function corteControls(tx: Tx, d: LoadedDrawer): Promise<CorteControls> {
  const until = d.closedAt;
  const [c] = await tx<Row[]>`
    with w as (select ${d.openedAt}::timestamptz as since, coalesce(${until}::timestamptz, now()) as until)
    select
      (select count(*)::int from discounts x, w
        where x.device_id = ${d.deviceId} and x.reversed_at is null
          and x.created_at >= w.since and x.created_at <= w.until) as discount_count,
      (select coalesce(sum(x.amount), 0)::int8 from discounts x, w
        where x.device_id = ${d.deviceId} and x.reversed_at is null
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
/** Folio runs of the fiscal tickets issued on the drawer's device while it was open (027). */
async function corteFolios(
  tx: Tx,
  d: LoadedDrawer,
  restaurant: ReportRestaurant,
) {
  if (!fiscalCurrency(restaurant.currency)) return [];
  const closeDay = d.closedAt
    ? wallClockBusinessDate(d.closedAt, restaurant.timezone, restaurant.cutoff)
    : currentBusinessDate(restaurant);
  const rows = await tx<Row[]>`
    select series, min(number)::int8 as first, max(number)::int8 as last, count(*)::int as count
      from fiscal_tickets
     where device_id = ${d.deviceId}
       and business_date between ${addDays(d.businessDate, -1)}::date and ${addDays(closeDay, 1)}::date
       and issued_at >= ${d.openedAt}::timestamptz and issued_at <= coalesce(${d.closedAt}::timestamptz, now())
     group by series order by series`;
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
  });
}

/**
 * POST /api/reports/drawers/:id/corte: records a corte X, corte Z or count slip print and returns
 * the authoritative document with its print number (> 1 is a reprint). Each document has its own
 * sequence (cortePrintKind): a blind role's count slip and the full corte Z of the same drawer
 * are numbered apart, so the manager's first Z is print 1 and only full Z reprints are audited
 * as reports.corte_z.reprinted (the corte_reprint exception). Two prints of one document with
 * different operation ids are serialized on that document's report-print key before numbering,
 * so they get consecutive numbers (DB test 34); a replayed operation id returns the same
 * document.
 */
export async function printDrawerCorte(
  tx: Tx,
  s: Session,
  drawerId: string,
  raw: unknown,
  ports: Pick<ReportsPorts, "moneyControls" | "canSeeExpected">,
): Promise<CorteDocument> {
  await heavyStatementTimeout(tx);
  // Before once(): a replayed operation id never returns a document to a role that may not
  // print one (drawerCorte applies the per-drawer access rules inside).
  permit(s, operators);
  const p = cortePrintInput.parse(raw);
  const subject = canonicalId(drawerId);
  return once(
    tx,
    s,
    p.operationId,
    "reports.corte",
    { drawerId: subject, kind: p.kind },
    async () => {
      // The document (and so which sequence it numbers in) depends on the viewer's access;
      // drawerCorte only reads, so the report-print key (LO-3) is still taken before numbering.
      const doc = await drawerCorte(tx, s, subject, ports);
      if (doc.kind !== p.kind)
        throw new DomainError("reports_corte_state", 409);
      const kind = cortePrintKind(doc);
      await tx`select pg_advisory_xact_lock(hashtextextended(${reportPrintKey(s.tenantId, kind, subject)}, 0))`;
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
  // cfdi (030): extra.cfdi = await cfdiCoverage(tx, {from: date, to: date})
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

/** POST /api/reports/days/:date/corte: records a corte del día print (consecutive per date). */
export async function printDayCorte(
  tx: Tx,
  s: Session,
  date: string,
  raw: unknown,
  ports: ReportsPorts,
): Promise<DayCorteDocument> {
  await heavyStatementTimeout(tx);
  permit(s, managers); // before once(), as in printDrawerCorte
  const p = dayCortePrintInput.parse(raw);
  return once(tx, s, p.operationId, "reports.day_corte", { date }, async () => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${reportPrintKey(s.tenantId, "day_corte", date)}, 0))`;
    const doc = await dayCorte(tx, s, date, "", ports);
    const printNumber = await recordPrint(tx, s, "day_corte", date);
    await audit(tx, s, "reports.day_corte.printed", date, { printNumber });
    return { ...doc, printNumber };
  });
}

/**
 * POST /api/reports/drawers/:id/close: a manager, with step-up, closes a drawer that its own
 * device can no longer close (revoked or inactive device, or open from an earlier business day),
 * with a visible count and a reason, through discounts' closeDrawerRow; audited as cash.close
 * with remote: true. Returns the corte Z.
 */
export async function closeDrawerRemotely(
  tx: Tx,
  s: Session,
  rawDrawerId: string,
  raw: unknown,
  ports: ReportsPorts,
): Promise<CorteDocument> {
  await heavyStatementTimeout(tx);
  permit(s, managers);
  requireRecentAuth(s);
  const p = remoteCloseInput.parse(raw);
  const drawerId = canonicalId(rawDrawerId);
  return once(
    tx,
    s,
    p.operationId,
    "reports.drawer_close",
    { drawerId, ...p },
    async () => {
      const [d] = await tx<Row[]>`
        select c.id, c.device_id, c.closed_at, business_date_at(c.tenant_id, c.opened_at)::text as day,
          dv.active, dv.revoked_at
          from cash_sessions c join devices dv on dv.tenant_id = c.tenant_id and dv.id = c.device_id
         where c.id = ${drawerId} for update of c`;
      if (!d) throw new DomainError("not_found", 404);
      if (d.closed_at !== null)
        throw new DomainError("reports_drawer_closed", 409);
      // once() verified the session's settings against the restaurants row it holds FOR SHARE.
      const orphan =
        d.active !== true ||
        d.revoked_at !== null ||
        String(d.day) < currentBusinessDate(s.restaurant);
      if (!orphan) throw new DomainError("reports_drawer_not_orphaned", 409);
      await ports.closeDrawerRow(
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
      return drawerCorte(tx, s, drawerId, ports);
    },
  );
}
