import { useEffect, useRef } from "react";

const ACTIVITY = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

/**
 * Calls onIdle after `seconds` without pointer, touch, key or wheel input.
 * One setTimeout, reset on every input event and cleared when the lock is
 * disabled (null seconds) or inactive (already locked / signed out).
 */
export function useIdleLock(
  seconds: number | null,
  active: boolean,
  onIdle: () => void,
) {
  const callback = useRef(onIdle);
  useEffect(() => {
    callback.current = onIdle;
  }, [onIdle]);
  useEffect(() => {
    if (!seconds || !active) return;
    const fire = () => callback.current();
    let timer = setTimeout(fire, seconds * 1000);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(fire, seconds * 1000);
    };
    for (const event of ACTIVITY)
      window.addEventListener(event, reset, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const event of ACTIVITY) window.removeEventListener(event, reset);
    };
  }, [seconds, active]);
}
