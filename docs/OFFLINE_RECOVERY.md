# Offline and payment recovery

Status on October 5, 2026 (wave 1, offline track, migration 026): the offline
selling and recovery changes below are implemented and qualified **locally**
(unit, isolated database suites, compiled-server browser tests in Chromium and in
Playwright's emulated WebKit iPad). They are **not** deployed to staging, and they
have **not** been checked on real tablets, real thermal printers or a real ISP
outage. Those remain release gates (see "Verification").

## What staff see

The POS decides it is offline from what actually happens, not from
`navigator.onLine`:

- A heartbeat calls `GET /api/offline/ping` (every 30 s while online, every 2–15 s
  while offline, 120 s while the page is hidden). After one failed ping or request
  while still online, the next ping comes 3 s later instead of 30 s, so an idle
  device notices an outage within about 40 s, not after two full cycles.
- Every API request reports its outcome. Two consecutive failures (network error,
  timeout, 5xx, a non-JSON or HTML proxy page) switch the device to offline; two
  consecutive successes switch it back. A browser that reports itself offline is
  offline immediately.
- Requests time out (GET 8 s, POST 15 s, offline sync 20 s), so a hung server never
  leaves a dialog stuck.

The top bar pill always shows an icon and text, at every width: **Conectado**,
**Conexión lenta**, **Sin conexión** or **Sin conexión (manual)**, plus
"· N por sincronizar". A full-width banner explains the state:

| State                                    | Banner                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offline                                  | "Sin conexión con el servidor. Las ventas se guardan en este dispositivo y se envían al volver la conexión." plus the offline-window line and **Comandas (k)** / **Ver sincronización** |
| Manual                                   | "Trabajando sin conexión por decisión del equipo…" with **Volver a conectarme**                                                                                                         |
| Slow (2 of the last 3 requests over 4 s) | "La conexión está lenta…" with **Trabajar sin conexión**                                                                                                                                |
| Kitchen role offline                     | "Sin conexión: esta pantalla no recibe pedidos nuevos. Pide las comandas impresas o en voz al mostrador."                                                                               |

The offline-window line reads "Puedes vender sin conexión hasta las HH:mm", turns
amber and bold in the last 30 minutes, and once the window has ended says that no
new sales can be saved until someone reconnects and signs in. The banner also warns
when any unsynced record is older than 20 hours (if it does not sync soon, the
global invoice for that day will be issued late, flagged and alerted; see "Late
sales and the global invoice") and when the device clock differs from the server
by more than 2 minutes.

**Trabajar sin conexión** (Sync screen switch, slow banner) is a device-local mode
for any operator. While it is on, the POS never attempts blocking server commands
such as sending or charging; background probes and background sync continue
whenever the server answers. What is saved in this mode syncs like any offline
record, including its stock policy (see "Stock policy at sync"). The mode survives reloads and sign-outs, so the login
screen says the device is in offline mode and offers **Volver a conectarme**.
Signing in always reads the new session from the server, even in that mode; only
the startup check is skipped. A cached session is never restored right after a
sign-in, so a shift change can never continue under the previous employee.

A reload during an outage restores the cached session (any transient failure, not
only a browser that says it is offline) while its offline window is open. If the
window has ended, the login screen says signing in needs a connection and offers a
backup download of every unsynced record without a session.

## What can be done offline

| Action                                                                                                                                | Offline                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| New order paid in full in cash                                                                                                        | yes                                                                                                    |
| New order paid in full on a separate card terminal (staff confirm approval and type its reference; nothing is verified with the bank) | yes                                                                                                    |
| Item split                                                                                                                            | no (disabled; an offline save refuses it with "Dividir por productos no está disponible sin conexión") |
| Settle several orders together, voids, refunds, discounts, drawer open/close/paid-out                                                 | no: unavailable offline (they need the server and fail with a connection message)                      |
| Integrated card charges, invoicing                                                                                                    | no                                                                                                     |

Open-price lines are allowed offline (wave contract D11): the server re-prices them
with the same staff rule at sync.

### Table service offline (Beta, off by default)

Offline table service (open checks, rounds and partial payments without a
connection) is a **per-restaurant beta setting that ships off** (lead decision
LD-7), because it is where offline and online records meet. Owners and managers
turn it on or off on the Sync screen under **Servicio de mesa sin conexión
(Beta)**; the change is audited (`offline.settings_changed`) and requires a
recent PIN (step-up, D23). Devices read the setting when selling
opens and when the connection returns (it is never polled) and keep the last
answer for an outage; a device that never read it treats it as off.

With the setting **off** (the default), offline selling is limited to new orders
paid in full, in cash or by a recorded external terminal, plus the kitchen
fallback. An order already on screen shows "Disponible al volver la conexión" and
takes no items or payments; **Enviar (sin conexión)**, partial payments and
**Órdenes abiertas** are unavailable (`offline_table_service_off`), and the device
never fetches the open-orders snapshot (the server refuses it as well). Records
saved while it was on still sync after it is turned off: sync never consults the
setting.

With the setting **on**:

| Action                                                                               | Offline                                                                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **Enviar (sin conexión)**: send a new order to the kitchen without paying            | yes, it becomes a local open order with a provisional number                               |
| Add items to a local open order or to a server order cached before the outage        | yes, as a new round (additive; no version check), only while the check still has a balance |
| **Cobrar** a local or cached order, in full or in part, by cash or external terminal | yes, revalidated against the balance at sync                                               |
| New order paid in part                                                               | yes (order and payment saved together)                                                     |

The setting ships as the separate `feat(offline-tables)` commit series (wave
contract §8.1), so the core fixes can ship without it.

**Órdenes abiertas** (next to Borradores while offline) lists the server open orders
cached before the outage, "Órdenes guardadas antes de perder la conexión (HH:mm)"
(refreshed every 120 s while selling is visible; current and previous business
day, at most 200), and the orders created on this device that the server does not
have yet. Each row shows the number, table, name and the balance due. Every server
order selling handles online (send, round, payment, resume), and every order an
offline record has just synced into, is also stored in that cache at once, so the
order on screen when the connection drops can be paid offline at its current
balance; an older copy never replaces a newer one. Offline, the order on screen
shows the cached copy plus this device's rounds and payments that copy does not
contain yet. The server lists, with each cached order, the tenders and offline
records it already contains (a payment a manager reconciled is recognised by its
tender), so a record is never counted twice and never dropped, whatever the device
clock says. Money another employee collected on this device (before a shift
change) counts too. Paying a cached server order warns that it may have been paid
on another device.

A round or payment for a local order waits until that order has synced (it is
never sent to another order). Once a local order's record has synced, the server
owns the order: offline it is served only through its cached server copy, and
when that copy closes (paid or closed online) the order is no longer offered or
accepted offline (`offline_order_not_cached`). A payment that would exceed the
server balance at sync (for example because the table was paid on another device
after the last refresh) is refused and shown for review; it is never partially
applied. Local orders are only changed through offline records, even after the
connection returns; once their record syncs, selling continues on the server order.

What this does and does not guarantee about charging twice, or too little:

- "Charging that order online" means every path on this device that charges a
  server order: **Cobrar** in selling, and **Órdenes › Cobrar juntas** (the
  grouped settlement), which checks every selected order before it sends
  anything and names the order it refuses ("#142 · …"). In Órdenes, an order
  with such records cannot be selected and shows the reason until they sync.
  Service's settlement dialog (`SettlementDialog.tsx`) reads the full orders
  and runs this guard (`onlineChargeRefusal`) right before it posts
  `/settlements` (done at offline's merge, LD-10 B2); no other charge path
  exists in this wave. The retry of a payment attempt is not a new charge: it resends the same
  attempt, and no offline payment can be saved for an order while it exists.
- On this device, while an offline payment for an order is still unresolved,
  charging that order online is refused ("Esta orden tiene un pago por
  confirmar…"), and selling reads the order again as soon as the payment syncs.
- On this device, while an offline round for an order is still unsynced (its
  sync failed transiently, for example during a deploy, or it waits in backoff),
  the server balance does not include its items, so charging that order online
  is refused ("Esta orden tiene productos guardados sin conexión que aún no se
  sincronizan…") and the device syncs it at once. A round in review blocks the
  charge until a manager decides ("Un gerente debe revisarlos en Sincronización
  antes de cobrar"); rounds cannot be reconciled, so the manager archives it and
  the items are added again online before charging. Another employee's round on
  this device syncs only in that employee's session, and the refusal says so.
  Once the round syncs, selling reads the order again, and an amount still at the
  old balance in the open payment dialog follows the new one; a charge started
  from the old copy is refused with "La orden cambió…". This keeps a guest from
  leaving without paying items served offline, and keeps the round from being
  refused later on a paid check.
- The device cannot know about money taken elsewhere after its last refresh. A
  cached copy can be stale (the check was paid on another device or online after
  the snapshot), so staff may collect money for a balance that no longer exists.
  The server never records it: the payment becomes `offline_payment_exceeds_due`
  for a manager, who checks it, returns the money to the guest if it was charged
  twice, and archives the record. That is why paying a cached order shows its
  warning, and why the setting ships off.

#### Rounds on paid or ticketed checks

A check with no balance left (dine-in "Pagada · por liberar", a closed check, and
since fiscal 027 any check with a numbered ticket) takes no offline round. The
device refuses it with "Esta cuenta ya está pagada. Envía lo nuevo como orden nueva
para la misma mesa." (`offline_check_paid`) and offers **Enviar como orden nueva**,
which saves the items as a new local order for the same table, mode and name. The
balance is the projected one: the order total plus this device's unsynced rounds,
minus the server's payments and this device's unsynced payments. The same rule
applies to a round added in the same checkout as a payment; neither row is written.
If the cached copy was stale and the check was paid after the snapshot, the server
refuses the round at sync (`offline_order_closed`: "La orden ya no acepta cambios:
está cerrada, cancelada o en conciliación, o ya tiene ticket con folio…") and a
manager archives it; a paid check is never reopened by an offline round.

A manager reconciles an offline payment (see Review below):

- into its order when it fits the balance, recording it in the original drawer
  even if that drawer is closed; the order stays a normal order;
- never while its original local order is still queued (on this or another
  device): the review says "Esperando a que se sincronice la orden original" and
  offers only archive. Recording the money first would leave the real order to
  sync unpaid later, counting the revenue twice;
- as a financial-only recovery only when its order was archived, cancelled, is in
  recovery or does not exist;
- never into a paid or closed check (`offline_payment_exceeds_due`); the manager
  archives it instead.

Before any offline save the device checks: the session may sell (Free selection),
the offline window is still open by the server-corrected clock, the device clock
has not been set back since its last contact, a drawer was open and cached before
the outage, table service is on for anything but a new order paid in full, the
order has no unresolved online payment, and the record fits in local storage
(otherwise "No hay espacio en este dispositivo…").

## Provisional numbers

Each offline sale gets a number such as **B-07**: a per-device letter prefix
assigned once by the server (`A`…`Y`, then `A1`…`Y9`; immutable once set) and a
per-device, per-business-day counter. A device that never fetched a prefix uses the
reserved `Z` family derived from its device id. While only the device knows the
order, the receipt shows "Número provisional B-07" and "El número definitivo se
asigna al sincronizar."; once the server has numbered it, receipts, the cart
heading, the open-orders list and the Sync screen show "B-07 → #142" and never the
provisional hint, and `Order.offline` keeps the provisional number and the sale
time for reprints.

A provisional number is never a fiscal folio (LD-12). The local receipt prints the
issuer data from the fiscal context cached on the device (Dexie
`{tenantId}:fiscal-context`, refreshed at every sign-in and when the window
regains focus after a minute) and "Folio fiscal pendiente: se asigna al
sincronizar." (a partial local payment says the folio comes when the check is
settled). The server assigns the consecutive folio when the sale syncs (or when a
manager reconciles it), with the sale's business date; order history and reprints
then show "Folio …" and "Venta sin conexión B-07 · {fecha}", staff find the order
in Órdenes by its provisional number, and the Sincronización list maps
"B-07 → #142 · Folio 000123" ([FISCAL.md](FISCAL.md)). A financial-only recovery's
ticket prints its frozen line "1 × Venta sin conexión conciliada".
Printed receipts are always in Spanish, including the "Número provisional" label,
whatever the device language. Records never carry tax: the device's tax snapshot
is dropped from the receipt snapshot, and the server re-prices lines with its own
fiscal context at sync: a change of the tax region or the default product tax
applies to sales still queued (the profile save never invalidates leases), so make
those changes only after every device has synced. Changing a product's tax bumps
its version, so queued offline sales of that product go to manager review
(`offline_catalog_changed`).

## Kitchen during and after an outage

During the outage the KDS receives nothing over the network. Each offline sale
produces one comanda per station (kitchen, bar) with "COMANDA · SIN CONEXIÓN",
the provisional number, mode, table, call name, time and lines. A round's comanda
shows the round it takes in the order as the device saw it (the cached copy's
last round plus this device's earlier unsynced rounds, so "#142 · Ronda 4" when the
order already had three) and, once synced, the order's real round, the one the KDS
review lane shows.

- **Print**: a local receipt offers **Imprimir comanda** for exactly what that
  save sent to the kitchen: the new order, or the new round added while paying,
  never the order's earlier rounds again (nothing when a payment added no items).
  A local or cached order on screen offers **Imprimir comanda** for all its
  comandas saved on this device. The Sync screen setting "Al guardar sin conexión"
  (Preguntar / Imprimir comanda / Imprimir comanda y recibo) can print
  automatically right after saving; with **Preguntar** (the default), an offline
  **Enviar** shows "Comanda guardada en este dispositivo…" with **Imprimir
  comanda**. The local receipt, shown and printed, is service's receipt (kind
  "local", LD-10 B4): lines with options and notes, the order and round notes
  (LD-1), the payment method, the external-terminal reference, cash received and
  change, and what was collected, with the balance after a partial payment
  (Beta table service). Only that payment prints as "Cobrado · pendiente de
  sincronizar"; what the check had already been paid before it (tenders recorded
  online, earlier payments) prints as "Cobrado". A round added offline keeps the
  cart's round note in its record, so the note prints on its comanda and on the
  local receipt and reaches the round when it syncs; the open-orders cache keeps
  each server order's round notes for the same reason. Printing uses the
  browser/OS print dialog; the browser cannot confirm that paper came out.
- **Device list**: "Comandas sin conexión" (banner button) lists the last 24 hours
  with local Pendiente/Lista/Entregada chips and **Reimprimir**. The list stays on
  the device; the kitchen does not see it.

After reconnect, rounds created by sync start in state `offline_review` and wait in
the KDS lane **Ventas sin conexión por revisar**, showing "B-07 → #142", station,
round, mode, table, lines, "Vendida HH:mm · sincronizada HH:mm" and whether the
comanda was printed or only listed. **Ya se preparó** completes the round (and
acknowledges that round's pending void tickets); **Preparar ahora** sends it to the
live KDS. The first decision wins. Owners, managers and kitchen may do both; servers
only "Ya se preparó"; cashiers only see the lane. An order whose online create had
committed before the outage (lost response) is reused, not duplicated, and its
rounds stay live.

The lane sits above the KDS tickets (service's `beforeTickets` slot) and follows
the KDS's selected station: **Todas** shows every station's rounds, **Cocina** or
**Barra** only that station's, with a count of what waits at the other station.
**Marcar todas como ya preparadas** marks only the rounds on screen, so clearing
the kitchen never hides the bar's drinks. The lane loads when
the screen opens, when the page becomes visible, when the connection returns and
after each decision, then every 10 s while it has something to review and every
30 s while it is empty (visible pages only).

The KDS screen never shows a round in `offline_review` as a live ticket: it waits
only in the lane until someone decides, and "Preparar ahora" moves it to the live
columns of its station. Service excludes `offline_review` on the server
(`kitchenFeed`, `clearStaleRounds` and the legacy `GET /api/kitchen`, contract
D13), and the decision endpoint bumps the kitchen feed last, so a "Preparar ahora"
ticket appears on the next KDS poll.

## Sync, retries and exactly-once

Every record carries an `operationId` created once per save; it is the server
idempotency key. Sync (`POST /api/offline/sync`), the legacy `POST /api/sync`
and manager reconcile all run inside `once(operationId, "offline_sync")`, so a
record applies at most once whatever the path or retry. Manager archive takes the
same advisory lock, so exactly one of archive or sync wins.

Retry policy:

- Transient failures (network, timeout, 5xx, non-JSON, 429, database unavailable,
  contention the server gave up retrying (`concurrent_update`), a JSON 404 from a
  server rolled back to a build without the sync endpoint, a device clock slightly
  ahead, a dependency still queued) are retried forever
  with jittered backoff capped at 60 s. They never become conflicts themselves,
  and they never turn a later record into one: while a record waits on a
  transient answer (or its backoff), every later record of the same order waits
  behind it in that pass, without counting an attempt. For example, a checkout that
  added items and paid saves a round and then a payment that includes the round's
  amount; the payment is never sent before the round.
- Attempts are not counted, and sync is not attempted, while the device is offline.
- Only explicit domain answers (price changed, product changed, evidence not
  verifiable, outside the offline window, another drawer open, settings changed,
  payment past the balance…) mark a record **Requiere revisión**.
- Synced and archived rows are kept 7 days on the device, then pruned. Unresolved
  rows are never pruned. Background passes (every 10 s) prune at most once an hour;
  reconnect and manual passes always do. Pruning walks indexes and keys only, so it
  never reads the cached menu or open orders.

The server re-prices every line from today's catalog and refuses any total or
product-revision mismatch (`price_conflict`, `offline_catalog_changed`); it never
silently charges a different amount. An online create whose response was lost is
reused only when the device priced it exactly as the server did, and a sale never
reuses an order that already took money; otherwise the record goes to a manager
(`price_conflict` or `offline_payment_exceeds_due`) instead of becoming a partial
payment. Items an online send already recorded (its response was lost, so the
draft kept their ids) are never inserted again: the record becomes
`offline_lines_already_sent` for a manager, who archives it when the order already
has them, instead of a server error retried forever. More generally, a record that
collides with rows the server already has (a unique or foreign-key violation, for
example a table deleted after the outage) is `offline_record_conflict` for a manager,
never a 500 retried forever. Payments go through the normal payment command,
so a record can never pay past the order's balance (`offline_payment_exceeds_due`).
The order's business date comes from the validated sale time, not the sync time.

**Stock policy at sync (decision LD-13, accepted).** Every offline record that
moves stock (a sale, an order sent with **Enviar (sin conexión)**, a round) syncs
with `stockPolicy: "allow"` (offline D8), whatever the restaurant's negative-stock
policy, because the sale physically happened. Stock may therefore go negative even
when the restaurant uses `block`: the ledger records every movement and the
ingredient shows **Negativo**, as under `allow`, and the record does not go to
manager review for stock. This includes records saved while the server was
reachable in manual **Trabajar sin conexión** mode, which stays available to every
role: it exists for slow or flaky connections, and gating it would add friction
during a rush. An item 86'd after the device cached its catalog is different: the
server refuses its line at sync (`unavailable`) and the record goes to manager
review. See [Menu, tables and ingredients](MENU.md) (negative-stock policy).

## Clock handling

Records carry the server-corrected sale time, the raw device time and the measured
offset (median of the last 5 pings, kept on the device). The server accepts a sale
up to 2 minutes after its own clock, up to 5 minutes before the lease window or
drawer opened, and up to 2 minutes after the window or drawer closed, and clamps the
sale time into those bounds. A record more than 2 minutes in the future is retried
later (the device clock may simply be ahead); one outside the window goes to a
manager. Records cite the offline lease they were made under, never the live
settings version (the old live-vs-lease bug blocked review and drawer close).

The corrected clock cannot be moved back by changing the device time. Every
successful ping anchors it to the server's time and the page's monotonic clock,
and the device keeps the latest corrected time it has shown. The corrected time
is the later of the device clock plus the offset and that anchor, so setting the
clock back neither reopens an ended offline window nor backdates a record. If the
device clock drops more than 2 minutes below its earlier readings (in the page, or
since the app was last open), offline saves stop with "La hora de este dispositivo
se atrasó desde la última conexión…" until a ping measures the server time again.

## Lock order

Offline sync follows the binding
[global lock order](ARCHITECTURE.md#global-lock-order-binding), written in full
by Wave 2.0 (platform). `tests/lock-order.test.ts` checks it statically for each
unit it can see (the appliers and reconcilers, `applySale`, `reconcileSale`;
not the dynamic `appliers[kind]` dispatch from `syncOfflineRecord`), and the
concurrency bursts that run through `tenant()` fail on any retried deadlock
(`noRetries`, LO-R9; `tests/db-retries.test.ts` checks that each is wrapped): the `once()`
key, the restaurant row (`FOR SHARE`), area serialization locks (including the
offline prefix and archive advisory locks, which are config paths only, and the
catalog `FOR SHARE` of `verifyLines`), `order_numbers`, `orders` (several sorted
by id), `rounds`, `line_voids`, `stock_items` (all at once through
`lockStockItems`), `kitchen_feed_versions`, then the drawer (`cash_sessions`)
and the fiscal folio counter (027) last.

A sale takes order numbers → order → stock → rounds → feed inside `createOrder`,
then `recordPayment` locks its own new order and the drawer, and the ledger row
is written. Three sanctioned exceptions apply (ARCHITECTURE "Global lock
order"; E5 and E6 by lead decision LD-21). E4: sale, order and round sync then
place the rounds they just created in kitchen review
(`placeRoundsInOfflineReview`) after the drawer and after the fiscal folio
counter (027; LD-15 fiscal Q4). Only rows inserted by the same transaction are
updated, so no other transaction can hold or wait for them; reordering is
blocked by the foreign key to `offline_sync_records`, whose ledger row needs
the tender id first. E5: `createOrder`'s refresh cannot issue (nothing is paid
yet), so the payment's fresh key, its new order row and the drawer after it are
not a step back from the folio counter. E6: a manager reconcile whose target is
a cancelled online create or unresolvable falls back to a financial-only
recovery, whose new order takes an order number after that lookup. Every other
offline path follows the order: a payment takes the order, then the drawer; a
round never bumps the feed; a manager reconcile takes the order, then the
drawer. None locks an order after the drawer.

## Late sales and the global invoice

A sale keeps the business date of its validated sale time, whenever it syncs.
Under cfdi decision D5, each period's global invoice is built at close + 60
minutes; a sale that syncs later goes into a supplementary global part for its
own period (never the next one), and a part created after the period's 24-hour
deadline is flagged "Emitida fuera de plazo" and alerted. Reaching it needs no
manager action beyond syncing or reconciling the record. The 20-hour warning on
the device still leaves at least 4 hours for a daily period. Built in cfdi 030: the
worker's `cfdi_global` tick creates the part, the Facturas globales register
shows it with "Emitida fuera de plazo" and the alert key is `cfdi_global_late`
([CFDI](CFDI.md) "Global periods").

## Background requests and the GAP-4 gate

Offline adds this steady authenticated traffic, which ops' load test models
before launch:

| Who                                         | Request                        | Rate (visible page)                                              | Notes                                                                         |
| ------------------------------------------- | ------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Every device                                | `GET /api/offline/ping`        | every 30 s (120 s hidden); one extra ping 3 s after a failure    | pre-auth, no tenant data; one shared `select 1` at most every 2 s per process |
| Every KDS screen                            | `GET /api/offline/kitchen`     | every 30 s while the lane is empty, 10 s while it has items      | one indexed query                                                             |
| Selling devices, only with table service on | `GET /api/offline/open-orders` | on opening selling and every 120 s                               | one bounded query (2 business days, 200 rows)                                 |
| Selling devices                             | `GET /api/offline/settings`    | when selling opens and when the connection returns; never polled | one row                                                                       |
| Devices with unresolved records             | `POST /api/offline/sync`       | only while records are due                                       | one record per request                                                        |

With the default settings (table service off) no device fetches open orders.

## Authenticity, eligibility, review and archive

The server first decides whether the evidence is **authentic** (the session exists,
tenant/employee/device and lease match, currency, drawer of that device, amounts)
and separately whether it is **eligible** to sync automatically (not archived, same
employee on the same device, session not revoked, employee and device active,
selling allowed, time within tolerance, that drawer still open, settings unchanged).
Under the wave contract (D6) an ended session (logout, switch, PIN reset, role
change) is valid evidence for the same person on the same device, and only a
revoked session (employee deactivated or device unpaired) needs a manager: its
records go to **Requiere revisión** (`offline_conflict`) for reconcile or archive.

On the Sync screen a manager can:

- **Revisar** any unresolved row. Review never fails because evidence is bad; it
  shows the original employee and whether that session is still valid, drawer,
  amounts, method (efectivo or terminal externa), reference, sale time and whether
  the server already has the record. Each problem is explained with its way out:
  which rule stopped it (session revoked, employee or device inactive, selling not
  authorized, settings changed, price or product changed, lines already sent), and
  for a sent order or round, which carry no money, that the way out is to archive
  it and add the items online. The panel title follows the record ("Conciliar
  efectivo ya recibido", "Conciliar cobro con terminal ya recibido", "Revisar orden
  enviada", "Revisar ronda"), and when nothing can be reconciled it says why.
- A record that nothing blocks syncs by itself once the employee who saved it
  signs in on that device; the review says so ("Este registro se envía solo cuando
  Dani inicie sesión en Caja 2…") and keeps reconcile behind **Conciliar de todos
  modos**, because a reconcile keeps only the money (no lines, kitchen or stock).
  **Reintentar sincronización** sends only the signed-in employee's records, and
  rows saved by someone else say so. A record already on the server offers
  **Marcar como registrado** instead of reconcile or archive.
- **Conciliar** authentic cash or terminal sales: the money is recorded once in the
  original drawer (even if closed) as a financial-only recovery order, with kitchen
  and stock follow-up tasks, and gets a fiscal ticket (source `recovery`: one line
  "Venta sin conexión conciliada" at the restaurant's default tax, issued by the
  reconciling manager). A reconciled payment of a table check goes into its
  order (see "Table service offline"); the device stores the tender the reconcile
  made, so offline balances count it once.
- A sale whose online create had already committed (its response was lost) and
  that sync refused (`price_conflict`, `offline_payment_exceeds_due` or
  `offline_order_already_exists`) already has its order, which the kitchen made.
  The review names it ("Registraremos el cobro en la orden #N…"). When that order
  is open and the sale's amount fits its balance, **Conciliar** records the money
  into it, in the original drawer, with no recovery order; any balance left (the
  device's price was lower) is collected or voided on the order. Otherwise the
  review explains why nothing can be reconciled (the order is paid, closed, or
  smaller than the money) and offers only archive; the money is never recorded
  beside that order as a second one. If that online order was cancelled (every
  line voided), the money is reconciled as a financial-only recovery instead, once
  per draft. An offline order (Enviar) whose create committed online with the same
  draft and price syncs into that order by itself, and the review says not to
  archive it. At another price it is archived; its offline payments are then
  reconciled into the online order instead of a recovery order, and the review
  lists its offline rounds, which cannot be reconciled, so their items are added
  online to that order first. A different draft under the same id is never merged:
  its payments are reconciled as money only.
- **Archivar registro local** for anything, including evidence that cannot be
  verified or does not parse: a reason (10–500 characters) and confirmation are
  required, the evidence is kept verbatim on the server with its hash and the
  manager's name, and nothing is added to sales or the drawer. Drawer close then
  counts the row as resolved and notes "Este dispositivo archivó $X de ventas
  locales de esta caja. Ese efectivo puede aparecer como sobrante." Only archived
  cash counts there; archived terminal payments are named apart ("…no afectan el
  efectivo"), because they never put cash in the drawer.

## Uncertain online payments

An online payment whose answer is lost stays in the device's single active slot
and is resolved with its exact command (status, then the same retry). If the server
needs a manager (for example the attempt belongs to an older session), the attempt
is **parked** under its own key: it blocks only its own order, "Nueva orden" and
other sales stay available, and the Sync screen lists it as "En revisión". An
attempt is never overwritten.

When **Consultar estado** finds no safe result (the server never recorded it and
the device may not resend it), a manager resolves it: **Registrar cobro
verificado** records the money the guest handed over in that order, in the
attempt's original drawer (open or closed), never past the balance; **Descartar
intento (no se cobró)** records that the guest was not charged. Both need a reason
and a confirmation, are audited with the original employee, device and drawer, and
close the attempt's own operation id on the server, so the original request can
never also apply. The attempt then leaves the device and its order can be charged
again. A parked attempt never blocks an app update; only unsynced records and a
payment in flight do.

## Service-worker updates

The build id is baked into `sw.js` at build time and the worker is registered at
the fixed `/sw.js`; each revision uses its own `green-monkey-shell-<build>` cache.
Install refuses HTML from another build, caches every hashed asset first (an HTML
fallback page is never accepted as an asset), writes the HTML last and deletes its
own cache on any failure, so a failed update on flaky Wi-Fi can never leave a
half-cached shell. Navigations use the worker's own revision. A new revision waits;
the bar "Hay una nueva versión lista." applies it only when the device has no
unsynced record and no payment in flight, under the exclusive session-transition
lock. Otherwise it activates when every tab closes. `/api` responses are never
cached.

## Storage persistence and installing

After the first online load the app requests persistent storage automatically (at
most once a day while not granted; Firefox shows a prompt, Chromium and Safari
decide themselves). The Sync screen shows the result. The app ships a web app
manifest and icons so it can be installed to the home screen. On iPad/iPhone an
installed app has its own storage, separate from Safari: pair and sign in inside the
installed app, and do not switch between the two while records are unsynced.

## Supported browsers

Chrome or Edge 111+, Safari 16.4+ (iPadOS/iOS 16.4 or later) and Firefox 114+
(the Vite 8 default build target). The app refuses to start on browsers missing
IndexedDB, Web Locks, AbortController, `AbortSignal.timeout` or
`crypto.randomUUID`. A browser without service workers (for example a private
window) can sell offline only while the page stays open; the Sync screen says so.

## Physical limitations

- If browser storage is erased before the server acknowledges a record and no
  backup survives, the record cannot be recovered. There is no hidden cloud copy.
- Browser printing cannot confirm that paper came out. On iPad, printing goes
  through AirPrint, which most thermal printers do not support; there the device
  ticket list may be the only kitchen fallback.
- There is no LAN or peer-to-peer KDS during an outage.
- A backup is evidence for manager review, not proof that cash, kitchen work or
  stock movement happened.
- Recovery never performs another real customer payment.

## Data model (migration 026)

- `offline_sync_records`: immutable ledger of every applied record (kind, path,
  device, employee, session, order, tender, round, provisional number, recorded
  time, raw device time, offset, validated `sold_at`, `business_date`, kitchen
  delivery, amounts, `synced_at`). Reports and CFDI read the sale day from here.
- `offline_kitchen_reviews`: one pending → decided transition per offline round.
- `offline_archives`: manager archives with verbatim evidence and its sha256.
- `devices.offline_prefix`: unique per tenant, immutable once set.

All tables use forced row-level security with tenant checks on reads and writes.
The runtime role can only insert into the ledger and archives and can only update
the decision columns of reviews; it cannot delete any of them.

## Wave-1 integration notes

Rollout: a tab still running a pre-026 revision on the same device (for example in
a private window without a service worker, or during the first update) treats every
status other than "synced" as unsynced and can post an archived row to `/api/sync`,
rewriting it to pending or conflict. Such a row keeps its `archivedAt`, so it still
counts as resolved for drawer close and updates, and the next sync pass of the new
revision puts its status back to archived. Close old tabs after the update.

Reverting the table-service series (wave contract §8.1): revert every commit whose
subject starts with `feat(offline-tables)`, `style(offline-tables)`,
`docs(offline-tables)`, `fix(offline-tables)` or `test(offline-tables)`, newest
first. The core commit `0604935` (prettier formatting) sits between two of them and
touches `tests/offline-records.test.ts`, so the last revert (`cf69988`) stops with
one conflict in that file; resolve it by taking the side being reverted to, which
drops the table-service record tests. Checked in a scratch clone: the remaining
core then typechecks, lints and passes every unit test.

Since the wave merged, offline uses the real modules the wave contracts named
(the in-wave `server/compat` and `src/compat` stand-ins are gone): access's
`leaseForEvidence` with every renewal window, service's check lifecycle, kitchen
feed bump and `applyRound`, and service's print primitive and kitchen ticket
document. The offline window is the base lease plus access's renewals, and the
time rule accepts evidence inside any of them.

Lock and connectivity (LD-10 B6): access's lock screen and its offline "Continuar
como" follow offline's heartbeat, that is whether the server answers, not the
**Trabajar sin conexión** preference. With the server reachable the lock asks for
the PIN even in manual offline mode, and a soft unlock ends as soon as the server
answers again; any call made during it first probes the server and is refused
unsent (`session_locked`) if it answers. Offline evidence (`/offline/sync`) syncs
behind any lock. Signing out and the sign-in gate follow the same rule: in
manual offline mode "Salir" syncs and ends the session normally and the next
employee signs in (OFF-R16).

## Verification

Local qualification on the offline track (isolated local databases and a compiled
local server):

```sh
npm run lint && npm run typecheck && npm test
npm run test:db:qualification      # includes npm run test:db:offline
npm run build && npm run test:restart
TEST_BASE_URL=http://127.0.0.1:<port> TEST_PRODUCTION=1 npx playwright test
```

- Unit: `tests/offline-policy.test.ts` (connectivity state machine, retry policy,
  clock offset, provisional numbers), `tests/offline-net.test.ts` (timeouts, error
  kinds, HTML 502, bounded retry), `tests/offline-records.test.ts` (v3 contracts,
  time rule, backup v3), `tests/offline-clock.test.ts`, `tests/sw-shell.test.ts`
  (the real `public/sw.js` in `node:vm`), `tests/offline-store.test.ts` (sale
  builder preconditions, exactly-once local writes, the sync loop's dependency,
  retry, classification and pruning rules, the clock-rollback refusal) and
  `tests/offline-tables-store.test.ts` (table-service preconditions I8, I9, I13,
  I14, atomic checkouts, projections with a skewed clock, the open-orders cache, the
  online charge guard for unsynced payments and rounds (this or another employee's,
  in backoff after a 503 or in review), both LD-7 settings, rounds on paid checks,
  synced local orders that closed online, reconciled payments, table names, the
  tickets an order prints and their round labels, and the sync loop holding an
  order's later records behind a 5xx), both against an in-memory store
  (`tests/offline-fake-db.ts`). `tests/offline-clock.test.ts` sets the device
  clock back after a ping and checks the window still expires.
- Database: `tests/offline-sync-db.ts` (exactly-once sync, archive races, repricing,
  reuse only at the server's price and the manager path for a lost online create
  (reconciled into that order once, or refused, never a second order), lines
  already sent online, rounds on paid checks, drawer guard, clock tolerance,
  lease-cited config, review lane decisions, device prefixes, RLS, grants,
  immutability, pagination, the ping, and the LD-7 setting: off by default,
  managers only, audited once, gating the snapshot but never sync) and the
  updated `tests/offline-recovery-db.ts`.
- Browser: `tests/browser/offline.spec.ts` on Chromium, and its `@cross` tests on the
  `webkit-ipad` project (Playwright WebKit with an emulated iPad, not a real device).
  The default fixture keeps table service off ("With offline table service off…",
  "Open orders are never fetched while offline table service is off", the Beta
  switch); the table-service tests run in a group that turns it on and off again
  (cached checks, Enviar and rounds, the order on screen, the online charge guard
  for an offline payment and for an offline round whose sync is held, the 120 s
  refresh, a synced order paid online, "Enviar como orden nueva" on a paid check,
  and printing the new round). The KDS tests cover the station filter and the
  10 s / 30 s lane cadence; another test signs in with manual offline mode on.

Not verified, and still release gates: real tablets (iPad Safari and installed app,
Android Chrome), real thermal printers through the browser dialog and
`--kiosk-printing`, a real ISP outage on restaurant Wi-Fi, and staging proof of a
service-worker update between two deployed builds.

## Earlier recovery slice (September 2026)

The September 20–22 slice introduced versioned offline leases (018–020), manager
reconciliation of cash into the original drawer, durable kitchen/stock follow-up
tasks, tenant-bound atomic backups, uncertain-payment status and same-command retry,
and its tests (`tests/offline-recovery-db.ts`, `tests/browser/recovery.spec.ts`).
That behaviour is kept; this wave replaces the retry exhaustion that turned
transient failures into conflicts, and the revision-from-URL service-worker cache.
