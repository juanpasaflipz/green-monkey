// Kept for documented commands: same as `migrate --grants-only` (applies the
// reviewed manifest to PG_APP_USER, logs its sha256 in `grants_applied`, and
// reconciles policies). Nothing records the hash in the database yet: the
// schema_grants registry is a next-wave item (RUNBOOK.md, Open follow-ups).
import { main } from "./migrate.js";
process.exitCode = await main(["--grants-only"]);
