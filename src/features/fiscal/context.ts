// The restaurant's fiscal context (issuer data, region, default tax) for receipts and the
// product editor. A module store rather than React context: printDocument renders receipts
// into their own root, where context from the app tree does not reach (Receipt.tsx slots).
// Cached in Dexie under `${tenantId}:fiscal-context` so offline receipts keep the issuer.
import { useSyncExternalStore } from "react";
import type { Session } from "../../../shared/domain";
import type { FiscalContextView } from "../../../shared/fiscal";
import { api } from "../../api";
import { db } from "../../offline";

let value: FiscalContextView | null = null;
let restaurant: Session["restaurant"] | null = null;
let lastSession: Session | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const snapshot = () => value;
const cacheKey = (s: Session) => s.tenantId + ":fiscal-context";

export function setFiscalContext(next: FiscalContextView | null) {
  value = next;
  emit();
}

/** Forgets the context (sign-out, another session); receipts fall back to their own data. */
export function clearFiscalContext() {
  value = null;
  restaurant = null;
  lastSession = null;
  emit();
}

/** The restaurant of the session last prefetched, for receipt fallbacks (timezone, currency). */
export function fiscalRestaurant(): Session["restaurant"] | null {
  return restaurant;
}

/** The current context, synchronously (print roots and pure helpers). */
export function currentFiscalContext(): FiscalContextView | null {
  return value;
}

/** Loads GET /fiscal/context; offline (or on any failure) falls back to the Dexie copy. */
export async function prefetchFiscalContext(
  session: Session,
): Promise<FiscalContextView | null> {
  restaurant = session.restaurant;
  lastSession = session;
  try {
    const fresh = await api<FiscalContextView>("/fiscal/context");
    if (lastSession !== session) return value;
    setFiscalContext(fresh);
    try {
      await db.cache.put({ id: cacheKey(session), value: fresh });
    } catch {
      /* Storage full or blocked: the context lasts for this page only. */
    }
  } catch {
    try {
      const cached = (await db.cache.get(cacheKey(session)))?.value as
        FiscalContextView | undefined;
      if (cached && lastSession === session) setFiscalContext(cached);
    } catch {
      /* No cached copy: receipts print without issuer data until online. */
    }
  }
  return value;
}

/** Loads the context once if nothing is loaded yet (the product editor's labels). */
export function ensureFiscalContext() {
  if (!value && lastSession) void prefetchFiscalContext(lastSession);
}

/** The context, re-rendering when it changes. */
export function useFiscalContext(): FiscalContextView | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
