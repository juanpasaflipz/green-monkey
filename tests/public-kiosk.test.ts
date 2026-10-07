import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleController } from "../src/features/public/kioskIdle";
import { KIOSK_TIMING } from "../shared/public-ordering";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const controller = (dirty: boolean) => {
  const onWarn = vi.fn();
  const onReset = vi.fn();
  const c = createIdleController({
    warnAfterMs: KIOSK_TIMING.warnAfterMs,
    resetAfterMs: KIOSK_TIMING.resetAfterMs,
    dirty: () => dirty,
    onWarn,
    onReset,
  });
  return { c, onWarn, onReset };
};

describe("kiosk idle reset", () => {
  it("14. with a cart, warns at 75 s and resets at 90 s", () => {
    const { onWarn, onReset } = controller(true);
    vi.advanceTimersByTime(74_999);
    expect(onWarn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onReset).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15_000);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("15. activity at 80 s cancels the pending reset and arms again", () => {
    const { c, onWarn, onReset } = controller(true);
    vi.advanceTimersByTime(80_000);
    expect(onWarn).toHaveBeenCalledTimes(1);
    c.activity();
    vi.advanceTimersByTime(20_000);
    expect(onReset).not.toHaveBeenCalled();
    vi.advanceTimersByTime(55_000);
    expect(onWarn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(15_000);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("16. with an empty cart there is no warning; the reset (menu refetch) runs every 90 s", () => {
    const { onWarn, onReset } = controller(false);
    vi.advanceTimersByTime(90_000);
    expect(onWarn).not.toHaveBeenCalled();
    expect(onReset).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(90_000);
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it("17. the done screen resets at 20 s", () => {
    const onReset = vi.fn();
    createIdleController({
      resetAfterMs: KIOSK_TIMING.doneResetMs,
      onReset,
    });
    vi.advanceTimersByTime(19_999);
    expect(onReset).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("18. dispose clears every timer", () => {
    const { c, onWarn, onReset } = controller(true);
    vi.advanceTimersByTime(10_000);
    c.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(200_000);
    expect(onWarn).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
    c.activity();
    expect(vi.getTimerCount()).toBe(0);
  });
});
