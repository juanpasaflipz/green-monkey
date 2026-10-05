import { useEffect, useRef } from "react";

const ACTIVITY = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

/**
 * Calls onIdle after `seconds` without pointer, touch, key or wheel input.
 * One setTimeout, reset on every input event and cleared when the lock is
 * disabled (null seconds) or inactive (already locked / signed out). Each
 * input also calls onActivity, so a reload can tell how long the device sat idle.
 * onIdle may return a number of milliseconds to wait before it is asked again
 * (another tab of the same session is still in use, ACC-21).
 */
export function useIdleLock(
  seconds: number | null,
  active: boolean,
  onIdle: () => number | void,
  onActivity?: () => void,
) {
  const callback = useRef(onIdle);
  const activity = useRef(onActivity);
  useEffect(() => {
    callback.current = onIdle;
    activity.current = onActivity;
  }, [onIdle, onActivity]);
  useEffect(() => {
    if (!seconds || !active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(fire, ms);
    };
    const fire = () => {
      const wait = callback.current();
      if (typeof wait === "number" && wait > 0) arm(wait);
    };
    arm(seconds * 1000);
    const reset = () => {
      arm(seconds * 1000);
      activity.current?.();
    };
    for (const event of ACTIVITY)
      window.addEventListener(event, reset, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const event of ACTIVITY) window.removeEventListener(event, reset);
    };
  }, [seconds, active]);
}
