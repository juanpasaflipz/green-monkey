import "dotenv/config";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "dotenv";
const migration = new URL(process.env.MIGRATION_DATABASE_URL!);
const runtime = new URL(process.env.DATABASE_URL!);
const target = `${migration.hostname}:${migration.port || "5432"}${migration.pathname}`;
if (
  process.env.BILLING_PROVISION_TARGET !== target ||
  migration.pathname !== runtime.pathname ||
  ![
    "/green_monkey_staging",
    "/green_monkey_test",
    "/green_monkey_dev",
  ].includes(migration.pathname)
)
  throw Error("explicit_isolated_billing_target_required");
const suffix = migration.pathname.split("_").at(-1)!;
const role = "gm_" + suffix + "_billing";
const output = ".env.billing-" + suffix;
let saved: Record<string, string> | null = null;
try {
  saved = parse(await readFile(output, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const worker = new URL(runtime);
worker.username = role;
worker.password = randomBytes(32).toString("hex");
if (saved) {
  const prior = new URL(saved.BILLING_DATABASE_URL);
  if (
    prior.host !== runtime.host ||
    prior.pathname !== runtime.pathname ||
    prior.username !== role
  )
    throw Error("saved_billing_target_mismatch");
  worker.password = prior.password;
}
if (!/^[a-f0-9]{64}$/.test(worker.password))
  throw Error("generated_billing_password_required");
const sql = postgres(migration.href, { max: 1 });
try {
  const [exists] =
    await sql`select rolname from pg_roles where rolname=${role}`;
  if (exists && !saved)
    throw Error("existing_billing_role_requires_saved_credentials");
  // Save before creating the role so a lost response never requires rotation.
  if (!saved)
    await writeFile(output, `BILLING_DATABASE_URL=${worker.href}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  if (!exists)
    await sql.unsafe(
      `create role "${role}" login password '${worker.password}' nosuperuser nocreatedb nocreaterole nobypassrls`,
    );
  await sql.unsafe(`grant gm_billing_worker to "${role}"`);
  await sql.unsafe(
    `grant connect on database "${runtime.pathname.slice(1)}" to "${role}"`,
  );
  const [r] =
    await sql`select rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname=${role}`;
  if (r.rolsuper || r.rolbypassrls || r.rolcreatedb || r.rolcreaterole)
    throw Error("unsafe_billing_role");
  console.log(
    "Restricted billing login provisioned; credentials saved privately.",
  );
} catch (error) {
  console.error({
    code: (error as { code?: string }).code ?? "billing_provision_failed",
  });
  process.exitCode = 1;
} finally {
  await sql.end();
}
