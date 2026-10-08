import type { Session } from "../../../shared/domain";
import { db } from "../../offline";
import { devicePrefix, scope } from "../../offline-keys";
import type { DrawerView } from "./DrawerCloseDialog";

/**
 * offline (026, ACC-PR-3): what any employee of this device may know about its
 * drawer during an outage: whether it is open, when and by whom. No figures,
 * so no role ever sees one it could not see online.
 */
export type DrawerFact =
  | { open: true; openedAt: string; openedByName: string }
  | { open: false; openedAt: null; openedByName: null };

/** One employee's copy of the drawer, as the server showed it to them. */
export const drawerKey = (s: Session) => scope(s) + ":drawer";
/** The device's drawer fact, shared by every employee of the device. */
export const drawerFactKey = (s: Session) => devicePrefix(s) + "drawer-fact";

export const drawerFact = (d: DrawerView | null): DrawerFact =>
  d && !d.closed_at
    ? { open: true, openedAt: d.opened_at, openedByName: d.openedByName }
    : { open: false, openedAt: null, openedByName: null };

/** Remembers the drawer the server just returned, for an outage. */
export async function rememberDrawer(s: Session, d: DrawerView | null) {
  await db.cache.bulkPut([
    { id: drawerKey(s), value: d },
    { id: drawerFactKey(s), value: drawerFact(d) },
  ]);
}

/**
 * The drawer Caja shows during an outage: this employee's own copy when there
 * is one, else the device's fact, else nothing.
 */
export async function cachedDrawer(
  s: Session,
): Promise<
  | { view: DrawerView | null; fact?: never }
  | { fact: DrawerFact; view?: never }
  | null
> {
  const [own, device] = await db.cache.bulkGet([
    drawerKey(s),
    drawerFactKey(s),
  ]);
  if (own && own.value !== undefined) return { view: own.value };
  if (device?.value) return { fact: device.value as DrawerFact };
  return null;
}
