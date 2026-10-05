import { z } from "zod";

/** Pure access rules shared by the server and the client (no I/O). */
export type DeviceKind = "terminal" | "personal";
export type EndReason =
  | "logout"
  | "switched"
  | "replaced"
  | "pin_reset"
  | "role_changed"
  | "employee_deactivated"
  | "device_revoked"
  | "ended_by_manager";

/** Session lifecycle details sent to the client with every Session. */
export type SessionAccess = {
  /** null = legacy session (fixed expiry, no sliding). */
  absoluteExpiresAt: string | null;
  authenticatedAt: string | null;
  deviceName: string;
  deviceKind: DeviceKind;
  /** Effective auto-lock in seconds; null = never lock. */
  idleLockSeconds: number | null;
  /** The session was entered through a Google owner account. */
  ownerAccount: boolean;
};

export const ACCESS = {
  sessionIdleMinutes: 480,
  sessionAbsoluteHours: 16,
  touchSeconds: 60,
  offlineWindowHours: 4,
  offlineRenewMinutes: 15,
  deviceTokenDays: 30,
  pairingCodeMinutes: 10,
  maxOpenPairingCodes: 5,
  defaultStepUpSeconds: 120,
  reuseMinRemainingMinutes: 30,
  expiryWarningMinutes: 30,
  defaultIdleLockSeconds: 180,
  idleLockChoices: [0, 60, 120, 180, 300, 600, 900] as const,
  pin: {
    firstStage: 5,
    laterStage: 3,
    baseLockMinutes: 5,
    maxLockMinutes: 60,
    decayHours: 12,
    hardLockFailures: 100,
  },
} as const;

/** Crockford base32: no I, L, O or U, so codes read aloud unambiguously. */
export const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_CODE_LENGTH = 8;
/** New and reset PINs: 6 to 8 digits. Older 4+ character secrets keep working. */
export const pinInput = z.string().regex(/^\d{6,8}$/);

/**
 * Accepts what people type: lower case, spaces, hyphens, and the look-alikes
 * O→0 and I/L→1. Returns the canonical 8-character code or null.
 */
export function normalizePairingCode(raw: string): string | null {
  const code = raw
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (const char of code) if (!PAIRING_ALPHABET.includes(char)) return null;
  return code;
}

/** "K7QM4TZP" → "K7QM-4TZP". */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export type PinState = {
  failures: number;
  lockLevel: number;
  lockedUntil: Date | null;
  lastFailureAt: Date | null;
};
export const emptyPinState = (): PinState => ({
  failures: 0,
  lockLevel: 0,
  lockedUntil: null,
  lastFailureAt: null,
});

export function isPinLocked(s: PinState, now: Date): boolean {
  return s.lockedUntil !== null && s.lockedUntil.getTime() > now.getTime();
}

/** After 12 h without failures (and no active lock) the throttle starts over. */
export function decayPinState(s: PinState, now: Date): PinState {
  if (isPinLocked(s, now)) return s;
  if (
    s.lastFailureAt &&
    s.lastFailureAt.getTime() <=
      now.getTime() - ACCESS.pin.decayHours * 3600_000
  )
    return emptyPinState();
  return s;
}

/**
 * One more wrong PIN. The first stage allows 5 failures, later stages 3; each
 * stage lock doubles from 5 minutes up to a 60-minute cap (OWASP exponential
 * lockout, bounded so it never becomes a permanent denial of service).
 */
export function failPinState(
  s: PinState,
  now: Date,
): PinState & { lockedNow: boolean } {
  const failures = s.failures + 1;
  const threshold =
    s.lockLevel === 0 ? ACCESS.pin.firstStage : ACCESS.pin.laterStage;
  if (failures < threshold)
    return { ...s, failures, lastFailureAt: now, lockedNow: false };
  const lockLevel = s.lockLevel + 1;
  const minutes = Math.min(
    ACCESS.pin.baseLockMinutes * 2 ** (lockLevel - 1),
    ACCESS.pin.maxLockMinutes,
  );
  return {
    failures: 0,
    lockLevel,
    lockedUntil: new Date(now.getTime() + minutes * 60_000),
    lastFailureAt: now,
    lockedNow: true,
  };
}

/**
 * A session entered through a Google owner account on that person's own
 * personal device. Only these skip step-up and the default auto-lock: the
 * exemption follows how the session was entered, never the device kind alone,
 * because legacy "Owner browser" devices can be shared tablets where staff
 * sign in with a PIN (A4).
 */
export function stepUpExempt(access: SessionAccess | undefined): boolean {
  return !access || (access.deviceKind === "personal" && access.ownerAccount);
}

/**
 * Device setting wins; otherwise PIN sessions lock after the default (3 min,
 * or ACCESS_IDLE_LOCK_DEFAULT_SECONDS on the server, 0 = never) on any device;
 * kitchen sessions and Google-entered sessions on a personal device never.
 */
export function effectiveIdleLock(
  setting: number | null,
  role: string,
  kind: DeviceKind,
  defaultSeconds: number = ACCESS.defaultIdleLockSeconds,
  ownerAccount = false,
): number | null {
  if (setting === 0) return null;
  if (setting !== null && setting > 0) return setting;
  if (
    (kind === "personal" && ownerAccount) ||
    role === "kitchen" ||
    defaultSeconds <= 0
  )
    return null;
  return defaultSeconds;
}

/**
 * Step-up rule. Internal callers (no access details) and Google-entered
 * sessions on a personal device pass; every PIN session, on a terminal or on a
 * legacy "Owner browser" device, needs a PIN or Google verification within the
 * window (A4).
 */
export function isRecentAuth(
  access: SessionAccess | undefined,
  nowMs: number,
  maxAgeSeconds: number,
): boolean {
  if (stepUpExempt(access)) return true;
  if (!access) return true;
  if (!access.authenticatedAt) return false;
  return nowMs - new Date(access.authenticatedAt).getTime() <= maxAgeSeconds * 1000;
}

// Wire types shared by the access routes and the client screens ----------

export type TerminalState = {
  paired: boolean;
  google: boolean;
  demo: { tenantId: string; login: "owner" } | null;
  device?: {
    id: string;
    name: string;
    kind: DeviceKind;
    idleLockSeconds: number | null;
  };
  restaurant?: { name: string };
  staff?: TerminalStaff[];
};
export type TerminalStaff = {
  id: string;
  name: string;
  role: string;
  lockedUntil: string | null;
  hardLocked: boolean;
};
export type StaffRow = {
  id: string;
  name: string;
  login: string;
  role: string;
  active: boolean;
  access: "pin" | "google" | "google_and_pin" | "none";
  freeSlot: number | null;
  locked: { devices: number; until: string | null; hard: boolean };
  lastSignInAt: string | null;
  pinSetAt: string | null;
  deactivatedAt: string | null;
  isSelf: boolean;
  /**
   * Active devices this employee paired. Deactivation unpairs the personal
   * ones; terminals stay paired for the owner to review (ACC-R6-2).
   */
  pairedDevices: {
    id: string;
    name: string;
    kind: DeviceKind;
    current: boolean;
  }[];
};
export type ManagedDevice = {
  id: string;
  name: string;
  kind: DeviceKind;
  status: "active" | "revoked" | "expired";
  pairedAt: string | null;
  pairedBy: string | null;
  lastSeenAt: string | null;
  tokenExpiresAt: string | null;
  idleLockSeconds: number | null;
  freeSlot: boolean;
  current: boolean;
  liveSession: { employeeName: string; since: string } | null;
  openDrawer: boolean;
  sharedWarning: boolean;
  revokedAt: string | null;
  revokedBy: string | null;
};
export type PairingCodeRow = {
  id: string;
  deviceName: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  state: "open" | "consumed" | "cancelled" | "expired";
  deviceId: string | null;
};
export type Approver = { id: string; name: string; role: string };
