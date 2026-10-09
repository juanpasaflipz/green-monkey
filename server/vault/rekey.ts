/**
 * Re-seals the payments provider credentials (payment_secrets mp_credentials / clip_credentials)
 * under the active CREDENTIAL_ENCRYPTION_KEY kid (payments spec §9.1, docs/RUNBOOK.md "Credential
 * key rotation"). Worker side: run by scripts/vault-rekey.ts with the jobs login; the web never
 * imports it. Counts only, never a value; safe to run again.
 *
 * Tenant discovery. 037 gives the jobs login no cross-tenant listing on the payments tables (and
 * P2 adds no migration), so the restaurants to visit are the union of
 *   - every tenant with a payments job row the worker can see (jobs_worker_discover_payments:
 *     every connect writes payments_credentials, every charge payments_push/poll), and
 *   - the tenant ids the operator passes (`--tenant <uuid>`, e.g. from the support listing).
 * A credential the script does not reach is still re-sealed on its next use: the worker opens it
 * with any listed kid and writes it back under the active one (server/payments/worker/account.ts),
 * so the old kid is dropped only after the documented window (RUNBOOK) or after every connected
 * restaurant has charged once.
 */
import type postgres from "postgres";
import { tenant } from "../db.js";
import type { Keyring } from "../cfdi/config.js";
import { paymentsVault, type PaymentSecretPurpose } from "./vault.js";

export const PAYMENTS_WORKER_KINDS = [
  "payments_push",
  "payments_poll",
  "payments_cancel",
  "payments_webhook",
  "payments_credentials",
  "payments_devices",
  "payments_device_mode",
  "payments_wipe",
] as const;

export async function rekeyPaymentSecrets(
  sql: postgres.Sql,
  ring: Keyring,
  o: {
    tenants?: readonly string[];
    log?: (line: Record<string, unknown>) => void;
  } = {},
): Promise<{ tenants: number; resealed: number; failed: number }> {
  const log = o.log ?? (() => undefined);
  const found = await sql<{ tenant_id: string }[]>`
    select distinct tenant_id from jobs
    where kind = any(${[...PAYMENTS_WORKER_KINDS]}::text[]) order by tenant_id`;
  const ids = [
    ...new Set([...found.map((r) => r.tenant_id), ...(o.tenants ?? [])]),
  ].sort();
  let tenants = 0,
    resealed = 0,
    failed = 0;
  for (const tenantId of ids) {
    tenants++;
    try {
      resealed += await tenant(sql, tenantId, async (tx) => {
        const rows = await tx<
          { id: string; purpose: PaymentSecretPurpose; payload_secret: string }[]
        >`select id, purpose, payload_secret from payment_secrets
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
          await tx`update payment_secrets set kid = ${sealed.kid}, payload_secret = ${sealed.jwe}
            where id = ${s.id}`;
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
