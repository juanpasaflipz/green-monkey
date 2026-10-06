/**
 * Verifies a restored database against the backup manifest (DB-2/OPS-5):
 * newest bundled migration present, identical schema fingerprint (tables,
 * forced RLS, policies, triggers, indexes), identical control totals, and the
 * runtime role still isolated to one tenant at a time.
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { latestBundledMigration } from "../../server/readiness.js";
import { databaseTls, withoutParams } from "../../server/db-support.js";
import type { Tx } from "../../server/db.js";
import { controlTotals, schemaFingerprint } from "./control-totals.js";

export interface RestoreManifest {
  schema: Awaited<ReturnType<typeof schemaFingerprint>>;
  totals: Awaited<ReturnType<typeof controlTotals>>;
}

const pool = (raw: string) => {
  const url = new URL(raw);
  return postgres(withoutParams(url).href, {
    max: 1,
    ssl: databaseTls(url),
    onnotice: () => {},
  });
};

/**
 * adminUrl: a login that reads every row (the backup login, or the owner with
 * BYPASSRLS); runtimeUrl: the runtime role on the restored database.
 */
export async function verifyRestore(o: {
  adminUrl: string;
  runtimeUrl: string;
  manifest: RestoreManifest | string;
}) {
  const manifest: RestoreManifest =
    typeof o.manifest === "string"
      ? JSON.parse(readFileSync(o.manifest, "utf8"))
      : o.manifest;
  const admin = pool(o.adminUrl),
    runtime = pool(o.runtimeUrl);
  const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
  const check = (name: string, ok: boolean, detail?: unknown) =>
    checks.push({ name, ok, ...(ok ? {} : { detail }) });
  try {
    const [latest] =
      await admin`select max(name) as name from schema_migrations`;
    check(
      "restored schema_migrations latest equals bundled",
      latest.name === latestBundledMigration(),
      { restored: latest.name, bundled: latestBundledMigration() },
    );
    const schema = await schemaFingerprint(admin);
    check(
      "all public tables keep forced RLS; policy, trigger and index counts equal the source",
      JSON.stringify(schema) === JSON.stringify(manifest.schema),
      { restored: schema, source: manifest.schema },
    );
    const totals = await admin.begin(async (raw) => {
      const tx = raw as unknown as Tx;
      await tx`set local row_security = on`;
      return controlTotals(tx as unknown as postgres.Sql);
    });
    check(
      "control totals equal the dump manifest",
      JSON.stringify(totals) === JSON.stringify(manifest.totals),
      { restored: totals, source: manifest.totals },
    );
    const [sample] =
      await admin`select tenant_id::text as tenant from employees limit 1`;
    const isolated = !sample
      ? true // an empty database has no tenant to leak
      : await runtime.begin(async (raw) => {
          const tx = raw as unknown as Tx;
          const [none] = await tx`select count(*)::int as n from employees`;
          await tx`select set_config('app.tenant_id', ${sample.tenant}, true)`;
          const [one] =
            await tx`select count(distinct tenant_id)::int as tenants from employees`;
          return none.n === 0 && one.tenants === 1;
        });
    check("runtime role sees one tenant at a time", isolated);
  } finally {
    await admin.end();
    await runtime.end();
  }
  return { ok: checks.every((c) => c.ok), checks };
}
