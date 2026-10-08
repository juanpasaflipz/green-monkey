# Staging operation and verification

**Current state (October 8, 2026).** Staging was cut over to the Wave 2.0 setup on
October 6–7, 2026: steps 1–13 of [RUNBOOK.md](RUNBOOK.md) "Staging cutover", recorded
below in "Wave 2.0 cutover record" and "Credential rotation log". Two Railway services
in the `staging` environment, `web` and `worker`, deploy from `main` through GitHub
Actions (`.github/workflows/deploy.yml`): migrations first, as `gm_migrator` from a
GitHub environment secret, then the IaC sync, the `worker` and `web` uploads and the
smoke. Staging runs `3e62285` (migrations through 035; deploy run 37636967247, smoke
green). Still pending: cutover steps 10, 14 and 15, the older Neon branch decision and
the CFDI organizations-provider rehearsal ([LAUNCH_HANDOFF.md](LAUNCH_HANDOFF.md)
section 3). Staging stays a development environment at
https://green-monkey-staging.up.railway.app with fictional restaurants and
transactions, not production; required feature gaps remain in
[DELIVERY_STATUS.md](DELIVERY_STATUS.md).

## Checkpoints before the cutover (historical)

The checkpoints below describe the one-service setup the cutover replaced (uploads
from a workstation, migrations as `neondb_owner` in a `preDeploy`, a hand-set
`RAILWAY_GIT_COMMIT_SHA`). They are kept as history: their "pending", "must be
rotated" and "not yet" statements were true when written and are closed by the
records further down.

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

## Targets

- Railway project: `9bd572ca-7c0b-41f8-8553-e69253e8e9e8` (`green-monkey`).
- New staging environment: `9e87eafe-e620-40ad-98c2-2c541e1afaf7`.
- Web service: `cf91a7f0-e533-4354-baea-d5d56df6d3d9`, renamed from `green-monkey` to
  `web` at cutover step 3 (same id and domain).
- Worker service: `c79f34cd-4ac5-4bfb-9539-cabd9f53deba`, created by the cutover's IaC
  apply (step 6); no public domain.
- Initial successful deployment (September 12, historical): `3a9fab03-b4af-449f-8a3f-31bcf543f664`.
- The supplied default `production` environment was not deployed.
- Separate Neon databases: `green_monkey_staging` and `green_monkey_test`. Separate login roles: `gm_staging_app` and `gm_test_app` (historical for staging: since 2026-10-07 its runtime login is `gm_staging_app_r20261007`, and the cutover added `gm_migrator`, `gm_staging_worker`, `gm_staging_backup` and the billing login `gm_staging_billing_r20261007`; see below). Only `gm_migrator` owns application tables; none of these logins bypasses RLS, creates roles/databases or inherits privileged roles. Database CONNECT is revoked from PUBLIC on these new databases.
- Provisioning uses the verified direct endpoint; runtime uses the verified pooled endpoint. Both client connections negotiated TLS 1.3. No source database was used.

## Access

On the provisioning workstation, `.env.staging-access` holds the generated owner password and employee PINs, together with the URL and restaurant ID. The file is ignored by Git and readable only by its owner. The public local-demo password does not work in staging.

From the access release on (migration 023, [ACCESS.md](ACCESS.md); deployed to staging on 2026-10-07 with migrations 022–034):
- The owner-password form ("Acceso de demostración") appears only for the restaurant named by `DEMO_TENANT_ID` on `web`. On staging set it to the **fictional** staging restaurant only; never set it in production (the server refuses to start, and `.railway/railway.ts` declares it for non-production environments only). Railway's documentation does not say what `preserve()` does for a variable that is not set yet, so set `DEMO_TENANT_ID` on staging's `web` **before** the first `railway config apply` that declares it, and check that apply's plan.
- Every other browser pairs with a single-use code from **Configuración → Dispositivos → Vincular un dispositivo** (10 minutes, at most 5 open). Staff then pick their name and enter their PIN; nobody types a restaurant ID.
- `ACCESS_STEP_UP_SECONDS` and `ACCESS_IDLE_LOCK_DEFAULT_SECONDS` are optional (defaults 120 s and 180 s) and declared with `preserve()`; leave them unset on staging unless a check needs otherwise.
- `npm run access:pairing-code` is a support fallback that writes a code straight into the database with the migration credential and the target's `JWT_SECRET`; on staging prefer a code from Dispositivos.
- `scripts/staging-smoke.mjs` now signs in on the demo form, pairs a second browser with a code, signs the cashier in by PIN, passes a refund's PIN step-up and unpairs the synthetic terminal afterwards. It has not run against staging yet; the CD smoke (`scripts/ops/smoke.mjs`, "Deployment" below) runs on every deploy and does not sign in.

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

Cut over on October 6–7, 2026, by the operator with the owner's consent
([RUNBOOK.md](RUNBOOK.md) "Staging cutover"; record in "Wave 2.0 cutover record"
below). Since then:

- Merging to `main` runs Qualification; on success `.github/workflows/deploy.yml`
  first runs `migrate.js --grants --retention` as `gm_migrator` from the
  GitHub environment secret `MIGRATION_DATABASE_URL` (a failure stops before
  Railway), then applies `.railway/railway.ts` (non-destructive changes only),
  stamps `build-info.json` with the commit, uploads the `worker` service and
  then `web`, and runs `scripts/ops/smoke.mjs` until `/api/version` reports
  the merged SHA. Nobody uploads from a workstation and nobody types
  `RAILWAY_GIT_COMMIT_SHA` by hand any more; the cutover's apply (step 6)
  deleted that service variable.
- `web` holds only `DATABASE_URL`/`PG_APP_USER` (runtime role), `JWT_SECRET`,
  `SIGNING_KEYS`, Google OAuth, `STRIPE_WEBHOOK_SECRET` and, with billing
  enabled, `BILLING_DATABASE_URL`. It refuses to start with
  `MIGRATION_DATABASE_URL`, `BACKUP_DATABASE_URL`, `STRIPE_SECRET_KEY`,
  `WORKER_DATABASE_URL` or the Facturapi keys when `APP_ENV=staging`.
- `worker` (new service, no public domain) holds `WORKER_DATABASE_URL`
  (`gm_staging_worker`, a `gm_jobs_worker` member, pooled endpoint),
  `BILLING_DATABASE_URL`, the Stripe sandbox keys, `APP_URL`,
  `FACTURAPI_TEST_KEY` (CFDI in the shared sandbox, `sandbox_shared`) and, once
  the owner supplies a topic, `ALERT_WEBHOOK_URL` (none is set yet). It
  refuses `MIGRATION_DATABASE_URL`, `SIGNING_KEYS` and `JWT_SECRET`; the
  schema-owner credential lives only in the GitHub environment `staging`. `web` reaches its `/healthz` at
  `http://worker.railway.internal:3002` (`WORKER_URL`) for `/api/ops/status`.
- Health: `/api/health` (schema ready, not draining); public status:
  `/api/ops/status`; client-address probe: `/api/ops/diagnostics/ip`, which the
  CD smoke uses to prove Railway's edge is a trusted peer, the client address
  is the edge's `X-Real-IP` (`source: "x-real-ip"`, which every per-IP limit
  relies on; the `X-Forwarded-For` hop is the edge's own address, LD-46) and
  spoofed headers are not honoured ([RUNBOOK](RUNBOOK.md) "Client address").

Historical (written before the cutover, closed by it): until the cutover, the
existing one-service setup described in the checkpoints above remained what was
deployed. Do not redeploy it from this tree before the
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
(`scripts/ops/rotate-db-login.ts`, dual role, zero downtime); step numbers are those of
[RUNBOOK.md](RUNBOOK.md) "Staging cutover" (11 to 13).

The September 30 working session exposed the `gm_staging_app` and
`gm_staging_billing` passwords (September 30 checkpoint above); the rotations below
replaced both logins and finalized them, so those passwords no longer work on the
staging branch. The older Neon branch `pre-021-staging-backup-2026-09-30`, which held
the pre-rotation passwords in its copy of the roles, was deleted on 2026-10-08 with the
owner's approval (LD-65); no branch carries them any more. Dates are UTC.

| Date | Role | Action | Operator |
| --- | --- | --- | --- |
| 2026-09-30 | `neondb_owner` (before the cutover) | Password rotated after migration 021; the staging `MIGRATION_DATABASE_URL` of that time updated | lead |
| 2026-10-07, about 04:05 | `gm_staging_app` → `gm_staging_app_r20261007` | Runtime rotation (`rotate-db-login.ts --kind runtime`, dual role): new login set as `DATABASE_URL` and `PG_APP_USER` on `web` and as the GitHub `staging` variable `PG_APP_USER`, `web` redeployed; `--finalize` dropped the old login after the lead cleared a legacy schema grant whose grantor was `pg_database_owner` (LD-47; `--finalize` now handles that case itself, RUNBOOK "Credential rotation" step 3); cutover step 11 | lead |
| 2026-10-07 | `gm_staging_billing` → `gm_staging_billing_r20261007` | Billing rotation (`--kind billing`): new login set as `BILLING_DATABASE_URL` on `web` and `worker`, finalized (old login dropped); cutover step 12 | lead |
| 2026-10-07 | `neondb_owner` | New password set by SQL (`ALTER ROLE … WITH PASSWORD`, which Neon supports); the old one is refused; the value is held by the operator outside the repository, and the owner may reset it from the Neon console; cutover step 13 | lead |

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

## Wave 2.0 cutover record

The staging cutover ran once, from the integrated code that contains Wave 2.0,
with the deltas in [RUNBOOK.md](RUNBOOK.md) "Staging cutover" (Wave 2.0 deltas):
steps 1–8 by the operator with the owner's consent, paused before step 6 on
October 6 and resumed with the owner's approval on October 7 at about 02:15 UTC.
Recorded without values; dates are UTC.

| Step | Date | What was done | Evidence / note |
| --- | --- | --- | --- |
| 1 | 2026-10-06 | Neon restore branch `pre-cutover-staging-2026-10-06` (`br-super-hat-aeeeffgs`) | Deleted on 2026-10-07 with the owner's approval (LD-53) |
| 2 | 2026-10-06 | `provision-roles.ts --env staging` (dry run, then real) as `neondb_owner`: `globals.sql` capability roles (`gm_jobs_worker`, `gm_support` and the others), `gm_migrator` login with the tables' ownership, `gm_staging_worker` (jobs login), `gm_staging_backup` | Logins written to a private 0600 file |
| 3 | 2026-10-06 | Railway service `green-monkey` renamed `web` | Same id and domain |
| — | 2026-10-06 | Staging project token minted for CD (`github-cd-staging`) | Verified scoped to the project's `staging` environment |
| 4 | 2026-10-06 | Variable inventory, names only. Retired from `web`: `MIGRATION_DATABASE_URL`, `RAILWAY_GIT_COMMIT_SHA` and five Stripe names (their values first copied privately for the worker, never printed). Leftovers: `ENABLE_BACKGROUND_EMAIL`, `ENABLE_BACKGROUND_SMS` | — |
| 5 | 2026-10-06 | `railway config plan` (CLI 5.63.4, IaC 3.13.0, Node 24.21.0) | 1 addition (`worker`), 9 changes on `web` (literals, health check, start command), 9 deletions: exactly the 7 retired and 2 leftover names |
| 6 | 2026-10-07 | `railway config apply --yes --confirm-destructive` for that plan | A second plan: already up to date; `worker` created |
| 7 | 2026-10-07 | `railway-vars.sh staging` (`--skip-deploys`): `web` `SIGNING_KEYS`; `worker` `WORKER_DATABASE_URL`, `BILLING_DATABASE_URL`, `BILLING_SANDBOX_ENABLED`, the five Stripe sandbox values, `FACTURAPI_TEST_KEY` (CFDI `sandbox_shared`) and `APP_URL` | 11 variables |
| — | 2026-10-07 | Release PR #5 merged to `main` (merge commit `3823858`) on green CI run 37560761336 | Brought migrations 022–034 |
| 8 | 2026-10-07 | `github-protect.sh` (no 403): `main` ruleset 24624180 (pull request, squash or rebase, linear history, `qualify` and `security` required and strict, 0 approvals); `staging` and `production` deploy only from `main`. `staging` secrets `RAILWAY_TOKEN`, `MIGRATION_DATABASE_URL`, `BACKUP_DATABASE_URL`; variables `APP_URL`, `PG_APP_USER`, `ALERT_WEBHOOK_KIND`; repository variables `RAILWAY_CLI_VERSION`, `RAILWAY_IAC_VERSION` | — |
| — | 2026-10-07 | DB-9 check ([RUNBOOK.md](RUNBOOK.md) "DB-9 validation") as `neondb_owner` before the first deploy of 032/033 | 0 rows (staging then at migration 021: 6 orders, 6 rounds, 6 jobs) |
| 9 | 2026-10-07 | CD deploys from `main` | "First deploys" below |
| 10 | — | Railway deploy webhook → ntfy; manual settings | **Pending**: no alert topic yet (LAUNCH_HANDOFF 1.7) |
| 11–13 | 2026-10-07 | Rotations | "Credential rotation log" above |
| 14 | 2026-10-08 | R2 bucket `gm-backups-staging`, Object Read & Write token (staging environment secrets) and the owner's age recipient (LD-66); first manual backup (run 37800599099, `gm-staging-20261008T152550Z.dump.age`, 1.05 MB); first Retention dispatch (run 37800918722); restore drill on Neon (PITR branch + logical restore into a fresh project, all four verification checks passed, RTO 117 s, dump age 6 min: [evidence](evidence/restore/2026-10-08-staging.json)); rehearsal resources deleted; `OPS_LIVE_ENVIRONMENTS=staging` (LD-67) | Done |
| 15 | — | Load test `target` and `stress`, pool decision | **Pending** ([LOAD_TEST.md](LOAD_TEST.md)) |

Wave 2.0 items:

| Item | Date | Evidence |
| --- | --- | --- |
| `globals.sql` run on the staging cluster (`gm_jobs_worker`, `gm_support`) | 2026-10-06 | Cutover step 2 |
| `gm_staging_worker` created by `provision-roles.ts`; `WORKER_DATABASE_URL` set on `worker` | 2026-10-06; 2026-10-07 | Steps 2 and 7 |
| GitHub environment `staging`: secret `MIGRATION_DATABASE_URL`, variables `PG_APP_USER`, `ALERT_WEBHOOK_KIND` | 2026-10-07 | Step 8 |
| `SIGNING_KEYS` set on `web` | 2026-10-07 | Step 7 |
| First deploy migrated from GitHub Actions; first `worker_ready` line with `jobs:true` | 2026-10-07 | Deploy run 37567966909: migrations 022–034 applied as `gm_migrator`; worker reported `jobs:true` |
| `v2.` prefix on a freshly issued `gm_session` cookie | — | Not recorded |
| First green Actions → Retention → staging dispatch | — | Pending with step 14 (every deploy already runs one retention pass) |

### First deploys

| Deploy run | Commit | Started (UTC) | Result |
| --- | --- | --- | --- |
| 37567966909 | `3823858` (PR #5, public ordering) | 2026-10-07 03:42 | Migrations 022–034 applied from GitHub Actions; config in sync; `worker` and `web` on the commit; `/api/health` and `/api/ops/status` ok; worker `jobs:true`. The smoke **failed** its `client_ip` check: the address was Railway's edge hop, not the client (LD-46) |
| 37603422529 | `90c5e8a` (PR #6, client address behind Railway's edge) | 2026-10-07 09:51 | **First fully green deploy**: every smoke check, `client_ip` included (`peerTrusted`, `source: "x-real-ip"`, the same answer with spoofed headers, a public address) |
| 37636967247 | `3e62285` (PR #7, W3-1 polish and W3-2 flake fixes) | 2026-10-07 14:28 | Applied 035 (`035_kitchen_reopened.sql`); smoke green. Its CI was re-run after a 16-minute package-install stall cancelled the first run (LD-54) |

Before the fix in PR #6, the header shape was verified on staging on 2026-10-07 with a
temporary header-echo service (created, probed, deleted): Railway's edge discards
client-supplied `X-Forwarded-For` and `X-Real-IP` and sends the client's address in
`X-Real-IP` ([RUNBOOK.md](RUNBOOK.md) "Client address"). Migration 036 and the
restaurant-day workflow reach staging with the release pull request.
