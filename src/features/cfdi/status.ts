/**
 * The CFDI status store (spec §5.2): what buttons and the printed ticket block need, read
 * synchronously so receipts print offline from the cached value. Prefetched after sign-in
 * (App.tsx load()), hydrated from Dexie when the device starts offline (restoreCached()), and
 * cleared on every employee change. Kitchen sessions never call it (GET /cfdi/status is for
 * operators).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Session } from "../../../shared/domain";
import type { CfdiStatusView, CfdiTicketView } from "../../../shared/cfdi";
import { api } from "../../api";
import { db, scope } from "../../offline";

let current: CfdiStatusView | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function getCfdiStatus(): CfdiStatusView | null {
  return current;
}
export function setCfdiStatus(v: CfdiStatusView | null): void {
  current = v;
  emit();
}
export function clearCfdiStatus(): void {
  setCfdiStatus(null);
}
export function useCfdiStatus(): CfdiStatusView | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getCfdiStatus,
    getCfdiStatus,
  );
}

const cacheKey = (s: Session) => scope(s) + ":cfdi-status";

/**
 * GET /cfdi/status → store → Dexie cache; on any failure the cached value (if any). `cacheOnly`
 * reads only the cache (a device started in manual offline mode).
 */
export async function prefetchCfdiStatus(
  s: Session,
  o: { cacheOnly?: boolean } = {},
): Promise<CfdiStatusView | null> {
  if (s.role === "kitchen") return null;
  if (!o.cacheOnly)
    try {
      const v = await api<CfdiStatusView>("/cfdi/status");
      setCfdiStatus(v);
      try {
        await db.cache.put({ id: cacheKey(s), value: v });
      } catch {
        // A full or blocked IndexedDB only loses the offline copy.
      }
      return v;
    } catch {
      // Fall back to the cache below.
    }
  try {
    const cached = (await db.cache.get(cacheKey(s)))?.value as
      CfdiStatusView | undefined;
    if (cached) setCfdiStatus(cached);
    return cached ?? null;
  } catch {
    return null;
  }
}

/** True when the ticket's covering document (an invoice or a global) is valid. */
export function cfdiTicketCovered(v: CfdiTicketView | null): boolean {
  return v?.covering?.status === "valid";
}

/**
 * Whether useCfdiTicketStatus asks the server at all: an id, CFDI available, and CFDI activated
 * at some point (a mode). A restaurant that never activated it has no invoice to report, and the
 * server answers cfdi_disabled (409), which the browser logs on every refund dialog. A paused
 * restaurant keeps its mode and its invoices, so it is still asked.
 */
export function ticketStatusWanted(
  ticketId: string | null,
  status: CfdiStatusView | null,
): ticketId is string {
  return !!ticketId && !!status?.available && status.mode !== null;
}

/** GET /cfdi/tickets/:id, or null on any failure (never throws). */
export async function loadCfdiTicketStatus(
  ticketId: string,
  signal?: AbortSignal,
): Promise<CfdiTicketView | null> {
  try {
    return await api<CfdiTicketView>(
      "/cfdi/tickets/" + encodeURIComponent(ticketId),
      undefined,
      { signal },
    );
  } catch {
    return null;
  }
}

/**
 * The CFDI view of one ticket, for discounts' RefundDialog notice (spec §6.1): one request per id,
 * no polling, null immediately without an id or when CFDI is unavailable, and null on any error
 * (forbidden roles, cfdi_unavailable, not found, offline). Never throws, never shows an error.
 */
export function useCfdiTicketStatus(
  ticketId: string | null,
): CfdiTicketView | null {
  const status = useCfdiStatus();
  const wanted = ticketStatusWanted(ticketId, status);
  const [view, setView] = useState<{
    id: string;
    v: CfdiTicketView | null;
  } | null>(null);
  useEffect(() => {
    if (!wanted || !ticketId) return;
    const abort = new AbortController();
    void loadCfdiTicketStatus(ticketId, abort.signal).then((v) => {
      if (!abort.signal.aborted) setView({ id: ticketId, v });
    });
    return () => abort.abort();
  }, [wanted, ticketId]);
  return wanted && view?.id === ticketId ? view.v : null;
}
