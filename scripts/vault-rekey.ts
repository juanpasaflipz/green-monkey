// Re-seals every worker-held credential under the active CREDENTIAL_ENCRYPTION_KEY kid: the cfdi
// organization keys (cfdi_secrets org_*) and the payments provider credentials (payment_secrets
// mp_credentials / clip_credentials). Payments spec §9.1, critic R42 (replaces scripts/cfdi-rekey.ts;
// `npm run cfdi:rekey` stays as an alias). Run in the WORKER environment, after prepending the new
// kid and redeploying the worker:
//
//   npm run vault:rekey [-- --tenant <uuid> ...]
//
// Needs WORKER_DATABASE_URL (the jobs login, a gm_jobs_worker member) and CREDENTIAL_ENCRYPTION_KEY
// with the old kid still listed. Prints counts only, never a key. Upload boxes are wiped after use
// and need no re-seal. Safe to run again: rows already under the active kid are skipped.
// `--tenant` adds restaurants the payments discovery cannot see (server/vault/rekey.ts).
import {
  checkWorkerRole,
  connectWorker,
  waitForDatabase,
} from "../server/db.js";
import { parseCredentialKeyring } from "../server/cfdi/config.js";
import { rekeyOrganizationSecrets } from "../server/cfdi/rekey.js";
import { rekeyPaymentSecrets } from "../server/vault/rekey.js";

const url = process.env.WORKER_DATABASE_URL?.trim();
const raw = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
if (!url || !raw) {
  console.error(
    "vault:rekey needs WORKER_DATABASE_URL and CREDENTIAL_ENCRYPTION_KEY",
  );
  process.exit(2);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const args = process.argv.slice(2);
const tenants: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--tenant" && uuid.test(args[i + 1] ?? "")) {
    tenants.push(args[i + 1].toLowerCase());
    i++;
  } else {
    console.error("usage: vault:rekey [-- --tenant <uuid> ...]");
    process.exit(2);
  }
}
const ring = parseCredentialKeyring(raw);
const sql = connectWorker(url);
async function run(): Promise<number> {
  try {
    await waitForDatabase(sql, { check: checkWorkerRole });
    const line = (l: Record<string, unknown>) =>
      console.error(JSON.stringify(l));
    const cfdi = await rekeyOrganizationSecrets(sql, ring, line);
    const payments = await rekeyPaymentSecrets(sql, ring, {
      tenants,
      log: line,
    });
    console.log(
      JSON.stringify({
        message: "vault_rekey_done",
        activeKid: ring.active,
        cfdi,
        payments,
      }),
    );
    return cfdi.failed || payments.failed ? 1 : 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
process.exit(await run());
