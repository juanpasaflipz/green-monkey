import { registerJobHandler } from "../../jobs.js";

// The KDS reads rounds directly (pull-based), so a kitchen_dispatch job has
// nothing left to do: marking it done drains existing and future rows
// (OPS-15) without changing the enqueue in orders.ts. Receipt jobs have no
// handler and stay blocked (printer_not_paired); the runner never touches them.
registerJobHandler("kitchen_dispatch", async () => {}, {
  concurrency: 2,
  leaseSeconds: 60,
});
