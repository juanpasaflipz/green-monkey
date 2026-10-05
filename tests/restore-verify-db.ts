// Restore rehearsal verification (scripts/ops/rehearse-neon-restore.ts and
// scripts/rehearse-restore.sh run it against the restored database).
//   RESTORE_ADMIN_URL     login that reads every row (backup login or owner)
//   RESTORE_DATABASE_URL  runtime role on the restored database
//   RESTORE_MANIFEST      path to the backup's .manifest.json
import "dotenv/config";
import { verifyRestore } from "../scripts/ops/restore-verify.js";

const { RESTORE_ADMIN_URL, RESTORE_DATABASE_URL, RESTORE_MANIFEST } =
  process.env;
if (!RESTORE_ADMIN_URL || !RESTORE_DATABASE_URL || !RESTORE_MANIFEST)
  throw Error(
    "RESTORE_ADMIN_URL, RESTORE_DATABASE_URL and RESTORE_MANIFEST required",
  );
const result = await verifyRestore({
  adminUrl: RESTORE_ADMIN_URL,
  runtimeUrl: RESTORE_DATABASE_URL,
  manifest: RESTORE_MANIFEST,
});
for (const c of result.checks)
  console.log(
    c.ok ? "PASS" : "FAIL",
    c.name,
    c.ok ? "" : JSON.stringify(c.detail),
  );
if (!result.ok) process.exitCode = 1;
else
  console.log(`Restore verification passed: ${result.checks.length} checks.`);
