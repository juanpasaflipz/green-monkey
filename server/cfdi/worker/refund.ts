/**
 * cfdi_refund (spec §4.8.7): after a refund, decide whether a credit note (CFDI de egreso, related
 * 01) is due. No covering CFDI yet: nothing now (the ticket is invoiced or globalized later at its
 * net amount). A covering document still in flight: wait with an escalating backoff (up to 6 h; 60
 * attempts is more than 10 days), then alert; the global tick's refund sweep re-enqueues it.
 * Refunds are never blocked by a CFDI (discounts D13).
 */
import { randomUUID } from "node:crypto";
import type { JobContext, JobOutcome } from "../../jobs.js";
import { enqueueStamp, INVOICE_MAX_ATTEMPTS, retryOrExhaust } from "../jobs.js";
import { loadDocument, loadSettings } from "../store.js";
import { event, HOUR, runtimeOr } from "./common.js";
import { raise, tenantTag } from "./runtime.js";

type Payload = { refundId?: string; force?: boolean };

export async function refundJob(ctx: JobContext): Promise<JobOutcome> {
  const p = (ctx.job.payload ?? {}) as Payload;
  const refundId = p.refundId;
  if (!refundId) return { status: "dead", code: "cfdi_invalid_payload" };
  const { rt, outcome } = runtimeOr(ctx);
  if (!rt) return outcome;
  const tenantId = ctx.job.tenantId;

  const decision = await ctx.tenant(async (tx) => {
    const settings = await loadSettings(tx);
    if (!settings?.enabled) return { kind: "done" as const };
    const [refund] = await tx`
      select a.order_id, t.id as ticket_id
      from fiscal_adjustments a
      join fiscal_tickets t on t.tenant_id = a.tenant_id and t.order_id = a.order_id
      where a.refund_id = ${refundId} limit 1`;
    if (!refund) return { kind: "done" as const };
    const [claim] = await tx`
      select c.document_id from cfdi_document_tickets c
      join cfdi_documents d on d.tenant_id = c.tenant_id and d.id = c.document_id
      where c.ticket_id = ${refund.ticket_id} and c.mode = ${settings.mode} and c.state = 'active'
      order by (d.kind = 'invoice') desc, c.created_at desc limit 1`;
    if (!claim) return { kind: "done" as const };
    const parent = await loadDocument(tx, claim.document_id);
    if (!parent) return { kind: "done" as const };
    if (["queued", "stamping", "pending", "waiting"].includes(parent.status))
      return { kind: "wait" as const, code: "cfdi_parent_not_valid" };
    if (parent.status === "canceling")
      return { kind: "wait" as const, code: "cfdi_parent_canceling" };
    if (parent.status !== "valid") return { kind: "done" as const };
    if (parent.nettedRefundIds.includes(refundId))
      return { kind: "done" as const };
    const [existing] = await tx`
      select id from cfdi_documents where kind = 'egreso' and refund_id = ${refundId}
        and mode = ${settings.mode} and status <> 'failed' limit 1`;
    if (existing) return { kind: "done" as const };
    const id = randomUUID();
    // The partial unique index (refund, mode) of non-failed credit notes settles a race with the
    // global tick's refund sweep.
    const [inserted] = await tx`
      insert into cfdi_documents(tenant_id, id, kind, source, mode, status, parent_document_id, refund_id,
        receptor, receptor_rfc)
      values (${tenantId}, ${id}, 'egreso', 'refund', ${settings.mode}, 'queued', ${parent.id}, ${refundId},
        ${parent.kind === "invoice" && parent.receptor ? tx.json(parent.receptor as never) : null},
        ${parent.kind === "invoice" ? parent.receptorRfc : null})
      on conflict (tenant_id, refund_id, mode) where kind = 'egreso' and status <> 'failed' do nothing
      returning id`;
    if (!inserted) return { kind: "done" as const };
    await event(tx, ctx, id, "requested", {
      source: "refund",
      parent: parent.id,
    });
    await enqueueStamp(tx, tenantId, id, { maxAttempts: INVOICE_MAX_ATTEMPTS });
    return { kind: "done" as const };
  });
  if (decision.kind === "done") return { status: "done" };
  const afterMs =
    decision.code === "cfdi_parent_canceling"
      ? 6 * HOUR
      : Math.min(120_000 * 2 ** Math.max(0, ctx.job.attempts - 1), 6 * HOUR);
  const next = retryOrExhaust(ctx.job, { code: decision.code, afterMs });
  if (next && next.status === "dead")
    raise(rt, {
      key: `cfdi_refund_unresolved:${tenantTag(tenantId)}:${refundId}`,
      severity: "warning",
      title: "CFDI credit note pending",
      body: `tenant ${tenantTag(tenantId)} refund ${refundId} code ${decision.code}`,
    });
  return next;
}
