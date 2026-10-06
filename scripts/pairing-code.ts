/**
 * Operator CLI: prints one single-use pairing code for a restaurant, for
 * support cases where no owner or manager can open Settings → Devices.
 *
 *   npm run access:pairing-code -- --tenant <uuid> --name "Caja 1" \
 *     --confirm-target <host:port/db>
 *
 * Local and CI only. The deployed migrator credential lives only in GitHub
 * Actions (docs/RUNBOOK.md), so the CLI refuses any target that is not a
 * loopback database (access A4); deployed support uses Configuración →
 * Dispositivos or account recovery.
 *
 * Uses MIGRATION_DATABASE_URL (privileged) and JWT_SECRET, which must be the
 * secret of the server that will redeem the code (it keys the pairing
 * digest). The code is stored only as an HMAC, expires in 10 minutes, and is
 * attributed to the restaurant owner.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import postgres from "postgres";
import type { Tx } from "../server/db.js";
import { isLoopbackHost } from "../server/config-rules.js";
import { z } from "zod";
import { generatePairingCode, pairingHash } from "../server/access-pairing.js";
import { ACCESS, formatPairingCode } from "../shared/access.js";

const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    name: { type: "string" },
    "confirm-target": { type: "string" },
  },
});
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw Error("MIGRATION_DATABASE_URL required");
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)
  throw Error("JWT_SECRET of the target server required (32+ characters)");
const tenantId = z.uuid().parse(values.tenant);
const deviceName = z.string().trim().min(1).max(60).parse(values.name);
const parsed = new URL(url);
const identity = `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
if (values["confirm-target"] !== identity)
  throw Error(`--confirm-target must equal ${identity}`);
if (!isLoopbackHost(parsed.hostname))
  throw Error(
    "pairing CLI is limited to local and CI databases; deployed support uses Configuración → Dispositivos or account recovery",
  );

const sql = postgres(url, { max: 1 });
try {
  const result = await sql.begin(async (raw) => {
    const tx = raw as Tx;
    await tx`select set_config('app.tenant_id',${tenantId},true)`;
    const [owner] =
      await tx`select id from employees where tenant_id=${tenantId} and role='owner' and active order by id limit 1`;
    if (!owner) throw Error("No active owner for that restaurant");
    await tx`select pg_advisory_xact_lock(hashtextextended(${tenantId},923))`;
    const [open] =
      await tx`select count(*)::int as count from device_pairing_codes
      where tenant_id=${tenantId} and consumed_at is null and cancelled_at is null and expires_at>now()`;
    if (open.count >= ACCESS.maxOpenPairingCodes)
      throw Error("Too many open pairing codes; cancel one or wait 10 minutes");
    const id = randomUUID(),
      code = generatePairingCode();
    const [row] =
      await tx`insert into device_pairing_codes(tenant_id,id,code_hash,device_name,created_by,expires_at)
      values(${tenantId},${id},${pairingHash(code)},${deviceName},${owner.id},
        now()+make_interval(mins=>${ACCESS.pairingCodeMinutes}))
      returning expires_at`;
    await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail)
      values(${tenantId},${randomUUID()},${owner.id},'access.pairing_code_created',${id},
        ${tx.json({ id, deviceName, expiresAt: row.expires_at, source: "operator_cli" })})`;
    return { code, expiresAt: row.expires_at as Date };
  });
  console.log(
    `${formatPairingCode(result.code)} (expires ${result.expiresAt.toISOString()})`,
  );
} finally {
  await sql.end();
}
