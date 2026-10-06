# Free, Pro and tenant signup

September 14 staging qualification: real Google sign-in → Free restaurant creation
→ POS entry → logout/return passed. Migrations 001–010 and saved Google credentials
are now on staging. [Evidence and remaining scope](TENANCY_QUALIFICATION.md).
Earlier statements below about missing Google staging verification are historical.

Latest provider checkpoint, September 14: dedicated Green Monkey sandbox
`acct_1UFZZRFYpuQNRtU1` created and credentials saved privately. Actual sandbox
catalog provisioning and rerun passed for both approved prices; see
[billing implementation](BILLING_IMPLEMENTATION.md) and
[provider evidence](evidence/stripe-sandbox-catalog.json). Historical statements
below about missing Stripe credentials are superseded. Subscription activation,
durable webhook integration and full sandbox flow verification remain pending.

Status: commercial policy approved by the owner on September 13, 2026. Free forever; Pro MXN 799 monthly or MXN 7,990 annually per restaurant location, before applicable taxes. Kiosk is included in Pro; no per-employee Pro fee. The 14-day trial requires no card and starts at restaurant creation, not identity authentication. Beta pilots stay free until promised Pro workflows are qualified. This is not a claim of enabled billing; implementation and verification are recorded below.

## Approved packaging

| Capability | Free forever | Pro and Pro trial |
| --- | --- | --- |
| Restaurant/register scope | One restaurant, one active POS device | Multiple POS devices; additional billed restaurant locations |
| Team | Owner plus two named employees; individual PINs and fixed roles | More employees, granular permissions, shifts and payroll summaries |
| Menu and selling | Categories, search, modifiers, basic combos, availability, notes, dine-in/takeaway/delivery tickets | Scheduled promotions, more advanced menu management and automation |
| Cash and manually recorded external terminal payments | Included | Included |
| Tables, rounds, split payments, refunds, receipts, cash opening/closing and paid-outs | Included | Included |
| Kitchen operations | Basic kitchen queue and acknowledgement | Kitchen/bar station routing, advanced device and printer management |
| Offline cash and recovery | Included for eligible authenticated sessions | Included with the same correctness/security limits |
| Menu sold-out controls | Included | Included |
| Inventory | Manual stock quantities and basic movements | Recipes, cost versions, purchasing, suppliers, prep, counts, waste and expiry workflows |
| Reporting | Daily sales, payment breakdown, cash differences and source records | Margins, costs, forecasts/scenarios, organization views, PDF/scheduled reports |
| Customer QR | Read-only menu | Ordering on shared order/pricing services |
| Self-service kiosk | Unavailable | Required Pro feature: paired device, scoped catalog, modifiers, idle reset, explicit order/payment states |
| Loyalty, delivery connectors, invoicing and AI parsing | Unavailable | Available only when the module is implemented, configured and provider-verified |
| History, data export, audit integrity and security | Included; no loss of records on downgrade | Included |

Do not cap completed order count or withhold refunds/history behind an upgrade. Provider transaction fees, messaging/AI usage and hardware are distinct from subscription inclusion. Use configured Stripe Price IDs validated against the approved amounts in `shared/plans.ts`: 79,900 minor units monthly and 799,000 annually, MXN, recurring per location, exclusive of applicable taxes. Annual savings are 159,800 minor units (two months, 16.7%); the 665.83 MXN monthly equivalent is display-only, never the amount charged each month. There is no permanent founder tier or per-employee Pro fee. One organization owns the Stripe Customer; explicit restaurant entitlements determine which locations receive paid access. The first implementation should use one consistent Pro plan across an organization's billed locations to keep quantities and access unambiguous.

## Trial and upgrade

The approved trial lasts 14 days from successful verified-owner restaurant creation. This gives two weekly service cycles without making an unsupported claim about optimal conversion. Show the exact expiry date and remaining days. Offer Free without a trial for owners who prefer it. One trial per organization; creating another location or linking another login must not reset it.

Create a Stripe Customer and trial subscription using configured Pro Price IDs and no required payment method. Choose cancellation when the trial ends without a payment method; Green Monkey then retains the Free account. Store a durable provisioning attempt and reuse idempotency keys so retries never create duplicate subscriptions. If Stripe is unavailable, complete Free signup, show trial activation as pending, and start the full trial only when Stripe confirms creation.

Adding payment details must present the plan, interval, recurring price and first charge date and obtain recurring-payment consent. Preserve the original trial end unless the owner explicitly chooses immediate upgrade. Do not create a second active subscription during trial upgrade. Show reminders three days and one day before expiry. Stripe's cancellation ends paid entitlement, not the restaurant's local tenant or historical records.

On expiry/cancellation, stop starting new Pro actions and new kiosk/QR orders. Preserve existing tickets, cash reconciliation, paid receipts, refunds and pending sync. A kiosk cart is unpaid until confirmed otherwise; show staff assistance when access expires. Already accepted orders remain available to staff. Do not erase extra employees, locations, recipes or device history; allow an owner to select the permitted Free register/team, retain read/export access and finish outstanding work. Proposed failed-renewal grace: seven days with billing notices, followed by Free limits; this is distinct from the bounded offline authorization lease.

## Signup and identity

Recommended owner entry points: Continue with Google, Continue with Apple, and a verified email/password fallback with recovery. Employee access remains paired-device PIN; staff do not need their own Stripe or social accounts.

Google/Apple authenticate identity. Stripe handles billing; Apple Pay/Google Pay are payment wallets and do not replace sign-in. Use Google Identity Services and Sign in with Apple on the same backend identity/session service. Keep Neon as the only application database and existing signed sessions/CSRF/device checks. No Supabase runtime or second auth dashboard is introduced.

Signup sequence:

1. Authenticate and verify the owner's identity.
2. Create a global identity and explicit organization membership. Match provider issuer/subject, not display names. Apple relay email must not merge accounts automatically. Link another provider only after authenticated proof of both accounts.
3. Ask for restaurant name, locale/currency/timezone and operating settings, defaulting to Spanish/MXN/America/Mexico_City; create tenant and owner membership transactionally. Generate tenant IDs server-side. **Implemented (account 031):** the simplified privacy notice sits next to the Google button, and the restaurant is created only after the owner accepts the Terms and the organization's data processing agreement and acknowledges the privacy notice, all recorded with their versions in `legal_acceptances`. While the legal documents are unpublished, new accounts are refused (`signup_paused`) unless the non-production `LEGAL_UNPUBLISHED_SIGNUP=allow` override applies. See [account and legal](ACCOUNT_AND_LEGAL.md).
4. Activate Free or initiate the Pro trial with the durable Stripe provisioning operation.
5. Import/add menu, pair the first register and open a drawer. Show account scope and trial state clearly.

Use Stripe-hosted Checkout for paid subscription purchase/consent and Customer Portal for card changes, invoices and cancellation. Server-authorized sessions must select the organization's stored Stripe Customer and configured prices; never accept arbitrary client customer or price IDs. A checkout redirect does not grant Pro. Verify webhook signatures, deduplicate events, reconcile out-of-order events with canonical Stripe state and persist entitlements server-side. Stripe subscription charges stay separate from restaurant customer tenders, tax, tips and refunds.

## Kiosk entitlement

Kiosk is required Pro, including during an active trial. Check entitlement on pairing, credential renewal, catalog access where appropriate and every new order command; hiding a navigation item is insufficient. Combine plan eligibility, role/device permission and verified integration configuration. Signed kiosk credentials must not become permanent Pro access after expiry.

The existing kiosk ordering code is a partial implementation, not a completed commercial kiosk module. Work still includes entitlement enforcement, held/unpaid dispatch policy, entitlement expiry UI and verified integrated checkout. Until restaurant payment integrations are proven, offer only an explicitly unpaid pay-at-counter flow with staff confirmation; do not simulate card success. Basic web kiosk is required; native wrappers and advanced merchandising remain optional follow-ons.

## Implementation and external prerequisites

Pending implementation: global owner identities, tenant signup and organization membership, social callbacks/account linking, email verification/recovery, plan entitlements/limits, Stripe provisioning/Checkout/Portal/webhook reconciliation, trial downgrade/grace handling and kiosk gates. None is represented as live by this document.

External setup required for verification: Stripe sandbox secret/webhook secret and monthly/annual Pro Price IDs; Google web OAuth client with approved staging/production origins; Apple developer App ID, Services ID, key and verified callback/domain configuration; verified Resend sender for email verification/recovery/reminders. Keep missing providers disabled with truthful configuration status. These credentials are separate from the supplied Neon and Railway access.

Required tests: two-tenant billing/identity isolation; verified-email/account-linking takeover resistance; retry-safe signup and subscription creation; invalid/duplicate/out-of-order webhooks; no Pro activation from redirects; trial expiry and failed renewal; no loss of existing orders/refunds/sync; kiosk API denial on Free, success on trial/paid Pro and denial for new orders after expiry; preservation of restaurant tenders regardless of SaaS billing state.

## Official references consulted

- [Stripe trial periods, including trials without payment methods](https://docs.stripe.com/billing/subscriptions/trials)
- [Stripe subscription Checkout](https://docs.stripe.com/payments/checkout/build-subscriptions)
- [Stripe Customer Portal](https://docs.stripe.com/customer-management)
- [Google Identity Services](https://developers.google.com/identity)
- [Sign in with Apple for the web](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web): web setup requires a Services ID associated with an existing primary Apple-platform App ID enabled for Sign in with Apple.
- [Stripe Checkout wallets](https://stripe.com/payments/checkout): wallet display depends on customer/device/payment-method eligibility.

## Implementation checkpoint — September 13, 2026

Implemented locally: versioned tenant entitlement table with FORCE RLS and read-only runtime access; Free default; bounded trial/active/grace access; server checks on ordering-link issuance, public catalog, and canonical creation of QR/kiosk orders. The gate runs after idempotency replay, so retrying an accepted order after expiry returns its original result. Receipts and ordinary POS financial operations remain accessible. Settings show the current plan and the truthful unavailable state of subscription activation.

Verification: four policy tests plus the existing 14 domain tests; isolated database checks for two-tenant isolation, missing-scope denial, runtime write denial, Pro kiosk success, expiry rejection and replay recovery; existing 17 database checks passed. Local fixture grants are explicitly marked `fixture`, last 14 days and are only created by the localhost-only seed. They do not represent verified Stripe trials and are not added to cloud staging by this change.

Still pending: signup and provider authentication, Stripe trial provisioning/Checkout/Portal/webhooks, broader Free device/team/feature limits, entitlement notifications and cloud qualification. Browser account setup was attempted but the installed browser runtime failed to load a component before accessing provider accounts. No Stripe, Google or Apple account settings were changed.

The eleven existing local browser scenarios also passed after correcting grouped-settlement test selection to use a unique order call name (order numbers legitimately repeat across business days). Typecheck, lint and production build passed. These changes have not been deployed to staging.

## Google provider and adapter checkpoint

Google project `green-monkey-508518` now has a created, enabled web client named
`Green Monkey staging`. Its sole origin is
`https://green-monkey-staging.up.railway.app` and its callback is
`/api/auth/google/callback`. The owner approved the policy acceptance and client
creation. Credentials were captured into a private mode-0600, Git-ignored
`.env.google-staging` file; they are not deployed or included in frontend code.
The Google audience remains External/Testing, with no test users at inspection.

Implemented locally: `server/google-identity.ts` performs authorization-code
exchange with PKCE, browser binding and nonce checking, verifies Google RS256
signatures through JOSE, and requires the configured audience, verified email,
valid issuer, expiry and recent issuance. Identity keys use canonical issuer and
subject, never email matching. Provider errors are sanitized. An uncertain exchange
consumes the attempt and requires a fresh login rather than replaying the code.

Migration 007 and `server/google-attempt-store.ts` persist one-time login attempts.
Before identity authentication there is no tenant: these rows instead use FORCE
RLS scoped by a cryptographic random state hash with transaction-local context.
Missing scope returns no rows. The runtime can insert/read and update only
`consumed_at`. Database time controls expiry; atomic consumption precedes the
external request and survives restart. No migration was applied to Neon in this
checkpoint.

Verified: 36 unit tests (including 18 Google adapter tests), local PostgreSQL
checks for missing-scope rejection, browser isolation, eight concurrent callbacks,
restart/replay rejection, expiry and restricted column grants; lint, typecheck
and production build. Token/exchange tests use explicitly synthetic keys and
responses, not a claimed Google sandbox login.

Still pending: HTTP start/callback routes, cookie lifecycle, global identities and
memberships, account linking, signup UI and bilingual errors, attempt cleanup,
test-user setup and real Google login on staging. The adapter is intentionally not
mounted until verified identities have an authorized membership/session flow.
Apple and Stripe configuration/implementation remain pending.

Contract references checked for this implementation:
[Google OpenID Connect server flow](https://developers.google.com/identity/openid-connect/openid-connect)
and [JOSE official repository](https://github.com/panva/jose). JOSE 6.2.12 is pinned
in the lockfile and was installed and tested using Node 24.

## Owner signup continuation

Implemented after the adapter checkpoint: HTTP Google start/callback with a
ten-minute HttpOnly SameSite=Lax flow cookie, credential-gated login entry,
global issuer/subject owner accounts, hashed account sessions with CSRF, explicit
memberships, one initial organization/restaurant per owner, authorized POS entry
and logout. New restaurants start Free with no synthetic billing entitlement.
The account creation transaction serializes concurrent signup and reuses its
original restaurant. Provider email equality never links legacy employees or
another owner. Existing POS sessions are not silently switched by an OAuth callback.

Migrations 008–010 are local only. A local failing signup test exposed a redundant
restaurant INSERT policy querying organizations whose policy queried restaurants;
009 removes that recursive policy while preserving transaction-local tenant RLS.
010 links Google-origin POS sessions to their owner session so expiry/revocation
is checked on every online POS request. Already issued bounded offline leases
retain their documented offline expiry behavior.

Spanish/English signup uses a restaurant name plus expandable currency/time
settings. Browser testing covered keyboard submission, Free restaurant creation,
authorized entry, denial of another tenant, and logout; all 12 browser scenarios
passed. Signup axe checks had zero violations at 1440×900, 1024×768, 768×1024 and
390×844. All 36 unit tests, 17 existing integration checks, targeted owner/attempt
database tests, lint, typecheck and build passed. Owner database checks include
four simultaneous signup requests, email non-merging and inherited POS revocation.

Pending: real Google callback verification on staging, existing account linking,
invited/multi-location organization management and switching UX, email recovery,
trial/Stripe provisioning, Apple integration, expired-attempt cleanup and broader
Free plan limits. The provider-verified identity used in local browser testing is
explicitly a synthetic test fixture. No real OAuth login or staging deployment is
claimed from that test.

Google dashboard follow-up: `juan@injupe.com` was saved and verified in the test
user list (one test user). The app remains in Testing mode. No production publish
or real account login was performed.

## Approved-price implementation checkpoint

The application displays the approved monthly/annual launch prices, annual savings,
location basis, additional applicable taxes and kiosk inclusion, while explaining
that subscriptions/trials are not yet enabled. There is no nonfunctional purchase
button. Hardware, processing fees and metered third-party usage are separate.

`npm run stripe:catalog:sandbox` prepares only a sandbox product and its monthly
and annual prices. It requires a sandbox `STRIPE_SECRET_KEY` and exact
`STRIPE_EXPECTED_ACCOUNT_ID`. It verifies account identity before mutation, uses
a fixed Green Monkey product ID and unique versioned price lookup keys, and
validates returned amounts/currency/interval/tax behavior. Reruns reconcile existing
objects; mismatches fail closed instead of rewriting prices. It never creates
customers, subscriptions, payments or charges. Validated IDs are saved privately
to `.env.stripe-price-ids`. The same code rejects live keys.

No Stripe API provisioning has been verified yet: the Chrome dashboard timed out,
and a dedicated sandbox key/target account is still required. Trial activation,
Checkout, Customer Portal, signed webhook reconciliation and real sandbox flows
remain pending. New restaurant signup continues to grant Free only.


## Account 031 checkpoint — October 5, 2026

Implemented locally on `track/account` (migration 031) and qualified with the
local unit, database, compiled HTTP and browser suites; nothing here has run on
staging, and the legal text awaits counsel review.

- **Launch posture:** v1 production launches with Stripe billing disabled.
  Pilot restaurants get Pro from the support CLI (`grant-entitlement`, at most
  90 days per grant, renewable, never on Stripe-bound restaurants), shown to
  owners as "Pro otorgado por soporte" with its end date
  ([operations](OPERATIONS.md), Support).
- **Acceptance step** in signup, invitation acceptance (terms and privacy) and
  ownership transfer (terms, privacy and the organization's DPA); material
  document changes ask again and gate account commands, never the POS.
- **Co-owners:** up to 3 per organization with full POS and management control;
  billing, new locations, transfers and the tax profile stay with the primary
  owner. Co-owners do not use Free employee slots.
- **Ownership transfer** by the owner (email-bound link, 72 h), by support after
  identity verification (held, default 72 h) or by recovery code (held 24 h).
- **Recovery:** single-use recovery codes and support-assisted transfer;
  verified-email recovery remains pending.
- **Lapse behaviour:** when Pro ends, registers with a drawer opened in the last
  16 hours keep selling until it closes; POS notices warn 7, 3 and 1 days before
  a trial or grant ends, and explain Pro ended and "not selected" states. Free
  slots follow the most recent drawer openers automatically until the owner
  pins a manual selection ([Free limits](FREE_LIMITS.md)).
- **Grace:** the proposed seven-day failed-renewal grace above remains
  **unapproved**; a failed payment applies Free limits at once (with drawer
  continuation).
- **Data export:** owners download all restaurant records (JSON, or one table as
  CSV) from Settings, on Free too.
- **QR and kiosk** stay off in production (`PUBLIC_ORDERING_ENABLED` unset)
  until the public-ordering area (032) ships; the landing and plan copy say
  "próximamente".
