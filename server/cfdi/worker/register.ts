/**
 * Registers the nine cfdi job kinds with the WORKER registry (Wave 2.0 (c)). Imported only by
 * server/worker.ts (between its "worker areas: imports" markers): the web never loads this module,
 * so the web runner can never claim a cfdi kind without provider keys (tests/import-graph.test.ts).
 *
 * Every handler runs with its job trace (traced): a job that ends done logs one info line,
 * `cfdi_job_done` (outcome "ok"), with the document it acted on, the ids its payload carries and
 * the X-Facturapi-Log-Id of each provider answer (LD-51 F13). A job that failed its document (a
 * permanent refusal: done, but the document failed), or that ends retry or dead, logs
 * `cfdi_job_failed` instead, with its outcome, the code and the log ids, error answers' included,
 * so a refused stamp never reads like a success and the correlation id Facturapi support asks
 * for is in the log (LD-55 CFDIFIX-OPS-1). The runner's own `job_done` is debug; its job_failed
 * and job_dead carry no document or log id.
 * The line is logged here, when the handler returns, before the runner's completeJob: a lease
 * lost at completion logs job_lease_lost next and the job may run again, so a second line for
 * the same jobId can follow (CFDIFIX-10, accepted and documented in docs/CFDI.md "Jobs"; the
 * handlers are idempotent).
 */
import { registerWorkerJobHandler } from "../../jobs/worker-registry.js";
import type { JobHandler } from "../../jobs.js";
import { CFDI_JOB_LIMITS, type CfdiJobKind } from "../jobs.js";
import { cancelJob } from "./cancel.js";
import { csdJob } from "./csd.js";
import { deliverJob } from "./deliver.js";
import { globalJob } from "./global.js";
import { orgJob } from "./org.js";
import { reconcileJob } from "./reconcile.js";
import { refundJob } from "./refund.js";
import { reissueJob } from "./reissue.js";
import { stampJob } from "./stamp.js";
import { withTrace, type JobTrace } from "./runtime.js";

/** Payload ids worth a log line (cfdi payloads carry ids and flags only, spec R16). */
const PAYLOAD_IDS = [
  "cancellationId",
  "refundId",
  "uploadId",
  "periodKey",
  "action",
  "purpose",
] as const;
const TOKEN = /^[A-Za-z0-9_:.-]{1,64}$/;
const token = (v: unknown): string | null =>
  typeof v === "string" && TOKEN.test(v) ? v : null;

/** Wraps a cfdi handler: its trace, and the one info line of a job that ends done (LD-51 F13). */
export function traced(handler: JobHandler): JobHandler {
  return async (ctx) => {
    const payload = (ctx.job.payload ?? {}) as Record<string, unknown>;
    const trace: JobTrace = {
      documentId: token(payload.documentId) ?? token(payload.globalDocumentId),
      logIds: [],
      quiet: false,
    };
    const outcome = await withTrace(trace, () => handler(ctx));
    if (trace.quiet) return outcome;
    const ids: Record<string, string> = {};
    for (const key of PAYLOAD_IDS) {
      const value = token(payload[key]);
      if (value) ids[key] = value;
    }
    // jobId, kind and tenantId are bound on ctx.log by the runner.
    if (!outcome || outcome.status === "done") {
      if (trace.failure)
        ctx.log.info("cfdi_job_failed", {
          documentId: trace.documentId,
          ...ids,
          outcome: "document_failed",
          code: trace.failure.code,
          logId: trace.failure.logId,
          facturapiLogIds: trace.logIds,
        });
      else
        ctx.log.info("cfdi_job_done", {
          documentId: trace.documentId,
          ...ids,
          outcome: "ok",
          facturapiLogIds: trace.logIds,
        });
    } else if (outcome.status === "retry" || outcome.status === "dead")
      ctx.log.info("cfdi_job_failed", {
        documentId: trace.documentId,
        ...ids,
        outcome: outcome.status,
        code: outcome.code,
        logId: trace.errorLogId ?? null,
        facturapiLogIds: trace.logIds,
      });
    return outcome;
  };
}

export const CFDI_HANDLERS: Record<CfdiJobKind, JobHandler> = {
  cfdi_org: traced(orgJob),
  cfdi_csd: traced(csdJob),
  cfdi_stamp: traced(stampJob),
  cfdi_deliver: traced(deliverJob),
  cfdi_cancel: traced(cancelJob),
  cfdi_reconcile: traced(reconcileJob),
  cfdi_global: traced(globalJob),
  cfdi_refund: traced(refundJob),
  cfdi_reissue: traced(reissueJob),
};

for (const [kind, handler] of Object.entries(CFDI_HANDLERS))
  registerWorkerJobHandler(kind, handler, CFDI_JOB_LIMITS[kind as CfdiJobKind]);
