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
- GitHub environments `staging` and `production` accept deployments from the
  branch `main` only: a custom deployment branch policy with exactly one
  rule, `main`, which `github-protect.sh` reads back (PLATFORM-CI-2). The
  "protected branches" mode is not used, because `main` is protected by a
  ruleset rather than a classic branch protection rule, and GitHub then lets
  every branch deploy.

## Continuous integration (`.github/workflows/qualification.yml`)

Runs on every pull request and on pushes to `main`.

`qualify`: Node from `.nvmrc` (24.21.0), PostgreSQL 18 service (Neon parity).
Provisions the global roles, migrates both databases as the non-superuser
`gm_migrator` with `APP_ENV=staging` (migrate, then grants, then retention),
seeds fixtures, then: typecheck, lint, unit tests (including the migrations
lint), every DB suite (`npm run test:db:qualification`, which includes
`test:db:ops`, `test:db:access`, `test:db:account` and `test:db:support`),
build, restart test, access HTTP checks (`npm run test:access-http`), account
HTTP checks (`npm run test:account-http`), drain test, the compiled browser suite
with web and worker running, a 60 s load smoke, and an image smoke: the
Dockerfile is built with a stamped commit and the container must pass
`/api/health`, report the commit on `/api/version`, start the worker
(`/healthz`) and pass `migrate.js --check`.

The browser suite is written to run again on a database it already ran
against (W3-2, LD-42): `tests/browser/kitchen-hygiene.ts` delivers, as the
demo owner, every kitchen round a test in the order-heavy specs (kitchen,
reports, service, voids, core, discounts, menu, fiscal, cfdi, finance) opened,
and `tests/browser/global-setup.ts` delivers the rounds earlier runs left open
on the demo restaurants before a run, only on the isolated local fixture
database. Tests find their own records by unique names or by searching (no
"last" ticket or first register page). A reused staging database still
accumulates the open checks, and the rounds of specs outside that list.
Local confirmation (October 6, 2026, local fixture only, not staging): after
the full qualification, three full browser rounds on one database without a
reset between them, the last two with four `yes` processes loading the CPU,
each passed 229 tests (1 skipped) with the same web process throughout; each
run left 20 open rounds from specs outside the list, which the next run's
global setup delivered. An earlier set of the same rounds, run while the
machine's load average was about 440 for reasons outside this suite, had 4
and 9 time-outs in tests whose bodies W3-2 did not change (each passed when
rerun alone on that database).

`security`: `npm audit --omit=dev --audit-level=high` and gitleaks over the
full history (`.gitleaks.toml` allowlists only synthetic local/CI values).

Legal values in CI (account 031): the job sets `LEGAL_UNPUBLISHED_SIGNUP=allow`,
and only the account-http and compiled browser steps carry the fictional,
plausible legal and support set of `tests/fixtures/legal-ci.ts` ("Nopal Verde
Software S.A. de C.V."), so those servers publish the documents under
`NODE_ENV=production`. These values, and the `RD_LEGAL_*` / `RD_SUPPORT_*`
repository variables an acceptance workflow may hold, are **fictional** and
never reach Railway.

## Go-live checklist (account and legal)

Before production accepts its first restaurant (see also
[provisioning](PROVISIONING.md) §9 and [launch hand-off](LAUNCH_HANDOFF.md)):

1. Counsel has reviewed the privacy notice, terms and data processing agreement
   (D1, D2), and any text change is published as a new version
   ([account and legal](ACCOUNT_AND_LEGAL.md), "How to publish a new version").
2. The production `web` variables hold the real `LEGAL_ENTITY_NAME`,
   `LEGAL_ENTITY_ADDRESS`, `LEGAL_PRIVACY_CONTACT_EMAIL`,
   `LEGAL_JURISDICTION` (and the optional `LEGAL_ENTITY_RFC`) and the
   `SUPPORT_*` channels, never the fictional CI set ("Nopal Verde Software
   S.A. de C.V.", `@nopalverde.mx`, `server/legal-ci.ts`): production refuses
   those values and keeps the documents unpublished.
3. `GET /api/account-config` reports `legal.status: "published"`, and the
   startup log has no `legal_documents_unpublished`.
4. `LEGAL_UNPUBLISHED_SIGNUP` is unset (startup logs
   `legal_unpublished_signup_ignored` otherwise).
5. Public ordering (032/033/034): the "DB-9 validation" check
   ([RUNBOOK.md](RUNBOOK.md)), run as the Neon owner role and never as
   `gm_migrator` (FORCE RLS hides every row from it), returns no rows on
   staging before the change that brings 032 and 033 to `main` merges
   (staging deploys on its own once Qualification passes there) and on
   production before that SHA is dispatched (PUBLIC-OPS-8). That deploy runs
   before 07:00 Mexico City once production has traffic (RUNBOOK "Deploy
   window"), and the LD-5 delta reviews of B1-B4 are done (LD-23, LD-41).
   The GAP-4 `target` capacity run on staging includes public ordering's
   polls (inbox summary and inbox on operator devices, diner revision,
   submit and status) before `DB_POOL_MAX` is chosen (LOAD_TEST.md,
   PUBLIC-OPS-7).
   `PUBLIC_ORDERING_ENABLED` is unset or `true` on production
   (`/api/account-config` reports `publicOrdering.enabled: true`; since public
   ordering's flag flip, B4, unset means on everywhere), and a staging browser
   run passed on the same revision. To turn QR and kiosk ordering off (roll
   back), set it to `false` on `web` and redeploy: no deploy window and no
   new build (RUNBOOK "Online ordering abuse", step 6). Reverting the B4
   commit restores the old default (off in production when unset) only
   where that commit exists; `main` takes squashed or rebased merges, so
   there the forward change in PUBLIC_ORDERING "Rolling back QR and kiosk
   ordering" applies (PUBLIC-OPS-2).
6. At least one support operator is provisioned (`npm run support:provision`,
   [operations](OPERATIONS.md), Support) and can run `lookup`; pilot
   restaurants get Pro with `grant-entitlement`.
7. `SAAS_TAX_MODE` stays `off` while billing is disabled.

Every third-party action in `.github/` is pinned by full commit SHA with the
release in a trailing comment (`actions/checkout@<sha> # v7.0.1`); the deploy,
retention, backup and uptime jobs hold production secrets, so a moved tag must
not change what runs. Those privileged jobs also check out with
`persist-credentials: false` and restore no npm cache
(`package-manager-cache: false`): the cache Qualification saves would also
hold `~/.npm/_npx`, where the Railway CLI is installed (PLATFORM-CI-3, CI-5). `tests/workflows.test.ts` refuses a tag or branch reference. To
update one, read the new tag's commit with
`git ls-remote https://github.com/actions/<name> refs/tags/<tag>` (an
annotated tag lists a second `^{}` line: use that commit), review the
release, confirm that its `action.yml` at that commit declares
`runs.using: node24` (`gh api "repos/actions/<name>/contents/action.yml?ref=<sha>"`;
GitHub retires the Node.js 20 runtime for JavaScript actions), and replace
every occurrence. The pins were last moved on 2026-10-05: `actions/checkout`
v7.0.1, `actions/setup-node` v7.0.0 and `actions/upload-artifact` v7.0.1, all
`node24`. No input this repository passes was renamed (checkout v6 stores the
persisted credentials in a separate file and v7 refuses fork pull-request code
under `workflow_run`, which `deploy.yml` never checks out because it accepts
only `push` runs; setup-node v5+ caches npm automatically, so Qualification
keeps `cache: npm` explicit and the privileged jobs turn it off;
upload-artifact v7 adds `archive`, default `true`).
`tests/workflows.test.ts` refuses a pin older than the first Node 24 major of
each action.

## Continuous delivery (`.github/workflows/deploy.yml`)

- **Staging:** after Qualification succeeds for a push to `main`, the composite
  action `.github/actions/deploy` builds, then **migrates first**:
  `node build/scripts/migrate.js --grants --retention` as `gm_migrator` on the
  direct endpoint, from the GitHub environment secret `MIGRATION_DATABASE_URL`
  (with the environment variable `PG_APP_USER` and `app-env`). Only then does
  it install the pinned IaC package (no lockfile change), run
  `railway config plan` and `railway config apply --yes` (destructive changes
  stop for review), stamp `build-info.json`, upload the `worker` and then
  `web`, and run `scripts/ops/smoke.mjs --expect-commit <sha>`, which also
  waits until the worker reports that commit with its jobs runner on
  (`railway up --ci` returns when the build ends, and a worker that fails to
  boot leaves the old one answering). If the migrate
  step fails (a missing secret fails it with
  `::error::environment secret MIGRATION_DATABASE_URL is not set`), nothing on
  Railway changes and the old revision keeps serving on the old schema; the
  migrations are expand-only, so the old revision also keeps working on the
  expanded schema while the new one uploads. No Railway service holds the
  schema-owner credential, and the worker has no `preDeploy`. Success marks
  the commit with the `deploy/staging` status.
- **Production:** only by Actions → Deploy → Run workflow with the full SHA and
  the typed phrase `deploy <sha7> to production`. The SHA must be on `main` and
  carry `deploy/staging` = success. Between 12:00 and 23:59
  America/Mexico_City it also needs `allow_service_hours`. The IaC sync runs
  only when the SHA is the head of `main` (`railway_config: auto`); a
  rollback to an older SHA keeps the live service configuration
  ([RUNBOOK.md](RUNBOOK.md), Rollback). After the smoke the workflow creates
  the GitHub release `prod-YYYYMMDD-HHMM-<sha7>` (`gh release create
  --target <sha>` makes the tag). The newest `prod-*` tag is the live release:
  the daily retention run checks out its code. Never roll back from the
  Railway dashboard (it restores old variables; RUNBOOK "Rollback").
- Required reviewers on environments are not available for private
  repositories on the Free/Pro/Team plans, so the production gate is the
  manual dispatch plus the typed confirmation and the staging proof.

`/api/version` reports the commit from `build-info.json` (stamped by CD and by
the CI image build; `local` otherwise); nobody sets it by hand.

## Migrations

Migrations live in `migrations/NNN_name.sql` and are applied by
`scripts/migrate.ts` (compiled to `build/scripts/migrate.js`), run by the
GitHub Actions deploy job as `gm_migrator` before any service deploys; CI
qualification migrates the same way. The capability roles the grants name
come from `scripts/ops/sql/globals.sql`, never from a migration; a migration
may only carry the `IF NOT EXISTS … CREATE ROLE … NOLOGIN` fallback that
local and CI clusters need (contract C-11):

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
  and a failing manifest rolls the newest migration back with it. When the
  newest pending file is a no-transaction file (033), the manifest and that
  file's registry row commit together in one explicit transaction on the
  runner's reserved connection after its last statement. With nothing
  pending, the manifest runs in its own transaction;
- then the backup-reader policy reconciler (`scripts/db/post-migrate.sql`) and,
  with `--retention`, the retention pass (a failure alerts `retention_failed`
  and never fails the deploy; every batch is bounded by a 200 ms lock wait and
  a 1.5 s statement timeout, [RUNBOOK.md](RUNBOOK.md) "Retention");
- `--retention-only` runs retention and nothing else (no migrations, grants
  or reconcile): up to 10 passes inside 04:00–07:00 America/Mexico_City while
  a backlog remains, exit 1 when a table fails (after alerting) and 75 when a
  table was skipped on a lock timeout;
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

## Retention (`.github/workflows/retention.yml`)

Daily, as `gm_migrator` from the environment secret, never from Railway:
production at 05:15 and staging at 05:45 America/Mexico_City (11:15 and 11:45
UTC), after the 03:30 backup and inside the 04:00–07:00 retention window. It
runs `npx tsx scripts/migrate.ts --retention-only`, retries a lock-timeout
skip (exit 75) twice, 5 minutes apart, and opens or updates the
`ops-alert: <env>` issue when the run is red. Schedules run only for the
environments listed in `OPS_LIVE_ENVIRONMENTS` and only from the default
branch; a manual dispatch always runs. Only `deploy.yml` and `retention.yml`
read the `MIGRATION_DATABASE_URL` secret (`tests/workflows.test.ts`). Details:
[RUNBOOK.md](RUNBOOK.md) "Retention".
