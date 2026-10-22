import { registerWorkerJobHandler } from "../jobs/worker-registry.js";
import { deliveryHandler, deliveryDead } from "./runtime.js";
// Disabled replicas must leave queued jobs untouched so enabling resumes them.
// In particular, a pause must not permanently consume a disconnect request.
if (process.env.DELIVERY_BROWSER_ENABLED === "1")
  registerWorkerJobHandler("delivery_browser", deliveryHandler, {
    concurrency: 2,
    leaseSeconds: 180,
    maxAttempts: 100,
    onDead: deliveryDead,
  });
