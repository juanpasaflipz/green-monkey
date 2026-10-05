import { registerJobHandler } from "../registry.js";

// The KDS reads rounds directly, so a kitchen_dispatch job has nothing left to
// do: completing it drains existing and future rows (OPS-15) without editing
// the enqueue in orders.ts. Receipt jobs stay blocked (printer_not_paired)
// and are pruned by retention after 30 days.
registerJobHandler("kitchen_dispatch", async () => {}, {
  concurrency: 4,
  leaseSeconds: 60,
});
