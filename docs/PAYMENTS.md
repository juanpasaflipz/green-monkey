# Payments: card terminals, platform orders and platform prices

Area doc for migration 037 (Wave 4, LD-71 and LD-72). The spec is `specs/payments-w4.md`, and the critic's resolutions are binding where they differ. The work ships in two phases:

- **Phase P1** delivers:
  - the whole 037 schema;
  - named manual terminals with fee rates;
  - the "Pagado por plataforma" tender;
  - per-platform product prices;
  - every reader of `tenders.method`;
  - Configuración and the payment dialog.
- **Phase P2** adds integrated Mercado Pago Point and Clip charging: the worker, provider adapters, webhooks, attempts end to end and the resolve dialog (section "Phase P2" below). P2 adds no migration.

## Concepts

- **Tender methods** (`TENDER_METHODS`, `shared/payments.ts`):
  - `cash`;
  - `external`: a card terminal, recorded manually now and integrated in P2;
  - `platform`: the order was paid on Uber Eats, Rappi, DiDi Food or another platform.

  Every reader maps the method by value. An unknown value is refused (`report_method_unknown`, `cfdi_payment_method_unknown`) and never counted as cash. `tests/payments-shared.test.ts` scans `server/` and `shared/` for the old `=== "external" ? … : "cash"` pattern.
- **Terminal** (`payment_terminals`): a named card device with an optional fee rate in basis points, for example 4.18 % entered as `4.18`.
  - Kinds: `manual`, `mercadopago_point` and `clip_pinpad`. An integrated kind needs an active provider account (P2). Without one (or offline, or with the provider down), an MP or Clip device is recorded like a manual terminal used in standalone mode.
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

## Phase P2: integrated Mercado Pago Point and Clip

P2 sends the card amount to the terminal and records the tender itself. The web never calls a provider and never holds a usable credential: it writes attempt rows and queues jobs, and the payments worker (`server/payments/worker/**`) talks to Mercado Pago and Clip.

### One charge (an attempt)

1. **Start** (`POST /payments/terminal/charges`, operators; `startCharge` takes the 933 terminal key). It checks, in order: the terminal is integrated and active; the worker serves the provider (`payments_platform`); the account is active; Pro; MXN; MP's $5.00 minimum (on amount + tip); the order is writable, has no live attempt and the amount fits the balance; this device has an open drawer; the terminal shows no other charge. It inserts one `created` attempt and a `payments_push` job, and wakes the worker after the commit. A replay of the same `operationId` returns the same attempt.
2. **Push** (worker): `created → sending`, then the provider create, then `pending` with the provider's reference.
   - Mercado Pago Orders API: the idempotency key and `external_reference` are the attempt id, so a lost answer is retried with the same key and MP returns the order it already made. Expiration `PT10M` (POS) or `PT5M` (kiosk). 429 and 5xx retry up to 3 times; after that the attempt is `unknown` (`payments_provider_unreachable`).
   - Clip PinPad: no idempotency key exists, so a create whose answer is lost is **never sent again**. The attempt goes `unknown` (`payments_clip_create_outcome_unknown`) and the worker withdraws whatever the reader has not taken (`DELETE /payment/serial-number/{serial}`).
3. **Waiting.** The payment dialog shows «Esperando el pago en {terminal}…» and syncs every 1.5 s (`POST …/sync`: settles an approved attempt or wakes the worker; never a provider call). The worker polls every 2 s for 3 minutes, then every 10 s; a 429 read waits 3.5 s and never changes the attempt. A notification only makes the worker read sooner.
4. **Outcome** (the worker's read under the attempt lock): `approved` (paid amount, tip, card type, brand and last 4, the provider fee when MP gives it, else the terminal's estimate), `declined` (`payments_provider_rejected`), `expired`, `cancelled`, or `unknown` when no final status arrives within the expiration plus 2 minutes (an alert fires).
5. **Settle exactly once** under the attempt's `settle_operation_id` (LO-1): the web job `payments_settle` and every sync race onto the same key, and only the first commit writes the tender (`insertTender` with the provider fields, into the attempt's own drawer), the allocations, `settled`, the check refresh (fiscal ticket at zero balance) and the receipt job. An approval that no longer fits (the order changed, was paid offline, is in recovery, or the approval is flagged) goes to `review` instead; nothing is ever applied twice.
6. **Cancel** (`POST …/cancel`): `created` is cancelled at once; in flight, the worker reads first (a charge paid meanwhile stays approved and settles), then cancels at the provider. A refusal (Clip 400, MP 409) keeps the attempt `pending` with «La terminal ya tomó el cobro. Cancélalo en la terminal.» Only a confirmed cancel or a final status frees the order.

Attempt states and who moves them (037 trigger, `ATTEMPT_TRANSITIONS`): the worker moves `created → sending → pending → approved | declined | cancelled | expired | unknown` (and `unknown` back to `pending` or to a final state); the web moves `created → cancelled`, `approved → settled | review`, `review → settled | dismissed` and `unknown → settled | dismissed`. Final rows never change.

037 also guards inserts (PAYMENTS-CONCURRENCY-1): outside the worker an attempt is born `created`, version 1, with every provider-, worker-, settle- and resolution-owned column empty, and only the worker writes `actor='worker'` events. `provider_reference` is written once (null → value); outside the worker only in the UPDATE that settles the attempt with `resolution='recorded'` (PAYMENTS-CONCURRENCY-2). The attempt tables and `drawer_terminal_counts` refuse TRUNCATE. 037 takes its ACCESS EXCLUSIVE locks up front and must run outside service hours with the worker idle (PAYMENTS-CONCURRENCY-4).

### Resolution (`POST …/resolve`, critic R13)

- `check` (any operator): «Volver a consultar» queues a one-shot provider read.
- `retry` (any operator, no step-up): from `review` when the provider gave the paid amount, the approval is not flagged and the order can now take it.
- `record` (managers, step-up, note ≥ 10 characters, «Revisé el historial del proveedor»): from `unknown` (with the provider's reference typed when none was recorded) or `review`. The tender has no card data and the terminal's estimated fee.
- `not_charged` (managers, step-up): `unknown → dismissed`; refused once the provider said paid.
- `refunded_at_provider` (managers, step-up): `review → dismissed`; the note names the refund done in the provider's app. v1 has no provider refunds through the API and no partial refunds.

Every outcome writes an attempt event and an audit row, and Excepciones lists it: `terminal_attempt_review` (when the approval went to review), `terminal_attempt_dismissed` (every manager resolution, with the manager, the outcome and the note) and `terminal_attempt_unknown_open` (still unknown after 10 minutes).

### Provider accounts and secrets (spec §9.1, §9.2)

- **Connect** (owner, step-up; `POST /payments/providers/:provider/credentials`): MP's production access token and notification secret, or Clip's API key and secret. The web checks the format and seals them at once to the worker's published public key (`payments_platform.upload_public_jwk`, derived from `CREDENTIAL_ENCRYPTION_KEY`), bound to the restaurant and the row. Only the sealed box (`payment_secrets` `credentials_upload`) and the hash of a fresh 128-bit notification token are stored. The reply (`Cache-Control: no-store`, never kept in `operations`) carries the notification URL, shown once with «Copiar».
- **Verify** (worker, `payments_credentials`): opens the box, calls the provider (MP `GET /users/me`, which must be a Mexican `MLM` account; Clip lists the readers), re-seals the credentials at rest (`mp_credentials` / `clip_credentials`) under the active key, activates the account and wipes the upload in every branch. A 401 or a non-Mexican account fails the account (`payments_credentials_rejected`, `payments_account_country`).
- The web login has no SELECT on `payment_secrets`; plaintext never reaches a table, a job payload, an event, an audit row or a log line (`tests/payments-p2-db.ts` checks all of them after every flow).
- **Disconnect** (owner, step-up): refused while a charge is live; the account is disabled and `payments_wipe` wipes its secrets. Integrated terminals then work only as manual records.
- **Devices** (managers): «Buscar terminales» / «Buscar lectores» refresh the device cache (at most one search a minute); a found device is added as a terminal; an MP device switches between «Integrado (PDV)» and «Independiente» (step-up; restart the terminal).
- **Key rotation:** `npm run vault:rekey` re-seals CFDI and payment secrets under the newest `CREDENTIAL_ENCRYPTION_KEY` entry (RUNBOOK "Credential key rotation"). It lists every restaurant with sealed provider credentials through 037's `payment_provider_accounts_rekey_list` policy (worker only, and only in a transaction that sets `app.payments_rekey_list`, like CFDI's `cfdi_organizations_rekey_list`; LD-76 deviation 1), then re-seals each restaurant in its own tenant transaction. The worker also re-seals a credential under the active kid whenever it opens one.

### Notifications (pre-auth `POST /api/payments/webhooks/:provider/:hook`)

- Always answered 200 with an empty body, so it never reveals whether a hook or an id exists. Screened first: token format, per-IP and per-hook limits, 16 KB body, MP topic `order`.
- The hook's hash finds exactly one active account and only its live attempts (037 lookup policies); an id that is not live writes nothing.
- **Mercado Pago:** the worker verifies `x-signature` (HMAC-SHA256 over `id:{data.id};request-id:{x-request-id};ts:{ts};` with the sealed notification secret) before anything else. A missing or wrong signature is a `webhook_rejected` event and **no provider read** (it fails closed); polling still settles the charge.
- **Clip:** a notification is only a hint: the worker reads the payment from Clip and trusts nothing in the body.

### Configuration and capabilities

- Worker: `PAYMENTS_PROVIDERS` (`mercadopago`, `clip`; empty = integrated charging off), `CREDENTIAL_ENCRYPTION_KEY`, `WORKER_DATABASE_URL`. `MERCADOPAGO_API_URL` and `CLIP_API_URL` may point at a loopback fake only in development and test.
- Web: `WORKER_URL` lets the web wake the worker (`POST /wake`, 202, coalesced by `poke()`); without it the worker's 5 s sweep applies.
- `/capabilities` has `mercadopago` and `clip` entries: `{enabled: true}` or a reason (`worker_not_configured`, `not_connected`, `verifying`, or the account's error code).

### Screens

- **PaymentDialog:** chips «Efectivo · Tarjeta · Plataforma». On «Tarjeta» an integrated terminal (online, with its connectivity: «Conectada», «Sin conexión», «Sin datos») shows only Importe and Propina and the button «Enviar a {terminal}». The waiting panel (`TerminalWait`) shows the amount, the elapsed time and the state; it offers «Cancelar cobro» and «Cambiar de terminal» while waiting, «Reintentar» and «Otra forma de pago» after a decline, «Cobrar sin integración» (the same terminal recorded manually) when the integration itself failed, «Volver a consultar» and «Resolver cobro» (managers) when the outcome is unknown, and never a blind retry. Closing while a charge is live asks first and keeps the charge. Offline, integrated terminals are manual only and a known live charge refuses an offline collect for its order. A reload resumes waiting (the attempt id is kept per restaurant and device in `sessionStorage`).
- **Cobros en terminal en curso** (`ActiveCharges`, Venta and Órdenes): live and review charges with order, terminal, amount, state and age, and «Resolver cobro».
- **Configuración → Pagos con tarjeta y plataformas:** Mercado Pago and Clip sections (`ProviderAccounts`) under Terminales.
- **Cobro de prueba:** v1 has no automatic preflight charge. Charge a real low-value order (at least $5.00 on MP) with «Enviar a {terminal}» and cancel it on the terminal or refund it in the provider's app; the button in Configuración explains this and opens Venta.

### Tests

- `tests/payments-mercadopago.test.ts`, `tests/payments-clip.test.ts`: the pure adapters (statuses, amounts, identity checks, the signature).
- `tests/payments-p2-db.ts` (in `test:db:qualification`): start, settle exactly once under races, review and resolution, the worker against the HTTP fake (`tests/fakes/payments-fake.ts`), notifications through the real route, credentials and leaks, capabilities, devices, disconnect, rekey and the lock-order burst.
- `tests/drain-http.ts`: the worker's `POST /wake` on the compiled build.
- `tests/browser/payments.spec.ts`: Configuración connects both providers and adds their devices; a charge waits and settles; a decline retries; an unknown outcome is resolved by a manager (CI starts `npm run dev:payments-fake` and the worker with the fake's API bases).
- The fake's credentials, cards (`visa` / `4242`) and devices are fictional and obviously so.

### Still open

- The real-device rehearsal on staging (RUNBOOK "Real-device rehearsal") verifies MP's reference and last-4 sources (deviation 8) before the pilot.

### Privacy inputs for the legal set (critic R40)

Payments supplies these lines; the loyalty track drafts them into the platform privacy notice and DPA in `shared/legal/*` (LD-74), and counsel reviews them (LD-3):

- **Data categories (DPA §2):** card brand, card type and the last 4 digits of a card charged on an integrated terminal (stored on the tender and the attempt; never the full number, the expiry or the cardholder's name, which the adapters discard). No diner identity is stored on an attempt.
- **Transmission (DPA §11):** on the restaurant's instruction, the amount, tip, an opaque reference (the attempt id) and, for Mercado Pago, a description ("Orden {n}") go to the restaurant's own Mercado Pago or Clip account; Green Monkey keeps the restaurant's provider credentials sealed (custody), opened only by the payments worker.
- **Processors:** none new: Mercado Pago and Clip act for the restaurant (its own accounts), not for Green Monkey.
- **Restaurant-notice checklist** (ACCOUNT_AND_LEGAL "Restaurant privacy notice"): add the line "card brand, type and last 4 digits of card payments, kept with the sale".
- **Retention:** payments evidence (attempts and their events) is kept 5 years with no retention rule, like the other fiscal money records (R41).
- **Timing:** a material DPA change is published at least 15 days before integrated charging is enabled for a restaurant in production with users (LD-72 Q8: none yet).
