import { useEffect, useRef } from "react";

type Timer = ReturnType<typeof setTimeout>;

/**
 * Kiosk inactivity: after `warnAfterMs` of no activity `onWarn` runs (only
 * while `dirty()` says there is something to lose), and after `resetAfterMs`
 * `onReset` runs and the timers arm again (an idle kiosk keeps refreshing
 * its menu). Any `activity()` restarts both. Pure and injectable for fake
 * timers; `dispose()` clears everything.
 */
export function createIdleController(o: {
  warnAfterMs?: number | null;
  resetAfterMs: number;
  onWarn?: () => void;
  onReset: () => void;
  dirty?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}) {
  const set = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = o.clearTimer ?? ((t) => clearTimeout(t));
  let warn: Timer | null = null;
  let reset: Timer | null = null;
  let live = true;
  const stop = () => {
    if (warn) clear(warn);
    if (reset) clear(reset);
    warn = reset = null;
  };
  const arm = () => {
    stop();
    if (!live) return;
    if (o.warnAfterMs != null && o.onWarn)
      warn = set(() => {
        warn = null;
        if (o.dirty?.() ?? true) o.onWarn?.();
      }, o.warnAfterMs);
    reset = set(() => {
      reset = null;
      o.onReset();
      arm();
    }, o.resetAfterMs);
  };
  arm();
  return {
    activity: arm,
    dispose() {
      live = false;
      stop();
    },
  };
}

/**
 * Binds a controller to pointerdown/keydown on the window while `enabled`.
 * The callbacks are read through refs, so they always see current state.
 */
export function useKioskIdle(
  enabled: boolean,
  timing: { warnAfterMs?: number | null; resetAfterMs: number },
  handlers: { dirty: () => boolean; onWarn?: () => void; onReset: () => void },
) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const control = useRef<ReturnType<typeof createIdleController> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const c = createIdleController({
      warnAfterMs: timing.warnAfterMs,
      resetAfterMs: timing.resetAfterMs,
      dirty: () => ref.current.dirty(),
      onWarn: () => ref.current.onWarn?.(),
      onReset: () => ref.current.onReset(),
    });
    control.current = c;
    const activity = () => c.activity();
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    return () => {
      c.dispose();
      control.current = null;
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
    };
  }, [enabled, timing.warnAfterMs, timing.resetAfterMs]);
  return { activity: () => control.current?.activity() };
}
