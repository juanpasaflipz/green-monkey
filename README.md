# Green Monkey

Spanish-first restaurant POS built with React/TypeScript/Vite, Express/TypeScript and PostgreSQL. Neon is the target application database. Railway runs two services from one Docker image, declared in `.railway/railway.ts`: `web` (the compiled app, API and the web jobs runner, on the runtime role and the signing keys) and `worker` (the jobs runner for worker-only kinds on its own jobs login, the billing provider loop and watchdog alerts). Neither holds the schema-owner credential: migrations, grants and the daily retention pass run in GitHub Actions as `gm_migrator`; see [infrastructure](docs/INFRASTRUCTURE.md) and [release process](docs/RELEASE.md).

**Status (October 8, 2026): the v1 pilot release is on its way to `main`; staging is cut over; production is not launched.** Staging was cut over on October 6–7, 2026 and deploys `main` through GitHub Actions (migrations as `gm_migrator`, then Railway, then a smoke that is green; [staging](docs/STAGING.md)). Production is launched by the business owner, not by the team. The full required scope of the source matrix is still incomplete: see [delivery status](docs/DELIVERY_STATUS.md) for every capability and its evidence level, [verification](docs/RELEASE_REPORT.md) and [acceptance coverage](docs/ACCEPTANCE_STATUS.md). The pinned source applications were inspected, not run or modified.

Pilot, launch and operations:

- [Pilot operating guide](docs/PILOT_SOP.md) (in Spanish): printers, tablets, pairing, selling without a connection, whom to call.
- [Launch hand-off](docs/LAUNCH_HANDOFF.md): what only the business owner can supply (accounts, credentials, legal identity, signatures), what staging already did, and the production launch sequence in order.
- [Runbook](docs/RUNBOOK.md): signals and alerts, "the POS is down", rollback, client address, credential rotation, the staging cutover, DB-9 validation, open follow-ups.
- [Release process](docs/RELEASE.md): CI, the restaurant-day gate, CD to staging and the gated production dispatch, migrations, retention.
- Restaurant-day go-live gate: two fictional business days through the UI on a production-mode web and worker, then a DB reconciliation ([acceptance status](docs/ACCEPTANCE_STATUS.md), "Restaurant-day go-live gate"; workflow `.github/workflows/restaurant-day.yml`). It passes locally; its required checks are applied once the release reaches `main`, and two consecutive green CI runs are pending. Local run: "Build and checks" below.
- [Provisioning](docs/PROVISIONING.md), [backups and restore](docs/BACKUP_RESTORE.md), [load test](docs/LOAD_TEST.md) and the [operator guide](docs/OPERATIONS.md). The staging backup and restore drill and the load test have not run yet.

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

For a reproducible disposable local Mac fixture, run `npm run setup:local` after `npm ci`. It initializes/migrates/seeds both isolated databases, creates the capability roles (`scripts/ops/sql/globals.sql`) and the local jobs login `gm_worker`, applies grants, and creates `.env` only if absent, with `WORKER_DATABASE_URL` and a local `SIGNING_KEYS` entry. An existing `.env` is preserved; add those two variables (see `.env.example`) by hand.

The underlying `npm run db:local` creates a cluster under ignored `work/pgdata` on port **55439**, using Homebrew PostgreSQL 16. Set `PG_BIN` to override the executable location. `scripts/provision-local.sql` creates `green_monkey_dev`, `green_monkey_test`, and the fictional runtime role. These commands must only target that new local cluster.

After setting `MIGRATION_DATABASE_URL` to the local development target:

```sh
ALLOW_DEMO_SEED=green-monkey-local npm run db:seed
npm run dev
# another terminal
npm run dev:ui
```

Open **http://127.0.0.1:5173** for the marketing page, or **http://127.0.0.1:5173/app** for the POS/login. The demo owner form ("Acceso de demostración") appears only when `.env` sets `DEMO_TENANT_ID=10000000-0000-4000-8000-000000000001` (the fictional restaurant; `npm run setup:local` writes it, and the server refuses to start with it in production). Owner login: `owner` / `demo-green-monkey`; that pairs the browser as a terminal. Pair any other browser with a code from **Configuración → Dispositivos**. On a paired browser, staff tap their name and enter their PIN: `cashier` / `123456`; kitchen: `kitchen` / `654321`. Pairing, PIN lockout, step-up, the lock screen and staff/device management: [access](docs/ACCESS.md).

Menus, choices, combos, open-price items, areas and tables, and ingredient stock with a per-restaurant negative-stock policy are described in [Menu, tables and ingredients](docs/MENU.md).

Front-of-house service (orders and tables lists, check lifecycle with **Liberar mesa**, kitchen display, kitchen and order notes, receipts and browser printing on 80/58 mm) is described in [Service](docs/SERVICE.md).

Discounts and courtesies by line or for the whole check (reason codes, per-role limits, one manager PIN for staff over their limit), refunds by item or by amount for cash and external-terminal payments with a kitchen cancellation and optional restock, and drawer controls (cash and terminal apart, blind counts, closer attribution and manager review of differences) are described in [Discounts, refunds and drawer controls](docs/DISCOUNTS.md).

Reporting (migration 029) buckets every figure by stored or versioned business dates: sales, IVA from fiscal tickets, collections by cash and terminal, breakdowns, loss-prevention exceptions, a paged activity log, cortes X/Z/del día on 58/80 mm or letter/A4, and CSV exports. Hoy and Finanzas read fiscal (027) and discounts (028); cortes, kitchen cancellation chits and report sheets print through the browser/OS print path (checked in Chromium print emulation, not yet on a physical printer). See [Reports](docs/REPORTS.md).

New in the continuation: per-item split payments with lost-response recovery, table/server reassignment, owner restaurant configuration, and immutable item allocations/configuration snapshots.

The seed is explicit, repeatable, and refuses non-local hosts. It is never run at boot. Seed prices/costs are fictional. Prices are tax-inclusive (Mexico): each product has a tax category (IVA 16%, IVA 8% in a registered border region, IVA 0% or exempt), every order line keeps an immutable tax snapshot, and every settled sale gets a ticket with a consecutive folio and the issuer's RFC, régimen and place of issue, from the owner's fiscal profile. CFDI invoicing through Facturapi is built (cfdi 030, rehearsal fixes 036; [CFDI](docs/CFDI.md)); IEPS is out of scope. See [docs/FISCAL.md](docs/FISCAL.md).

## Build and checks

```sh
npm run lint
npm run typecheck
npm test
npm run test:db
npm run test:db:qualification
npm run build
npm run test:restart # isolated local dev fixture; starts its own server on 3003
npm run test:access-http # access checks against the compiled server; same fixture and port
npm run test:account-http # account checks (public-ordering switch, account-config, exports); same fixture and port
npm run test:drain # compiled web and worker exit cleanly on SIGTERM; same fixture and port
NODE_ENV=production npm start
npm run start:worker # compiled worker; `npm run worker` runs it from source
```

`test:db` runs the 17 core operational scenarios. `test:db:qualification`
also runs the identity, owner management, entitlement, billing, Free-limit,
offline-recovery, item-void, ops (roles, migrations, jobs, backups,
provisioning), access (`npm run test:db:access`: pairing codes, PIN
throttling, sessions, step-up, staff and devices), service
(`npm run test:db:service`: check lifecycle, kitchen feed, notes, print audit),
menu (`npm run test:db:menu`: catalog, floor, stock ledger and policy),
offline (`npm run test:db:offline`: sync, reconcile, archive, review lane),
account (`npm run test:db:account`: legal acceptance, co-owners, transfers,
recovery, export, 031 RLS) and support (`npm run test:db:support`: the
vendor support CLI as `gm_support`) suites in a fixed order.
`npm run test:db:recovery` runs the recovery database slice directly. All database runners require both
`TEST_DATABASE_URL` and `TEST_MIGRATION_DATABASE_URL`; the runtime target must end
in `_test`, and both local or Neon endpoints must satisfy the exact allowlists
described below. Prepare that separate target with migrations, grants and
fictional fixtures first. The runners never fall back to `DATABASE_URL`.

Browser checks require a running server and Chromium. The server under test
needs `DEMO_TENANT_ID=10000000-0000-4000-8000-000000000001`,
`ACCESS_STEP_UP_SECONDS=1800` and `ACCESS_IDLE_LOCK_DEFAULT_SECONDS=0` (the
suites sign in through the demo form and fast-forward the clock past the
default auto-lock); `scripts/compiled-local.sh` sets them:

The legal, account, landing and owner browser suites expect published legal
documents: start the server with the fictional CI set, as `qualification.yml`
does on its browser step. `scripts/compiled-local.sh` sources
`tests/fixtures/legal-ci.sh` (the `LEGAL_*` and `SUPPORT_*` literals of
`tests/fixtures/legal-ci.ts` plus `LEGAL_UNPUBLISHED_SIGNUP=allow`); for any
other compiled server, run `. tests/fixtures/legal-ci.sh` in the shell that
starts it. `.env.example` lists the same values as commented, test-only lines.
The DB suites pass their own legal configuration, so the set in `.env` cannot
change them. Never use those values outside tests.

```sh
npx playwright install chromium
npm run test:browser
# Full service-worker checks need the compiled same-origin server:
TEST_BASE_URL=http://127.0.0.1:3002 TEST_PRODUCTION=1 npm run test:browser
```

On this development machine, `bash scripts/compiled-local.sh` serves the compiled app on port 3002 and `bash scripts/browser-check.sh` runs the complete browser suite there. Service workers deliberately do not force-update active sessions.

The restaurant-day go-live gate (two full business days through the UI on a
production-mode web and worker, then a DB reconciliation) is a separate run that
needs no server and no `.env`: export `RD_LEGAL_ENTITY_NAME`,
`RD_LEGAL_ENTITY_ADDRESS`, `RD_LEGAL_PRIVACY_CONTACT_EMAIL`,
`RD_LEGAL_JURISDICTION`, `RD_SUPPORT_EMAIL`, `RD_SUPPORT_PHONE` and
`RD_SUPPORT_HOURS` (values production publishes, never the CI literals), point
`RD_PG_PORT` at the local fixture cluster and run `npm run test:acceptance:day`.
It resets only the disposable `green_monkey_acceptance_dev`; the regular browser
suite ignores its spec. See [acceptance status](docs/ACCEPTANCE_STATUS.md) and
[release](docs/RELEASE.md).

Offline selling (connection pill and manual offline mode, cash or external-terminal
sales with provisional numbers, on-device kitchen tickets, the KDS review lane,
exactly-once sync with manager reconcile and archive, service-worker updates),
recovery backups and uncertain-payment behavior are documented in
[offline recovery](docs/OFFLINE_RECOVERY.md). Offline table service (open checks,
rounds and partial payments offline) is a per-restaurant Beta setting, off by
default. The current slice is locally qualified; exact staging
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
The signup form is available in Spanish and English. Next to the Google button
the page shows the simplified privacy notice, and the restaurant is created only
after the owner accepts the Terms and the data processing agreement and
acknowledges the privacy notice (recorded in `legal_acceptances`; see
[account and legal](docs/ACCOUNT_AND_LEGAL.md)). While the legal documents are
unpublished, new accounts get `signup_paused` unless `LEGAL_UNPUBLISHED_SIGNUP=allow`
(never honored with `APP_ENV=production`). This does not activate a
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
Free device/team/location limits are implemented and tested. Co-owners,
ownership transfer and recovery codes (migration 031) are implemented locally
and not yet staging-qualified. Deliberate account linking, verified email
recovery and Apple sign-in remain pending. See the latest
handoff and completion ledger rather than older dated staging checkpoints.

## Legal configuration (privacy notice, terms, DPA)

The platform's privacy notice (`/legal/privacidad`), terms (`/legal/terminos`)
and data processing agreement (`/legal/encargo-de-datos`) are versioned code in
`shared/legal.ts`; the legal entity comes only from web environment variables
(`LEGAL_ENTITY_NAME`, `LEGAL_ENTITY_ADDRESS`, `LEGAL_PRIVACY_CONTACT_EMAIL`,
`LEGAL_JURISDICTION`, optional `LEGAL_ENTITY_RFC` and
`LEGAL_PRIVACY_CONTACT_NAME`) and support channels from `SUPPORT_*`. Missing,
malformed or placeholder values (and, with `NODE_ENV=production`, test/demo
words) keep the documents **unpublished**: the pages show a draft banner and
`noindex`, startup logs `legal_documents_unpublished`, and new signups are
paused. `GET /api/account-config` reports the state. The text is a draft
pending counsel review and no deployed environment has the real values yet.
Checklist, versioning and material-change procedure:
[account and legal](docs/ACCOUNT_AND_LEGAL.md).

## Support CLI

Vendor support acts only through `npm run support -- <command>` from an
operator workstation with `SUPPORT_DATABASE_URL` (a `gm_support` member login
created by `npm run support:provision`). Never set that URL on Railway or
GitHub; the web refuses to start with it. Every command needs an operator name,
a ticket and a reason, is logged in `support_actions` and is visible to the
restaurant's owners. Pilot Pro grants (≤ 90 days, renewable), unlocks,
support-assisted transfers and emergency Free device reassignment are
described in [operations](docs/OPERATIONS.md) (Support).

## Owner data export

Owners download every restaurant record as JSON or one table as CSV from
Configuración › Privacidad y datos (also on Free). Shared terminals ask for the
owner's PIN first; secrets, credentials and CFDI binaries are excluded. Format
and limits: [account and legal](docs/ACCOUNT_AND_LEGAL.md).

## SaaS tax mode

`SAAS_TAX_MODE=off` (default) leaves Stripe requests unchanged and the UI says
prices are before taxes and the subscription IVA/CFDI is not configured.
`SAAS_TAX_MODE=tax_rate` (sandbox only for now) makes the worker add a Stripe
IVA 16 % Tax Rate (`STRIPE_TAX_RATE_ID`, created with
`npm run stripe:tax-rate:sandbox`) to trials, Checkout and location quotes, and
collects the customer's tax ID. SaaS CFDI is not built. See
[billing implementation](docs/BILLING_IMPLEMENTATION.md).

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
checkout, portal and location requests stay pending. The worker runs its jobs
runner only when `WORKER_DATABASE_URL` is set (local login `gm_worker`,
written by `setup:local`); without it `/healthz` reports `jobs: false` and
worker-only jobs (cfdi, from 030) stay queued. `npm run ops:retention` runs
`migrate.ts --retention-only`, the same retention-only mode as the daily
GitHub workflow. The worker's health port
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

No Supabase or Vercel runtime dependency is used. R2, Resend, Stripe and other configured integrations are **not enabled or verified**. CFDI: built on fiscal, discounts and reports, contract-tested against Facturapi's documented API (fixtures `docs@1c2e617`) and tested end to end against the Facturapi fake; its shared-sandbox flows passed a local rehearsal against the real Facturapi sandbox on 2026-10-07, and staging runs the shared sandbox with a test key; the per-restaurant `organizations` provider and live mode are not enabled ([CFDI](docs/CFDI.md)). Cash POS does not require those credentials. The [isolated staging deployment](docs/STAGING.md) runs on Railway with Neon and deploys from `main` through GitHub Actions since the October 6–7 cutover. Full release qualification remains incomplete; live cutover requires the owner's decision ([launch hand-off](docs/LAUNCH_HANDOFF.md)) and reconciled migration.

## Marketing landing page

The public root `/` serves a Spanish-first, English-switchable landing page.
`/app` opens the existing application; Google callbacks now return to `/app`,
while old root callback links remain compatible. QR and kiosk ordering (`/qr#…`,
`/kiosk#…`, Pro) uses revocable codes and **held** orders that reach the kitchen
only when staff accept them (or charge them first); there is no online card
payment ([public ordering](docs/PUBLIC_ORDERING.md)).
The landing page includes illustrative (fictional) product previews, Free/Pro
pricing from the shared approved policy, a monthly/annual toggle, availability
explanations and keyboard-operable FAQs. Pro billing is labeled upcoming.
All app links open the actual access screen; there is no simulated signup,
lead collection, invented testimonial or active trial promise.

Run `bash scripts/browser-check.sh landing.spec.ts` against the compiled local
server to check responsive layouts, accessibility, language persistence, pricing
interaction and entry into the app. Source: `src/marketing/`.
