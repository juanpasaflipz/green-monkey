import type { Tx } from "../db.js";
import { enqueueJob } from "../jobs.js";
import type { DeliveryProvider } from "../../shared/delivery.js";
export async function queueDelivery(
  tx: Tx,
  tenantId: string,
  provider: DeliveryProvider,
  generation: number,
  action: "connect" | "verify" | "sync" | "disconnect" | "expire",
  runAt?: Date,
) {
  await enqueueJob(
    tx,
    { tenantId },
    {
      kind: "delivery_browser",
      dedupeKey: `${provider}:${generation}:${action}:${runAt?.toISOString() ?? "initial"}`,
      payload: { provider, generation, action },
      runAt,
    },
  );
}
