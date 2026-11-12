import { registerWorkerJobHandler } from "../jobs/worker-registry.js";
import { marketingMessageHandler } from "./messages.js";
registerWorkerJobHandler("marketing_message", marketingMessageHandler(), {
  concurrency: 2,
  leaseSeconds: 60,
  maxAttempts: 10,
});
