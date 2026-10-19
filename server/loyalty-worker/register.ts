import { registerWorkerJobHandler } from "../jobs/worker-registry.js";
import { messageHandler } from "./messages.js";
import { walletHandler } from "./wallet.js";
registerWorkerJobHandler("loyalty_message", messageHandler, {
  concurrency: 2,
  leaseSeconds: 60,
  maxAttempts: 10,
});
registerWorkerJobHandler("loyalty_wallet_sync", walletHandler, {
  concurrency: 2,
  leaseSeconds: 60,
  maxAttempts: 8,
});
