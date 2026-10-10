# Infrastructure and configuration contract

The requirement is to keep the same provider setup—Neon, Railway, and the useful existing integrations—while creating a separate application. No live Neon/Railway settings or credentials were fetched during this handoff. This document describes source configuration and a proposed new contract.

## Source versus target

| Concern | Inspected source | Green Monkey target |
| --- | --- | --- |
| Application DB | POS Lite: Neon/postgres.js; Luma: Supabase | Neon PostgreSQL only |
| Runtime | POS Lite Dockerfile: Node 20; Express serves `dist` and `dist-kiosk` | Node 24.21.0 (`.nvmrc`, Dockerfile), TypeScript server build; `web` service (API + web jobs runner) and `worker` service (worker-only jobs runner, billing provider loop, watchdog); migrations, grants and retention run in GitHub Actions |
| Railway config | `NIXPACKS`, `npm run build`, `node server/index.js`, retry count 5 | `.railway/railway.ts` infrastructure as code: Dockerfile build, readiness checks, draining; no preDeploy (the GitHub Actions deploy job migrates before uploading) |
| Luma scheduling | `0 15 * * 1` weekly; `0 8 1 * *` monthly in Vercel config | Railway scheduled jobs with deliberate restaurant timezone semantics |
| DB auth | Owner connection plus app_user role and PG_APP_* credentials | Runtime app role; separately configured migration/provisioning privileges |
| Assets | POS Lite R2 with local-disk fallback | R2 in production; local storage only for disposable development |
| Reports/email | Luma PDF generation and Resend | Durable report jobs and optional Resend delivery |
| Billing | Both Stripe implementations and differing price variables | One subscription model with explicit price-ID mapping |
| Fiscal integration | POS Lite `FACTURAPI_API_KEY`; Luma `FACTURAPI_KEY` | Canonical POS Lite variable, temporary import compatibility only if needed |

## Deployment blueprint

Railway project `green-monkey`, two services built from the root
`Dockerfile` (multi-stage, Node 24.21.0, `npm ci` from the lockfile, compiled
frontend/server, migrations, `scripts/grants.sql`, `scripts/db/post-migrate.sql`
and the stamped `build-info.json`). Both start through
`node --import ./build/server/instrument.js`, which loads and validates the
configuration before any application module (`server/config.ts`).

`railway.json` is gone: Railway stops reading config-as-code files on
2026-12-01. `.railway/railway.ts` (TypeScript IaC, `railway/iac`) declares:

| Service | Start | Health | Notes |
| --- | --- | --- | --- |
| `web` | `build/server/index.js` | `/api/health` (300 s) | Runtime role only (plus the billing login when billing is enabled) and the signing keys (`SIGNING_KEYS`, `JWT_SECRET`). `replicas: 1` because rate limits are in memory. `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=20`, `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=10`. |
| `worker` | `build/server/worker.js` | `/healthz` (300 s) | No public domain and no `preDeploy`. It runs the jobs runner for worker-only kinds on the jobs login (`WORKER_DATABASE_URL`, `gm_<env>_worker`, a member of `gm_jobs_worker`) and reports its `commit`, `jobs: true` and a `jobs` loop that must tick within 120 s on `/healthz`; a deployed worker without `WORKER_DATABASE_URL` refuses to start (`missing_worker_database_url`), and `/api/ops/status` counts a worker without jobs as degraded. The CD smoke waits until the worker reports the deployed commit with `jobs: true`. Holds the Stripe secret key and, from cfdi (030), the Facturapi keys and `CREDENTIAL_ENCRYPTION_KEY`; never the schema-owner credential or a signing key. `DB_STATEMENT_TIMEOUT_MS=30000`, draining 30 s. |

Migrations, the runtime grants and retention run as the non-superuser
`gm_migrator` from GitHub Actions, never in a Railway service: the deploy job
runs `node build/scripts/migrate.js --grants --retention` before any Railway
change, and `.github/workflows/retention.yml` runs a daily retention pass
inside 04:00–07:00 America/Mexico_City (each batch waits at most 200 ms for its
lock and runs each statement at most 1.5 s; `retention_failed` alert on
failure; [RUNBOOK.md](RUNBOOK.md) "Retention").

Every variable that holds a secret is `preserve()`d: IaC never writes secret
values; `scripts/ops/railway-vars.sh` sets them from a private file via stdin.
Railway plans any variable the file does not declare for a service as a
deletion, so every variable the code reads is declared (a literal or
`preserve()`) in `.railway/railway.ts`. Wave 2.0 registered every wave-2
variable; areas never edit the file, and a missing name goes to the lead
(contract C-10). The staging cutover inventories the live variables before
the first apply ([RUNBOOK.md](RUNBOOK.md) "Staging cutover").
CD (`.github/workflows/deploy.yml`, through `.github/actions/deploy`) runs `railway config apply --yes` without
`--confirm-destructive`, so a plan that would delete a service or variable
stops for review. Domains are deliberately not in IaC. Settings IaC cannot
express are manual and listed in [RUNBOOK.md](RUNBOOK.md): restart policy
(On Failure), region, custom domain, serverless sleep (off), deploy webhook.

Client address (LD-46): Railway's edge connects to `web` from
100.64.0.0/10, discards the client's own `X-Forwarded-For` and `X-Real-IP`,
and sends `X-Forwarded-For: <client>, <edge hop>` and `X-Real-IP: <client>`
(verified on staging on 2026-10-07 with a temporary header-echo service).
With the default `trust proxy` Express's `req.ip` is the edge hop, shared by
every client behind it, so `clientIp(req)` (`server/logging.ts`) returns
`X-Real-IP` when the immediate peer is trusted and the header is one valid
address, else `req.ip`. Every per-IP limit and log `ipHash` keys on it, and
every `rateLimit()` has an explicit `keyGenerator` through it.
`/api/ops/diagnostics/ip` reports `{ ip, peerTrusted, source }` and the CD
smoke requires `peerTrusted: true` and `source: "x-real-ip"` on a deployed
origin ([RUNBOOK.md](RUNBOOK.md) "Client address").

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
| `gm_<env>_billing` (`BILLING_DATABASE_URL`) | pooled | web (owner billing commands, webhook; only while billing is enabled, refused by production web otherwise: open DB-1 follow-up in [RUNBOOK.md](RUNBOOK.md)), worker (provider loop); member of `gm_billing_worker` | 30 s / 8 s / 60 s |
| `gm_<env>_worker` (`WORKER_DATABASE_URL`) | pooled | worker only (jobs runner for worker-only kinds); member of `gm_jobs_worker` and nothing more privileged (`checkWorkerRole`); claims, completes and enqueues jobs inside `tenant()` and discovers tenants through area `SELECT` policies | 30 s / 8 s / 60 s |
| `gm_migrator` (`MIGRATION_DATABASE_URL`) | direct | GitHub Actions (environment secret): the deploy job (migrate, grants, retention) and the daily retention workflow; no Railway service holds it. Manual uses, from a private 0600 file on the operator's workstation (as for a manual retention purge, [RUNBOOK.md](RUNBOOK.md) "Retention"): that purge, and support's hold redaction for an ARCO request ([PUBLIC_ORDERING.md](PUBLIC_ORDERING.md), "Redacting a hold (ARCO)"). Owns the schema; no superuser, BYPASSRLS or CREATEROLE, so FORCE RLS applies to it (backfills use the owner pattern, [RELEASE.md](RELEASE.md)) | `lock_timeout` 5 s, `statement_timeout` 10 min |
| `gm_<env>_backup` (`BACKUP_DATABASE_URL`) | direct | GitHub backup workflow; member of `gm_backup_reader` (reads through `ops_backup_read` policies) | no timeouts |
| `neondb_owner` | direct | provisioning and rotation scripts; manually, the DB-9 check and repair before the first deploy carrying 032/033 ([RUNBOOK.md](RUNBOOK.md), "DB-9 validation"); password kept offline | — |
| `gm_support_<name>` (`SUPPORT_DATABASE_URL`) | direct | operator workstation only (account's support CLI, 031); member of `gm_support`; both runtime processes refuse it | account's |

Capability roles (NOLOGIN), created only by `scripts/ops/sql/globals.sql`,
never by a migration: `gm_billing_worker` and `gm_backup_reader` (built),
`gm_jobs_worker` (Wave 2.0: `jobs` grants in `scripts/grants.sql`, discovery
policies in area migrations) and `gm_support` (grants and policies in 031).
No runtime or worker login may hold another capability role or `gm_migrator`
/ `neon_superuser` membership (`checkRole`, `checkWorkerRole`,
`assertRuntimeRole`; one list in `server/roles.ts`).

TLS: `connect()` passes `ssl: 'verify-full'` for every non-loopback host and
drops URL query parameters, so `sslmode=require` can no longer downgrade to an
unverified connection (OPS-14); configuration refuses `sslmode=disable` for a
remote host. Neon's pooler (PgBouncer, transaction mode) drops startup
parameters, so timeouts come from role defaults and from `tenant()`, which
sets `app.tenant_id` and `statement_timeout` in one `set_config` statement
(`DB_STATEMENT_TIMEOUT_MS`, default 10000). Pool size is `DB_POOL_MAX`
(default 20) until the load test chooses a value ([LOAD_TEST.md](LOAD_TEST.md)).

Deployed processes refuse credentials they must not hold
(`server/config-rules.ts`, when `APP_ENV` is `staging` or `production`): web
refuses `MIGRATION_DATABASE_URL`, `BACKUP_DATABASE_URL`,
`PROVISION_DATABASE_URL`, `STRIPE_SECRET_KEY`, `WORKER_DATABASE_URL`,
`SUPPORT_DATABASE_URL`, `FACTURAPI_API_KEY`, `FACTURAPI_TEST_KEY`,
`CREDENTIAL_ENCRYPTION_KEY` and `CFDI_LIVE_ENABLED`; the worker refuses
`DATABASE_URL`, `BACKUP_DATABASE_URL`, `PROVISION_DATABASE_URL`,
`MIGRATION_DATABASE_URL`, `SUPPORT_DATABASE_URL`, `SIGNING_KEYS` and
`JWT_SECRET`. Tenant queries still require transaction-local
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
| `TRUST_PROXY` | Express trust proxy; unset means `loopback, 100.0.0.0/8` in production (Railway edge). The client address is the trusted edge's `X-Real-IP`, not `req.ip` (`clientIp`, LD-46; "Deployment blueprint" above) |
| `JWT_SECRET` | Retain, `web` only; verifies pre-2.0 tokens outside production and keys the lookup digests; generated per environment, rotated only with an emergency key rotation ([RUNBOOK.md](RUNBOOK.md) "Signing keys") |
| `SIGNING_KEYS` | New (Wave 2.0, OPS-10): `web` only, `kid:base64url(>=32 bytes)[,…]`, first entry signs; required when `APP_ENV=production`; a deployed worker refuses it |
| `WORKER_DATABASE_URL` | New (Wave 2.0): jobs login of the `worker` only; a deployed web refuses it |
| `FISCAL_TICKETS_ENABLED`, `CFDI_INVOICE_LINK_EXPIRY_HOURS`, `LEGAL_*`, `SUPPORT_EMAIL`/`_PHONE`/`_WHATSAPP`/`_URL`/`_HOURS`/`_HOURS_EN`, `SAAS_TAX_PROFILE_ENABLED`, `PUBLIC_ORDERING_ENABLED` | Registered by Wave 2.0 on `web` (`preserve()`) for fiscal, cfdi and account; each area validates its own values |
| `SAAS_TAX_MODE`, `SAAS_COLLECT_TAX_ID` | Registered on both services (account) |
| `STRIPE_TAX_RATE_ID`, `CFDI_LIVE_ENABLED`, `CFDI_GLOBAL_GRACE_MINUTES` | Registered on `worker` only (account, cfdi) |
| `ACCESS_STEP_UP_SECONDS`, `ACCESS_IDLE_LOCK_DEFAULT_SECONDS` | New (access): step-up window (30..1800 s, default 120) and default terminal auto-lock (default 180 s); `preserve()` on `web` ([ACCESS.md](ACCESS.md) "Configuration") |
| `DEMO_TENANT_ID` | New (access): fictional demo tenant for local and staging only; declared on staging's `web` only, and the server refuses to start with it when `RAILWAY_ENVIRONMENT_NAME` or `APP_ENV` is `production` |
| `ADMIN_SECRET` | Legacy compatibility only; empty/disabled normally; no universal browser admin bypass |
| `APP_URL`, `PORT`, `NODE_ENV`, `RESTAURANT_TZ` | Retain; timezone is default, restaurant data takes precedence |
| `DEFAULT_TENANT_ID` | Development convenience only; reject production fallback |
| `VITE_API_BASE` | Public browser config, same-origin by default; reconcile other legacy `VITE_API_URL*` aliases |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Server-only Stripe credentials; the secret key lives only in the worker, the webhook secret in web; distinguish billing versus restaurant merchant scope |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Browser-safe publishable key, only if that payment surface needs it |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_FOUNDERS` | Compatibility candidates from POS Lite; map plans explicitly rather than assuming old prices |
| Luma `STRIPE_PRICE_MONTHLY`, `*_ANNUAL`, `*_POS_MONTHLY`, `*_PRO_*` | Map existing subscriptions/products during migration; not a second billing engine |
| `MP_*`, `GETNET_*`, `CLIP_*` | Preserve documented provider configuration where enabled; restaurant credentials remain tenant-scoped |
| `FACTURAPI_API_KEY`, `FACTURAPI_TEST_KEY` | Canonical invoicing variables, `worker` only (a deployed web refuses them). `FACTURAPI_API_KEY` is the platform's Facturapi **User key** (`sk_user_…`): one organization per restaurant, each with its own test and live keys. `FACTURAPI_TEST_KEY` (`sk_test_…`) alone gives the shared sandbox for staging/dev rehearsal and the opt-in sandbox check; refused alone in production ([CFDI](CFDI.md) "Environment matrix") |
| `CREDENTIAL_ENCRYPTION_KEY` | `worker` only, required with `FACTURAPI_API_KEY`: `kid:base64url(>=32 bytes)[,…]`, first entry seals the organization keys and derives the CSD upload key pair; generate with `scripts/cfdi-generate-credential-key.mjs`, rotate by prepending a kid, redeploying and running `npm run cfdi:rekey` |
| `CFDI_LIVE_ENABLED` | `worker` only: `true` only with `APP_ENV=production` and a User key; publishes live availability (each restaurant still switches with step-up) |
| `PAYMENTS_PROVIDERS` | `worker` only (payments 037 P2): `mercadopago`, `clip` or both; empty or unset = integrated charging off (manual terminals keep working). Declared in `railway.ts` as the literal `mercadopago,clip` on every environment but production, undeclared in production until the real-device rehearsal passes (LD-85; switching on is a reviewed `railway.ts` change). Needs `CREDENTIAL_ENCRYPTION_KEY` |
| `KIOSK_SELF_CHECKOUT_ENABLED` | `web` (kiosk 039): unset or `true` on, `false` off (kiosks take counter orders only; settlement continues). Anything else refuses to start (`kiosk_flag_invalid`). `railway.ts`: `preserve()` on staging, `"false"` in production until the field checks and the R44a rehearsal (RUNBOOK "Kiosk self-checkout and menu photos") |
| `MENU_PHOTOS_ENABLED` | `web` (kiosk 039): unset or `true` on, `false` hides photos everywhere and stops uploads (the media route answers 404). Invalid: `media_flag_invalid`. `railway.ts`: as `KIOSK_SELF_CHECKOUT_ENABLED` |
| `MEDIA_STORE` | `web` only (kiosk 039, critic R36): `r2` (production and staging) or `fs` (development and CI; refused in staging and production while photos are on). Unset: no photo can be stored (uploads answer `media_store_not_configured`) and the menus show text tiles; never a local directory. `railway.ts`: `preserve()` in both environments, never a literal |
| `MEDIA_FS_ROOT` | `web`, with `MEDIA_STORE=fs`: a writable directory for the object files. Development and CI only: never declared in `railway.ts` (a Railway disk does not survive a deploy) |
| `MEDIA_R2_ACCOUNT_ID`, `MEDIA_R2_BUCKET`, `MEDIA_R2_ACCESS_KEY_ID`, `MEDIA_R2_SECRET_ACCESS_KEY` | `web` only, with `MEDIA_STORE=r2`: a private R2 bucket for menu photos (separate from the backup bucket) and a **bucket-scoped Object Read & Write token that does not expire** (LD-66's backup token expires; do not repeat that). Forbidden on the worker (`forbiddenCredentials.worker`). `railway.ts`: `preserve()` on web in both environments. Rotation: RUNBOOK "Menu photos store" |
| `MERCADOPAGO_API_URL`, `CLIP_API_URL` | development/test only, loopback host only (the payments fake); refused in staging and production; never declared in Railway |
| `CFDI_GLOBAL_GRACE_MINUTES` | `worker` only: minutes after a period closes before its global invoice is built (0–600, default 60) |
| `CFDI_INVOICE_LINK_EXPIRY_HOURS` | `web`: lifetime of the self-invoicing portal's request links (1–168 h, default 72) |
| `FACTURAPI_BASE_URL` | development/test only, loopback host only (the Facturapi fake, `npm run dev:facturapi-fake`); refused in staging and production; not registered in Railway |
| `R2_*`, `FEATURE_MENU_PHOTOS`, `VITE_FEATURE_MENU_PHOTOS` | Preserve asset capability and server/client flags |
| `RESEND_API_KEY`, `ANTHROPIC_API_KEY` | Optional reports/email and reviewed import assistance |
| `TYPESAFE_API_KEY` | New: optional, server-only key for the TypeSafe judgment-assist modules in the feature matrix; never expose to the browser; unset disables them and keeps the manual flow |
| `TWILIO_*`, `WA_*`, `APPLE_PASS_*`, `GOOGLE_WALLET_*` | Optional modules; add documented fields when implementing each |
| Luma `NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY` | Remove from target runtime; authorized read-only migration access belongs to a separate import process |
| Luma `NEXT_PUBLIC_APP_URL` | Map to `APP_URL` and safe public configuration |
| `ENABLE_BACKGROUND_EMAIL`, `ENABLE_BACKGROUND_SMS` | Default off in development/test; enable for an explicit environment/recipient policy |
| `CREDENTIAL_ENCRYPTION_KEY` | New: `worker`-only key for protected tenant integration secrets (a deployed web refuses it); rotation design required |

Store tenant-specific provider credentials encrypted with access audit. Never treat another restaurant's or the platform's fallback merchant as an automatic payment destination. Missing merchant configuration disables that tenant's integration. Never expose raw credential values back to settings pages.

## Scheduling, printing, and providers

Railway cron schedules use UTC and are for jobs that exit; they are unsuitable for continuous print/KDS loops. See [Railway scheduled jobs](https://docs.railway.com/cron-jobs). Background work uses the jobs outbox (`server/jobs.ts`): business code enqueues in its own tenant transaction, and the web process's runner claims per tenant with the runtime role (lease-fenced, retry with backoff, dead after the kind's `maxAttempts`, default 8, alert on dead). Worker-only kinds (cfdi, 030) run in the worker on its jobs login, which discovers due tenants every 5 s ([ARCHITECTURE.md](ARCHITECTURE.md) "Offline, jobs, and operational recovery"). Handlers must be idempotent and must not hold a transaction across a network call. The runner keeps its tenant list in memory: after a restart or deploy a tenant's pending jobs and retries resume on its first authenticated request (a read is enough), and jobs enqueued by unauthenticated public ordering are claimed by the 30 s sweep or on that next request, so a handler must not assume a delivery deadline. Shutdown waits for running handlers within the drain window, then aborts them (`ctx.signal`) and the job is retried. Reconcile the source schedules rather than copying their offsets unquestioningly.

Printer bridge pairing needs short-lived setup credentials, a revocable device token, station routing, job acknowledgements, and an operator test-print step. The cloud web process must not try to access restaurant USB hardware. Do not carry over Luma's Supabase-dependent bridge directly.

Provider certification is explicit: official API contract, sandbox auth, amount/currency, idempotency, signed webhook, timeout recovery, partial/refund behavior, tenant merchant isolation, and actual device behavior if applicable. Document supported capabilities for each adapter. Clip's source guesses are not a contract. Preserve Conekta/OXXO/SPEI historical tender mapping, but do not infer current working charge support solely from legacy columns or README claims.

Current official documentation consulted for this handoff: Railway configuration/healthchecks/cron, Neon connection guidance, and W3C accessibility guidance. Dependency versions, provider contracts, tax requirements, and account-specific limits remain implementation-time verification tasks.
