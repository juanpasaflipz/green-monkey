// Explicit provisioning only; same as `migrate --grants-only` for the role in
// DATABASE_URL. The web process never imports this module.
import "dotenv/config";
import { main } from "./migrate.js";

const migration = process.env.MIGRATION_DATABASE_URL;
const runtime = process.env.DATABASE_URL;
if (!migration || !runtime) throw Error("Both database URLs are required");
const target = new URL(runtime),
  owner = new URL(migration);
if (owner.pathname !== target.pathname || owner.username === target.username)
  throw Error(
    "Migration and runtime must use different roles in the same database",
  );
process.exitCode = await main(["--grants-only"], {
  ...process.env,
  PG_APP_USER: decodeURIComponent(target.username),
});
