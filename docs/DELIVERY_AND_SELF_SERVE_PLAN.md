# Delivery connections and self-serve activation

Design proposal, 2026-10-17. The landing changes advertise current capabilities with activation requirements; this document describes work still to implement. No delivery partner has been contracted or validated, and no new billing or provisioning behavior ships with the landing update.

## Current foundation

- Kiosk/QR promotion follows `/api/account-config.publicOrdering.enabled`. Orders paid at the counter are the conservative public promise.
- KDS already routes station tickets and preparation states.
- `server/cfdi/` implements fiscal workflows. Live issuance still requires issuer setup, CSD, provider activation and qualification; see `CFDI.md` and `BETA_READINESS.md`.
- Clip PinPad and Mercado Pago Point adapters exist in `server/payments/worker/`; accounts and compatible devices must be connected and validated. These are not arbitrary terminal integrations.
- `server/payments/settings.ts` already supports platform-specific prices, commissions and platform-paid tenders. Recording a sale does not import or acknowledge a delivery order.
- `server/billing-store.ts`, `billing-worker.ts` and `stripe-billing.ts` already provide durable billing operations and reconciliation. Extend these, rather than creating a second subscription system. Subscription payment and restaurant customer payments are separate flows.

## Recommended delivery route

Use a managed channel aggregator first. Green Monkey maintains one partner integration; tenants authorize their store connections rather than acquiring developer API keys. This is not an API-free integration: Green Monkey still needs an aggregator agreement and credentials. Start with a Deliverect feasibility pilot, subject to commercial terms and Mexican store coverage.

Deliverect documents Uber Eats, Rappi and DiDi Food activation, including menu prerequisites and provider delays. Confirm all three for Mexico, merchant eligibility, embedded onboarding, pricing per location, cancellation/refund semantics, menu ownership, support responsibility and webhook/API access before selecting it. Published channel support alone does not prove our integration is ready.

| Route                                                      | Tenant experience                                                            | Decision                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Aggregator                                                 | Authorize store, confirm menu mapping, wait for activation when required     | Preferred first pilot; fewer separate integrations            |
| Direct marketplace APIs                                    | Merchant consent plus platform partnership and approval                      | Later option where access and economics justify it            |
| Manual platform recording                                  | Staff enter order/reference and platform-paid tender                         | Existing fallback; no automatic order claim                   |
| Browser scraping or unattended merchant-session automation | Persistent logged-in sessions, breakage and ambiguous order acknowledgements | Do not use as the foundation for a seamless, reliable service |

A receipt/import assistant could reduce manual entry later, but remains a reviewed draft until confirmed. It cannot claim to accept an order, synchronize menus or refund a marketplace transaction. No TypeSafe call is needed to choose this architecture; no private merchant data was sent for evaluation.

## Minimal tenant journey

Target three short screens from the landing page:

1. **Create account and restaurant.** Authenticate, accept terms, name the location, confirm timezone and choose plan. Persist the selected plan server-side for resumption. Keep the existing Free path.
2. **Pay and activate.** Open hosted subscription checkout. On return, show “Confirming your subscription” until the server verifies payment and subscription eligibility. Automatically prepare the tenant's base workspace, permissions and default stations; show progress and retry safely after refresh.
3. **Make it yours.** Import or create a menu, then choose “Open POS”, “Open kitchen” or “Set up kiosk”. Offer optional connection cards for payments, CFDI and delivery. Reuse information already entered; request only missing consent, device selection, fiscal documents or menu mapping. Allow users to continue while a provider activation is pending.

No infrastructure deployment should be required per tenant. Use the existing multi-tenant application. A paid subscription can unlock the base workspace automatically; it cannot substitute for provider approval, fiscal certificates, merchant verification, device pairing or a restaurant menu.

## Activation implementation contract

- Bind authenticated account, organization, tenant and checkout operation before redirecting. Never derive ownership or paid status from browser parameters or untrusted metadata.
- Reuse billing reconciliation to establish verified payment and eligible subscription state; a successful redirect alone never grants entitlements. Handle delayed payment, failed payment, abandoned checkout, refund and subscription cancellation explicitly.
- Add a tenant setup state with resumable, idempotent steps: `awaiting_payment`, `preparing`, `needs_details`, `ready`, `attention_required`. Keep provider connection states separate: `not_connected`, `authorizing`, `pending_provider`, `active`, `action_required`, `disconnected`.
- Enqueue setup transactionally after confirmed billing, using a unique tenant/setup-version key. Retry via existing worker jobs and expose authenticated progress. Duplicate/reordered webhooks and a crash after payment must neither duplicate tenants nor charge again.
- Build one connection screen that uses provider authorization where actually supported. Clip's existing credential setup must not be relabeled as OAuth. Keep credentials sealed server-side, scope connections to the tenant, and expose revocation/reconnect controls.
- Persist provider/store bindings with tenant isolation. Only mark a connection active after authorization, store verification, menu mapping and a successful health check.
- Normalize delivery events into an inbox with unique `(connection_id, external_order_id, event_id)` deduplication and a separate unique order binding. Verify signatures, persist before acknowledging, reject unmapped stores and tolerate retries/out-of-order events.
- Map products/modifiers deterministically. Route unknown items to review; never silently substitute allergens or menu items. Keep marketplace monetary totals authoritative and exact.
- Create the POS order and station tickets once, then acknowledge through an outbox. Distinguish platform acceptance, kitchen acceptance and payment settlement. A platform-paid order must never trigger a second customer charge.
- Track cancellations, partial refunds, availability and connection failures explicitly. Preserve the manual fallback with a duplicate check on marketplace reference.

## Delivery sequence and acceptance

1. Qualify existing live billing, CFDI and payment adapters independently; retain beta messaging until evidence supports launch.
2. Implement the resumable checkout/setup flow using existing billing jobs. Test synthetic duplicate events, ownership mismatches, delayed/failed payment, disconnect, reload and worker restart.
3. Validate an aggregator sandbox, commercial terms and one Mexican pilot store per target channel. Start with incoming orders and status acknowledgements; enable menu publishing only after mapping and ownership are agreed.
4. Verify synthetic duplicate/reordered orders, unknown modifiers, cross-tenant events, cancellation, refund and provider outages. Require a single POS order/KDS ticket and no duplicate charge in each replay case.
5. Run an authorized real-store rehearsal before advertising automatic delivery synchronization. Measure completion rate, median/p95 setup time, user interactions, manual support interventions, order latency and duplicates. No assumed speed or one-click claims.

## Sources checked 2026-10-17

- [Uber Eats Marketplace introduction](https://developer.uber.com/docs/eats/introduction): API access may require written approval; POS integration covers menus/orders/stores.
- [Uber authentication](https://developer.uber.com/docs/eats/guides/authentication): scoped OAuth and store provisioning authorization.
- [Deliverect activation guidance](https://help.deliverect.com/en/articles/7978928-when-will-my-channel-be-activated): menu prerequisite; Uber self-serve/manual paths; DiDi Food and Rappi have activation windows rather than guaranteed immediate availability.
- [Stripe Terminal in Mexico](https://support.stripe.com/questions/terminal-in-mexico): public preview. Landing copy therefore says “coming to Green Monkey”, not “coming to Mexico”.
