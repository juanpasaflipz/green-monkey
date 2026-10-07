/**
 * cfdi_stamp (spec §4.8.3): read → freeze (first attempt) → preconditions → adopt by external_id
 * after an unknown outcome → POST /invoices → record. The document id is Facturapi's
 * idempotency_key and external_id, so a retry can never create a second CFDI (R3, DB test 11).
 *
 * Every attempt that reaches POST /invoices first commits a `stamp_sent` event; outcomes that may
 * have created an invoice (timeouts, network failures, 5xx, in-flight 409s, unreadable 2xx) also
 * write `stamp_unknown`. A later attempt of a document that was sent looks it up by external_id
 * BEFORE any other precondition (legal sync, key checks), and is never failed by a permanent error
 * unless that lookup positively found no invoice (review CFDI-WORKER-2): its claims stay, it stays
 * `stamping`, shows as stuck, and Reintentar adopts it.
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
  platform,
  stampingFacts,
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
  const { rt, outcome } = await runtimeOr(ctx);
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
        // The issuer's facts: the shared sandbox organization's in that mode (LD-51 F3).
        const f = await freezeRequest(
          tx,
          doc,
          settings,
          stampingFacts(facts, await platform(tx), org),
        );
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
    // An earlier attempt reached POST /invoices (its stamp_sent event committed first).
    const [sent] = await tx`
      select 1 as one from cfdi_events where document_id = ${documentId}
        and kind in ('stamp_sent','stamp_unknown') limit 1`;
    return {
      kind: "stamp" as const,
      doc: frozen,
      org,
      facts,
      sent: !!sent,
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

  // 3. Preconditions: the organization is ready. A document never sent fails after 10 attempts.
  if (org?.status !== "ready") {
    if (ctx.job.attempts >= 10 && !prep.sent && !doc.providerInvoiceId) {
      await failDocument(rt, ctx, documentId, { code: "cfdi_not_ready" });
      return DONE;
    }
    return retryOrExhaust(ctx.job, {
      code: "cfdi_org_not_ready",
      afterMs: MINUTE,
    });
  }
  let invoice: FInvoice | null = null;
  // Whether an invoice may exist at the provider that this attempt has not ruled out: an earlier
  // attempt was sent and no lookup by external_id answered "none" yet.
  let mayExist = prep.sent;
  try {
    const key = await ctx.tenant((tx) =>
      documentKey(rt, tx, tenantId, doc.mode),
    );
    // 4. Adopt first: an earlier attempt may have created the invoice. Before the legal sync or
    // any other precondition that can fail permanently (CFDI-WORKER-2).
    if (prep.sent) {
      invoice = await rt.client.findInvoiceByExternalId(
        key,
        documentId,
        ctx.signal,
      );
      mayExist = !!invoice;
    }
    if (!invoice) {
      // The restaurant's legal data, current at Facturapi before a new stamp.
      if (
        org.source === "own" &&
        org.providerOrgId &&
        org.legalSyncedVersion !== facts.version
      )
        await syncLegal(rt, ctx, org.providerOrgId, facts);
      // 5. Stamp: committed first, so any later attempt (a lost lease included) adopts first.
      if (!prep.sent)
        await ctx.tenant((tx) => event(tx, ctx, documentId, "stamp_sent", {}));
      invoice = (
        await rt.client.createInvoice(key, doc.request as never, ctx.signal)
      ).invoice;
    }
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
      // A refused key stamped nothing now (401 before any work). But an earlier attempt that was
      // sent may have created the invoice: such a document is never failed (its claims stay), it
      // stays `stamping` and Reintentar adopts it once the key is fixed (review CFDI-R6).
      if (mayExist) {
        await c.tenant((tx) =>
          event(tx, c, d.id, "stamp_retry", {
            code: "cfdi_org_key_invalid",
            providerCode: failure.providerCode ?? null,
            logId: failure.logId ?? null,
          }),
        );
        return DONE;
      }
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
            logId: failure.logId ?? null,
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
    // A permanent refusal before this attempt could rule out an earlier invoice (the key, the
    // live switch, the legal sync): never fail a document that may already be a valid CFDI
    // (CFDI-WORKER-2). It stays `stamping` (stuck) for Reintentar.
    if (mayExist) {
      await c.tenant((tx) =>
        event(tx, c, d.id, "stamp_retry", {
          code: failure.code,
          providerCode: failure.providerCode ?? null,
          logId: failure.logId ?? null,
        }),
      );
      return DONE;
    }
    await failDocument(rt!, c, d.id, {
      code: failure.code,
      message: failure.message ?? null,
      path: failure.path ?? null,
      logId: failure.logId ?? null,
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
