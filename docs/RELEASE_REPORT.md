# Verification record — in progress

Green Monkey is a working local development application, not a completed release. The full required scope remains tracked in [DELIVERY_STATUS.md](DELIVERY_STATUS.md).

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
- 11 domain tests passed.
- 12 isolated database integration checks passed, including tenant isolation, idempotency, concurrency, rollback, immutable tenders, and import reruns with no operational effects.
- Nine browser scenarios passed together against the compiled server (17.5 seconds suite runtime, not operator task timings): cash checkout/modifier/KDS/receipt; additional rounds; partial-payment reload; cash refund; drawer close; inventory adjustment; owner drill-down; responsive layouts and keyboard search/dialog dismissal; offline full refresh/reconnect; QR authoritative pricing; grouped settlement; device PIN, CSRF, server permission and public scope checks.
- Screenshots captured at 1440×900, 1024×768, 768×1024 and 390×844. No page-wide horizontal overflow detected in those selling layouts.
- Automated axe check on the tested selling state reports zero WCAG-tagged violations. This is not a complete screen-reader or all-screen accessibility certification.

The suite also covers creating and editing multi-ingredient recipes while retaining all links. Its initial locator failure was fixed using the control’s accessible role/name. Earlier failures uncovered and fixed: insufficient product-category contrast, stale workspace response races, an invalid refund row-lock permission requirement, development-mode bundling, and stale sync queue display.

## Setup and restore

- `npm ci --offline` clean install passed with the committed lockfile.
- `npm run setup:local` repeated successfully across both disposable local targets; migrations and fixtures were not duplicated.
- POS Lite and Luma normalized catalog fixtures passed CLI dry runs. This does not validate raw legacy database migrations.
- `bash scripts/rehearse-restore.sh` dumped the isolated test database and restored it into a new local database. Source/restored counts and financial/stock control totals matched: 5 orders, 4 tenders totaling 26000 minor units, zero refund amount, stock quantity control sum 2392, 3 source mappings, 2 migrations. These are fixture control totals, not business metrics.
- The restore script verifies the exact local cluster data directory and never reads `DATABASE_URL`. It leaves the backup and restored target in the ignored local work area. The pre-round-regression 11-check database integration suite also passed against the restored target, proving runtime grants/RLS and operational writes after restore. Staging restore and application rollback remain unverified.

## Build size

Latest production assets are split into application, React, validation and IndexedDB chunks. Total shipped JavaScript is approximately 455 kB uncompressed / 143 kB gzip; CSS approximately 22 kB / 5.6 kB gzip. These are build sizes, not network-performance or task-time measurements.

## Unrun / incomplete qualification

- All acceptance scenarios beyond the listed subsets, including 300-item/50-active-order pilot load, 10-user API p95, two-tab interrupted sync, catalog conflict reconciliation, item settlement UI, provider crash recovery, and real hardware.
- Whole-app manual accessibility and screen-reader review; KDS and payment accessibility across every required viewport.
- Historical source import mapping/reconciliation, staging restore and application rollback rehearsal.
- Docker image execution, Neon pooled/direct validation, Railway staging smoke, provider sandboxes, and physical printing.
- No production deployment or cutover has been attempted.

The configured integrations stay disabled. Passing cash tests does not establish Stripe, Clip, FacturAPI, Resend, R2, printer, delivery, or subscription billing readiness.
