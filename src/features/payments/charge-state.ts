// Payments (037, P2): the pure parts of useTerminalCharge, unit-tested (tests/payments-client.test.ts;
// P2-UX-15): the start's operation key, how a server reply moves the waiting panel, and what this
// device remembers about a live charge across reloads and restarts, online or not.
import { isLiveForOrder, type AttemptView } from "../../../shared/payments";
import type { Order } from "../../../shared/domain";
import { ApiError } from "../../api";

/**
 * One start operation per (order, terminal, amount, tip, items), kept until a definite answer
 * (P2-UX-1): a re-tap after a lost reply replays the same operation and gets the same attempt,
 * never payments_order_attempt_live. Any change of values is a new operation.
 */
export type StartKey = { sig: string; id: string };
export function startSignature(
  orderId: string,
  v: { terminalId: string; amount: number; tip: number; items?: string[] },
): string {
  return JSON.stringify([
    orderId,
    v.terminalId,
    v.amount,
    v.tip,
    [...(v.items ?? [])].sort(),
  ]);
}
export function nextStartKey(
  prev: StartKey | null,
  sig: string,
  fresh: () => string,
): StartKey {
  return prev && prev.sig === sig ? prev : { sig, id: fresh() };
}
/** The server answered (a domain refusal or an attempt): the operation is decided. */
export function definiteAnswer(e: unknown): boolean {
  return e instanceof ApiError && !e.transient;
}

export type SyncReply = { attempt: AttemptView; order?: Order };
export type ChargeState = {
  attempt: AttemptView | null;
  /** "Cambiar de terminal" asked for a cancel: a confirmed one returns to the picker. */
  switching: boolean;
  /** The attempt whose settle was already announced (critic R18: exactly once). */
  settledId: string | null;
};
/**
 * How one reply moves the panel. `settled` is set exactly once per attempt with the order to
 * announce; `remember` is false once the charge is no longer live for its order.
 */
export function reduceReply(
  s: ChargeState,
  r: SyncReply,
): ChargeState & {
  settled: { order: Order; attempt: AttemptView } | null;
  remember: boolean;
} {
  const a = r.attempt;
  if (a.state === "settled") {
    const announce = Boolean(r.order) && s.settledId !== a.id;
    return {
      attempt: null,
      switching: s.switching,
      settledId: announce ? a.id : s.settledId,
      settled: announce ? { order: r.order!, attempt: a } : null,
      remember: false,
    };
  }
  const live = isLiveForOrder(a.state);
  if (s.switching && !live)
    return {
      attempt: null,
      switching: false,
      settledId: s.settledId,
      settled: null,
      remember: false,
    };
  return {
    attempt: a,
    switching: s.switching,
    settledId: s.settledId,
    settled: null,
    remember: live,
  };
}

// ---- What this device remembers (localStorage: survives a reload, a PWA relaunch and a
// restart while offline; P2-MONEY-6). Never a secret: the staff view of the attempt.

function local(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
const liveKey = (tenantId: string, deviceId: string) =>
  `gm-terminal-attempt:${tenantId}:${deviceId}`;
const activeKey = (tenantId: string) => `gm-terminal-active:${tenantId}`;

/** The live charge this device waits for (null when none). */
export function loadLiveCharge(
  tenantId: string,
  deviceId: string,
  store: Storage | null = local(),
): AttemptView | null {
  try {
    const raw = store?.getItem(liveKey(tenantId, deviceId));
    if (!raw) return null;
    const a = JSON.parse(raw) as AttemptView;
    return a && typeof a.id === "string" && isLiveForOrder(a.state) ? a : null;
  } catch {
    return null;
  }
}
export function saveLiveCharge(
  tenantId: string,
  deviceId: string,
  a: AttemptView | null,
  store: Storage | null = local(),
): void {
  try {
    if (a && isLiveForOrder(a.state))
      store?.setItem(liveKey(tenantId, deviceId), JSON.stringify(a));
    else store?.removeItem(liveKey(tenantId, deviceId));
  } catch {
    // Storage full or blocked: the server still refuses a second charge online.
  }
}
/** The last «Cobros en terminal» list seen online: orders with money possibly in flight. */
export function saveActiveCharges(
  tenantId: string,
  rows: AttemptView[],
  store: Storage | null = local(),
): void {
  try {
    store?.setItem(
      activeKey(tenantId),
      JSON.stringify(
        rows
          .filter((a) => a.orderId && isLiveForOrder(a.state))
          .map((a) => a.orderId),
      ),
    );
  } catch {
    // as above
  }
}
export function cachedLiveOrders(
  tenantId: string,
  store: Storage | null = local(),
): string[] {
  try {
    const ids = JSON.parse(store?.getItem(activeKey(tenantId)) ?? "[]");
    return Array.isArray(ids)
      ? ids.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}
