# Green Monkey

Spanish-first restaurant POS built with React/TypeScript/Vite, Express/TypeScript and PostgreSQL. Neon is the target application database. Railway runs two services from one Docker image, declared in `.railway/railway.ts`: `web` (the compiled app, API and jobs runner) and `worker` (billing provider loop, watchdog alerts and the deploy-time migrations); see [infrastructure](docs/INFRASTRUCTURE.md).

**Status: working local development application; required scope is still incomplete. Not production-ready.** See [delivery status](docs/DELIVERY_STATUS.md) for every source capability, [verification](docs/RELEASE_REPORT.md), [acceptance coverage](docs/ACCEPTANCE_STATUS.md), and [operator guide](docs/OPERATIONS.md). Release and operations: [release process](docs/RELEASE.md) (CI, CD and migrations), [runbook](docs/RUNBOOK.md), [provisioning](docs/PROVISIONING.md), [backups and restore](docs/BACKUP_RESTORE.md) and [load test](docs/LOAD_TEST.md). These are written and locally rehearsed; none has run against staging or production yet. The pinned source applications were inspected, not run or modified.

## Local setup

Use Node 24.21.0 (pinned in `.nvmrc` and the Dockerfile) and PostgreSQL 16+ (CI qualifies on PostgreSQL 18). Dependencies are pinned in `package-lock.json`.

```sh
nvm use
npm ci
```

Create a **new isolated database** and separate migration/runtime roles. The runtime role cannot own tables, be superuser, or bypass RLS. Copy `.env.example` to `.env`, replacing placeholders with the new targets. Never reuse a legacy production URL.

```sh
npm run db:migrate
```

Apply reviewed runtime grants after migrations. `scripts/grants.sql` is the reviewed privilege manifest; `scripts/grant-runtime.ts` safely applies it to an explicit runtime role for Neon. Migrations use a checksum registry and an advisory lock, and run one transaction per file with a 5 s `lock_timeout` and retries; `npm run db:migrate -- --grants` commits the grants in the newest migration's transaction (deployed environments always do this). Rules and flags: [release process](docs/RELEASE.md#migrations).

For a reproducible disposable local Mac fixture, run `npm run setup:local` after `npm ci`. It initializes/migrates/seeds both isolated databases, applies grants, and creates `.env` only if absent. An existing `.env` is preserved.

The underlying `npm run db:local` creates a cluster under ignored `work/pgdata` on port **55439**, using Homebrew PostgreSQL 16. Set `PG_BIN` to override the executable location. `scripts/provision-local.sql` creates `green_monkey_dev`, `green_monkey_test`, and the fictional runtime role. These commands must only target that new local cluster.

After setting `MIGRATION_DATABASE_URL` to the local development target:

```sh
ALLOW_DEMO_SEED=green-monkey-local npm run db:seed
npm run dev
# another terminal
npm run dev:ui
```

Open **http://127.0.0.1:5173** for the marketing page, or **http://127.0.0.1:5173/app** for the POS/login. Fictional restaurant ID: `10000000-0000-4000-8000-000000000001`. Owner login: `owner` / `demo-green-monkey`. Employee PIN access after owner device pairing: `cashier` / `123456`; kitchen: `kitchen` / `654321`.

New in the continuation: per-item split payments with lost-response recovery, table/server reassignment, owner restaurant configuration, and immutable item allocations/configuration snapshots.

The seed is explicit, repeatable, and refuses non-local hosts. It is never run at boot. Seed prices/costs are fictional. Live tax configuration is not yet implemented.

## Build and checks

```sh
npm run lint
npm run typecheck
npm test
npm run test:db
npm run test:db:qualification
npm run build
npm run test:restart # isolated local dev fixture; starts its own server on 3003
npm run test:drain # compiled web and worker exit cleanly on SIGTERM; same fixture and port
NODE_ENV=production npm start
npm run start:worker # compiled worker; `npm run worker` runs it from source
```

`test:db` runs the 17 core operational scenarios. `test:db:qualification`
also runs the identity, owner management, entitlement, billing, Free-limit,
offline-recovery, item-void and ops (roles, migrations, jobs, backups,
provisioning) suites in a fixed order. `npm run test:db:recovery` runs the
recovery database slice directly. All database runners require both
`TEST_DATABASE_URL` and `TEST_MIGRATION_DATABASE_URL`; the runtime target must end
in `_test`, and both local or Neon endpoints must satisfy the exact allowlists
described below. Prepare that separate target with migrations, grants and
fictional fixtures first. The runners never fall back to `DATABASE_URL`.

Browser checks require a running server and Chromium:

```sh
npx playwright install chromium
npm run test:browser
# Full service-worker checks need the compiled same-origin server:
TEST_BASE_URL=http://127.0.0.1:3002 TEST_PRODUCTION=1 npm run test:browser
```

On this development machine, `bash scripts/compiled-local.sh` serves the compiled app on port 3002 and `bash scripts/browser-check.sh` runs the complete browser suite there. Service workers deliberately do not force-update active sessions.

Offline cash, manager reconciliation, recovery backups and uncertain-payment
behavior are documented in [offline recovery](docs/OFFLINE_RECOVERY.md). The current
slice is locally qualified; exact staging
qualification is still pending. See [the completion ledger](docs/COMPLETION_LEDGER.md).

## Imports

```sh
npm run import:dry-run -- tests/fixtures/pos-lite-catalog.json
npm run import:dry-run -- tests/fixtures/luma-catalog.json
```

The current adapter accepts **documented normalized catalog exports**, with explicit source and target restaurant IDs, source row IDs, category, decimal price, and availability. It is not a raw database backup loader. Unknown fields and duplicate source IDs are rejected; matching names never merge records. The settings screen previews and commits the same format. A commit rerun preserves mappings and creates no kitchen, payment, invoice, subscription or stock-consumption effects.

Historical transactions, summaries, recipes and identity migration remain pending and require approved exports/schema metadata. See [migration contract](docs/MIGRATION.md).

## Owner signup (local implementation)

Google owner signup now has a server authorization-code callback, persistent
one-time login attempts, issuer/subject identities, account sessions, and explicit
restaurant memberships. New accounts create one Free restaurant with an empty
catalog and configurable currency, timezone, business cutoff and opening days.
The signup form is available in Spanish and English. This does not activate a
Stripe trial or link an existing restaurant by matching email addresses.

The backend enables the Google button only when `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` are set. The redirect must have
the same origin as `APP_URL` and the path `/api/auth/google/callback`. Use separate
OAuth clients for local, staging and production; the saved staging client does
not authorize localhost. Secrets stay in the server environment. Apply migrations
through 020 and runtime grants before deploying this code.

`npm test` includes Google token/PKCE/replay tests. After local setup, targeted
database checks run with `npm run test:db:identity`; provide `TEST_DATABASE_URL`,
`TEST_MIGRATION_DATABASE_URL`, and exact `TEST_DATABASE_HOST_ALLOWLIST` through a
private environment. They accept isolated localhost `_test` targets or Neon test
targets with an additional exact `TEST_MIGRATION_DATABASE_HOST_ALLOWLIST`.
`bash scripts/browser-check.sh` includes responsive signup using a clearly labeled
verified-identity fixture. It does not automate or claim Google's external login.

Real Google signup, POS entry and returning login now pass on staging; see
[tenancy qualification](docs/TENANCY_QUALIFICATION.md).
Invitations and multiple locations are implemented and have prior staging proof;
Free device/team/location limits are implemented and tested. Deliberate account
linking, verified email recovery and Apple sign-in remain pending. See the latest
handoff and completion ledger rather than older dated staging checkpoints.

## Billing implementation in progress

Durable sandbox billing now has organization bindings, leased operations, signed
webhook reconciliation, saved signup trial preferences and owner controls. Real
Stripe trial, hosted Checkout payment and cancellation checks pass. See
[the current billing checkpoint](docs/BILLING_IMPLEMENTATION.md) for activation
requirements, evidence and remaining staging qualification. It is disabled by
default and cannot use live keys.

With `BILLING_SANDBOX_ENABLED=true`, the web server only records billing
requests; the Stripe provider loop runs in the worker. Locally, run
`npm run worker` (or `npm run start:worker` after a build) alongside
`npm run dev`, `npm start` or `scripts/compiled-local.sh`, or owner trial,
checkout, portal and location requests stay pending. The worker's health port
defaults to 3002, the same port `compiled-local.sh` uses, so set `WORKER_PORT`
to a free port when running both.

## Approved launch pricing

Free remains free. Pro is MXN 799 monthly or MXN 7,990 annually, paid upfront,
per restaurant location, before applicable taxes. Annual billing saves MXN 1,598.
Kiosk is included in Pro, with no per-employee fee. The approved trial is 14 days,
without a card, starting at restaurant creation. Beta pilots remain free until
the promised Pro workflows qualify. Trial and subscription provisioning are implemented and verified in the dedicated
sandbox. Owner billing controls are enabled only for the configured sandbox.

To prepare only the Stripe sandbox product and two recurring prices, configure
`STRIPE_SECRET_KEY` with a sandbox key and `STRIPE_EXPECTED_ACCOUNT_ID` with the
explicit sandbox account, in a private environment, then run:

```sh
npm run stripe:catalog:sandbox
```

The command rejects live keys and mismatched accounts/prices, reconciles existing
objects on rerun, and saves price IDs to ignored `.env.stripe-price-ids`. It never
creates customers, subscriptions or charges. The dedicated Green Monkey sandbox
is configured privately in `.env.stripe-sandbox`; actual catalog provisioning and
rerun verification passed. Run it with
`node --env-file=.env.stripe-sandbox --import tsx scripts/stripe-sandbox-catalog.ts`.
Subscription flows and webhook verification passed in the dedicated sandbox. See
[billing implementation](docs/BILLING_IMPLEMENTATION.md) and
[plan policy](docs/PLANS_AND_SIGNUP.md).

## Layout

- `shared/`: validation, money, pricing, units, business time, finance and import preview.
- `server/`: authentication, explicit tenant transactions, canonical order/payment/stock commands, cash/refunds, management and public ordering.
- `src/`: reusable UI, selling, operational/management workspaces, bilingual copy, IndexedDB recovery.
- `migrations/`: complete baseline and subsequent versioned migrations.
- `scripts/ops/`, `scripts/load/`, `.github/`, `.railway/`: provisioning, rotation, backups and restore rehearsal, load test, CI/CD workflows and Railway infrastructure as code.
- `tests/`: domain, isolated DB, and Playwright scenarios.
- `work/reference-sources/`: ignored hash-verified source snapshots, never part of the deploy image.

No Supabase or Vercel runtime dependency is used. R2, Resend, Stripe, FacturAPI and other configured integrations are **not enabled or verified**. Cash POS does not require those credentials. The [isolated staging deployment](docs/STAGING.md) is running on Railway with Neon; a live cash/KDS/receipt smoke passed. Full release qualification remains incomplete; live cutover requires specific approval and reconciled migration.

## Marketing landing page

The public root `/` serves a Spanish-first, English-switchable landing page.
`/app` opens the existing application; Google callbacks now return to `/app`,
while old root callback links remain compatible. QR and kiosk routes are unchanged.
The landing page includes illustrative (fictional) product previews, Free/Pro
pricing from the shared approved policy, a monthly/annual toggle, availability
explanations and keyboard-operable FAQs. Pro billing is labeled upcoming.
All app links open the actual access screen; there is no simulated signup,
lead collection, invented testimonial or active trial promise.

Run `bash scripts/browser-check.sh landing.spec.ts` against the compiled local
server to check responsive layouts, accessibility, language persistence, pricing
interaction and entry into the app. Source: `src/marketing/`.
