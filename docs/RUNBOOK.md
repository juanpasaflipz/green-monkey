# Production runbook

Operating Green Monkey in staging and production. Companion documents:
[RELEASE.md](RELEASE.md) (how changes ship), [PROVISIONING.md](PROVISIONING.md)
(creating an environment), [BACKUP_RESTORE.md](BACKUP_RESTORE.md) (backups,
restores, RPO/RTO), [LOAD_TEST.md](LOAD_TEST.md) (capacity) and
[INFRASTRUCTURE.md](INFRASTRUCTURE.md) (services, roles, variables).

Status: written and locally rehearsed (scripts run with `--dry-run`, DB
suites against local PostgreSQL). Nothing here has been executed against
Railway, Neon, GitHub settings, R2 or ntfy yet.

## Contacts and escalation

The owner fills these in; they are deliberately not invented.

| Role | Name | Channel | Hours |
| --- | --- | --- | --- |
| Platform owner (first responder) | _to fill_ | ntfy topic + phone | _to fill_ |
| Backup responder | _to fill_ | _to fill_ | _to fill_ |
| Railway support | — | Railway dashboard → Help | — |
| Neon support | — | Neon console → Support | — |

Escalate to the backup responder when the first responder has not
acknowledged a critical alert within 15 minutes during service hours
(12:00–23:59 America/Mexico_City).

## Signals

| Signal | Where | Meaning |
| --- | --- | --- |
| `web_down` (critical) | ntfy, from the worker watchdog | `/api/health` failed 3 consecutive minutes |
| `web_recovered` (info) | ntfy | the probe passes again |
| `jobs_dead_<kind>` (warning) | ntfy, from the web jobs runner | a job exhausted 8 attempts; see `GET /api/jobs` as a manager |
| `billing_review` / `billing_retrying` (warning) | ntfy, from the worker | billing operations need a person / keep failing |
| `retention_failed` (warning) | ntfy, from the worker's off-hours retention or the deploy's preDeploy pass | deleting expired OAuth attempts or old done/dead jobs failed (`tables=` names which); lock-timeout skips do not alert. Check `@message:retention_table_failed` in the worker logs: `reason:"statement_timeout"` means a batch hit its 1.5 s bound (see "Retention" below), anything else is an error; the next run retries |
| Uptime workflow failure | ntfy + GitHub issue `ops-alert: production` | `/api/ops/status` not ok or degraded, or the last successful production backup run is older than 26 h |
| Backup workflow failure | ntfy + GitHub issue `ops-alert: <env>` | the nightly dump failed |
| Railway deploy failed/crashed | ntfy (Railway webhook, manual setup below) | a deploy or a running instance failed |

Alerts carry codes and counts only, never personal or tenant data. Logs are
single-line JSON in Railway: filter with `@level:error`, `@message:http_request`,
`@requestId:<id>` (the "Referencia de soporte" a cashier reads out is the first
8 characters of a request id), `@route:/api/orders/:id`.

## "The POS is down" playbook

1. **Status.** `curl -s https://<app>/api/ops/status`. `db:"down"` → step 3;
   `schema:"not_ready"` → a deploy is mid-migration or failed, step 4;
   `worker.status:"stale"` alone does not stop selling (billing and alerts pause).
2. **Railway.** Dashboard → `web` → Deployments. Crashed or failed health →
   open the deploy logs (`@level:error`). `database_waiting` lines mean the
   process is up and waiting for Neon (it retries with backoff; it does not
   crash-loop).
3. **Neon.** Console → project → Monitoring and Operations. Compute suspended
   or starting → it resumes on connect; an incident on Neon's status page →
   wait, the app recovers on its own (requests get 503, the offline queue on
   terminals keeps cash sales). Connection limit (`53300`) → reduce
   `DB_POOL_MAX` or raise the compute size.
4. **Bad release.** Roll back (below). Expand-only migrations mean the
   previous revision runs against the new schema.
5. Record the incident (template below) within 24 hours.

## Rollback

Redeploy an older SHA: Actions → Deploy → Run workflow with that SHA, the typed
phrase `deploy <sha7> to production` and, during service hours,
`allow_service_hours`. The SHA must be on `main` and must once have been live on
staging (the `deploy/staging` commit status). Production release tags
(`prod-YYYYMMDD-HHMM-<sha7>`) list every SHA that was live.

A rollback deploys the older **code** and keeps the live Railway **service
configuration**. With the default `railway_config: auto`, the workflow
applies `.railway/railway.ts` only when the SHA is the head of `main`; for any
older SHA it skips `railway config apply` and says so in the run summary. The
reason: an older file omits variables added since, Railway plans an omitted
variable as a deletion, and `config apply --yes` refuses destructive plans,
so syncing would fail the rollback (or, forced, delete the variables). Use
`railway_config: apply` only when the older configuration itself is wanted
and its plan has been reviewed; to undo a configuration change, revert it in
`.railway/railway.ts` on `main` and deploy forward instead. A forward deploy
of a SHA that is no longer the head of `main` (main moved on after staging)
also skips the sync under `auto`: if that SHA adds variables, review
`railway config plan` locally and dispatch with `railway_config: apply`.
`skip` never syncs, even for the head. (Every SHA that can be live in
production carries this behaviour: it predates the first production deploy.)

One-way points (a rollback past them needs extra steps):

| Point | Rolling back past it |
| --- | --- |
| A migration that a later revision depends on | Not a blocker: older revisions keep working on the newer schema (expand-only). Never revert a migration by hand. |
| This ops release (worker service, preDeploy migrations) | **Not supported without manual steps (staging only; production has no pre-ops revision).** A rollback keeps the live service configuration (above), which starts `web` with `node --import ./build/server/instrument.js build/server/index.js` and the worker with `build/server/worker.js` and runs the worker preDeploy `migrate.js --grants --retention`; none of these exist in pre-ops builds, so both services would crash-loop. To go back that far, first restore the old start command on `web` and remove the worker's preDeploy and start command (or delete the worker service) in the dashboard, or dispatch with `railway_config: apply` after reviewing `config plan` for that older SHA; the previous revision expects migrations from Railway's old preDeploy on `web`. Prefer deploying a fix forward. |
| `BILLING_SANDBOX_ENABLED=true` with a pre-ops revision | Older revisions run the Stripe provider loop in `web` and need `STRIPE_SECRET_KEY` there; set `BILLING_SANDBOX_ENABLED=false` while rolled back. |

## Restart

Railway → service → Deployments → latest → Restart. Graceful: `web` drains for
up to `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (20 s; the process exits by 18 s),
`worker` for 30 s. In-flight money commands are idempotent (operation ids), so
a client retry after a restart never doubles a payment.

## Manual Railway settings (not expressible in IaC)

Check after creating an environment and after every IaC change:

- Restart policy: On Failure (default, 10 retries).
- Region: same as the Neon project (`us-east4` with Neon `aws-us-east-1`).
- Custom domain on `web` only (Cloudflare DNS-only CNAME); none on `worker`.
- Serverless sleep: off on both services.
- Deploy webhook: Project → Settings → Webhooks → the ntfy topic URL, events
  deploy failed/crashed.

## Scaling caveat

`replicas: 1` is pinned in `.railway/railway.ts`: rate limits (login, owner,
public ordering, billing, ops endpoints) use in-memory stores, and two replicas
would double every limit and split buckets. Before scaling out, move the
limiter store to Postgres or Redis. Size the database pool from
[LOAD_TEST.md](LOAD_TEST.md) first.

## Retention

Retention deletes only expired OAuth login attempts and done/dead jobs older
than 30 days (`server/ops/retention.ts`; every other table, blocked receipt
jobs included, is kept). It runs as `gm_migrator` once per deploy (the
worker's preDeploy) and from the worker every 15 minutes **only between
04:00 and 10:00 America/Mexico_City**, after the 03:30 backup and outside
service hours; `lastRetentionAt` in the worker's `/healthz` shows the last
pass. Each batch briefly turns off FORCE row-level security, which takes an
ACCESS EXCLUSIVE lock on the table until it commits, and every order and
payment inserts into `jobs`. So each batch waits at most 200 ms for that
lock (a lock-timeout skip is logged, not alerted) and runs each statement
at most 1.5 s; a deploy during service can therefore stall order and
payment inserts by at most about 1.7 s per batch, and the off-hours passes
not at all. When `retention_failed` reports `reason:"statement_timeout"`,
the jobs scan has outgrown that bound (no index serves the predicate):
nothing was deleted and sales were not affected, but the table now keeps
growing until the follow-up below ships. Do not raise the bounds in
service hours.

## Deploy window

Production deploys are refused between 12:00 and 23:59 America/Mexico_City
(UTC−6 year-round) unless `allow_service_hours` is ticked for an urgent fix.
Prefer 06:00–11:00.

## Credential rotation

Database logins (`scripts/ops/rotate-db-login.ts`, owner credential from the
offline vault, direct endpoint):

1. `PROVISION_DATABASE_URL=… npx tsx scripts/ops/rotate-db-login.ts --env <env> --kind runtime`
   creates `gm_<env>_app_r<date>` with the same memberships and timeouts,
   applies the runtime grants manifest (`scripts/grants.sql`) to it **in the
   same transaction**, and rolls everything back unless the new login holds
   every table and column privilege of the old one. It writes the URL to a
   0600 file. The new login can serve traffic before any deploy, so the
   order in which services restart does not matter (Railway does not order
   `web` and `worker`, and a dashboard redeploy of `web` skips the worker).
   A rollback message naming missing privileges means the old login carries
   a manual grant the manifest lacks: add it to `scripts/grants.sql` through
   a PR or revoke it, then retry.
2. Set `DATABASE_URL` and `PG_APP_USER` on `web` and `PG_APP_USER` on `worker`
   (`scripts/ops/railway-vars.sh`), redeploy both. Do not merge a migration
   between this step and step 3: the preDeploy grants only the new login.
3. When the old login has no sessions:
   `… rotate-db-login.ts --env <env> --finalize --old gm_<env>_app`.
   It drops what the old login owns, revokes the database `CONNECT` and
   schema `USAGE` that deploys granted it as `gm_migrator` (acting as that
   role, since only the grantor can revoke them), and drops the login, in
   one transaction. A refusal naming a grantor the owner cannot `SET ROLE`
   to changed nothing: revoke that grant as its grantor, then retry.
4. Same for `--kind billing` (both services) and `--kind backup` (GitHub
   environment secret). `--kind migrator` sets a new `gm_migrator` password;
   update `MIGRATION_DATABASE_URL` on `worker`.
5. Record it in [STAGING.md](STAGING.md) "Credential rotation log" (no secrets).

Other secrets:

- `JWT_SECRET` signs sessions, device pairings, ordering links and
  invitations; rotating it today unpairs every terminal. The keyring that makes
  this routine (OPS-10) is a follow-up; until then rotate only on compromise,
  outside service hours, and plan to re-pair devices.
- Stripe webhook secret: roll in the Stripe dashboard (it keeps the old secret
  valid for a window), set `STRIPE_WEBHOOK_SECRET` on `web`, deploy.
- Google OAuth client secret: add a new secret in Google Cloud, set
  `GOOGLE_CLIENT_SECRET`, deploy, then disable the old secret.
- R2 token, Railway project token, ntfy topic: create the new one, update the
  GitHub environment secret/variable, delete the old one.

## Staging cutover

Ordered steps to move staging onto this setup (operator, with the owner's
consent; record each in [STAGING.md](STAGING.md)). Pin the CLI with
`RAILWAY_CLI_VERSION` (`npx @railway/cli@$RAILWAY_CLI_VERSION`, written
`railway` below) and use `--environment staging` on every command.

1. Neon: take a branch snapshot of the staging database (restore point).
2. `PROVISION_DATABASE_URL=<neondb_owner direct> npx tsx scripts/ops/provision-roles.ts --env staging --dry-run`,
   review, then run it for real: capability roles, `gm_migrator` login,
   role defaults, ownership transfer to `gm_migrator`. It runs as
   `neondb_owner`, which is not a superuser.
3. Rename the existing Railway service to `web` if needed (keeps its id and
   domain).
4. **Inventory the live variables, names only** (never print values):
   `railway variable list --service web --json | jq -r 'keys[]' | sort`.
   Railway IaC plans every variable that `.railway/railway.ts` does not
   declare for a service as a **deletion**, so classify every name that is
   neither declared there (the service's `env` or `common`) nor a
   Railway-provided `RAILWAY_*` name:
   - **Retired from `web`, deleted by this cutover:** `MIGRATION_DATABASE_URL`,
     `RAILWAY_GIT_COMMIT_SHA`, `STRIPE_SECRET_KEY`, `STRIPE_EXPECTED_ACCOUNT_ID`,
     `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_ANNUAL`,
     `STRIPE_PORTAL_CONFIG_ID` (the web refuses the secret key when deployed).
     First copy the values the worker needs into the private file for step 7,
     under its `# service: worker` header, without printing them (for example
     `railway variable list --service web --kv | grep -E '^(STRIPE_SECRET_KEY|STRIPE_EXPECTED_ACCOUNT_ID|STRIPE_PRICE_PRO_MONTHLY|STRIPE_PRICE_PRO_ANNUAL|STRIPE_PORTAL_CONFIG_ID)=' >> <private file>`);
     they cannot be read back after the apply.
   - **Still needed:** a variable another area reads on staging (for example
     access's `DEMO_TENANT_ID`, `ACCESS_STEP_UP_SECONDS` and
     `ACCESS_IDLE_LOCK_DEFAULT_SECONDS`, if set there) or a deliberate
     override such as `TRUST_PROXY`. Add `NAME: preserve()` to that service in
     `.railway/railway.ts` and merge it before step 5 (until step 8 adds the
     `RAILWAY_TOKEN` environment secret, the deploy run that merge triggers
     fails before it touches Railway).
   - **Leftovers nothing reads** (for example `RESTAURANT_TZ`, which the
     server ignores): write them down; they are deleted in step 6.
5. `railway config plan`. Proceed only if it creates `worker`, changes `web`'s
   start command, health check and declared variables, removes no domain,
   and its deletions are **exactly** the retired and leftover names written
   down in step 4. Any other deletion: stop, add `preserve()` for it (step 4)
   and plan again.
6. `railway config apply --yes --confirm-destructive`, by the operator, once,
   for that reviewed plan. A second `railway config plan` must then show no
   changes. CD applies with `--yes` only (never `--confirm-destructive`), so
   from here on any undeclared variable stops the automatic staging deploy at
   the sync step until it is declared or deleted on purpose.
7. Set variables with `scripts/ops/railway-vars.sh staging <private file>`:
   `web` (`APP_ENV=staging`, `WORKER_URL`), `worker` (`MIGRATION_DATABASE_URL`
   as `gm_migrator`, `PG_APP_USER`, `BILLING_DATABASE_URL`, Stripe sandbox
   keys, `ALERT_WEBHOOK_URL`).
8. GitHub: `scripts/ops/github-protect.sh` (after the first PR has run the
   checks), environment secrets and variables.
9. Merge to `main`; CD deploys; the smoke must pass, including the client IP
   check.
10. Railway deploy webhook → ntfy; check the manual settings above.
11. Rotate `gm_staging_app` (dual role), deploy, finalize.
12. Rotate the billing login (replaces the exposed `gm_staging_billing`).
13. Rotate the `neondb_owner` password; keep it offline.
14. First staging backup (Actions → Backup → staging, by hand), then the
    restore rehearsal ([BACKUP_RESTORE.md](BACKUP_RESTORE.md)); then turn on
    the weekly schedule with `gh variable set OPS_LIVE_ENVIRONMENTS --body staging`
    ([PROVISIONING.md](PROVISIONING.md) §7).
15. Load test `target` and `stress`; record the pool decision
    ([LOAD_TEST.md](LOAD_TEST.md)).

**For every area (integration note):** a Railway variable that a service
must keep has to be declared in `.railway/railway.ts` (a literal, or
`preserve()` for a value set out of band), in the same change that starts
reading it. An undeclared variable is planned as a deletion, and CD's
non-destructive `config apply --yes` then stops every automatic staging
deploy at the sync step.

## Open follow-ups

Known gaps this release leaves open, with their owner:

| Item | Today | Follow-up |
| --- | --- | --- |
| DB-1, billing credential in `web` | While billing is enabled, `web` holds `BILLING_DATABASE_URL` for owner billing commands and the webhook. That login is a member of `gm_billing_worker`, whose policies read restaurants, organizations, entitlements and billing tables across tenants. Production launches with `BILLING_SANDBOX_ENABLED=false`, and production `web` refuses to start with `BILLING_DATABASE_URL` set while billing is disabled (`server/config-rules.ts`), so the internet-facing process never holds it there. | Account area (migration 031): a `billing_requests` inbox written with the runtime role and drained by the worker, after which only `worker` holds the billing login. |
| DB-6, grants hash in readiness | Grants are applied in the newest migration's transaction, so a new revision cannot pass `/api/health` before its tables are granted; readiness itself checks only `schema_migrations` (`server/readiness.ts` is frozen this wave). | Ops, next wave: a `schema_grants` registry and a readiness check of the manifest hash. |
| OPS-R10, retention needs DDL | Each retention batch turns off FORCE row-level security (ACCESS EXCLUSIVE until commit) and scans `jobs` without an index, because only the owner may delete and FORCE applies to it. The worker therefore runs it only 04:00–10:00 Mexico City, with a 200 ms lock wait and a 1.5 s statement bound per batch; at a few million `jobs` rows (blocked receipt jobs are never deleted) the scan exceeds the bound and `retention_failed` reports `statement_timeout` every night. | Ops, next wave (a new migration; 022 is limited to the hot-path indexes): a partial index `jobs(created_at) WHERE state IN ('done','dead')` so each batch finds its rows in milliseconds, and a `gm_maintenance` login with DELETE on the two tables under policies limited to the retention predicates, so retention needs no DDL and no ACCESS EXCLUSIVE lock and can run at any hour. |
| OPS-10, signing keyring; F2 in-transaction authentication | Tokens are still signed with `JWT_SECRET`; deferred while the access area rewrites `server/auth.ts`. | Ops, after the access merge. |

## Incident log template

```
Date/time (America/Mexico_City):
Detected by: (alert / restaurant call / uptime issue)
Impact: (restaurants affected, what staff could not do, duration)
Timeline: (detection, acknowledgement, mitigation, resolution)
Root cause:
Data impact: (none / reconciled how)
Follow-ups: (owner, due date)
```
