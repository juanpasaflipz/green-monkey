// Local backup → restore rehearsal (DB-2/OPS-5): scripts/ops/backup.ts dumps
// the isolated test database through a disposable backup login (reading via
// ops_backup_read), the dump is restored into a throwaway database after
// globals.sql, grants and policies are re-applied by the migration runner,
// and scripts/ops/restore-verify.ts compares schema fingerprint and control
// totals with the manifest. Encryption is a local pass-through (`cat`); the
// script refuses that for any non-loopback database.
// Needs pg_dump/pg_restore matching the server major (BACKUP_PG_DUMP /
// BACKUP_PG_RESTORE override the binaries).
import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { check, disposableLogins, passed } from "./ops-roles.js";
import { runBackup } from "../scripts/ops/backup.js";
import { verifyRestore } from "../scripts/ops/restore-verify.js";
import { reconcilePolicies } from "../server/ops/schema.js";
import { main as migrate } from "../scripts/migrate.js";
import { setLogSink } from "../server/logging.js";
import {
  controlTotals,
  recoveryTables,
} from "../scripts/ops/control-totals.js";

setLogSink(() => {});
const { runtime, migration } = isolatedTarget(process.env);
const admin = postgres(migration, { max: 1, onnotice: () => {} });
const restored = `green_monkey_restore_${randomBytes(4).toString("hex")}_test`;
const dir = mkdtempSync(join(tmpdir(), "gm-backup-"));
const with_ = (base: string, database: string) => {
  const u = new URL(base);
  u.pathname = "/" + database;
  return u.href;
};
let drop: (() => Promise<void>) | undefined;
const memberId = randomBytes(16).toString("hex");
let memberTenant: string | undefined;
/** pg_dump/pg_restore for the server's major version (newer clients emit
 * settings an older server rejects on restore). */
async function clientBinary(name: "pg_dump" | "pg_restore") {
  const override =
    process.env[name === "pg_dump" ? "BACKUP_PG_DUMP" : "BACKUP_PG_RESTORE"];
  if (override) return override;
  const [{ major }] =
    await admin`select current_setting('server_version_num')::int / 10000 as major`;
  for (const dir of [
    `/usr/lib/postgresql/${major}/bin`,
    `/opt/homebrew/opt/postgresql@${major}/bin`,
  ])
    if (existsSync(`${dir}/${name}`)) return `${dir}/${name}`;
  return name;
}
try {
  const [tenant] = await admin`select id::text from restaurants limit 1`;
  memberTenant = tenant.id;
  await admin`insert into loyalty_members
    (tenant_id,id,phone_e164,name,name_key,joined_via,consent_channel,consent_at)
    values (${memberTenant},${memberId},'+525555001234','Restore fixture','restore fixture',
      'join_qr','self_service',now())`;
  await admin.unsafe(readFileSync("scripts/ops/sql/globals.sql", "utf8"));
  await reconcilePolicies(admin);
  const logins = await disposableLogins(admin, runtime, {
    backup: ["gm_backup_reader"],
  });
  drop = logins.drop;
  let backup!: Awaited<ReturnType<typeof runBackup>>;

  await check(
    "backup dumps one consistent snapshot with control totals and a sha256 manifest",
    async () => {
      backup = await runBackup({
        url: logins.logins.backup.url,
        env: "local",
        outDir: dir,
        skipUpload: true,
        pgDump: await clientBinary("pg_dump"),
        encrypt: ["cat"],
      });
      const bytes = readFileSync(backup.path);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        backup.sha256,
      );
      assert.equal(
        bytes.subarray(0, 5).toString(),
        "PGDMP",
        "custom-format dump",
      );
      assert.ok(Number(backup.totals.orders) >= 0);
      assert.ok(backup.schema.forced_rls_tables > 40);
      const [direct] = await admin`select count(*)::text as n from employees`;
      assert.ok(Number(direct.n) > 0, "fixture has employees");
      for (const table of recoveryTables) {
        assert.match(backup.totals[`${table}_digest`], /^[a-f0-9]{32}$/);
        const [count] = await admin.unsafe(
          `select count(*)::text as n from public.${table}`,
        );
        assert.equal(backup.totals[`${table}_count`], count.n);
      }
    },
  );

  await check(
    "encryption pass-through is refused for a non-loopback database",
    async () => {
      await assert.rejects(
        runBackup({
          url: "postgresql://u:p@db.example.com/green_monkey",
          env: "staging",
          encrypt: ["cat"],
          skipUpload: true,
        }),
        /local rehearsals only/,
      );
    },
  );

  await check(
    "the dump restores after globals.sql and verifies against the manifest",
    async () => {
      await admin.unsafe(`create database "${restored}"`);
      const restoreAdmin = with_(migration, restored);
      const scoped = postgres(restoreAdmin, { max: 1, onnotice: () => {} });
      await scoped.unsafe(
        readFileSync("scripts/ops/sql/database-grants.sql", "utf8"),
      );
      await scoped.end();
      execFileSync(
        await clientBinary("pg_restore"),
        [
          "--exit-on-error",
          "--no-owner",
          "--no-privileges",
          `--dbname=${restoreAdmin}`,
          backup.path,
        ],
        { stdio: "pipe" },
      );
      // --no-privileges drops grants: the runner re-applies the runtime grants
      // and the backup-reader policies/grants.
      assert.equal(
        await migrate(["--grants-only"], {
          MIGRATION_DATABASE_URL: restoreAdmin,
          PG_APP_USER: new URL(runtime).username,
          APP_ENV: "development",
        }),
        0,
      );
      const result = await verifyRestore({
        adminUrl: with_(logins.logins.backup.url, restored),
        runtimeUrl: with_(runtime, restored),
        manifest: backup,
      });
      assert.ok(result.ok, JSON.stringify(result.checks.filter((c) => !c.ok)));
      assert.equal(result.checks.length, 4);

      // Same row count and unchanged financial totals must not hide a member
      // whose personal data changed during recovery.
      const corrupt = postgres(restoreAdmin, { max: 1, onnotice: () => {} });
      try {
        await corrupt`update loyalty_members set name='Changed restore fixture'
          where tenant_id=${memberTenant} and id=${memberId}`;
        const changed = await verifyRestore({
          adminUrl: with_(logins.logins.backup.url, restored),
          runtimeUrl: with_(runtime, restored),
          manifest: backup,
        });
        assert.equal(
          changed.ok,
          false,
          "same-count member corruption must fail restore verification",
        );
        assert.ok(
          changed.checks.some(
            (c) => c.name === "control totals equal the dump manifest" && !c.ok,
          ),
        );
        // Main's scheduled backup code may run while production is still on
        // 041. Missing 042 tables must be recorded, not abort all backups.
        await corrupt`drop table loyalty_member_cards cascade`;
        await corrupt`drop table loyalty_referrals cascade`;
        const older = await corrupt.begin(async (tx) =>
          controlTotals(tx as unknown as postgres.Sql),
        );
        assert.equal(older.loyalty_member_cards_count, "absent");
        assert.equal(older.loyalty_referrals_digest, "absent");
        assert.notEqual(older.loyalty_members_digest, "absent");
      } finally {
        await corrupt.end();
      }
    },
  );

  console.log(`Backup/restore DB checks passed: ${passed()} checks.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
  await admin
    .unsafe(`drop database if exists "${restored}" with (force)`)
    .catch(() => undefined);
  await drop?.();
  if (memberTenant)
    await admin`delete from loyalty_members where tenant_id=${memberTenant} and id=${memberId}`;
  await admin.end();
}
