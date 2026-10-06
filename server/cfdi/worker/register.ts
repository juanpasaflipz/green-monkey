/**
 * Registers the nine cfdi job kinds with the WORKER registry (Wave 2.0 (c)). Imported only by
 * server/worker.ts (between its "worker areas: imports" markers): the web never loads this module,
 * so the web runner can never claim a cfdi kind without provider keys (tests/import-graph.test.ts).
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

export const CFDI_HANDLERS: Record<CfdiJobKind, JobHandler> = {
  cfdi_org: orgJob,
  cfdi_csd: csdJob,
  cfdi_stamp: stampJob,
  cfdi_deliver: deliverJob,
  cfdi_cancel: cancelJob,
  cfdi_reconcile: reconcileJob,
  cfdi_global: globalJob,
  cfdi_refund: refundJob,
  cfdi_reissue: reissueJob,
};

for (const [kind, handler] of Object.entries(CFDI_HANDLERS))
  registerWorkerJobHandler(kind, handler, CFDI_JOB_LIMITS[kind as CfdiJobKind]);
