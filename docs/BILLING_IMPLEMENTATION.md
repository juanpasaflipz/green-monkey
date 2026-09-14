# Active continuation — September 14, 2026

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
