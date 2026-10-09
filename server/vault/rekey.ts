/**
 * Re-seals the payments provider credentials (payment_secrets mp_credentials / clip_credentials)
 * under the active CREDENTIAL_ENCRYPTION_KEY kid (payments spec §9.1, docs/RUNBOOK.md "Credential
 * key rotation"). Worker side: run by scripts/vault-rekey.ts with the jobs login; the web never
 * imports it. Counts only, never a value; safe to run again.
 *
 * Tenant discovery mirrors server/cfdi/rekey.ts: 037's payment_provider_accounts_rekey_list policy
 * (LD-76 deviation 1) lets the jobs login list, in one transaction that sets
 * app.payments_rekey_list = 'on', every restaurant whose account holds sealed credentials. Every
 * unwiped mp_credentials / clip_credentials row is an account's credential_secret_id (a newer one
 * wipes the previous; payments_wipe wipes a disabled account's), so the listing reaches every
 * restaurant. Each restaurant is then re-sealed in its own tenant transaction.
 */
import type postgres from "postgres";
import { tenant, type Tx } from "../db.js";
import type { Keyring } from "../cfdi/config.js";
import { paymentsVault, type PaymentSecretPurpose } from "./vault.js";

export async function rekeyPaymentSecrets(
  sql: postgres.Sql,
  ring: Keyring,
  log: (line: Record<string, unknown>) => void = () => undefined,
): Promise<{ tenants: number; resealed: number; failed: number }> {
  // The listing policy payment_provider_accounts_rekey_list applies only with this flag (037).
  const ids = await sql.begin(async (raw) => {
    const tx = raw as Tx;
    await tx`select set_config('app.payments_rekey_list', 'on', true)`;
    return (
      await tx<{ tenant_id: string }[]>`
        select distinct tenant_id from payment_provider_accounts
        where credential_secret_id is not null order by tenant_id`
    ).map((r) => r.tenant_id);
  });
  let tenants = 0,
    resealed = 0,
    failed = 0;
  for (const tenantId of ids) {
    tenants++;
    try {
      resealed += await tenant(sql, tenantId, async (tx) => {
        const rows = await tx<
          {
            id: string;
            kid: string;
            purpose: PaymentSecretPurpose;
            payload_secret: string;
          }[]
        >`select id, kid, purpose, payload_secret from payment_secrets
          where purpose in ('mp_credentials','clip_credentials') and wiped_at is null
            and kid <> ${ring.active}
          order by id for update`;
        for (const s of rows) {
          const binding = { tenantId, purpose: s.purpose, id: s.id };
          const plain = await paymentsVault.openSecret(
            ring,
            s.payload_secret,
            binding,
          );
          const sealed = await paymentsVault.sealSecret(ring, plain, binding);
          // Compare-and-set like openAccount's re-seal (the row is already locked here).
          await tx`update payment_secrets set kid = ${sealed.kid}, payload_secret = ${sealed.jwe}
            where id = ${s.id} and kid = ${s.kid} and wiped_at is null`;
        }
        return rows.length;
      });
    } catch (e) {
      failed++;
      log({
        message: "payments_rekey_failed",
        tenant: tenantId.slice(0, 8),
        code: (e as { code?: string }).code ?? "error",
      });
    }
  }
  return { tenants, resealed, failed };
}
