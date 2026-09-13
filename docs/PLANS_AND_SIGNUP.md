# Free, Pro and tenant signup

Status: product definition for implementation. The owner explicitly requires kiosk to be Pro. Other limits and the 14-day trial below are recommended defaults, not claims of implemented billing or approved commercial prices. Existing staging access is unchanged. Required workflows remain in scope even where they belong to Pro.

## Recommended packaging

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

Do not cap completed order count or withhold refunds/history behind an upgrade. Provider transaction fees, messaging/AI usage and hardware are distinct from subscription inclusion. No Pro price is set here; use configured Stripe Price IDs for monthly and annual plans, not hardcoded amounts or legacy prices. Recommend per-location pricing rather than per-employee pricing. One organization owns the Stripe Customer; explicit restaurant entitlements determine which locations receive paid access. The first implementation should use one consistent Pro plan across an organization's billed locations to keep quantities and access unambiguous.

## Trial and upgrade

Recommend 14 days from successful verified-owner restaurant creation. This gives two weekly service cycles without making an unsupported claim about optimal conversion. Show the exact expiry date and remaining days. Offer Free without a trial for owners who prefer it. One trial per organization; creating another location or linking another login must not reset it.

Create a Stripe Customer and trial subscription using configured Pro Price IDs and no required payment method. Choose cancellation when the trial ends without a payment method; Green Monkey then retains the Free account. Store a durable provisioning attempt and reuse idempotency keys so retries never create duplicate subscriptions. If Stripe is unavailable, complete Free signup, show trial activation as pending, and start the full trial only when Stripe confirms creation.

Adding payment details must present the plan, interval, recurring price and first charge date and obtain recurring-payment consent. Preserve the original trial end unless the owner explicitly chooses immediate upgrade. Do not create a second active subscription during trial upgrade. Show reminders three days and one day before expiry. Stripe's cancellation ends paid entitlement, not the restaurant's local tenant or historical records.

On expiry/cancellation, stop starting new Pro actions and new kiosk/QR orders. Preserve existing tickets, cash reconciliation, paid receipts, refunds and pending sync. A kiosk cart is unpaid until confirmed otherwise; show staff assistance when access expires. Already accepted orders remain available to staff. Do not erase extra employees, locations, recipes or device history; allow an owner to select the permitted Free register/team, retain read/export access and finish outstanding work. Proposed failed-renewal grace: seven days with billing notices, followed by Free limits; this is distinct from the bounded offline authorization lease.

## Signup and identity

Recommended owner entry points: Continue with Google, Continue with Apple, and a verified email/password fallback with recovery. Employee access remains paired-device PIN; staff do not need their own Stripe or social accounts.

Google/Apple authenticate identity. Stripe handles billing; Apple Pay/Google Pay are payment wallets and do not replace sign-in. Use Google Identity Services and Sign in with Apple on the same backend identity/session service. Keep Neon as the only application database and existing signed sessions/CSRF/device checks. No Supabase runtime or second auth dashboard is introduced.

Signup sequence:

1. Authenticate and verify the owner's identity.
2. Create a global identity and explicit organization membership. Match provider issuer/subject, not display names. Apple relay email must not merge accounts automatically. Link another provider only after authenticated proof of both accounts.
3. Ask for restaurant name, locale/currency/timezone and operating settings, defaulting to Spanish/MXN/America/Mexico_City; create tenant and owner membership transactionally. Generate tenant IDs server-side.
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
