# Loyalty club (Club de lealtad)

Migration 038 (`migrations/038_loyalty.sql`), LD-71 and LD-72, built from `specs/loyalty-w4.md` with the
Wave 4 critic's binding changes (`specs/wave4-cross-track.md` R5, R15–R23, R26–R32, R35, R38, R40–R45).
Status: built on `track/loyalty`, which has absorbed payments P1 (037; see "Payments P1" below).

## Concepts

- **Socio (member).** A row in `loyalty_members`, identified by its phone in E.164 (`+52` + 10 digits,
  or `+1` + 10 digits for US/Canada), one per phone per restaurant. It carries a name or nickname (60
  characters), consent evidence, an optional marketing opt-in (unchecked by default) and cached
  balances: `stamps` of the card (may be negative: "Ajuste pendiente"), `rewards` available, lifetime
  counters and `last_activity_at`.
- **Libro (ledger).** `loyalty_ledger` is append-only (a trigger refuses UPDATE and DELETE, even for
  the owner) and is the only source of balances: its insert trigger `loyalty_ledger_apply()`
  (SECURITY DEFINER, as 025's stock ledger) applies each row to the member under the member's row
  lock. The runtime role has no UPDATE on balance columns. Kinds: `earn`/`earn_reversal` (an order's
  stamps), `reward_earned`/`reward_unearned` (a card completes / a refund crossed an unused card),
  `reward_redeemed`/`reward_restored` (tied one-to-one to a reward discount, unique indexes),
  `adjustment` (a manager, with reason and note) and `import` (pos-lite; not activity).
- **Vínculo (order link).** `loyalty_order_links`: at most one member per order, for life; "Quitar
  cliente" keeps the row with `member_id` null. Ways: `pos`, `join_qr`, `kiosk`.
- **Base de sellos (stamp base).** For a settled order: Σ non-platform tender amounts − Σ their
  refunds, capped at the order total and floored at 0. Tips never count; platform tenders (037)
  never count (`STAMP_TENDER_METHODS`, from payments' `TENDER_METHODS`).
- **Settled.** `check_state = 'paid'`, or closed `settled`/`released`, and never in recovery.

## Stamp rules (`shared/loyalty.ts` `planReconcile`, the single statement of them)

1. Target per order: `base ≤ 0 → 0`; threshold 0 → 1; else `1 + floor(base / threshold)`, capped by
   `max_stamps_per_order` and never above 1,000 (one ledger row's bound). Defaults: 10 stamps a card,
   $400.00 threshold (pos-lite's rule on the paid amount instead of the order total). An order keeps
   the rule of its first earn (recorded on its earn rows): a refund, relink or requeue after the
   owner changes the threshold or cap re-targets it by that rule, never by the new one.
2. Target 0 when the order is not settled, is voided, is in recovery, has no member, or its member is
   deleted.
3. Reconcile, not increment: post `target − posted` (`earn` or `earn_reversal`). Running it again
   posts nothing, so retries, double taps, job redelivery and races cannot double-stamp.
4. When it runs: the check settles or is all voided (hooks in `refreshCheckState`), a refund is
   written (last statement of `insertRefundBatch`), a reward discount is removed (`reverseDiscount`),
   an order is linked or relinked (inline), and Vender calls `POST /api/loyalty/orders/:id/reconcile`
   after a payment (for the toast). A paid table check that returns to open keeps its linked
   member's stamps until it settles again (a reconcile meanwhile, e.g. a reward discount's job,
   plans nothing for that member); each settle is its own job (`settle:<id>:<paid>:<version>`), so
   paid → open → paid with the same tenders reconciles again. Any link row, a removed one included,
   makes the hooks enqueue (a redemption stays the first member's).
5. Card completion: overflow carries over (9 + 3 → 1 reward, 2 stamps). A lowered `stamps_required`
   completes on the member's next posting; past rows never change.
6. A reversal that leaves the card negative withdraws an available reward; when the reward was
   already redeemed the card stays negative ("Ajuste pendiente") and future stamps repay it. A
   reward restored onto a negative card is withdrawn the same way (it repays the card first).
7. A reward is restored when its discount is removed, or when its units were all voided and the order
   is settled or closed (a paid table check included, which "Liberar mesa" closes later with no
   hook; at most once per discount).
8. Club off: no new earnings (the target never exceeds what is posted); reversals and restorations
   still post.
9. Link window: an order takes a member while open or up to `link_window_days` (default 7) after it
   settled (by its last tender).

## Roles

| Action | Propietario | Responsable | Cajero / Mesero | Cocina | Comensal |
| --- | --- | --- | --- | --- | --- |
| Lookup by phone or name, enroll, link, redeem, change the member of an open check | ✓ | ✓ | ✓ | – | – |
| Change the member of a settled order | ✓ step-up | ✓ step-up | – | – | – |
| Clientes, detail, edit, adjust, ARCO sheet, delete | ✓ (step-up on writes and the sheet) | ✓ | – | – | – |
| Settings, attestation, import; Finanzas › Club de lealtad | ✓ | ✓ | – | – | – |
| Join with the receipt QR (`/club`) | – | – | – | – | ✓ |

Kitchen gets `forbidden` on every loyalty route before any work. No PIN for lookup, enrollment,
linking or redemption (part of the sale). Removing a reward discount keeps discounts' rule: an
approver.

## Rewards (`server/loyalty/rewards.ts`)

A reward is a `discounts` row with `reason_code = 'loyalty_reward'`, no approver, no note, recorded
through discounts' extracted `recordDiscount` (the same order lock, writable, fiscal and preview
checks; `reserved` skips the staff limit and the step-up). LD-72: "item" (the default) is one free unit
the cashier picks, up to the owner's cap (default $150.00): a comp of one unit within the cap, else an
amount discount equal to the cap. "amount" is a check discount of `min(amount, due)`, refused with
`loyalty_reward_conflict` when the check already has a check discount. `applyDiscount` refuses the
reason (`discount_reason_reserved`), Descuento never offers it (`SELECTABLE_DISCOUNT_REASONS`) and
`unapprovedDiscounts` ignores it. It flows unchanged into fiscal tickets, CFDI (item discount),
reports and Excepciones, and prints as "Recompensa del club". At most `max_rewards_per_order` (default
1) per order.

## Data model (038)

`loyalty_settings` (one row per restaurant; absent = off with defaults), `loyalty_members`,
`loyalty_ledger`, `loyalty_order_links`. All four force row-level security; nothing grants DELETE.
Guards: a member is born with zero balances; identity columns (join, consent, legacy figures) are
immutable; a deleted member's contact and redaction columns never change again; an order link keeps
its identity and only moves forward in time. Grants: `scripts/grants.sql` "038 loyalty" (guarded
`DO` block). The owner export includes the four tables (labels in `shared/account-export.ts`); phones
and names export, which is correct for the responsable.

## Lock order

Rows 47–54 and rule LO-R10 of [ARCHITECTURE](ARCHITECTURE.md#global-lock-order-binding). Member rows
and the settings row are LO-3; members are locked `FOR NO KEY UPDATE` in one statement ordered by
id; no advisory class. Inside money transactions loyalty does one link read and at most one
`loyalty_reconcile` jobs insert keyed by the caller's own order, refund batch or discount.

## Server

- `shared/loyalty.ts` (phones, `stampsFor`, `planReconcile`, `rewardDiscountRequest`, inputs, views),
  `shared/loyalty-import.ts` (the pos-lite export schema and the pure preview).
- `server/loyalty/{settings,members,links,ledger,rewards,hooks,join,kiosk,import,reports}.ts`,
  `server/routes/loyalty.ts` (`/api/club` pre-auth; `/api/loyalty/*`), `server/jobs/handlers/loyalty.ts`
  (`loyalty_reconcile`: concurrency 4, lease 60 s, 8 attempts).
- `/api/capabilities` → `loyalty: {enabled, reason?}` (`pro_required`, `club_off`).
- Lookups by phone or name are POST bodies (`/members/lookup`, `/members/search`, `/members/list`):
  a phone or a name never appears in a URL, so no edge or access log holds one. Writes the spec named
  PUT/PATCH are POST paths (`/members/:id/update`, `/orders/:id/member/change`).

### Kiosk interface (039; critic R20–R23, LD-72)

Kiosk owns the screens and its device-bound route, which mounts loyalty's `kioskMemberLimiter()`
(`server/routes/loyalty.ts`: 20 lookups a minute per IP by clientIp, `CLUB_RATES.kioskLookupPerIp`,
critic R20) beside its own per-device bucket (5 per 5 minutes); loyalty provides:
`lookupMemberForKiosk(tx, {phone, country}, {stationId})` → `{found:false}` or `{found, memberToken,
maskedPhone, stamps, required, rewards}` (no name, no enrolment at the kiosk);
`issueKioskMemberToken(tenantId, memberId, stationId)` (`seal("loyalty-member", {t, m, s}, 900 s)`);
`memberFromToken(tx, token, {tenantId, stationId})`; `linkFromKiosk(tx, s, orderId, memberId)` (call it
right after `createOrder`, before any tender or refresh); `reconcileOrder` and `orderLoyaltyView` for
the done screen; `joinUrlForOrder(tx, orderId)`; `loyaltyKioskConfig(tx)`.

## Client

Vender: the Club button (or the member's chip "Ana · 7/10" with ✕), the prompt once per cart cycle
when `prompt_at_checkout` is on, the link once the order exists (fire-and-forget, 3 s) and again after
payment, the reconcile toast, and "Canjear premio" next to Descuento. Detalle de orden: the "Cliente del
club" panel (Mesas checks open in Vender, whose club control covers them). Clientes (management rail,
shown only while the club is on). Configuración › Club de lealtad (after Privacidad y datos) with the
pos-lite import. Finanzas › Club de lealtad. The receipt's club block prints through Receipt.tsx's
`setReceiptExtra` slot (its own slot: it prints with or without a fiscal ticket and never replaces
fiscal's or cfdi's lines): the member's counts with no name or phone, or the join QR (not on a
settled order whose stamp base earns nothing: platform-paid, fully comped or refunded). `/club#<token>`
is the diner join page (no service worker). An order is claimable once: once it has a link, every
phone (the claimant's included) gets `loyalty_order_linked` and the page shows "Esta compra ya sumó
sellos.", so a receipt never tells whether a given phone claimed it. Everything is online-only: offline, the controls are
disabled with "El club requiere conexión." and the sale proceeds.

## Privacy (LFPDPPP)

- The restaurant is the responsable. The club cannot be switched on without the restaurant's privacy
  notice URL (031) and the owner's attestation that it covers the club (data, purposes, retention,
  ARCO channel); who and when are recorded. Green Monkey is the encargado: the club also waits for
  the platform's published privacy notice and DPA version that list the club (`2026-10-09`,
  `loyalty_legal_required`; ACCOUNT_AND_LEGAL "The loyalty club").
- Consent per member: `consent_channel` (`staff_attested` at the counter, `self_service` on `/club`,
  `pos_lite_import`), `consent_at`, a snapshot of the notice URL. Marketing is separate and starts
  unchecked; nothing sends messages in the pilot. A marketing opt-in is not proof the person owns the
  phone (`/club` and the counter take any number typed): the deferred messaging module must confirm
  each number with a double opt-in (a first message asking to confirm) before any promotion, and
  never treats `marketing_opt_in` alone, nor pos-lite's `legacy_sms_opt_in`, as consent
  (LOYALTY-PRIVACY-7).
- Call names: choosing a member fills the order's call name with the first name (§2.5); it is the
  restaurant's sales record and stays after an ARCO deletion (the delete dialog says so; counsel
  confirms, LOYALTY-PRIVACY-6).
- ARCO: access ("Imprimir datos del cliente", the owner export), rectification ("Editar datos"),
  cancellation ("Eliminar datos del cliente": name, phone, notice snapshot and opt-in blanked; ledger,
  links and sales stay; irreversible), opposition (the marketing toggle). Clientes and these actions
  need neither Pro nor the club on: with the club off, Clientes stays (with a "club desactivado"
  note, no Ajustar) while any member who is not deleted exists (LOYALTY-PRIVACY-3). The printed sheet
  holds every stored field: pos-lite's figures and its pre-checked SMS flag (evidence, never
  consent), the marketing change date, the managers' notes and the linked orders with totals.
- Retention: the daily pass redacts members with no activity for 24 months
  (`server/ops/retention.ts`); no loyalty row is ever deleted.
- Personal data never goes into logs (route templates only; lookups are POST bodies), audit details
  (ids, counts and field names), job payloads (`{orderId}`), sealed tokens (uuids) or the idempotency
  log: once() saves ids only for every club command, and a replay re-reads the member as it is now, so
  a deletion or the retention pass leaves no name or phone in `operations` (LOYALTY-PRIVACY-1).

## Payments P1

Payments P1 (037) is merged into this branch; its `shared/payments.ts` is the only one (the loyalty
stub and its rebase checklist, LOYALTY-OPS-6, are done). Loyalty uses three P1 symbols and adds no
call to payments, and payments adds none to loyalty (critic R16):

- **`TENDER_METHODS`** (R15): the stamp base (`stampBase`, `STAMP_TENDER_METHODS` in
  `shared/loyalty.ts`, and the Finanzas › Club de lealtad query) counts every method but
  `platform`. A platform tender covers the whole remaining balance (payments Q6), so a
  platform-paid order earns nothing and its receipt offers no join QR, and cash plus platform earns
  on the cash part only. DB check L9 asserts both.
- **The payment-settled exit** (R18): Selling's `onPaymentSettled(order, cartOwn)` is the one place
  the club's after-payment work starts, on every settled path (collect, the pending-attempt retry,
  settlements by items, "Recuperar pago"). For the cart's own order (owned and the same context
  epoch; in "Recuperar pago", the cart shows that check) it calls `loyalty.afterPayment(order)`
  (link the cart's member if needed, reconcile) and shows the text in the receipt status. For an
  order the cart moved on from (an empty new cart showing a recovered receipt included) it only
  calls `POST /api/loyalty/orders/:id/reconcile` (`reconcileOnly`) and never links the cart's
  current member to it. P2's integrated terminals take the same exit when TerminalWait's sync,
  a retry or a manager record settles the charge on this device (`settledFromTerminal`): the
  cart's own order while the cart still shows it, otherwise reconcile only. A charge settled by the
  worker's `payments_settle` job with no device waiting takes no exit and shows no toast; the settle
  hook's job still stamps.
- **The live-attempt guard** (R17): P1's `assertNoLiveAttempt` sits in `recordDiscount` right
  after the order lock, so a reward redemption, like a staff discount, is refused with
  `payments_order_attempt_live` while a terminal charge for the order is in flight (DB check L10).

The settle hooks reach every payment path through `refreshCheckState`, including payments'
`settleAttempt` (row 43, phase P2). With P2 in, L16's lock-order burst races the `payments_settle`
job and the sync route on approved charges of two linked orders (one tender and one `earn` each),
and payments' DB 15 runs a member link, a reward redemption and the after-payment reconcile of a
linked order whose charge settles in its burst (R16).

## Restaurant-day branch L (spec §9.4)

The restaurant-day gate (`tests/browser/restaurant-day.spec.ts`, after X1) runs the club through the
UI in its own restaurant, "Tortas El Mezquite" (lead decision LD-80): created like A and B (signup,
support grant, fiscal profile, staff, menu, a paired register), it is the only restaurant whose club
is ever on, so A's and B's sales, receipts and hand-typed tables never meet the prompt, the receipt
block or the Club button. `tests/restaurant-day/club-l.ts`: the owner publishes the restaurant's
privacy notice and turns the club on (3 stamps a card, one extra per $50.00); the cashier enrolls
Rosa at the prompt (her $125.00 purchase completes a card), answers "Sin club" for a walk-in (the
receipt's join QR), redeems Rosa's reward on the $120.00 torta cubana with no PIN and takes the rest
by card, and records a $30.00 cash refund on Rosa's first sale with the manager's PIN, which reverses
one stamp. The register's corte X, Clientes, Excepciones (the reward with no approver), the corte del
día (the reward among the cortesías, the refund and its IVA) and Finanzas › Club de lealtad show the
oracle's figures (`oracle.ts` R18 reward, R19 stamps; `expected.ts` L, hand-typed). DB checks
D20–D23 reconcile tickets, tenders, the reward discount, the refund and the drawer; the settings,
the consented member, the links and the ledger row by row (each earn's base and rule); every
reconcile job done and no phone or name in audit, jobs or operations; and that A and B hold no
loyalty row and see none of L's. L28 still asserts acceptance criterion 5 against the reports'
code directly.

## Runbooks

- **Import Juanberto's pos-lite members** (before enabling; PILOT_SOP §9 and MIGRATION's cutover).
  The order is: save the club's settings, import, verify, then attest and turn the club on.
  Balances convert at the saved stamps per card, so "Aplicar a la configuración" then Guardar comes
  first; while pos-lite's stamps per card differ from the saved ones, Importar is blocked and a page
  is refused (`settings_changed`, LOYALTY-OPS-3). Run `scripts/loyalty/poslite-export.sql` with psql
  against pos-lite's database as its admin login (read-only transaction;
  `-v tenant=<pos-lite tenant> -v target=<green-monkey restaurant>`), keep the file in the private
  scratchpad (mode 600), upload it in Configuración › Club de lealtad › Importar socios de POS Lite,
  choose the rewards policy (default "recent": completed in the last 90 days with no visit since),
  "Imprimir listas para la bitácora" (rejected rows and premios por confirmar, masked phones) into
  the cutover log, Importar (a failed page shows Reintentar: committed pages replay), and require
  "Verificado". Spot-check 10 members against pos-lite's Loyalty y CRM screen: compare the active
  card's dots (n of required) with Tarjeta, not pos-lite's lifetime "Total stamps"; rewards differ by
  the policy. Record it in the cutover log, delete the file. Cards the policy did not grant stay on
  each member's "Saldo importado" row ("Premios de POS Lite por confirmar: <dates>", shown in the
  detail and the ARCO sheet); Clientes › "Premio de POS Lite por confirmar" lists them until a
  manager settles one with Ajustar › Saldo de POS Lite (LOYALTY-OPS-2). A phone already in the club
  refuses its page (`loyalty_import_member_exists`): take it out of the export and move its pos-lite
  balance with Ajustar › Saldo de POS Lite. Then purge pos-lite's copy:
  once Juanberto's stops using pos-lite, delete (or anonymise) that tenant's `loyalty_customers`
  rows in pos-lite and record it in the cutover log; until then, an ARCO cancellation of an
  imported member is also done in pos-lite (OPERATIONS "ARCO requests"). "Premios por confirmar" lists
  completed cards the policy did not grant; grant one with Ajustar › Saldo de POS Lite.
- **Dead `loyalty_reconcile` job** (`jobs_dead_loyalty_reconcile`): the order's stamps did not post.
  No screen requeues jobs yet: requeue it with the operator API call (`POST /api/jobs/<id>/requeue`
  from a manager's browser session with step-up; RUNBOOK "Jobs"), or reconcile the order with
  `POST /api/loyalty/orders/:id/reconcile`. Both are state-reconciling and never double-post.
- **Ledger/member mismatch** (Finanzas › Club de lealtad alert, `loyalty_ledger_vs_members`): a
  member's cached balances differ from their ledger. That should be impossible (only the trigger writes
  balances); the alert gives the count only: escalate to support with the restaurant and the day,
  and support finds the members by comparing `loyalty_members` with the sums of `loyalty_ledger`.

Campaigns and daily automated messages for confirmed members are a separate area:
[MARKETING.md](MARKETING.md) (047).

## Engagement extension (042)

Migration `042_loyalty_engagement.sql` adds the remaining core POS Lite engagement
flows. These options are independent of the stamp rules and start disabled.
Configure them in **Configuración › Club de lealtad › Recomendaciones, tarjetas y
mensajes** while the club is active.

- **Referrals:** an issued card has a shareable referral code. A new member can
  enter it on their card page, or staff can apply it at enrollment or in Clientes, within seven
  days of enrollment. Both receive the configured bonus (default two stamps).
  Self-referrals and a second referrer are refused. Concurrent claims produce
  one award. The two members lock in UUID order; bonuses and card completion use
  the append-only ledger. Referral stamps appear separately in the club report.
- **Digital card:** staff issue or replace a card from Clientes or the checkout
  member lookup. The customer scans its private link and sees their live card at
  `/club/card#…`, with a checkout QR, referral code, review link and message
  preference. A public phone lookup cannot issue access to an existing account.
  The access credential travels in a header; only its SHA-256 digest is stored.
  The checkout QR contains a separate random identifier, not a portal credential
  or phone number. A keyboard barcode scanner can enter it in the checkout
  lookup; pressing Enter searches. Replacement invalidates the old link and QR.
- **Wallet:** the member page offers signed Apple passes and Google Wallet save
  links when their provider artifacts are ready. Passes contain the restaurant,
  balances, reward and scan identifier, without the member's name or phone.
  Ledger and settings changes queue updates. Apple device registration and update
  routes are scoped by restaurant and member. Google object identity includes
  the issued card's scan identifier, so replacing a card cannot update a stolen
  older pass with the replacement QR. Member revocation invalidates checkout
  lookup immediately and queues provider deactivation.
- **Messages:** opted-in members receive welcome, stamp, reward and referral
  messages, with a delayed reminder for an available reward (default seven
  days). Queued messages recheck current consent, redaction, Pro entitlement and
  the club setting before sending. Reminder deliveries are limited to one per
  member per 24 hours. The member page and Clientes can withdraw consent.
  Twilio's Messaging Service must have its STOP handling configured. The worker
  polls sent-message status; Clientes shows delivery state. An ambiguous send
  becomes `unknown` and is never blindly resent. Message rows and jobs do not
  retain the destination phone or rendered message body.
- **Reviews:** an owner-supplied HTTPS review link appears on the card and in
  configured messages. Review requests are not conditioned on a positive rating.

### Provider setup and activation

The web process refuses provider secrets. Configure these on the **worker only**:

| Provider | Configuration |
| --- | --- |
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`; set `LOYALTY_SMS_SEND=1` only for intentional delivery |
| Google Wallet | `GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_SA_KEY_BASE64` (service-account JSON authorized for that issuer) |
| Apple Wallet | `APPLE_TEAM_ID`, `APPLE_PASS_TYPE_ID`, `APPLE_PASS_CERT_BASE64`, `APPLE_PASS_KEY_BASE64`, `APPLE_WWDR_CERT_BASE64`, optional `APPLE_PASS_KEY_PASSPHRASE`, and a stable random `LOYALTY_WALLET_SIGNING_SECRET` of at least 32 characters |
| Both wallets | HTTPS `APP_URL` pointing to the web service |

Apple passes are signed with system OpenSSL; the runtime Docker image installs
it. No pass-signing npm dependency is required. Keep the Apple signing secret
stable: rotating it requires members to download their passes again. Signing
keys are written only to a private temporary directory and removed in `finally`.
A per-member lease serializes wallet work without holding a database transaction
across provider calls. Missing configuration blocks the job with a named reason;
after setup, cancel the blocked job and requeue it through the existing job
operations workflow (direct requeue applies to dead jobs).

Apply migration 042 and the grants manifest before deploying both processes.
Confirm provider accounts, sender/STOP configuration, privacy disclosures and
actual Apple/Android devices before enabling these optional integrations for
customers. Local tests use synthetic members, self-signed certificates and fake
provider responses; they do not establish provider approval or live delivery.
No provider has been enabled by the implementation work itself.

### Verification

`tests/loyalty-engagement.test.ts` verifies validation, credential separation,
message text, versioned Google objects and an independently verified Apple CMS
signature/ZIP. `tests/loyalty-db.ts` includes referral races and completion,
restaurant isolation, card replacement/revocation, consent withdrawal, SMS
success/uncertain outcomes, fake Google updates and public card authorization.
`tests/browser/loyalty-card.spec.ts` covers the mobile card, referral/consent
interaction, revoked-card handling and accessibility. The existing loyalty
checkout, refunds, imports and ledger tests remain part of qualification.

This extension follows POS Lite's stamp-based program. Points-based earning,
VIP tiers, birthday rewards and cross-restaurant pooled balances are not part of
this implementation.

Wallet device unregistering clears the push token and records `unregistered_at`; registration reactivates the same device. Discovery and push delivery ignore inactive registrations. Runtime and jobs roles have no DELETE permission; member redaction physically removes registrations through the existing restricted trigger. A delayed APNs rejection only retires the token it attempted, preserving a newer registration.

Pilot limitations: Apple Wallet and messaging remain disabled until provider and device qualification. Reissuing a card rotates its Wallet credential, requiring the member to add the new pass. Member redaction removes push registrations immediately; an already installed Apple pass may retain its cached display, although its checkout scan is invalid. Inactive registration hashes remain until member redaction; the five-device limit bounds active registrations, not lifetime registrations.
