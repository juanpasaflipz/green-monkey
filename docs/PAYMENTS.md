# Payments: card terminals, platform orders and platform prices

Area doc for migration 037 (Wave 4, LD-71 and LD-72). The spec is `specs/payments-w4.md`, and the critic's resolutions are binding where they differ. The work ships in two phases:

- **Phase P1 (this branch)** delivers:
  - the whole 037 schema;
  - named manual terminals with fee rates;
  - the "Pagado por plataforma" tender;
  - per-platform product prices;
  - every reader of `tenders.method`;
  - Configuración and the payment dialog.
- **Phase P2** adds integrated Mercado Pago Point and Clip charging: the worker, provider adapters, webhooks, attempts end to end and the resolve dialog. P2 adds no migration.

## Concepts

- **Tender methods** (`TENDER_METHODS`, `shared/payments.ts`):
  - `cash`;
  - `external`: a card terminal, recorded manually now and integrated in P2;
  - `platform`: the order was paid on Uber Eats, Rappi, DiDi Food or another platform.

  Every reader maps the method by value. An unknown value is refused (`report_method_unknown`, `cfdi_payment_method_unknown`) and never counted as cash. `tests/payments-shared.test.ts` scans `server/` and `shared/` for the old `=== "external" ? … : "cash"` pattern.
- **Terminal** (`payment_terminals`): a named card device with an optional fee rate in basis points, for example 4.18 % entered as `4.18`.
  - Kinds: `manual`, `mercadopago_point` and `clip_pinpad`. An integrated kind needs an active provider account (P2). Until then, record a Clip or MP device as a manual terminal used in standalone mode.
  - Terminals are archived, never deleted. A tender keeps the terminal's name as a snapshot (`terminal_label`).
  - Each POS device may have a default terminal (`payment_device_terminals`). Operators set it for their own device; managers set it for any device.
- **Platform tender:**
  - It needs the platform, plus a name when the platform is "Otra", and the confirmation «La plataforma ya cobró este pedido».
  - It covers the whole remaining balance, has no tip, and its `received` equals its amount. The platform's order number is optional (up to 40 characters).
  - It is recorded in this device's drawer but never counted in expected cash or card totals.
  - Its estimated commission is the platform's rate (`payment_platforms.commission_bp`). No row means the platform is enabled and its commission is not tracked.
- **Platform prices** (LD-72, `payment_platform_prices`):
  - A product may have a price per platform. When an order is rung with «Precios: Uber Eats», its products take that platform's price, or the counter price when none is set. Modifier prices stay the counter ones.
  - The list is stored on the order (`orders.price_platform`) and set once. Later rounds use it, and a round naming another list is refused.
  - A platform tender on such an order must be that platform (`payments_platform_price_list`).
  - QR and kiosk orders never take a list.
  - Tickets, CFDI and reports read line prices, so they carry the charged platform price.
  - The staff catalog carries `platformPrices`; the diner catalog strips them. A price save bumps the menu revision so every POS reprices.
- **Fees:** the tender stores an estimated fee: the terminal's rate on amount + tip, or the platform's commission on the amount. P2 stores provider fees (`fee_source='provider'`). Fees and commissions are manager figures: the order view never carries them, and staff drawer views strip them.

## Commands and lock order

These are rows 3, 13, 25, 26 and 41–46 of the ARCHITECTURE global lock order, with levels LO-2c, 933 and 934.

- `recordPayment` takes `method` `platform` and an optional `terminalId` on `external`. It refuses while the order has a live terminal attempt (`payments_order_attempt_live`). That refusal is a plain read after the order lock, and the same guard runs in `voidLines`, `applyDiscount`, `closeCheck` and `recordSettlement`.
  - Offline evidence (OFF-8) skips the guard and the online-only platform rules.
  - An archived terminal named in evidence is accepted. An unknown one is dropped, and the audit row notes `payments_terminal_unknown`.
- `insertTender` (`server/payments/tenders.ts`) is the only tender writer. Online payments, offline sale and payment sync, financial recovery, reconcile-into-order and payment-attempt resolution all write through it.
- **Configuration** (managers with step-up; class 934): `saveTerminal`, `archiveTerminal` (refused while the terminal may show a charge), `savePlatforms`, `savePlatformPrices` and `setDeviceTerminal`.
- **Drawer close:** it refuses while an attempt on the drawer is live (`payments_attempt_unresolved`), and there is no force-close. It accepts optional per-terminal batch totals («Total del lote», `drawer_terminal_counts`). `external_reported` stays their sum for older readers.
- **Refunds:** a refund of a platform tender is a `platform` portion. It needs no drawer and no terminal confirmation, and the batch records `platform_amount`. The legacy `POST /refunds` refuses platform tenders (`payments_platform_refund_requires_batch`).
- **Public pay-first:** the accept's payment is a union on `method` (cash, or external with an optional `terminalId`) and never a platform. The kiosk (039) adds `{method: "attempt", attemptId}`.

## Reports and the corte

- `byMethod` has a platform row.
- `byTerminal` and `byPlatform` (statements S6 and S7) reconcile with it. The `methods_sum` check also fails when either split disagrees.
- The margin gains `processorFees`, `platformCommissions` and `marginAfterFees`.
- Pagos lists terminal, provider, card, platform and fee columns. Its CSV is the managers' export.
- The corte X and Z print card money by terminal (with batch totals, the kiosk sub-line from 039, and fees in the full variant) and «Pagado por plataformas» apart.
- A batch difference typed per terminal is a `terminal_difference` exception naming its terminal.

## CFDI

- `cfdi_settings.platform_payment_form` can be 31, 03, 04 or 28, with a default of 31 «Intermediario pagos», pending the accountant's confirmation. It is never 99, because green-monkey stamps PUE.
- `paymentFormFor(payments, {card, platform})`:
  - the largest amount wins, and ties go to the earliest tender;
  - a platform tender takes the platform form;
  - a card tender of known type takes 04 for credit and 28 for debit or prepaid;
  - otherwise a card tender takes the card form.
- The credit note of a platform refund uses the platform form.
- The stamped global body is built by `freeze.ts` with the restaurant's platform form.

## Offline

- Platform tenders and named-terminal records are saved offline under the terminal's rule (`allowPlatform` follows `allowExternal`).
- Payment options (terminals, platforms, the device default) are cached per tenant and device. They never include secrets, and fees only when a manager fetched them.
- A pre-037 offline record or stored payment attempt parses and fingerprints exactly as before: the new fields are optional with no defaults.

## Phase P2 (not yet built)

P2 adds:

- the generalized vault and rekey;
- the payments worker (adapters, jobs, `/wake`, `poke()`);
- integrated start, sync, cancel, settle, resolve and operator retry (critic R13), plus the settler registry for the kiosk (R10);
- provider credentials and verified webhooks, and `/capabilities` for `mercadopago` and `clip`;
- TerminalWait, ActiveCharges and ResolveDialog;
- the attempt exceptions (`terminal_attempt_review`, `terminal_attempt_dismissed`, `terminal_attempt_unknown_open`);
- the fake provider and the real-device rehearsal.

The 037 attempt table, its transition trigger, the live-attempt indexes and the guards are already in place.
