import { useEffect, useRef } from "react";

const ACTIVITY = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

/**
 * Calls onIdle after `seconds` without pointer, touch, key or wheel input.
 * One setTimeout, reset on every input event and cleared when the lock is
 * disabled (null seconds) or inactive (already locked / signed out). Each
 * input also calls onActivity, so a reload can tell how long the device sat idle.
 */
export function useIdleLock(
  seconds: number | null,
  active: boolean,
  onIdle: () => void,
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
    const fire = () => callback.current();
    let timer = setTimeout(fire, seconds * 1000);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(fire, seconds * 1000);
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
