// Kiosk device helpers (039, §2.11), each feature-detected and never throwing: fullscreen on a
// user gesture, a screen wake lock re-requested when the page is visible again, the heartbeat and
// the reload when a new build ships. MDN: a wake lock is released when the document is hidden and
// a released sentinel cannot be reused, so a new one is requested on visibilitychange.

/** Fullscreen with the system navigation hidden; only from a user gesture (the welcome tap). */
export function enterFullscreen(doc: Document = document): void {
  const el = doc.documentElement as HTMLElement & {
    requestFullscreen?: (o?: FullscreenOptions) => Promise<void>;
  };
  if (!el.requestFullscreen || doc.fullscreenElement) return;
  el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
}

type Sentinel = { release(): Promise<void> };
/** Holds a screen wake lock while `active()`; returns the cleanup. */
export function keepAwake(
  active: () => boolean,
  nav: Navigator = navigator,
  doc: Document = document,
): () => void {
  const wl = (
    nav as Navigator & {
      wakeLock?: { request(t: "screen"): Promise<Sentinel> };
    }
  ).wakeLock;
  if (!wl) return () => {};
  let sentinel: Sentinel | null = null;
  let disposed = false;
  const acquire = () => {
    if (disposed || sentinel || doc.visibilityState !== "visible" || !active())
      return;
    wl.request("screen")
      .then((s) => {
        if (disposed) void s.release().catch(() => {});
        else sentinel = s;
      })
      .catch(() => {});
  };
  const onVisible = () => {
    sentinel = null;
    acquire();
  };
  doc.addEventListener("visibilitychange", onVisible);
  acquire();
  return () => {
    disposed = true;
    doc.removeEventListener("visibilitychange", onVisible);
    void sentinel?.release().catch(() => {});
  };
}

export const viewportClass = (
  w: number,
  h: number,
): "landscape" | "portrait" => (w >= h ? "landscape" : "portrait");

/**
 * Every `everyMs` while visible: `beat()` (the heartbeat), then the deployed build from
 * /api/version; a new build reloads the page when `idle()` says the kiosk is on its welcome
 * screen with an empty cart (pos-lite's kioskUpdate watcher, §2.11).
 */
export function watchDevice(o: {
  everyMs: number;
  beat: () => Promise<unknown>;
  idle: () => boolean;
  reload: () => void;
  fetchVersion?: () => Promise<string | null>;
  doc?: Document;
}): () => void {
  const doc = o.doc ?? document;
  const version =
    o.fetchVersion ??
    (() =>
      fetch("/api/version", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((v: { commit?: string } | null) => v?.commit ?? null)
        .catch(() => null));
  let first: string | null = null;
  let stale = false;
  const tick = async () => {
    if (doc.visibilityState !== "visible") return;
    await o.beat().catch(() => {});
    const now = await version();
    if (now && first === null) first = now;
    else if (now && now !== first) stale = true;
    if (stale && o.idle()) o.reload();
  };
  void tick();
  const timer = setInterval(() => void tick(), o.everyMs);
  return () => clearInterval(timer);
}
