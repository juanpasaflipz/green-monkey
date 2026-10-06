/**
 * cfdi_deliver (spec §4.8.4): stores the stamped XML and PDF (or the cancellation acuse), checks
 * the stamped amounts against the frozen request once, and emails the receptor.
 *
 * Amount check: exact when the stamped pre-retention total, IVA and ISR retention equal the
 * expected (fiscal) figures. Otherwise "differs"; it alerts (cfdi_amount_mismatch) only when the
 * stamped figures also differ from the canonical ones the provider must stamp (canonicalAmounts of
 * the frozen request): the documented bounds (pre-ticket refunds, base-priced RESICO concepts,
 * egresos) never alert.
 */
import { createHash } from "node:crypto";
import type { JobContext, JobOutcome } from "../../jobs.js";
import { retryOrExhaust } from "../jobs.js";
import { canonicalAmounts } from "../build.js";
import type { FInvoiceInput } from "../facturapi-schema.js";
import { parseCfdiTotals } from "../xml.js";
import { loadDocument, type DocumentRow } from "../store.js";
import { classify, event, runtimeOr } from "./common.js";
import { documentKey, raise, tenantTag } from "./runtime.js";

type Payload = {
  documentId?: string;
  email?: boolean;
  to?: string | null;
  acuse?: boolean;
};

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function amountCheck(
  doc: Pick<
    DocumentRow,
    "kind" | "expectedTotal" | "expectedTax" | "expectedWithholding" | "request"
  >,
  xml: Uint8Array,
): {
  check: "exact" | "differs";
  alert: boolean;
  stamped: { total: number; tax: number; withheld: number; subtotal: number };
  canonical: { total: number; tax: number; withheld: number };
  reason: string | null;
} {
  const totals = parseCfdiTotals(xml);
  const stamped = {
    total: totals.total + totals.taxRetenidos,
    tax: totals.taxTraslados,
    withheld: totals.taxRetenidos,
    subtotal: totals.subtotal,
  };
  const canonical = canonicalAmounts(doc.request as FInvoiceInput);
  const exact =
    stamped.total === doc.expectedTotal &&
    stamped.tax === doc.expectedTax &&
    stamped.withheld === doc.expectedWithholding;
  const matchesCanonical =
    stamped.total === canonical.total &&
    stamped.tax === canonical.tax &&
    stamped.withheld === canonical.withheld;
  return {
    check: exact ? "exact" : "differs",
    alert: !exact && !matchesCanonical,
    stamped,
    canonical,
    reason: exact
      ? null
      : matchesCanonical
        ? doc.expectedWithholding > 0
          ? "base_priced_rounding"
          : doc.kind === "egreso"
            ? "egreso_extract"
            : "pre_ticket_refund_bound"
        : "provider_rounding",
  };
}

export async function deliverJob(ctx: JobContext): Promise<JobOutcome> {
  const p = (ctx.job.payload ?? {}) as Payload;
  const documentId = p.documentId;
  if (!documentId) return { status: "dead", code: "cfdi_invalid_payload" };
  const { rt, outcome } = runtimeOr(ctx);
  if (!rt) return outcome;
  const tenantId = ctx.job.tenantId;

  const loaded = await ctx.tenant(async (tx) => {
    const doc = await loadDocument(tx, documentId);
    if (!doc || !doc.providerInvoiceId) return null;
    const files = (
      await tx`select format from cfdi_files where document_id = ${documentId}`
    ).map((r) => r.format as string);
    let parentEmail: string | null = null;
    if (doc.kind === "egreso" && doc.parentDocumentId) {
      const parent = await loadDocument(tx, doc.parentDocumentId);
      parentEmail = parent?.receptor?.email ?? null;
    }
    return {
      doc,
      files,
      parentEmail,
      key: await documentKey(rt, tx, tenantId, doc.mode),
    };
  });
  if (!loaded) return { status: "done" };
  const { doc, key } = loaded;
  const providerId = doc.providerInvoiceId!;

  try {
    if (p.acuse) {
      if (doc.status !== "canceled") return { status: "done" };
      for (const format of ["xml", "pdf"] as const) {
        const name = format === "xml" ? "cancel_xml" : "cancel_pdf";
        if (loaded.files.includes(name)) continue;
        const bytes = await rt.client.downloadCancellationReceipt(
          key,
          providerId,
          format,
          ctx.signal,
        );
        await ctx.tenant(
          (tx) => tx`
            insert into cfdi_files(tenant_id, document_id, format, content, sha256)
            values (${tenantId}, ${documentId}, ${name}, ${Buffer.from(bytes)}, ${sha256(bytes)})
            on conflict do nothing`,
        );
      }
      return { status: "done" };
    }
    if (!["valid", "canceling", "canceled"].includes(doc.status))
      return { status: "done" };
    let xml: Uint8Array | null = null;
    for (const format of ["xml", "pdf"] as const) {
      if (loaded.files.includes(format)) continue;
      const bytes = await rt.client.download(
        key,
        providerId,
        format,
        ctx.signal,
      );
      if (format === "xml") xml = bytes;
      await ctx.tenant(
        (tx) => tx`
          insert into cfdi_files(tenant_id, document_id, format, content, sha256)
          values (${tenantId}, ${documentId}, ${format}, ${Buffer.from(bytes)}, ${sha256(bytes)})
          on conflict do nothing`,
      );
    }
    if (doc.amountCheck === null && doc.request) {
      if (!xml) {
        const [row] = await ctx.tenant(
          (tx) =>
            tx`select content from cfdi_files where document_id = ${documentId} and format = 'xml'`,
        );
        xml = row ? new Uint8Array(row.content) : null;
      }
      if (xml) {
        const check = amountCheck(doc, xml);
        await ctx.tenant(async (tx) => {
          const [changed] = await tx`
            update cfdi_documents set subtotal = ${check.stamped.subtotal}, tax = ${check.stamped.tax},
              withheld = ${check.stamped.withheld}, amount_check = ${check.check}
            where id = ${documentId} and amount_check is null returning id`;
          if (!changed) return;
          await event(tx, ctx, documentId, "amount_check", {
            result: check.check,
            ...(check.check === "differs"
              ? {
                  expected: {
                    total: doc.expectedTotal,
                    tax: doc.expectedTax,
                    withheld: doc.expectedWithholding,
                  },
                  stamped: check.stamped,
                  canonical: check.canonical,
                  reason: check.reason,
                }
              : {}),
          });
        });
        if (check.alert)
          raise(rt, {
            key: `cfdi_amount_mismatch:${tenantTag(tenantId)}:${new Date().toISOString().slice(0, 10)}`,
            severity: "warning",
            title: "CFDI stamped amount differs",
            body: `tenant ${tenantTag(tenantId)} document ${documentId} reason provider_rounding`,
          });
      }
    }
    // Email: on request (resend), or once after stamping when the receptor gave an address.
    const receptorEmail =
      doc.kind === "egreso"
        ? loaded.parentEmail
        : (doc.receptor?.email ?? null);
    const to = p.email ? (p.to ?? receptorEmail) : receptorEmail;
    const auto = !p.email && doc.emailedAt === null && doc.emailError === null;
    if (to && doc.kind !== "global" && (p.email || auto)) {
      try {
        await rt.client.sendByEmail(key, providerId, [to], ctx.signal);
        await ctx.tenant(async (tx) => {
          await tx`update cfdi_documents set emailed_at = now(), email_error = null where id = ${documentId}`;
          await event(tx, ctx, documentId, "emailed", {});
        });
      } catch (e) {
        const failure = classify(e);
        if (failure.retry) throw e;
        await ctx.tenant(async (tx) => {
          await tx`update cfdi_documents set email_error = ${failure.code} where id = ${documentId}`;
          await event(tx, ctx, documentId, "email_failed", {
            code: failure.code,
          });
        });
      }
    }
    return { status: "done" };
  } catch (e) {
    const failure = classify(e);
    if (!failure.retry && !failure.unknownOutcome) {
      await ctx.tenant((tx) =>
        event(
          tx,
          ctx,
          documentId,
          p.acuse ? "acuse_failed" : "deliver_failed",
          {
            code: failure.code,
          },
        ),
      );
      return { status: "done" };
    }
    return retryOrExhaust(ctx.job, {
      code: failure.code,
      afterMs: failure.afterMs,
    });
  }
}
