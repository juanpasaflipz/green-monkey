# Backups and restore

The point-of-sale database is the restaurant's record of sales, tenders,
refunds and cash closes. Mexico's Código Fiscal de la Federación, Art. 30,
requires keeping accounting records and their support for five years from the
related filing (https://mley.mx/CFF/articulo/30/). The live database never
deletes financial rows; backups add point-in-time recovery and off-platform
copies.

Status: the backup, restore and verification code is exercised locally by
`tests/backup-db.ts` (dump through a backup-reader login, restore after
`globals.sql`, grants re-applied, schema fingerprint and control totals
compared). The Neon rehearsal and the R2 upload have not run yet; measured
RTO/RPO will be recorded under `docs/evidence/restore/` when they do.

## Targets

| Measure | Target | How |
| --- | --- | --- |
| RPO, normal operation | minutes | Neon history window (7 days on Launch, 30 on Scale): branch from any second in it |
| RPO, Neon project lost | ≤ 24 h | nightly encrypted `pg_dump` to R2 |
| RTO | ≤ 2 h | rehearsal measures it; recorded value goes here |
| Long-term | 5 years | monthly dumps kept 1,900 days (≈ 5.2 years), optional bucket lock |

## Layers

1. **Neon history window and snapshots** (`scripts/ops/provision-neon.sh`):
   instant restore or a branch from a past timestamp; daily and weekly
   snapshots kept 35 days; protected default branch. An instant restore
   rewinds every tenant on that branch, so a single-tenant repair uses a branch
   and a reviewed copy instead (below).
2. **Nightly logical dump** (`.github/workflows/backup.yml`,
   `scripts/ops/backup.ts`): production daily at 03:30 Mexico City, staging
   weekly. One read-only `REPEATABLE READ` snapshot is exported; control totals
   (orders, tenders, refunds, allocations, stock movements, drawers, voids,
   recoveries, audit, migrations) and a schema fingerprint (tables, forced
   RLS, policies, triggers, indexes) are read inside it; `pg_dump --snapshot
   --enable-row-security` dumps exactly that state as the `gm_<env>_backup`
   login (member of `gm_backup_reader`, which reads through the
   `ops_backup_read` policies the migration runner keeps on every RLS table).
   The stream is encrypted with `age` to the public recipients in
   `ops/backup/age-recipients.txt`; the sha256 of the encrypted bytes goes into
   a manifest. Objects go to `daily/<env>/YYYY/MM/` (35-day lifecycle) and, on
   the 1st, `monthly/<env>/YYYY/MM/` (1,900 days). The workflow verifies the
   stored sizes and alerts on failure; the uptime workflow alerts if the last
   successful backup is older than 26 hours.

## Key custody

The `age` private key is generated offline (`age-keygen`) and never enters
GitHub, Railway or any server. Keep it in the owner's password manager plus a
printed copy in a safe place; add a second recipient for a recovery holder.
Losing every copy of the private key makes the dumps unreadable.

## Restore rehearsal (quarterly, and before launch)

```sh
REHEARSAL_SOURCE_ENV=staging … npx tsx scripts/ops/rehearse-neon-restore.ts --dry-run
REHEARSAL_SOURCE_ENV=staging … npx tsx scripts/ops/rehearse-neon-restore.ts
```

1. **PITR drill:** branch the source project from one hour ago (expires in a
   day) and read the control totals through the backup login.
2. **Logical drill into a brand-new project** (the "Neon project lost" case):
   create the project, provision roles (global roles first: `pg_dump` never
   emits roles, which is what failed before on a fresh cluster), download the
   latest dump and manifest, check the sha256, decrypt, `pg_restore
   --no-owner --no-privileges --role=gm_migrator`, re-apply grants with the
   migration runner, then `tests/restore-verify-db.ts` checks: newest
   migration present, schema fingerprint equal, control totals equal, runtime
   role still sees one tenant at a time.
3. RTO (start → verified) and RPO (dump snapshot age) are written to
   `docs/evidence/restore/<date>-<env>.json`. Review, then
   `--cleanup <that file>` deletes the branch and project after a typed
   confirmation.

Local equivalent (no cloud): `scripts/rehearse-restore.sh` on the checkout's
own cluster, or `npx tsx tests/backup-db.ts` against the isolated test target.

## Single-tenant repair (manual, reviewed)

Rare; never automatic.

1. Create a Neon branch from the timestamp before the damage.
2. As the backup login on that branch, export the affected tenant's rows
   (`SET row_security = on`; filter by `tenant_id`) for the damaged tables.
3. Compare with production; write a reviewed SQL script that inserts the
   missing rows (financial tables are insert-only: corrections are new rows,
   never edits).
4. Apply it as the migration owner in one transaction with the owner pattern
   (`ALTER TABLE … NO FORCE ROW LEVEL SECURITY` / `FORCE`), record it in the
   incident log, delete the branch.
