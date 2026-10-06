/**
 * cfdi_stamp (spec §4.8.3): read → freeze (first attempt) → preconditions → adopt by external_id
 * after an unknown outcome → POST /invoices → record. The document id is Facturapi's
 * idempotency_key and external_id, so a retry can never create a second CFDI (R3, DB test 11).
 *
 * Outcomes that may have created an invoice (timeouts, network failures, 5xx, in-flight 409s,
 * unreadable 2xx) write a `stamp_unknown` event and retry; the next attempt adopts the invoice by
 * external_id. Such a document is never failed and its claims are never released; when the retry
 * limit is reached it stays `stamping`, shows as stuck, and Reintentar adopts it.
 */
import type { JobContext, JobOutcome } from "../../jobs.js";
import { DomainError } from "../../../shared/domain.js";
import { retryOrExhaust } from "../jobs.js";
import type { FInvoice } from "../facturapi.js";
import {
  fiscalFacts,
  loadDocument,
  loadOrganization,
  loadSettings,
  type DocumentRow,
} from "../store.js";
import {
  AUTH_CODES,
  classify,
  event,
  markKeyInvalid,
  MINUTE,
  runtimeOr,
} from "./common.js";
import { freezeRequest } from "./freeze.js";
import { syncLegal } from "./org.js";
import {
  failDocument,
  failDocumentTx,
  globalFailedAlert,
  recordPending,
  recordStamped,
} from "./record.js";
import { documentKey, raise, tenantTag } from "./runtime.js";

const DONE: JobOutcome = { status: "done" };
const FINAL = ["valid", "failed", "canceled", "canceling", "pending"];

export async function stampJob(ctx: JobContext): Promise<JobOutcome> {
  const documentId = (ctx.job.payload as { documentId?: string } | null)
    ?.documentId;
  if (!documentId) return { status: "dead", code: "cfdi_invalid_payload" };
  const { rt, outcome } = runtimeOr(ctx);
  if (!rt) return outcome;
  const tenantId = ctx.job.tenantId;

  // 1-2. Read and freeze (first attempt only) in one transaction.
  const prep = await ctx.tenant(async (tx) => {
    const doc = await loadDocument(tx, documentId, { forUpdate: true });
    if (!doc || FINAL.includes(doc.status)) return { kind: "done" as const };
    if (doc.status === "waiting") return { kind: "waiting" as const };
    const settings = await loadSettings(tx);
    const facts = await fiscalFacts(tx);
    const org = await loadOrganization(tx);
    if (!settings) return { kind: "done" as const };
    if (!doc.request) {
      try {
        const f = await freezeRequest(tx, doc, settings, facts);
        await tx`
          update cfdi_documents set request = ${tx.json(f.body as never)}, payment_form = ${f.body.payment_form},
            cfdi_use = ${f.body.use}, series = ${f.body.series}, netted_refund_ids = ${f.nettedRefundIds}::uuid[],
            expected_total = ${f.expectedTotal}, expected_tax = ${f.expectedTax},
            expected_withholding = ${f.expectedWithholding}, concept_count = ${f.conceptCount},
            ticket_count = ${f.ticketCount}, provider_org_id = ${org?.providerOrgId ?? null},
            status = 'stamping', attempts = attempts + 1
          where id = ${documentId}`;
        await event(tx, ctx, documentId, "frozen", f.detail);
        if (f.detail.itemizedFallback)
          await event(tx, ctx, documentId, "itemized_fallback", {
            reason: f.detail.itemizedFallback,
          });
        for (const x of f.excluded)
          await event(tx, ctx, documentId, "ticket_excluded", {
            ticketId: x.id,
            folio: x.folio,
            code: x.code,
          });
      } catch (e) {
        if (!(e instanceof DomainError)) throw e;
        // Build-time failure (S5): nothing was sent, the document fails and frees its tickets.
        const failed = await failDocumentTx(tx, ctx, documentId, {
          code: e.code,
        });
        return {
          kind: "failed" as const,
          global: failed?.kind === "global",
          code: e.code,
        };
      }
    } else
      await tx`
        update cfdi_documents set status = 'stamping', attempts = attempts + 1
        where id = ${documentId} and status in ('queued','stamping')`;
    const frozen = (await loadDocument(tx, documentId))!;
    const [unknown] = await tx`
      select 1 as one from cfdi_events where document_id = ${documentId} and kind = 'stamp_unknown' limit 1`;
    return {
      kind: "stamp" as const,
      doc: frozen,
      org,
      facts,
      unknown: !!unknown,
    };
  });
  if (prep.kind === "waiting") {
    ctx.log.warn("cfdi_stamp_waiting", { documentId });
    return DONE;
  }
  if (prep.kind === "done") return DONE;
  if (prep.kind === "failed") {
    if (prep.global) globalFailedAlert(rt, ctx, documentId, prep.code);
    return DONE;
  }
  const { doc, org, facts } = prep;

  // 3. Preconditions: the organization is ready, its legal data current, the key for this mode.
  if (org?.status !== "ready") {
    if (ctx.job.attempts >= 10 && !prep.unknown && !doc.providerInvoiceId) {
      await failDocument(rt, ctx, documentId, { code: "cfdi_not_ready" });
      return DONE;
    }
    return retryOrExhaust(ctx.job, {
      code: "cfdi_org_not_ready",
      afterMs: MINUTE,
    });
  }
  let invoice: FInvoice | null = null;
  try {
    if (
      org.source === "own" &&
      org.providerOrgId &&
      org.legalSyncedVersion !== facts.version
    )
      await syncLegal(rt, ctx, org.providerOrgId, facts);
    const key = await ctx.tenant((tx) =>
      documentKey(rt, tx, tenantId, doc.mode),
    );
    // 4. Adopt: an earlier attempt may have created the invoice.
    if (prep.unknown || doc.attempts > 1)
      invoice = await rt.client.findInvoiceByExternalId(
        key,
        documentId,
        ctx.signal,
      );
    // 5. Stamp.
    invoice ??= (
      await rt.client.createInvoice(key, doc.request as never, ctx.signal)
    ).invoice;
    // 6. Record.
    if (invoice.status === "valid" || invoice.status === "canceled") {
      await recordStamped(ctx, documentId, invoice);
      return DONE;
    }
    if (invoice.status === "pending") {
      await recordPending(ctx, documentId, invoice);
      return DONE;
    }
    if (invoice.status === "failed") {
      await failDocument(rt, ctx, documentId, { code: "cfdi_stamping_failed" });
      return DONE;
    }
    // A draft is not a stamp: retry and adopt.
    throw Object.assign(new Error("cfdi_provider_schema"), {
      code: "cfdi_provider_schema",
    });
  } catch (e) {
    return onError(ctx, doc, e);
  }

  async function onError(
    c: JobContext,
    d: DocumentRow,
    e: unknown,
  ): Promise<JobOutcome> {
    const failure = classify(e);
    if (AUTH_CODES.has(failure.code)) {
      await markKeyInvalid(rt!, c, "cfdi_org_key_invalid");
      // A refused key stamped nothing (401 before any work).
      await failDocument(rt!, c, d.id, { code: "cfdi_org_key_invalid" });
      return DONE;
    }
    if (failure.retry || failure.unknownOutcome) {
      await c.tenant((tx) =>
        event(
          tx,
          c,
          d.id,
          failure.unknownOutcome ? "stamp_unknown" : "stamp_retry",
          {
            code: failure.code,
            providerCode: failure.providerCode ?? null,
          },
        ),
      );
      const next = retryOrExhaust(c.job, {
        code: failure.code,
        afterMs: failure.afterMs,
      });
      if (next && next.status === "dead") {
        await c.tenant((tx) =>
          event(tx, c, d.id, "attempts_exhausted", { code: failure.code }),
        );
        if (d.kind === "global")
          globalFailedAlert(rt!, c, d.id, "cfdi_attempts_exhausted");
      }
      return next;
    }
    await failDocument(rt!, c, d.id, {
      code: failure.code,
      message: failure.message ?? null,
      path: failure.path ?? null,
    });
    if (failure.code === "cfdi_csd_expired")
      raise(rt!, {
        key: `cfdi_csd_expiring:${tenantTag(c.job.tenantId)}`,
        severity: "warning",
        title: "CFDI certificate expired",
        body: `tenant ${tenantTag(c.job.tenantId)} code cfdi_csd_expired`,
      });
    return DONE;
  }
}
