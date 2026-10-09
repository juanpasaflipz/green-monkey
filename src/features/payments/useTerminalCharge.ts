// Payments (037, P2; spec §5.1 Selling, §5.5): the integrated charge the payment dialog waits for.
// It starts the charge (POST /payments/terminal/charges), then syncs it every dialogSyncMs while
// it is in flight (5 s while the outcome is unknown; never offline, never while a person must
// review it). The attempt id is kept in sessionStorage per restaurant and device, so a reload
// resumes waiting. A settled charge reaches `onSettled` once (critic R18: Selling's one exit).
import { useEffect, useRef, useState } from "react";
import type { Order, Session } from "../../../shared/domain";
import {
  isLiveForOrder,
  PAYMENTS_LIMITS,
  type AttemptView,
} from "../../../shared/payments";
import { api } from "../../api";
import type { TerminalChargeValues } from "../PaymentDialog";
import { waitingKey } from "./attempt-text";

type SyncReply = { attempt: AttemptView; order?: Order };

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function useTerminalCharge({
  session,
  online,
  onSettled,
}: {
  session: Session;
  online: boolean;
  onSettled: (order: Order, attempt: AttemptView) => void;
}) {
  const key = waitingKey(session.tenantId, session.deviceId);
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [tick, setTick] = useState(0);
  const switching = useRef(false);
  const settled = useRef<string | null>(null);
  const settledCallback = useRef(onSettled);
  settledCallback.current = onSettled;

  const remember = (a: AttemptView) =>
    storage()?.setItem(key, JSON.stringify({ id: a.id, orderId: a.orderId }));
  const forget = () => storage()?.removeItem(key);

  function apply(r: SyncReply) {
    const a = r.attempt;
    if (a.state === "settled") {
      forget();
      setAttempt(null);
      if (r.order && settled.current !== a.id) {
        settled.current = a.id;
        settledCallback.current(r.order, a);
      }
      return;
    }
    if (!isLiveForOrder(a.state)) forget();
    if (switching.current && !isLiveForOrder(a.state)) {
      // "Cambiar de terminal": the cancel is confirmed, so the cashier picks another terminal.
      switching.current = false;
      setAttempt(null);
      return;
    }
    setAttempt(a);
  }

  // A reload (or another view) resumes the charge this device was waiting for.
  useEffect(() => {
    if (!online) return;
    const raw = storage()?.getItem(key);
    if (!raw) return;
    let id: string | null;
    try {
      id = (JSON.parse(raw) as { id?: string }).id ?? null;
    } catch {
      id = null;
    }
    if (!id) {
      forget();
      return;
    }
    let alive = true;
    void api<AttemptView>(`/payments/terminal/charges/${id}`)
      .then((a) => {
        if (!alive) return;
        if (isLiveForOrder(a.state)) setAttempt(a);
        else forget();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [key, online]);

  // Sync while the charge is in flight.
  useEffect(() => {
    if (!attempt || !online) return;
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
  }, [attempt, online, tick]);

  async function start(orderId: string, v: TerminalChargeValues) {
    const a = await api<AttemptView>(
      "/payments/terminal/charges",
      {
        operationId: crypto.randomUUID(),
        orderId,
        terminalId: v.terminalId,
        amount: v.amount,
        tip: v.tip,
        ...(v.items?.length ? { items: v.items } : {}),
      },
      { idempotent: true },
    );
    switching.current = false;
    remember(a);
    setAttempt(a);
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
    forget();
    setAttempt(null);
  }
  return { attempt, start, cancel, recheck, retrySettle, dismiss, apply };
}
