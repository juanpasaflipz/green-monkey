import type { Tx } from "./db.js";
import { permit, operators } from "./auth.js";
import { DomainError, type Session } from "../shared/domain.js";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXY".split("");
/** A..Y, then A1..Y1, ..., A9..Y9: 250 server-assignable prefixes. "Z" is reserved. */
export const OFFLINE_PREFIXES = [
  ...LETTERS,
  ...Array.from({ length: 9 }, (_, i) => LETTERS.map((l) => l + (i + 1))).flat(),
];

/**
 * Returns this device's provisional-number prefix, assigning the first free one
 * under a per-tenant advisory lock. A set prefix is immutable (DB trigger).
 */
export async function offlineDevicePrefix(
  tx: Tx,
  s: Session,
): Promise<{ deviceId: string; prefix: string }> {
  permit(s, operators);
  const [known] =
    await tx`select offline_prefix from devices where id=${s.deviceId}`;
  if (!known) throw new DomainError("not_found", 404);
  if (known.offline_prefix)
    return { deviceId: s.deviceId, prefix: known.offline_prefix };
  // Area serialization lock (contract §3.14 step 3), then re-read: another
  // request for this device may have assigned a prefix meanwhile.
  await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + ":offline_prefix"},0))`;
  const [device] =
    await tx`select offline_prefix from devices where id=${s.deviceId}`;
  if (device.offline_prefix)
    return { deviceId: s.deviceId, prefix: device.offline_prefix };
  const used = new Set(
    (
      await tx`select offline_prefix from devices where offline_prefix is not null`
    ).map((row) => row.offline_prefix as string),
  );
  const prefix = OFFLINE_PREFIXES.find((candidate) => !used.has(candidate));
  if (!prefix) throw new DomainError("offline_prefix_exhausted", 409);
  await tx`update devices set offline_prefix=${prefix} where id=${s.deviceId}`;
  return { deviceId: s.deviceId, prefix };
}
