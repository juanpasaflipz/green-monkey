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
  credentialsHandler,
  deviceModeHandler,
  devicesHandler,
  wipeHandler,
} from "./setup.js";

// A push that goes dead with the attempt still `sending` leaves it `unknown` (pushDead).
registerWorkerJobHandler("payments_push", pushHandler, {
  leaseSeconds: 30,
  concurrency: 4,
  maxAttempts: 3,
  onDead: pushDead,
});
registerWorkerJobHandler("payments_poll", pollHandler, {
  leaseSeconds: 30,
  concurrency: 8,
  maxAttempts: 100,
});
// 15 claims: a cancel waits (2 s apart) while the push is still recording the provider's answer.
registerWorkerJobHandler("payments_cancel", cancelHandler, {
  leaseSeconds: 30,
  concurrency: 4,
  maxAttempts: 15,
});
registerWorkerJobHandler("payments_webhook", webhookHandler, {
  leaseSeconds: 20,
  concurrency: 8,
  maxAttempts: 3,
});
registerWorkerJobHandler("payments_credentials", credentialsHandler, {
  leaseSeconds: 60,
  concurrency: 2,
  maxAttempts: 3,
});
registerWorkerJobHandler("payments_devices", devicesHandler, {
  leaseSeconds: 30,
  concurrency: 2,
  maxAttempts: 2,
});
registerWorkerJobHandler("payments_device_mode", deviceModeHandler, {
  leaseSeconds: 30,
  concurrency: 1,
  maxAttempts: 2,
});
registerWorkerJobHandler("payments_wipe", wipeHandler, {
  leaseSeconds: 20,
  concurrency: 1,
  maxAttempts: 3,
});
