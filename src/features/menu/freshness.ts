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
  /**
   * Up to this many ms are taken off each wait at random (at most half of
   * `every`), so pages opened together do not poll in step. A change still
   * shows within `every`.
   */
  jitter?: number;
  /** A focus or visibility check this soon after the last check is skipped. */
  minGap?: number;
  /**
   * While this returns false the poll and the focus and visibility checks are
   * skipped; MENU_REFRESH_EVENT still refetches.
   */
  active?: () => boolean;
  /** Test seam for the jitter; Math.random by default. */
  random?: () => number;
};

/**
 * QR/kiosk pages (MENU-R1): every diner on a venue's Wi-Fi shares one IP, so
 * open pages spread their polls, collapse focus bursts and stop once hidden or
 * once the order is sent. The server gives the poll its own small budget.
 */
export const PUBLIC_MENU_POLL = { jitter: 10_000, minGap: 15_000 } as const;

/**
 * Keeps the POS catalog fresh while selling: polls the menu revision every
 * minute and when the terminal becomes visible or focused, refetching the
 * catalog only when the revision moved. The first check of a scope always
 * refetches once, because the catalog shown may predate that first revision
 * read (a change can land between the catalog fetch and the first poll).
 * MENU_REFRESH_EVENT refetches without asking. Errors are ignored; the next
 * tick retries. QR/kiosk pages also pass `jitter`, `minGap` and `active`
 * (PUBLIC_MENU_POLL); the POS keeps the plain minute poll. Returns the
 * cleanup function.
 */
export function watchMenuRevision<T = Product[]>(
  d: MenuFreshness<T>,
): () => void {
  let live = true;
  const every = d.every ?? MENU_POLL_MS;
  const jitter = Math.min(Math.max(d.jitter ?? 0, 0), every / 2);
  const active = d.active ?? (() => true);
  let lastCheck = -Infinity;
  const refetch = async () => {
    const c = await d.catalog();
    if (live) await d.apply(c);
    return live;
  };
  const check = async () => {
    lastCheck = Date.now();
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
    if (
      d.doc.visibilityState === "visible" &&
      active() &&
      Date.now() - lastCheck >= (d.minGap ?? 0)
    )
      void check();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(
      () => {
        if (!live) return;
        schedule();
        if (active()) void check();
      },
      every - Math.floor((d.random ?? Math.random)() * jitter),
    );
  };
  if (active()) void check();
  schedule();
  d.win.addEventListener("focus", visible);
  d.doc.addEventListener("visibilitychange", visible);
  d.win.addEventListener(MENU_REFRESH_EVENT, refresh);
  return () => {
    live = false;
    clearTimeout(timer);
    d.win.removeEventListener("focus", visible);
    d.doc.removeEventListener("visibilitychange", visible);
    d.win.removeEventListener(MENU_REFRESH_EVENT, refresh);
  };
}

/**
 * Moves a page's baseline forward to a revision its shown catalog includes.
 * Revisions only grow, so an older value (a poll read before a later catalog
 * payload) never moves it back; a missing revision leaves it as it is.
 */
export function advanceBaseline(
  ref: { current: number | null },
  revision: number | undefined,
): void {
  if (typeof revision === "number")
    ref.current = Math.max(ref.current ?? revision, revision);
}

const baselines = new Map<string, number>();
/** Per-scope baseline (tenant, device and employee), kept for the page's life. */
export function menuBaseline(scope: string): MenuFreshness["baseline"] {
  return {
    get: () => baselines.get(scope) ?? null,
    set: (revision) => void baselines.set(scope, revision),
  };
}
