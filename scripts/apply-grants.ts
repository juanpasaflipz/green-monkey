// Kept for documented commands: same as `migrate --grants-only` (applies the
// reviewed manifest, records its hash in schema_grants, reconciles policies).
import { main } from "./migrate.js";
process.exitCode = await main(["--grants-only"]);
