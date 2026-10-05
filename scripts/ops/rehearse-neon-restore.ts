// User-run restore rehearsal on Neon (DB-2/OPS-5): staging first, then
// production before launch, then quarterly. Never run from CI.
//   NEON_API_KEY, NEON_PROJECT_ID (source), NEON_ORG_ID, NEON_REGION,
//   NEONCTL_VERSION (exact MAJOR.MINOR.PATCH; required, also for --dry-run)
//   REHEARSAL_SOURCE_ENV (staging|production), SOURCE_DATABASE,
//   SOURCE_BACKUP_URL (direct backup login on the source, for the PITR totals)
//   AGE_IDENTITY (path to the offline private key)
//   R2_ACCOUNT_ID, R2_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (read)
//   tsx scripts/ops/rehearse-neon-restore.ts [--dry-run]
//   tsx scripts/ops/rehearse-neon-restore.ts --cleanup docs/evidence/restore/<file>.json
// 1. PITR drill: a branch of the source from one hour ago (expires in a day);
//    control totals read through the backup login. Records branch-ready time.
// 2. Logical drill into a brand-new project (the fresh-cluster case): roles
//    from provision-roles.ts (globals first), latest daily dump downloaded,
//    sha256 checked, decrypted, pg_restore --no-owner --no-privileges as
//    gm_migrator, runtime grants re-applied, restore-verify against the
//    manifest.
// 3. RTO (start → verified) and RPO (dump snapshot age, PITR granularity)
//    are written to docs/evidence/restore/<date>-<env>.json. Cleanup commands
//    are printed and run only with --cleanup after typing the confirmation.
import "dotenv/config";
import postgres from "postgres";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { databaseTls, withoutParams } from "../../server/db-support.js";
import type { Tx } from "../../server/db.js";
import { controlTotals } from "./control-totals.js";
import { provisionRoles } from "./provision-roles.js";
import { verifyRestore } from "./restore-verify.js";
import { main as migrate } from "../migrate.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const started = Date.now();
const date = new Date().toISOString().slice(0, 10);
const env = process.env.REHEARSAL_SOURCE_ENV ?? "";
// The Neon CLI runs with NEON_API_KEY and the owner connection string, so it
// is pinned to an exact version, as the deploy action pins the Railway CLI
// (OPS-R13); never `latest`.
const neonctlVersion = process.env.NEONCTL_VERSION ?? "";
if (!/^\d+\.\d+\.\d+$/.test(neonctlVersion))
  throw Error("NEONCTL_VERSION must be an exact version (MAJOR.MINOR.PATCH)");
const neonctl = ["npx", "-y", `neonctl@${neonctlVersion}`];
const timings: Record<string, number> = {};
const evidence: Record<string, unknown> = {
  date,
  env,
  startedAt: new Date(started).toISOString(),
};

function sh(command: string[], o: { input?: string } = {}): string {
  if (dryRun) {
    console.log(
      "DRY-RUN:",
      command.map((c) => (/[\s]/.test(c) ? JSON.stringify(c) : c)).join(" "),
    );
    return "{}";
  }
  return execFileSync(command[0], command.slice(1), {
    encoding: "utf8",
    input: o.input,
    stdio: ["pipe", "pipe", "inherit"],
  });
}
const neon = (...rest: string[]) =>
  sh([...neonctl, ...rest, "--output", "json"]);
const bucket = process.env.R2_BUCKET ?? "<bucket>";
const r2 = (...rest: string[]) =>
  sh([
    "aws",
    ...rest,
    "--endpoint-url",
    `https://${process.env.R2_ACCOUNT_ID ?? "<account>"}.r2.cloudflarestorage.com`,
    "--region",
    "auto",
  ]);
const timed = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
  const t = Date.now();
  const value = await fn();
  timings[name] = Date.now() - t;
  return value;
};

async function cleanup(file: string) {
  const recorded = JSON.parse(readFileSync(file, "utf8"));
  const commands = [
    [
      ...neonctl,
      "branches",
      "delete",
      recorded.pitr.branch,
      "--project-id",
      recorded.sourceProject,
    ],
    [...neonctl, "projects", "delete", recorded.logical.project],
  ];
  for (const c of commands) console.log(c.join(" "));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    'Type "delete rehearsal resources" to run the commands above: ',
  );
  rl.close();
  if (answer !== "delete rehearsal resources") return console.log("cancelled");
  for (const c of commands)
    execFileSync(c[0], c.slice(1), { stdio: "inherit" });
}

if (args.includes("--cleanup")) {
  await cleanup(args[args.indexOf("--cleanup") + 1]);
  process.exit(0);
}
for (const name of [
  "NEON_API_KEY",
  "NEON_PROJECT_ID",
  "NEON_ORG_ID",
  "SOURCE_DATABASE",
  "AGE_IDENTITY",
  "R2_BUCKET",
  "R2_ACCOUNT_ID",
])
  if (!process.env[name] && !dryRun) throw Error(`${name} required`);
if (!/^(staging|production)$/.test(env))
  throw Error("REHEARSAL_SOURCE_ENV must be staging or production");
const project = process.env.NEON_PROJECT_ID ?? "<source-project>";
const sourceDatabase = process.env.SOURCE_DATABASE ?? `green_monkey_${env}`;
evidence.sourceProject = project;

// ---- 1. point-in-time branch ----
const pitrAt = new Date(Date.now() - 3600_000).toISOString();
const branchName = `rehearsal-${date}`;
const branch = await timed("pitr_branch_ready_ms", () =>
  JSON.parse(
    neon(
      "branches",
      "create",
      "--project-id",
      project,
      "--name",
      branchName,
      "--parent",
      pitrAt,
      "--expires-at",
      new Date(Date.now() + 86400_000).toISOString(),
    ),
  ),
);
let pitrTotals: unknown = null;
if (!dryRun) {
  const source = new URL(process.env.SOURCE_BACKUP_URL ?? "");
  const branchHost = branch.endpoints?.[0]?.host;
  if (!branchHost)
    throw Error("branch endpoint host missing from neonctl output");
  source.hostname = branchHost;
  const sql = postgres(withoutParams(source).href, {
    max: 1,
    ssl: databaseTls(source),
    onnotice: () => {},
  });
  try {
    pitrTotals = await sql.begin(async (raw) => {
      const tx = raw as unknown as Tx;
      await tx`set local row_security = on`;
      return controlTotals(tx as unknown as postgres.Sql);
    });
  } finally {
    await sql.end();
  }
}
evidence.pitr = { branch: branchName, pointInTime: pitrAt, totals: pitrTotals };

// ---- 2. logical restore into a brand-new project ----
const created = JSON.parse(
  neon(
    "projects",
    "create",
    "--name",
    `gm-restore-${date}`,
    "--region-id",
    process.env.NEON_REGION ?? "aws-us-east-1",
    "--org-id",
    process.env.NEON_ORG_ID ?? "<org>",
  ),
);
const restoreProject = created.project?.id ?? "<restore-project>";
const ownerUrl: string =
  created.connection_uris?.[0]?.connection_uri ??
  "postgresql://owner@restore.invalid/neondb";
evidence.logical = { project: restoreProject };
const work = `work/restore/${date}-${env}`;
if (!dryRun) mkdirSync(work, { recursive: true, mode: 0o700 });
const provisioned = dryRun
  ? null
  : await timed("provision_ms", () =>
      provisionRoles({
        ownerUrl,
        env: "restore",
        file: `${work}/.env.provisioned-restore`,
      }),
    );
const listing = r2("s3", "ls", `s3://${bucket}/daily/${env}/`, "--recursive");
const key = dryRun
  ? `daily/${env}/<yyyy>/<mm>/<latest>.dump.age`
  : (listing
      .split("\n")
      .map((l) => l.trim().split(/\s+/).at(-1) ?? "")
      .filter((k) => k.endsWith(".dump.age"))
      .sort()
      .at(-1) ?? "");
if (!key) throw Error("no daily dump found");
const local = `${work}/${key.split("/").at(-1)}`;
await timed("download_ms", () => {
  r2("s3", "cp", `s3://${bucket}/${key}`, local, "--only-show-errors");
  r2(
    "s3",
    "cp",
    `s3://${bucket}/${key}.manifest.json`,
    `${local}.manifest.json`,
    "--only-show-errors",
  );
});
const manifest = dryRun
  ? null
  : JSON.parse(readFileSync(`${local}.manifest.json`, "utf8"));
if (manifest) {
  const sha = createHash("sha256").update(readFileSync(local)).digest("hex");
  if (sha !== manifest.sha256)
    throw Error("downloaded dump does not match its manifest sha256");
}
const plain = local.replace(/\.age$/, "");
await timed("decrypt_ms", () =>
  sh([
    "age",
    "-d",
    "-i",
    process.env.AGE_IDENTITY ?? "<identity>",
    "-o",
    plain,
    local,
  ]),
);
const migratorUrl =
  provisioned?.urls.MIGRATION_DATABASE_URL ??
  "postgresql://gm_migrator@restore.invalid/neondb";
await timed("pg_restore_ms", () =>
  sh([
    process.env.REHEARSAL_PG_RESTORE ?? "pg_restore",
    "--exit-on-error",
    "--no-owner",
    "--no-privileges",
    "--role=gm_migrator",
    `--dbname=${migratorUrl}`,
    plain,
  ]),
);
if (!dryRun && provisioned) {
  const code = await timed("grants_ms", () =>
    migrate(["--grants-only"], {
      MIGRATION_DATABASE_URL: provisioned.urls.MIGRATION_DATABASE_URL,
      PG_APP_USER: provisioned.urls.PG_APP_USER,
      APP_ENV: "staging",
    }),
  );
  if (code !== 0) throw Error("grants failed on the restored project");
  const verification = await timed("verify_ms", () =>
    verifyRestore({
      adminUrl: provisioned.urls.BACKUP_DATABASE_URL,
      runtimeUrl: provisioned.urls.DATABASE_URL.replace("-pooler", ""),
      manifest,
    }),
  );
  evidence.verification = verification;
  if (!verification.ok) throw Error("restore verification failed");
}

// ---- 3. RTO / RPO ----
evidence.timings = timings;
evidence.rtoMs = Date.now() - started;
evidence.rpo = {
  logicalMs: manifest ? started - Date.parse(manifest.snapshotAt) : null,
  dumpSnapshotAt: manifest?.snapshotAt ?? null,
  pitr: "any second within the history window (point in time used: one hour ago)",
};
evidence.sourceDatabase = sourceDatabase;
const out = `docs/evidence/restore/${date}-${env}.json`;
if (!dryRun) writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n");
console.log(
  JSON.stringify({
    message: dryRun ? "rehearsal_planned" : "rehearsal_complete",
    evidence: dryRun ? null : out,
    rtoMs: evidence.rtoMs,
  }),
);
console.log(
  `Cleanup after review: npx tsx scripts/ops/rehearse-neon-restore.ts --cleanup ${out}`,
);
