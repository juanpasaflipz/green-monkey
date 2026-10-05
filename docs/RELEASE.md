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
lint), every DB suite (`npm run test:db:qualification`, which ends with
`test:db:ops`), build, restart test, drain test, the compiled browser suite
with web and worker running, a 60 s load smoke, and an image smoke: the
Dockerfile is built with a stamped commit and the container must pass
`/api/health`, report the commit on `/api/version`, start the worker
(`/healthz`) and pass `migrate.js --check`.

`security`: `npm audit --omit=dev --audit-level=high` and gitleaks over the
full history (`.gitleaks.toml` allowlists only synthetic local/CI values).

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
  America/Mexico_City it also needs `allow_service_hours`. After the smoke the
  workflow tags `prod-YYYYMMDD-HHMM-<sha7>` and creates a GitHub release.
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
- after migrating: the reviewed grants manifest `scripts/grants.sql` for
  `PG_APP_USER`, the backup-reader policy reconciler
  (`scripts/db/post-migrate.sql`) and, with `--retention`, the retention pass;
- `--check` exits 3 while migrations are pending; `--dry-run` lists them.

Rules enforced by `tests/migrations-lint.test.ts` for files numbered 022 and
later:

- the first statement is `SET LOCAL lock_timeout = '…'`;
- no `CONCURRENTLY`, `BEGIN` or `COMMIT` in transactional files;
- new tables enable and force row-level security (allowlist: `schema_migrations`);
- data backfills wrap the DML in `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` /
  `FORCE ROW LEVEL SECURITY` on that table: the deployed migration role owns the
  tables but is not a superuser, so without it an `UPDATE` silently touches
  zero rows;
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
