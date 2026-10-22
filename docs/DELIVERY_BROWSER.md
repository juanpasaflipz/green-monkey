# Delivery report connections

Local implementation, 2026-10-22. Not deployed or qualified for production.

Release preparation: reconciled onto main 3a47b2f in an isolated worktree.
Migration 043 avoids the deployed delivery-history migration 041. Automatic
connection translations have their own namespace, preserving historical imports.
Railway declares worker-only Browserbase configuration. Production credentials
were checked for presence only and configured; `DELIVERY_BROWSER_ENABLED=0`
was verified. No credential values were printed.

The reconciled branch passed typecheck, lint, build, 1,750 unit tests, the
synthetic browser flow, and seven database scenarios on a fresh PostgreSQL 16
cluster migrated as the non-superuser gm_migrator. CI supplies PostgreSQL 18
qualification. Production dependency audit reports zero vulnerabilities.

Independent Claude Code review of Codex-authored code cleared an initial
**disabled deployment only**. Activation remains blocked on closed-day scope,
late adjustments, durable download checkpoints, stable store identity and a
merchant rehearsal. The review's follow-up calls itself Claude-on-Claude, but
the implementation author is Codex; both reviews were read-only Claude sessions.

Live Browserbase checks proved project/key authentication, isolated context and
session creation, a live-view URL, and GET-session returning a reconnect URL.
Session release succeeds; immediate context deletion returns 400 during provider
persistence, while a later deletion returns 204. The worker retains the context
reference and retries rather than claiming deletion succeeded. No merchant login
or report data was used in these checks. These are provider lifecycle checks,
not validation of unattended merchant imports.

Disabled workers leave delivery jobs queued. Re-enabling resumes them, including
disconnect jobs. A staff Cancel while disabled awaits a delivery worker after
re-enabling. Do not use the flag as a substitute for revoking stored contexts.

## Subscriber experience

Settings contains Uber Eats, Rappi and DiDi Food cards. An owner accepts the
versioned report-access consent, opens a private hosted sign-in window, signs in
on the delivery platform (including any MFA), returns to confirm the store, and
then sees daily platform totals. There is no manual file upload or daily fetch
button. Owners can disconnect; managers can view results. Connections are separate
for each restaurant and platform. Platform-imposed reauthentication still requires
the owner; indefinite unattended access cannot be promised.

The implemented adapter is **Uber Eats, English-language Manager, MXN**. Rappi
and DiDi cards remain unavailable until their adapters are built and tested.
The earlier interactive local pilot retrieved all three reports; that does not
qualify unattended SaaS operation.

## Runtime

Migration 043 adds tenant-scoped connections, worker-only Browserbase context
references, and daily financial snapshots. The web service enqueues durable jobs;
the existing dedicated worker discovers them even with no user online. A fresh
worker heartbeat controls whether Connect is available. Pro and owner checks run
server-side; each connection mutation requires recent authentication.

A connection has a generation number, and browser operations have a separate
short lease. Each transaction validates the exact job lease. Disconnect increments
the generation immediately, hides live-view links, then releases the remote
session and deletes its persisted context. Old jobs cannot publish data. A failed
disconnect remains retryable. Session recording, logging, and automatic CAPTCHA
solving are disabled. Browserbase credentials exist only on the worker. Live links
are short-lived capabilities excluded from status responses and owner exports;
retained context identifiers cannot be read by the web DB role.

Reports keep a fixed local calendar day across retries. On connection, the worker
retrieves yesterday. Later runs are scheduled after the restaurant's next cutoff
plus 30 minutes. Missed days are processed sequentially. Reports still being
generated retry every five minutes, up to 100 attempts. Sign-in expiry has a
separate job, which cannot start another daily sync chain. Upserts by tenant,
platform, store and day replace a snapshot instead of adding sales. These totals
do not create POS orders, tickets, charges or inventory movements. Only totals
and a source hash are persisted.

## Verification and activation

`tests/delivery-db.ts` uses the explicitly isolated `TEST_DATABASE_URL`,
`TEST_MIGRATION_DATABASE_URL`, `TEST_WORKER_DATABASE_URL`, and host allowlist.
It uses fictional restaurants and a fake browser, with no platform traffic.

```sh
npx vitest run tests/delivery.test.ts --exclude 'work/**'
node --import tsx tests/delivery-db.ts
npx playwright test --config playwright.delivery.config.ts
npm run typecheck
```

The browser test starts its own Vite server and synthetic fixture. It exercises
consent, request bodies, store selection, disconnect, mobile layout and
accessibility without a database or merchant account.

Verified locally: 133 relevant unit/regression tests, seven synthetic database
scenarios, and the browser flow. The wider suite also exposed an unrelated
existing `docs-consistency.test.ts` failure about the business-day cutoff label
in `PILOT_SOP`; this change does not modify that document.

For an authorized hosted rehearsal, configure **worker-only** variables:
`DELIVERY_BROWSER_ENABLED=1`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`.
Keep disabled until the rehearsal passes. Credentials were subsequently configured and validated as described above. The hosted-browser provider is a new service and subprocessor;
the consent screen identifies it. No real account session was copied from the
local pilot into this implementation.

## Remaining qualification

- Build and qualify Rappi and DiDi store discovery, date selection, export history,
  XLSX/ZIP parsing and nonzero-order cases.
- Run Uber against an authorized hosted account: English UI selectors, MFA,
  context persistence, report pagination and long generation delays. The executable
  selector adapter has not passed this real rehearsal.
- Validate empty-report scope before accepting zero sales. Header-only files
  currently stop with attention rather than fabricate a verified zero.
- Qualify refunds, adjustments posted after the reporting day, alternate locales,
  identical store names and session longevity. Late corrections are not yet
  automatically revisited; totals remain provisional.
- Confirm provider retention/deletion and orphan recovery after an ambiguous
  context-creation timeout. Remote creation is not an atomic DB operation.
- Add reconnect notifications outside Settings and an optional onboarding entry.

References: [Browserbase contexts](https://docs.browserbase.com/platform/browser/core-features/contexts),
[live views](https://docs.browserbase.com/platform/browser/observability/session-live-view),
[download listing](https://docs.browserbase.com/reference/api/list-downloads).
