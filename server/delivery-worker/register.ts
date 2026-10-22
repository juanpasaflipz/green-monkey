import { registerWorkerJobHandler } from "../jobs/worker-registry.js";
import { deliveryHandler, deliveryDead } from "./runtime.js";
registerWorkerJobHandler("delivery_browser", deliveryHandler, {
  concurrency: 2,
  leaseSeconds: 180,
  maxAttempts: 100,
  onDead: deliveryDead,
});
