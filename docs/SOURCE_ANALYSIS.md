# Source analysis

Reviewed on 2026-09-12. This is a static code and configuration review, not a production audit or a browser usability test. All 252 Luma files and 719 POS Lite files were indexed; the review focused on architecture, representative UI flows, order/payment/inventory services, migrations, integrations, and test setup. File indexing is not a claim that every line was manually examined. Neither application was started against its database, and no payment/hardware integration was exercised.

## Exact references

| Reference | Snapshot | Access |
| --- | --- | --- |
| [POS Lite](https://github.com/juanpasaflipz/pos-lite/tree/0ae96c930fa417c4f77232ceb26882ee0e9e75d8) | Default `master` at review; package version 1.24.0 | Public source |
| [Luma](https://github.com/juanpasaflipz/luma-app/tree/d55d5eb10aed119df5287ddd283e15bf08d4694f) | Supplied ZIP; commit verified through GitHub | Private source |

The archive SHA-256 and every indexed file's hash are in `reference/SOURCES.json`. No source repository or production infrastructure was modified.

## What each project contributes

| Area | POS Lite evidence | Luma evidence | Combined direction |
| --- | --- | --- | --- |
| Stack | `package.json`: React 18, Vite 5, Express 4, TypeScript, postgres.js, Dexie | `package.json`: Next 16, React 19, Supabase SSR, TypeScript, Zod | New React/Vite + Express/TypeScript application; one API and database |
| Deployment | `Dockerfile`, `railway.json`, `server/index.js`: API and SPA served together | `vercel.json`: weekly/monthly scheduled routes | Railway web/worker/jobs; translate Luma schedules |
| Tenancy/auth | `server/db/index.js`, `server/middleware/tenant.js`, `ownerAuth.js`, `auth.js`: tenant context, RLS, owner/employee auth | `middleware.ts`, `lib/supabase/server.ts`: Supabase auth, owner/operator/Luma admin roles | One identity/permission model with restaurant membership and RLS |
| Service | `src/screens/POSScreen.tsx`, orders/payments routes, kitchen, kiosk and customer ordering | `components/POS/POSScreen.tsx`, TablesManager, WaitersManager, ModifierModal | POS Lite breadth plus Luma's tables/waiter workflow, newly designed |
| Stock | `server/helpers/stockLedger.js`, `inventory.js`, prep routes, migration `0103_two_stage_inventory.js` | Inventory counts, merchandise receipts, waste review, recipes/substitutes | One ledger with raw/prepared inventory and recipe costs |
| Owner insight | Reports, expenses, recurring expenses, delivery, manual sales, organization routes | Dashboard, projections, fixed costs, break-even, alerts, PDF services | Transaction-based operational reporting plus explicit estimates/scenarios |
| Integrations | Payment/delivery adapters, R2, Resend, FacturAPI, wallets, Twilio/WhatsApp | Stripe, Resend, FacturAPI, Anthropic parsing, local printer bridge | Preserve provider families with explicit capability status |
| Reliability | Offline sync engine, unique offline ID migration, payment/stock/RLS tests, print jobs | POS events, queued printing, small CSV/date/projection test suite | Reuse requirements and verified patterns; consolidate implementations |

The two frameworks and database access patterns are incompatible as a direct folder merge. POS Lite is the infrastructure reference. Luma supplies workflows and domain concepts to translate, rather than a second runtime to retain.

## Findings that affect the new design

These findings describe the inspected snapshot. They are not assertions about a deployed service's current state.

1. **The POS Lite README understates the code.** Its exclusions list kiosk, menu boards, AI suggestions, and monitoring, while `kiosk/src/`, `src/screens/MenuBoardScreen.tsx`, `src/hooks/useAISuggestions.ts`, and `server/sentinel/` exist. The route registrations in `server/index.js` are more useful for scope than the marketing list. Presence alone does not prove feature completeness.
2. **Both main selling screens mix many concerns.** Luma's `components/POS/POSScreen.tsx` is 2,280 lines; POS Lite's `src/screens/POSScreen.tsx` is 1,745. Their local state covers catalog, carts, payment, splits, approvals, refunds, tables/delivery, and recovery. The rewrite should use focused feature modules and explicit state models. Line count alone does not prove bad usability; the overlapping workflows explain why redesigning the interaction structure matters.
3. **Luma's navigation spreads related work across many entries.** `components/Layout/Sidebar.tsx` has separate summary, operations, configuration, and POS groups. Inventory also has `/dashboard/inventario` and `/dashboard/inventory` routes. The new app needs one home for each task and role-based navigation.
4. **Luma's POS routes need a new authorization boundary.** `app/api/pos/orders/route.ts` reads a restaurant ID from the query/body; its GET has no visible session check, and POST checks schema and POS entitlement. `middleware.ts` excludes `/api`. `lib/services/pos.service.ts` uses the admin client. These particular paths do not establish a caller's restaurant membership in the inspected code. The new API must authorize every operation server-side, including public/device flows.
5. **Luma accepts client money and numbers orders through a read-then-increment pattern.** `createPOSOrder` validates dish membership but inserts submitted `total_amount` and item payloads; it reads the previous order number then adds one. Replace with canonical server pricing and database-safe numbering, backed by concurrency tests.
6. **Luma's paid-order side effects can diverge.** `updatePOSOrder` launches `syncPOSSalesEntry` and `deductIngredientsForOrder` without awaiting them. Stock consumption goes into `waste_items` with `loss_type='sold'`; repeat paid transitions lack a visible deduction idempotency guard in that service. Use one stock movement model and durable transactions/jobs.
7. **Luma links recipes by dish name.** `lib/services/recipes.service.ts` explicitly documents that recipes have no FK to restaurant dishes. Cost sync uses a case-insensitive name match. The new model must use stable IDs and versioned recipe links.
8. **Count variance can be mistaken for loss.** `lib/services/inventory.service.ts` computes a review difference from prior count plus receipts minus current count; that particular formula does not deduct known sales/preparation. The new expected-stock calculation must include all intervening movements before suggesting a variance.
9. **Luma's forecast has an internal consistency problem.** `lib/services/projections.service.ts` projects profit separately from sales minus costs, applies only part of a positive profit trend to sales, and holds costs constant. Those forecast values can disagree. It also uses an absolute cash difference as projected loss. The rewrite must keep scenario arithmetic consistent and distinguish shortages from overages.
10. **POS Lite has good tenant-scoping machinery, with a dangerous fallback to avoid.** `withTenant()` uses a transaction-local setting, but `getConn()` falls back to `adminSql` if context is absent. Its runtime also builds a direct app-role URL by rewriting the base URL. Green Monkey should require explicit tenant context, explicit privileged entry points, and tested pooled/direct connection configuration.
11. **Order and payment logic remain distributed.** Creation and payment writers are present across orders, payments, kiosk, customer-order, and provider routes. `audits/ORDER_FLOW_CONSOLIDATION.md` describes consolidation work but is historical context, not proof every proposed phase landed. Establish one canonical service for each new domain.
12. **Offline recovery offers a strong starting point.** `src/lib/syncEngine.ts` recovers interrupted syncing orders and calls an atomic order-plus-cash endpoint; migration `0052_unique_offline_temp_id.js` handles uniqueness. It stops automatic attempts after a maximum count, so the new UX also needs visible recovery for exhausted retries, tenant/device scoping, and cross-tab coordination.
13. **Stock ledger behavior needs an explicit policy.** `server/helpers/stockLedger.js` records unclamped movements but clamps cached quantity to zero. Its comments intentionally preserve oversell as ledger/cache variance. Green Monkey should choose and document a consistent available/reserved/oversold model rather than inherit two values with unclear operator meaning.
14. **Clip is explicitly unverified in source.** `server/services/clip.js` says PinPad fields and amount units were inferred and contains sandbox TODOs. Preserve the adapter opportunity, not a claim that it is ready to charge customers.
15. **Configuration needs reconciliation.** POS Lite has a Node 20 Dockerfile and a `NIXPACKS` Railway config. Luma uses Vercel cron. A new Docker/Railway contract should pick one current build path, health checks, version stamping, and migration execution. Do not treat source configuration files as evidence of current dashboard settings.
16. **Legacy tests are not safe to run unchanged.** POS Lite's `tests/setup/env.ts` demands a hardcoded legacy Neon test endpoint; its global setup runs migrations. Luma's migrations reference base tables/views/auth schema not fully defined in the ZIP. Build isolated new test targets and a complete new baseline before running database tests.

## What was not established

No measured tap/time baseline, visual browser audit, actual Neon/Railway service settings, production schema completeness, live integration health, payment certification, fiscal compliance, production secret inventory, or source-to-source customer overlap was established. The handoff deliberately makes these implementation or migration verification tasks rather than invented facts.
