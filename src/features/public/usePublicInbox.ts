import { useEffect, useSyncExternalStore } from "react";
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

/**
 * The inbox read "not available" (the kill switch): the badge and the banner
 * go at once; the summary poll keeps its idle pace and brings them back when
 * ordering returns (PUBLIC-OPS-1).
 */
export function setPublicInboxUnavailable() {
  if (state.available || state.active || state.pending) emit(EMPTY);
}

/** The inbox's own reading wins between summary polls. */
export function setPublicInboxPending(pending: number, active?: boolean) {
  const next = {
    ...state,
    available: true,
    pending,
    active: active ?? state.active,
  };
  if (
    next.pending !== state.pending ||
    next.active !== state.active ||
    !state.available
  )
    emit(next);
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
 * link is active), only while visible and online. "Not available" (the kill
 * switch, a Free plan) never stops it for good: it keeps the 5-minute idle
 * pace, so a terminal follows the switch back on without a reload
 * (PUBLIC-OPS-1). The session answers in QUIET wait silently for the next
 * session.
 */
export function usePublicInbox(
  session: Session | null,
  online: boolean,
): InboxSummary {
  const operator = !!session && OPERATORS.includes(session.role);
  const scope = session ? session.tenantId + ":" + session.id : "";
  useEffect(() => {
    emit(EMPTY);
  }, [scope]);
  const current = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const poll = usePoll(
    async () => {
      try {
        emit(await api<InboxSummary>("/ordering/inbox/summary"));
      } catch (e) {
        if (QUIET.has((e as Error).message)) return;
        throw e;
      }
    },
    {
      intervalMs: current.active || current.pending > 0 ? 20_000 : 300_000,
      maxBackoffMs: 300_000,
      enabled: operator && online,
    },
    [scope],
  );
  refresher = poll.refresh;
  return operator ? current : EMPTY;
}
