import { liveQuery } from "dexie";
import { useEffect, useState } from "react";
import type { Locale, Order, Session } from "../../../shared/domain";
import { translateError } from "../../i18n";
import { orderNumberLabel } from "../../labels";
import { guardOnlineCharges, OnlineChargeRefused } from "../../offline-queue";
import { chargeBlockFromRows, deviceRows } from "../../offline-records";

/**
 * OFF-R29: the online charge guard for screens that charge server orders
 * outside Selling (Órdenes › Cobrar juntas). For each order on screen, the
 * guard code that blocks charging it now, recomputed whenever this device's
 * offline records change, so the order can be shown as not selectable with
 * its reason. An order that is only outdated (one of this device's rounds
 * synced after the list was read) makes the screen read the list again.
 */
export function useOnlineChargeBlocks(
  session: Session,
  orders: Order[] | null,
  reload: () => void,
): Record<string, string> {
  const [blocks, setBlocks] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!orders?.length) {
      setBlocks({});
      return;
    }
    // One direct Dexie query (liveQuery tracks only Dexie calls); the codes
    // are computed from the rows it observed.
    const subscription = liveQuery(deviceRows(session)).subscribe({
      next: (rows) => {
        const next: Record<string, string> = {};
        for (const order of orders) {
          const code = chargeBlockFromRows(session, order, rows);
          if (code) next[order.id] = code;
        }
        setBlocks(next);
      },
      error: () => {},
    });
    return () => subscription.unsubscribe();
  }, [orders, session.id]);
  const outdated = Object.keys(blocks)
    .filter((id) => blocks[id] === "offline_order_outdated")
    .sort()
    .join();
  useEffect(() => {
    if (outdated) reload();
  }, [outdated]);
  return blocks;
}

/**
 * Runs the guard over every order of a grouped charge right before it is
 * sent. Returns the message to show ("#142 · …") when one order is refused,
 * or null when the charge may go to the server. An order from another
 * business day than `today` names its date as the dialog's lines do
 * ("#142 · 5 oct · …", LD-29).
 */
export async function onlineChargeRefusal(
  session: Session,
  orders: Order[],
  locale: Locale,
  today?: string | null,
): Promise<string | null> {
  try {
    await guardOnlineCharges(session, orders);
    return null;
  } catch (e) {
    if (e instanceof OnlineChargeRefused)
      return `${orderNumberLabel(e.order, today, locale)} · ${translateError(e.message, locale)}`;
    throw e;
  }
}
