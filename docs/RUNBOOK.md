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
| `retention_failed` (warning) | ntfy, from the worker's 15-minute retention or the deploy's preDeploy pass | deleting expired OAuth attempts or old done/dead jobs failed (`tables=` names which); lock-timeout skips do not alert. Check `@message:retention_table_failed` in the worker logs; the next run retries |
| Uptime workflow failure | ntfy + GitHub issue `ops-alert: production` | `/api/ops/status` not ok or degraded, or the last backup is older than 26 h |
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

One-way points (a rollback past them needs extra steps):

| Point | Rolling back past it |
| --- | --- |
| A migration that a later revision depends on | Not a blocker: older revisions keep working on the newer schema (expand-only). Never revert a migration by hand. |
| This ops release (worker service, preDeploy migrations) | The previous revision expects migrations from Railway's old preDeploy on `web`; keep the worker service, it is harmless to older web revisions. |
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
consent; record each in [STAGING.md](STAGING.md)):

1. Neon: take a branch snapshot of the staging database (restore point).
2. `PROVISION_DATABASE_URL=<neondb_owner direct> npx tsx scripts/ops/provision-roles.ts --env staging --dry-run`,
   review, then run it for real: capability roles, `gm_migrator` login,
   role defaults, ownership transfer to `gm_migrator`.
3. Rename the existing Railway service to `web` if needed (keeps its id and
   domain). `npx @railway/cli@<ver> config plan` → no destructive changes and no
   domain removal → `config apply` creates `worker` and the variables.
4. Set variables with `scripts/ops/railway-vars.sh staging <private file>`:
   `web` (`APP_ENV=staging`, `WORKER_URL`), `worker` (`MIGRATION_DATABASE_URL`
   as `gm_migrator`, `PG_APP_USER`, `BILLING_DATABASE_URL`, Stripe sandbox
   keys, `ALERT_WEBHOOK_URL`).
5. Delete from `web`: `MIGRATION_DATABASE_URL`, `RAILWAY_GIT_COMMIT_SHA`,
   `STRIPE_SECRET_KEY`, `STRIPE_EXPECTED_ACCOUNT_ID`, `STRIPE_PRICE_PRO_*`,
   `STRIPE_PORTAL_CONFIG_ID` (the web refuses the secret key when deployed).
6. GitHub: `scripts/ops/github-protect.sh` (after the first PR has run the
   checks), environment secrets and variables.
7. Merge to `main`; CD deploys; the smoke must pass, including the client IP
   check.
8. Railway deploy webhook → ntfy; check the manual settings above.
9. Rotate `gm_staging_app` (dual role), deploy, finalize.
10. Rotate the billing login (replaces the exposed `gm_staging_billing`).
11. Rotate the `neondb_owner` password; keep it offline.
12. First staging backup, then the restore rehearsal
    ([BACKUP_RESTORE.md](BACKUP_RESTORE.md)).
13. Load test `target` and `stress`; record the pool decision
    ([LOAD_TEST.md](LOAD_TEST.md)).

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
