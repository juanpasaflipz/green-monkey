# Sandbox billing qualification — September 14, 2026

**Item 1 core sandbox flow is qualified on staging.** Deployment
`d0178bd6-4861-43e1-8699-e4056e6d5587` serves commit
`fc939bcded08c5d5992a3e48096e3210a99e2659`; migrations through 013 and restricted
billing credentials are installed. Real deployed signup created a no-card trial,
Pro access, and processed signed Stripe events. Adding a test card through Portal
kept the subscription and trial end unchanged. Railway logs confirm restart;
a previously queued operation completed afterward. Canonical cancellation and its
webhook returned the restaurant to Free. Evidence: `evidence/staging/billing.json`
and `evidence/staging/billing-restart.json`. The synthetic fixture is retained.

This qualifies sandbox behavior, not live billing, tax configuration, production
release, or additional billed locations. Live keys are rejected. In-app trial
reminders work during the final three days; email requires a verified sender.
Uncertain creation operations older than 23 hours stop in `review` so Stripe's
finite idempotency retention cannot cause duplicate subscriptions. An operator
must reconcile those provider objects before changing their state; never generate
a fresh creation key to bypass review. No live customers were charged.

The continuation is now item 2: multi-location creation, invitations and switching.
The implementation checkpoint below is historical.

## SaaS tax mode and lapse handling (account 031, implemented locally)

Status: implemented and unit-tested with synthetic Stripe responses; **not**
run against the Stripe sandbox, and live billing stays disabled (v1 production
launches without billing; pilots get Pro from the support CLI's
`grant-entitlement`, see [operations](OPERATIONS.md)).

- `SAAS_TAX_MODE=off` (default): provider requests are byte-for-byte unchanged.
  Plan settings, the billing consent and the location quotes say "Precio antes
  de impuestos. El IVA y la factura (CFDI) de la suscripción aún no están
  configurados." instead of "más impuestos aplicables".
- `SAAS_TAX_MODE=tax_rate`: the **worker** (which runs the provider loop)
  requires `STRIPE_TAX_RATE_ID=txr_…` and validates it on first use (active,
  exclusive, 16 %, country MX, test mode in the sandbox). Trials send
  `default_tax_rates[0]`; Checkout sends `subscription_data[default_tax_rates][0]`
  and, with `SAAS_COLLECT_TAX_ID` (default true in this mode),
  `tax_id_collection[enabled]=true`, `customer_update[name]=auto`,
  `customer_update[address]=auto` and `billing_address_collection=required`.
  Location quotes include the tax through the subscription's default rates. The
  UI shows "MXN 799 + IVA 16 % = MXN 926.84". The web reads only the display
  variables (`SAAS_TAX_MODE`, `SAAS_COLLECT_TAX_ID`, `SAAS_TAX_PROFILE_ENABLED`).
- `npm run stripe:tax-rate:sandbox` creates or reconciles the sandbox IVA rate
  (Tax Rates are immutable in percentage and country) and writes
  `.env.stripe-tax-rate` (mode 0600) for the worker. It creates no customer,
  subscription or charge. Stripe Tax is not used (Mexico border rates are not
  supported there).
- **Live-billing tax guard:** `assertSaasTaxReady(env, legal)`
  (`server/saas-tax.ts`) refuses (`saas_tax_required_for_live_billing`) unless
  the worker runs `SAAS_TAX_MODE=tax_rate` and the published legal entity has an
  RFC. Live keys are still rejected everywhere today; the post-launch live
  adapter must call this guard before accepting one. The accountant's
  confirmation of IVA treatment is on the launch hand-off list.
- **Canceled subscriptions:** reconciliation uses the subscription's
  `ended_at` (when it actually ended) as `access_until` for canceled
  subscriptions, not `canceled_at`.
- **Lapse:** when Pro ends, registers with a drawer opened in the last 16 hours
  keep selling until they close it (drawer continuation); notices warn 7, 3 and
  1 days before a trial or support grant ends. See
  [account and legal](ACCOUNT_AND_LEGAL.md) and [Free limits](FREE_LIMITS.md).
- **Deferred:** SaaS CFDI for the subscription (no flag exists; the optional
  tax profile, `SAAS_TAX_PROFILE_ENABLED`, only stores receptor data) and the
  `billing_requests` inbox (DB-1), reassigned to the post-launch billing area.

## Earlier implementation checkpoint

Item 1 is in progress. New local implementation includes migrations 011–013,
organization billing/location bindings, immutable durable operations, retry leases,
stale-worker fencing, a signed-event inbox, canonical subscription reconciliation,
Checkout session polling, owner/CSRF routes, saved signup trial preferences and
Spanish/English sandbox billing controls. Billing stays disabled unless
`BILLING_SANDBOX_ENABLED=true` with a separate restricted `BILLING_DATABASE_URL`,
sandbox keys/prices, `STRIPE_PORTAL_CONFIG_ID` and `STRIPE_WEBHOOK_SECRET`.
The worker login must be a member of the NOLOGIN `gm_billing_worker` role and
connect to the same pooled database as the POS using different credentials.
The POS role cannot write entitlements or billing events.

Real sandbox checks now passed for a no-card 14-day trial, same-key creation
retry, canonical Pro projection, cancellation and return to Free. A dedicated
portal configuration permits payment-method changes, invoice history and
period-end cancellation; subscription price/quantity updates are disabled.
Portal session creation, annual Checkout creation/retry, session retrieval and
explicit expiry passed. A monthly Checkout payment also completed in the browser using Stripe’s test card; the canonical subscription granted bounded Pro and was then canceled. No live payments occurred.
Evidence: `evidence/stripe-sandbox-trial.json` and
`evidence/stripe-sandbox-hosted.json`, plus `evidence/stripe-sandbox-paid.json`. Private check state is under ignored `work/`;
portal ID is in ignored `.env.stripe-portal`.

Local database tests pass ownership isolation, six concurrent requests, immutable
payloads, one worker per organization, expired lease recovery, stale completion
rejection, one-trial enforcement, duplicate-event inbox, isolated access writes,
past-due revocation and 23-hour uncertain-mutation review. HTTP checks pass missing
owner/foreign-owner/CSRF denial, raw signed webhook acceptance, duplicate IDs,
tamper rejection and no direct grants from event snapshots. 108 unit tests pass.
Typecheck, lint and build pass. All 13 browser scenarios pass, including a billing
UI consent fixture and accessibility scan; 17 Neon operational checks also pass.
Migrations 011–013 are applied to local dev/test and Neon test. Neon billing and
owner tests pass, including corrected fixture-role cleanup.

Remaining before declaring item 1 complete: trial payment-method consent,
deployed webhook/restart verification and safe review
of uncertain operations. In-app reminders appear during the final three trial days; external email reminders
remain unavailable without a verified sender. Staging still runs the prior
application without billing. Its restricted billing login and Stripe webhook have
been provisioned, with credentials saved privately, pending rollout.
No move to item 2 or production readiness is claimed.

---

# Subscription provider foundation

September 14, 2026: local sandbox adapter only. No billing route, subscription
activation, entitlement writes or external provider verification is enabled.
Existing Free signup, approved pricing, branding and uncommitted work are retained.

`server/stripe-billing.ts` implements account-checked sandbox Customer, trial,
Checkout and Customer Portal requests. It validates organization/customer scope,
configured approved prices, location quantity, returned provider identifiers and
hosted URLs. Mutation calls require caller-supplied operation UUIDs and reuse
provider idempotency keys. API requests explicitly use `2026-08-26.dahlia`.

Canonical subscription reads validate the saved subscription/customer/organization
binding, sandbox mode, MXN price and location quantity before deriving bounded
access. Trial end and cancellation cap expiry. Past-due does not automatically
grant an unpaid renewal period; the proposed seven-day grace is not enabled.
This projection is not yet persisted to `restaurant_entitlements`.

`server/stripe-webhook.ts` verifies HMAC-SHA256 against original raw bytes with
constant-time comparison, a five-minute delivery timestamp tolerance and rotating
v1 signatures. It rejects live and connected-account events. Subscription events
yield only a subscription reference; event snapshots and Checkout redirects never
grant access. Signature verification alone does not deduplicate deliveries.

## Required next integration

1. Durable organization billing/customer bindings and explicit billed locations.
   The existing entitlement schema has unique customer/subscription IDs per
   restaurant; organization billing needs a new forward migration, not broader
   writes to that schema or edited historical migration checksums.
2. Persist immutable operation payloads and IDs before network calls, serialize
   organization provisioning, and enforce one trial per organization. Never
   create Checkout subscriptions while a trial or another subscription exists.
   Upgrade an existing trial through its existing subscription with consent.
3. Recover uncertain provider operations using their saved keys and canonical
   objects; Stripe idempotency retention is finite, so do not blindly replay an
   old creation request indefinitely. Complete Free signup during outages.
4. Durable verified-event inbox, duplicate IDs, retry leases, canonical fetch
   outside transactions, and version-checked reconciliation that prevents older
   concurrent fetches overwriting newer state. Preserve the read-only POS runtime
   entitlement boundary. Handle invoice/payment-driven reconciliation too.
5. Authorized owner routes with CSRF, billing status UI, approved consent and tax
   treatment, trial reminders, downgrade and Free-limit recovery workflows.
6. Configure the dedicated sandbox, then verify actual trial, Checkout, Portal,
   duplicate/out-of-order events and restart recovery before enabling controls.

The dedicated Green Monkey sandbox is configured under Injupe, account
`acct_1UFZZRFYpuQNRtU1`. `.env.stripe-sandbox` stores the sandbox secret,
expected account and publishable key; `.env.stripe-price-ids` stores both validated
Price IDs. Both files are ignored and mode 0600. No keys were installed in staging
or frontend bundles. No webhook endpoint/signing secret is configured because the
durable receiving route is still pending.

Actual catalog provisioning and a second reconciliation run passed against Stripe.
The prices are MXN 79,900 minor units monthly and 799,000 annually with exclusive
tax behavior. Evidence: `docs/evidence/stripe-sandbox-catalog.json`. No customers,
subscriptions or charges were created. Other sandboxes and live configuration
were preserved. On Node 24, rerun with:

```sh
node --env-file=.env.stripe-sandbox --import tsx scripts/stripe-sandbox-catalog.ts
```

## Verification and contracts

94 unit tests pass, including 47 new sandbox billing/webhook tests using synthetic
responses. Typecheck and lint pass. Tests cover wrong account/organization/price,
live mode, uncertain response retries, hosted URL validation, bounded access,
canonical cancellation despite a stale active event, and signed webhook tampering,
timestamp expiry, key rotation and scope rejection. This is not a database inbox,
real sandbox or end-to-end billing verification.

Provider contracts consulted:
[API versioning](https://docs.stripe.com/api/versioning),
[subscription object](https://docs.stripe.com/api/subscriptions/object),
[trial behavior](https://docs.stripe.com/billing/subscriptions/trials),
[Checkout](https://docs.stripe.com/api/checkout/sessions/create),
[Customer Portal](https://docs.stripe.com/api/customer_portal/sessions/create),
and [webhook signature verification](https://docs.stripe.com/webhooks).
