/**
 * Vendor support CLI (account 031): `npm run support -- <command> [flags]`.
 *
 *   lookup             --email <e> | --tenant <id> | --organization <id>
 *   unlock-employee    --tenant <id> --login <login>
 *   grant-entitlement  --tenant <id> --until YYYY-MM-DD   (pilot Pro, ≤90 days, renewable)
 *   end-entitlement    --tenant <id>
 *   transfer-ownership --organization <id> --to-email <e> [--hold-hours 72]
 *   cancel-transfer    --transfer <id>
 *   set-free-device    --tenant <id> --device <id>
 *   rectify-account    --account <id> [--name "<n>"] [--email <e>]   (ARCO rectification)
 *   block-account      --account <id> [--offboarding]                (ARCO cancellation: blocking)
 *   anonymize-account  --account <id>          (after the blocking period; never --yes)
 *   redact-email       --email <e>             (someone who never had an account)
 *   actions            --organization <id> [--limit 50]
 *
 * Every command needs --operator "<human name>" --ticket <ref> --reason "<10–500 chars>"
 * and is logged in support_actions (owners see it in their account console).
 * Mutating commands ask for the restaurant or organization name (--yes skips it,
 * except for transfer-ownership). Connects only with SUPPORT_DATABASE_URL, an
 * operator login that is a gm_support member (npm run support:provision); never a
 * Railway service variable. transfer-ownership prints its link on
 * SUPPORT_APP_URL (or APP_URL), which must be the deployment's https origin
 * (OPS-5). Runbook: docs/OPERATIONS.md (Support).
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import postgres from "postgres";
import { poolOptions, withoutParams } from "../server/db-support.js";
import {
  SupportError,
  checkSupportRole,
  parseSupportArgs,
  runSupportCommand,
  validateSupportArgs,
} from "./support-commands.js";

async function main() {
  const url = process.env.SUPPORT_DATABASE_URL;
  if (!url) throw new SupportError("support_database_url_required");
  const { command, flags } = parseSupportArgs(process.argv.slice(2));
  const validated = validateSupportArgs(command, flags);
  const target = new URL(url);
  const sql = postgres(
    withoutParams(target).href,
    poolOptions(target, { max: 1, applicationName: "gm-support-cli" }),
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await checkSupportRole(sql, process.env);
    await runSupportCommand(sql, validated, {
      print: (line) => process.stdout.write(line + "\n"),
      confirm: async (prompt, expected) =>
        (await rl.question(prompt)).trim() === expected,
      appUrl: process.env.SUPPORT_APP_URL || process.env.APP_URL,
    });
  } finally {
    rl.close();
    await sql.end({ timeout: 5 });
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    (error instanceof SupportError
      ? error.code
      : `support_command_failed: ${(error as Error).message}`) + "\n",
  );
  process.exitCode = 1;
}
