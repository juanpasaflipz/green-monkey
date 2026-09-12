import type { Tx } from "../server/db.js";
import "dotenv/config";
import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw Error("MIGRATION_DATABASE_URL required");
const sql = postgres(url, { max: 1 });
try {
  await sql.begin(async (raw) => {
    const tx = raw as Tx;
    await tx`select pg_advisory_xact_lock(7102481)`;
    await tx`create table if not exists schema_migrations(name text primary key, hash text not null, applied_at timestamptz not null default now())`;
    for (const file of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const body = await readFile(`migrations/${file}`, "utf8");
      const hash = createHash("sha256").update(body).digest("hex");
      const [prior] =
        await tx`select hash from schema_migrations where name=${file}`;
      if (prior) {
        if (prior.hash !== hash)
          throw Error(`Migration checksum changed: ${file}`);
        continue;
      }
      await tx.unsafe(body);
      await tx`insert into schema_migrations(name,hash) values(${file},${hash})`;
      console.log("Applied", file);
    }
  });
} finally {
  await sql.end();
}
