import Dexie, { type EntityTable } from "dexie";
import type { OrderInput, Session, Product } from "../shared/domain";
import { api } from "./api";
export type Draft = {
  id: string;
  scope: string;
  order: OrderInput;
  updatedAt: number;
};
export type Pending = {
  id: string;
  scope: string;
  body: any;
  status: "pending" | "syncing" | "conflict" | "synced";
  attempts: number;
  nextAt: number;
  error?: string;
  result?: any;
};
const db = new Dexie("green-monkey-v1") as Dexie & {
  drafts: EntityTable<Draft, "id">;
  pending: EntityTable<Pending, "id">;
  cache: EntityTable<{ id: string; value: any }, "id">;
};
db.version(1).stores({
  drafts: "id,scope,updatedAt",
  pending: "id,scope,status",
  cache: "id",
});
export const scope = (s: Session) =>
  `${s.tenantId}:${s.deviceId}:${s.employeeId}`;
export { db };
export async function cacheSession(s: Session, catalog: Product[]) {
  await db.cache.put({ id: "session", value: s });
  await db.cache.put({ id: scope(s) + ":catalog", value: catalog });
}
export async function syncPending(s: Session, force = false) {
  return navigator.locks.request(
    "green-monkey-sync:" + scope(s),
    { ifAvailable: !force },
    async (lock) => {
      if (!lock) return;
      const rows = await db.pending.where("scope").equals(scope(s)).toArray();
      for (const row of rows) {
        if (
          row.status === "synced" ||
          (row.status === "conflict" && !force) ||
          (row.nextAt > Date.now() && !force)
        )
          continue;
        await db.pending.update(row.id, { status: "syncing" });
        try {
          const result = await api("/sync", row.body);
          await db.pending.update(row.id, {
            status: "synced",
            result,
            error: undefined,
          });
        } catch (e) {
          const code = (e as Error).message;
          await db.pending.update(row.id, {
            status: [
              "price_conflict",
              "offline_conflict",
              "insufficient_stock",
              "unavailable",
            ].includes(code)
              ? "conflict"
              : "pending",
            attempts: row.attempts + 1,
            nextAt:
              Date.now() +
              Math.min(300000, 2000 * 2 ** Math.min(row.attempts, 8)),
            error: code,
          });
        }
      }
    },
  );
}
