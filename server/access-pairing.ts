import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import type { Tx } from "./db.js";
import { hash, managers, permit } from "./auth.js";
import { audit } from "./orders.js";
import {
  endDeviceSessions,
  requireRecentAuth,
  type DeviceCookie,
} from "./access.js";
import { DomainError, type Session } from "../shared/domain.js";
import {
  ACCESS,
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  formatPairingCode,
  normalizePairingCode,
  type PairingCodeRow,
} from "../shared/access.js";

/** Codes are stored only as HMAC-SHA256 under the server secret, never in plaintext. */
export function pairingHash(code: string) {
  return createHmac("sha256", process.env.JWT_SECRET!)
    .update("gm-pairing-v1:" + code)
    .digest("hex");
}
/** 8 Crockford base32 characters = 40 bits from the CSPRNG. */
export function generatePairingCode() {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++)
    code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  return code;
}

const createInput = z
  .object({ deviceName: z.string().trim().min(1).max(60) })
  .strict();

/**
 * Creates a single-use code valid for 10 minutes. Deliberately not wrapped in
 * once(): the operations table would persist the plaintext code; a retry makes
 * another code and the unused one expires.
 */
export async function createPairingCode(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  requireRecentAuth(s);
  const p = createInput.parse(raw);
  // Serializes the open-code limit per restaurant.
  await tx`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id'),923))`;
  const [open] = await tx`select count(*)::int as count from device_pairing_codes
    where consumed_at is null and cancelled_at is null and expires_at>now()`;
  if (open.count >= ACCESS.maxOpenPairingCodes)
    throw new DomainError("pairing_code_limit", 409);
  const id = randomUUID();
  for (let attempt = 0; ; attempt++) {
    const code = generatePairingCode();
    try {
      const [row] = await tx.savepoint(
        (sp) => (sp as Tx)`insert into device_pairing_codes(tenant_id,id,code_hash,device_name,created_by,expires_at)
          values(${s.tenantId},${id},${pairingHash(code)},${p.deviceName},${s.employeeId},
            now()+make_interval(mins=>${ACCESS.pairingCodeMinutes}))
          returning expires_at`,
      );
      await audit(tx, s, "access.pairing_code_created", id, {
        id,
        deviceName: p.deviceName,
        expiresAt: row.expires_at,
      });
      return {
        id,
        code: formatPairingCode(code),
        deviceName: p.deviceName,
        expiresAt: (row.expires_at as Date).toISOString(),
      };
    } catch (error) {
      // A hash collision across all restaurants is astronomically rare; retry.
      if ((error as { code?: string }).code !== "23505" || attempt >= 2)
        throw error;
    }
  }
}

/** Open codes plus those resolved in the last 30 minutes (for the pairing dialog). */
export async function listPairingCodes(
  tx: Tx,
  s: Session,
): Promise<PairingCodeRow[]> {
  permit(s, managers);
  const rows = await tx`select c.id,c.device_name,c.created_at,c.expires_at,c.consumed_at,
      c.cancelled_at,c.device_id,e.name as created_by
    from device_pairing_codes c join employees e on e.tenant_id=c.tenant_id and e.id=c.created_by
    where (c.consumed_at is null and c.cancelled_at is null and c.expires_at>now())
       or greatest(c.consumed_at,c.cancelled_at,c.expires_at)>now()-interval '30 minutes'
    order by c.created_at desc limit 50`;
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    deviceName: r.device_name,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    state: r.consumed_at
      ? "consumed"
      : r.cancelled_at
        ? "cancelled"
        : r.expires_at.getTime() <= now
          ? "expired"
          : "open",
    deviceId: r.device_id,
  }));
}

export async function cancelPairingCode(
  tx: Tx,
  s: Session,
  id: string,
  raw: unknown,
) {
  permit(s, managers);
  requireRecentAuth(s);
  z.object({}).strict().parse(raw ?? {});
  const [row] = await tx`update device_pairing_codes set cancelled_at=now(),cancelled_by=${s.employeeId}
    where id=${id} and consumed_at is null and cancelled_at is null and expires_at>now()
    returning id,device_name`;
  if (!row) throw new DomainError("pairing_code_unavailable", 409);
  await audit(tx, s, "access.pairing_code_cancelled", id, {
    id,
    deviceName: row.device_name,
  });
  return { ok: true };
}

/**
 * Cancels the open codes an employee created, when they are deactivated or no
 * longer a manager (A11): a code outlives neither its creator's access nor role.
 */
export async function cancelCodesCreatedBy(
  tx: Tx,
  employeeId: string,
  actorId: string,
): Promise<number> {
  const rows = await tx`update device_pairing_codes set cancelled_at=now(),cancelled_by=${actorId}
    where created_by=${employeeId} and consumed_at is null and cancelled_at is null
    returning id`;
  return rows.length;
}

const redeemInput = z
  .object({ code: z.string().trim().min(8).max(20) })
  .strict();

/**
 * Pairs this browser as a shared terminal. The code is looked up by its exact
 * hash (RLS policy pairing_code_redeem_read), consumed atomically in the same
 * transaction as the device insert, and every failure gets one uniform error.
 */
export async function redeemPairingCode(
  sql: postgres.Sql,
  raw: unknown,
  previous: DeviceCookie | null,
): Promise<{ device: DeviceCookie; name: string; restaurant: string }> {
  const p = redeemInput.parse(raw);
  const code = normalizePairingCode(p.code);
  if (!code) throw new DomainError("pairing_code_invalid", 400);
  const codeHash = pairingHash(code);
  return sql.begin(async (rawTx) => {
    const tx = rawTx as Tx;
    await tx`select set_config('app.pairing_code_hash',${codeHash},true)`;
    const [row] =
      await tx`select tenant_id,id,device_name,created_by from device_pairing_codes where code_hash=${codeHash}`;
    if (!row) throw new DomainError("pairing_code_invalid", 400);
    await tx`select set_config('app.tenant_id',${row.tenant_id},true)`;
    // The creator must still be an active owner or manager (A11).
    const [creator] = await tx`select 1 from employees
      where id=${row.created_by} and active and role in ('owner','manager')`;
    if (!creator) throw new DomainError("pairing_code_invalid", 400);
    const device: DeviceCookie = {
      id: randomUUID(),
      tenantId: row.tenant_id,
      token: randomBytes(32).toString("hex"),
    };
    await tx`insert into devices(tenant_id,id,name,token_hash,kind,paired_at,paired_by,token_expires_at)
      values(${row.tenant_id},${device.id},${row.device_name},${hash(device.token)},'terminal',now(),
        ${row.created_by},now()+make_interval(days=>${ACCESS.deviceTokenDays}))`;
    const [consumed] = await tx`update device_pairing_codes set consumed_at=now(),device_id=${device.id}
      where id=${row.id} and consumed_at is null and cancelled_at is null and expires_at>now()
      returning id`;
    // Unknown, expired, cancelled and used codes are indistinguishable; the
    // throw rolls back the device insert, so a code pairs exactly one device.
    if (!consumed) throw new DomainError("pairing_code_invalid", 400);
    // Re-pairing a browser that holds this restaurant's terminal cookie retires the old device.
    const replaced = previous?.tenantId === row.tenant_id ? previous : null;
    if (replaced) {
      const [old] = await tx`update devices set active=false,revoked_at=now(),revoked_reason='replaced',free_slot=null
        where id=${replaced.id} and token_hash=${hash(replaced.token)} and active returning id`;
      if (old)
        await endDeviceSessions(tx, replaced.id, "replaced", { revoke: false });
    }
    await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail)
      values(${row.tenant_id},${randomUUID()},${row.created_by},'access.device_paired',${device.id},
        ${tx.json({ deviceName: row.device_name, codeId: row.id, replaced: replaced?.id ?? null })})`;
    const [restaurant] =
      await tx`select name from restaurants where id=${row.tenant_id}`;
    return { device, name: row.device_name, restaurant: restaurant.name };
  }) as Promise<{ device: DeviceCookie; name: string; restaurant: string }>;
}
