# Infrastructure and configuration contract

The requirement is to keep the same provider setup—Neon, Railway, and the useful existing integrations—while creating a separate application. No live Neon/Railway settings or credentials were fetched during this handoff. This document describes source configuration and a proposed new contract.

## Source versus target

| Concern | Inspected source | Green Monkey target |
| --- | --- | --- |
| Application DB | POS Lite: Neon/postgres.js; Luma: Supabase | Neon PostgreSQL only |
| Runtime | POS Lite Dockerfile: Node 20; Express serves `dist` and `dist-kiosk` | Node 24.21.0 (`.nvmrc`, Dockerfile), TypeScript server build; `web` service (API + jobs runner) and `worker` service (billing provider loop, watchdog, deploy-time migrations) |
| Railway config | `NIXPACKS`, `npm run build`, `node server/index.js`, retry count 5 | `.railway/railway.ts` infrastructure as code: Dockerfile build, worker preDeploy (migrate, grants, retention), readiness checks, draining |
| Luma scheduling | `0 15 * * 1` weekly; `0 8 1 * *` monthly in Vercel config | Railway scheduled jobs with deliberate restaurant timezone semantics |
| DB auth | Owner connection plus app_user role and PG_APP_* credentials | Runtime app role; separately configured migration/provisioning privileges |
| Assets | POS Lite R2 with local-disk fallback | R2 in production; local storage only for disposable development |
| Reports/email | Luma PDF generation and Resend | Durable report jobs and optional Resend delivery |
| Billing | Both Stripe implementations and differing price variables | One subscription model with explicit price-ID mapping |
| Fiscal integration | POS Lite `FACTURAPI_API_KEY`; Luma `FACTURAPI_KEY` | Canonical POS Lite variable, temporary import compatibility only if needed |

## Deployment blueprint

Railway project `proactive-upliftment`, two services built from the root
`Dockerfile` (multi-stage, Node 24.21.0, `npm ci` from the lockfile, compiled
frontend/server, migrations, `scripts/grants.sql`, `scripts/db/post-migrate.sql`
and the stamped `build-info.json`). Both start through
`node --import ./build/server/instrument.js`, which loads and validates the
configuration before any application module (`server/config.ts`).

`railway.json` is gone: Railway stops reading config-as-code files on
2026-12-01. `.railway/railway.ts` (TypeScript IaC, `railway/iac`) declares:

| Service | Start | Health | Notes |
| --- | --- | --- | --- |
| `web` | `build/server/index.js` | `/api/health` (300 s) | Runtime role only (plus the billing login when billing is enabled). `replicas: 1` because rate limits are in memory. `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=20`, `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=10`. |
| `worker` | `build/server/worker.js` | `/healthz` (300 s) | No public domain. `preDeploy: node build/scripts/migrate.js --grants --retention` runs as the non-superuser `gm_migrator`, so the owner credential never reaches `web`. The same credential runs retention every 15 minutes (first run 60 s after boot; `retention_failed` alert on failure). Draining 30 s. Holds the Stripe secret key. |

Every variable that holds a secret is `preserve()`d: IaC never writes secret
values; `scripts/ops/railway-vars.sh` sets them from a private file via stdin.
CD (`.github/workflows/deploy.yml`) runs `railway config apply --yes` without
`--confirm-destructive`, so a plan that would delete a service or variable
stops for review. Domains are deliberately not in IaC. Settings IaC cannot
express are manual and listed in [RUNBOOK.md](RUNBOOK.md): restart policy
(On Failure), region, custom domain, serverless sleep (off), deploy webhook.

`/health` is process liveness. `/api/health` returns 200 only when the newest
bundled migration is applied and the instance is not draining; otherwise 503
(`schema_not_ready`, `server_draining`). `/api/ops/status` is the public,
tenant-free status document for uptime checks. Startup waits for the database
with capped backoff instead of crash-looping (`waitForDatabase`), and SIGTERM
drains in-flight requests and jobs before closing the pools.

Migrations are expand-only, applied one file per transaction with
`lock_timeout` 5 s and retries; see [RELEASE.md](RELEASE.md). Application
rollback is a redeploy of an older SHA, not a database rollback; see
[RUNBOOK.md](RUNBOOK.md) and [BACKUP_RESTORE.md](BACKUP_RESTORE.md).

## Neon connections

Each role has one job ([PROVISIONING.md](PROVISIONING.md) creates them):

| Login | Endpoint | Used by | Defaults (`ALTER ROLE … SET`) |
| --- | --- | --- | --- |
| `gm_<env>_app` (`DATABASE_URL`) | pooled (`-pooler`) | web | `statement_timeout` 10 s, `lock_timeout` 8 s, `idle_in_transaction_session_timeout` 15 s |
| `gm_<env>_billing` (`BILLING_DATABASE_URL`) | pooled | web (owner billing commands, webhook), worker (provider loop); member of `gm_billing_worker` | 30 s / 8 s / 60 s |
| `gm_migrator` (`MIGRATION_DATABASE_URL`) | direct | worker only: preDeploy (migrate, grants, retention) and the 15-minute retention schedule (one connection, closed when idle); owns the schema; no superuser, BYPASSRLS or CREATEROLE, so FORCE RLS applies to it (backfills use the owner pattern, [RELEASE.md](RELEASE.md)) | `lock_timeout` 5 s, `statement_timeout` 10 min |
| `gm_<env>_backup` (`BACKUP_DATABASE_URL`) | direct | GitHub backup workflow; member of `gm_backup_reader` (reads through `ops_backup_read` policies) | no timeouts |
| `neondb_owner` | direct | provisioning and rotation scripts only; password kept offline | — |

TLS: `connect()` passes `ssl: 'verify-full'` for every non-loopback host and
drops URL query parameters, so `sslmode=require` can no longer downgrade to an
unverified connection (OPS-14); configuration refuses `sslmode=disable` for a
remote host. Neon's pooler (PgBouncer, transaction mode) drops startup
parameters, so timeouts come from role defaults and from `tenant()`, which
sets `app.tenant_id` and `statement_timeout` in one `set_config` statement
(`DB_STATEMENT_TIMEOUT_MS`, default 10000). Pool size is `DB_POOL_MAX`
(default 20) until the load test chooses a value ([LOAD_TEST.md](LOAD_TEST.md)).

Deployed processes refuse credentials they must not hold
(`server/config-rules.ts`): web refuses `MIGRATION_DATABASE_URL`,
`BACKUP_DATABASE_URL`, `PROVISION_DATABASE_URL` and `STRIPE_SECRET_KEY`;
the worker refuses `DATABASE_URL`, `BACKUP_DATABASE_URL` and
`PROVISION_DATABASE_URL`. Tenant queries still require transaction-local
context; the runtime role has no DELETE anywhere.

## Environment mapping

`.env.example` lists placeholders only. Validate required variables by enabled capability; missing optional integrations must not prevent core POS startup.

| Variables | Treatment |
| --- | --- |
| `DATABASE_URL`, `PG_APP_USER`, `PG_APP_PASSWORD` | Retain names; explicit least-privilege runtime behavior |
| `MIGRATION_DATABASE_URL`, `TEST_DATABASE_URL`, `TEST_DATABASE_HOST_ALLOWLIST` | New: separate migration/test targets and fail-closed test checks |
| `APP_ENV`, `PROCESS_KIND`, `LOG_LEVEL` | New: environment (`staging`/`production` enable the deployed checks), process kind, log threshold |
| `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` | New: pool size, per-transaction timeout, graceful shutdown window and overlap (set in IaC) |
| `WORKER_URL`, `WORKER_PORT` | New: worker `/healthz` over private networking for `/api/ops/status`; local worker port |
| `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_KIND`, `SENTRY_DSN` | New: alert webhook (ntfy by default) and optional error tracking |
| `BILLING_DATABASE_URL` | Billing capability login; web (commands, webhook) and worker (provider loop) |
| `BACKUP_DATABASE_URL`, `PROVISION_DATABASE_URL` | Backup workflow and operator scripts only; refused by deployed services |
| `TRUST_PROXY` | Express trust proxy; unset means `loopback, 100.0.0.0/8` in production (Railway edge) |
| `JWT_SECRET` | Retain; generated per environment, rotated deliberately |
| `ADMIN_SECRET` | Legacy compatibility only; empty/disabled normally; no universal browser admin bypass |
| `APP_URL`, `PORT`, `NODE_ENV`, `RESTAURANT_TZ` | Retain; timezone is default, restaurant data takes precedence |
| `DEFAULT_TENANT_ID` | Development convenience only; reject production fallback |
| `VITE_API_BASE` | Public browser config, same-origin by default; reconcile other legacy `VITE_API_URL*` aliases |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Server-only Stripe credentials; the secret key lives only in the worker, the webhook secret in web; distinguish billing versus restaurant merchant scope |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Browser-safe publishable key, only if that payment surface needs it |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_FOUNDERS` | Compatibility candidates from POS Lite; map plans explicitly rather than assuming old prices |
| Luma `STRIPE_PRICE_MONTHLY`, `*_ANNUAL`, `*_POS_MONTHLY`, `*_PRO_*` | Map existing subscriptions/products during migration; not a second billing engine |
| `MP_*`, `GETNET_*`, `CLIP_*` | Preserve documented provider configuration where enabled; restaurant credentials remain tenant-scoped |
| `FACTURAPI_API_KEY`, `FACTURAPI_TEST_KEY` | Canonical invoicing variables; verify sandbox/live separation |
| `R2_*`, `FEATURE_MENU_PHOTOS`, `VITE_FEATURE_MENU_PHOTOS` | Preserve asset capability and server/client flags |
| `RESEND_API_KEY`, `ANTHROPIC_API_KEY` | Optional reports/email and reviewed import assistance |
| `TYPESAFE_API_KEY` | New: optional, server-only key for the TypeSafe judgment-assist modules in the feature matrix; never expose to the browser; unset disables them and keeps the manual flow |
| `TWILIO_*`, `WA_*`, `APPLE_PASS_*`, `GOOGLE_WALLET_*` | Optional modules; add documented fields when implementing each |
| Luma `NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY` | Remove from target runtime; authorized read-only migration access belongs to a separate import process |
| Luma `NEXT_PUBLIC_APP_URL` | Map to `APP_URL` and safe public configuration |
| `ENABLE_BACKGROUND_EMAIL`, `ENABLE_BACKGROUND_SMS` | Default off in development/test; enable for an explicit environment/recipient policy |
| `CREDENTIAL_ENCRYPTION_KEY` | New: server-only key for protected tenant integration secrets; rotation design required |

Store tenant-specific provider credentials encrypted with access audit. Never treat another restaurant's or the platform's fallback merchant as an automatic payment destination. Missing merchant configuration disables that tenant's integration. Never expose raw credential values back to settings pages.

## Scheduling, printing, and providers

Railway cron schedules use UTC and are for jobs that exit; they are unsuitable for continuous print/KDS loops. See [Railway scheduled jobs](https://docs.railway.com/cron-jobs). Background work uses the jobs outbox (`server/jobs.ts`): business code enqueues in its own tenant transaction, and the web process's runner claims per tenant with the runtime role (lease-fenced, retry with backoff, dead after 8 attempts, alert on dead). Handlers must be idempotent and must not hold a transaction across a network call. The runner keeps its tenant list in memory: after a restart or deploy a tenant's pending jobs and retries resume on its first authenticated request (a read is enough), and jobs enqueued by unauthenticated public ordering are claimed by the 30 s sweep or on that next request, so a handler must not assume a delivery deadline. Shutdown waits for running handlers within the drain window, then aborts them (`ctx.signal`) and the job is retried. Reconcile the source schedules rather than copying their offsets unquestioningly.

Printer bridge pairing needs short-lived setup credentials, a revocable device token, station routing, job acknowledgements, and an operator test-print step. The cloud web process must not try to access restaurant USB hardware. Do not carry over Luma's Supabase-dependent bridge directly.

Provider certification is explicit: official API contract, sandbox auth, amount/currency, idempotency, signed webhook, timeout recovery, partial/refund behavior, tenant merchant isolation, and actual device behavior if applicable. Document supported capabilities for each adapter. Clip's source guesses are not a contract. Preserve Conekta/OXXO/SPEI historical tender mapping, but do not infer current working charge support solely from legacy columns or README claims.

Current official documentation consulted for this handoff: Railway configuration/healthchecks/cron, Neon connection guidance, and W3C accessibility guidance. Dependency versions, provider contracts, tax requirements, and account-specific limits remain implementation-time verification tasks.
