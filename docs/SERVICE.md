# Front-of-house service

Status on October 5, 2026: implemented and verified locally (migration 024,
`npm run test:db:service`, `tests/browser/service.spec.ts`,
`tests/browser/kitchen.spec.ts`). Not yet staged. Printing is verified only in
Chromium print emulation; no physical 58/80 mm printer has been checked.

This area covers the order and check lifecycle, the Orders and Tables screens,
the kitchen display (KDS), kitchen and order notes, the payment dialog, receipts
and browser printing.

## Two lifecycles per order

Every order has two independent states.

- **Kitchen state** (`orders.state`): `active`, `ready`, `completed` (every round
  served), `cancelled` (every line voided), plus `recovery_pending` and
  `recovery_reviewed` for offline cash reconciliations. It is derived from the
  rounds by `refreshOrderState` (`server/voids.ts`) and never closes the check.
- **Check state** (`orders.check_state`): `open`, `paid` or `closed`, with
  `closed_at`, `closed_by` and `close_reason` (`settled`, `released`, `voided`,
  `recovery`).

```
  [open] ── balance reaches 0 ──► fiscal ticket (folio) ──► holds table? ── yes ──► [paid] ── Liberar mesa ──► [closed: released]
     │                                                                     no ──► [closed: settled]
     │      (paid + addRound → fiscal_ticket_issued: the items go out as a new order)
     ├── every line voided and nothing paid ─────────────────► [closed: voided]
     └── offline cash reconciliation (insert) ───────────────► [closed: recovery]
```

A check **holds its table** when `mode = 'dine_in'`, it has a table and
`channel <> 'offline'`. Takeaway, delivery, tableless and synced offline sales
close automatically when settled. Since fiscal (027), the balance reaching zero
also issues the check's fiscal ticket with its consecutive folio, in the same
transaction (RMF 2.7.1.21: the folio is on the comprobante given at payment;
[FISCAL.md](FISCAL.md)). A ticketed check takes no more rounds (LD-15 fiscal
Q2): "la última ronda" after paying goes out with **Enviar como orden nueva**
for the same table, a second check with its own ticket. In Mesas a paid check
still shows **Abrir orden** next to **Liberar mesa**; sending items from it
answers `fiscal_ticket_issued` and offers the new order. A paid check without a
ticket (zero total, or the `FISCAL_TICKETS_ENABLED=false` kill switch) still
takes rounds and returns to `open`.

| Action | open | paid | closed |
| --- | --- | --- | --- |
| Add a round (Enviar a cocina) | yes | `fiscal_ticket_issued` (send as a new order; without a ticket: becomes open) | `check_closed` |
| Void unpaid units | yes | n/a (no unpaid units) | `check_closed` |
| Record a payment | yes | `overpayment` | `check_closed` |
| Move table or server | yes | yes (leaving a table settles it) | `check_closed` |
| Edit the order note | yes | yes | only while kitchen tickets are open, else `check_closed` |
| Refund (any operator; staff with a manager's PIN, [discounts](DISCOUNTS.md) 028) | by item or by amount, only once the check is paid or ticketed (`refund_balance_due` otherwise, LD-25/LD-26) | yes | yes (post-close correction) |
| Discount or comp unpaid sent units ([discounts](DISCOUNTS.md) 028) | yes | n/a (nothing due) | `check_closed`; its discounts are final (`discount_not_reversible`) |
| Cerrar cuenta / Liberar mesa | only at balance 0, else `balance_due` | yes | returns the order |

Recovery orders keep their historical `stale_order` code for every write. The
kitchen continues independently: a takeaway check closed at payment still shows
its tickets on the KDS until they are served. **Marcar entregado** only changes
kitchen state. Because the order note goes to the kitchen, a closed check takes
**Editar nota** while its kitchen state is still `active` or `ready` (the
customer of a pay-first counter mentions an allergy right after paying); a
fully served, voided or recovery order refuses it (`orderNoteEditable` in
`shared/service.ts`). The receipt shown after the payment, order detail and the
cart offer **Editar nota** under the same rule.

### Database rules (migration 024)

- `orders_check_lifecycle` closes recovery orders on insert (either app
  revision) and makes closed checks immutable: `number`, `business_date`,
  `employee_id`, `table_id`, `mode`, `channel`, `total`, `discount`, `version`,
  `created_at` and the close columns can no longer change. Kitchen state, name,
  note, assignment and later areas' own columns stay mutable. Corrections after
  close are refunds; no check is ever reopened.
- `rounds_progress_timestamps` maintains `rounds.ready_at` and
  `rounds.completed_at`; recall clears `completed_at`.
- The backfill closes historical settled, fully voided and recovery orders.
  The deployed migration role owns the tables but is neither superuser nor
  BYPASSRLS, so the backfill switches `orders` and `tenders` to
  `NO FORCE ROW LEVEL SECURITY` for that one statement and back to `FORCE`
  right after it, in the same transaction (wave contract OPS-R2). DB test "024
  backfill closes historical checks when a non-superuser owner applies it"
  applies 001-021, writes history and applies 024 as such an owner.
- Indexes (names are a cross-area contract): `orders_open_checks`,
  `orders_business_day`, `orders_table_open`, `rounds_open`,
  `rounds_recent_completed`, `tender_allocations_order`, `refunds_tender`,
  `offline_recoveries_order`. Partial predicates such as
  `check_state <> 'closed'` and `state <> 'completed'` are written literally in
  the queries; a parameter would stop the planner from using the index.

### Server API (`server/checks.ts`, `server/kitchen.ts`)

| Method and path | Roles | Notes |
| --- | --- | --- |
| GET `/api/service/orders` | operators | `status=current\|open\|closed\|all`, `date`, `table`, `q`, `cursor`, `limit ≤ 100`; one statement per page |
| GET `/api/service/tables` | operators | occupancy from checks that are not closed, plus each table's pending QR orders (`pendingHolds`, public ordering 032, a subquery of the same statement); one statement |
| POST `/api/service/orders/:id/close` | operators | `{operationId}`; `balance_due` while money is owed |
| POST `/api/service/orders/:id/note` | operators | `{operationId, note ≤ 500}`; bumps the kitchen feed |
| POST `/api/service/orders/:id/print` | operators | `{operationId, document: receipt\|check, reprint}`; audit only |
| GET `/api/service/operations/:id/order` | operators | the order a send (`create_order` or `round` operation) produced, as it is now; `not_found` for any other operation |
| GET `/api/service/kitchen` | owner, manager, kitchen, server, cashier | `station`, `version`; unchanged polls are one row |
| POST `/api/service/kitchen/rounds/:id/recall` | owner, manager, kitchen, server | rounds served in the last 2 hours, of the current business day |
| POST `/api/service/kitchen/clear-stale` | owner, manager | completes previous-day rounds and acknowledges their voids |

Existing routes changed behaviour: rounds, payments, voids and table moves
return `check_closed` on a closed check; served orders accept new rounds and
voids; `/api/kitchen/:id` never turns a cancelled order back into an active
one; external tenders store `received = amount + tip` and keep only their
trimmed reference; grouped settlement locks every order before the drawer.

**Deploy.** Apply 024 and `scripts/grants.sql` first; the previous revision
keeps serving while the new one rolls out. In that window the previous revision
can settle a check without closing it, so such a check shows a zero balance
until staff release it (Órdenes and Mesas offer **Liberar mesa** / **Cerrar
cuenta** for any open check at balance 0), and its attempt to add a round to an
already settled check fails with a server error instead of `check_closed`.

**Order numbers across the business-day rollover (LD-29).** Numbers restart
every business day (the restaurant's timezone and cutoff, `businessDate()` in
`shared/domain.ts`), so after the cutoff an open order from the day before and a
new one can both be #10. These screens add the business date to an order that is
not from the current business day: "#10 · 5 oct" (English UI "#10 · Oct 5"):
the Órdenes cards and their checkboxes, **Cobrar juntas** (each check's line,
the "still owes" and "balance changed" notices, the lines after the payment and
the refusal while this device holds an unsynced offline record of a check), the
Mesas check cards, the cart heading in Vender, the payment dialog title
("Cobrar #10 · 5 oct"), the order detail title, the headers of the void, refund
and service-assignment dialogs, a round parked in Borradores for a server order
("#10 · 5 oct · ronda sin enviar", from the date stored when it was parked;
rounds parked before this change keep "#10"), and the kitchen tickets on screen
and their spoken announcements ("Nuevo ticket #10 · 5 oct, ronda 2"). The current
business date comes from the server where the response carries it (Órdenes
list, kitchen feed) and otherwise from the session's restaurant settings with
the same helper (`currentBusinessDate` in `src/labels.ts`) on the corrected
server clock (`src/clock.ts`), so a tablet whose clock is a few minutes off
agrees with Órdenes around the cutoff. The Órdenes card names the date once, in
its number (there is no separate "Del 5 oct" badge). The label is joined with
non-breaking spaces, so "#10 · 5 oct" never wraps apart on a narrow KDS header.

The same dated number is used by Vender's notices (for example "La orden
#10 · 5 oct llegó a cocina mientras cambiabas de cuenta", and the paid, failed
round and closed-check notices), the discount and refund dialog titles, the QR
inbox's accepted notice and its **Enviar a** list of open checks, and the
offline screens: the offline "Órdenes abiertas" pick list, the offline payment
review's check, the KDS lane "Ventas sin conexión por revisar" and
Sincronización. A provisional
number from another business day is dated the same way ("B-03 · 5 oct",
"B-07 → #142 · 5 oct"), since each device restarts its B- numbers every business
day.

Kitchen paper is dated too: every comanda and cancellation chit for an order
from another business day prints "#10 · 5 oct" (the comanda on send, KDS
auto-print and **Imprimir comanda**, the reprint after a note edit, the void and
refund chits, a QR order accepted from the inbox, and the offline **Comandas
(N)**). The one screen that keeps the plain number is the KDS **Recientes** list
of completed rounds (its feed carries no business date). The customer receipt
and pre-cuenta print the plain number next to the order's date and time.

**Legacy endpoints scheduled for removal.** `GET /api/orders` (now batched) and
`GET /api/kitchen` keep their response shapes for one release so PWA bundles
cached before the deploy keep working. A later contract change removes them.

## Kitchen display

- The feed is pulled every 3 seconds by a single-flight loop that never
  overlaps requests, backs off on failures (up to 30 seconds) and pauses while
  the screen is hidden. A full response is forced every 30 seconds.
- **Version protocol.** `kitchen_feed_versions` holds one counter per tenant.
  KDS-affecting commands (orders, rounds, progress, voids and acknowledgements,
  note edits, assignment, recall, clear-stale, and item refunds that cancel
  units the kitchen has not served, discounts 028) bump it. The feed reads the
  version before the data, so a concurrent change is either included or seen on
  the next poll. A poll with the current version returns `unchanged` after one
  row read.
- **Lock order.** Every command follows the binding
  [global lock order](ARCHITECTURE.md#global-lock-order-binding) (Wave 2.0):
  order rows (several sorted by id), rounds, line voids, stock items, then the
  feed row (level LO-10), then the drawer and `refreshCheckState`, which takes
  the fiscal folio counter (LO-12) last. `createOrder`, `voidLines` and
  `assignService` bump the feed before `refreshCheckState` since fiscal's merge
  (LO-R3; their `createOrder:12>10`, `voidLines:12>10` and
  `assignService:12>10` entries in `tests/lock-order.test.ts` are gone;
  `voidLines:9>7` stays, E3 / MENU-INT-5). DB test "kitchen feed and progress
  do not deadlock" runs mixed concurrent bursts, and fiscal DB test "lock
  order" adds offline sync, settling voids, reassignments and payments.
- The feed is bounded to the 200 oldest open rounds and excludes rounds held
  for offline review. A truncated feed shows an alert that new tickets do not
  appear until tickets are delivered and that a manager can retire the ones
  from previous days.
- Tickets show the order note, round note and line notes (allergy notes are
  emphasized), every modifier, voided quantities and pending cancellations.
- New tickets get a highlight, an aria-live announcement and, after a tap on
  **Activar sonido**, a beep (browsers block audio until a tap after each
  reload; a banner says so). Pending cancellations announce with a lower tone.
  The button and the banner follow the live audio state: when the system
  suspends or interrupts audio (a call, a notification, an app switch) the
  screen tries to resume it when shown again and otherwise asks for
  **Activar sonido** again.
- Each ticket's action stays disabled while its own request is in flight
  (another ticket's request never re-enables it) and shows the next step as
  soon as it succeeds; a feed fetched before the change is discarded.
- **Marcar entregado** waits for **Enterado de la cancelación**: a delivered
  ticket leaves the screen, and with it the only place a pending cancellation
  is acknowledged, so the server answers `void_ack_required` and the ticket
  says "Confirma la cancelación antes de marcar el ticket como entregado."
- When the order note of a ticket already on screen changes (**Editar nota**),
  the ticket is alerted like a new one: highlight with a "Nota actualizada"
  badge, the announcement "Nota actualizada en ticket #N", the beep and, when
  enabled, auto-print. Paper comandas printed at send time keep the old note,
  so after a note edit Selling and order detail offer **Reimprimir comanda**
  (when "Imprimir comanda al enviar a cocina" is on) for the tickets not yet
  served.
- **Entregados recientes** recalls tickets served in the last 2 hours of the
  current business day. Managers can retire tickets left open from previous
  business days for the station on screen (the count on the button is that
  station's; `POST /api/service/kitchen/clear-stale` takes an optional
  `station`, default all); the action is audited with the station and
  acknowledges their pending cancellations, and retired tickets are never
  listed or recallable.
- The selected station, sound preference and auto-print setting are per device.
  The screen requests a wake lock when the browser supports it; dedicated KDS
  devices should also disable screen sleep.

## Notes

| Note | Where it is stored | Where it appears |
| --- | --- | --- |
| Order note ("Nota de la orden (cocina)") | `orders.note` | every kitchen ticket of the order, receipts and pre-bills ("Nota de la orden"), order detail, Orders list; editable after sending with **Editar nota**, also after close while kitchen tickets are open |
| Round note ("Nota para esta ronda") | `rounds.note` | that round's tickets, receipts and pre-bills ("Nota de la ronda N", left out when identical to the order note), order detail |
| Line note (presets: Sin cebolla, Sin chile, Sin cilantro, Salsa aparte, Alergia:) | line snapshot `note` (≤ 300) | kitchen tickets, receipts and pre-bills, order detail |

Allergy notes (matching "alerg") are labelled **Alergia** on tickets and
receipts alike.

## Changes while a send is in flight

While **Enviar a cocina** waits for the server, the lines being sent show
"Enviando a cocina…" and cannot be edited (quantity, note, remove), the round
or order note is read-only, and **Guardar borrador**, **Nueva orden** and
**Borradores** are disabled. Everything else keeps working: a product tapped
meanwhile, including the product being sent, starts a new cart line, which can
take its own note. When the send succeeds, Selling compares the latest cart
with the order it returned (the same comparison as below) instead of emptying
it: the lines that landed leave, everything added meanwhile stays under a new
`operationId`, and the note leaves only if it reached the order. The order and
the cart change in the same render, so the balance is never counted twice; the
payment dialog compares the balance only after a collect settles, so
**Cobrar** sending the cart first never announces "El saldo pendiente cambió".

**Enviar (sin conexión)** (offline table service) follows the same rules while
the device saves its record (OFF-INT-5): the cart is compared with the local
order view the save returns, so a product tapped during the save stays, and the
order note, or the round note, leaves once the record holds it. If the cart
moved meanwhile (the backstop below), the record's lines leave the copy parked
in Borradores as they do online (LD-12 R6); what is left stays parked as a
round of the order the save reached, a cached server order or a local order
(Borradores resumes both, see "Parked carts").

### Switching checks while a send or payment is in flight

**Nueva cuenta** and **Abrir orden** in Mesas, and **Abrir orden** in Órdenes
and order detail, ask Selling to switch the cart to another check
(`requestSellingContext()` in `src/serviceHooks.ts`; the latest request wins).
While a send or a payment is in flight, or its receipt is on screen, Selling
keeps the request and says "Primero termina el envío en curso; después se abre
la cuenta que elegiste."; the switch happens as soon as the request settles, so
a late response can never put the previous check back in the cart, bill items
to it or post the next round to it. If that send or payment **fails**, the switch
is dropped instead: its error and actions (such as **Enviar como orden nueva**)
stay on screen with "No abrimos la cuenta que elegiste porque el envío o cobro
en curso no se completó. Revisa el aviso y vuelve a elegirla.", the cart still
holds the unsent lines, and choosing the table or order again switches (parking
the cart in Borradores). The same happens when a send fails while Vender is
hidden (the waiter is in Mesas or Órdenes) and the next request to switch
arrives: the waiter sees the failure first. Every switch (and **Nueva orden**,
**Guardar borrador**, restoring a draft, **Enviar como orden nueva**) goes
through one function that also bumps a context counter. As a backstop, a send
that answers after the counter moved (an **Abrir orden** that was still loading
when the waiter tapped **Enviar a cocina**) leaves the cart on screen alone: the
copy of its cart that the switch parked in Borradores drops the lines that
landed (and disappears when nothing is left), "La orden #N llegó a cocina
mientras cambiabas de cuenta." is shown, and its comanda prints when printing
on send is on. A failed send in that position stays in Borradores under its
`operationId`, so sending it from there replays or recovers it, and the cart on
screen says so ("La ronda para la orden #N no llegó a cocina: … Quedó en
Borradores; envíala desde ahí."). A payment that settles after a switch is
announced ("…quedó registrado. Su recibo está en Órdenes.") instead of
replacing the cart with its receipt. The same applies to **Recuperar pago** for
a stored payment of a check the cart already left (another check on screen, or
a new cart with items), and to the payment recovery and cached order loaded when
Selling mounts if a check was chosen meanwhile.

## Lost responses while sending

Every send carries the cart's `operationId`. If the response is lost and the
cashier sends the same cart again, the server replays the stored result. If the
cart changed in between, the server answers `operation_conflict`; Selling then
asks `GET /api/service/operations/:id/order` for the order that the first send
produced, makes it the current order, compares every cart line the order
already holds with the stored line, and gives what is left a new
`operationId`:

| Cart line compared with the stored line | What stays in the cart |
| --- | --- |
| Identical (quantity, option set, note, open amount) | nothing |
| Only the quantity grew (a tap on the same product) | the extra units, as a new line |
| Note, options or open amount changed, or fewer units | a copy with a new id, for review |

Lines the order does not hold stay as they are. When every line landed
unchanged the send counts as done. Otherwise Selling explains what happened
("Parte de esta orden ya había llegado a cocina…", or, when a landed line was
edited afterwards, "…revisa las cantidades y notas antes de enviar"), so a
line is never sent twice and never dropped silently. If the order cannot be
found, Selling says so and only **Enviar como orden nueva** gives the cart a
new operation id.

## Parked carts

**Guardar borrador**, **Nueva orden**, resuming an order and restoring a draft
store the unsent cart in Borradores. A cart of rounds for an open check also
keeps that check (IndexedDB cache record `…:parked-order:{operationId}`), is
listed as "#N · ronda sin enviar" and, when restored, goes back onto that check
and is sent as a round. If the check closed meanwhile, the cart offers
**Enviar como orden nueva**.

The check of a parked round is resolved through the device first (LD-13
addendum, `resolveParkedOrder` in `src/offline-records.ts`): a local order
created on this device (offline table service, Beta) is listed with its
provisional number ("B-07 · ronda sin enviar") and goes back onto that local
order, online or offline; once its order record has synced, the local id
resolves to the server order the sync recorded ("B-07 → #142 · ronda sin
enviar"), read from the server online or from the device's cached copy offline.
Opening Borradores then rewrites the parked reference to that server order
(`pinnedParkedOrder`, POL-R2-3), because the synced record that maps the local
id to it is pruned 7 days after it synced (OFF-12); a draft that was never
listed between its order's sync and that pruning still reads as gone.
Offline, a server check this device did not keep cannot take the round: the
draft stays parked with "Disponible al volver la conexión" (table service off)
or the `offline_order_not_cached` message (on). A draft whose check exists
nowhere any more (a local order whose record was archived, or a server answer
`not_found`) is shown as "La orden de este borrador ya no existe en este
dispositivo ni en el servidor." with only **Descartar borrador**.

## Payment dialog

The dialog mounts fresh for every payment: cash is selected, the reference and
the terminal confirmation start empty. **Efectivo recibido** follows the amount
plus tip until the cashier types or taps a quick amount (Exacto and the next
MXN 20/50/100/200/500/1000 bills). Change uses this payment's own amount. Tips
are voluntary (Profeco); 10 % and 15 % shortcuts round to whole pesos. Amounts
accept es-MX thousands separators ("1,250.50"). The first invalid field is shown
inline and **Confirmar cobro** stays disabled. Online, the device's drawer is
refetched when the dialog opens, and neither **Confirmar cobro** nor
**Enviar ronda y dividir por productos** sends anything to the kitchen unless
the drawer is open.

- **One payment at a time.** The tap sets an in-flight flag synchronously and
  it clears only when the whole collect (round send, payment, recovery)
  settles. Confirm stays disabled ("Cargando…") and the "retry is safe" hint is
  hidden meanwhile. The payment `operationId` is created once per opened dialog,
  so a duplicate that still reached the server would replay the stored result.
- **Feedback inside the dialog.** Selling's notices (`stale_order`, a recovered
  send) show inside the dialog. When the balance changes under the open dialog,
  "El saldo pendiente cambió a {saldo}" is shown and a prefilled **Importe**
  moves to the new balance (an amount the cashier typed stays). When the cart
  must offer **Enviar como orden nueva** (`check_closed`, an unconfirmed send),
  the dialog closes so the button is reachable.
- **Cobrar juntas** fixes the checks and balances when it opens, so a retry
  after a lost response sends the same amounts under the same `operationId`
  even if the list behind it refreshed, and shows the change. Short cash is
  refused before anything is sent. When the refreshed list shows a chosen
  check with another balance, the dialog says "La orden #N ahora debe …, pero
  este cobro conjunto cubre …". After the payment the dialog stays open with
  each check's paid amount and remaining balance ("La orden #N todavía debe
  …" when something is left), the change, and **Imprimir recibos (N)**, which
  prints every check's receipt in one job and records each print; **Listo**
  closes it.

## Printing (browser/OS)

- `printDocument()` in `src/print.tsx` is the only caller of `window.print()`.
  It renders one document into `#print-root` and hides everything else in print.
- Content width is 72 mm on 80 mm paper and 48 mm on 58 mm paper. The page uses
  `@page { margin: 0 }` with no forced size, so the OS driver's roll size defines
  the length. Set the printer's paper to the roll size and zero margins in the
  OS driver.
- Documents: receipt (after payment, or a reprint marked "REIMPRESIÓN"),
  pre-bill "Cuenta · no es comprobante de pago", and kitchen ticket (comanda).
  Receipts and pre-bills carry the order note, round notes, modifiers and
  line notes. A local (offline) receipt whose record has no tender yet is a
  sale collected in full before it was saved: it prints "Cobrado · pendiente de
  sincronizar" with the total instead of "Cobrado $0.00 / Saldo pendiente". Fiscal fields are added later through the receipt
  `header`/`footer` slots (see integration points).
- Per-device settings (localStorage `gm-print-settings`): paper width, print a
  kitchen ticket on send (off by default) and auto-print new KDS tickets (off).
- **Silent printing** (no print dialog) has no confirmed method today. Public
  sources, not official Chrome or Chromium documentation, describe launching
  Chromium with `--kiosk-printing` with the thermal printer as the OS default
  printer as working on Windows, and say macOS and Android always show the
  print dialog; none of this has been verified here. The KDS "Impresión"
  dialog's hint therefore says printing without a dialog is not confirmed and
  points staff to the pilot manual's print steps ([PILOT_SOP §1.3](PILOT_SOP.md)),
  which count on the dialog at every print (LD-17). KDS auto-print and the
  comanda on send therefore open the dialog at each ticket: they are practical
  only on a device verified to print without it.
- Browser printing never confirms that paper came out.
- Kitchen cancellation chits (reports 029): a KDS with auto-print and a selling device
  that prints on send also print "CANCELACIÓN · NO PREPARAR" after a void, per round and
  station ([REPORTS.md](REPORTS.md)).

## Per-device settings

| localStorage key | Values |
| --- | --- |
| `gm-kds-station` | `all` / `kitchen` / `bar` |
| `gm-kds-sound` | `on` / `off` |
| `gm-print-settings` | JSON `{ paper, kitchenOnSend, kdsAutoPrint }` |
| `gm-orders-tab` | `current` / `open` / `closed` |

## Integration points for other areas

- `refreshCheckState(tx, s, orderId)` must run after any write that changes the
  total, lines, voids, tenders, mode or table, while holding the order row lock.
  Keep `orders.total >= sum(tenders.amount)`; never change a closed check.
- `assertCheckWritable(row)`, `applyRound()` and `getOrders(tx, ids)` (constant
  statements for any number of ids).
- `bumpKitchenFeed(tx, s)` runs after every order, round, void and stock lock of
  a KDS-affecting command and before the drawer and `refreshCheckState`
  ([global lock order](ARCHITECTURE.md#global-lock-order-binding), LO-10).
- "Sale concluded" for fiscal/CFDI: the check has a fiscal ticket
  (`fiscal_tickets`), issued when its balance first reached zero, whether it is
  still `paid` (table not released) or `closed`. The ticket's `business_date`
  (the order's) is the fiscal day; `issued_at` is the date of issue. This
  supersedes the wave-1 "closed only" definition.
- `src/labels.ts` turns stored codes (audit operations, stock causes, tender
  methods, channels, integrations) into operator labels; new views must use it.
- Printing: `printDocument`, `readPrintSettings`, `ReceiptDocument` (with
  `header`/`footer`) and `KitchenTicketDocument`/`ticketsFromLines`.
- Receipt content from fiscal (027) and CFDI (030): fiscal calls
  `setReceiptSlots({ header, footer })` from `src/features/Receipt.tsx` once at
  startup (`installFiscalReceipt()`, the only caller); CFDI adds its block with
  fiscal's `setFiscalFooterExtra`. Each slot is a function of
  `{ order, kind, reprint, locale }`, and every receipt render uses it: the
  receipt modal and its print, and the pre-bill and reprint printed from order
  detail. React context cannot do this, because `printDocument` renders into
  its own root. `ReceiptModal` also forwards explicit `header`/`footer` props.
  Printed comprobantes use `locale="es"` (D10); `ReceiptModal` takes
  `printLabel`/`printLabelHint` for a Spanish twin of a UI-language label.
- `tenderMethodLabel` labels only `cash` and `external`; any other method shows
  "Otro método de pago" until its area adds a label.
- Public QR/kiosk ordering (032, [PUBLIC_ORDERING](PUBLIC_ORDERING.md)): a
  diner's order waits as a hold, outside `orders`, until staff accept it in
  the inbox at the top of **Órdenes**; acceptance runs the unmodified
  `createOrder` (a new check, `channel` `qr`/`kiosk`) or `addRound` (a round
  on the table's **open** check; a paid or closed target is refused with
  `public_hold_target_invalid`), and for pay-first `recordPayment` through
  `PaymentDialog`, ending on `ReceiptModal`. The hold's label travels with
  the order: a new check's call name is `Q-14 · Ana` and its order note
  `Q-14 · sin cebolla`; an appended round's note is `Q-14 · sin cebolla`,
  never the diner's name, because round notes print on the shared check's
  receipt (LD-1). A pending, unexpired table hold counts as occupancy:
  `tablesWithOpenChecks` unions those holds' tables with the tables of checks
  that are not closed (so such a table cannot be archived, `table_in_use`),
  and Mesas shows "Pedido QR por confirmar" on its card. Public ordering adds no `getOrders` member and
  never calls `getOrder` (C-14).
- Component slots: `Kitchen.beforeTickets`, `Tables.onEditTables`,
  `PaymentDialog.offline`, `ReceiptModal.label`/`labelHint`/`extraActions`/
  `header`/`footer`.

## Merge notes (wave 1)

Edits outside the regions wave contracts 4.1 assign to service, for the
integrator:

- `server/index.ts` `/settlements` (base lines 308-351): the route body moved to
  `recordSettlement` in `server/checks.ts`; the route is now three lines. It
  sits directly above offline's deletion of the `/sync` routes (base lines
  352-360), so expect a textual conflict at offline's merge: keep service's
  three-line route and apply offline's deletion (done at offline's
  integration; the `/sync*` routes live in `server/routes/offline.ts`).
  **Behaviour change:** grouped
  settlement now locks every order row (sorted by id) before the drawer, where
  it previously locked the drawer between orders. This removes a deadlock with
  concurrent rounds and payments (DB test "kitchen feed and progress do not
  deadlock with concurrent payments and rounds").
- `src/features/Selling.tsx` `add()` (contracts 4.8 golden form): keep
  service's form, which derives the lines inside the `setDraft` updater
  (`mergeLine(d.lines, p, choice, opts)`) with a pre-generated `newId` and the
  in-flight `locked` set. The golden form's
  `setDraft((d) => ({ ...d, lines: r.lines }))`, with `r` computed from render
  state, would again let a tap that lands just after a send bring the sent
  lines back (SVC-R7). `mergeLine` keeps the D16 call form; the fourth `opts`
  argument is optional.
- `src/features/Selling.tsx` **Nueva orden** button (base line 613, offline's
  region 612-640): service changed `disabled={pendingPayment}` to
  `disabled={pendingPayment || busy}` and disabled **Borradores** while `busy`.
  When offline removes `disabled={pendingPayment}`, keep `disabled={busy}` so a
  cart cannot be parked or replaced while its send is in flight. Requests from
  Mesas and Órdenes wait the same way (the `gm-resume`/`gm-table` effect
  returns early while `busy`, `paying` or a receipt is shown, SVC-R10), and a
  request that a failed send or payment was holding is dropped once
  (`requestFailed()`/`unseenFailure`, SVC-REV-1); offline's send and collect
  paths should call `requestFailed()` on failure the same way. Done at
  offline's integration: **Nueva orden** is `disabled={busy}`; offline's send
  and collect run inside `sendWith`/`collectLocked`, whose failure paths call
  `requestFailed()`; and offline's **Órdenes abiertas** (table service on) is
  disabled while `busy` or `paying` and parks unsent lines before it replaces
  the cart.
- `src/features/Selling.tsx` context switches (SVC-R10): every place that
  replaces the cart's order calls `replaceContext(order, draft)`, which bumps
  `contextEpoch`; `sendWith` and `collectLocked` compare the epoch after each
  await. Offline's `sendOffline`/`collectOffline` and the restored
  `settleActiveAttempt` path should do the same: replace the cart through
  `replaceContext` and, in `collectLocked`, finish through `settled(result)`
  (which announces instead of showing a receipt when the epoch moved). Offline's
  own local `setDraft(fresh())` after a local sale is a reset of the same cart
  and may stay as it is. Done at offline's integration: the offline send
  checks the epoch (`moved()`) before writing the cart, `settleActiveAttempt`
  finishes through `settled()`, and an "Órdenes abiertas" pick goes through
  `replaceContext`. The offline collect writes its local receipt directly,
  which is safe because every control that replaces the cart waits while a
  collect is in flight.
- `tests/voids-db.ts` "paid units cannot be voided…" (base lines ~215-260, next
  to menu's stock-assertion region 188-216): the order is now dine-in, because a
  fully paid takeaway check closes and would answer `check_closed` instead of
  the paid-units error under test (allowed by contracts 5.2.1). Keep the
  dine-in fixture when resolving menu's edits there. In the same file, the
  fully voided order's rejected round now expects `check_closed` (it was
  `stale_order` before the lifecycle split).
