# Live billing (Stripe, real charges)

Live billing charges restaurants for Pro (MXN 799 a month or MXN 7,990 a year per location,
plus 16 % IVA) through the owner's live Stripe account. It reuses the sandbox flow that
qualified on staging ([BILLING_IMPLEMENTATION.md](BILLING_IMPLEMENTATION.md)): the 14-day
no-card trial, Checkout, the Customer Portal, signed webhooks, the durable operation queue
and the canonical entitlement projection. Only the mode changes.

Status: implemented and unit-tested with synthetic Stripe answers. **Not yet run against a
live account.** It stays off until the owner completes "Owner setup" and the first-charge
check below.

## The switch

| Variable                       | Where          | Meaning                                                                 |
| ------------------------------ | -------------- | ----------------------------------------------------------------------- |
| `BILLING_LIVE_ENABLED=true`    | web and worker | Live Stripe. Production only (`billing_live_production_only` elsewhere) |
| `BILLING_SANDBOX_ENABLED=true` | web and worker | Stripe test mode, as before                                             |

The two never combine (`billing_mode_conflict`): one deployment talks to one Stripe mode.
Anything other than `true`, `false` or empty in `BILLING_LIVE_ENABLED` stops the process
(`billing_mode_invalid`). Staging keeps the sandbox, so staging can never charge a card.

## What live mode refuses

At startup (`server/config-rules.ts`), on both web and worker as applicable:

- a test key (`sk_test_`/`rk_test_`) on the worker: `stripe_live_key_required`;
- `SAAS_TAX_MODE` other than `tax_rate`, on web or worker: `saas_tax_required_for_live_billing`;
- on the worker, legal values that are unpublished or lack an RFC:
  `saas_tax_required_for_live_billing`. The worker now declares the `LEGAL_*` values
  (`.railway/railway.ts`); they must be the same as the web's, since the RFC is the
  subscription CFDI's issuer.

At runtime (`server/stripe-billing.ts`, `server/stripe-webhook.ts`): every Stripe object
read back (account, customer, price, tax rate, subscription, invoice, Checkout and Portal
sessions) and every webhook event must say `livemode: true`; a Checkout session id must start
`cs_live_`. A sandbox deployment refuses live objects and events in the same way. The sandbox
behaviour is otherwise unchanged.

The owner screens say "sandbox" and "no real payments are charged" only when the server
reports `mode: "sandbox"`.

## DB-1: the billing login on production web

Production web refused `BILLING_DATABASE_URL` unless sandbox billing was on (RUNBOOK.md, "Open
follow-ups", DB-1). It now accepts it while billing is on in either mode, and still refuses it
while billing is off. Web uses that login only for the owner billing commands and the webhook
inbox, as it did on staging. Removing it from web altogether (the `billing_requests` inbox)
remains the DB-1 follow-up. **This is an accepted risk the owner must confirm before go-live.**

## Owner setup

Only the owner does these, in order. Keys never go into a chat, a PR or a document.

1. **Activate the live account** under the RESICO profile: business details, identity check,
   payout bank account, public business name and statement descriptor "Green Monkey". Note
   the account id (`acct_…`, not a secret).
2. **Create a restricted live key** for the worker, or use the secret key.
3. **Products, prices and IVA**, on your own machine with the key in your shell only:

   ```sh
   STRIPE_SECRET_KEY=… STRIPE_EXPECTED_ACCOUNT_ID=acct_… \
     npm run stripe:live:setup -- --confirm-live=acct_…
   ```

   It creates or reconciles product `green_monkey_pro_v1`, the two MXN prices (exclusive of
   tax) and the IVA 16 % rate, and writes their ids to `.env.stripe-live` (mode 600). It
   creates no customer, subscription or charge. Rerunning it is safe.

4. **Customer Portal configuration** in the Dashboard: payment-method changes, invoice
   history and cancellation at period end; price and quantity changes off. Note its `bpc_…` id.
5. **Webhook endpoint** in the Dashboard: `https://app.greenmonkey.online/api/billing/webhook`,
   API version `2026-08-26.dahlia`, events `customer.subscription.created`, `.updated`,
   `.deleted`, `.paused`, `.resumed`, `.trial_will_end`, `invoice.paid`,
   `invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible`. Keep its
   signing secret (`whsec_…`).
6. **Production variables** with `scripts/ops/railway-vars.sh production`:
   - worker: `STRIPE_SECRET_KEY`, `STRIPE_EXPECTED_ACCOUNT_ID`, `STRIPE_PRICE_PRO_MONTHLY`,
     `STRIPE_PRICE_PRO_ANNUAL`, `STRIPE_TAX_RATE_ID`, `STRIPE_PORTAL_CONFIG_ID`, the `LEGAL_*`
     values (the same as web's), `BILLING_DATABASE_URL`;
   - web: `STRIPE_WEBHOOK_SECRET`, `BILLING_DATABASE_URL`;
   - both: `SAAS_TAX_MODE=tax_rate`, then `BILLING_LIVE_ENABLED=true` last.
7. **Deploy** outside service hours and check that web and worker started (a refused
   configuration stops the process with the code above).

## First-charge check

On production, with your own card, before announcing paid Pro:

1. A new test restaurant: the trial starts without a card; Plan shows Pro and the trial end.
2. Subscribe monthly through Checkout: the price shows MXN 799 + IVA = MXN 926.84; the
   restaurant stays Pro; the webhook delivery shows 200 in the Dashboard.
3. The Portal opens for that customer only.
4. Cancel in the Portal and refund the charge in the Dashboard; the restaurant returns to
   Free at period end.

Record the result (ids only) before switching paid Pro on in the announcement.

## Not covered here

- The CFDI for each subscription payment (issued by the owner under RESICO): a separate area,
  waiting on the accountant's SAT keys and retention answers.
- Trial-ending emails: they need a verified sender; in-app reminders work.
