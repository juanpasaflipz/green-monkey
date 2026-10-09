/**
 * Loyalty club client calls (038, specs/loyalty-w4.md §5). Every call is online-only: the club
 * never blocks a sale (offline, the buttons are disabled with "El club requiere conexión.").
 * Lookups by phone or name are POST bodies, never URLs. The receipt block reads a per-order
 * in-memory cache filled before printing (printDocument renders into its own root).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../../api";
import type { Order, Session } from "../../../shared/domain";
import type {
  EnrollResult,
  LoyaltyClubView,
  LoyaltyCountry,
  LoyaltyReport,
  LoyaltySettingsView,
  MemberDetail,
  MemberListResponse,
  MemberSummary,
  OrderLoyaltyView,
  ReceiptLoyaltyView,
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
  update: (id: string, body: Record<string, unknown>) =>
    api<MemberDetail>(
      `/loyalty/members/${id}/update`,
      { operationId: crypto.randomUUID(), ...body },
      { idempotent: true },
    ),
  adjust: (id: string, body: Record<string, unknown>) =>
    api<MemberDetail>(
      `/loyalty/members/${id}/adjust`,
      { operationId: crypto.randomUUID(), ...body },
      { idempotent: true },
    ),
  remove: (id: string, expectedVersion: number) =>
    api<MemberDetail>(
      `/loyalty/members/${id}/delete`,
      { operationId: crypto.randomUUID(), expectedVersion, confirm: "ELIMINAR" },
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

let club: { tenant: string; view: LoyaltyClubView | null } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
/** Re-reads the club (after saving settings). */
export async function refreshClub(session: Session) {
  try {
    const v = (await loyaltyApi.settings()) as LoyaltyClubView;
    club = { tenant: session.tenantId, view: v.enabled ? v : null };
  } catch {
    club = { tenant: session.tenantId, view: null };
  }
  emit();
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
  const snapshot = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => club,
  );
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
const receiptListeners = new Set<() => void>();
/** Fetches (once) the receipt block of an order; failures leave no block (never throws). */
export async function prefetchLoyaltyReceipt(orderId: string) {
  if (receipts.has(orderId)) return receipts.get(orderId)!;
  try {
    const v = await loyaltyApi.receipt(orderId);
    receipts.set(orderId, v);
    receiptListeners.forEach((l) => l());
    return v;
  } catch {
    return null;
  }
}
/** Drops a cached block (the member changed, so the counts did). */
export function forgetLoyaltyReceipt(orderId: string) {
  receipts.delete(orderId);
  receiptListeners.forEach((l) => l());
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
