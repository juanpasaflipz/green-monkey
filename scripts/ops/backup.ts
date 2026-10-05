// Nightly logical backup (DB-2/OPS-5). Run by .github/workflows/backup.yml.
//   BACKUP_DATABASE_URL   direct (non-pooled) endpoint, backup login that is a
//                         member of gm_backup_reader
//   BACKUP_ENV            staging | production (object key prefix)
//   AGE_RECIPIENTS_FILE   public age recipients (ops/backup/age-recipients.txt)
//   R2_ACCOUNT_ID, R2_BUCKET and AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
//                         (R2 API token scoped to the bucket) for the upload
// Options: --skip-upload, --out <dir> (default work/backup).
// Command overrides for local rehearsals only: BACKUP_PG_DUMP (a pg_dump
// binary instead of `docker run postgres:18 pg_dump`) and BACKUP_ENCRYPT
// (a command reading stdin, writing stdout); the plaintext pass-through is
// refused for any non-loopback database.
//
// 1. One read-only REPEATABLE READ transaction exports a snapshot; the
//    control totals are computed inside it.
// 2. pg_dump --snapshot dumps exactly that state (--enable-row-security, so
//    the backup role reads through the ops_backup_read policies), piped
//    through age; the sha256 is computed on the encrypted bytes.
// 3. Upload to R2 daily/<env>/YYYY/MM/ (and monthly/ on the 1st) with a
//    manifest, then verify the stored size. Prints one JSON summary.
import "dotenv/config";
import postgres from "postgres";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { databaseTls, withoutParams } from "../../server/db-support.js";
import { controlTotals, schemaFingerprint } from "./control-totals.js";

export interface BackupOptions {
  url: string;
  env: string;
  recipientsFile?: string;
  outDir?: string;
  skipUpload?: boolean;
  pgDump?: string;
  encrypt?: string[];
  now?: Date;
}

const isLoopback = (url: URL) =>
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(out)
        : reject(
            Error(`${basename(command)} exited ${code}: ${err.slice(-500)}`),
          ),
    );
  });
}

/** pg_dump of one snapshot, piped through the encryptor into `file`. */
async function dumpEncrypted(
  o: { pgDump: string[]; encrypt: string[]; file: string },
  env: NodeJS.ProcessEnv,
): Promise<{ sha256: string; bytes: number }> {
  const dump = spawn(o.pgDump[0], o.pgDump.slice(1), {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const enc = spawn(o.encrypt[0], o.encrypt.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const hash = createHash("sha256");
  const out = createWriteStream(o.file, { mode: 0o600 });
  let bytes = 0,
    errors = "";
  dump.stderr.on("data", (c) => (errors += c));
  enc.stderr.on("data", (c) => (errors += c));
  dump.stdout.pipe(enc.stdin);
  enc.stdout.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  enc.stdout.pipe(out);
  const exit = (child: ReturnType<typeof spawn>) =>
    new Promise<number | null>((r, reject) => {
      child.on("error", reject);
      child.on("close", (code) => r(code));
    });
  const [dumpCode, encCode] = await Promise.all([
    exit(dump),
    exit(enc),
    new Promise<void>((r, reject) => {
      out.on("finish", () => r());
      out.on("error", reject);
    }),
  ]);
  if (dumpCode !== 0)
    throw Error(`pg_dump failed (${dumpCode}): ${errors.slice(-500)}`);
  if (encCode !== 0)
    throw Error(`encryption failed (${encCode}): ${errors.slice(-500)}`);
  return { sha256: hash.digest("hex"), bytes };
}

export async function runBackup(o: BackupOptions) {
  if (!/^(staging|production|local)$/.test(o.env))
    throw Error("BACKUP_ENV must be staging or production");
  const url = new URL(o.url);
  if (url.hostname.includes("-pooler"))
    throw Error("backups need the direct endpoint");
  if (o.encrypt && !isLoopback(url))
    throw Error("custom encryption commands are for local rehearsals only");
  const now = o.now ?? new Date();
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const outDir = resolve(o.outDir ?? "work/backup");
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const file = `${outDir}/gm-${o.env}-${stamp}.dump.age`;
  const encrypt = o.encrypt ?? [
    "age",
    "-R",
    resolve(o.recipientsFile ?? "ops/backup/age-recipients.txt"),
  ];

  const sql = postgres(withoutParams(url).href, {
    max: 1,
    ssl: databaseTls(url),
    connection: { application_name: "gm-backup" },
    onnotice: () => {},
  });
  const reserved = await sql.reserve();
  try {
    await reserved`begin isolation level repeatable read read only`;
    await reserved`set local row_security = on`;
    const [{ snapshot }] =
      await reserved`select pg_export_snapshot() as snapshot`;
    const [{ server, snapshotAt }] =
      await reserved`select version() as server, now() as "snapshotAt"`;
    const totals = await controlTotals(reserved);
    const schema = await schemaFingerprint(reserved);
    // Same connection parameters as the app policy: verified TLS off-host.
    const dsn = new URL(withoutParams(url).href);
    dsn.password = "";
    if (!isLoopback(url)) {
      dsn.searchParams.set("sslmode", "verify-full");
      dsn.searchParams.set("sslrootcert", "system");
    }
    const dumpArgs = [
      `--snapshot=${snapshot}`,
      "--enable-row-security",
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--dbname=${dsn.href}`,
    ];
    const pgDump = o.pgDump
      ? [o.pgDump, ...dumpArgs]
      : [
          "docker",
          "run",
          "--rm",
          "-i",
          "--network",
          "host",
          "-e",
          "PGPASSWORD",
          "postgres:18",
          "pg_dump",
          ...dumpArgs,
        ];
    const pgDumpVersion = (
      await run(
        pgDump[0],
        o.pgDump
          ? ["--version"]
          : ["run", "--rm", "postgres:18", "pg_dump", "--version"],
      )
    ).trim();
    const { sha256, bytes } = await dumpEncrypted(
      { pgDump, encrypt, file },
      { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
    );
    await reserved`commit`;
    const manifest = {
      file: basename(file),
      env: o.env,
      sha256,
      bytes,
      snapshotAt: new Date(snapshotAt).toISOString(),
      server,
      pgDump: pgDumpVersion,
      schema,
      totals,
    };
    writeFileSync(
      `${file}.manifest.json`,
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600 },
    );

    const uploads: string[] = [];
    if (!o.skipUpload) {
      const account = process.env.R2_ACCOUNT_ID,
        bucket = process.env.R2_BUCKET;
      if (!account || !bucket)
        throw Error("R2_ACCOUNT_ID and R2_BUCKET required");
      const endpoint = `https://${account}.r2.cloudflarestorage.com`;
      const month = now.toISOString().slice(0, 7).replace("-", "/");
      const prefixes = [`daily/${o.env}/${month}`];
      if (now.getUTCDate() === 1) prefixes.push(`monthly/${o.env}/${month}`);
      for (const prefix of prefixes)
        for (const source of [file, `${file}.manifest.json`]) {
          const key = `${prefix}/${basename(source)}`;
          await run("aws", [
            "s3",
            "cp",
            source,
            `s3://${bucket}/${key}`,
            "--endpoint-url",
            endpoint,
            "--region",
            "auto",
            "--only-show-errors",
          ]);
          const head = JSON.parse(
            await run("aws", [
              "s3api",
              "head-object",
              "--bucket",
              bucket,
              "--key",
              key,
              "--endpoint-url",
              endpoint,
              "--region",
              "auto",
            ]),
          );
          if (Number(head.ContentLength) !== statSync(source).size)
            throw Error(`size mismatch for ${key}`);
          uploads.push(key);
        }
    }
    return { ...manifest, path: file, uploads };
  } catch (error) {
    await reserved`rollback`.catch(() => undefined);
    throw error;
  } finally {
    reserved.release();
    await sql.end({ timeout: 5 });
  }
}

function invokedDirectly() {
  try {
    return (
      Boolean(process.argv[1]) &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  try {
    const result = await runBackup({
      url: process.env.BACKUP_DATABASE_URL ?? "",
      env: process.env.BACKUP_ENV ?? "",
      recipientsFile: process.env.AGE_RECIPIENTS_FILE,
      outDir: outIndex >= 0 ? args[outIndex + 1] : undefined,
      skipUpload: args.includes("--skip-upload"),
      pgDump: process.env.BACKUP_PG_DUMP,
      encrypt: process.env.BACKUP_ENCRYPT
        ? process.env.BACKUP_ENCRYPT.split(" ")
        : undefined,
    });
    console.log(
      JSON.stringify({
        message: "backup_complete",
        ...result,
        totals: undefined,
        controlTotals: result.totals,
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        message: "backup_failed",
        error: String((error as Error).message).replace(
          /postgres(ql)?:\/\/[^@\s]+@/g,
          "postgresql://[redacted]@",
        ),
      }),
    );
    process.exitCode = 1;
  }
}
