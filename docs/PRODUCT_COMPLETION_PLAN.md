# Green Monkey: product completion execution handoff

Prepared September 19, 2026. **Planning only: this document does not authorize or
claim new implementation, deployment, provider configuration, or live charges.**
The next agent must execute against the actual checkout, including uncommitted work.

## 1. Mission and definition of finished

Finish the restaurant POS and management product described by
`FEATURE_MATRIX.md`, `ACCEPTANCE.md`, `ARCHITECTURE.md`, `UX_SPEC.md`,
`PLANS_AND_SIGNUP.md` and `MIGRATION.md`. Continue the original priority:
**close item 3 (Free limits), finish item 4 (offline recovery), then item 5
(production qualification).** Qualification must expose and close the remaining
required product gaps; an infrastructure smoke test alone cannot finish the product.

Track three distinct outcomes:

1. **Required product complete:** every required matrix capability works through
   the UI and canonical API, with acceptance evidence. Unavailable external proof
   remains explicitly blocked, not passed or silently reclassified as optional.
2. **Release candidate qualified:** the exact candidate passes security, migration,
   restore/rollback, browser, performance, accessibility and operational checks
   on isolated targets. Configured providers and hardware have actual evidence.
3. **Production launch complete:** only after the user explicitly approves the
   named live target, enabled modules and cutover window, perform the rehearsed
   launch and verify it. Do not equate sandbox billing with live billing approval.

Optional follow-ons do not block the required product: native wrappers, courier
integration, wallet passes, messaging/voice, AI assist, kiosk recommendations,
menu boards and advanced automated incident response. The feature matrix marks AI
parsing as optional assist despite older delivery prose calling it pending; retain
a functional manual workflow. Configured invoicing, delivery connections, loyalty
and payment integrations require explicit enablement scope and evidence. If a pilot
requires an optional module, record its promotion into that pilot's release gates.
Do not remove required features merely to make the release checklist green.

## 2. Authority, constraints and decisions to preserve

- Repository: `/Users/juan/Developer/green-monkey`; remote identity in the handoff
  is `juanpasaflipz/green-monkey`. Verify current remote before any remote operation.
- Preserve current changes, approved logo and bilingual marketing. Do not reset,
  clean, overwrite private configuration, replace the app, or edit source repos.
- React/TypeScript/Vite, Express/TypeScript, PostgreSQL/Neon and Railway remain the
  architecture. Shared domain validation, exact minor-unit money, explicit tenant
  transactions, FORCE RLS and restricted runtime roles are mandatory.
- Separate preparation, order and payment lifecycles. Money and inventory history
  are append-only. Provider requests never run while holding a DB transaction.
- Free forever: one location, one selling device, owner plus two named employees.
  Pro: MXN 799/month or MXN 7,990/year upfront per location, taxes additional,
  kiosk included, no employee fee. Annual savings: MXN 1,598.
- One 14-day no-card Pro trial per organization, beginning at restaurant creation
  or confirmed provisioning after an outage, not at identity sign-in. Additional
  locations share the original subscription/trial end. Preserve quote/consent.
- Downgrade preserves records, export, refunds, outstanding cash work and recovery.
  Existing bounded offline authorization cannot be retroactively revoked offline;
  server access and new leases must reflect current permissions.
- Spanish default; complete English support; MXN and `America/Mexico_City` defaults.
  Respect configured currency
  exponents, timezone, cutoff and opening days throughout.
- Beta pilots remain free until promised Pro workflows are qualified. Do not
  enable automatic billing of beta participants through an unrelated rollout.
- No live charges, production cutover or source-data migration is approved by the
  earlier provider setup. No guessed merchant contracts, tax rates or payroll law.
- Use official current provider documentation when implementing integrations.
  Repository observations in this plan are not guarantees of future provider APIs.
- Private values belong only in ignored, restricted files or approved secret
  stores. Read private environment files with dotenv/Node, never shell-source
  URI-bearing files. Do not print credentials or put them in artifacts/uploads.
- Default to useful autonomous implementation and isolated verification. Ask only
  for missing provider/business inputs or genuinely unapproved live actions.
  Do not repeatedly ask about the commercial or architectural decisions above.

## 3. Baseline the next agent must preserve

### Observed repository state

At this planning checkpoint, HEAD is `11ae598` (multi-location staging evidence).
The checkout contains intentional **uncommitted** Free-limit and offline-recovery
work. A clone of HEAD alone does not contain that work.

Read, in order:

1. `PROJECT_HANDOFF.md` (latest opening checkpoints supersede historical text).
2. `LOCATION_IMPLEMENTATION.md`, `BILLING_IMPLEMENTATION.md`,
   `TENANCY_QUALIFICATION.md`, and their evidence JSON files.
3. `FREE_LIMITS.md` and this document.
4. Repository-root `README.md`, then delivery/feature/acceptance/release documents.
5. Architecture, infrastructure, UX, migration, source analysis, operations and
   dependency documents. Consult the pinned source snapshots only as references.

Existing work to inspect before editing:

| Area | Files |
| --- | --- |
| Free selections | `migrations/016_free_limits.sql`, `017_free_location_policy.sql`, `server/free-limits.ts`, `shared/plans.ts`, `scripts/grants.sql` |
| Entry and enforcement | `server/auth.ts`, `owner-accounts.ts`, `owner-management.ts`, `owner-routes.ts`, `management.ts`, `orders.ts`, `index.ts` |
| Free UI | `src/features/FreeSelection.tsx`, `OwnerManagement.tsx`, `OwnerAccess.tsx`, `Operations.tsx`, `src/App.tsx`, `src/i18n.ts` |
| Offline draft | `server/offline-sync.ts`, `server/operations.ts`, `src/offline.ts`, `src/features/RecoveryQueue.tsx`, `Selling.tsx`, `shared/domain.ts` |
| Tests and evidence | `tests/free-limits-db.ts`, `tests/browser/free-limits.spec.ts`, `docs/FREE_LIMITS.md`, two `free-selection-*.png` images and refreshed existing screenshots |

Do not assume untracked files are disposable. Before editing, record `git status`,
HEAD, diff summary and tracked/untracked file hashes in an ignored local checkpoint.
Capture a patch and copies of the task's untracked source files if making an
execution checkpoint; exclude all environment files, dumps and credentials.
If other work appeared since this plan, reconcile it rather than replaying patches
blindly. Make later implementation commits by feature; do not push simply because
a local milestone is complete.

### Actual verification and deployment boundaries

- Items 1 and 2 have prior staging proof. Latest recorded staging application:
  `55badcd92f83cbc5149159969889a33303d0b72a`, deployment
  `b6989aa9-b027-44ac-a8dc-206173812c60`, migrations through 015.
- Migrations 016–017 were applied to local dev/test and Neon test. They have **not**
  been applied to staging in this continuation. Preserve their checksums: corrections
  require a new migration, starting at 018 if that number remains unused.
- Free-limit tests passed locally and on Neon test. They exercise concurrent team
  and device selection, invitation cap, reserved owner role, expiry, canonical API
  gate, recovery of accepted commands, collection of outstanding orders, ownership,
  foreign IDs and one Free location.
- Free-selection browser test passed with two contexts and accessibility scans at
  1440×900 and 390×844. Other existing scenarios passed across an initial run and
  targeted reruns. There was no final clean single full-suite run of all changes.
- 115 unit tests, 17 operational DB scenarios, lint and build passed **before** the
  newest offline refactor. Those results are not proof for the current full diff.
- Last current-tree typecheck passed. Last lint failed on unused `quote` and
  `orderInput` imports in `server/index.ts`. No fixes were made during this plan.
- Offline manager reconciliation, backup import and related new code have not had
  their required DB/browser qualification. No offline recovery feature is claimed
  finished merely because its TypeScript compiles.

### Known review targets, not all confirmed defects

1. `/api/health` still checks migration 015, although new runtime code requires
   016–017. Align readiness with actual schema requirements before deployment.
2. The Free gate chiefly protects new orders/rounds. Audit **every** mutation so
   extra staff/devices cannot conduct unrestricted new operational work through
   payment, KDS, drawer or management endpoints under the name of recovery.
3. `reconcileOffline` currently writes a completed order without item lines and a
   tender against the original drawer. This is a draft approach, not an approved
   financial model. Resolve its business-date, refunds, reporting, stock, kitchen,
   closed-drawer and repeated-request behavior before allowing its UI to ship.
4. `cashSummary` now returns `closedExpected` and `lateRecovery`; the UI does not
   yet clearly display those additions or historical drawer corrections.
5. RecoveryQueue formats money with `/100`; replace this with the existing shared
   currency-exponent handling, including tests for supported non-two-decimal money.
6. Backups restore local queue records; session IDs and client timestamps are not
   proof that cash was collected. Recovery must remain an authorized reviewed
   correction with durable evidence, never an automatic financial import.
7. Payment attempts remain scoped in `db.cache` separately from queued cash. A
   queue-only recovery screen does not solve inaccessible payment attempts after
   logout, device-root loss or employee change.
8. The service worker uses a fixed cache name and network-first shell caching.
   Waiting activation alone does not prove old/new shell and asset compatibility.
9. Several broad status docs still say billing/Google/locations are missing.
   Update their current summaries without deleting dated historical evidence.

## 4. Execution order and milestone gates

Execute sequentially. A milestone may be locally complete while external proof is
blocked; say so explicitly and continue independent work. Never mark the overall
product complete while required gates remain blocked. Each milestone ends with
an evidence entry and an updated handoff, not an unsupported completion claim.

| Milestone | Work | Depends on | Exit gate |
| --- | --- | --- | --- |
| M0 | Restore a trustworthy baseline | Current checkout | Known failures reproduced, checks organized, no lost work |
| M1 | Close item 3, Free limits | M0 | Full policy/route matrix and downgrade tests pass |
| M2 | Finish item 4, offline/payment recovery | M1 | OFF-01 through OFF-08 and financial correction tests pass |
| M3 | Start item 5 qualification | M2 | Exact M1/M2 candidate qualified on staging; full gap ledger and external inputs recorded |
| M4 | Complete selling, pricing, cash and kitchen | M3 | Operational and money acceptance passes |
| M5 | Durable jobs, printing and merchant payments | M4; external contracts | Failure/restart/reconciliation and device evidence passes |
| M6 | Complete inventory and procurement | M4; jobs from M5 where needed | End-to-end stock/cost invariants pass |
| M7 | Complete finance, forecasts, reporting and imports | M4, M6, job infrastructure | FIN and import reconciliation gates pass |
| M8 | Complete account/team/onboarding and configured modules | M4–M7 foundations | Ownership, permissions, configured integrations and onboarding pass |
| M9 | Migration rehearsal and operational readiness | Required implementation; exports | Reconciliation, restore and rollback evidence passes |
| M10 | Final release-candidate qualification | M1–M9 | All required acceptance gates pass on exact revision |
| M11 | Approved launch and completion handoff | M10 plus explicit live authorization | Live smoke, reconciliation and observation pass |

M4–M9 are the work exposed by item 5; do not skip them by redefining the product
as the current demo. Dependencies can be prepared while awaiting provider input,
but avoid simultaneous edits to the shared monetary/authentication services.

## M0. Preserve state and establish the baseline

1. Inspect applicable `AGENTS.md` files, repository status, diff and private file
   names. Do not print secret contents. Record current tools/runtime availability.
2. Reproduce typecheck and the two lint errors; remove only genuinely unused
   imports. Run `git diff --check`. Review untracked files as part of the change.
3. Recheck both isolated local targets and their migration registries before
   running migrations. Do not reseed existing dev data to make tests pass.
4. Make DB test commands reproducible: today `npm run test:db` covers only
   `tests/database.ts`, and `npm test` names six unit files explicitly. Add documented
   commands/CI coverage for all owner, OAuth, entitlement, billing, Free and future
   recovery suites. Preserve test-target allowlists; never fall back to runtime DB.
5. Reproduce baseline tests. Label synthetic identity, mocked provider, actual
   sandbox, local browser and deployed evidence separately.
6. Review refreshed screenshots against prior evidence. Keep meaningful new images
   under revision-specific names; exclude meaningless regenerated churn without
   discarding images produced by other work.

**Exit:** reproducible checks, complete source inventory, recorded baseline
failures and a small checkpoint commit when the initial corrections pass.

## M1. Close Free-limit correctness and downgrade UX

Work primarily in the Free-limit, entitlement, owner-access, management and order
files listed above. Retain serialized slot assignment and unique DB constraints.

1. Write a route/capability table identifying Free, Pro, owner/manager/operator and
   recovery permissions. Classify each endpoint as read/export, new operational
   action, completion of previously accepted work, or correction.
2. Define and enforce recovery eligibility on the server. A nonselected device or
   employee must not be able to keep performing arbitrary new work. Persist enough
   transition/lease information to identify previously authorized work. Owners must
   always have a route to change selections without needing a second selling slot.
   Security revocation and plan downgrade are different: revoked identities need
   fresh authorized access; a paid-plan expiry does not erase financial obligations.
3. Verify one Free location per organization across owner signup, invitation, old
   password accounts, pending locations and switching. Preserve activation_pending
   and the billing worker's sole authority to activate paid locations.
4. Verify named-team limits on creation, activation, role changes and invitation
   acceptance. Test deactivation frees a slot, concurrent replacement, last-owner
   protection, existing extra owners, unselected retained staff edits, and an
   invited account creating its own unrelated restaurant without gaining owner rights.
5. Verify selection changes concurrent with orders and new session issuance. Check
   existing tabs, fresh sessions, reconnect and old bounded offline leases. The UI
   must announce restrictions and refresh permission state without losing drafts.
6. Apply Pro checks to implemented advanced actions after idempotency replay. Keep
   basic inventory quantity corrections, sold-out controls, daily sales, historical
   evidence and authorized export usable on Free. Provide a basic signed quantity
   adjustment if Free currently offers additions only; do not force stock correction
   through a Pro count workflow. Separate historical cost reads from new Pro analysis.
7. Extend UI tests to all four required viewports and both languages. Exercise
   keyboard selection, two employees, extra staff on downgrade, full recovery-only
   access, location selection, invitation-full errors and upgrade/downgrade transitions.
8. Update readiness to the actual required schema version. Test a deliberately
   missing required migration returns non-ready before accepting application traffic.

**Exit:** local and Neon unit/service/HTTP isolation and concurrency checks pass;
full compiled browser suite passes; policy matrix and `FREE_LIMITS.md` accurately
state remaining deployment limits. No required route is enforced only by hiding UI.

## M2. Finish offline recovery, including uncertain payments

### A. Contracts and persisted evidence

1. Move the offline request/backup schema into a shared module used by client and
   server. Preserve compatibility with already stored v1 records and operation hashes.
   Parsing defaults must not invalidate replay of an already accepted request.
2. Retain original operation ID, draft/order operation ID, tenant, employee, device,
   original session/lease and drawer IDs, observed timestamps, currency/configuration
   version, cached quote lineage, collected amount/tip/change and optional receipt
   snapshot. Do not manufacture historical tax, recipe, cost or item-price fields
   absent from an old record. Label absent evidence explicitly.
3. Store authorization/configuration issuance facts server-side for new sessions
   rather than inferring issuance solely from a hardcoded session duration. Version
   lease contracts and bound them by authenticated identity/plan/security policy.
4. Preserve a recoverable local receipt. Local cash receipt must say that money was
   recorded on this device, server sync is pending and kitchen delivery is unknown.
   A snapshot read from a backup is a claim for review, not trusted authorization.

### B. Automatic synchronization

1. Retain atomic order/tender/stock/outbox writes and the original operation IDs.
   Enforce authenticated tenant/device/employee scope and original eligible lease.
   Reject forged `channel: offline` bypasses in ordinary order routes.
2. Serialize browser synchronization and session transitions. Recover abandoned
   `syncing` rows after reload/tab exit. Classify permanent conflicts, authentication
   failures, rate limits and transient transport failures distinctly. Bound automatic
   retries; retain all exhausted records for explicit retry/review.
3. Verify the normal sync, manager reconciliation and uncertain-response replay paths
   share the same deduplication identity. Define one lock order for drawer/order/
   operation rows and test concurrent normal sync versus reconciliation.
4. Never silently reprice collected cash, replay current recipes as historical stock,
   change the original currency or record kitchen delivery without acknowledgement.

### C. Manager reconciliation

Finish a dedicated audited recovery command rather than shipping the current
unfinished synthetic-completed-order shortcut unchanged:

1. Manager/owner reviews the claimed original sale, original identity/device/drawer,
   current server status, price/availability differences and source evidence. Require
   a reason and explicit confirmation of already collected cash.
2. Query the original operation under the canonical lock first. If already committed,
   return that exact result; do not create another tender. If the draft/order exists
   without the parent sync, inspect its tenders and route to payment reconciliation.
3. Persist an immutable recovery record linking the original claim, evidence version,
   actor/reason, existing or newly recorded financial result, original sold time and
   actual recognition time. Use an explicit recovered-source marker. Do not mark
   preparation `completed` solely because a manager recognized cash.
4. Preserve the original collected total and tip. Missing per-item historical values
   remain unallocated; do not invent them from today's menu. Expose them as such in
   receipt, source drill-down, tax coverage, margin coverage and item-refund UI.
5. Post the cash effect exactly once against the correctly verified original drawer.
   Lock/read the drawer consistently with close/refund commands. Never rewrite the
   original close count, expected amount or reason. Show original close results and
   append-only late corrections separately, including old drawers on other devices.
6. Persist separate kitchen/stock follow-up tasks. Operator must verify whether
   preparation or stock consumption already happened. Each correction references
   the recovery ID and has a unique causal key; don't deduct twice. Do not imply
   manual reconciliation is complete while these tasks remain unresolved.
7. Allow permitted refunds against the original/recovered tender, capped by remaining
   refundable amount, with explicit stock disposition. Retain Free recovery access.
8. Authorize every review, export, import, correction and outcome lookup server-side;
   reject foreign tenant sessions, drawers, orders and operation references.

### D. Reauthentication, replacement devices and backups

1. Show same-tenant retained records to a freshly authenticated authorized manager,
   including records created under a previous employee/device scope. Ordinary staff
   see only records their access permits. Tenant switching never blends queues.
2. Add a recovery route for unresolved payment-attempt cache entries, not only cash
   queues. First perform read-only canonical status lookup. A missing response is
   not permission to charge again. Retry only the original immutable command when
   its provider/local state permits it; otherwise create a review case.
3. Validate backups by version, tenant, IDs, amount ranges, currency and maximum
   size. Restore atomically; reject changed-payload collisions without replacing
   existing entries. Handle repeated imports and normalize schemas consistently.
   Do not discard unresolved payment attempts when backing up recovery state.
4. Explain the physical limit: unsynced records destroyed with all browser storage
   cannot be recovered without a surviving backup or prior server acknowledgement.
   Offer storage-persistence status and backup/export; never claim nonexistent cloud
   copies. Recover lost cookies/device root independently from lost IndexedDB data.

### E. Service-worker and browser recovery acceptance

Use revision-specific shell/asset caches. Do not cache authenticated API responses.
Prevent an active checkout from mixing incompatible shell and asset revisions.
Activate updates safely, keep old assets until no client needs them, and test
IndexedDB schema upgrades without deleting queues or attempts.

**Mandatory tests:** OFF-01–OFF-08 plus lost response before/after commit; browser
close/reopen; two tabs; interrupted lock holder; retry exhaustion; changed price,
recipe, availability and permissions; lease expiry; revoked owner/PIN; logout;
new device root; wrong tenant import; malformed/repeated/conflicting backup;
closed drawer; simultaneous close and reconciliation; same-key replay after
restart; duplicate correction; item/amount refund after recovery; old v1 queue;
zero/two/three-decimal currency display where supported; service-worker update
while a payment and queue are unresolved. Add DB, HTTP and compiled-browser tests.

**Exit:** all tests above pass locally and on isolated Neon where applicable;
receipt/report/cash totals reconcile; operator instructions describe limitations.
No additional real customer payment occurs during recovery qualification.

## M3. Start production qualification with the exact candidate

1. Build a requirement ledger with one row per feature-matrix capability and each
   acceptance ID. Columns: policy tier, required/configured/optional disposition,
   implementation files, automated evidence, browser evidence, provider/device proof,
   outstanding work, blocker and next action. Historical doc claims are not evidence.
2. Inventory provider prerequisites from names/configured capability status only.
   Collect missing inputs once, clearly naming what is needed and why. Continue
   other work while answers are pending; do not infer approval from silence.
3. Recheck the authorized staging identifiers in `STAGING.md`, actual health/version,
   current schema, credentials' intended targets and role grants. Prepare a fresh
   restricted backup and source-only upload manifest. Do not reuse an old upload tree.
4. Run ordered checksum migrations and reviewed grants on the isolated target,
   deploy the exact tested revision to authorized staging, and verify `/api/version`
   matches it. Keep rollback compatibility evidence. Never promote to production here.
5. Exercise real deployed Free selection, downgrade, invitations, two-browser entry,
   queued cash/reconciliation and one complete cash/KDS/refund flow. Rerun tenant
   isolation. Keep synthetic fixture IDs and output in scrubbed evidence JSON.
6. Requalify sandbox billing where entitlements/sessions interact with changed code:
   trial expiry, paid upgrade, cancellation, location quantity and webhook/restart.
   Preserve the 23-hour uncertain-provider-operation review barrier.

**Exit:** items 3 and 4 have deployed evidence; the remaining product scope and
provider blockers are explicit. This is an intermediate qualification checkpoint,
not release approval.

## M4. Complete selling, money, cash and kitchen

Suggested module boundaries: shared pricing/offer/tax contracts; canonical server
pricing/order/correction services; focused selling/payment/management components.
Extract from large files only when required by the behavior being added.

1. **Catalog:** complete category/modifier editing, stable combo definitions/slots,
   basic Free combos, permissioned open amounts, product availability, channel
   visibility and tenant branding. Add photo upload only through verified scoped
   asset storage; validate content/size, isolate paths and preserve original logo.
2. **Pricing:** build one deterministic calculation for POS, QR, kiosk, imports where
   applicable and sync validation. Define scheduling in restaurant business time,
   offer eligibility, discount stacking/order, rounding and max reductions. Return
   a versioned quote with price/discount/tax snapshots. Add configured tax behavior
   from verified requirements; do not guess a universal Mexican tax rate or turn a
   sample setting into fiscal certification.
3. **Approvals:** add short-lived, single-use action-bound manager approvals for
   protected discounts, courtesies, voids and exceptional stock actions. Bind actor,
   tenant, order/version, action and amount; validate server-side and audit use.
4. **Drafts/service:** complete named parked-ticket list/resume/templates, editable
   lines, fulfillment details and table/round flow. Preserve unsent versus accepted
   lines and original ownership; test refresh, stale version and tenant switching.
5. **Corrections/refunds:** implement item void/cancel and item-level refunds with
   immutable price/tax/discount allocations. Enforce refund caps and required reasons;
   separate money reversal from stock return and kitchen cancellation.
6. **Kitchen:** persisted cancellation/change deltas with explicit acknowledgement;
   reconnect catches up without duplicate alerts; visible stale state. Keep station
   routing and printer/device management correctly gated by Pro.
7. **Cash:** saved close drafts, tips/refunds/paid-outs together, discrepancy approval
   and historical drawer drill-down, including M2 late corrections. Closed totals
   must retain their original snapshots. Never close away unresolved local work
   without preserving an explicit recovery procedure.
8. **QR/kiosk:** Free read-only QR menu; Pro scoped ordering and renewable device
   credentials; accessible modifier/cart flow, idle reset, expired-plan assistance,
   staff-controlled held/pay-at-counter policy. Customer wording must accurately
   distinguish unpaid, awaiting staff, accepted and paid. Integrated checkout awaits M5.
9. **History/export:** searchable, paginated history and complete authorized export,
   including old locations and recovery/correction evidence. Export must not depend
   on a paid plan and must neutralize spreadsheet formula injection in CSV fields.

**Exit:** UX-01–UX-07, UX-10, CORE-01–CORE-02, CORE-05–CORE-11 and related QR/KDS
scenarios pass to the extent they are independent of external payment providers.
Existing splits/grouped settlements retain their tested identities and allocations.

## M5. Durable jobs, physical printing and merchant payment integrations

### Shared job infrastructure

Use existing jobs/outbox tables as the starting point; preserve the separately
restricted billing worker. Add durable leasing, attempt history, bounded retries,
stale-worker fencing, backoff, dead-letter review and permissioned retry. Side-effect
consumers must deduplicate by immutable logical key. Show queued/acknowledged/
failed/uncertain states in a usable operator screen. Add restart tests before adding
email or printer delivery on top. Scheduled work uses restaurant timezone and a
unique period key rather than copying source cron schedules.

### Printing

Implement tenant/device pairing with short-lived setup authorization and revocable
bridge credentials; route station jobs; protect transport. Persist printer/job
acknowledgements. Socket write is not proof of printed paper. Reprint requires a
reason, actor and duplicate mark. Verify disconnect, paper-out, uncertain delivery,
duplicate delivery and bridge restart on an actual supported printer. Browser
printing alone does not meet thermal/kitchen printing acceptance. Complete OPS-01.

### Restaurant merchant payments

Keep SaaS subscriptions separate from customer tenders and merchant accounts.
Confirm the first actual merchant/provider and device contract from user/provider
inputs; do not assume the platform's billing sandbox is a restaurant merchant.

For each enabled provider implement:

- Scoped credential encryption and audited configuration; tenant merchant/terminal
  ownership; no global fallback merchant.
- Durable attempts before calls, original provider idempotency keys, canonical
  status reconciliation, amount/currency validation and signed deduplicated webhooks.
- Explicit pending/unknown UI, cancellation policy, partial/split collection,
  refunds, timeout and restart recovery, and accepted-order access on plan expiry.
- Contract tests plus actual provider sandbox evidence, then hardware evidence for
  each terminal family. Validate the provider's idempotency retention and offline
  support instead of assuming billing-provider behavior applies.

Do not create guessed Clip requests or claim every provider family supported
because an adapter interface exists. Unconfigured adapters remain disabled and
truthfully described. Complete CORE-03–CORE-05 and pending provider-dependent UX-05.

## M6. Inventory, recipes and procurement

1. Extend stable stock-item/unit data and recipe versions. Add substitution mappings
   with explicit approval, actual unit conversions, effective cost versions and
   missing-cost coverage. Preserve historic order consumption/cost snapshots.
2. Purchase orders: draft/approve/ordered/partially received/received/canceled with
   immutable received quantities and supplier documents. Receiving is idempotent;
   repeated files or button retries cannot add stock twice.
3. Implement lot/expiry tracking and deterministic depletion appropriate to the
   configured policy; separate receipt date, expiry and cost. Do not infer unavailable
   historical lot allocations. Add expiry alerts with evidence and a corrective action.
4. Prep batches consume raw inputs and produce prepared quantities exactly once.
   Track yield loss, portions and cost allocation. Sales of prepared stock must not
   also deduct its raw ingredients. Declare valuation/rounding policy explicitly;
   keep it versioned and do not present it as legal accounting advice.
5. Save count drafts with cutoff and observed stock version. Preview variance against
   the ledger, detect intervening movements, require review and append adjustments.
6. Waste and stock returns need reasons, dispositions, authorization and causal
   deduplication. Link recovery corrections from M2; prevent both normal sync and
   manual reconciliation from consuming the same sale twice.
7. Provide basic Free quantity management and read/export history alongside Pro
   recipes/procurement/count/prep features. Downgrade retains all advanced records.

**Exit:** INV-01–INV-04 pass for complete purchase→receipt→prep→sale→refund/return→
count→waste chains; balances and historical costs reconcile under contention.

## M7. Finance, forecasts, reporting and data imports

1. Create a shared reporting contract and queries for gross sales, discounts,
   net sales, configured taxes, tenders, refunds, tips, marketplace/provider fees,
   COGS coverage, operating expenses and cash differences. Drill every figure into
   source records. Distinguish transaction date, original offline sold date and
   correction recognition date. Never mix currencies in an unlabeled total.
2. Add fixed/variable/recurring expenses with idempotent period generation. Avoid
   double-counting inventory purchase cash outflow as both expense and COGS.
3. Date filters use half-open business-time boundaries. Test midnight/cutoff, DST,
   leap day, month/year transitions and setting changes. Organization views enumerate
   explicit memberships and show per-currency totals or an approved FX policy.
4. Forecasts aggregate available history, label partial/insufficient periods, expose
   editable assumptions and always derive profit from revenue minus costs. Alerts
   lead to evidence and a permitted action; no invented confidence or guarantees.
5. Add manual/CSV sales and delivery-settlement imports for the planned source
   families. Preview mappings, preserve external/source IDs and original files/hashes,
   reject duplicates/orphans and build a coverage map. Settlement net cash is not
   another gross sale. Overlapping detail and weekly summaries must not double count.
6. Generate PDF reports and durable scheduled summaries using M5 jobs. Verify output
   layout and values against the same report source. Delivery stays disabled until
   Resend sender/recipient policy and actual sandbox delivery are verified. Complete OPS-03.
7. Mark basic daily summaries/history/export Free; advanced margins/forecasts/
   organization reporting Pro. Keep historical source access on downgrade.

**Exit:** FIN-01–FIN-04 pass; tender/order/refund/fee totals reconcile; import reruns
and interruption do not alter accepted totals; PDF values match on-screen values.

## M8. Accounts, team, onboarding and configured business modules

1. Complete organization membership lifecycle: list/change/revoke access, last-owner
   protection and deliberate ownership transfer. Prevent role escalation through
   invitation replay or matching email. Sessions inherit revocation across POS access.
2. Preserve Google issuer/subject identity. Implement deliberate account linking only
   with fresh proof of both identities. Add verified email/password fallback and
   recovery with rate limits, one-time hashed expiring tokens, enumeration resistance
   and session invalidation. Social accounts must not acquire guessed passwords.
3. Apple sign-in requires actual developer membership/configuration/key/domain
   prerequisites and real provider testing. Implement/verify the adapter only from
   official contracts; offer no fake button while blocked.
4. Complete tenant-scoped granular Pro permissions, team/shift review, corrections,
   tip allocation and payroll summaries. Version configurable payroll/tip policies;
   totals are operational estimates unless separately qualified for legal payroll.
5. Complete onboarding end-to-end: verified identity→Free/trial choice→restaurant
   settings→reviewed menu import→device selection→drawer→first sale→receipt/report.
   Restore interrupted onboarding without another tenant, trial or subscription.
6. Complete account/subscription status, in-app reminders, verified email reminders
   when configured, payment-failure recovery, cancellation/expiry and operator review
   of uncertain operations. Preserve existing tested billing organization/location
   bindings, canonical entitlement projection and explicit recurring-charge consent.
7. Prepare production SaaS billing support as a separate validated mode. The current
   adapter rejects live keys: do not simply remove that check. Separate sandbox/live
   configurations and object bindings, validate the approved live account/prices/
   webhooks, test mode rejection, and leave live activation off until M11 authorization.
8. Implement CFDI generation/customer self-service/cancellation only for approved
   enabled module scope with actual FacturAPI sandbox configuration and current
   official requirements. Protect fiscal/customer data and signed links; reconcile
   provider state and prevent duplicate invoices. No invented fiscal success.
   **Status:** built (migration 030) against Facturapi's documented API with contract
   tests and a deterministic fake ([CFDI](CFDI.md)); sandbox verification awaits a
   Facturapi test key; live awaits production approval.
9. Delivery connections follow import-first reconciliation from M7. Implement live
   Uber Eats/Rappi/DiDi only where authorized contracts and sandbox access exist;
   preserve order/channel/fee identities and credential isolation.
10. Implement configured loyalty/stamp/referral ledger with idempotent earning,
    redemption and refund reversal; keep it outside the critical payment path.
    Wallet passes and messaging remain optional follow-ons unless promoted explicitly.
11. Make capability settings and landing copy reflect the verified environment.
    Distinguish SaaS Stripe billing from restaurant Stripe payments; remove stale
    'coming soon' wording only when the specific workflow is actually qualified.

**Exit:** complete tenant/role/security boundary tests, UX-13–UX-14, configured
provider evidence and an accurate capability inventory. External blockers remain
named with prerequisites; mocks do not satisfy them.

**Account 031 status (October 5, 2026, local only).** M8.1 ownership transfer
and last-owner protection (owner-seat changes only through the account console;
the team screen refuses owner role changes and deactivation), co-owners and
access revocation: **implemented locally**. M8.2 recovery: **partial**
(single-use recovery codes and support-assisted transfer; verified email
recovery, account linking and the password fallback pending). M8.6 in-app
reminders (trial and support grant ending, failed payment, Pro ended, drawer
continuation): **implemented locally**; email reminders pending a verified
sender. M8.11 landing truth pass (QR/kiosk claims follow
`PUBLIC_ORDERING_ENABLED`; kitchen-note examples shown, verified by service 024):
**implemented locally**. Platform legal documents with versioned acceptance,
owner data export and the vendor support CLI are new and documented in
[account and legal](ACCOUNT_AND_LEGAL.md). None of it is staging-qualified;
the legal entity values and counsel review are user hand-off items.

## M9. Data migration, restore and operational readiness

### Source migration

Pinned references remain POS Lite `0ae96c930fa417c4f77232ceb26882ee0e9e75d8`
and Luma `d55d5eb10aed119df5287ddd283e15bf08d4694f`. Neither source's code archive
is a production database export.

1. Obtain specifically approved sanitized exports/schema metadata, source/target
   tenant mapping, currency/timezone and coverage periods. Do not connect to source
   production or freeze source writes without explicit authorization.
2. Implement adapters for identities/membership enrollment, catalog/modifiers,
   historical orders/payments/refunds, allocations where known, inventory/opening
   balances, recipes/costs, expenses/summaries, cash/shifts and provider references.
   Preserve unknown fields as unknown; use durable source mappings, not names.
3. Stage/preview mappings and exceptions before commit. Report counts by entity,
   tenant/status, money by currency/business day, stock by unit/lot, duplicate/orphan
   cases, source hashes and unresolved overlap.
4. Rerun and kill/resume imports. Accepted counts/totals/IDs must remain unchanged;
   no kitchen, stock-consumption, print, payment, invoice, email or subscription
   side effects may be replayed. Preserve existing provider subscription ownership.
5. Rehearse final delta/watermark and post-cutover reconciliation. Record ownership
   of transactions across systems. Reconcile before routing traffic. Complete MIG-01/02.

### Restore, deployment and operations

1. Restore an isolated Neon staging backup into a distinct approved restore target;
   do not overwrite active staging to rehearse. Check client/server PostgreSQL
   compatibility, all migrations, role grants/RLS, billing bindings, inbox/jobs,
   recovery records, source mappings, allocations, money and stock control totals.
2. Disable outbound providers/worker delivery and isolate sessions/secrets on the
   restored copy before starting it; a restored pending job must not charge or send.
3. Run login/tenant isolation, sale, refund, report and recovery checks on the copy.
   Record measured recovery duration and actual recovery point; do not invent RTO/RPO.
4. Rehearse an application rollback on a separate isolated environment using the
   previous schema-compatible image. Destructive DB rollback is not the strategy.
   Preserve all transactions accepted after a deployment or cutover.
5. Separate migration/provisioning privileges from the web runtime where platform
   support allows. Verify runtime roles cannot own tables, bypass RLS or write
   billing entitlements. Restrict billing-worker privileges to its intended scope.
6. Validate the Docker artifact, environment-specific health/readiness, exact version,
   bounded DB timeouts/pools, shutdown draining and restart behavior. Verify current
   Railway configuration support from official docs; the repository records a
   December 1, 2026 format transition warning, which needs fresh verification.
7. Add privacy-safe structured logs, request IDs, metrics and actionable alerts for
   health, error rates, latency, unknown payments, webhook/job age, stale KDS, sync
   conflicts, stock variance and backup failures. Test alert delivery to an explicitly
   approved recipient. Do not enable automatic destructive remediation.
8. Write runbooks for opening/closing, refunds, Free downgrade, offline recovery,
   printer failure, provider outage, billing review, member revocation, secret
   rotation, restore, rollback and incident escalation. Name operational ownership
   and support paths supplied by the user; do not invent an on-call team.

**Exit:** restore/rollback and migration reconciliation artifacts are complete on
isolated targets. Any missing real exports/hardware/provider inputs remain release
blockers for their required scope, with ready-to-run tools and exact input requests.

## M10. Final qualification of one release candidate

Freeze the candidate revision for qualification. New fixes invalidate only the
relevant checks plus required integration regression; record which evidence was
rerun. Never mix test evidence from different revisions into one unqualified claim.

1. **Build/CI:** clean locked install, typecheck, lint, all discovered unit/service/
   isolated DB/HTTP/browser checks, migration/grant checks, production build and
   deployed Docker image. Include all new suites in CI, not just ad hoc commands.
2. **Security:** two-tenant/organization isolation, all roles, missing tenant context,
   CSRF/session fixation/revocation, invitation/linking takeover, API/header/ID
   tampering, RLS/grants, privileged credential separation, webhook replay/signatures,
   upload/export boundaries, rate limits and dependency/secret scan. Fix actionable
   findings without inventing unrelated compliance certifications.
3. **Recovery:** rerun OFF-01–08, provider restart/unknown results, duplicate delivery,
   print uncertainty, billing expiry/downgrade and all append-only financial/stock
   invariants on the candidate.
4. **Pilot dataset/load:** fictional two-tenant fixture, 300 catalog items with
   realistic modifiers, 50 active orders, dated reporting history; ten concurrent
   users. Measure cold and warm behavior separately. Target cached add-item feedback
   ≤100 ms, warmed core reads p95 ≤400 ms, mutation APIs p95 ≤700 ms under the stated
   pilot conditions, KDS appearance ≤2 s on a healthy network. Record local versus
   cloud conditions and provider waiting time separately. Optimize measured bottlenecks.
5. **UX:** after selecting items, exact-cash checkout needs at most three primary
   activations. Measure task timings/steps; do not claim percentage improvement
   over the source apps without a safe measured baseline.
6. **Accessibility/localization:** all core workspaces at 1440×900, 1024×768,
   768×1024 and 390×844; keyboard, focus/dialog restoration, screen-reader announcements,
   reduced motion, contrast, tap targets, horizontal overflow, complete ES/EN, currency
   and timezone semantics. Axe success is supporting evidence, not certification.
7. **Provider/device:** attach separate real sandbox and hardware evidence for every
   enabled provider/device flow. Verify absent providers remain disabled and core
   cash POS remains usable without them.
8. **Evidence:** record candidate SHA, immutable build/upload manifest, migrations and
   grants, target identifiers, commands/results, fixture IDs, screenshots, latency
   distributions, reconciliation reports, restoration/rollback results and limitations.
   Store secrets/raw business backups only in restricted ignored storage.
9. Update README and current summaries in handoff, delivery, acceptance, staging and
   release documents. Every required acceptance row must pass or remain an explicit
   release blocker. Never turn `partial` into `verified` based on an adjacent subset.

**Exit:** produce `docs/RELEASE_CANDIDATE.md` with a go/no-go decision and linked
supporting artifacts. A no-go decision includes exact blocked criteria and concrete
remaining inputs; it is not permission to deploy or a claim that the product is done.

## M11. Live approval, launch and completion

Prepare everything reviewable before asking for live approval:

- Named production app/database/account/domain and proposed enabled modules.
- Exact immutable revision/build and schema compatibility.
- Source/target tenant mapping, migration/delta reconciliation and cutover window.
- Provider mode, live billing activation/customer consent and beta-pilot treatment.
- Backup, rollback/reconciliation steps, observation period, failure thresholds,
  operator contacts and any measured recovery limitations.

Ask once for the missing explicit live authorization. Prior sandbox or staging
permission is insufficient. If not approved, stop at a qualified release candidate
and report the remaining launch decision without pretending the live launch occurred.

After approval, execute the rehearsed runbook, verify health/version/migrations,
owner and staff access, a specifically authorized smoke transaction and its cleanup/
reversal, printer/provider states, queue/job/webhook health and reconciliation. Do
not test live charges unless that exact action is authorized. Monitor for the agreed
observation window using the application's supported scheduling tools if follow-up
is requested; do not promise background monitoring without creating it.

Final completion package: release URL/revision, operating instructions, support/
incident procedure, tested feature matrix, migration and restore evidence, known
optional follow-ons, provider/hardware scope, billing policy and credential-rotation
ownership. Preserve the previous system's evidence and post-cutover transaction
reconciliation path until the approved retention period ends.

## 5. External input register

Prepare these requests early during M3; do not block unrelated local work. Ask for
secrets through private configuration, not pasted into chat or the handoff.

| Input | Needed for | Until supplied |
| --- | --- | --- |
| Approved pilot workflows and configured integration list | Concrete deployment scope | Keep all required core work; leave unspecified providers disabled |
| Printer model/connectivity and accessible test device | Thermal/kitchen printing proof | Implement bridge/contracts and simulated faults; hardware gate blocked |
| Restaurant merchant sandbox and terminal ownership | Integrated customer payments | Build/test provider-independent lifecycle; no guessed charge requests |
| R2 bucket/domain and scoped access | Menu/tenant photo assets | Build authorized upload boundary; no production local-disk fallback |
| Verified Resend sender and test recipients | Recovery/verification/reminders/summaries | Implement durable jobs/templates; outbound sending disabled |
| Apple developer configuration | Apple sign-in | Keep hidden/unavailable; complete Google and independent account work |
| FacturAPI sandbox and verified fiscal requirements | Enabled invoicing | Implement scoped contracts/tests; no fiscal-success claim |
| Marketplace contracts/exports/sandbox access | Delivery imports/live connectors | Normalized import-first tooling; live connections disabled |
| Tax display/configuration and tip/payroll business policy | Operational financial behavior | Version configuration; no invented legal defaults |
| Approved source exports/schema and tenant/period mapping | Actual legacy migration | Complete fixture adapters; real reconciliation remains blocked |
| Live target, domain, window, accounts and approval | M11 cutover/live billing | Staging and release-candidate preparation only |
| Operational contacts and recovery/retention objectives | Alert/runbook acceptance | Record measured behavior; do not invent staffing or guarantees |

## 6. Verification commands and execution protocol

Existing commands (run from the repository using Node 24):

```sh
source /Users/juan/.nvm/nvm.sh
nvm use 24
npm run typecheck
npm run lint
npm test
npm run test:db
npm run build
```

Use `bash scripts/compiled-local.sh` only after checking port/process ownership;
then `bash scripts/browser-check.sh` targets the compiled same-origin server.
Do not kill another task's server. Browser fixtures target local dev, whereas
isolated DB suites must target an explicitly allowlisted `_test` database.

Targeted existing suites that the next agent must include in documented runners:

- `tests/google-attempts-db.ts`
- `tests/owner-accounts-db.ts`
- `tests/owner-management-db.ts`
- `tests/entitlements-db.ts` (currently local-only target validation)
- `tests/billing-db.ts` (inspect its separate role/fixture prerequisites)
- `tests/free-limits-db.ts`
- New `tests/offline-recovery-db.ts`, HTTP recovery and browser recovery scenarios.

For suites using `isolatedTarget`, supply both `TEST_DATABASE_URL` and
`TEST_MIGRATION_DATABASE_URL` plus exact runtime host allowlist; Neon additionally
requires `TEST_MIGRATION_DATABASE_HOST_ALLOWLIST`. Never guess URLs by replacing a
production suffix or pooled hostname. Some saved env files lack the explicit test
migration variables; configure them privately for the known test target.

Deploy/test scripts under `tests/staging-*.ts` and `scripts/staging-smoke.mjs` need
separate exact staging allowlists and fictional fixture authorization. Inspect their
prerequisites before running; never assume they are generic production smoke tools.

For each milestone:

1. State the concrete outcome and dependencies.
2. Inspect current code/evidence before changing it.
3. Implement one coherent vertical slice using shared services and forward migrations.
4. Add meaningful failing-then-passing regression tests for money, isolation,
   permissions, concurrency or recovery behavior.
5. Run relevant checks, then the integration gate for that milestone. Do not keep
   rerunning unrelated passing suites without a new change or concern.
6. Record exact results and limitations, create a coherent local implementation
   checkpoint, update the requirement ledger and handoff, then continue.
7. At an external block, finish all preparation/testing possible and name the exact
   input needed. Continue independent work. Never invent verification or reduce scope.

## 7. Copyable instruction for the execution agent

> Read `docs/PRODUCT_COMPLETION_PLAN.md` completely, then its baseline references.
> Work in `/Users/juan/Developer/green-monkey` and preserve the intentional uncommitted
> Free-limit and offline-recovery changes. Verify actual status before edits; HEAD
> alone does not include this work. Execute M0 through M10 in order, starting with
> closing Free limits and finishing offline/payment recovery. Track every required
> feature and acceptance criterion, continue useful work through external blockers,
> and distinguish local, Neon, staging, sandbox and hardware evidence. Preserve all
> approved architecture, branding and commercial decisions. Do not rewrite applied
> migrations, access source production, charge live customers or perform production
> cutover without the specific authorization described in M11. Finish with a verified
> release candidate and concrete launch approval package; perform M11 only when its
> required authorization exists. Update the handoff at each milestone so another
> agent can resume without losing work or repeating settled decisions.
