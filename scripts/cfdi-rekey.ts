// Re-seals the cfdi organization API keys under the active CREDENTIAL_ENCRYPTION_KEY kid
// (spec §4.5, docs/CFDI.md "Credential key rotation"). Run in the WORKER environment, after
// prepending the new kid and redeploying the worker:
//
//   npm run cfdi:rekey
//
// Needs WORKER_DATABASE_URL (the jobs login, a gm_jobs_worker member) and CREDENTIAL_ENCRYPTION_KEY
// with the old kid still listed. Prints counts only, never a key. CSD upload boxes are wiped after
// use and need no re-seal. Safe to run again: rows already under the active kid are skipped.
import {
  checkWorkerRole,
  connectWorker,
  waitForDatabase,
} from "../server/db.js";
import { parseCredentialKeyring } from "../server/cfdi/config.js";
import { rekeyOrganizationSecrets } from "../server/cfdi/rekey.js";

const url = process.env.WORKER_DATABASE_URL?.trim();
const raw = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
if (!url || !raw) {
  console.error(
    "cfdi:rekey needs WORKER_DATABASE_URL and CREDENTIAL_ENCRYPTION_KEY",
  );
  process.exit(2);
}
const ring = parseCredentialKeyring(raw);
const sql = connectWorker(url);
async function run(): Promise<number> {
  try {
    await waitForDatabase(sql, { check: checkWorkerRole });
    const result = await rekeyOrganizationSecrets(sql, ring, (line) =>
      console.error(JSON.stringify(line)),
    );
    console.log(
      JSON.stringify({
        message: "cfdi_rekey_done",
        activeKid: ring.active,
        ...result,
      }),
    );
    return result.failed ? 1 : 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
process.exit(await run());
