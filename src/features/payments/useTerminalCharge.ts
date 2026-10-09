// Payments (037, P2; spec §5.1 Selling, §5.5): the integrated charge the payment dialog waits for.
// It starts the charge (POST /payments/terminal/charges), then syncs it every dialogSyncMs while
// it is in flight (5 s while the outcome is unknown; never offline, never while a person must
// review it). The live attempt is kept in localStorage per restaurant and device
// (charge-state.ts), so a reload, a PWA relaunch or a restart while offline resumes it and keeps
// the order blocked for offline collection (spec §2.5; P2-MONEY-6). A settled charge reaches
// `onSettled` once (critic R18: Selling's one exit).
import { useEffect, useRef, useState } from "react";
import type { Order, Session } from "../../../shared/domain";
import {
  isLiveForOrder,
  PAYMENTS_LIMITS,
  type AttemptView,
} from "../../../shared/payments";
import { api } from "../../api";
import type { TerminalChargeValues } from "../PaymentDialog";
import { readsTerminalCharges } from "./options";
import {
  definiteAnswer,
  loadLiveCharge,
  nextStartKey,
  reduceReply,
  saveLiveCharge,
  startSignature,
  type StartKey,
  type SyncReply,
} from "./charge-state";

export function useTerminalCharge({
  session,
  online,
  onSettled,
}: {
  session: Session;
  online: boolean;
  onSettled: (order: Order, attempt: AttemptView) => void;
}) {
  const { tenantId, deviceId } = session;
  // A kitchen display never reads charges (the routes answer 403 there: restaurant-day G4).
  const reads = readsTerminalCharges(session.role);
  const [attempt, setAttempt] = useState<AttemptView | null>(() =>
    loadLiveCharge(tenantId, deviceId),
  );
  const [tick, setTick] = useState(0);
  const switching = useRef(false);
  const settled = useRef<string | null>(null);
  const startKey = useRef<StartKey | null>(null);
  const settledCallback = useRef(onSettled);
  settledCallback.current = onSettled;

  const keep = (a: AttemptView | null) => {
    saveLiveCharge(tenantId, deviceId, a);
    setAttempt(a);
  };

  function apply(r: SyncReply) {
    const next = reduceReply(
      { attempt, switching: switching.current, settledId: settled.current },
      r,
    );
    switching.current = next.switching;
    settled.current = next.settledId;
    saveLiveCharge(tenantId, deviceId, next.remember ? next.attempt : null);
    setAttempt(next.attempt);
    if (next.settled)
      settledCallback.current(next.settled.order, next.settled.attempt);
  }

  // A reload, a relaunch or a restart resumes the charge this device was waiting for. Offline,
  // the remembered view alone keeps the order blocked; online, the server's answer replaces it.
  useEffect(() => {
    const remembered = loadLiveCharge(tenantId, deviceId);
    if (!remembered || !reads) return;
    if (!online) {
      setAttempt((a) => a ?? remembered);
      return;
    }
    let alive = true;
    void api<AttemptView>(`/payments/terminal/charges/${remembered.id}`)
      .then((a) => {
        if (!alive) return;
        keep(isLiveForOrder(a.state) ? a : null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [tenantId, deviceId, online, reads]);

  // Sync while the charge is in flight.
  useEffect(() => {
    if (!attempt || !online || !reads) return;
    if (!isLiveForOrder(attempt.state) || attempt.state === "review") return;
    const delay =
      attempt.state === "unknown" ? 5000 : PAYMENTS_LIMITS.dialogSyncMs;
    let alive = true;
    const timer = setTimeout(() => {
      void api<SyncReply>(`/payments/terminal/charges/${attempt.id}/sync`, {})
        .then((r) => alive && apply(r))
        .catch(() => alive && setTick((n) => n + 1));
    }, delay);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [attempt, online, tick, reads]);

  /**
   * The order's live charge started elsewhere (another device, a lost reply, a relaunch): show its
   * waiting panel here, with Cancelar and Cambiar de terminal (P2-UX-1, P2-UX-2). null if none.
   */
  async function attach(orderId: string): Promise<AttemptView | null> {
    const rows = await api<AttemptView[]>("/payments/terminal/active");
    const live =
      rows.find((a) => a.orderId === orderId && isLiveForOrder(a.state)) ??
      null;
    if (live) {
      switching.current = false;
      keep(live);
    }
    return live;
  }

  async function start(orderId: string, v: TerminalChargeValues) {
    const key = nextStartKey(startKey.current, startSignature(orderId, v), () =>
      crypto.randomUUID(),
    );
    startKey.current = key;
    let a: AttemptView;
    try {
      a = await api<AttemptView>(
        "/payments/terminal/charges",
        {
          operationId: key.id,
          orderId,
          terminalId: v.terminalId,
          amount: v.amount,
          tip: v.tip,
          ...(v.items?.length ? { items: v.items } : {}),
        },
        { idempotent: true },
      );
    } catch (e) {
      // A lost reply keeps the key, so the next tap replays this same operation.
      if (definiteAnswer(e)) startKey.current = null;
      if ((e as Error).message === "payments_order_attempt_live") {
        const live = await attach(orderId).catch(() => null);
        if (live) return live;
      }
      throw e;
    }
    startKey.current = null;
    switching.current = false;
    keep(a);
    return a;
  }
  async function cancel(switchTerminal = false) {
    if (!attempt) return;
    switching.current = switchTerminal;
    const a = await api<AttemptView>(
      `/payments/terminal/charges/${attempt.id}/cancel`,
      { operationId: crypto.randomUUID() },
    );
    apply({ attempt: a });
  }
  async function recheck() {
    if (!attempt) return;
    apply(
      await api<SyncReply>(`/payments/terminal/charges/${attempt.id}/resolve`, {
        operationId: crypto.randomUUID(),
        outcome: "check",
      }),
    );
  }
  async function retrySettle() {
    if (!attempt) return;
    apply(
      await api<SyncReply>(`/payments/terminal/charges/${attempt.id}/resolve`, {
        operationId: crypto.randomUUID(),
        outcome: "retry",
      }),
    );
  }
  /** Back to the form (after a final outcome): Reintentar, Otra forma de pago. */
  function dismiss() {
    if (attempt && isLiveForOrder(attempt.state)) return;
    keep(null);
  }
  return {
    attempt,
    start,
    attach,
    cancel,
    recheck,
    retrySettle,
    dismiss,
    apply,
  };
}
