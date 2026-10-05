# Load test

Repeatable capacity test for the target of 30 restaurants × 800 orders a day,
each with two kitchen display screens (GAP-4). Scripts: `scripts/load/`.

## Profiles (`scripts/load/profile.ts`)

| Profile | Restaurants | Orders/day each | Peak share | KDS screens | KDS poll | Duration |
| --- | --- | --- | --- | --- | --- | --- |
| `smoke` (CI) | 3 | 10,000 (≈ 25/min in the peak) | 15% | 2 | 1.5 s | 60 s |
| `target` | 30 | 800 | 15% | 2 | 1.5 s | 15 min (2 min ramp) |
| `stress` | 30 | 2,400 | 15% | 2 | 1.5 s | 15 min (2 min ramp) |

Per restaurant the runner simulates a cashier terminal (orders arrive as a
Poisson process: 1–4 lines with valid modifiers, 40% extra round, payment cash
or card with reference, 10% split in two), two KDS screens polling `/kitchen`
and advancing rounds seen → ready → completed, and a tables view polling
`/orders` every 10 s. Each simulated browser has its own cookies and a
keep-alive pool of at most 6 sockets. `KDS_POLL_MS` overrides the poll
interval to compare kitchen-feed designs.

## Running

```sh
# Seed LOAD-NN restaurants (refuses databases not named *_test, *_load or
# *_staging and APP_ENV=production; credentials go to work/load/fixture.json).
LOAD_MIGRATION_DATABASE_URL=… LOAD_TARGET_ALLOWLIST=<host:port/db> LOAD_PROFILE=target npm run load:seed
# Drive the API (exact origin allowlist).
LOAD_BASE_URL=https://<staging> LOAD_ORIGIN_ALLOWLIST=https://<staging> LOAD_PROFILE=target npm run load:run
```

Results go to `docs/evidence/load/<date>-<host>-<profile>.json` and `.md`
(`LOAD_EVIDENCE_DIR` overrides). The run fails (exit 1) unless:

| Measure | Threshold (docs/ACCEPTANCE.md) |
| --- | --- |
| Reads p95 | ≤ 400 ms |
| Mutations p95 | ≤ 700 ms |
| KDS appearance p95 (round accepted → first poll that shows it) | ≤ 2,000 ms |
| Error rate | < 0.1% |
| 5xx other than 503 with `Retry-After` | 0 |

## Pool sizing procedure

Run `target` and `stress` on staging with `DB_POOL_MAX` ∈ {8, 20, 40} (Railway
variable on `web`, then redeploy). Choose the smallest value that meets every
threshold at `stress`, set it in `.railway/railway.ts` and record the evidence
below. The default stays 20 until then.

## Results

| Date | Target | Profile | `DB_POOL_MAX` | Reads p95 | Mutations p95 | KDS p95 | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-05 | local compiled server, PostgreSQL 16 (laptop) | smoke | 20 | 18 ms | 24 ms | 1,381 ms | 0 | 64 orders in 60 s; harness check only, not a capacity result |
| — | staging (Neon pooled) | target / stress | 8 / 20 / 40 | pending | pending | pending | pending | requires the staging cutover |
