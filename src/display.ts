// Per-device display settings («Pantalla» in Vender; kiosk 039, specs/kiosk-w4.md §2.9). Kept in
// localStorage "gm-display-settings" like the print settings: a choice made on one tablet never
// follows the employee to a phone. `gridPhotos: null` means the device kind's default.
import { useSyncExternalStore } from "react";
import type { DeviceKind } from "../shared/access";

export type DisplaySettings = {
  /** Product photos on the selling grid; null follows the device kind. */
  gridPhotos: boolean | null;
};
const KEY = "gm-display-settings";
const defaults: DisplaySettings = { gridPhotos: null };

/** Parses the stored value (anything unexpected reads as the defaults). */
export function parseDisplaySettings(raw: string | null): DisplaySettings {
  try {
    const v = JSON.parse(raw ?? "null");
    if (!v || typeof v !== "object") return defaults;
    return {
      gridPhotos: typeof v.gridPhotos === "boolean" ? v.gridPhotos : null,
    };
  } catch {
    return defaults;
  }
}

/**
 * Grid photos on this device: the explicit choice, else on for a shared terminal and off for a
 * personal device (a phone's small tiles and mobile data), §2.9.
 */
export function gridPhotosOn(
  settings: DisplaySettings,
  deviceKind: DeviceKind | undefined,
): boolean {
  return settings.gridPhotos ?? deviceKind !== "personal";
}

function read(): DisplaySettings {
  try {
    return parseDisplaySettings(localStorage.getItem(KEY));
  } catch {
    return defaults;
  }
}
let current: DisplaySettings | null = null;
const listeners = new Set<() => void>();
function snapshot() {
  return (current ??= read());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    current = read();
    listener();
  };
  window.addEventListener("storage", storage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", storage);
  };
}
export function saveDisplaySettings(patch: Partial<DisplaySettings>) {
  current = { ...snapshot(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* Storage blocked: the setting lasts for this page only. */
  }
  for (const listener of listeners) listener();
}
export function useDisplaySettings(): [
  DisplaySettings,
  (p: Partial<DisplaySettings>) => void,
] {
  const settings = useSyncExternalStore(subscribe, snapshot, () => defaults);
  return [settings, saveDisplaySettings];
}
