import { describe, expect, it } from "vitest";
import { translateError } from "../src/i18n";
import {
  ACCESS,
  decayPinState,
  effectiveIdleLock,
  emptyPinState,
  failPinState,
  formatPairingCode,
  isPinLocked,
  isRecentAuth,
  stepUpExempt,
  normalizePairingCode,
  pinInput,
  type PinState,
  type SessionAccess,
} from "../shared/access";

const minutes = (s: PinState, now: Date) =>
  Math.round((s.lockedUntil!.getTime() - now.getTime()) / 60_000);

describe("pairing codes", () => {
  it("normalizes pairing codes (case, spaces, hyphens, O→0, I/L→1) and rejects other characters or lengths", () => {
    expect(normalizePairingCode("k7qm-4tzp")).toBe("K7QM4TZP");
    expect(normalizePairingCode("  K7QM 4TZP ")).toBe("K7QM4TZP");
    expect(normalizePairingCode("OOII-LLoo")).toBe("00111100");
    expect(normalizePairingCode("K7QM4TZ")).toBeNull();
    expect(normalizePairingCode("K7QM4TZPX")).toBeNull();
    // U is not part of Crockford base32 and is not silently mapped.
    expect(normalizePairingCode("K7QM4TZU")).toBeNull();
    expect(normalizePairingCode("K7QM_4TZP")).toBeNull();
    expect(normalizePairingCode("")).toBeNull();
  });

  it("formats pairing codes as XXXX-XXXX", () => {
    expect(formatPairingCode("K7QM4TZP")).toBe("K7QM-4TZP");
  });
});

describe("PIN throttle", () => {
  const start = new Date("2026-10-04T20:00:00Z");

  it("PIN throttle: 4 failures do not lock, the 5th locks 5 min (SEC-2)", () => {
    let s: PinState = emptyPinState();
    for (let i = 0; i < 4; i++) {
      const next = failPinState(s, start);
      expect(next.lockedNow).toBe(false);
      s = next;
    }
    expect(isPinLocked(s, start)).toBe(false);
    expect(s.failures).toBe(4);
    const locked = failPinState(s, start);
    expect(locked.lockedNow).toBe(true);
    expect(locked.lockLevel).toBe(1);
    expect(locked.failures).toBe(0);
    expect(minutes(locked, start)).toBe(5);
  });

  it("PIN throttle: later stages allow 3 failures and back off 10, 20, 40, 60, 60 min", () => {
    let now = start;
    let s: PinState = emptyPinState();
    for (let i = 0; i < ACCESS.pin.firstStage; i++) s = failPinState(s, now);
    expect(minutes(s, now)).toBe(5);
    const expected = [10, 20, 40, 60, 60];
    for (const lock of expected) {
      now = new Date(s.lockedUntil!.getTime() + 1000);
      s = decayPinState(s, now);
      expect(isPinLocked(s, now)).toBe(false);
      const one = failPinState(s, now);
      const two = failPinState(one, now);
      expect(one.lockedNow || two.lockedNow).toBe(false);
      const three = failPinState(two, now);
      expect(three.lockedNow).toBe(true);
      expect(minutes(three, now)).toBe(lock);
      s = three;
    }
    expect(s.lockLevel).toBe(6);
  });

  it("PIN throttle decays after 12 h without failures (SEC-2 regression: no permanent one-typo relock)", () => {
    let s: PinState = emptyPinState();
    for (let i = 0; i < 5; i++) s = failPinState(s, start);
    expect(s.lockLevel).toBe(1);
    // Still locked: decay never shortens an active lock.
    expect(decayPinState(s, new Date(start.getTime() + 60_000))).toBe(s);
    // 11 h later the stage is remembered, so 3 failures relock.
    const soon = decayPinState(s, new Date(start.getTime() + 11 * 3600_000));
    expect(soon.lockLevel).toBe(1);
    // 12 h after the last failure a single typo no longer relocks.
    const later = new Date(start.getTime() + 12 * 3600_000);
    const fresh = decayPinState(s, later);
    expect(fresh).toEqual(emptyPinState());
    expect(failPinState(fresh, later).lockedNow).toBe(false);
  });

  it("accepts only 6 to 8 digit PINs for new and reset PINs", () => {
    expect(pinInput.safeParse("123456").success).toBe(true);
    expect(pinInput.safeParse("12345678").success).toBe(true);
    expect(pinInput.safeParse("12345").success).toBe(false);
    expect(pinInput.safeParse("123456789").success).toBe(false);
    expect(pinInput.safeParse("12345a").success).toBe(false);
  });
});

describe("shared-terminal rules", () => {
  it("effective idle lock: default 180 s for PIN sessions, never for kitchen and Google-entered personal sessions, explicit 0 means never", () => {
    expect(effectiveIdleLock(null, "cashier", "terminal")).toBe(180);
    expect(effectiveIdleLock(null, "owner", "terminal")).toBe(180);
    expect(effectiveIdleLock(null, "kitchen", "terminal")).toBeNull();
    expect(effectiveIdleLock(null, "owner", "personal", 180, true)).toBeNull();
    // A4: a PIN session on a personal (legacy "Owner browser") device locks.
    expect(effectiveIdleLock(null, "manager", "personal")).toBe(180);
    expect(effectiveIdleLock(null, "owner", "personal", 180, false)).toBe(180);
    expect(effectiveIdleLock(null, "owner", "terminal", 180, true)).toBe(180);
    expect(effectiveIdleLock(0, "cashier", "terminal")).toBeNull();
    expect(effectiveIdleLock(600, "kitchen", "terminal")).toBe(600);
    expect(effectiveIdleLock(60, "owner", "personal")).toBe(60);
    // ACCESS_IDLE_LOCK_DEFAULT_SECONDS changes only the default (0 = never).
    expect(effectiveIdleLock(null, "cashier", "terminal", 0)).toBeNull();
    expect(effectiveIdleLock(null, "cashier", "terminal", 300)).toBe(300);
    expect(effectiveIdleLock(180, "cashier", "terminal", 0)).toBe(180);
  });

  it("recent auth: personal devices and internal sessions pass, terminals need authentication within the window", () => {
    const now = Date.parse("2026-10-04T20:00:00Z");
    const terminal: SessionAccess = {
      absoluteExpiresAt: null,
      authenticatedAt: new Date(now - 60_000).toISOString(),
      deviceName: "Caja 1",
      deviceKind: "terminal",
      idleLockSeconds: 180,
      ownerAccount: false,
    };
    expect(isRecentAuth(undefined, now, 120)).toBe(true);
    expect(isRecentAuth(terminal, now, 120)).toBe(true);
    expect(isRecentAuth(terminal, now, 30)).toBe(false);
    expect(
      isRecentAuth({ ...terminal, authenticatedAt: null }, now, 120),
    ).toBe(false);
    expect(
      isRecentAuth(
        {
          ...terminal,
          deviceKind: "personal",
          ownerAccount: true,
          authenticatedAt: null,
        },
        now,
        120,
      ),
    ).toBe(true);
    // A4: the exemption follows how the session was entered, not the device.
    expect(
      isRecentAuth(
        { ...terminal, deviceKind: "personal", authenticatedAt: null },
        now,
        120,
      ),
    ).toBe(false);
    expect(
      isRecentAuth(
        { ...terminal, deviceKind: "personal", authenticatedAt: new Date(now - 600_000).toISOString() },
        now,
        120,
      ),
    ).toBe(false);
    expect(
      isRecentAuth({ ...terminal, ownerAccount: true, authenticatedAt: null }, now, 120),
    ).toBe(false);
    expect(stepUpExempt(undefined)).toBe(true);
    expect(stepUpExempt({ ...terminal, deviceKind: "personal", ownerAccount: true })).toBe(true);
    expect(stepUpExempt({ ...terminal, deviceKind: "personal" })).toBe(false);
  });
});

describe("access error copy", () => {
  it("too_many_attempts blames no network: limits count per device, restaurant and IP, or session (ACC-R6-5)", () => {
    expect(translateError("too_many_attempts", "es")).toBe(
      "Demasiados intentos. Espera un minuto e inténtalo de nuevo.",
    );
    expect(translateError("too_many_attempts", "en")).toBe(
      "Too many attempts. Wait a minute and try again.",
    );
  });
});
