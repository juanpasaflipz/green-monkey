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
- **Platforms are off by default** (LD-75, PAYMENTS-SECURITY-1): no `payment_platforms` row means the platform is disabled, «Otra» included. The owner turns each one on in Configuración → «Plataformas de entrega». A disabled platform is not offered at payment or as a price list, and the server refuses it (`payments_platform_disabled`).
- **Platform tender:**
  - It needs the platform, plus a name when the platform is "Otra", and the confirmation «La plataforma ya cobró este pedido».
  - Uber Eats, Rappi and DiDi tenders need the platform's order number: 2 to 40 letters, digits, spaces, `#` or `-` (`payments_platform_reference_required`). «Otra»'s number is optional (up to 40 characters). The dialog prefills it from the order name («DiDi 4F2A» → «4F2A»).
  - It covers the whole remaining balance, has no tip, and its `received` equals its amount.
  - A table or dine-in order is never paid by a platform (`payments_platform_dine_in`).
  - It is recorded in this device's drawer but never counted in expected cash or card totals.
  - Its estimated commission is the platform's rate (`payment_platforms.commission_bp`); NULL means the commission is not tracked.
- **Platform prices** (LD-72, `payment_platform_prices`):
  - A product may have a price per platform. When an order is rung with «Precios: Uber Eats», its products take that platform's price, or the counter price when none is set; the product tiles and the modifier preview show it too. Modifier prices stay the counter ones (the pilot keeps platform extras at the counter price, PILOT_SOP §8).
  - The list is stored on the order (`orders.price_platform`) and set once. Later rounds use it, and a round naming another list is refused. Online, only an enabled platform's list is accepted, and never on a table or dine-in order.
  - A platform tender on such an order must be that platform (`payments_platform_price_list`).
  - When a platform has any price configured, its tender is accepted only on an order rung at its list (`payments_platform_needs_price_list`). An order sent at counter prices is voided and rung again with «Precios: …»; the dialog says so before Confirm. Selling shows «Pedido con precios de …» in both layouts.
  - QR and kiosk orders never take a list.
  - Offline, the order's list travels with the device's copy (the open-orders snapshot, local and cached views), so a second offline round prices at it (PAYMENTS-MONEY-1). The manager's review of an offline record prices it at the same list (PAYMENTS-MONEY-3).
  - Tickets, CFDI and reports read line prices, so they carry the charged platform price.
  - The staff catalog carries `platformPrices`; the diner catalog strips them. A price save bumps the menu revision so every POS reprices.
- **Fees:** the tender stores an estimated fee: the terminal's rate on amount + tip, or the platform's commission on the amount. P2 stores provider fees (`fee_source='provider'`). Fees and commissions are manager figures: the order view never carries them, and staff drawer views and the staff corte X/Z strip them, even when the owner lets staff see expected cash (PAYMENTS-SECURITY-3).

## Commands and lock order

These are rows 3, 13, 25, 26 and 41–46 of the ARCHITECTURE global lock order, with levels LO-2c, 933 and 934.

- `recordPayment` takes `method` `platform` and an optional `terminalId` on `external`. It refuses while the order has a live terminal attempt (`payments_order_attempt_live`). That refusal is a plain read after the order lock, and the same guard runs in `voidLines`, `applyDiscount`, `closeCheck` and `recordSettlement`.
  - Offline evidence (OFF-8) skips the guard and the online-only platform rules (enabled platform, full balance, dine-in, price list, order number), so the money is never lost. Each rule it broke is noted on the `payment.recorded` audit (`platformRulesSkipped`, PAYMENTS-SECURITY-4), and the tender is listed in Excepciones.
  - An archived terminal named in evidence is accepted. An unknown one is dropped, and the audit row notes `payments_terminal_unknown`.
  - The `payment.recorded` audit names the tender (`tenderId`), which Excepciones uses for the actor.
  - With several terminals and no device default, the card form preselects nothing and asks «Elige la terminal», so «Otra terminal» is always a deliberate choice; with one terminal it is preselected.
- `insertTender` (`server/payments/tenders.ts`) is the only tender writer. Online payments, offline sale and payment sync, financial recovery, reconcile-into-order and payment-attempt resolution all write through it.
- **Configuration** (managers with step-up; class 934): `saveTerminal`, `archiveTerminal` (refused while the terminal may show a charge), `savePlatforms`, `savePlatformPrices` and `setDeviceTerminal`.
- **Drawer close:** it refuses while an attempt on the drawer is live (`payments_attempt_unresolved`), and there is no force-close. It accepts optional per-terminal batch totals («Total del lote», `drawer_terminal_counts`): for every terminal that took money (non-zero net) or for none (`payments_batch_totals_incomplete`, PAYMENTS-SECURITY-2). `external_reported` stays their sum for older readers, so it always covers the same terminals as `external_expected`.
- **Refunds:** a refund of a platform tender is a `platform` portion. It needs no drawer and no terminal confirmation, and the batch records `platform_amount`. The dialog's breakdown shows «Reembolso por plataforma (sin efectivo)» before Confirm. The legacy `POST /refunds` refuses platform tenders (`payments_platform_refund_requires_batch`).
- **Public pay-first:** the accept's payment is a union on `method` (cash, or external with an optional `terminalId`) and never a platform. The kiosk (039) adds `{method: "attempt", attemptId}`.

## Reports and the corte

- `byMethod` has a platform row.
- `byTerminal` and `byPlatform` (statements S6 and S7) reconcile with it. The `methods_sum` check also fails when either split disagrees.
- Platforms group by (platform, label): each «Otra» name is its own row (case and spaces ignored) in `byPlatform`, the drawer breakdown, the drawer list and the corte (LD-75, PAYMENTS-MONEY-8). «Por plataforma» shows «Ventas netas (antes de comisión)» and «Neto después de comisión (estimado)».
- The per-day table and the day CSV have a «Plataformas» column; the drawers CSV has platform sales and refunds (PAYMENTS-MONEY-5).
- A recovered tender keeps its method label: «Pagado en Uber Eats (recuperado)», «Tarjeta · BBVA (recuperado)»; only recovered cash reads «Efectivo recuperado».
- The margin gains `processorFees`, `platformCommissions` and `marginAfterFees`.
- Pagos lists terminal, provider, card, platform and fee columns. Its CSV is the managers' export.
- The corte X and Z print card money by terminal (with batch totals, the kiosk sub-line from 039, and fees in the full variant) and «Pagado por plataformas» apart.
- A batch difference typed per terminal is a `terminal_difference` exception naming its terminal.
- **Excepciones kind `platform_tender`** (LD-75): a platform tender that is «Otra», or on an order not rung at that platform's price list, or offline evidence that broke an online platform rule. The row names the actor (the payment's, else the drawer's), the device (the drawer's), the platform («Otra» by its name), why it is listed, the order's price list and the order number. Managers review these against the platform's payout; a cash sale recorded as a platform tender shows up here.

## CFDI

- `cfdi_settings.platform_payment_form` can be 31, 03, 04 or 28, with a default of 31 «Intermediario pagos», pending the accountant's confirmation. It is never 99, because green-monkey stamps PUE.
- `paymentFormFor(payments, {card, platform})`:
  - the largest amount wins, and ties go to the earliest tender;
  - a platform tender takes the platform form;
  - a card tender of known type takes 04 for credit and 28 for debit or prepaid;
  - otherwise a card tender takes the card form.
- The credit note of a platform refund keeps its parent's form when that is a platform form (31 or 03), so a later change of the setting never splits the pair (PAYMENTS-FISCAL-2); otherwise it takes the platform form in force.
- A credit note's substitute (CFDI-SAT-2) may carry 01, 03, 04, 28 or 31 (`cfdi_documents.payment_form_override`, widened in 037); the dialog preselects the note's own form (PAYMENTS-FISCAL-1).
- `needsCardForm(payments, platformForm)` takes the restaurant's platform form at every caller, since with 04 or 28 the platform money joins a card sum (PAYMENTS-FISCAL-3).
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

The 037 attempt table, its transition trigger, the live-attempt indexes and the guards are already in place. 037 also guards inserts (PAYMENTS-CONCURRENCY-1): outside the worker an attempt is born `created`, version 1, with every provider-, worker-, settle- and resolution-owned column empty, and only the worker writes `actor='worker'` events. `provider_reference` is written once (null → value); outside the worker only in the UPDATE that settles the attempt with `resolution='recorded'` (PAYMENTS-CONCURRENCY-2). The attempt tables and `drawer_terminal_counts` refuse TRUNCATE. 037 takes its ACCESS EXCLUSIVE locks up front and must run outside service hours with the worker idle (PAYMENTS-CONCURRENCY-4).
