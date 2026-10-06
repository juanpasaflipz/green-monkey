/**
 * Creates one vendor support operator login (account 031):
 *
 *   PROVISION_DATABASE_URL=<CREATEROLE owner, direct endpoint> \
 *   SUPPORT_PROVISION_TARGET=<host:port/database> \
 *   npm run support:provision -- --name <alnum>
 *
 * The login gm_support_<name> is LOGIN, not superuser, no CREATEDB/CREATEROLE/
 * BYPASSRLS, a member of gm_support (created by scripts/ops/sql/globals.sql,
 * which must have run) and gets CONNECT on the target database. The URL is
 * written once to .env.support-<name> (mode 0600, never overwritten): keep it
 * on the operator's workstation, never in Railway. gm_migrator is NOCREATEROLE,
 * so this needs the provisioning owner, like scripts/ops/provision-roles.ts.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import postgres from "postgres";
import { poolOptions, withoutParams } from "../server/db-support.js";

const ALLOWED = [
  "/green_monkey_staging",
  "/green_monkey_test",
  "/green_monkey_dev",
];

async function main() {
  const nameIndex = process.argv.indexOf("--name");
  const name = nameIndex > 0 ? process.argv[nameIndex + 1] : undefined;
  if (!name || !/^[a-z0-9]{2,20}$/.test(name))
    throw Error("support_operator_name_required");
  if (!process.env.PROVISION_DATABASE_URL)
    throw Error("provision_database_url_required");
  const owner = new URL(process.env.PROVISION_DATABASE_URL);
  const target = `${owner.hostname}:${owner.port || "5432"}${owner.pathname}`;
  // Production (/green_monkey) only when its exact target is named (D16).
  if (
    process.env.SUPPORT_PROVISION_TARGET !== target ||
    !(ALLOWED.includes(owner.pathname) || owner.pathname === "/green_monkey")
  )
    throw Error("explicit_support_provision_target_required");
  const role = `gm_support_${name}`;
  const password = randomBytes(32).toString("hex");
  const login = new URL(withoutParams(owner).href);
  login.username = role;
  login.password = password;
  if (owner.searchParams.get("sslmode"))
    login.searchParams.set("sslmode", owner.searchParams.get("sslmode")!);
  const sql = postgres(
    withoutParams(owner).href,
    poolOptions(owner, { max: 1, applicationName: "gm-support-provision" }),
  );
  try {
    const [support] =
      await sql`select 1 from pg_roles where rolname='gm_support'`;
    if (!support) throw Error("gm_support_missing_run_globals_sql_first");
    const [exists] = await sql`select 1 from pg_roles where rolname=${role}`;
    if (exists) throw Error("support_operator_exists");
    const output = `.env.support-${name}`;
    // Saved before the role exists, so a lost response never needs a rotation.
    await writeFile(output, `SUPPORT_DATABASE_URL=${login.href}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await sql.unsafe(
      `create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole nobypassrls`,
    );
    await sql.unsafe(`grant gm_support to "${role}"`);
    await sql.unsafe(
      `grant connect on database "${owner.pathname.slice(1)}" to "${role}"`,
    );
    process.stdout.write(
      JSON.stringify({
        message: "support_operator_provisioned",
        role,
        output,
      }) + "\n",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
