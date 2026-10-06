/**
 * cfdi_reissue (spec §4.8.8; SAT cancellation FAQ Q10, Escenario 4): a nominative invoice for a
 * ticket already in a valid global. Order: cancel the global G with motive 04 → issue G' (same
 * period, Periodicidad, Meses and Año) without the tickets now invoiced → stamp the waiting
 * nominative invoices (released by G' reaching valid or failed). Several late requests against one
 * global share one cancellation and one replacement.
 */
import { randomUUID } from "node:crypto";
import type { JobContext, JobOutcome } from "../../jobs.js";
import type { Tx } from "../../db.js";
import {
  cfdiEnqueue,
  dedupe,
  enqueueStamp,
  GLOBAL_MAX_ATTEMPTS,
  INVOICE_MAX_ATTEMPTS,
  retryOrExhaust,
} from "../jobs.js";
import {
  activatePendingClaims,
  loadDocument,
  releaseClaims,
} from "../store.js";
import { lockDocument, lockPeriod } from "../locks.js";
import { classify, event, MINUTE, runtimeOr } from "./common.js";
import { cancellationOutcome, loadCancellation } from "./cancel.js";
import { documentKey, raise, tenantTag } from "./runtime.js";

type Payload = { globalDocumentId?: string };

export async function reissueJob(ctx: JobContext): Promise<JobOutcome> {
  const globalId = (ctx.job.payload as Payload | null)?.globalDocumentId;
  if (!globalId) return { status: "dead", code: "cfdi_invalid_payload" };
  const { rt, outcome } = await runtimeOr(ctx);
  if (!rt) return outcome;
  const tenantId = ctx.job.tenantId;

  const loaded = await ctx.tenant(async (tx) => {
    const g = await loadDocument(tx, globalId);
    if (!g || g.kind !== "global") return null;
    const c = await loadCancellation(tx, { documentId: globalId, open: true });
    return { g, c, key: await documentKey(rt, tx, tenantId, g.mode) };
  });
  if (!loaded) return { status: "done" };
  const { g, c, key } = loaded;

  /**
   * Waiting invoices behind G fail when the global cannot be canceled. Runs in the transaction that
   * ends the cancellation, under G's document key (the key createInvoiceRequest takes before it
   * adds a waiter), so no request can join a cancellation that is being refused (CFDI-R1).
   */
  const failWaiters = async (tx: Tx, code: string) => {
    const waiters = await tx`
      select id from cfdi_documents where depends_on = ${globalId} and status = 'waiting'`;
    for (const w of waiters) {
      await tx`update cfdi_documents set status = 'failed', error_code = ${code} where id = ${w.id}`;
      await releaseClaims(tx, w.id, "failed");
      await event(tx, ctx, w.id, "failed", { code });
    }
  };

  let canceled = g.status === "canceled";
  if (!canceled) {
    if (!c || c.motive !== "04") return { status: "done" };
    try {
      const inv =
        g.status === "canceling"
          ? await rt.client.getInvoice(key, g.providerInvoiceId!, ctx.signal)
          : await rt.client.cancelInvoice(
              key,
              g.providerInvoiceId!,
              { motive: "04" },
              ctx.signal,
            );
      const result = cancellationOutcome(inv);
      if (result === "rejected") {
        await ctx.tenant(async (tx) => {
          await lockDocument(tx, tenantId, globalId);
          await tx`update cfdi_documents set status = 'valid' where id = ${globalId} and status = 'canceling'`;
          await tx`update cfdi_cancellations set status = 'rejected', processed_at = now() where id = ${c.id}`;
          await event(tx, ctx, globalId, "cancel_rejected", { motive: "04" });
          await failWaiters(tx, "cfdi_cancel_rejected_provider");
        });
        return { status: "done" };
      }
      if (result !== "canceled") {
        await ctx.tenant(async (tx) => {
          await tx`update cfdi_documents set status = 'canceling' where id = ${globalId} and status = 'valid'`;
          await tx`update cfdi_cancellations set status = 'requested' where id = ${c.id} and status = 'queued'`;
        });
        return retryOrExhaust(ctx.job, {
          code: "cfdi_cancellation_in_progress",
          afterMs: 10 * MINUTE,
        });
      }
      canceled = true;
    } catch (e) {
      const failure = classify(e);
      if (failure.code === "cfdi_cancellation_in_progress")
        return retryOrExhaust(ctx.job, {
          code: failure.code,
          afterMs: 10 * MINUTE,
        });
      if (failure.retry || failure.unknownOutcome)
        return retryOrExhaust(ctx.job, {
          code: failure.code,
          afterMs: failure.afterMs,
        });
      await ctx.tenant(async (tx) => {
        await lockDocument(tx, tenantId, globalId);
        await tx`
          update cfdi_cancellations set status = 'failed', error_code = ${failure.code}, processed_at = now()
          where id = ${c.id} and status in ('queued','requested')`;
        await tx`update cfdi_documents set status = 'valid' where id = ${globalId} and status = 'canceling'`;
        await event(tx, ctx, globalId, "cancel_failed", {
          motive: "04",
          code: failure.code,
        });
        await failWaiters(tx, "cfdi_cancel_rejected_provider");
      });
      raise(rt, {
        key: `cfdi_reissue_failed:${tenantTag(tenantId)}:${globalId}`,
        severity: "warning",
        title: "CFDI global reissue refused",
        body: `tenant ${tenantTag(tenantId)} document ${globalId} code ${failure.code}`,
      });
      return { status: "done" };
    }
  }

  // 3. G is canceled: free its tickets, activate the waiting invoices' claims, and issue G'. Under
  // G's document key (LO-3), the key createInvoiceRequest holds while it adds a waiter: a waiter
  // committed before this transaction is collected here, and a request that comes after it sees G
  // canceled and answers cfdi_global_in_progress (CFDI-R1).
  await ctx.tenant(async (tx) => {
    await lockDocument(tx, tenantId, globalId);
    const current = await loadDocument(tx, globalId, { forUpdate: true });
    if (!current) return;
    if (current.status === "valid" || current.status === "canceling")
      await tx`update cfdi_documents set status = 'canceled' where id = ${globalId}`;
    if (c && c.status !== "accepted")
      await tx`update cfdi_cancellations set status = 'accepted', processed_at = now()
        where id = ${c.id} and status in ('queued','requested')`;
    const released = (
      await tx`
        update cfdi_document_tickets set state = 'released', released_reason = 'canceled', released_at = now()
        where document_id = ${globalId} and state = 'active' returning ticket_id`
    ).map((r) => r.ticket_id as string);
    const waiters = (
      await tx`select id from cfdi_documents where depends_on = ${globalId} and status = 'waiting'`
    ).map((r) => r.id as string);
    for (const w of waiters) await activatePendingClaims(tx, w);
    if (!released.length && !waiters.length) return;
    await event(tx, ctx, globalId, "canceled", {
      motive: "04",
      source: "reissue",
    });
    await cfdiEnqueue(tx, tenantId, {
      kind: "cfdi_deliver",
      dedupeKey: dedupe.acuse(globalId),
      payload: { documentId: globalId, acuse: true },
    });
    // G' claims G's freed tickets except those now held by the waiting invoices. Its part number
    // is taken under the period's key, after G's document key (LO-3), the key the global builder
    // numbers its parts under: a late or supplementary build of the same period never takes the
    // same part (CFDI-R2-5; the unique index cfdi_documents_period backs it).
    if (current.periodKey)
      await lockPeriod(tx, tenantId, current.mode, current.periodKey);
    const replacement = randomUUID();
    const won = await tx
      .savepoint(async (raw) => {
        const sp = raw as Tx;
        const [part] = await sp`
        select coalesce(max(part), 0) + 1 as next from cfdi_documents
        where kind = 'global' and mode = ${current.mode} and period_key = ${current.periodKey}`;
        await sp`
        insert into cfdi_documents(tenant_id, id, kind, source, mode, status, replaces_document_id,
          period_key, global_info, part)
        values (${tenantId}, ${replacement}, 'global', 'reissue', ${current.mode}, 'queued', ${globalId},
          ${current.periodKey}, ${sp.json(current.globalInfo as never)}, ${part.next})`;
        const rows = await sp`
        insert into cfdi_document_tickets(tenant_id, document_id, ticket_id, mode, state)
        select ${tenantId}, ${replacement}, t, ${current.mode}, 'active' from unnest(${released}::uuid[]) t
        on conflict (tenant_id, ticket_id, mode) where state = 'active' do nothing
        returning ticket_id`;
        if (!rows.length) throw new NoTickets();
        return rows.length;
      })
      .catch((e) => {
        if (e instanceof NoTickets) return 0;
        throw e;
      });
    if (won) {
      await tx`update cfdi_documents set depends_on = ${replacement} where depends_on = ${globalId} and status = 'waiting'`;
      await enqueueStamp(tx, tenantId, replacement, {
        maxAttempts: GLOBAL_MAX_ATTEMPTS,
      });
      await event(tx, ctx, globalId, "reissue_completed", {
        replacement,
        tickets: won,
      });
      await event(tx, ctx, replacement, "requested", {
        source: "reissue",
        replaces: globalId,
      });
    } else {
      for (const w of waiters) {
        await tx`update cfdi_documents set status = 'queued' where id = ${w} and status = 'waiting'`;
        await enqueueStamp(tx, tenantId, w, {
          maxAttempts: INVOICE_MAX_ATTEMPTS,
          suffix: ":dep",
        });
      }
      await event(tx, ctx, globalId, "reissue_completed", {
        replacement: null,
      });
    }
  });
  return { status: "done" };
}

class NoTickets extends Error {}
