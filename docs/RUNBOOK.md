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
| `jobs_dead_<kind>` (warning) | ntfy, from the web jobs runner or the worker jobs runner (worker-only kinds) | a job exhausted its kind's `maxAttempts` (default 8), or its lease expired on its last allowed claim (`error_code` `lease_expired`: the process died mid-job, for example out of memory); see `GET /api/jobs` as a manager and "Jobs" below |
| `job_lease_expired` (log, warn) | web or worker logs | a handler ignored its abort signal past its lease; the runner stopped counting it and the job is reclaimed (or goes dead on its last attempt). Repeated lines for one kind mean a provider call without the signal |
| `db_retry` (log, warn) | web or worker logs | `tenant()` caught a deadlock (`40P01`) or serialization failure (`40001`); `retried:true` was retried once, `retried:false` became a 409 `concurrent_update`. Any steady rate is a lock-order bug ([ARCHITECTURE.md](ARCHITECTURE.md) "Global lock order", LO-R9): note the `requestId` and route and open an issue |
| `signing_keys_active` (log, info) | web startup | the kid that signs and every kid that verifies (never key material); after a key rotation it must show only the intended kids |
| `billing_review` / `billing_retrying` (warning) | ntfy, from the worker | billing operations need a person / keep failing |
| `retention_failed` (warning) | ntfy, from the deploy job or the daily Retention workflow | deleting expired OAuth attempts or old done/dead jobs failed (`tables=` names which); lock-timeout skips do not alert. Check `retention_table_failed` in that GitHub Actions run's log: `reason:"statement_timeout"` means a batch hit its 1.5 s bound (see "Retention" below), anything else is an error; the next run retries |
| Retention workflow failure | GitHub issue `ops-alert: <env>` | a table failed (it has also alerted `retention_failed`), the run was skipped on a lock timeout three times in a row, or `MIGRATION_DATABASE_URL` is missing |
| Uptime workflow failure | ntfy + GitHub issue `ops-alert: production` | `/api/ops/status` not ok or degraded (database, schema, worker not ok, or the worker's jobs runner off), or the last successful production backup run is older than 26 h |
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
(`prod-YYYYMMDD-HHMM-<sha7>`) list every SHA that was live; the newest one is
the live release, whose code the daily retention run uses.

**Never use the Railway dashboard's Rollback or Redeploy on an older
deployment.** Railway restores that deployment's Docker image **and its
custom variables** (Rollback), or rebuilds it with its original variables
(Redeploy). Every variable changed since comes back: after a `SIGNING_KEYS`
rotation the leaked key signs again and the new one is gone (everyone is
logged out a second time and forged links work again); after a credential
rotation the old password returns. The only rollback path is Actions →
Deploy with the older SHA, which uploads the older code and keeps the live
variables. (Restart of the *current* deployment is safe: same image, same
variables.)

A rollback through Actions → Deploy deploys the older **code** and keeps the
live Railway **service configuration**. With the default `railway_config: auto`, the workflow
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
| A release that added column grants (`GRANT UPDATE(<col>) …` in `scripts/grants.sql`) | The rollback's migrate step applies the **older** `scripts/grants.sql`, whose table-level `REVOKE`s also drop the newer column grants, before the older web is uploaded: until it is live (or for good, if its build fails) the newer web gets `42501` on those columns (PLATFORM-OPS-9). Prefer a forward fix; if a rollback is needed, re-dispatch the newer SHA's grants afterwards only by deploying forward again. |
| This ops release (worker service, migrations outside `web`) | **Not supported without manual steps (staging only; production has no pre-ops revision).** A rollback keeps the live service configuration (above), which starts `web` with `node --import ./build/server/instrument.js build/server/index.js` and the worker with `build/server/worker.js`; neither exists in pre-ops builds, so both services would crash-loop. To go back that far, first restore the old start command on `web` and remove the worker's preDeploy and start command (or delete the worker service) in the dashboard, or dispatch with `railway_config: apply` after reviewing `config plan` for that older SHA; the previous revision expects migrations from Railway's old preDeploy on `web`. Prefer deploying a fix forward. |
| Wave 2.0 (keyring, migrations in GitHub Actions) | **Staging only** (production is provisioned after 2.0, so it has no pre-2.0 revision). Under `railway_config: auto` the IaC sync is skipped for an older SHA, so the services keep 2.0's configuration: no worker `preDeploy`, no `MIGRATION_DATABASE_URL` on any service. `uses: ./.github/actions/deploy` resolves the action from the older checkout, which has no migrate step (GitHub warns about the unexpected `migration-database-url`, `pg-app-user`, `app-env` and alert inputs); nothing migrates, and the older schema needs nothing. The older worker finds no `MIGRATION_DATABASE_URL` and runs no retention schedule; the daily Retention workflow runs the live staging release's own code (the commit whose `deploy/staging` status is the most recent), not `main`'s; if that older code cannot run the pass, the run is red until staging deploys forward. The older web cannot read `v2.` cookies or links: every staff member signs in again with their PIN, every terminal pairs again, owners sign in with Google again. Prefer a forward fix. |
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
than 30 days (`server/ops/retention.ts`). It never deletes sessions, any
`offline_*` table, operations, audit, `device_pairing_codes`, any money,
stock, cash or void table, `fiscal_*`, `cfdi_*`, `business_day_settings`,
`report_prints`, `support_actions`, `legal_acceptances`, `account_events`,
`ownership_transfers`, `billing_*`, or blocked receipt jobs
(`tests/retention.test.ts` asserts the allow-list).

Both tables force row-level security and the runtime login has no DELETE, so
retention runs as the schema owner `gm_migrator` from GitHub Actions (the
environment secret `MIGRATION_DATABASE_URL`), never from a Railway service:

- **Once per deploy:** the deploy job's `migrate.js --grants --retention`. A
  failure alerts and never fails the deploy.
- **Daily:** `.github/workflows/retention.yml`, production at 05:15 and
  staging at 05:45 America/Mexico_City (11:15 and 11:45 UTC), after the
  03:30 backup and inside the 04:00–07:00 window (`RETENTION_WINDOW`). One
  run repeats bounded passes while the previous pass deleted a full batch
  (5,000 rows) from some table, at most 10 passes, and never starts a pass
  after 07:00. The schedules run only for environments listed in the
  repository variable `OPS_LIVE_ENVIRONMENTS`; a manual dispatch (Actions →
  Retention → environment) always runs, except production during service
  hours (12:00–23:59) without `allow_service_hours`.
  The workflow runs the environment's **live** release, never `main`'s
  head: production the newest `prod-*` release tag, staging the `main`
  commit (of the latest 30) whose successful `deploy/staging` status is the
  most recent, so a re-run that deployed an older commit is honoured (either
  must be on `main`, or the run fails). It installs and compiles that release without
  the secret, then runs only `node build/scripts/migrate.js
  --retention-only` with `MIGRATION_DATABASE_URL`.
  GitHub may delay or drop a scheduled run: a run that starts after 07:00
  does nothing (`retention_outside_window`, green), and a dropped day is
  caught up the next day; every deploy also runs a pass. A window check that
  cannot answer (the release's `build/server/ops/retention.js` fails to load)
  makes the run red (`retention_window_check_failed`), never "outside".
- **Skips and failures:** when a backup's `pg_dump` or another long
  transaction holds a lock on `jobs`, the pass is skipped (exit 75, logged,
  not alerted); the workflow retries twice, 5 minutes apart, and a third skip
  makes the run red. A scheduled run also stops (red) when the window has
  closed before a retry. A failed table exits 1 after alerting
  `retention_failed`. Either red run opens or updates the `ops-alert: <env>`
  issue.

Each batch briefly turns off FORCE row-level security, which takes an ACCESS
EXCLUSIVE lock on the table until it commits, and every order and payment
inserts into `jobs`. So each batch waits at most 200 ms for that lock and
runs each statement at most 1.5 s. Every batch, from a deploy or the daily
run, can therefore stall order and payment inserts for up to about 1.7 s;
that matters during service (a deploy) and for a restaurant that already
sells before 07:00. When `retention_failed` reports
`reason:"statement_timeout"`, the jobs scan has outgrown that bound (no index
serves the predicate): nothing was deleted, each such pass stalled inserts
for up to that 1.7 s, and the table keeps growing until the follow-up below
ships. Do not raise the bounds in service hours.

To purge by hand (for example after a red run), with `MIGRATION_DATABASE_URL`
(`gm_migrator`, direct endpoint), `APP_ENV` and optionally
`ALERT_WEBHOOK_URL` in a private 0600 file, never on the command line:
`node --env-file=<file> --import tsx scripts/migrate.ts --retention-only`
(what `npm run ops:retention` and the workflow run). It applies no
migrations, grants or policy reconcile; inside the window it repeats passes
while a backlog remains, outside it runs exactly one. It exits 1 when a table
fails (after alerting) and 75 when a table was skipped on a lock timeout. Run
it outside service hours for the same reason.

## Jobs

`GET /api/jobs` lists a restaurant's latest jobs for an owner or manager. Two
controls, both for an owner or manager with a recent PIN or password
(step-up), act on one job of their own restaurant. **No screen calls them
yet:** they are operator API calls made from a signed-in manager's browser
session (cookie, CSRF header and a step-up within the last
`ACCESS_STEP_UP_SECONDS`) until a jobs screen exists. Each writes an audit row
(`job.requeued`, `job.cancelled`) with the job's kind and its state and error
code before the change, visible in `GET /api/audit`:

- `POST /api/jobs/<id>/requeue` retries a **dead** job (attempts reset);
- `POST /api/jobs/<id>/cancel` stops a queued, available, blocked or running
  job: it goes dead with `error_code` `cancelled`, a running holder loses its
  lease (its later writes match no row) and nothing claims it again. Use it
  for a job that keeps killing its process before its last attempt; requeue
  it after the fix.

A job whose process dies on its last allowed claim goes dead by itself
(`lease_expired`) and alerts `jobs_dead_<kind>`; earlier crashes are retried
after the lease (120–300 s per kind, at most 1 hour).

## Deploy window

Production deploys are refused between 12:00 and 23:59 America/Mexico_City
(UTC−6 year-round) unless `allow_service_hours` is ticked for an urgent fix.
Prefer 06:00–11:00.

The deploy job migrates before it uploads anything (`migrate.js --grants
--retention` as `gm_migrator`), and a migration's locks last until it
commits. A production deploy that first carries a migration locking a hot
table runs **before 07:00** Mexico City, ahead of breakfast service: cfdi's
030 ends with the `jobs` discovery policy and a non-concurrent index on
`jobs`, and every order and payment inserts into `jobs`, so those inserts
wait while the index builds (platform P-27, LD-8). Fiscal's 027 belongs in
the same window: its foreign keys to `orders`, `restaurants`, `employees`,
`devices` and `refunds` and its `BEFORE INSERT` trigger on `order_lines` take
`SHARE ROW EXCLUSIVE` on those tables until 027 commits, so sales wait for it
(bounded by its `SET LOCAL lock_timeout = '5s'`). The fiscal operations
(missing tickets, kill switch, series, border incentive) are in
[FISCAL.md](FISCAL.md#runbook).

**Dated operator check, 2026-12-31 (border tenants, lead decision LD-25).** The
IVA 8% border incentive runs until 31-12-2026 (DOF decree of 31-12-2025). In
the last week of December, look for a DOF extension. If none is published, on
2027-01-01, before the first sale, each border restaurant's owner moves IVA 8%
products and the default product tax to IVA 16% and switches Datos fiscales to
the general region, after every device has synced its offline sales (queued
sales are taxed with the settings in force at sync). If one is published,
update `BORDER_STIMULUS_VALID_UNTIL` in `shared/tax.ts` and deploy.

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
2. Set `DATABASE_URL` and `PG_APP_USER` on `web` (`scripts/ops/railway-vars.sh`)
   and the GitHub environment variable `PG_APP_USER`
   (`gh variable set PG_APP_USER --env <env> --body <new login>`), redeploy
   `web`. Do not merge a migration between this step and step 3: the deploy
   job grants only the login `PG_APP_USER` names. The worker holds no runtime
   login.
3. When the old login has no sessions:
   `… rotate-db-login.ts --env <env> --finalize --old gm_<env>_app`.
   It drops what the old login owns, revokes the database `CONNECT` and
   schema `USAGE` that deploys granted it as `gm_migrator` (acting as that
   role, since only the grantor can revoke them), and drops the login, in
   one transaction. A refusal naming a grantor the owner cannot `SET ROLE`
   to changed nothing: revoke that grant as its grantor, then retry.
4. Same for `--kind billing` (both services), `--kind worker`
   (`WORKER_DATABASE_URL` on `worker`, redeploy it, then `--finalize`; the new
   login copies the `gm_jobs_worker` membership and the 30 s/8 s/60 s
   defaults) and `--kind backup` (GitHub environment secret). `--kind migrator`
   sets a new `gm_migrator` password; update the GitHub environment secret
   with `gh secret set MIGRATION_DATABASE_URL --env <env> < <file>` (stdin,
   never on the command line). No Railway service holds it.
5. Record it in [STAGING.md](STAGING.md) "Credential rotation log" (no secrets).

Other secrets:

- Signing keys (`SIGNING_KEYS`) and `JWT_SECRET`: see "Signing keys" below.
- Stripe webhook secret: roll in the Stripe dashboard (it keeps the old secret
  valid for a window), set `STRIPE_WEBHOOK_SECRET` on `web`, deploy.
- Google OAuth client secret: add a new secret in Google Cloud, set
  `GOOGLE_CLIENT_SECRET`, deploy, then disable the old secret.
- R2 token, Railway project token, ntfy topic: create the new one, update the
  GitHub environment secret/variable, delete the old one.

## Signing keys

Cookies and links are signed with the OPS-10 keyring (`server/keyring.ts`):
`SIGNING_KEYS="<kid>:<base64url secret>[,…]"` on `web` only. The first entry
signs; every listed entry verifies; each use gets its own HKDF-derived key,
so a cookie never opens a sealed CFDI link and one sealed purpose never opens
another. Sealed tokens are signed, not encrypted: their payload is readable by
whoever holds the link, so it carries opaque ids only (`server/tokens.ts`). A
deployed `web` (staging and production) requires `SIGNING_KEYS` and refuses
the committed CI keyring, fixture kids (`ci-`, `local-`, `test-`) and secrets
that decode to printable text (`placeholder_signing_keys`), and the CI, local
and documented placeholder `JWT_SECRET`s (`placeholder_jwt_secret`); a
deployed worker refuses both variables. At startup `web` logs
`signing_keys_active` with the signing kid and every verifying kid. Every step below edits only the `web` service's `SIGNING_KEYS`,
from the private file read by `scripts/ops/railway-vars.sh` (never on a
command line). `node scripts/ops/generate-signing-key.mjs` prints one new
entry (`k<YYYYMMDD>-<4 hex>:<32 random bytes>`).

1. **Routine** (yearly, or when someone with access leaves), in two steps so
   the instance still serving during a deploy's overlap can verify what the
   new one signs:
   1. Generate `<new>`. Set `SIGNING_KEYS="<current>,<new>"` (still signed by
      `<current>`; `<new>` only verifies) and redeploy `web`.
   2. After that deploy is live, set `SIGNING_KEYS="<new>,<current>"` and
      redeploy. `<new>` now signs.
   3. After **31 days** (the `gm_device` and owner-browser cookies live 30 days
      and are re-signed on every sign-in; CFDI portal links live at most 7
      days), set `SIGNING_KEYS="<new>"` and redeploy.
2. **Emergency** (a key leaked): set `SIGNING_KEYS="<new>"` only and redeploy.
   From then on, **never** roll back or redeploy a `web` deployment created
   before this one from the Railway dashboard: it restores the leaked key
   ("Rollback" above). Roll back only with Actions → Deploy. After the
   redeploy, record its deployment id in the incident log and confirm that
   the new deployment's `signing_keys_active` line shows `signKid` and `kids`
   equal to the new kid alone, and that a fresh `gm_session` cookie starts with
   `v2.<new kid>.`.
   Before proceeding, where possible, have every device sync its offline
   queue: re-paired terminals are new devices, so an unsynced offline payment
   arriving from them lands in manager review (`offline_drawer_conflict`).
   The impact, which the operator accepts before proceeding and records in
   the incident log:
   - every staff member signs in again with their PIN;
   - every terminal pairs again with a new code from Configuración →
     Dispositivos (at most 5 open codes at a time; see
     [ACCESS.md](ACCESS.md) "Signing-key rotation and terminals");
   - owners sign in with Google again;
   - QR/kiosk ordering links (off in production until wave 3) and CFDI
     self-invoice links stop working and are issued again.
3. **`JWT_SECRET`** stays required on `web` in v1: outside production it
   still verifies pre-2.0 tokens (production refuses them; none were ever
   issued there), and it keys the lookup digests. Rotate it only together
   with an emergency rotation, because then outstanding pairing codes stop
   working, an invitation re-created with the same operation id gets
   `operation_conflict`, and an idempotent replay of a PIN-reset operation
   from before the change is refused as a conflict. Keep it at 64+
   characters.

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
   - **Still needed:** a variable another area reads on staging or a
     deliberate override such as `TRUST_PROXY`. Access's
     `ACCESS_STEP_UP_SECONDS` and `ACCESS_IDLE_LOCK_DEFAULT_SECONDS` are
     already declared on `web`, and `DEMO_TENANT_ID` on staging's `web` only
     (production never declares it, so a value there is planned as a deletion;
     the server refuses to start with it in production). For any other
     still-needed name, add `NAME: preserve()` to that service in
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
   `web` (`APP_ENV=staging`, `WORKER_URL`, `SIGNING_KEYS`), `worker`
   (`WORKER_DATABASE_URL`, `BILLING_DATABASE_URL`, Stripe sandbox keys,
   `ALERT_WEBHOOK_URL`). Never `MIGRATION_DATABASE_URL` on any service: it is
   the GitHub environment secret of step 8 (Wave 2.0 deltas below).
8. GitHub: `scripts/ops/github-protect.sh` (after the first PR has run the
   checks), environment secrets (`RAILWAY_TOKEN`, `MIGRATION_DATABASE_URL`,
   `ALERT_WEBHOOK_URL`, backup and R2 secrets) and variables (`APP_URL`,
   `PG_APP_USER`, `ALERT_WEBHOOK_KIND`, the pinned CLI and IaC versions).
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

**Wave 2.0 deltas to these steps.** Staging has not run this cutover yet, so
it runs once, from the integrated code that already contains Wave 2.0
(keyring, worker jobs login, migrations in GitHub Actions), with these
changes:

| Step | Delta |
| --- | --- |
| 2 | `provision-roles.ts` also creates `gm_staging_worker` (a `gm_jobs_worker` member; 30 s/8 s/60 s; `CONNECT`) and writes `WORKER_DATABASE_URL` to `.env.provisioned-staging`; `globals.sql` creates `gm_jobs_worker` and `gm_support`. The `-- 2.0 jobs worker` grants block refuses to apply until `globals.sql` has run. |
| 4 | Nothing new for `web`. The `worker` service is created by this cutover, so it has nothing to inventory. |
| 5 | Expected for `worker`: no `preDeploy`, `WORKER_DATABASE_URL`, `DB_STATEMENT_TIMEOUT_MS`, and the cfdi and account `preserve()` names; for `web`: `SIGNING_KEYS` and the account, fiscal and cfdi `preserve()` names. If the plan rejects a `preserve()` of a never-set variable (Railway's docs only say `preserve()` keeps a value that is already set), set it empty with `railway variable set NAME= --service <svc> --skip-deploys`; every reader treats an empty value as unset. **Never** use that workaround for `SIGNING_KEYS` (web) or `WORKER_DATABASE_URL` (worker): a deployed web without real signing keys and a deployed worker without its jobs login refuse to start (`missing_signing_keys`, `missing_worker_database_url`); set them in step 7 first. |
| 7 | `web`: add `SIGNING_KEYS` (`generate-signing-key.mjs` output). `worker`: set `WORKER_DATABASE_URL`; **do not** set `MIGRATION_DATABASE_URL` (the worker refuses it) or `PG_APP_USER`. |
| 8 | Environment `staging`: `gh secret set MIGRATION_DATABASE_URL --env staging` (stdin, from `.env.provisioned-staging`); `gh variable set PG_APP_USER --env staging --body gm_staging_app`; `gh variable set ALERT_WEBHOOK_KIND --env staging --body ntfy`. |
| 9 | The deploy job migrates from GitHub before Railway; `worker_ready` logs `jobs:true`; `/api/ops/status` shows `worker.status:"ok"`. |
| After 9 | Confirm a `v2.` prefix on a freshly issued `gm_session` cookie (browser devtools; read the prefix only). If a terminal paired before the deploy still has a valid device row, confirm that it still signs in: its pre-2.0 cookie verifies on staging while `JWT_SECRET` is set. |
| 14 | `OPS_LIVE_ENVIRONMENTS=staging` also turns on the daily retention workflow. Dispatch Actions → Retention → staging once by hand first; it must pass. |

Record each delta in [STAGING.md](STAGING.md).

**For every area (integration note):** a Railway variable that a service
must keep has to be declared in `.railway/railway.ts` (a literal, or
`preserve()` for a value set out of band). Wave 2.0 registered every wave-2
variable; wave-2 areas never edit that file, and a missing name is reported
to the lead, who adds it on `integration/v1` before that area merges. An
undeclared variable is planned as a deletion, and CD's non-destructive
`config apply --yes` then stops every automatic staging deploy at the sync
step. Declare a variable before setting it: `TRUST_PROXY` is deliberately
undeclared (its default is correct on Railway).

## Open follow-ups

Known gaps this release leaves open, with their owner:

| Item | Today | Follow-up |
| --- | --- | --- |
| DB-1, billing credential in `web` | While billing is enabled, `web` holds `BILLING_DATABASE_URL` for owner billing commands and the webhook. That login is a member of `gm_billing_worker`, whose policies read restaurants, organizations, entitlements and billing tables across tenants. Production launches with `BILLING_SANDBOX_ENABLED=false`, and production `web` refuses to start with `BILLING_DATABASE_URL` set while billing is disabled (`server/config-rules.ts`), so the internet-facing process never holds it there. | No billing inbox is built in v1 (critic #0 dropped it). Production keeps billing disabled, so its `web` never holds the login; revisit before live billing is enabled. Owner: the post-launch billing area that builds the live Stripe adapter (LD-15 account Q7; the account area does not build it). |
| DB-6, grants hash in readiness | Grants are applied in the newest migration's transaction, so a new revision cannot pass `/api/health` before its tables are granted; readiness itself checks only `schema_migrations` (`server/readiness.ts` is frozen this wave). | Ops, next wave: a `schema_grants` registry and a readiness check of the manifest hash. |
| OPS-R10, retention needs DDL | Each retention batch turns off FORCE row-level security (ACCESS EXCLUSIVE until commit) and scans `jobs` without an index, because only the owner may delete and FORCE applies to it. The daily workflow therefore runs it only 04:00–07:00 Mexico City (and each deploy runs one pass), with a 200 ms lock wait and a 1.5 s statement bound per batch; at a few million `jobs` rows (blocked receipt jobs are never deleted) the scan exceeds the bound and `retention_failed` reports `statement_timeout` every night. | Ops, next wave (a new migration; 022 is limited to the hot-path indexes): a partial index `jobs(created_at) WHERE state IN ('done','dead')` so each batch finds its rows in milliseconds, and a `gm_maintenance` login with DELETE on the two tables under policies limited to the retention predicates, so retention needs no DDL and no ACCESS EXCLUSIVE lock and can run at any hour. |
| OPS-R17, gitleaks image by tag | The qualification secret scan runs `ghcr.io/gitleaks/gitleaks:v8.21.2` by tag, while every action is pinned by commit SHA; a retagged image would run with the repository history mounted. The digest is not pinned yet: it could not be read from the registry in the environment that made this change, and a guessed digest would fail every run. | Ops: read the index digest (`docker buildx imagetools inspect ghcr.io/gitleaks/gitleaks:v8.21.2`), pin `…:v8.21.2@sha256:<digest>`, and make `tests/workflows.test.ts` refuse a `docker run` image without a digest. |
| PLATFORM-OPS-10 / PLAT-HR-7, running-lease scans | Worker discovery, the claim's running branch and `expireLostJobs` (`state='running' and lease_until < now()` per tenant and kind) have no supporting index, so each scans the tenant's `jobs` rows of that kind, including 30 days of done `kitchen_dispatch` rows. The claim runs on every drain (the web drains on every authenticated write, 250 ms debounce); the expiry runs at most once per sweep (30 s) per tenant and kind since the hardening. | cfdi's 030 (the first migration that registers worker kinds): a partial index on `jobs (tenant_id, kind, lease_until) WHERE state='running'`, with `EXPLAIN` of discovery, the claim and the expiry statement recorded in the cfdi DB suite. |
| PLATFORM-ROLES-2 (rest), reachable-role checks | The runtime and worker login checks cover every role a login can `SET ROLE` to since the hardening. Still unchanged: `assertRuntimeRole` (`server/ops/schema.ts`), the `provision-roles.ts` assertion (attributes and `neon_superuser` only), and `globals.sql`, which creates missing capability roles but never corrects an existing `gm_jobs_worker` or `gm_support` (`ALTER ROLE … NOLOGIN NOBYPASSRLS …`). | Wave 3 ops: the same reachable-role allow-list in `assertRuntimeRole` and `provision-roles.ts`, and a normalizing `ALTER ROLE` for each capability role in `globals.sql`. |
| PLATFORM-ROLES-4, local bootstrap migrates as the superuser | `scripts/setup-local.sh` migrates and applies grants as `gm_provisioner` (the initdb superuser), so locally FORCE RLS does not bind the table owner; CI, the track reset script and Neon migrate as `gm_migrator`. A SECURITY DEFINER helper that forgets `app.tenant_id` passes locally and fails in CI. | Wave 3 ops: mirror `qualification.yml` (give `gm_migrator` a local login, apply `database-grants.sql`, migrate with `MIGRATION_DATABASE_URL` as `gm_migrator`; keep `gm_provisioner` for fixtures only). |
| PLATFORM-CI-8, images by tag | Besides gitleaks (OPS-R17 above), the `postgres:18` CI service and the production base image `node:24.21.0-bookworm-slim` (`Dockerfile`) are referenced by mutable tags; `tests/workflows.test.ts` pins only `uses:` lines. | Wave 3 ops, with OPS-R17: pin each image by digest (tag as a comment) and make the workflows test require `@sha256:` on `docker run`, `services` images and `FROM` lines. |
| OPS-10 residual: lookup digests and legacy tokens | **Done in Wave 2.0:** the signing keyring (`SIGNING_KEYS`, named kids, HKDF per-use keys, purpose-bound sealed tokens, two-step rotation; "Signing keys" above). Production refuses pre-2.0 tokens. Still keyed by `JWT_SECRET`: the pairing-code, PIN-fingerprint, invitation and transfer digests, so `JWT_SECRET` stays required on `web`, and outside production pre-2.0 tokens verify while it is set. F2 (in-transaction authentication) is unchanged. | Wave 3 (D4): keyed digests (access A1) together with account's invitation and transfer HMACs; then production unsets `JWT_SECRET`. |

## Incident log template

```
Date/time (America/Mexico_City):
Detected by: (alert / restaurant call / uptime issue)
Key or credential rotated: (name, new kid or login, Railway deployment id of the
  rotation; confirmed with signing_keys_active / a fresh v2.<kid> cookie)
Impact: (restaurants affected, what staff could not do, duration)
Timeline: (detection, acknowledgement, mitigation, resolution)
Root cause:
Data impact: (none / reconciled how)
Follow-ups: (owner, due date)
```
