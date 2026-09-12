# Infrastructure and configuration contract

The requirement is to keep the same provider setup—Neon, Railway, and the useful existing integrations—while creating a separate application. No live Neon/Railway settings or credentials were fetched during this handoff. This document describes source configuration and a proposed new contract.

## Source versus target

| Concern | Inspected source | Green Monkey target |
| --- | --- | --- |
| Application DB | POS Lite: Neon/postgres.js; Luma: Supabase | Neon PostgreSQL only |
| Runtime | POS Lite Dockerfile: Node 20; Express serves `dist` and `dist-kiosk` | Supported Node LTS, TypeScript server build, one web service |
| Railway config | `NIXPACKS`, `npm run build`, `node server/index.js`, retry count 5 | Explicit Dockerfile build, migration pre-deploy command, readiness check |
| Luma scheduling | `0 15 * * 1` weekly; `0 8 1 * *` monthly in Vercel config | Railway scheduled jobs with deliberate restaurant timezone semantics |
| DB auth | Owner connection plus app_user role and PG_APP_* credentials | Runtime app role; separately configured migration/provisioning privileges |
| Assets | POS Lite R2 with local-disk fallback | R2 in production; local storage only for disposable development |
| Reports/email | Luma PDF generation and Resend | Durable report jobs and optional Resend delivery |
| Billing | Both Stripe implementations and differing price variables | One subscription model with explicit price-ID mapping |
| Fiscal integration | POS Lite `FACTURAPI_API_KEY`; Luma `FACTURAPI_KEY` | Canonical POS Lite variable, temporary import compatibility only if needed |

## Deployment blueprint

Create a new Railway project/service associated with `juanpasaflipz/green-monkey`. Do not reuse existing service IDs, domains, custom host bindings, or source repo integrations implicitly. Use a separate Neon development/test branch or project and a deliberate production target when cutover is authorized.

Use a reproducible multi-stage Dockerfile. The image contains compiled frontend/server, runtime dependencies, migration runner/files, and version metadata. Lock dependency versions. Bind to `0.0.0.0` and Railway's `PORT`. Preserve `RAILWAY_GIT_COMMIT_SHA` in the build stamp and expose a safe `/api/version`. Implement SIGTERM draining and database shutdown.

A target configuration, to create **only after these scripts exist**, is:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "preDeployCommand": ["npm run db:migrate"],
    "startCommand": "npm start",
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 120,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5
  }
}
```

Railway documents Dockerfile selection, pre-deploy commands, and these config fields in its [configuration reference](https://docs.railway.com/config-as-code/reference). The new root repository intentionally has no active `railway.json` yet, because no application/build scripts exist.

`/health` can be process liveness; `/api/health` should check DB connectivity and required schema readiness with a bounded query. Do not expose configuration values. Railway deployment health checks expect an HTTP success response; separately implement ongoing service monitoring. See [Railway health checks](https://docs.railway.com/deployments/healthchecks).

Run versioned, forward-compatible migrations under an advisory lock in the pre-deploy phase. Never execute destructive demo seeds at server boot. Use expand/contract migrations so old and new app revisions can coexist during rollout. Application rollback is not a database rollback; document both and rehearse restore/reconciliation.

## Neon connections

Keep application and migration/provisioning credentials distinct. Proposed default: `DATABASE_URL` is an app-role runtime connection; `MIGRATION_DATABASE_URL` is a direct privileged connection available only to migration/provisioning execution. If Railway makes the latter available to the web container, the web code must neither instantiate it nor log it; prefer a separately scoped migration job/service when feasible.

`PG_APP_USER` and `PG_APP_PASSWORD` retain a documented compatibility path for the legacy configuration shape. They must not silently create an owner-credential fallback or derive a new endpoint by string replacement. Validate role/host/database at startup and document which values the resolver uses. Tenant queries still require transaction-local context.

Use a bounded postgres.js pool, connection/query timeouts, and explicit SSL settings appropriate to the Neon connection string. Validate both pooled application access and direct migration access in staging. Do not reuse source pool sizes blindly; size for measured concurrency and account limits. Neon explains pooled endpoint naming and connection behavior in its [connection pooling support recap](https://neon.com/blog/postgres-support-case-recap) and documents direct connections for session-dependent operations in its [connection guidance update](https://neon.com/docs/changelog/2025-01-24). Recheck current docs before implementation.

## Environment mapping

`.env.example` lists placeholders only. Validate required variables by enabled capability; missing optional integrations must not prevent core POS startup.

| Variables | Treatment |
| --- | --- |
| `DATABASE_URL`, `PG_APP_USER`, `PG_APP_PASSWORD` | Retain names; explicit least-privilege runtime behavior |
| `MIGRATION_DATABASE_URL`, `TEST_DATABASE_URL`, `TEST_DATABASE_HOST_ALLOWLIST` | New: separate migration/test targets and fail-closed test checks |
| `JWT_SECRET` | Retain; generated per environment, rotated deliberately |
| `ADMIN_SECRET` | Legacy compatibility only; empty/disabled normally; no universal browser admin bypass |
| `APP_URL`, `PORT`, `NODE_ENV`, `RESTAURANT_TZ` | Retain; timezone is default, restaurant data takes precedence |
| `DEFAULT_TENANT_ID` | Development convenience only; reject production fallback |
| `VITE_API_BASE` | Public browser config, same-origin by default; reconcile other legacy `VITE_API_URL*` aliases |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Server-only Stripe credentials; distinguish billing versus restaurant merchant scope |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Browser-safe publishable key, only if that payment surface needs it |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_FOUNDERS` | Compatibility candidates from POS Lite; map plans explicitly rather than assuming old prices |
| Luma `STRIPE_PRICE_MONTHLY`, `*_ANNUAL`, `*_POS_MONTHLY`, `*_PRO_*` | Map existing subscriptions/products during migration; not a second billing engine |
| `MP_*`, `GETNET_*`, `CLIP_*` | Preserve documented provider configuration where enabled; restaurant credentials remain tenant-scoped |
| `FACTURAPI_API_KEY`, `FACTURAPI_TEST_KEY` | Canonical invoicing variables; verify sandbox/live separation |
| `R2_*`, `FEATURE_MENU_PHOTOS`, `VITE_FEATURE_MENU_PHOTOS` | Preserve asset capability and server/client flags |
| `RESEND_API_KEY`, `ANTHROPIC_API_KEY` | Optional reports/email and reviewed import assistance |
| `TWILIO_*`, `WA_*`, `APPLE_PASS_*`, `GOOGLE_WALLET_*` | Optional modules; add documented fields when implementing each |
| Luma `NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY` | Remove from target runtime; authorized read-only migration access belongs to a separate import process |
| Luma `NEXT_PUBLIC_APP_URL` | Map to `APP_URL` and safe public configuration |
| `ENABLE_BACKGROUND_EMAIL`, `ENABLE_BACKGROUND_SMS` | Default off in development/test; enable for an explicit environment/recipient policy |
| `CREDENTIAL_ENCRYPTION_KEY` | New: server-only key for protected tenant integration secrets; rotation design required |

Store tenant-specific provider credentials encrypted with access audit. Never treat another restaurant's or the platform's fallback merchant as an automatic payment destination. Missing merchant configuration disables that tenant's integration. Never expose raw credential values back to settings pages.

## Scheduling, printing, and providers

Railway cron schedules use UTC and are for jobs that exit; they are unsuitable for continuous print/KDS loops. See [Railway scheduled jobs](https://docs.railway.com/cron-jobs). Use scheduled runs to enqueue due reports based on each restaurant's calendar and a unique period key; a worker handles generation/delivery with retry. Reconcile the source schedules rather than copying their offsets unquestioningly.

Printer bridge pairing needs short-lived setup credentials, a revocable device token, station routing, job acknowledgements, and an operator test-print step. The cloud web process must not try to access restaurant USB hardware. Do not carry over Luma's Supabase-dependent bridge directly.

Provider certification is explicit: official API contract, sandbox auth, amount/currency, idempotency, signed webhook, timeout recovery, partial/refund behavior, tenant merchant isolation, and actual device behavior if applicable. Document supported capabilities for each adapter. Clip's source guesses are not a contract. Preserve Conekta/OXXO/SPEI historical tender mapping, but do not infer current working charge support solely from legacy columns or README claims.

Current official documentation consulted for this handoff: Railway configuration/healthchecks/cron, Neon connection guidance, and W3C accessibility guidance. Dependency versions, provider contracts, tax requirements, and account-specific limits remain implementation-time verification tasks.
