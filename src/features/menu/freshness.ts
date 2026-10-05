import type { Product } from "../../../shared/domain";

/** How often a selling terminal asks whether the menu changed (FOH-8). */
export const MENU_POLL_MS = 60_000;
/** Window event any feature dispatches to force a catalog refetch. */
export const MENU_REFRESH_EVENT = "gm-menu-refresh";

type Listeners = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export type MenuFreshness<T = Product[]> = {
  /** GET /menu/revision (POS) or /public/:token/revision (QR/kiosk). */
  revision: () => Promise<number>;
  /** GET /catalog (POS) or the public catalog payload (QR/kiosk). */
  catalog: () => Promise<T>;
  /**
   * Shows and caches a fresh catalog. It must not touch the cached session:
   * access's heartbeat owns that entry (contract D15), and a copy captured
   * when polling started would overwrite a renewed offline window.
   */
  apply: (catalog: T) => void | Promise<void>;
  /**
   * Revision the shown catalog is known to include, kept across restarts of
   * the watcher (view changes) for one session scope.
   */
  baseline: { get: () => number | null; set: (revision: number) => void };
  win: Listeners;
  doc: Listeners & { readonly visibilityState: DocumentVisibilityState };
  every?: number;
};

/**
 * Keeps the POS catalog fresh while selling: polls the menu revision every
 * minute and when the terminal becomes visible or focused, refetching the
 * catalog only when the revision moved. The first check of a scope always
 * refetches once, because the catalog shown may predate that first revision
 * read (a change can land between the catalog fetch and the first poll).
 * MENU_REFRESH_EVENT refetches without asking. Errors are ignored; the next
 * tick retries. Returns the cleanup function.
 */
export function watchMenuRevision<T = Product[]>(
  d: MenuFreshness<T>,
): () => void {
  let live = true;
  const refetch = async () => {
    const c = await d.catalog();
    if (live) await d.apply(c);
    return live;
  };
  const check = async () => {
    try {
      const revision = await d.revision();
      if (!live) return;
      const known = d.baseline.get();
      if (known === revision) return;
      // The baseline moves only once the catalog that includes it is shown.
      if (await refetch()) d.baseline.set(revision);
    } catch {
      /* The next tick, focus or refresh event retries. */
    }
  };
  const refresh = () => void refetch().catch(() => {});
  const visible = () => {
    if (d.doc.visibilityState === "visible") void check();
  };
  void check();
  const timer = setInterval(() => void check(), d.every ?? MENU_POLL_MS);
  d.win.addEventListener("focus", visible);
  d.doc.addEventListener("visibilitychange", visible);
  d.win.addEventListener(MENU_REFRESH_EVENT, refresh);
  return () => {
    live = false;
    clearInterval(timer);
    d.win.removeEventListener("focus", visible);
    d.doc.removeEventListener("visibilitychange", visible);
    d.win.removeEventListener(MENU_REFRESH_EVENT, refresh);
  };
}

const baselines = new Map<string, number>();
/** Per-scope baseline (tenant, device and employee), kept for the page's life. */
export function menuBaseline(scope: string): MenuFreshness["baseline"] {
  return {
    get: () => baselines.get(scope) ?? null,
    set: (revision) => void baselines.set(scope, revision),
  };
}
