/**
 * Registers the payments worker kinds (spec §4.7). Imported only between server/worker.ts's
 * "worker areas: imports" markers; 037's jobs_worker_discover_payments policy lets the jobs login
 * discover exactly these kinds.
 */
import { registerWorkerJobHandler } from "../../jobs/worker-registry.js";
import {
  cancelHandler,
  pollHandler,
  pushDead,
  pushHandler,
  webhookHandler,
} from "./charge.js";
import {
  credentialsDead,
  credentialsHandler,
  deviceModeHandler,
  devicesHandler,
  wipeHandler,
} from "./setup.js";
import { PAYMENTS_JOB_OPTIONS } from "./job-options.js";

const o = PAYMENTS_JOB_OPTIONS;
registerWorkerJobHandler("payments_push", pushHandler, {
  ...o.payments_push,
  onDead: pushDead,
});
registerWorkerJobHandler("payments_poll", pollHandler, o.payments_poll);
registerWorkerJobHandler("payments_cancel", cancelHandler, o.payments_cancel);
registerWorkerJobHandler(
  "payments_webhook",
  webhookHandler,
  o.payments_webhook,
);
registerWorkerJobHandler("payments_credentials", credentialsHandler, {
  ...o.payments_credentials,
  onDead: credentialsDead,
});
registerWorkerJobHandler(
  "payments_devices",
  devicesHandler,
  o.payments_devices,
);
registerWorkerJobHandler(
  "payments_device_mode",
  deviceModeHandler,
  o.payments_device_mode,
);
registerWorkerJobHandler("payments_wipe", wipeHandler, o.payments_wipe);
