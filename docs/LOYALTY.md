# Loyalty club (Club de lealtad)

Migration 038 (`migrations/038_loyalty.sql`), LD-71 and LD-72, built from `specs/loyalty-w4.md` with the
Wave 4 critic's binding changes (`specs/wave4-cross-track.md` R5, R15–R23, R26–R32, R35, R38, R40–R45).
Status: built on `track/loyalty`; merges after payments P1 (037), then rebases on it (see "Payments P1
stub" below).

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
   `max_stamps_per_order`. Defaults: 10 stamps a card, $400.00 threshold (pos-lite's rule on the
   paid amount instead of the order total).
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
   already redeemed the card stays negative ("Ajuste pendiente") and future stamps repay it.
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

Kiosk owns the screens and its device-bound route; loyalty provides:
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
  unchecked; nothing sends messages in the pilot.
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

## Payments P1 stub

`shared/payments.ts` on this branch is a stub (`TENDER_METHODS = ["cash", "external", "platform"]`,
`OnPaymentSettled`, `paymentSettledNoop`). Payments P1 owns the file: its merge replaces it whole.
Selling takes an `onPaymentSettled` prop (no-op by default) and calls it with the club's after-payment
work from its single payment-settled exit; P1's own exit replaces that wiring at the rebase. Loyalty
DB check L9 (a platform tender earns nothing) runs once P1's `tenders.method` constraint accepts
`platform`; until then the unit tests cover the exclusion.

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
