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
keep-alive pool of at most 6 sockets. It pairs as a terminal with its own
single-use pairing code (`POST /api/access/pair`), then signs its staff member
in by PIN (`POST /api/access/pin`), like a real register or KDS; owner-password
pairing is reserved for the demo tenant (docs/ACCESS.md). Browsers pair one at
a time, because the pair route allows 10 requests per IP per minute and counts
each while it is in flight. Pairing and PIN sign-in are setup, so they are
left out of the mutation p95. `KDS_POLL_MS` overrides the poll interval to
compare kitchen-feed designs.

## Running

```sh
# Seed LOAD-NN restaurants (refuses databases not named *_test, *_load or
# *_staging and APP_ENV=production; credentials and one pairing code per
# simulated browser go to work/load/fixture.json). JWT_SECRET must be the
# target server's (codes are HMACs under it). Codes expire after 10 minutes:
# start load:run within that, or seed again (re-seeding cancels unused codes).
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

## Not in the profile yet: public ordering (PUBLIC-OPS-7)

Since public ordering's B4 (QR and kiosk on for every Pro restaurant), a
restaurant with an active code adds steady traffic the profile does not
model:

| Who | Request | Interval |
| --- | --- | --- |
| Every operator device | `GET /api/ordering/inbox/summary` | 20 s while a code is active or orders wait, else 5 min |
| A device on Órdenes | `GET /api/ordering/inbox` | 10 s while busy, else 60 s |
| Each diner page or kiosk | `GET /api/public/revision` | 1 min (jittered) |
| Each diner with an order | `GET /api/public/status` | 5 s for 2 min, then 15 s; 20 s after acceptance |
| Diners | `POST /api/public/orders`, `/status/cancel` | per order |

The staging `target`/`stress` run that sizes `DB_POOL_MAX` must include these
polls and a diner submit/status mix for restaurants with codes before
go-live (RELEASE item 5; RUNBOOK "Open follow-ups"). Until then the p95 below
does not cover them.

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
