import "dotenv/config";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const migration = process.env.MIGRATION_DATABASE_URL;
if (!migration) throw Error("MIGRATION_DATABASE_URL required");
const runtimeRole =
  process.env.PG_APP_USER ??
  (process.env.DATABASE_URL
    ? decodeURIComponent(new URL(process.env.DATABASE_URL).username)
    : "");
if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(runtimeRole))
  throw Error("Explicit valid PG_APP_USER or DATABASE_URL runtime role required");
const quotedRole = `"${runtimeRole}"`;
const reviewed = await readFile("scripts/grants.sql", "utf8");
const scoped = reviewed.replace(/\bgm_app\b/g, quotedRole);
const sql = postgres(migration, { max: 1 });
try {
  await sql.unsafe(scoped);
  console.log("Applied reviewed runtime grants to the configured database and role.");
} finally {
  await sql.end();
}
