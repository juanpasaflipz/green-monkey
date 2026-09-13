import "dotenv/config";
import type { Tx } from "../server/db.js";
import postgres from "postgres";
import { readFile } from "node:fs/promises";

// Explicit provisioning only. The web process never imports this module.
const migration = process.env.MIGRATION_DATABASE_URL;
const runtime = process.env.DATABASE_URL;
if (!migration || !runtime) throw Error("Both database URLs are required");
const target = new URL(runtime);
const owner = new URL(migration);
const role = decodeURIComponent(target.username);
if (owner.pathname !== target.pathname || owner.username === target.username)
  throw Error(
    "Migration and runtime must use different roles in the same database",
  );
const sql = postgres(migration, { max: 1 });
try {
  await sql.begin(async (raw) => {
    const tx = raw as Tx;
    const [r] =
      await tx`select rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname=${role}`;
    if (!r || r.rolsuper || r.rolbypassrls || r.rolcreatedb || r.rolcreaterole)
      throw Error("Runtime role has unsafe provisioning privileges");
    const [owned] =
      await tx`select count(*)::int as count from pg_tables where schemaname='public' and tableowner=${role}`;
    if (owned.count) throw Error("Runtime role owns application tables");
    // Static reviewed privilege manifest; substitute quoted SQL identifiers only.
    const ident = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    const manifest = (await readFile("scripts/grants.sql", "utf8"))
      .replaceAll(/\bgm_app\b/g, ident(role))
      .replaceAll(
        /\bgreen_monkey_dev\b/g,
        ident(decodeURIComponent(target.pathname.slice(1))),
      );
    await tx.unsafe(manifest);
    await tx`revoke create on schema public from public`;
  });
  console.log("Restricted runtime privileges applied");
} finally {
  await sql.end();
}
