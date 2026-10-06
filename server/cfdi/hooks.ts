/**
 * cfdi's cross-area contracts (spec §6.1). Web only.
 *   fiscal (027):  enqueueCfdiRefund, called from recordRefundTax step 9 (only when adjustment rows
 *                  were inserted). No-op when CFDI is not enabled; never throws for a missing
 *                  setting; takes no locks (LO-R8).
 *   ops:           cfdiCapability for GET /api/capabilities.
 *   reports (029): cfdiAlerts + cfdiReportAlerts for Today, cfdiCoverage for the day corte.
 * Imports only cfdi's jobs and store modules and the db types, so fiscal → cfdi has no cycle.
 */
import type { CfdiAlertsView, CfdiCoverage } from "../../shared/cfdi.js";
import type { ReportAlert } from "../../shared/reports.js";
import type { Session } from "../../shared/domain.js";
import type { Tx } from "../db.js";
import { cfdiEnqueue, dedupe } from "./jobs.js";
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
