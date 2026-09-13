# Green Monkey

Spanish-first restaurant POS built with React/TypeScript/Vite, Express/TypeScript and PostgreSQL. Neon is the target application database; Railway serves the compiled web app and API from one service.

**Status: working local development application; required scope is still incomplete. Not production-ready.** See [delivery status](docs/DELIVERY_STATUS.md) for every source capability, [verification](docs/RELEASE_REPORT.md), [acceptance coverage](docs/ACCEPTANCE_STATUS.md), and [operator guide](docs/OPERATIONS.md). The pinned source applications were inspected, not run or modified.

## Local setup

Use Node 24 LTS and PostgreSQL 16+. Dependencies are pinned in `package-lock.json`.

```sh
nvm use
npm ci
```

Create a **new isolated database** and separate migration/runtime roles. The runtime role cannot own tables, be superuser, or bypass RLS. Copy `.env.example` to `.env`, replacing placeholders with the new targets. Never reuse a legacy production URL.

```sh
npm run db:migrate
```

Apply reviewed runtime grants after migrations. `scripts/grants.sql` is the reviewed privilege manifest; `scripts/grant-runtime.ts` safely applies it to an explicit runtime role for Neon. Migrations use a checksum registry and advisory transaction lock.

For a reproducible disposable local Mac fixture, run `npm run setup:local` after `npm ci`. It initializes/migrates/seeds both isolated databases, applies grants, and creates `.env` only if absent. An existing `.env` is preserved.

The underlying `npm run db:local` creates a cluster under ignored `work/pgdata` on port **55439**, using Homebrew PostgreSQL 16. Set `PG_BIN` to override the executable location. `scripts/provision-local.sql` creates `green_monkey_dev`, `green_monkey_test`, and the fictional runtime role. These commands must only target that new local cluster.

After setting `MIGRATION_DATABASE_URL` to the local development target:

```sh
ALLOW_DEMO_SEED=green-monkey-local npm run db:seed
npm run dev
# another terminal
npm run dev:ui
```

Open **http://127.0.0.1:5173**. Fictional restaurant ID: `10000000-0000-4000-8000-000000000001`. Owner login: `owner` / `demo-green-monkey`. Employee PIN access after owner device pairing: `cashier` / `123456`; kitchen: `kitchen` / `654321`.

New in the continuation: per-item split payments with lost-response recovery, table/server reassignment, owner restaurant configuration, and immutable item allocations/configuration snapshots.

The seed is explicit, repeatable, and refuses non-local hosts. It is never run at boot. Seed prices/costs are fictional. Live tax configuration is not yet implemented.

## Build and checks

```sh
npm run lint
npm run typecheck
npm test
npm run test:db
npm run build
NODE_ENV=production npm start
```

`test:db` refuses targets unless the database name ends in `_test` and the exact `host:port/database` appears in `TEST_DATABASE_HOST_ALLOWLIST`. Prepare that separate target with migrations, grants, and fictional fixtures first. It never falls back to `DATABASE_URL`.

Browser checks require a running server and Chromium:

```sh
npx playwright install chromium
npm run test:browser
# Full service-worker checks need the compiled same-origin server:
TEST_BASE_URL=http://127.0.0.1:3002 TEST_PRODUCTION=1 npm run test:browser
```

On this development machine, `bash scripts/compiled-local.sh` serves the compiled app on port 3002 and `bash scripts/browser-check.sh` runs the complete browser suite there. Service workers deliberately do not force-update active sessions.

## Imports

```sh
npm run import:dry-run -- tests/fixtures/pos-lite-catalog.json
npm run import:dry-run -- tests/fixtures/luma-catalog.json
```

The current adapter accepts **documented normalized catalog exports**, with explicit source and target restaurant IDs, source row IDs, category, decimal price, and availability. It is not a raw database backup loader. Unknown fields and duplicate source IDs are rejected; matching names never merge records. The settings screen previews and commits the same format. A commit rerun preserves mappings and creates no kitchen, payment, invoice, subscription or stock-consumption effects.

Historical transactions, summaries, recipes and identity migration remain pending and require approved exports/schema metadata. See [migration contract](docs/MIGRATION.md).

## Layout

- `shared/`: validation, money, pricing, units, business time, finance and import preview.
- `server/`: authentication, explicit tenant transactions, canonical order/payment/stock commands, cash/refunds, management and public ordering.
- `src/`: reusable UI, selling, operational/management workspaces, bilingual copy, IndexedDB recovery.
- `migrations/`: complete baseline and subsequent versioned migrations.
- `tests/`: domain, isolated DB, and Playwright scenarios.
- `work/reference-sources/`: ignored hash-verified source snapshots, never part of the deploy image.

No Supabase or Vercel runtime dependency is used. R2, Resend, Stripe, FacturAPI and other configured integrations are **not enabled or verified**. Cash POS does not require those credentials. The [isolated staging deployment](docs/STAGING.md) is running on Railway with Neon; a live cash/KDS/receipt smoke passed. Full release qualification remains incomplete; live cutover requires specific approval and reconciled migration.
