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
| `cfdi_provider_auth_failed` (critical) | ntfy, from the worker | Facturapi refused the platform User key (CFDI publishes `disabled`) or a restaurant's organization key: check the worker's `FACTURAPI_API_KEY` / that organization ([CFDI](CFDI.md) "Operations") |
| `cfdi_global_overdue:*`, `cfdi_global_late:*`, `cfdi_global_failed:*` (warning) | ntfy, from the worker | a global invoice missed its 24 h deadline, a late supplementary part was issued after it, or a part failed: Facturas globales → **Emitir ahora** / **Reintentar** |
| `cfdi_stamp_unresolved:*`, `cfdi_cancel_unresolved:*`, `cfdi_cancel_failed:*`, `cfdi_substitution_rejected:*`, `cfdi_reissue_failed:*`, `cfdi_refund_unresolved:*`, `cfdi_ticket_excluded:*`, `cfdi_amount_mismatch:*` (warning) | ntfy, from the worker | one restaurant's document needs a person (`<tenant>` = first 8 hex characters of the tenant id): see the action per key in [CFDI](CFDI.md) "Operations" |
| `cfdi_csd_expiring:*` (info) | ntfy, from the worker | a restaurant's CSD expires within 30 days: the owner uploads a new one |
| `public_order_limited` (log, warn) | web logs | a public QR/kiosk order hit a durable cap (`code`: `public_order_limit`, `public_ordering_busy` or `public_order_churn`); the line names the code's `ref` (the "Ref. 7A3F" staff see in Mesas or Configuración), its kind and the client's `ipHash`, never a token or a path. Repeated lines for one `ref` from one `ipHash`: "Online ordering abuse" below |
| `rate_limited` with `limiter: public-*` (log, warn) | web logs | a client hit a public ordering per-IP or per-link limit (in memory, per replica); one diner retrying is normal, a steady stream from one `ipHash` is abuse |
| `jobs_dead_cfdi_*` (warning) | ntfy, from the worker | a cfdi job used up its attempts. The global tick's recovery sweep re-enqueues what the document needs within a day (or a manager presses **Reintentar** on it); a dead `cfdi_global` tick already scheduled the next one, and the chain also restarts at the next worker deploy and operator sign-in ([CFDI](CFDI.md) "Jobs") |

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

## Client address

Every per-IP limit (access PIN, pairing and logout; public ordering; the cfdi
portal; account; owner sign-in and account; billing; ops endpoints) and every
`ipHash` in the logs key on `clientIp(req)` (`server/logging.ts`, LD-46).

Railway's edge, as verified on staging on 2026-10-07 with a temporary
header-echo service (created, probed, deleted), connects to `web` from
100.64.0.0/10, **discards** any `X-Forwarded-For` and `X-Real-IP` the client
sent, and sends `X-Forwarded-For: <client>, <edge hop>` and
`X-Real-IP: <client>`. Express's `req.ip` takes the rightmost untrusted
`X-Forwarded-For` entry, which there is the edge hop: a public address that
every client behind that hop shares. So `clientIp` returns `X-Real-IP` when
the immediate peer is trusted by `trust proxy` (`TRUST_PROXY`, default
`loopback, 100.0.0.0/8` in production; IPv4-mapped peers count as IPv4) and
the header is exactly one valid address; otherwise `req.ip`. An untrusted
peer's `X-Real-IP` is ignored. Limiters group IPv6 clients per /56, and every
`rateLimit()` in `server/` has an explicit `keyGenerator` through `clientIp`
(`tests/client-ip.test.ts` fails on one without, and on any `req.ip` read
outside `server/logging.ts`).

Check it by hand with `GET /api/ops/diagnostics/ip`, which answers
`{ ip, peerTrusted, source }`: behind the edge you should see
`peerTrusted: true`, `source: "x-real-ip"` and your own public address. The
CD smoke's `client_ip` check proves less than that: it requires
`peerTrusted: true`, `source: "x-real-ip"` and a public address, and the same
answer when the request carries spoofed `X-Forwarded-For` and `X-Real-IP`
(spoof invariance). It cannot prove the address is the runner's own (it does
not know it), so after a change at the edge also compare the answer with
your own address by hand. Its error names each failed condition:

| Smoke error | Meaning | Action |
| --- | --- | --- |
| `peerTrusted is false` | the edge's peer address is outside `trust proxy`; every client then shares the peer's bucket | check `TRUST_PROXY` (deliberately undeclared; declare it in `.railway/railway.ts` before setting it, "Staging cutover" below) or a change in Railway's internal range; do not promote |
| `source is forwarded, not x-real-ip` | no usable `X-Real-IP` from the edge: the address is the edge hop (the first staging deploy's failure) | Railway's headers changed; re-verify the header shape with a header-echo service (record it without addresses) before changing `clientIp`; do not promote |
| `source is peer, not x-real-ip` | the request reached `web` without the edge's headers | check the domain still routes through Railway's edge |
| `ip is a client-supplied forwarding header value` or `forwarding headers changed the client IP` | the edge passed the client's own headers on: anyone can pick their limiter bucket | stop the rollout; roll back |
| `ip is a proxy or private address, not public` or `ip is not an IP address` | the address is the edge's peer, a private range or missing | as for `peerTrusted is false` |

Between smokes, a deployed `web` (`APP_ENV` staging or production) logs
`client_ip_without_real_ip` (warn, once per process, with `source` and
`realIpHeader: missing|invalid`, never an address) the first time a request
from a trusted peer arrives without a usable `X-Real-IP` (Railway's health
checks on `/health` and `/api/health` excepted). Treat it like the smoke's
`source is forwarded` or `source is peer` rows above.

While the address is wrong, a restaurant or a carrier NAT behind one edge hop
shares one bucket per limit (one busy client can lock the others out of PIN
login or public ordering), and `ipHash` names the hop, not the client.

The smoke cannot tell a client's address from another proxy's: keep the custom
domain DNS-only in Cloudflare ("Manual Railway settings" above). Proxied
through Cloudflare, `X-Real-IP` would be a Cloudflare address shared by many
clients while every check above still passes.

## Retention

Retention deletes only expired OAuth login attempts and done/dead jobs older
than 30 days (`server/ops/retention.ts`). It never deletes sessions, any
`offline_*` table, operations, audit, `device_pairing_codes`, any money,
stock, cash or void table, `fiscal_*`, `cfdi_*`, `business_day_settings`,
`report_prints`, `support_actions`, `legal_acceptances`, `account_events`,
`ownership_transfers`, `billing_*`, any `public_*` table
(`public_ordering_settings`, `public_links`, `public_hold_numbers`,
`public_order_holds`: diner status pages, the abuse and churn reads and the
owner export use them), or blocked receipt jobs (`tests/retention.test.ts`
asserts the allow-list).

It also **redacts** in place, never deletes: the diner's name and note of
every public ordering hold older than 30 days, in any state, are blanked
(migration 034 lets the transition trigger accept exactly that update;
LD-41). Each run reports them as `redacted.public_order_holds` in the
`retention_run` log line (and `retention_only_complete` for the daily run).
034's partial index `public_order_holds_unredacted` keeps each batch to the
holds that still carry a name or note.

The three tables force row-level security and the runtime login has no
DELETE (nor UPDATE on a hold's name or note), so retention runs as the
schema owner `gm_migrator` from GitHub Actions (the environment secret
`MIGRATION_DATABASE_URL`), never from a Railway service:

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
EXCLUSIVE lock on the table until it commits (for `public_order_holds`, diner
submits and staff decisions wait for it the same way), and every order and
payment inserts into `jobs`. So each batch waits at most 200 ms for that lock and
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

### Log retention

Service logs (web and worker) live only in Railway, which keeps them for the
workspace plan's period: 7 days on Hobby, 30 days on Pro, up to 90 days on
Enterprise (Railway's documentation, "Logs", checked 2026-10-06). Railway
notes that upgrading a plan restores older logs at once, so the period limits
what is shown, not what Railway stores. Members of the Railway project can
read them; nothing forwards them elsewhere. Some lines carry pseudonymous
personal data (`ipHash` in `rate_limited` and `public_order_limited`,
[PUBLIC_ORDERING.md](PUBLIC_ORDERING.md) §12), so keep project membership to
the people who operate the service and record the plan in use for counsel
([LAUNCH_HANDOFF.md](LAUNCH_HANDOFF.md) 1.12).

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
(bounded by its `SET LOCAL lock_timeout = '5s'`). Public ordering's 032 belongs
in the same window once production has traffic (P-27, LD-P15 OQ-14): its
`ADD CONSTRAINT … NOT VALID` statements take a brief `ACCESS EXCLUSIVE` on
`orders`, `rounds` and `jobs` (first in the file, `lock_timeout` 5 s, retried
on 55P03), and a deadlock with live KDS reads rolls the whole file back and
fails the deploy (re-running it is safe). Run "DB-9 validation" below before
the first deploy that carries 032 and 033. Public ordering's 034 replaces the
hold transition function (no table lock) and builds a small non-concurrent
partial index on `public_order_holds`, so diner submits and hold decisions
wait while it builds; it belongs in the same window once QR ordering has
traffic. The fiscal operations
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
   A schema grant whose grantor is `pg_database_owner` (schema `public`'s
   owner since PostgreSQL 15; a legacy grant made before the cutover, as on
   staging in LD-47) cannot be revoked that way: Neon lets no login
   `SET ROLE pg_database_owner`. Finalize revokes it in the same transaction
   through the schema's ownership: `ALTER SCHEMA public OWNER TO` the owner
   login (which rewrites `pg_database_owner`'s grants as that login's),
   `REVOKE`, `ALTER SCHEMA public OWNER TO pg_database_owner`, and it rolls
   everything back unless the schema ACL afterwards is the starting one
   minus exactly that grant, owned by `pg_database_owner` again (the action
   reads "schema ownership round trip, ACL verified"). The round trip folds
   any entry naming the owner login itself into the owner's own entry, so a
   refusal listing what it would have `lost` or `gained` changed nothing:
   run the same three statements by hand in one transaction as the owner
   login, compare `select nspacl from pg_namespace where nspname = 'public'`
   before and after (only the old login's entry may go), restore any other
   entry the round trip changed before `COMMIT`, then retry the finalize.
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
- cfdi `CREDENTIAL_ENCRYPTION_KEY` (worker only): prepend a new kid, redeploy
  the worker, run `npm run cfdi:rekey`, then drop the old kid
  ([CFDI](CFDI.md) "Credential key rotation"). The Facturapi User key: create a
  new one in Facturapi, set `FACTURAPI_API_KEY` on `worker`, deploy, revoke the
  old one.

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
   - CFDI self-invoice links stop working and are issued again. Public
     ordering's QR and kiosk codes (032) are database rows, not signed
     tokens: a key rotation leaves them working.
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
   check ("Client address" above: `source: "x-real-ip"` from a trusted peer).
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

## Online ordering abuse

Public QR and kiosk ordering (032, [PUBLIC_ORDERING](PUBLIC_ORDERING.md) §11).
A diner's order is only a hold until staff accept it: nothing reaches the
kitchen, stock or a fiscal record on its own.

1. **Reject as abuse.** In Órdenes, **Rechazar** → "Pedido falso o abuso". A
   manager ticks "Desactivar también este código QR". The printed code stops
   working at once in every web process (each request re-reads the link);
   the diner sees "Pregunta al personal". The code's other pending orders stay
   in the inbox, marked "Código desactivado por abuso", and need an explicit
   tick before anyone accepts them.
2. **Pause** online ordering (any operator, from the inbox or Configuración)
   while the source is unclear.
3. **Replace** a table's code in Mesas (**Reemplazar e imprimir**) and stick
   the new card; deactivate a kiosk or takeaway code in Configuración.
4. **Churn.** Many orders sent and cancelled from one code show in the inbox
   by name ("muchos pedidos cancelados desde el cliente"); replace or
   deactivate that code.
5. **Logs.** `rate_limited` lines carry the limiter name and `ipHash`;
   `public_order_limited` lines carry the code, the link's `ref` and kind, and
   `ipHash` (pseudonymous personal data: see "Log retention" above). Neither stores tokens or paths. The durable caps (3 pending per
   table, 5 per kiosk, 10 per takeaway code, 40 per restaurant; windows per
   15 minutes) bound the damage whatever the IP.
6. **Kill switch.** `PUBLIC_ORDERING_ENABLED=false` on `web` (a redeploy)
   turns QR and kiosk ordering off for every restaurant: diner and staff
   ordering routes answer `404 public_ordering_disabled`, and staff screens
   hide the panel, the table QR actions and the inbox. Pending QR orders can
   be neither accepted nor rejected while it is off, so they stop counting
   on tables too: Mesas shows no "Pedido QR por confirmar" badge and a table
   held only by one can be archived. They expire on their own.
   - Use exactly `false` (any other value except `true` or empty stops the
     web with `public_ordering_flag_invalid`). After the redeploy, check that
     `GET /api/account-config` reports `publicOrdering.enabled: false` and
     `switchedOff: true`; a Pro restaurant's plan panel then says "Pedidos
     QR y kiosco desactivados temporalmente por Green Monkey."
   - Staff terminals that are open drop the waiting cards, the badge and the
     banner at their next inbox or summary read.
   - **To turn it back on,** unset the variable or set it to `true`,
     redeploy, and check that `/api/account-config` reports
     `publicOrdering.enabled: true`. No reload is needed anywhere: staff
     terminals read the summary again within 5 minutes (at once when
     brought to the front), diner pages that loaded their menu clear the
     "no están disponibles" notice at their next minute poll, and a kiosk
     that booted while ordering was off retries its menu every 20 s
     (PUBLIC-UX-1, PUBLIC-OPS-1). The response is cacheable for 5 minutes,
     so a browser may show the old `/api/account-config` that long.

## DB-9 validation

032 adds CHECK constraints `NOT VALID` on `orders.state`, `orders.channel`,
`orders.mode`, `rounds.state` and `jobs.state` (enforced for every new write
at once); 033 (`-- gm:no-transaction`, one `VALIDATE` per part, `SHARE UPDATE
EXCLUSIVE`) validates existing rows. **Before the first deploy that carries
them,** run the check below on staging and on production. It lists every row
033 would refuse, by table, `tenant_id` and `id`, and it must return no rows.
Staging deploys on its own once Qualification passes on `main`, so run it on
staging **before merging** the change that brings 032/033 to `main`, and on
production before dispatching that SHA (PUBLIC-OPS-8).

**Run it as the Neon owner role** (`neondb_owner`, which bypasses RLS through
`neon_superuser`; [PROVISIONING.md](PROVISIONING.md)), connected as that role
and never after `SET ROLE gm_migrator`. Do not run it as `gm_migrator`:
`orders`, `rounds` and `jobs` use FORCE ROW LEVEL SECURITY, and `gm_migrator`
is neither a superuser nor BYPASSRLS. With no restaurant set it sees no rows
at all, so the check would pass whatever the data. The block's
`set local row_security = off` turns that mistake into an error (`query would
be affected by row-level security policy for table "orders"`) instead of an
empty result. If you get that error, reconnect as the Neon owner role.

```sql
begin read only;
set local row_security = off;
select tenant_id, id, state from orders where state not in ('active','ready','completed','cancelled','recovery_pending','recovery_reviewed');
select tenant_id, id, channel from orders where channel not in ('pos','qr','kiosk','offline');
select tenant_id, id, mode from orders where mode not in ('takeaway','dine_in','delivery');
select tenant_id, id, state from rounds where state not in ('active','ready','completed','offline_review');
select tenant_id, id, state from jobs where state not in ('queued','available','running','done','blocked','dead');
rollback;
```

If 033 fails anyway (a row outside a set), nothing is lost. 032 committed, so
its constraints already block new bad writes, and the new revision never
passes readiness because 033's registry row is written only after every part
succeeds. To recover:

1. Run the check above, as the Neon owner role, to find each row.
2. Repair each row as the same role, with the block below. Set it to the
   value the current code would write (for example, a legacy `state`), and
   record it in the incident log. `UPDATE 0` means the `tenant_id` or `id` is
   wrong and nothing changed.
3. Re-run the deploy. `VALIDATE` of an already valid constraint is a no-op.

```sql
begin;
set local row_security = off;
update <table> set <column> = '<value>' where tenant_id = '<tenant_id>' and id = '<id>';
commit;
```

`tests/public-ordering-db.ts` test 1+3 runs both blocks exactly as written
here. As a BYPASSRLS non-superuser member of the owner (the Neon owner role's
shape), they list and repair another tenant's bad row in every column. As the
schema owner (`gm_migrator`'s shape), they fail instead of passing. A new value in any of these
columns needs a migration that drops and re-adds its constraint
(`-- gm:contract-approved`), tests that write it, and a note to public
ordering (LD-P13).

## Hold redaction (ARCO)

A diner's ARCO cancellation of the name or note typed on a QR or kiosk
order: support runs [PUBLIC_ORDERING.md](PUBLIC_ORDERING.md) "Redacting a
hold (ARCO)" as `gm_migrator`, for one hold in any state, and records it in
the cancellation register ([OPERATIONS.md](OPERATIONS.md), "ARCO requests").
Since 034 it is a plain tenant-scoped `UPDATE` that locks only that hold, so
it can run at any hour; retention blanks every hold older than 30 days
anyway ("Retention" above).

## Open follow-ups

Known gaps this release leaves open, with their owner:

| Item | Today | Follow-up |
| --- | --- | --- |
| DB-1, billing credential in `web` | While billing is enabled, `web` holds `BILLING_DATABASE_URL` for owner billing commands and the webhook. That login is a member of `gm_billing_worker`, whose policies read restaurants, organizations, entitlements and billing tables across tenants. Production launches with `BILLING_SANDBOX_ENABLED=false`, and production `web` refuses to start with `BILLING_DATABASE_URL` set while billing is disabled (`server/config-rules.ts`), so the internet-facing process never holds it there. | No billing inbox is built in v1 (critic #0 dropped it). Production keeps billing disabled, so its `web` never holds the login; revisit before live billing is enabled. Owner: the post-launch billing area that builds the live Stripe adapter (LD-15 account Q7; the account area does not build it). |
| DB-6, grants hash in readiness | Grants are applied in the newest migration's transaction, so a new revision cannot pass `/api/health` before its tables are granted; readiness itself checks only `schema_migrations` (`server/readiness.ts` is frozen this wave). | Ops, next wave: a `schema_grants` registry and a readiness check of the manifest hash. |
| OPS-R10, retention needs DDL | Each retention batch turns off FORCE row-level security (ACCESS EXCLUSIVE until commit) and scans `jobs` without an index, because only the owner may delete and FORCE applies to it. The daily workflow therefore runs it only 04:00–07:00 Mexico City (and each deploy runs one pass), with a 200 ms lock wait and a 1.5 s statement bound per batch; at a few million `jobs` rows (blocked receipt jobs are never deleted) the scan exceeds the bound and `retention_failed` reports `statement_timeout` every night. | Ops, next wave (a new migration; 022 is limited to the hot-path indexes): a partial index `jobs(created_at) WHERE state IN ('done','dead')` so each batch finds its rows in milliseconds, and a `gm_maintenance` login with DELETE on the two tables under policies limited to the retention predicates, so retention needs no DDL and no ACCESS EXCLUSIVE lock and can run at any hour. |
| OPS-R17, gitleaks image by tag | The qualification secret scan runs `ghcr.io/gitleaks/gitleaks:v8.21.2` by tag, while every action is pinned by commit SHA; a retagged image would run with the repository history mounted. The digest is not pinned yet: it could not be read from the registry in the environment that made this change, and a guessed digest would fail every run. | Ops: read the index digest (`docker buildx imagetools inspect ghcr.io/gitleaks/gitleaks:v8.21.2`), pin `…:v8.21.2@sha256:<digest>`, and make `tests/workflows.test.ts` refuse a `docker run` image without a digest. |
| PLATFORM-ROLES-2 (rest), reachable-role checks | The runtime and worker login checks cover every role a login can `SET ROLE` to since the hardening. Still unchanged: `assertRuntimeRole` (`server/ops/schema.ts`), the `provision-roles.ts` assertion (attributes and `neon_superuser` only), and `globals.sql`, which creates missing capability roles but never corrects an existing `gm_jobs_worker` or `gm_support` (`ALTER ROLE … NOLOGIN NOBYPASSRLS …`). | Wave 3 ops: the same reachable-role allow-list in `assertRuntimeRole` and `provision-roles.ts`, and a normalizing `ALTER ROLE` for each capability role in `globals.sql`. |
| PLATFORM-ROLES-4, local bootstrap migrates as the superuser | `scripts/setup-local.sh` migrates and applies grants as `gm_provisioner` (the initdb superuser), so locally FORCE RLS does not bind the table owner; CI, the track reset script and Neon migrate as `gm_migrator`. A SECURITY DEFINER helper that forgets `app.tenant_id` passes locally and fails in CI. | Wave 3 ops: mirror `qualification.yml` (give `gm_migrator` a local login, apply `database-grants.sql`, migrate with `MIGRATION_DATABASE_URL` as `gm_migrator`; keep `gm_provisioner` for fixtures only). |
| PLATFORM-CI-8, images by tag | Besides gitleaks (OPS-R17 above), the `postgres:18` CI service and the production base image `node:24.21.0-bookworm-slim` (`Dockerfile`) are referenced by mutable tags; `tests/workflows.test.ts` pins only `uses:` lines. | Wave 3 ops, with OPS-R17: pin each image by digest (tag as a comment) and make the workflows test require `@sha256:` on `docker run`, `services` images and `FROM` lines. |
| PUBLIC-OPS-7, public ordering in the GAP-4 profile | The load profile (`scripts/load/profile.ts`, `run-load.ts`) models the cashier, the KDS and the tables view only. Since public ordering's B4, every operator device of a restaurant with an active code also polls `/api/ordering/inbox/summary` (20 s; 5 min otherwise) and Órdenes polls `/api/ordering/inbox` (10 s; 60 s otherwise), and diners poll the menu revision (1 min) and their order status (5-20 s). None of it is in the measured p95 ([LOAD_TEST.md](LOAD_TEST.md)). | Ops and public, before go-live: the staging `target`/`stress` capacity run that sizes `DB_POOL_MAX` includes these polls and a diner submit/status mix for restaurants with codes (RELEASE item 5). Not built yet (LD-41). |
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
