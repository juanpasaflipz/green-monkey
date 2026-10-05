# Staging operation and verification

September 30 staging checkpoint (M4 item voids): Railway deployment
`6526e175-a35a-475e-88a7-d4280c497786` serves
`fb922ab0d82dd19b246f25f7724fe970423e0f64`. Before any change, Neon branch
`pre-021-staging-backup-2026-09-30` (`br-polished-hall-aem062zv`, no compute)
copied the primary branch as the restore point. Migration 021 (`line_voids`,
employee PIN lockout columns) was applied to `green_monkey_staging` with
`scripts/migrate.ts` over the direct endpoint as `neondb_owner`, followed by
`scripts/grant-runtime.ts` for `gm_staging_app`. Read-only checks confirmed the
migration registry, forced RLS on `line_voids`, runtime `SELECT,INSERT` plus
`UPDATE` limited to the two kitchen-acknowledgement columns, the immutability
trigger and both `employees` columns. The previous build stayed healthy between
migration and deploy because its readiness gate requires only 020.

The source upload was a `git archive` of `fb922ab` (tracked files only).
Deployment `35568e97-b5cb-47a4-be83-427d272ff065` built and started, health
passed, and the served bundle contains the void screens. `RAILWAY_GIT_COMMIT_SHA`
is a manually set service variable, so it was updated to `fb922ab` for
`/api/version` (redeploy `ab09128b-8813-420b-8b8d-8c02754247b7`). The
`neondb_owner` password was then rotated and the staging
`MIGRATION_DATABASE_URL` updated; redeploy `6526e175` ran the migration step
with the new credential and passed health. The `gm_staging_app` and
`gm_staging_billing` passwords were exposed in a working session and must be
rotated, together with `DATABASE_URL` and `BILLING_DATABASE_URL`. Private env
files holding the old `neondb_owner` password are stale. The void/approval/kitchen
flow has not been exercised on staging; local `test:db:voids` (10 checks) and
`tests/browser/voids.spec.ts` passed. The workstation `RAILWAY_API_TOKEN` was
rejected by CLI 5.63.1; the upload used an interactive `railway login` session.

September 23 staging checkpoint: Railway deployment
`35e6fab1-0774-4e43-87ac-6262da6324fd` serves
`b05c6a422c4fc4ca5330cb6a7f42a1098a0a58d2` at the authorized staging URL.
Health and version pass. A fresh restricted backup preceded additive migrations
016–020 and reviewed runtime grants. Source-only upload excluded private files.
Deployed checks passed: 13 tenant-isolation checks; 12 recovery/Free-selection
checks including original closed-drawer recognition, duplicate replay, replacement
device, task resolution, refund and repeatable browser backup restore/download;
browser cash/KDS/refund/close, four viewports
and zero selling accessibility violations; real Stripe sandbox two-location trial,
invitation/switching, preserved trial end and cancellation of both locations to Free.
Evidence is under `docs/evidence/staging/`. Synthetic fixtures remain for audit;
no live charges or production cutover occurred. Printer and restaurant payment
providers remain disabled because none are selected. M3 still needs the remaining
exact-candidate paid-upgrade/restart/trial-expiry evidence;
M4–M11 remain required. This is not full product completion.


Latest billing qualification: deployment `d0178bd6-4861-43e1-8699-e4056e6d5587`
serves `fc939bc`, with migrations through 013 and sandbox billing enabled.
See [billing evidence](BILLING_IMPLEMENTATION.md). The pre-billing backup is
private at `work/billing/staging-before-billing.dump`. Staging restart and durable
queued-operation recovery passed; this is not a full restore/rollback rehearsal.

Latest qualification, September 14: deployment
`46cca000-9810-4451-a0fd-84c1d2e92855` serves `0fbc3e9`, with migrations 001–010
and saved Google staging credentials. Real Google signup/entry/return and 13
deployed tenant-isolation checks passed. See
[tenancy qualification](TENANCY_QUALIFICATION.md) for evidence and limits;
the initial September 12 deployment details below are historical.

Staging is running at https://green-monkey-staging.up.railway.app. It is a development build with fictional restaurants and transactions, not a completed release or production cutover. Required feature gaps remain in [DELIVERY_STATUS.md](DELIVERY_STATUS.md).

## Targets

- Railway project: `9bd572ca-7c0b-41f8-8553-e69253e8e9e8` (`proactive-upliftment`).
- New staging environment: `9e87eafe-e620-40ad-98c2-2c541e1afaf7`.
- Web service: `cf91a7f0-e533-4354-baea-d5d56df6d3d9`.
- Initial successful deployment: `3a9fab03-b4af-449f-8a3f-31bcf543f664`.
- The supplied default `production` environment was not deployed.
- Separate Neon databases: `green_monkey_staging` and `green_monkey_test`. Separate login roles: `gm_staging_app` and `gm_test_app`. Neither owns tables, bypasses RLS, creates roles/databases, nor inherits privileged roles. Database CONNECT is revoked from PUBLIC on these new databases.
- Provisioning uses the verified direct endpoint; runtime uses the verified pooled endpoint. Both client connections negotiated TLS 1.3. No source database was used.

## Access

On the provisioning workstation, `.env.staging-access` holds the generated owner password and employee PINs, together with the URL and restaurant ID. The file is ignored by Git and readable only by its owner. The public local-demo password does not work in staging. Login as owner first to pair a browser before employee PIN access.

The other ignored files separate provisioning credentials, staging runtime credentials, test credentials, workspace API access and a staging-only Railway deployment token. Do not copy these files into source archives, screenshots or tickets.

## Reproducible database setup

Use Node 24. Create separate empty staging/test databases and restricted login roles on an approved new Neon target. Store explicit direct `MIGRATION_DATABASE_URL`, pooled `DATABASE_URL`, and matching `PG_APP_USER` in a private environment file. Do not source connection strings as shell commands. The following commands use Node's environment-file parser:

```sh
node --env-file=.env.neon-staging --import tsx scripts/migrate.ts
node --env-file=.env.neon-staging --import tsx scripts/grant-runtime.ts
node --env-file=.env.neon-test --import tsx scripts/migrate.ts
node --env-file=.env.neon-test --import tsx scripts/grant-runtime.ts
```

`grant-runtime.ts` reads the reviewed privilege manifest and safely substitutes quoted database/role identifiers. It refuses privileged roles and application-table owners.

Optional fictional fixtures require `FIXTURE_TARGET_ALLOWLIST` equal to the exact direct `host:port/database`, a database named `green_monkey_staging` or `green_monkey_test`, a generated `FIXTURE_OWNER_PASSWORD` of at least 24 characters and distinct six-digit `FIXTURE_CASHIER_PIN`/`FIXTURE_KITCHEN_PIN`. Existing organizations cause refusal; concurrent initialization is serialized. No legacy data or provider side effects are involved.

```sh
node --env-file=.env.neon-staging --import tsx scripts/seed-staging.ts
node --env-file=.env.neon-test --import tsx scripts/seed-staging.ts
node --env-file=.env.neon-test --import tsx tests/database.ts
```

The test environment file must include `TEST_DATABASE_URL` and the exact pooled target in `TEST_DATABASE_HOST_ALLOWLIST`. Tests reject production mode, missing allowlists and database names without `_test`.

## Deployment

Prepared, not yet cut over (the cutover is an operator step with the owner's
consent: [RUNBOOK.md](RUNBOOK.md) "Staging cutover"). After the cutover:

- Merging to `main` runs Qualification; on success `.github/workflows/deploy.yml`
  applies `.railway/railway.ts` (non-destructive changes only), stamps
  `build-info.json` with the commit, uploads the `worker` service (its
  preDeploy runs `migrate.js --grants --retention` as `gm_migrator`) and then
  `web`, and runs `scripts/ops/smoke.mjs` until `/api/version` reports the
  merged SHA. Nobody uploads from a workstation and nobody types
  `RAILWAY_GIT_COMMIT_SHA` by hand any more; delete that service variable.
- `web` holds only `DATABASE_URL`/`PG_APP_USER` (runtime role), `JWT_SECRET`,
  Google OAuth, `STRIPE_WEBHOOK_SECRET` and, with billing enabled,
  `BILLING_DATABASE_URL`. It refuses to start with `MIGRATION_DATABASE_URL`,
  `BACKUP_DATABASE_URL` or `STRIPE_SECRET_KEY` when `APP_ENV=staging`.
- `worker` (new service, no public domain) holds `MIGRATION_DATABASE_URL`
  (`gm_migrator`, direct endpoint), `PG_APP_USER`, `BILLING_DATABASE_URL`, the
  Stripe sandbox keys and `ALERT_WEBHOOK_URL`. `web` reaches its `/healthz` at
  `http://worker.railway.internal:3002` (`WORKER_URL`) for `/api/ops/status`.
- Health: `/api/health` (schema ready, not draining); public status:
  `/api/ops/status`; client-address probe: `/api/ops/diagnostics/ip`, which the
  CD smoke uses to prove Railway's proxy hop is trusted and spoofed headers are
  not.

Until the cutover, the existing one-service setup described in the checkpoints
above remains what is deployed. Do not redeploy it from this tree before the
cutover: `railway.json`, which carried the preDeploy migrate command, is gone
from it, and the Stripe provider loop now runs only in `worker`. A
`railway up` of this tree to the single existing service would therefore apply
no migrations, keep `/api/health` at 503 `schema_not_ready` (failing the
deploy's health check) and run without billing. Until the cutover, redeploy
that service only from a checkout from before the ops merge (`ca36236` or
earlier). Railway stops reading its `railway.json` on 2026-12-01, so the
cutover must happen before then.

## Credential rotation log

Rotations are recorded here without secrets (date, role, action, operator).
The procedure is [RUNBOOK.md](RUNBOOK.md) "Credential rotation"
(`scripts/ops/rotate-db-login.ts`, dual role, zero downtime).

| Date | Role | Action | Operator |
| --- | --- | --- | --- |
| — | `gm_staging_app` | Exposed in a working session (September 30); rotation pending at cutover step 9 | — |
| — | `gm_staging_billing` | Exposed in a working session (September 30); replace with a rotated billing login at cutover step 10 | — |
| — | `neondb_owner` | Rotate after the cutover and keep offline (cutover step 11) | — |

## Checks and evidence

On September 12, 2026 Mexico City time (September 13 UTC):

- Five checksummed migrations applied to both databases; 17 integration checks passed on Neon test, including pooled transaction-local tenant isolation, concurrent cash/stock operations, rollback and immutable history.
- Typecheck, lint, 14 domain tests and local production build passed. Railway independently completed Docker build and reported successful deployment.
- Live browser smoke passed owner login, secure HttpOnly cookies, anonymous-session rejection, modifier selection, kitchen acknowledgement/readiness, cash payment and receipt.
- Selling screenshots at 1440×900, 1024×768, 768×1024 and 390×844 had no page-wide overflow. Keyboard search passed; automated WCAG-tagged axe checks on the selling state reported zero violations. No browser page errors were recorded.
- Database reconciliation independently confirmed one 9000-minor-unit cash tender for the 9000-minor-unit smoke order. Kitchen remained ready while the unacknowledged bar round remained active, preserving separate preparation/payment lifecycles. The initialized-target fixture guard also refused a repeat seed.
- Evidence is in `docs/evidence/staging/`, including `smoke.json`, `persistence.json` and screenshots. The smoke run deliberately created a fictional cash sale and drawer; it does not exercise real payment processing or hardware printing.

To rerun the smoke, provide `STAGING_URL`, matching `STAGING_ORIGIN_ALLOWLIST`, and generated fixture owner password in the private staging file:

```sh
node --env-file=.env.neon-staging scripts/staging-smoke.mjs
```

A smoke success does not imply full acceptance. Staging backup/restore and rollback rehearsal, full offline/reconnection and split/refund browser suites on the cloud target, sustained performance, provider sandboxes, physical printing and all remaining matrix gaps still require qualification.
