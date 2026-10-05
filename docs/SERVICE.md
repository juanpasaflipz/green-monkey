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
           addRound (total ↑)
     ┌──────────────────────────┐
     ▼                          │
  [open] ── balance reaches 0 ──┼──► holds table? ── yes ──► [paid] ── Liberar mesa ──► [closed: released]
     │                          │                     no ──► [closed: settled]
     │                          └─────────────────────────── (paid + addRound → open)
     ├── every line voided and nothing paid ─────────────────► [closed: voided]
     └── offline cash reconciliation (insert) ───────────────► [closed: recovery]
```

A check **holds its table** when `mode = 'dine_in'`, it has a table and
`channel <> 'offline'`. Takeaway, delivery, tableless and synced offline sales
close automatically when settled.

| Action | open | paid | closed |
| --- | --- | --- | --- |
| Add a round (Enviar a cocina) | yes | yes (becomes open) | `check_closed` |
| Void unpaid units | yes | n/a (no unpaid units) | `check_closed` |
| Record a payment | yes | `overpayment` | `check_closed` |
| Move table or server | yes | yes (leaving a table settles it) | `check_closed` |
| Edit the order note | yes | yes | `check_closed` |
| Refund (manager) | yes | yes | yes (post-close correction) |
| Cerrar cuenta / Liberar mesa | only at balance 0, else `balance_due` | yes | returns the order |

Recovery orders keep their historical `stale_order` code for every write. The
kitchen continues independently: a takeaway check closed at payment still shows
its tickets on the KDS until they are served. **Marcar entregado** only changes
kitchen state.

### Database rules (migration 024)

- `orders_check_lifecycle` closes recovery orders on insert (either app
  revision) and makes closed checks immutable: `number`, `business_date`,
  `employee_id`, `table_id`, `mode`, `channel`, `total`, `discount`, `version`,
  `created_at` and the close columns can no longer change. Kitchen state, name,
  note, assignment and later areas' own columns stay mutable. Corrections after
  close are refunds; no check is ever reopened.
- `rounds_progress_timestamps` maintains `rounds.ready_at` and
  `rounds.completed_at`; recall clears `completed_at`.
- The backfill closed historical settled, fully voided and recovery orders.
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
| GET `/api/service/tables` | operators | occupancy from checks that are not closed; one statement |
| POST `/api/service/orders/:id/close` | operators | `{operationId}`; `balance_due` while money is owed |
| POST `/api/service/orders/:id/note` | operators | `{operationId, note ≤ 500}`; bumps the kitchen feed |
| POST `/api/service/orders/:id/print` | operators | `{operationId, document: receipt\|check, reprint}`; audit only |
| GET `/api/service/kitchen` | owner, manager, kitchen, server, cashier | `station`, `version`; unchanged polls are one row |
| POST `/api/service/kitchen/rounds/:id/recall` | owner, manager, kitchen, server | rounds served in the last 2 hours |
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

**Legacy endpoints scheduled for removal.** `GET /api/orders` (now batched) and
`GET /api/kitchen` keep their response shapes for one release so PWA bundles
cached before the deploy keep working. A later contract change removes them.

## Kitchen display

- The feed is pulled every 3 seconds by a single-flight loop that never
  overlaps requests, backs off on failures (up to 30 seconds) and pauses while
  the screen is hidden. A full response is forced every 30 seconds.
- **Version protocol.** `kitchen_feed_versions` holds one counter per tenant.
  KDS-affecting commands (orders, rounds, progress, voids and acknowledgements,
  note edits, assignment, recall, clear-stale) bump it. The feed reads the
  version before the data, so a concurrent change is either included or seen on
  the next poll. A poll with the current version returns `unchanged` after one
  row read.
- **Lock order.** Commands lock order rows (several sorted by id), then rounds,
  line voids, stock items and the drawer; the feed row is always taken **last**.
  It is never bumped by payments, settlements, refunds or cash commands, because
  those lock several orders and the drawer one after another. DB test "kitchen
  feed and progress do not deadlock" runs mixed concurrent bursts.
- The feed is bounded to the 200 oldest open rounds ("Se muestran los 200
  tickets más antiguos") and excludes rounds held for offline review.
- Tickets show the order note, round note and line notes (allergy notes are
  emphasized), every modifier, voided quantities and pending cancellations.
- New tickets get a highlight, an aria-live announcement and, after a tap on
  **Activar sonido**, a beep (browsers block audio until a tap after each
  reload; a banner says so). Pending cancellations announce with a lower tone.
- **Entregados recientes** recalls tickets served in the last 2 hours.
  Managers can retire tickets left open from previous business days; the action
  is audited and acknowledges their pending cancellations.
- The selected station, sound preference and auto-print setting are per device.
  The screen requests a wake lock when the browser supports it; dedicated KDS
  devices should also disable screen sleep.

## Notes

| Note | Where it is stored | Where it appears |
| --- | --- | --- |
| Order note ("Nota de la orden (cocina)") | `orders.note` | every kitchen ticket of the order, order detail, Orders list; editable after sending with **Editar nota** |
| Round note ("Nota para esta ronda") | `rounds.note` | that round's tickets and the order detail |
| Line note (presets: Sin cebolla, Sin chile, Sin cilantro, Salsa aparte, Alergia:) | line snapshot `note` (≤ 300) | kitchen tickets, receipts, order detail |

## Payment dialog

The dialog mounts fresh for every payment: cash is selected, the reference and
the terminal confirmation start empty. **Efectivo recibido** follows the amount
plus tip until the cashier types or taps a quick amount (Exacto and the next
MXN 20/50/100/200/500/1000 bills). Change uses this payment's own amount. Tips
are voluntary (Profeco); 10 % and 15 % shortcuts round to whole pesos. Amounts
accept es-MX thousands separators ("1,250.50"). The first invalid field is shown
inline and **Confirmar cobro** stays disabled. Online, the device's drawer is
refetched when the dialog opens, and nothing is sent to the kitchen unless the
drawer is open.

## Printing (browser/OS)

- `printDocument()` in `src/print.tsx` is the only caller of `window.print()`.
  It renders one document into `#print-root` and hides everything else in print.
- Content width is 72 mm on 80 mm paper and 48 mm on 58 mm paper. The page uses
  `@page { margin: 0 }` with no forced size, so the OS driver's roll size defines
  the length. Set the printer's paper to the roll size and zero margins in the
  OS driver.
- Documents: receipt (after payment, or a reprint marked "REIMPRESIÓN"),
  pre-bill "Cuenta · no es comprobante de pago", and kitchen ticket (comanda).
  Fiscal fields are added later through the receipt `header`/`footer` slots.
- Per-device settings (localStorage `gm-print-settings`): paper width, print a
  kitchen ticket on send (off by default) and auto-print new KDS tickets (off).
- **Silent printing** requires Chromium launched with `--kiosk-printing` and the
  thermal printer set as the OS default printer. Public sources describe this as
  working on Windows; macOS and Android always show the print dialog. Verify on
  the target device; it has not been verified here.
- Browser printing never confirms that paper came out.

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
- `bumpKitchenFeed(tx, s)` is the last lock-taking statement of a KDS-affecting
  command and is never called in money commands.
- "Sale concluded" for fiscal/CFDI: `check_state = 'closed'` and
  `close_reason in ('settled','released','recovery')`; `closed_at` is the
  conclusion time and `business_date` the fiscal day.
- `src/labels.ts` turns stored codes (audit operations, stock causes, tender
  methods, channels, integrations) into operator labels; new views must use it.
- Printing: `printDocument`, `readPrintSettings`, `ReceiptDocument` (with
  `header`/`footer`) and `KitchenTicketDocument`/`ticketsFromLines`.
- Component slots: `Kitchen.beforeTickets`, `Tables.onEditTables`,
  `PaymentDialog.offline`, `ReceiptModal.label`/`labelHint`/`extraActions`.
