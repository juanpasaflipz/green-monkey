/**
 * cfdi's cross-area contracts (spec §6.1). Web only.
 *   fiscal (027):  enqueueCfdiRefund, called from recordRefundTax step 9 (only when adjustment rows
 *                  were inserted); cfdiTicketsIssued, called by issueDueTicket and the repair
 *                  before they take their ticket's folio counter (every issuance: sale, offline
 *                  recovery, repair). No-op when CFDI is not enabled; never throw for a missing
 *                  setting; take no locks; a jobs key only the calling operation can meet (LO-R8).
 *   ops:           cfdiCapability for GET /api/capabilities.
 *   reports (029): cfdiAlerts + cfdiReportAlerts for Today, cfdiCoverage for the day corte.
 * Imports only cfdi's jobs and store modules and the db types, so fiscal → cfdi has no cycle.
 */
import type { CfdiAlertsView, CfdiCoverage } from "../../shared/cfdi.js";
import type { ReportAlert } from "../../shared/reports.js";
import type { Session } from "../../shared/domain.js";
import type { Tx } from "../db.js";
import {
  cfdiEnqueue,
  dedupe,
  issuedTickPrefix,
  issuedTickRunAt,
} from "./jobs.js";
import { businessDate } from "../../shared/domain.js";
import { attention, platform } from "./store.js";

/** Fiscal's refund hook: decide on a credit note once the refund's tax rows exist. */
export async function enqueueCfdiRefund(
  tx: Tx,
  s: Pick<Session, "tenantId">,
  refundId: string,
): Promise<void> {
  const [settings] = await tx`select enabled from cfdi_settings`;
  if (!settings?.enabled) return;
  await cfdiEnqueue(tx, s.tenantId, {
    kind: "cfdi_refund",
    dedupeKey: dedupe.refund(refundId),
    payload: { refundId },
  });
}

/**
 * Fiscal's issuance hook (LD-51 F12, timing per LD-55): a ticket issued into a period that has
 * closed (an offline sale synced late, a check of last night paid this morning, a repair) goes
 * into a supplementary part of its own period (D5) by a tick's late sweep. Without this hook it
 * waits for the chain's next tick, up to 6 hours away. The hook does not start one at once: it
 * enqueues ONE tick per tenant per 30-minute bucket, due 10 minutes after the bucket ends, so an
 * offline drain (one record per request) lands in one supplementary part, not one per tick, and
 * the counter keeps a short window to invoice the ticket directly (CFDIFIX-FISCAL-4, OPS-2); RMF
 * 2.7.1.21's 24 hours stay far away.
 *
 * Late means the date's period is built or empty, or has closed (CFDIFIX-CONCURRENCY-4): a build
 * running now may have read its tickets before this one commits, so a closed period always gets
 * the tick; within the grace window that tick just finds nothing due.
 *
 * Keys and locks (CFDIFIX-CONCURRENCY-1): one read, then at most one insert. The read finds the
 * bucket's tick when one is waiting (committed), which dedupes every later issuance; otherwise the
 * insert's key carries the issuing order's id (`dedupe.tickIssued`), which the caller holds FOR
 * UPDATE, so a unique-key wait can only meet the same operation (LO-R8) and never another
 * transaction's uncommitted tick: recordSettlement's later orders run this hook after its first
 * order took the folio counter (LO-12), and a shared key there would wait under LO-12 on another
 * payment's insert. Two issuances racing in one bucket each insert their own tick, due at the
 * same moment: the first sweeps every committed late ticket, the second finds nothing. A sale of
 * today's business date costs no statement. Take no lock.
 */
export async function cfdiTicketsIssued(
  tx: Tx,
  s: Pick<Session, "tenantId" | "restaurant">,
  tickets: readonly { id: string; businessDate: string }[],
): Promise<void> {
  const now = new Date();
  const today = businessDate(
    now.toISOString(),
    s.restaurant.timezone,
    s.restaurant.cutoff,
  );
  const past = tickets.filter((t) => t.businessDate < today);
  if (!past.length) return;
  const dates = [...new Set(past.map((t) => t.businessDate))];
  const prefix = issuedTickPrefix(now);
  const [r] = await tx`
    select
      exists (select 1 from cfdi_settings s
        join cfdi_global_periods g on g.tenant_id = s.tenant_id and g.mode = s.mode
          and (g.status in ('built','empty') or g.closes_at <= now())
        join unnest(${dates}::date[]) d(day) on d.day between g.date_from and g.date_to
          and d.day >= (case when s.mode = 'live' then coalesce(s.live_from, s.test_from) else s.test_from end)
        where s.enabled) as late,
      exists (select 1 from jobs
        where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
          and kind = 'cfdi_global' and state in ('queued','available')
          and dedupe_key like ${prefix + "%"}) as waiting`;
  if (!r?.late || r.waiting) return;
  await cfdiEnqueue(tx, s.tenantId, {
    kind: "cfdi_global",
    dedupeKey: dedupe.tickIssued(now, past[0].id),
    payload: {},
    runAt: issuedTickRunAt(now),
  });
}

/** GET /api/capabilities `facturapi` (the Integraciones panel). */
export async function cfdiCapability(
  tx: Tx,
): Promise<{ enabled: boolean; reason: string }> {
  const p = await platform(tx);
  if (!p || p.provider === "disabled")
    return { enabled: false, reason: "provider_not_configured" };
  if (p.provider === "sandbox_shared")
    return { enabled: true, reason: "sandbox_shared" };
  return {
    enabled: true,
    reason: p.liveEnabled ? "live_enabled" : "test_mode",
  };
}

/** Attention counts for reports' Today (all zero / mode null when CFDI is not enabled). */
export async function cfdiAlerts(tx: Tx): Promise<CfdiAlertsView> {
  const [s] = await tx`select enabled from cfdi_settings`;
  if (!s?.enabled)
    return {
      overdueGlobals: 0,
      failedDocuments: 0,
      stuckDocuments: 0,
      rejectedSubstitutions: 0,
      csdExpiresSoon: false,
      mode: null,
    };
  return attention(tx);
}

/** The four cfdi_* Today alert codes; zero counts omitted; [] when CFDI is not enabled. */
export function cfdiReportAlerts(a: CfdiAlertsView): ReportAlert[] {
  if (!a.mode) return [];
  const out: ReportAlert[] = [];
  if (a.overdueGlobals > 0)
    out.push({ code: "cfdi_global_overdue", count: a.overdueGlobals });
  const documents = a.failedDocuments + a.stuckDocuments;
  if (documents > 0)
    out.push({ code: "cfdi_documents_attention", count: documents });
  if (a.rejectedSubstitutions > 0)
    out.push({
      code: "cfdi_substitution_rejected",
      count: a.rejectedSubstitutions,
    });
  if (a.csdExpiresSoon) out.push({ code: "cfdi_csd_expiring", count: 1 });
  return out;
}

/**
 * Coverage of a business-date range (tickets' fiscal business date, current mode, active claims):
 * invoiced individually vs in a global vs not covered yet. One statement; null when CFDI is not
 * enabled. Reports' dayCorte puts it in DayCorteDocument.extra.cfdi.
 */
export async function cfdiCoverage(
  tx: Tx,
  range: { from: string; to: string },
): Promise<CfdiCoverage | null> {
  const [s] = await tx`select enabled, mode from cfdi_settings`;
  if (!s?.enabled) return null;
  const [r] = await tx`
    with t as (
      select t.id, t.gross - coalesce((select sum(a.gross) from fiscal_adjustments a
          where a.tenant_id = t.tenant_id and a.order_id = t.order_id), 0) as net,
        (select d.kind from cfdi_document_tickets c join cfdi_documents d on d.tenant_id = c.tenant_id and d.id = c.document_id
          where c.tenant_id = t.tenant_id and c.ticket_id = t.id and c.mode = ${s.mode} and c.state = 'active'
          order by (d.kind = 'invoice') desc limit 1) as kind
      from fiscal_tickets t where t.business_date between ${range.from}::date and ${range.to}::date)
    select count(*)::int as tickets,
      count(*) filter (where kind = 'invoice')::int as invoiced,
      count(*) filter (where kind = 'global')::int as globalized,
      count(*) filter (where kind is null)::int as uncovered,
      coalesce(sum(net) filter (where kind = 'invoice'), 0)::int as invoiced_total,
      coalesce(sum(net) filter (where kind = 'global'), 0)::int as global_total
    from t`;
  return {
    mode: s.mode,
    tickets: r.tickets,
    invoiced: r.invoiced,
    globalized: r.globalized,
    uncovered: r.uncovered,
    invoicedTotal: r.invoiced_total,
    globalTotal: r.global_total,
  };
}
