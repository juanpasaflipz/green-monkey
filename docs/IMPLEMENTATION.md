# Execution record

2026-09-12: repository cloned; all specifications read. Both pinned snapshots fetched and verified against reference/SOURCES.json. Reviewed POS Lite syncEngine and stockLedger, and Luma pos/projections services. No legacy runtime, secrets, seed or deployment executed. Implementation is fresh; no source code copied.

## Checklist
- [x] Read specifications and verify source snapshots
- [ ] Foundation, domain model, tenant database, shared UI
- [x] Persisted order→kitchen→cash vertical slice and browser proof
- [ ] Complete operational scope (combos, promotions, protected discounts, item refunds and service reassignment remain pending)
- [ ] Recovery, offline, split/grouped payment, QR/kiosk
- [ ] Inventory, owner reporting, safe imports
- [ ] Management and configured extensions
- [ ] Release qualification and evidence

Required scope remains pending until implementation and tests are recorded. No provider or deployment is verified yet.

## Decisions
- Modular monolith, one package with shared TypeScript modules; no unnecessary workspace tooling.
- Node 24 LTS (official nodejs.org release table checked); stable dependencies resolved from npm, lockfile committed with implementation.
- A fresh local PostgreSQL development/test cluster is an isolated verification environment; Neon remains the production database contract.
- No tax rate assumed. Live tax configuration/calculation is not wired into checkout yet; the fictional fixture is unsuitable as a live tax setup.
- Stock consumed once at dispatch. Preparation converts raw inputs to prepared items; sale recipes consume prepared stock without consuming raw inputs again.
- Source screens were not run: comparable UX timings are unavailable.

## Implemented and verified milestones

- Fresh React/TypeScript UI and Express/TypeScript API; semantic tokens, shared fields/dialogs/buttons, responsive cart, Spanish/English interface.
- Complete baseline migrations, runtime role checks and RLS; separate local development/test targets; repeatable seed/setup.
- Canonical orders, rounds, cash/external terminal recording, amount splits/grouped settlement, cash refunds and drawer closing.
- Dexie drafts and offline cash, bounded session eligibility, same-ID atomic sync and full-refresh recovery.
- Stable stock links, recipe versions/cost snapshots, preparation, counts/waste, purchasing, source drill-down and normalized catalog imports.
- Team creation, shifts/payroll estimates, public QR/kiosk ordering and narrow receipts.
- Checks/evidence and remaining requirements are recorded in RELEASE_REPORT.md and DELIVERY_STATUS.md. This checklist does not mark an entire phase done based on a subset.
