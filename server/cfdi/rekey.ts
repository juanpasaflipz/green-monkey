/**
 * Re-seals the cfdi organization API keys under the active CREDENTIAL_ENCRYPTION_KEY kid (spec §4.5,
 * docs/CFDI.md "Credential key rotation"). Worker side: used by scripts/cfdi-rekey.ts with the jobs
 * login; the web never imports it. Counts only, never a key; safe to run again.
 */
import type postgres from "postgres";
import { tenant, type Tx } from "../db.js";
import type { Keyring } from "./config.js";
import { openSecret, sealSecret, type SecretPurpose } from "./vault.js";

export async function rekeyOrganizationSecrets(
  sql: postgres.Sql,
  ring: Keyring,
  log: (line: Record<string, unknown>) => void = () => undefined,
): Promise<{ tenants: number; resealed: number; failed: number }> {
  let tenants = 0,
    resealed = 0,
    failed = 0;
  // The listing policy cfdi_organizations_rekey_list applies only with this flag (030).
  const rows = await sql.begin(async (raw) => {
    const tx = raw as Tx;
    await tx`select set_config('app.cfdi_rekey_list', 'on', true)`;
    return tx<{ tenant_id: string }[]>`
      select tenant_id from cfdi_organizations
      where test_secret_id is not null or live_secret_id is not null order by tenant_id`;
  });
  for (const { tenant_id: tenantId } of rows) {
    tenants++;
    try {
      resealed += await tenant(sql, tenantId, async (tx) => {
        const secrets = await tx<
          { id: string; purpose: SecretPurpose; payload_secret: string }[]
        >`
          select id, purpose, payload_secret from cfdi_secrets
          where purpose in ('org_test_key','org_live_key') and wiped_at is null and kid <> ${ring.active}
          for update`;
        for (const s of secrets) {
          const binding = { tenantId, purpose: s.purpose, id: s.id };
          const plain = await openSecret(ring, s.payload_secret, binding);
          const sealed = await sealSecret(ring, plain, binding);
          await tx`update cfdi_secrets set kid = ${sealed.kid}, payload_secret = ${sealed.jwe} where id = ${s.id}`;
        }
        return secrets.length;
      });
    } catch (e) {
      failed++;
      log({
        message: "cfdi_rekey_failed",
        tenant: tenantId.slice(0, 8),
        code: (e as { code?: string }).code ?? "error",
      });
    }
  }
  return { tenants, resealed, failed };
}
