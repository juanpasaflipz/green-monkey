# Verification record — in progress

Stripe setup, September 14: created a dedicated Green Monkey sandbox, saved
credentials in ignored mode-0600 files, and verified the account and both approved
prices through the real Stripe API. Catalog rerun recovered the same product and
prices. [Evidence](evidence/stripe-sandbox-catalog.json) contains only non-secret
IDs and price attributes. No customers, subscriptions, charges, webhook endpoint
or staging deployment were created in this setup.

Latest continuation: [subscription provider foundation](BILLING_IMPLEMENTATION.md)
adds sandbox-only billing requests and raw webhook verification. All 94 unit tests,
typecheck and lint passed; provider responses are synthetic. Durable billing
operations, webhook inbox/reconciliation, activation UI and real Stripe sandbox
verification remain pending. No staging migration or deployment was performed.

Green Monkey is a working development application with an isolated staging deployment, not a completed release. The full required scope remains tracked in [DELIVERY_STATUS.md](DELIVERY_STATUS.md).

Scenario-by-scenario gaps are listed in [ACCEPTANCE_STATUS.md](ACCEPTANCE_STATUS.md).

## Environment

- macOS Apple Silicon; Node 24.21.0; PostgreSQL 16 in a newly created localhost cluster on port 55439.
- Separate `green_monkey_dev` and `green_monkey_test` databases. No legacy database or production service accessed.
- Playwright Chromium 153.0.8010.12. Local loopback network, unthrottled. Fictional fixtures: two restaurants, 12 products per restaurant, kitchen/bar modifiers, raw/prepared stock.
- Source revisions and file hashes verified through `scripts/fetch_references.py`. No safely runnable source baseline was established; no percentage improvement or source task timing is claimed.

## Checks completed

- TypeScript frontend and server checks passed.
- ESLint passed after excluding generated Playwright report assets.
- Production build passed. Production mode is forced explicitly so `.env` cannot accidentally bundle development React or suppress service-worker registration.
- 14 domain tests passed.
- 17 isolated database integration checks passed, including tenant isolation, idempotency, concurrency, rollback, immutable tenders, and import reruns with no operational effects.
- Eleven browser scenarios passed together against the compiled server (12.6 seconds suite runtime, not operator task timings): cash checkout/modifier/KDS/receipt; additional rounds; partial-payment reload; cash refund; drawer close; inventory adjustment; owner drill-down; responsive layouts and keyboard search/dialog dismissal; offline full refresh/reconnect; QR authoritative pricing; grouped settlement; device PIN, CSRF, server permission and public scope checks.
- Screenshots captured at 1440×900, 1024×768, 768×1024 and 390×844. No page-wide horizontal overflow detected in those selling layouts.
- Automated axe checks on the tested selling state and mobile item-payment dialog report zero WCAG-tagged violations. This is not a complete screen-reader or all-screen accessibility certification.

The suite also covers creating and editing multi-ingredient recipes while retaining all links. Its initial locator failure was fixed using the control’s accessible role/name. Earlier failures uncovered and fixed: insufficient product-category contrast, stale workspace response races, an invalid refund row-lock permission requirement, development-mode bundling, and stale sync queue display.

## Setup and restore

- `npm ci --offline` clean install passed with the committed lockfile.
- `npm run setup:local` repeated successfully across both disposable local targets; migrations and fixtures were not duplicated.
- POS Lite and Luma normalized catalog fixtures passed CLI dry runs. This does not validate raw legacy database migrations.
- `bash scripts/rehearse-restore.sh` dumped the isolated test database and restored it into a new local database. Source/restored counts and financial/stock control totals matched: 5 orders, 4 tenders totaling 26000 minor units, zero refund amount, stock quantity control sum 2392, 3 source mappings, 2 migrations. These are fixture control totals, not business metrics.
- The restore script verifies the exact local cluster data directory and never reads `DATABASE_URL`. It leaves the backup and restored target in the ignored local work area. The pre-round-regression 11-check database integration suite also passed against the restored target, proving runtime grants/RLS and operational writes after restore. Staging restore and application rollback remain unverified.

## Build size

Latest production assets are split into application, React, validation and IndexedDB chunks. Total shipped JavaScript is approximately 465 kB uncompressed / 147 kB gzip; CSS approximately 22.6 kB / 5.7 kB gzip. These are build sizes, not network-performance or task-time measurements.

## Unrun / incomplete qualification

- All acceptance scenarios beyond the listed subsets, including 300-item/50-active-order pilot load, 10-user API p95, two-tab interrupted sync, catalog conflict reconciliation, integrated provider crash recovery, and real hardware.
- Whole-app manual accessibility and screen-reader review; KDS accessibility across every required viewport; payment screen-reader review.
- Historical source import mapping/reconciliation, staging restore and application rollback rehearsal.
- Provider sandboxes and physical printing. Initial Docker/Railway staging execution and Neon pooled/direct checks have now passed; broader cloud acceptance remains incomplete.
- No production deployment or cutover has been attempted.

The configured integrations stay disabled. Passing cash tests does not establish Stripe, Clip, FacturAPI, Resend, R2, printer, delivery, or subscription billing readiness.

## Continuation verification

- Per-unit item allocations: selecting one of three items, dropping the successful cash response, refreshing, recovering the same operation, then paying the remaining two units creates exactly two tenders. The remaining payment was confirmed at 390×844.
- Payment confirmation and amount stay in view at all four required sizes. Evidence: `split-items-1440.png`, `split-items-1024.png`, `split-items-768.png`, `split-items-390.png`; interrupted response evidence: `payment-recovery-1440.png`.
- Restaurant settings persist name/timezone/cutoff/opening days, block currency reinterpretation, reject stale versions and unauthorized edits. English settings evidence: `settings-en-1440.png`. New orders retain original restaurant snapshots; existing records were not backfilled with invented original settings.
- Table/server reassignment was tested through the browser and database. Creator, payments and kitchen round numbering remain intact; cross-tenant employee/table choices and stale edits are rejected.
- KDS progress locks the parent order before its round. Concurrent new-round/progress testing leaves the aggregate state active when an active round exists.
- A fresh backup/restore including five migrations matched control totals: 16 orders; 16 tenders totaling 104001 minor units; zero refunds; stock quantity control sum 2962; 6 source mappings; 12 allocation rows totaling 65000; 9 order configuration snapshots. Different tender/allocation totals are expected because earlier tenders remain explicitly unallocated. These are fixture controls, not business metrics. All 17 integration checks then passed on the restored target.
- Dependencies and lockfile did not change in this continuation; the earlier clean install remains applicable. Staging, provider hardware, full tax/promotions, organization switching and remaining requirements are not implied by these checks.

## Neon and Railway staging verification

See [STAGING.md](STAGING.md) for exact isolated targets, repeatable commands, generated access credentials location and evidence. All 17 integration checks passed on Neon test. Railway built and started the Docker image successfully. Live browser smoke passed login, required modifier, kitchen acknowledgement/readiness, cash payment, receipt, secure HttpOnly cookies, four viewport layouts and selling axe checks (zero violations). Source-only upload contained no environment files or reference snapshots. Production was not deployed.

## Local plan-gating checkpoint

Migration 006 adds read-only runtime entitlements with FORCE RLS. Eighteen unit tests, targeted local entitlement database checks, all seventeen existing database checks, eleven browser scenarios, typecheck, lint and build passed. The canonical order service denies new QR/kiosk orders on Free or expired Pro but recovers accepted requests with the original idempotency key. Details and unimplemented signup/billing/provider work are in [PLANS_AND_SIGNUP.md](PLANS_AND_SIGNUP.md). This checkpoint is local; staging remains on its previously verified deployment.

## Google authentication foundation checkpoint

Google staging client creation was verified in its dashboard and credentials saved
privately. The backend adapter and persistent one-time attempt store are implemented
but not mounted as login routes. Migration 007 was applied only to local dev/test.
All 36 unit tests, the isolated Google-attempt database checks (including eight-way
concurrency and process-restart replay), lint, typecheck and build passed. JOSE
6.2.12 is a new locked dependency. No Google end-to-end login, new browser acceptance,
Neon migration or staging deployment was performed in this checkpoint. Memberships,
tenant onboarding, Apple login and Stripe billing remain pending.

## Owner signup continuation (local only)

Mounted Google start/callback, credential-gated button, account identity/session,
explicit restaurant membership, Free restaurant signup/entry and logout are now
implemented. Migrations 008–010 were applied on local dev/test only. Signup
preserves issuer/subject identity and never merges equal emails. Owner revocation
invalidates linked POS sessions online. Four-way concurrent signup, cross-account
access rejection and revoked POS lineage passed targeted database tests. All 36
unit tests, 17 existing DB checks, 12 browser tests, lint, typecheck and build
passed. Signup keyboard and axe checks passed at all four required sizes; images
are `docs/evidence/owner-signup-*.png`. Local browser testing starts from a synthetic
verified identity and therefore does not establish real Google login. Google
staging smoke, Apple, Stripe, account linking and organization management remain
pending. No cloud migration or deployment occurred during this continuation.

## Approved pricing checkpoint (local only)

Pro pricing is MXN 799/month or MXN 7,990/year upfront per location, with
applicable taxes additional. Shared policy records the approved 14-day no-card
trial, kiosk inclusion, no employee surcharge and free beta until qualification.
The bilingual settings screen displays the offer; billing/trial activation remains
unavailable. A sandbox-only Stripe catalog command validates account, product,
currency, amounts, intervals and tax behavior, with stable idempotency keys and
rerun reconciliation. All 47 unit tests, typecheck, lint and build passed.
Stripe tests use synthetic responses, including a lost-response recovery case.
An actual provisioning attempt stopped with `stripe_sandbox_key_required` before
network access. No external Stripe catalog or subscription was created.
The targeted settings browser test also passed, verifying monthly/annual prices,
annual savings and employee-fee copy in Spanish, plus annual-billing copy in English.

## Marketing landing page (local only)

Implemented a bilingual responsive landing at `/`, with the application at `/app`.
Existing root OAuth callback query links remain supported; new callbacks use
`/app`. Product preview examples are explicitly fictional. Pricing uses the shared
approved offer, with a working monthly/annual selector and truthful beta/Pro
availability. Signup links open existing app access rather than simulate enrollment.

Typecheck, lint and production build passed. All twelve existing browser scenarios
passed after moving their login entry point to `/app`. The new landing browser
scenario passed after correcting two text contrast colors and a test selector.
Axe reported zero WCAG-tagged violations at 1440×900, 1024×768, 768×1024 and 390×844
in Spanish, and in the tested English state. Keyboard FAQ activation, pricing,
preview switching, locale persistence and app entry were verified. Screenshots:
`docs/evidence/landing-*.png`. Desktop and mobile full-page images were visually
reviewed. This is local evidence, not a full accessibility certification or cloud
deployment. No new provider integration, subscription or production change.
