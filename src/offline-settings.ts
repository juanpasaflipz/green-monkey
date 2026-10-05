/**
 * Offline table service (lead decision LD-7): offline open checks, rounds and
 * partial payments are a per-restaurant beta, OFF by default. The device keeps
 * the restaurant's last known answer so an outage can still honour it; an
 * unknown value is OFF. With it off, offline selling is limited to new orders
 * paid in full (cash or a recorded external terminal) with the kitchen
 * fallback, and the open-orders snapshot is never fetched.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { Session } from "../shared/domain";
import { api } from "./api";
import { db } from "./offline";

export type OfflineSettings = { tableService: boolean };

const settingsKey = (tenantId: string) => `${tenantId}:offline-settings`;
const known = new Map<string, boolean>();
const listeners = new Set<() => void>();

function set(tenantId: string, on: boolean) {
  if (known.get(tenantId) === on) return;
  known.set(tenantId, on);
  for (const listener of listeners) listener();
}

/** The single client predicate (spec §5.7): on only when the restaurant turned it on. */
export function offlineTableServiceOn(
  session: Pick<Session, "tenantId">,
): boolean {
  return known.get(session.tenantId) === true;
}

/** Loads the device's last known value (works offline). */
export async function hydrateOfflineSettings(
  session: Pick<Session, "tenantId">,
): Promise<void> {
  if (known.has(session.tenantId)) return;
  const saved = (await db.cache.get(settingsKey(session.tenantId)))?.value as
    OfflineSettings | undefined;
  if (saved && !known.has(session.tenantId))
    set(session.tenantId, saved.tableService === true);
}

async function remember(tenantId: string, value: OfflineSettings) {
  const on = value.tableService === true;
  set(tenantId, on);
  await db.cache.put({
    id: settingsKey(tenantId),
    value: { tableService: on } satisfies OfflineSettings,
  });
}

/** GET /offline/settings while online; the answer is kept for outages. */
export async function refreshOfflineSettings(
  session: Pick<Session, "tenantId">,
): Promise<OfflineSettings> {
  const value = await api<OfflineSettings>("/offline/settings");
  await remember(session.tenantId, value);
  return value;
}

/** Owner or manager (with step-up once access merges): turns the beta on or off. */
export async function saveOfflineSettings(
  session: Pick<Session, "tenantId">,
  tableService: boolean,
  operationId: string,
): Promise<OfflineSettings> {
  const value = await api<OfflineSettings>(
    "/offline/settings",
    { operationId, tableService },
    { idempotent: true },
  );
  await remember(session.tenantId, value);
  return value;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React view of offlineTableServiceOn; hydrates the stored value on mount. */
export function useOfflineTableService(
  session: Pick<Session, "tenantId">,
): boolean {
  useEffect(() => {
    void hydrateOfflineSettings(session).catch(() => {});
  }, [session.tenantId]);
  return useSyncExternalStore(subscribe, () => offlineTableServiceOn(session));
}

/** Test seam: sets (or with null forgets) a restaurant's value in memory. */
export function setOfflineTableServiceForTests(
  tenantId: string,
  on: boolean | null,
) {
  if (on === null) {
    known.delete(tenantId);
    for (const listener of listeners) listener();
  } else set(tenantId, on);
}
