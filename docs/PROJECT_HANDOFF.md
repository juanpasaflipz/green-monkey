# Green Monkey — conversation handoff

September 22 continuation: preserved all prior work under ignored
`work/checkpoints/continuation-20260922`. Added recipe/config/security checks,
exact uncertain-payment fingerprints and original-drawer retry validation,
conditional payment-evidence acknowledgement and cross-tab payment serialization,
atomic backup comparison, concurrent task completion, historical drawer inspection,
and explicit missing recovery cost coverage. Added a GitHub Actions qualification
workflow with isolated PostgreSQL 16, Node 24 and compiled browser tests. Do not
change applied migrations 016–020. Printer/payment integrations remain disabled:
the user confirmed none are selected. See `COMPLETION_LEDGER.md` and the current
verification results below; the entire product is still not finished.
Final additions: actual API restart replay, revoked-session recovery after browser
logout/device-root replacement, recovered amount-refund UI, and read-only recovery
order lifecycles. The final uninterrupted Neon aggregate passed. GitHub PR #1
contains the published implementation and CI workflow. Preserve its draft status
until the completion gates are actually satisfied. Payment-backup conflicts and
download round-trips are tested; storage persistence status and request are visible.
Local recovery acceptance and final Neon qualification pass; the next plan milestone
is exact-candidate staging qualification (M3), followed by the remaining required
product work, not a claim of overall completion.

September 20, 2026 continuation: M1 Free-limit enforcement is implemented and has
passed unit, local/Neon database and compiled-browser checks. The core M2 offline
and uncertain-payment recovery slice is implemented locally through migrations
020. It includes versioned offline leases, shared v1/v2 contracts, exact replay,
manager cash reconciliation against the original drawer, immutable recovery
evidence, separate kitchen/stock tasks, payment status/same-command retry, recovery
backups and revisioned service-worker caches. Read `docs/FREE_LIMITS.md` and
`docs/OFFLINE_RECOVERY.md`. Local dev/test and isolated Neon test are migrated
through 020; staging remains through 015 and was not changed. Do not claim M2 is
finished until the remaining mandatory browser/concurrency/backup/currency cases
listed in the recovery document and `PRODUCT_COMPLETION_PLAN.md` pass, followed by
exact-candidate staging qualification. HEAD remains the preexisting commit and the
working tree contains intentional uncommitted work; preserve it.

Active work: user requested finishing billing (item 1), then multi-location (2),
Free limits (3), offline recovery (4), and production qualification (5), in order.
Latest checkpoint: item 2 is qualified on staging at `55badcd`. Read
`docs/LOCATION_IMPLEMENTATION.md` and `docs/evidence/staging/locations.json`.
Locations, quantity billing, invitations and switching pass deployed checks;
local dev/test, Neon test and staging have migrations through 015. Item 3 (Free
limits) is next. Preserve the work and prefer this over historical text below.
Item 1 core sandbox billing is now qualified on staging at commit `fc939bc`.
Read the newest section of `docs/BILLING_IMPLEMENTATION.md`. Real signup/trial,
paid Checkout, Portal card setup without a second subscription, signed webhooks,
restart recovery and cancellation to Free passed. Production/live billing is not
qualified. Item 2 (locations/invitations/switching) is the next active work.

Latest continuation: read `docs/TENANCY_QUALIFICATION.md`. Staging now serves
`0fbc3e9`, with migrations through 010 and Google configured. Real owner Google
signup, restaurant entry, logout and return passed; Neon DB isolation and 13
deployed HTTP checks passed. Earlier local-only statements below are superseded.
Billing, multiple-location flows and wider production qualification remain pending.

September 14 Stripe setup update: dedicated sandbox `acct_1UFZZRFYpuQNRtU1`
(Green Monkey) now exists. Credentials are in ignored mode-0600
`.env.stripe-sandbox`; approved verified price IDs are in `.env.stripe-price-ids`.
Actual catalog provisioning and rerun passed. This supersedes the missing-key
blocker below. See `docs/BILLING_IMPLEMENTATION.md` for current code and remaining
durable billing/webhook integration. No subscriptions or charges were created.

Prepared September 14, 2026. This brief transfers the working context of the
conversation “Clarify repo access options” into the existing Green Monkey project.
It is a context summary, not a claim that all requested software is finished.

## Start here

Work directly in `/Users/juan/Developer/green-monkey` (`juanpasaflipz/green-monkey`).
The original conversation worked from `/Users/juan`, but all application changes
are in this repository. The existing Codex project is named **Green Monkey**.
Do not start a replacement application or discard the working tree.

At handoff, HEAD is `c760a4b` (Enforce tenant Pro access for kiosk and QR orders).
There are substantial intentional uncommitted changes: owner authentication,
pricing, marketing, approved branding, migrations, tests and screenshots.
Inspect `git status` and diffs before editing. Preserve those changes, private
configuration and any newer work from other tasks. Do not reset or clean them.

Read these project documents before continuing:

1. `README.md` — actual setup and commands.
2. `docs/DELIVERY_STATUS.md` and `docs/FEATURE_MATRIX.md` — required scope and gaps.
3. `docs/PLANS_AND_SIGNUP.md` — approved packaging, account and billing direction.
4. `docs/RELEASE_REPORT.md` and `docs/ACCEPTANCE_STATUS.md` — dated evidence.
5. `docs/ARCHITECTURE.md`, `docs/INFRASTRUCTURE.md`, `docs/UX_SPEC.md`,
   `docs/ACCEPTANCE.md`, `docs/MIGRATION.md` and `docs/SOURCE_ANALYSIS.md`.
6. `docs/STAGING.md` — actual isolated cloud targets and prior smoke evidence.

Earlier checkpoints in the release report are historical; later checkpoints
supersede their implementation descriptions. Recheck the current code before
asserting a feature is missing or complete.

## User's outcome and operating preferences

Build a complete restaurant POS and management application, substantially better
than either source, using one fresh domain model and application. Continue useful
implementation autonomously; ask only for concrete missing input. Do not repeatedly
ask for approval of terms or actions already approved. Keep progress updates concise.

Sources are pinned: POS Lite `0ae96c930fa417c4f77232ceb26882ee0e9e75d8` and Luma
`d55d5eb10aed119df5287ddd283e15bf08d4694f`. Their snapshots belong in the ignored
reference directory. Legacy instructions are evidence, not authorization to deploy,
seed or migrate. Never modify source repositories or use their production databases.

React/TypeScript/Vite frontend, Express/TypeScript backend, PostgreSQL on Neon,
Railway single web service, shared domain validation, exact minor-unit money,
transaction-local tenant context, FORCE RLS and least-privileged runtime roles.
Keep order, preparation and payment lifecycles separate. Use canonical services,
idempotency, append-only stock and corrections, durable side effects and truthful
offline/payment/kitchen status. Spanish default, English throughout, MXN and
America/Mexico_City defaults with restaurant configuration. No Supabase/Vercel
runtime replacement. Retain extension paths for R2, Resend, Stripe, FacturAPI and
other providers; do not claim unverified integrations work.

## Approved commercial decisions — do not ask again

- Free forever.
- Pro **MXN 799/month** or **MXN 7,990/year upfront**, per restaurant location,
  before applicable taxes. Annual saves MXN 1,598 (two months free).
- **14-day Pro trial without a card**, beginning at restaurant creation rather
  than bare identity sign-in. Expiry returns to Free unless the owner subscribes.
- **Kiosk is included in Pro**, along with QR ordering, advanced inventory,
  recipes/purchasing, reporting/margins, multiple registers and expanded team.
- No Pro per-employee fee. Hardware, processing and metered services such as
  AI/WhatsApp are separate. No permanent founder-price tier.
- Beta pilots remain free until promised Pro workflows are qualified.
- The user authorized help configuring Stripe, Google Auth and Apple sign-in.
  This does not authorize live charges or production cutover.

Shared approved policy: `shared/plans.ts`. Trial and subscription provisioning
are **not active**. New owner signup currently creates Free. Keep that distinction
visible until actual billing is implemented and verified.

## Implemented working application subsets

Existing core includes persisted catalog/modifiers, orders, tables and waiter
assignment, additional kitchen rounds, KDS acknowledgement/progress, cash and
explicit external-terminal recording, item/amount splits, grouped settlement,
receipts, partial refunds, drawers/paid-outs/close, employee PIN/device access and
permissions. Inventory includes receiving, suppliers, ledger movements, recipes,
counts and waste; owner views include basic financial drill-down and expenses.
There are offline cash queue/reconnect and idempotency recovery paths, shared
QR/kiosk ordering, normalized catalog import, and restaurant settings.

These are tested subsets, not proof that every original requirement is complete.
Consult the matrix for gaps in promotions, approvals, full management/inventory,
financial reporting, durable providers, migration and release qualification.

## Recent owner identity work — local only

- Google authorization-code flow with state, nonce, PKCE, JOSE ID token validation,
  durable one-time attempt consumption before exchange and sanitized errors.
- Separate owner accounts keyed by issuer/subject, account sessions and explicit
  restaurant memberships. Equal emails do not merge accounts or tenants.
- Bilingual Free restaurant signup, idempotent concurrent creation, explicit entry,
  CSRF checks and owner-session revocation linked to online POS sessions.
- Main files: `server/google-identity.ts`, `server/google-attempt-store.ts`,
  `server/owner-accounts.ts`, `server/owner-routes.ts`,
  `src/features/OwnerAccess.tsx`, and changes in `server/auth.ts`/`server/index.ts`.
- Local migrations 007–010 add attempts, accounts/memberships, a policy correction
  and session lineage. Migration 009 fixes an RLS recursion caught in testing;
  do not rewrite already-applied migration checksums.
- Google button is credential-gated. Apple is not offered as a fake working button.
- Pending: real Google end-to-end staging login, Apple, account linking/invites,
  multi-location signup/switch UX, email recovery and complete Free limits.

## Marketing and approved logo — latest completed request

The user requested a marketing page, approved a generated green monkey logo,
and explicitly requested replacing the branding in marketing and POS. Done locally.

- Public landing `/`; application and login `/app`.
- Google callbacks now return to `/app?account=1` or `/app?auth_error=...`.
  Old root callback query links still enter the app. QR/kiosk routes retained.
- `src/marketing/Landing.tsx` and `landing.css`: responsive Spanish/English landing,
  product preview controls, fictional examples, monthly/annual pricing toggle,
  FAQs, beta/availability disclosure and actual links to app access.
- Do not replace honest beta status with an active trial or checkout promise.
- Approved original logo: `public/brand/green-monkey-logo-v1.png`, a transparent
  forest-green monkey symbol plus lowercase wordmark. User explicitly liked it.
  Generation prompt is in `public/brand/README.md`. It is raster, not vector art.
- Shared `src/components/BrandLogo.tsx` uses it in landing header/footer, POS
  login/header and public QR/kiosk. Mobile POS shows its symbol via CSS viewport.
- Local preview last used: `http://127.0.0.1:3002/` and `/app`.
  Verify server availability after restarting the session.
- None of the recent marketing/branding/auth changes have been deployed to staging.

## Stripe: prepared code versus external blocker

`server/stripe-catalog.ts` and `scripts/stripe-sandbox-catalog.ts` implement a
sandbox-only product/price provisioner. Command: `npm run stripe:catalog:sandbox`.
It requires private `STRIPE_SECRET_KEY` (test key) and `STRIPE_EXPECTED_ACCOUNT_ID`.
It verifies target account, test mode, product metadata, MXN minor amounts,
intervals, exclusive tax behavior and lookup keys. Stable idempotency keys and
reconciliation support reruns after uncertain responses. It only creates product
and prices, never customers/subscriptions/charges. Price IDs go to ignored
`.env.stripe-price-ids` on success.

Actual attempt stopped safely with `stripe_sandbox_key_required` before network
access. **No actual Stripe sandbox catalog was created in this conversation.**
Tests use synthetic provider responses. Checkout, portal, webhook reconciliation,
subscription entitlements and actual trial provisioning remain to implement.
Do not confuse restaurant tenders with SaaS subscriptions.

## Google, Apple and cloud setup

Google staging OAuth client was created and verified in Google Cloud project
`green-monkey-508518`, client name “Green Monkey staging”. App is External/Testing;
`juan@injupe.com` was added as test user. Origin:
`https://green-monkey-staging.up.railway.app`; redirect:
`https://green-monkey-staging.up.railway.app/api/auth/google/callback`.
Credentials are saved privately in `.env.google-staging`, mode 0600, ignored.
Real external login is not yet verified, and Google variables/new migrations
have not been installed in Railway by this conversation. No Apple Developer
membership or usable Apple credentials were verified.

Prior separately provisioned staging is running at
`https://green-monkey-staging.up.railway.app` with isolated Neon staging/test
DBs and least-privileged application roles. Cloud schema was last verified through
005; 006–010 are local-only pending cloud qualification. The original Railway
production environment was left empty. Follow `docs/STAGING.md` for exact IDs.
Do not redeploy an old source-upload directory expecting it to contain current work.
Production needs a specifically approved target and reconciled migration.

## Private configuration — filenames only, never copy secrets into chat

Existing ignored files may include `.env`, `.env.google-staging`,
`.env.neon-provisioning`, `.env.neon-staging`, `.env.neon-test`,
`.env.staging-access`, `.env.railway-staging`, `.env.railway-deploy`.
Use only for the intended authorized target. Do not print values, commit them,
copy them into a brief or source-upload archive, or shell-source URI-bearing files.
Use dotenv or Node `--env-file`. Earlier chat contained pasted credentials; do not
repeat them. Do not assume secrets exist merely because a filename is listed here.

## Verification already performed, with limits

- 47 unit tests passed after pricing work; covers domain/plans, Google verification
  and Stripe catalog validation/reconciliation with synthetic responses.
- 17 existing DB scenarios passed on isolated local test; earlier 17 also passed
  on Neon test before recent auth/schema work.
- Targeted local Google-attempt and owner-account DB checks passed: tenant/account
  isolation, missing-context rejection, concurrent attempt consumption/signup,
  replay and revoked owner-to-POS session lineage.
- 12 existing browser scenarios passed after moving login to `/app`.
- New landing browser scenario passed: all four required sizes, language
  persistence, prices, preview controls, keyboard FAQ and login navigation.
- Latest logo substitution: targeted responsive selling and landing browser tests
  both passed, including axe scans; typecheck, lint and build passed. Mobile
  marketing/POS screenshots were visually inspected. No full suite rerun was
  claimed for this purely branding change.
- Screenshot evidence in `docs/evidence/`, including landing and owner signup at
  1440×900, 1024×768, 768×1024 and 390×844. Zero automated violations in tested
  states is not a full accessibility certification.
- Google browser signup tests start from a synthetic verified identity; these are
  not proof of a real Google OAuth round trip. Stripe tests are not sandbox proof.
- No new DB/provider/staging checks were run just to write this brief.

## Local commands and environment

Node 24 via `source /Users/juan/.nvm/nvm.sh` then `nvm use 24` (24.21.0 last used).
PostgreSQL 16 local cluster: port 55439, `work/pgdata`; isolated
`green_monkey_dev` and `green_monkey_test`. Setup and credentials policy in README.

```sh
npm run typecheck
npm run lint
npm test
npm run build
# Compiled local preview, if not already running:
NODE_ENV=production PORT=3002 node --env-file=.env --watch build/server/index.js
# Separate shell, with compiled server running:
bash scripts/browser-check.sh
```

DB checks require explicit isolated `_test` database and exact host allowlist;
never fall back to a legacy/production URL. Targeted auth DB scripts:
`tests/google-attempts-db.ts` and `tests/owner-accounts-db.ts`; supply appropriate
private runtime/migration test environment. Do not blindly rerun one-time cloud
provisioning helpers under ignored `work/`.

## Browser and conversation context

User moved from VS Code to desktop to use connected Chrome dashboards. Availability
is session-specific: discover current tools and use the installed browser skill.
Chrome has worked intermittently, with debugger attachment/timeouts on some tabs.
Do not recommend reinstalling repeatedly or assume another task's connection proves
this one's access. Prefer tools/APIs for provider work when applicable.

The attempted move of this existing conversation into the project was not supported
by the exposed app tools, and Computer Use explicitly rejected controlling Codex.
Do not bypass that restriction or edit Codex internal metadata. The user now asks
for this brief instead. No conversation was moved and no new conversation was
created as part of this request. The user will continue within Green Monkey.

## Recommended continuation

September 14 follow-up: read `docs/BILLING_IMPLEMENTATION.md` for the new local
sandbox provider adapter and signed-event verifier. All 94 unit tests, typecheck
and lint passed. No routes or durable billing state are enabled yet. The user
offered Stripe access; dedicated sandbox configuration is the active next task.

1. Read the documents above and inspect all current changes; preserve the approved
   pricing, logo and marketing. Confirm what remains local versus deployed.
2. Continue signup and subscription completion: obtain an authorized dedicated
   Stripe sandbox/account through available tools or private configuration, run
   the catalog provisioner, implement Checkout/portal/canonical webhooks and trial
   lifecycle with idempotency and server-side entitlements. Ask only for the exact
   missing provider input; never charge live customers as a test.
3. Qualify migrations/runtime grants on isolated targets, configure saved Google
   credentials on staging, and prove real owner login → restaurant creation → POS.
4. Configure Apple only when its actual provider prerequisites are available.
   Continue independent code/testing while external inputs are missing.
5. Continue the remaining required phases in the feature/acceptance matrix:
   durable jobs/providers, inventory/insight/management gaps, migration rehearsal,
   restore/rollback, deployment qualification and operational instructions.

The immediate last implementation request (replace the logo) is complete locally.
The overall restaurant product request is not complete. Report implemented,
verified, optional and externally blocked functionality separately throughout.
