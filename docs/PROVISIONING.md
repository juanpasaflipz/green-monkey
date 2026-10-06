# Production provisioning checklist

Creating a new environment (production, or a fresh staging) end to end. The
launch itself is the owner's decision; this list prepares everything so that
it is a deliberate, reviewed step. Every script prints names and actions only,
writes credentials to 0600 files that it never overwrites, and supports
`--dry-run`. None of them runs from CI.

Status: scripted and dry-run tested locally; `provision-roles.ts` and
`rotate-db-login.ts` are exercised against throwaway local databases by
`tests/provision-db.ts`. Nothing has been run against Neon, Railway, GitHub,
Cloudflare or Google yet.

## 0. Decisions (defaults chosen so work is not blocked)

| Decision | Default |
| --- | --- |
| Neon plan and history window | Launch, 7 days (`NEON_PLAN=scale` for 30 days) |
| Region | Neon `aws-us-east-1`, Railway `us-east4` (both N. Virginia), or match staging |
| Alert channel | ntfy.sh topic with a long random name, phone app subscribed |
| Error tracking | Off until `SENTRY_DSN` is set and `@sentry/node` is installed |
| Off-platform backups | Cloudflare R2 with `age` encryption, key kept offline |
| Production domain | `<domain>` placeholder (for example `app.<your-domain>`) |
| GitHub plan | Rulesets on a private repository need a paid plan; `github-protect.sh` reports 403 otherwise |

## 1. Neon project

```sh
NEONCTL_VERSION=<x.y.z> NEON_API_KEY=… NEON_ORG_ID=… scripts/ops/provision-neon.sh production --dry-run
NEONCTL_VERSION=<x.y.z> NEON_API_KEY=… NEON_ORG_ID=… scripts/ops/provision-neon.sh production
```

`NEONCTL_VERSION` is required and must be an exact version
(`MAJOR.MINOR.PATCH`): the Neon CLI runs with the API key and writes the owner
connection string, so it is pinned like the Railway CLI and never resolves
`latest`. Pick a release from the neonctl changelog, review it, and use the
same value for `scripts/ops/rehearse-neon-restore.ts`.

Creates `green-monkey-production` and database `green_monkey_production`, sets
the history window, daily and weekly snapshots kept 35 days, protects the
default branch, and writes the owner connection to
`.env.neon-owner-production` (`PROVISION_DATABASE_URL`).

## 2. Roles

```sh
node --env-file=.env.neon-owner-production --import tsx scripts/ops/provision-roles.ts --env production --dry-run
node --env-file=.env.neon-owner-production --import tsx scripts/ops/provision-roles.ts --env production
```

It first runs `scripts/ops/sql/globals.sql`, which creates the capability
roles `gm_billing_worker`, `gm_backup_reader`, `gm_jobs_worker` and
`gm_support` (NOLOGIN) and `gm_migrator`. **`globals.sql` must have run on
every cluster before its first deploy that contains Wave 2.0:** the
`-- 2.0 jobs worker` block of `scripts/grants.sql` refuses to apply without
`gm_jobs_worker` and `gm_support`, and the deploy then stops before Railway.
Migrations never create these roles.

Creates `gm_migrator` (schema owner, no superuser/BYPASSRLS/CREATEROLE),
`gm_production_app`, `gm_production_billing` (member of `gm_billing_worker`),
`gm_production_worker` (member of `gm_jobs_worker` only; 30 s statement, 8 s
lock and 60 s idle timeouts; `CONNECT`) and `gm_production_backup` (member of
`gm_backup_reader`), with role-level timeouts that Neon's pooler honours,
revokes `CONNECT` from `PUBLIC`, and writes `.env.provisioned-production` with
`MIGRATION_DATABASE_URL` (direct), `DATABASE_URL`, `WORKER_DATABASE_URL` and
`BILLING_DATABASE_URL` (pooled), `BACKUP_DATABASE_URL` (direct) and
`PG_APP_USER`. On a re-run it appends any key missing from an existing file
and never rewrites one; a login that already existed without a saved password
is listed as "rotate it" (`rotate-db-login.ts --kind <kind>`).
`MIGRATION_DATABASE_URL` goes to the GitHub environment secret (§7), never to
Railway. It asserts that no login is privileged and that
only `gm_migrator` owns tables. `neondb_owner` is not a superuser on Neon
(it has CREATEROLE, CREATEDB and BYPASSRLS through `neon_superuser`), so the
script changes only role attributes such an owner may change and grants it
INHERIT and SET on `gm_migrator` for the ownership transfer and later
rotations. Every deploy re-applies the runtime grants as `gm_migrator`, so
the runtime login also holds `CONNECT` and schema `USAGE` granted by
`gm_migrator`, which `DROP OWNED` run by the owner leaves behind;
finalizing a rotation revokes each remaining grant as its grantor (`SET
ROLE gm_migrator`) before `DROP ROLE`, and names any grantor it cannot act
as instead of dropping anything. `tests/provision-db.ts` applies the grants
as `gm_migrator`, the way the deploy does, before each runtime rotation it
finalizes: once with a superuser owner, and twice in a row with a
Neon-like owner ("Neon parity"), which also provisions the database. Then
rotate the
`neondb_owner` password in the Neon console and keep it offline.

## 3. Railway

1. Create the `production` environment in project `proactive-upliftment`.
2. Create a project token scoped to it (for GitHub) and pin the CLI version.
3. `npx @railway/cli@<ver> config plan` (with `npm install --no-save railway@<ver>`
   for the IaC package) must show only additions; then `config apply`.
4. Variables from a private file (never on the command line):
   `scripts/ops/railway-vars.sh production <file>` with `# service: web` /
   `# service: worker` sections — web: `APP_URL`, `DATABASE_URL`,
   `PG_APP_USER`, `JWT_SECRET` (64+ random characters), `SIGNING_KEYS`
   (required in production: `node scripts/ops/generate-signing-key.mjs`;
   [RUNBOOK.md](RUNBOOK.md) "Signing keys"), Google OAuth,
   `STRIPE_WEBHOOK_SECRET` and `BILLING_DATABASE_URL` only if billing is
   enabled; worker: `WORKER_DATABASE_URL`, `APP_URL`, `ALERT_WEBHOOK_URL`,
   Stripe keys only if billing is enabled, and from cfdi (030) the Facturapi
   keys and `CREDENTIAL_ENCRYPTION_KEY`. The worker **never** gets
   `MIGRATION_DATABASE_URL`, `SIGNING_KEYS` or `JWT_SECRET`, and the web never
   gets `WORKER_DATABASE_URL`, the Facturapi keys, `CREDENTIAL_ENCRYPTION_KEY`
   or `CFDI_LIVE_ENABLED`: each deployed process refuses to start with the
   other's credentials (`forbidden_credential_in_process`).
   Production leaves `BILLING_SANDBOX_ENABLED` unset (billing disabled)
   unless live-mode billing has been qualified (account area); production
   `web` refuses to start with `BILLING_DATABASE_URL` set while billing is
   disabled (DB-1 follow-up, [RUNBOOK.md](RUNBOOK.md) "Open follow-ups").
5. Manual settings from [RUNBOOK.md](RUNBOOK.md): restart policy, region,
   serverless sleep off, deploy webhook to ntfy.

## 4. Domain and TLS

Add `<domain>` to the `web` service in Railway, then a DNS-only CNAME in
Cloudflare to the Railway target. Set `APP_URL=https://<domain>` (deployed
processes refuse a non-https `APP_URL`).

## 5. Google OAuth production client

Google Cloud console → APIs & Services → Credentials → OAuth client (Web):
authorized redirect `https://<domain>/api/auth/google/callback`. Set
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` on `web`.
Publish the consent screen before inviting real owners.

## 6. Backups

```sh
scripts/ops/provision-r2.sh production --lock --dry-run
scripts/ops/provision-r2.sh production --lock
age-keygen -o <offline path>/green-monkey-backup.key
```

Commit the public `age1…` line to `ops/backup/age-recipients.txt`. Create an
R2 token scoped to `gm-backups-production` (Object Read & Write).

## 7. GitHub

```sh
scripts/ops/github-protect.sh --dry-run
scripts/ops/github-protect.sh
```

The script limits both environments to deployments from the branch `main`
(a custom deployment branch policy, read back; it fails otherwise). If the
GitHub plan offers no environment branch policies on a private repository
(a 403 here), **do not set `MIGRATION_DATABASE_URL` as an environment
secret**: any branch could then dispatch a workflow that reads it. Upgrade the
plan or make the repository public first.

Then the environment secrets and variables it prints (`RAILWAY_TOKEN`,
`MIGRATION_DATABASE_URL`, `BACKUP_DATABASE_URL`, `R2_*`, `ALERT_WEBHOOK_URL`,
`APP_URL`, `PG_APP_USER`, `ALERT_WEBHOOK_KIND`) and the repository variables
`RAILWAY_CLI_VERSION` and `RAILWAY_IAC_VERSION`. The deploy job and the
retention workflow need, per environment:

- secret `MIGRATION_DATABASE_URL` (`gm_migrator`, direct endpoint), from
  `.env.provisioned-<env>` on stdin:
  `grep '^MIGRATION_DATABASE_URL=' .env.provisioned-production | cut -d= -f2- | gh secret set MIGRATION_DATABASE_URL --env production`
  (never on the command line). It is the only copy of the schema-owner
  credential outside the offline vault; no Railway service holds it;
- variable `PG_APP_USER` (`gm_production_app`), the login the grants target;
- variable `ALERT_WEBHOOK_KIND` (`ntfy`). The
script also creates the `ops-alert` label the alert steps file issues with
(they create it too if it is missing).

Scheduled backups and the hourly uptime check stay off until the repository
variable `OPS_LIVE_ENVIRONMENTS` lists the environment, so an unprovisioned
environment does not fail every hour. For each environment, after its
secrets are set: run Actions → Backup → Run workflow for it once by hand,
then add it (`gh variable set OPS_LIVE_ENVIRONMENTS --body "staging"`, later
`"staging production"`). Listing an environment also turns on its daily
retention workflow (production 05:15, staging 05:45 Mexico City); dispatch
Actions → Retention for it once by hand first. Listing `production` also
turns on the uptime check, whose backup-freshness step counts only runs named
`Backup production`. It is a repository variable because a job-level
condition cannot see environment-level variables.

## 8. Monitoring

- Subscribe the phone to the ntfy topic; send a test alert.
- Optional: a free external keyword monitor on `https://<domain>/api/ops/status`
  matching `"degraded":false` (5-minute interval) in addition to the hourly
  uptime workflow.

## 9. Legal entity values (lead decision LD-3)

The platform privacy notice and terms read the legal entity name, address and
support contact from configuration. The owner supplies the production values at
launch; CI and staging use clearly fictional values flagged as such. The
production readiness check that refuses placeholder legal values belongs to the
account area (wave 2); until it lands, confirm the values by hand on
`https://<domain>` before inviting restaurants.

## 10. First deploy and rehearsal

1. Dispatch Deploy for the SHA already live on staging, outside service hours.
   The deploy job creates the schema on the empty database (`migrate.js
   --grants --retention` as `gm_migrator`, from the environment secret)
   before it uploads either service.
2. The smoke must pass (live commit, health, worker ok on the same commit
   with its jobs runner on, client IP check, malformed JSON, session
   required).
3. Run the backup workflow manually for production, then the restore
   rehearsal from that backup ([BACKUP_RESTORE.md](BACKUP_RESTORE.md)).
4. Go-live checks (Wave 2.0; the worker and web now refuse to start without
   these, and the smoke checks the worker): `WORKER_DATABASE_URL` is set on `worker` and
   its log shows `worker_ready` with `jobs:true` (`/api/ops/status` reports
   the worker `ok`); `SIGNING_KEYS` is set on `web` and a fresh `gm_session`
   cookie starts with `v2.`; one Actions → Retention → production run is
   green.
5. Record evidence and dates in the completion ledger (M11 is the owner's
   launch decision).
