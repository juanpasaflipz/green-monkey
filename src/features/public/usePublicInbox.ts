import { useEffect, useState, useSyncExternalStore } from "react";
import type { Session } from "../../../shared/domain";
import type { InboxSummary } from "../../../shared/public-ordering";
import { api } from "../../api";
import { usePoll } from "../../serviceHooks";

/**
 * One store for the shell badge, the banner and the Órdenes inbox, so an
 * accept or a reject updates the badge at once.
 */
const EMPTY: InboxSummary = {
  available: false,
  active: false,
  pending: 0,
  oldestAt: null,
};
let state: InboxSummary = EMPTY;
const listeners = new Set<() => void>();
function emit(next: InboxSummary) {
  state = next;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => state;

/** The inbox's own count wins between summary polls. */
export function setPublicInboxPending(pending: number) {
  if (pending !== state.pending) emit({ ...state, pending });
}
let refresher: () => void = () => {};
/** Asks the shell's summary poll to run now. */
export function refreshPublicInbox() {
  refresher();
}
/** The latest summary, for components below the shell (Órdenes). */
export function usePublicInboxSnapshot(): InboxSummary {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}

const OPERATORS = ["owner", "manager", "cashier", "server"];
/** Answers after which the poll waits silently for the next session. */
const QUIET = new Set([
  "session_locked",
  "session_changed",
  "session_expired",
  "unauthorized",
  "forbidden",
]);

/**
 * GET /api/ordering/inbox/summary for operators every 20 s (5 min while no
 * link is active), only while visible and online; it stops when public
 * ordering is not available on this server and when the session ends.
 */
export function usePublicInbox(
  session: Session | null,
  online: boolean,
): InboxSummary {
  const operator = !!session && OPERATORS.includes(session.role);
  const [stopped, setStopped] = useState(false);
  const scope = session ? session.tenantId + ":" + session.id : "";
  useEffect(() => {
    emit(EMPTY);
    setStopped(false);
  }, [scope]);
  const current = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const poll = usePoll(
    async () => {
      try {
        const next = await api<InboxSummary>("/ordering/inbox/summary");
        emit(next);
        if (!next.available) setStopped(true);
      } catch (e) {
        if (QUIET.has((e as Error).message)) return;
        throw e;
      }
    },
    {
      intervalMs: current.active || current.pending > 0 ? 20_000 : 300_000,
      maxBackoffMs: 300_000,
      enabled: operator && online && !stopped,
    },
    [scope],
  );
  refresher = poll.refresh;
  return operator ? current : EMPTY;
}
