# Release process

How a change reaches staging and production. Status: workflows and scripts are
written and validated locally (YAML parsed, scripts dry-run, all suites green);
branch protection, environments and the first CD run are pending the steps in
[RUNBOOK.md](RUNBOOK.md) "Staging cutover".

## Branches and protection

- `main` is the only deployable branch. `scripts/ops/github-protect.sh` applies
  `ops/github/main-ruleset.json`: pull request required (0 approvals while
  there is a single maintainer; raise to 1 with a second reviewer), stale
  approvals dismissed, conversations resolved, linear history (squash or
  rebase), no force-push or deletion, required checks `qualify` and
  `security` (strict: up to date with `main`), no bypass actors.
- GitHub environments `staging` and `production` accept deployments from
  protected branches only.

## Continuous integration (`.github/workflows/qualification.yml`)

Runs on every pull request and on pushes to `main`.

`qualify`: Node from `.nvmrc` (24.21.0), PostgreSQL 18 service (Neon parity).
Provisions the global roles, migrates both databases as the non-superuser
`gm_migrator` with `APP_ENV=staging` (migrate, then grants, then retention),
seeds fixtures, then: typecheck, lint, unit tests (including the migrations
lint), every DB suite (`npm run test:db:qualification`, which includes
`test:db:ops`), build, restart test, drain test, the compiled browser suite
with web and worker running, a 60 s load smoke, and an image smoke: the
Dockerfile is built with a stamped commit and the container must pass
`/api/health`, report the commit on `/api/version`, start the worker
(`/healthz`) and pass `migrate.js --check`.

`security`: `npm audit --omit=dev --audit-level=high` and gitleaks over the
full history (`.gitleaks.toml` allowlists only synthetic local/CI values).

Every third-party action in `.github/` is pinned by full commit SHA with the
release in a trailing comment (`actions/checkout@<sha> # v4.4.0`); the deploy,
backup and uptime jobs hold production secrets, so a moved tag must not change
what runs. `tests/workflows.test.ts` refuses a tag or branch reference. To
update one, read the new tag's commit with
`git ls-remote https://github.com/actions/<name> refs/tags/<tag>` (an
annotated tag lists a second `^{}` line: use that commit), review the
release, and replace every occurrence.

## Continuous delivery (`.github/workflows/deploy.yml`)

- **Staging:** after Qualification succeeds for a push to `main`, the composite
  action `.github/actions/deploy` installs the pinned IaC package (no lockfile
  change), runs `railway config plan` and `railway config apply --yes`
  (destructive changes stop for review), stamps `build-info.json`, uploads the
  `worker` (its preDeploy runs `migrate.js --grants --retention`) and then
  `web`, and runs `scripts/ops/smoke.mjs --expect-commit <sha>`. Success marks
  the commit with the `deploy/staging` status.
- **Production:** only by Actions → Deploy → Run workflow with the full SHA and
  the typed phrase `deploy <sha7> to production`. The SHA must be on `main` and
  carry `deploy/staging` = success. Between 12:00 and 23:59
  America/Mexico_City it also needs `allow_service_hours`. The IaC sync runs
  only when the SHA is the head of `main` (`railway_config: auto`); a
  rollback to an older SHA keeps the live service configuration
  ([RUNBOOK.md](RUNBOOK.md), Rollback). After the smoke the workflow tags
  `prod-YYYYMMDD-HHMM-<sha7>` and creates a GitHub release.
- Required reviewers on environments are not available for private
  repositories on the Free/Pro/Team plans, so the production gate is the
  manual dispatch plus the typed confirmation and the staging proof.

`/api/version` reports the commit from `build-info.json` (stamped by CD and by
the CI image build; `local` otherwise); nobody sets it by hand.

## Migrations

Migrations live in `migrations/NNN_name.sql` and are applied by
`scripts/migrate.ts` (compiled to `build/scripts/migrate.js`):

- one transaction per file, `lock_timeout` 5 s and `statement_timeout` 10 min,
  retried 4 times on lock timeout (2/4/8/16 s), then the deploy fails and the
  old revision keeps serving;
- an advisory lock serialises concurrent runners; checksums of applied files
  must never change;
- files whose leading comments contain `-- gm:no-transaction` run statement by
  statement (split on lines `-- gm:statement-break`) for
  `CREATE INDEX CONCURRENTLY`; each statement must be idempotent;
- refuses a pooled (`-pooler`) host and, in staging/production, a superuser,
  BYPASSRLS, CREATEROLE or `neon_superuser` login;
- with `--grants`, the reviewed grants manifest `scripts/grants.sql` for
  `PG_APP_USER` commits in the **same transaction as the newest pending
  migration**, before its `schema_migrations` row. Readiness keys on that row,
  so a new revision never passes `/api/health` before its tables are granted,
  and a failing manifest rolls the newest migration back with it. With nothing
  pending, the manifest runs in its own transaction;
- then the backup-reader policy reconciler (`scripts/db/post-migrate.sql`) and,
  with `--retention`, the retention pass (a failure alerts `retention_failed`
  and never fails the deploy; the worker repeats it every 15 minutes between
  04:00 and 07:00 America/Mexico_City; every batch is bounded by a 200 ms
  lock wait and a 1.5 s statement timeout, [RUNBOOK.md](RUNBOOK.md)
  "Retention");
- `--check` exits 3 while migrations are pending; `--dry-run` lists them.

Rules enforced by `tests/migrations-lint.test.ts` (the rules live in
`scripts/ops/migrations-lint.ts`; lint any directory with
`npx tsx scripts/ops/migrations-lint.ts <dir>`) for files numbered 022 and
later:

- the first statement is `SET LOCAL lock_timeout = '…'`;
- no `CONCURRENTLY`, `BEGIN` or `COMMIT` in transactional files;
- new tables enable and force row-level security, either as literal
  `ALTER TABLE` statements or in the standard `DO` loop
  (`FOREACH t IN ARRAY ARRAY[…]` / `EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t)`);
  allowlist: `schema_migrations`, `schema_grants`;
- **backfills use the owner pattern.** Deployed migrations run as
  `gm_migrator`, which owns the tables but is neither a superuser nor
  BYPASSRLS, so `FORCE ROW LEVEL SECURITY` applies to it and, with no tenant
  set, every `tenant_scope` policy hides every row: an `UPDATE`, `DELETE` or
  `INSERT … SELECT` silently changes nothing, and tables it reads look empty.
  Every forced table that a top-level or `DO`-block statement writes **or
  reads** (`FROM`, `JOIN`, `USING`) needs `ALTER TABLE t NO FORCE ROW LEVEL
SECURITY;` before the statement and `ALTER TABLE t FORCE ROW LEVEL SECURITY;`
  after it, in the same file (reference: `025_menu.sql` section 8). Local
  development migrates as a superuser and CI migrates empty databases, so only
  the lint and `tests/migrate-db.ts` (a backfill applied as a non-superuser
  owner to a database with rows) catch this;
- expand-only: `DROP TABLE/COLUMN`, `RENAME` and column type changes need a
  `-- gm:contract-approved` line agreed with the tech lead; replacing a
  constraint, index, policy or trigger in the same file is allowed.

Expand/contract: ship the expanding migration and the code that tolerates both
shapes first; remove the old shape only in a later release once no running
revision uses it. A migration file is immutable once it has run on staging.

## IaC changes

Edit `.railway/railway.ts`, review `railway config plan` locally with a
staging-scoped token, merge. CD applies non-destructive changes; a deletion
(service or variable) must be applied by hand with `--confirm-destructive`
after review.
