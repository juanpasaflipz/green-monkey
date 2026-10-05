import { liveQuery } from "dexie";
import { useEffect, useRef } from "react";
import type { Order, Session } from "../../../shared/domain";
import { api } from "../../api";
import { db } from "../../offline";
import {
  deviceRows,
  findOpenOrder,
  isServerOrder,
  linkFromRows,
  rememberOpenOrder,
  serverLink,
} from "../../offline-records";

/**
 * Keeps Selling's current order consistent with this device's offline records.
 *
 * - Online, every server order Selling receives (send, round, payment, resume)
 *   is remembered in the open-orders cache, so the order on screen when an
 *   outage starts can still be paid offline at its current balance (OFF-R2).
 * - Offline, a server order on screen is replaced by its projection: the
 *   newest cached copy plus this device's rounds and payments it does not
 *   contain yet, so the default amount is the real balance (OFF-R2).
 * - Online, a projection is replaced by the server order as soon as the server
 *   knows it (I13), and a server order is read again whenever one of this
 *   device's rounds or payments for it syncs (OFF-R5).
 */
export function useOfflineCurrent({
  session,
  online,
  current,
  setCurrent,
  contextId,
}: {
  session: Session;
  online: boolean;
  current: Order | null;
  setCurrent: (order: Order) => void;
  contextId: string;
}) {
  const shown = useRef(current);
  shown.current = current;
  const server = isServerOrder(current);
  useEffect(() => {
    if (online && current && isServerOrder(current))
      void rememberOpenOrder(session, current).catch(() => {});
  }, [online, current]);
  useEffect(() => {
    if (online || !current || !server) return;
    let live = true;
    void findOpenOrder(session, { orderId: current.id })
      .then((view) => {
        if (live && view && shown.current?.id === view.id) setCurrent(view);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [online, current?.id, server]);
  useEffect(() => {
    if (!online || !current) return;
    let live = true,
      fetching = false;
    // Reads the order until it shows every synced record of this device for
    // it (a record may sync while the read is in flight); bounded.
    async function refresh(orderId: string) {
      for (let attempt = 0; attempt < 3 && live; attempt++) {
        const order = await api<Order>("/orders/" + orderId);
        if (!live) return;
        setCurrent(order);
        void db.cache.put({ id: contextId, value: order.id });
        if (!(await serverLink(session, order)).stale) return;
      }
    }
    // The querier is one direct Dexie query (liveQuery tracks only Dexie
    // calls); the link is computed from the rows it observed.
    const subscription = liveQuery(deviceRows(session)).subscribe({
      next: (rows) => {
        if (!live || fetching || !shown.current) return;
        const link = linkFromRows(shown.current, rows);
        if (!link.orderId || !link.stale) return;
        fetching = true;
        void refresh(link.orderId)
          .catch(() => {})
          .finally(() => {
            fetching = false;
          });
      },
      error: () => {},
    });
    return () => {
      live = false;
      subscription.unsubscribe();
    };
  }, [online, current?.id, server]);
}
