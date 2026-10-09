/**
 * Loyalty club client calls (038, specs/loyalty-w4.md §5). Every call is online-only: the club
 * never blocks a sale (offline, the buttons are disabled with "El club requiere conexión.").
 * Lookups by phone or name are POST bodies, never URLs. The receipt block reads a per-order
 * in-memory cache that it fills itself when it renders (every receipt, walk-ins included,
 * LOYALTY-OPS-1/UX-1); printing waits briefly for it (prepareLoyaltyReceipt), because
 * printDocument renders into its own root.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../../api";
import type { Order, Session } from "../../../shared/domain";
import {
  customersVisible,
  type EnrollResult,
  type LoyaltyClubView,
  type LoyaltyCountry,
  type LoyaltyReport,
  type LoyaltySettingsView,
  type MemberDetail,
  type MemberListResponse,
  type MemberSummary,
  type OrderLoyaltyView,
  type ReceiptLoyaltyView,
} from "../../../shared/loyalty";
import type { ImportStatus } from "../../../shared/loyalty-import";

export type RedeemBody = {
  operationId: string;
  memberId: string;
  expectedVersion: number;
  lineId?: string;
  expectedAmount: number;
  expectedBase: number;
  expectedAllocations: { lineId: string; units: number[]; amounts: number[] }[];
  expectedDue: number;
  expectedCloses: boolean;
};

export const loyaltyApi = {
  settings: () =>
    api<LoyaltySettingsView | LoyaltyClubView>("/loyalty/settings"),
  saveSettings: (body: unknown) =>
    api<LoyaltySettingsView>("/loyalty/settings", body, { idempotent: true }),
  lookup: (phone: string, country: LoyaltyCountry) =>
    api<MemberSummary | null>("/loyalty/members/lookup", { phone, country }),
  search: (q: string) =>
    api<MemberSummary[]>("/loyalty/members/search", { q }),
  enroll: (body: {
    phone: string;
    country: LoyaltyCountry;
    name: string;
    consent: boolean;
    marketingOptIn: boolean;
  }) =>
    api<EnrollResult>(
      "/loyalty/members",
      { operationId: crypto.randomUUID(), ...body },
      { idempotent: true },
    ),
  list: (body: { cursor?: string; q?: string; filter?: "rewards" | "imported" }) =>
    api<MemberListResponse>("/loyalty/members/list", body),
  member: (id: string) => api<MemberDetail>(`/loyalty/members/${id}`),
  sheet: (id: string) => api<MemberDetail>(`/loyalty/members/${id}/sheet`),
  // A dialog passes the operationId it made when it opened: a second tap or a retry replays
  // (LOYALTY-UX-6).
  update: (
    id: string,
    body: Record<string, unknown>,
    operationId: string = crypto.randomUUID(),
  ) =>
    api<MemberDetail>(
      `/loyalty/members/${id}/update`,
      { operationId, ...body },
      { idempotent: true },
    ),
  adjust: (
    id: string,
    body: Record<string, unknown>,
    operationId: string = crypto.randomUUID(),
  ) =>
    api<MemberDetail>(
      `/loyalty/members/${id}/adjust`,
      { operationId, ...body },
      { idempotent: true },
    ),
  remove: (
    id: string,
    expectedVersion: number,
    operationId: string = crypto.randomUUID(),
  ) =>
    api<MemberDetail>(
      `/loyalty/members/${id}/delete`,
      { operationId, expectedVersion, confirm: "ELIMINAR" },
      { idempotent: true },
    ),
  order: (orderId: string) =>
    api<OrderLoyaltyView>(`/loyalty/orders/${orderId}`),
  link: (orderId: string, memberId: string, timeoutMs?: number) =>
    api<OrderLoyaltyView>(
      `/loyalty/orders/${orderId}/member`,
      { operationId: crypto.randomUUID(), memberId },
      { idempotent: true, ...(timeoutMs ? { timeoutMs } : {}) },
    ),
  change: (orderId: string, memberId: string | null, expectedMemberId: string | null) =>
    api<OrderLoyaltyView>(
      `/loyalty/orders/${orderId}/member/change`,
      { operationId: crypto.randomUUID(), memberId, expectedMemberId },
      { idempotent: true },
    ),
  reconcile: (orderId: string) =>
    api<OrderLoyaltyView>(`/loyalty/orders/${orderId}/reconcile`, {}),
  redeem: (orderId: string, body: RedeemBody) =>
    api<{ order: Order; loyalty: OrderLoyaltyView }>(
      `/loyalty/orders/${orderId}/reward`,
      body,
      { idempotent: true },
    ),
  receipt: (orderId: string) =>
    api<ReceiptLoyaltyView>(`/loyalty/orders/${orderId}/receipt`),
  importPage: (body: unknown) =>
    api<{ batchId: string; page: number; imported: number; replayed: boolean }>(
      "/loyalty/import/commit",
      body,
      { idempotent: true, timeoutMs: 60000 },
    ),
  importStatus: (batchId: string) =>
    api<ImportStatus>(`/loyalty/import/${batchId}`),
  report: (from: string, to: string) =>
    api<LoyaltyReport>(`/loyalty/report?from=${from}&to=${to}`),
};

// ---- the club as Vender and the navigation see it ------------------------------------------

type ClubState = {
  tenant: string;
  view: LoyaltyClubView | null;
  /** Clientes: the club is on, or a member's data is still held (ARCO, LOYALTY-PRIVACY-3). */
  customers: { clubOn: boolean } | null;
};
let club: ClubState | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
/** Re-reads the club (after saving settings, or after an ARCO deletion). */
export async function refreshClub(session: Session) {
  try {
    const v = (await loyaltyApi.settings()) as LoyaltyClubView &
      Partial<LoyaltySettingsView>;
    club = {
      tenant: session.tenantId,
      view: v.enabled ? v : null,
      customers: customersVisible(v)
        ? { clubOn: v.enabled && v.plan !== "free" }
        : null,
    };
  } catch {
    club = { tenant: session.tenantId, view: null, customers: null };
  }
  emit();
}
const useClubState = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => club,
  );
/**
 * Clientes for owners and managers: shown while the club is on and, with the club off or on Free,
 * while any member who is not deleted exists (read and ARCO actions only). Null hides it.
 */
export function useLoyaltyCustomers(session: Session | null) {
  const snapshot = useClubState();
  return snapshot && snapshot.tenant === session?.tenantId
    ? snapshot.customers
    : null;
}
/**
 * The club when it is on (Pro and enabled) for this session's restaurant, else null. Fetched
 * once per restaurant while online; offline it is whatever was read last (the UI disables the
 * club controls offline anyway).
 */
export function useLoyaltyClub(
  session: Session | null,
  online: boolean,
): LoyaltyClubView | null {
  const snapshot = useClubState();
  const tenant = session?.tenantId ?? "";
  const role = session?.role ?? "";
  useEffect(() => {
    if (!session || !online || role === "kitchen") return;
    if (club?.tenant === tenant) return;
    void refreshClub(session);
  }, [tenant, online, role]);
  return snapshot && snapshot.tenant === tenant ? snapshot.view : null;
}

// ---- receipt cache -------------------------------------------------------------------------

const receipts = new Map<string, ReceiptLoyaltyView>();
const receiptReads = new Map<string, Promise<ReceiptLoyaltyView | null>>();
/** Bumped by forgetLoyaltyReceipt: a read that started before it never fills the cache. */
const receiptEpoch = new Map<string, number>();
/** Club work in flight for an order (Vender's after-payment link and reconcile). */
const receiptWork = new Map<string, Promise<unknown>>();
const receiptListeners = new Set<() => void>();
const receiptChanged = () => receiptListeners.forEach((l) => l());
/**
 * Fetches the receipt block of an order once (one read in flight per order); failures leave no
 * block and are not cached (never throws). With the club known to be off, nothing is fetched.
 */
export function prefetchLoyaltyReceipt(
  orderId: string,
): Promise<ReceiptLoyaltyView | null> {
  const cached = receipts.get(orderId);
  if (cached) return Promise.resolve(cached);
  if (club && !club.view) return Promise.resolve(null);
  const inFlight = receiptReads.get(orderId);
  if (inFlight) return inFlight;
  const epoch = receiptEpoch.get(orderId) ?? 0;
  const read: Promise<ReceiptLoyaltyView | null> = loyaltyApi
    .receipt(orderId)
    .then(
      (v) => {
        if ((receiptEpoch.get(orderId) ?? 0) === epoch) {
          receipts.set(orderId, v);
          receiptChanged();
        }
        return v;
      },
      () => null,
    )
    .finally(() => {
      if (receiptReads.get(orderId) === read) receiptReads.delete(orderId);
    });
  receiptReads.set(orderId, read);
  return read;
}
/** Drops a cached block (the member or the counts changed); the block reads it again. */
export function forgetLoyaltyReceipt(orderId: string) {
  receiptEpoch.set(orderId, (receiptEpoch.get(orderId) ?? 0) + 1);
  receipts.delete(orderId);
  receiptReads.delete(orderId);
  receiptChanged();
}
/** Records club work on an order that its receipt should wait for before printing. */
export function trackLoyaltyReceiptWork(orderId: string, work: Promise<unknown>) {
  const tracked = work.catch(() => undefined);
  receiptWork.set(orderId, tracked);
  void tracked.finally(() => {
    if (receiptWork.get(orderId) === tracked) receiptWork.delete(orderId);
  });
}
/**
 * Before a receipt prints: the club work in flight for the order, then its block (the caller
 * bounds the wait: prepareReceipt in Receipt.tsx).
 */
export async function prepareLoyaltyReceipt(orderId: string) {
  await receiptWork.get(orderId);
  await prefetchLoyaltyReceipt(orderId);
}
export const cachedLoyaltyReceipt = (orderId: string) =>
  receipts.get(orderId) ?? null;
export function useLoyaltyReceipt(orderId: string) {
  return useSyncExternalStore(
    (l) => {
      receiptListeners.add(l);
      return () => receiptListeners.delete(l);
    },
    () => receipts.get(orderId) ?? null,
  );
}

/** A small async loader with an error, for the screens. */
export function useLoader<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    load()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1), setData };
}
