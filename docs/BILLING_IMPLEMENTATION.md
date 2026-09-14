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
