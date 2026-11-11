# Promotions and guest marketing — November 11, 2026

Scope added on branch `feature/promotions-marketing`: the M4 promotion/discount
engine (all plans) and a Pro guest-marketing module built on top of it. The
feature set follows what restaurant marketing suites publicly describe (guest
list, campaigns, automations, offers, attribution, a copy assistant); the
implementation, data model and wording are Green Monkey's own.

This document separates **implemented and tested** from **externally blocked**.
No channel has sent a real message: every provider is disabled until its sandbox
send is verified.

## 1. Promotions and discounts (M4, all plans)

`shared/offers.ts` is the single calculation used by POS, QR, kiosk and previews
(`OFFER_RULES_VERSION = 1`). `server/offers.ts::priceOrder` is the only place an
order submission is priced; clients display the server quote and never compute a
discount.

- **Definitions** (`promotions`): percent or fixed amount; whole order, products
  or categories; weekdays, local time window (may wrap midnight), start/end
  dates, channels, minimum purchase, maximum reduction, optional code, usage
  limit, stackable flag. Versioned; edits never rewrite history.
- **Stacking order:** best single item/category offer per line → order offers on
  the remainder (percentages by descending value, then fixed amounts). A
  non-stackable offer only applies alone, and only when it reduces the order
  more than the combined plan. Manual staff discount last.
- **Rounding:** percentages half-up in minor units; order-level reductions are
  allocated to lines by largest remainder, so `line.total` (always the payable
  amount) sums to `orders.total`. Discounted lines keep `gross`, `discount` and
  the per-offer amounts. Item splits and refunds therefore need no change.
- **Schedule clock:** the restaurant's local wall clock (`offerClock`), not the
  business-day cutoff and not the server's zone.
- **Rounds:** later rounds receive automatic percentage/item offers. Codes and
  fixed order amounts apply only when the order is created.
- **Codes:** an unknown or ineligible code rejects the order
  (`promo_code_invalid` / `promo_code_not_eligible`); a code beaten by a better
  automatic offer is reported as `superseded` and the guest keeps the better
  price. Usage limits are enforced under a row lock.
- **Manual discounts/courtesies:** POS only, reason required. Managers apply
  directly; other roles need a manager approval (`approvals`) that is bound to
  requester, order operation, kind and value, expires after five minutes and is
  single use. `/api/approvals` is rate limited.
- **Offline:** offline cash sales charge list price. A code or manual discount
  is never queued offline, so the synchronized total always equals cash taken.
- **Evidence:** `promotion_redemptions` (insert-only for the runtime role) and
  `order.discounted` audit rows. Reports expose `discounts` separately; `gross`
  is now sales before discounts.

Not done in M4 pricing: tax configuration, combos, item-level void/refund
allocations. Those rows stay open in the ledger.

## 2. Guests and consent

- `guests` are created only when a person leaves an e-mail or phone at the
  register, QR or kiosk (optional on every surface), or a manager adds one.
  Orders link through `orders.guest_id`; visits and spend are always computed
  from orders, never stored counters.
- **Consent is explicit and per channel** (e-mail, SMS, WhatsApp). Boxes start
  unticked. An order can grant consent but never revoke it. Every change is an
  append-only `guest_consents` row with source, actor and the wording shown.
  Changing an address withdraws consent given for the old one. Manager-granted
  consent requires an explicit confirmation.
- Every message carries an unsubscribe link (`/u/<token>`); e-mail also sends
  RFC 8058 one-click headers. Delivery re-checks consent at send time.
- Guest list and CSV export are **not** plan-gated (the restaurant owns its
  data). CSV cells are neutralized against formula injection.
- Phones are stored in E.164; ten-digit numbers assume the restaurant's country.

Opt-in is single (no confirmation message), as is usual at a checkout. Someone
could type another person's address on a QR order; the first message they get
carries the unsubscribe link. Double opt-in is not implemented.

This is a consent record, not legal certification. Before live sends in Mexico
the operator must publish an *aviso de privacidad* (LFPDPPP) and set its URL in
Marketing → Configuración; REPEP/PROFECO do-not-contact obligations for
SMS/telephone promotions are the operator's to check.

## 3. Campaigns, automations and delivery (Pro)

- **Campaigns:** name, ordered channels, subject, body with `{{name}}`,
  `{{restaurant}}`, `{{offer}}`, an optional promotion code, and a segment
  (visits, recency, joined, spend, order channel). Each guest receives one
  message, on the first selected channel they opted in to. Launch now or
  schedule; cancel stops anything still queued.
- **Automations** (evaluated once per restaurant per local day, after the
  configured hour, over the window since the previous run, capped at 72 h):
  welcome, thank positive feedback, big spender, repeat guest, miss you, drive
  QR orders, drive dine-in visits, visit follow-up. Qualification is always an
  event inside the window, so switching one on never blasts old guests. A guest
  receives at most one automated message per frequency-cap period (default 30
  days); the list order above is the priority.
- **Not offered:** "invite to loyalty program". Green Monkey has no loyalty
  module; the screen says so instead of showing a dead toggle.
- **Feedback:** the public receipt asks for a 1–5 rating once per order; it
  feeds the positive-feedback automation and nothing else yet.
- **Outbox:** `messages` rows are rendered at enqueue time and deduplicated by
  key. `server/marketing-delivery.ts` leases one message, calls the provider
  outside any transaction, and settles by lease token. Retryable provider errors
  back off exponentially (5 attempts). An unknown outcome is retried only for
  e-mail (Resend idempotency key); SMS and WhatsApp are parked as `uncertain`
  rather than risk a duplicate.
- **Worker isolation:** a separate login in `gm_marketing_worker`
  (`npm run marketing:provision`, `MARKETING_DATABASE_URL`). It can list
  restaurants and find due work only while no tenant is selected; inside a
  tenant transaction it is scoped exactly like the application role, and it has
  no access to tenders, employees' secrets, cash or inventory.
- **Attribution (estimate):** an order is credited to the last message delivered
  to that guest within the attribution window (default 7 days); each order is
  credited once. Redeemed campaign codes are reported separately and never added
  to attributed sales.
- **Assistant:** the month plan is built from the restaurant's slowest weekdays
  (needs ≥14 days of sales), lapsed/new subscribed guests and a fixed list of
  Mexican dates, using fixed templates. Optional AI drafting sends only the
  restaurant name, best sellers and slow weekdays — never guest data — and
  every draft is edited by a person before it can be sent.
- **Social:** drafts to copy into the network. Nothing is published.

## 4. Evidence (local, isolated PostgreSQL 16)

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` | pass |
| `npm test` (unit; offers and marketing suites added) | pass |
| `npm run test:db:promotions` | 8 checks pass |
| `npm run test:db:marketing` (restricted worker role, fake providers) | 10 checks pass |
| `npm run test:db:qualification` (existing suites, unchanged behaviour) | pass |
| `npx playwright test tests/browser/marketing.spec.ts` (axe WCAG 2.2 AA on promotions, campaigns, results and QR) | 3 scenarios pass |

Not yet run: Neon pooled/direct connection pair, staging deployment, and the
existing browser suites against this branch.

## 5. Externally blocked before any real send

| Item | Needs |
| --- | --- |
| E-mail (Resend) | Verified sending domain, `MARKETING_EMAIL_FROM`, sandbox send and bounce/complaint handling reviewed |
| SMS (Twilio) | Account, Messaging Service, Mexico sender registration, sandbox send, delivery-status webhook decision |
| WhatsApp (Meta Cloud API) | Business account, approved marketing template with the four parameters in `.env.example`, pinned API version, sandbox send |
| AI drafting | `ANTHROPIC_API_KEY`, chosen `MARKETING_AI_MODEL`, cost limit |
| Staging | `gm_marketing_worker` login provisioned; migrations `021`–`022` and grants applied |

Provider adapters are unit-tested against the documented request shapes only.
Bounce, complaint, inbound STOP and delivery-receipt webhooks are **not**
implemented; until they are, unsubscribes arrive only through the link.
