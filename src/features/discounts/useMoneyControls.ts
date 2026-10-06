import { useSyncExternalStore } from "react";
import type { Session } from "../../../shared/domain";
import type { MoneyControlsView } from "../../../shared/discounts";
import { api } from "../../api";

/**
 * The restaurant's money controls (discount limits, blind count, who sees
 * expected cash and who closes), loaded once per session and after saving.
 * The server stays authoritative: a stale copy only changes whether a dialog
 * shows the manager approval first.
 */
let current: { key: string; view: MoneyControlsView } | null = null;
let loading: { key: string; promise: Promise<MoneyControlsView> } | null =
  null;
const listeners = new Set<() => void>();
const keyOf = (s: Session) => `${s.tenantId}:${s.id}`;
function emit() {
  for (const listener of listeners) listener();
}

/** Fetches the controls for this session unless they are already loaded. */
export function loadMoneyControls(
  session: Session,
  force = false,
): Promise<MoneyControlsView> {
  const key = keyOf(session);
  if (!force && current?.key === key) return Promise.resolve(current.view);
  if (!force && loading?.key === key) return loading.promise;
  const promise = api<MoneyControlsView>("/discounts/controls").then(
    (view) => {
      if (keyOf(session) === key) setMoneyControls(view, session);
      return view;
    },
  );
  loading = { key, promise };
  promise.finally(() => {
    if (loading?.promise === promise) loading = null;
  });
  return promise;
}
export function setMoneyControls(view: MoneyControlsView, session: Session) {
  current = { key: keyOf(session), view };
  emit();
}
export function clearMoneyControls() {
  current = null;
  loading = null;
  emit();
}
/** The controls of this session, or null until loaded (call loadMoneyControls). */
export function useMoneyControls(session: Session): MoneyControlsView | null {
  const key = keyOf(session);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (current?.key === key ? current.view : null),
    () => null,
  );
}
