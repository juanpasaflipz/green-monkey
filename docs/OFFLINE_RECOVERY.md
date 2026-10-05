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
  while offline, 120 s while the page is hidden).
- Every API request reports its outcome. Two consecutive failures (network error,
  timeout, 5xx, a non-JSON or HTML proxy page) switch the device to offline; two
  consecutive successes switch it back. A browser that reports itself offline is
  offline immediately.
- Requests time out (GET 8 s, POST 15 s, offline sync 20 s), so a hung server never
  leaves a dialog stuck.

The top bar pill always shows an icon and text, at every width: **Conectado**,
**Conexión lenta**, **Sin conexión** or **Sin conexión (manual)**, plus
"· N por sincronizar". A full-width banner explains the state:

| State | Banner |
|---|---|
| Offline | "Sin conexión con el servidor. Las ventas se guardan en este dispositivo y se envían al volver la conexión." plus the offline-window line and **Comandas (k)** / **Ver sincronización** |
| Manual | "Trabajando sin conexión por decisión del equipo…" with **Volver a conectarme** |
| Slow (2 of the last 3 requests over 4 s) | "La conexión está lenta…" with **Trabajar sin conexión** |
| Kitchen role offline | "Sin conexión: esta pantalla no recibe pedidos nuevos. Pide las comandas impresas o en voz al mostrador." |

The offline-window line reads "Puedes vender sin conexión hasta las HH:mm", turns
amber and bold in the last 30 minutes, and once the window has ended says that no
new sales can be saved until someone reconnects and signs in. The banner also warns
when any unsynced record is older than 20 hours (it may miss the 24 h global
invoice) and when the device clock differs from the server by more than 2 minutes.

**Trabajar sin conexión** (Sync screen switch, slow banner) is a device-local mode
for any operator. While it is on, the POS never attempts blocking server commands
such as sending or charging; background probes and background sync continue
whenever the server answers.

A reload during an outage restores the cached session (any transient failure, not
only a browser that says it is offline) while its offline window is open. If the
window has ended, the login screen says signing in needs a connection and offers a
backup download of every unsynced record without a session.

## What can be done offline

| Action | Offline |
|---|---|
| New order paid in full in cash | yes |
| New order paid in full on a separate card terminal (staff confirm approval and type its reference; nothing is verified with the bank) | yes |
| Item split | no (disabled; an offline save refuses it with "Dividir por productos no está disponible sin conexión") |
| Settle several orders together, voids, refunds, discounts, drawer open/close/paid-out | no: unavailable offline (they need the server and fail with a connection message) |
| Integrated card charges, invoicing | no |

Open-price lines are allowed offline (wave contract D11): the server re-prices them
with the same staff rule at sync.

### Table service offline

Shipped as the separate `feat(offline-tables)` commit series (wave contract §8.1),
so the core fixes can ship without it.

| Action | Offline |
|---|---|
| **Enviar (sin conexión)**: send a new order to the kitchen without paying | yes, it becomes a local open order with a provisional number |
| Add items to a local open order or to a server order cached before the outage | yes, as a new round (additive; no version check) |
| **Cobrar** a local or cached order, in full or in part, by cash or external terminal | yes, revalidated against the balance at sync |
| New order paid in part | yes (order and payment saved together) |

**Órdenes abiertas** (next to Borradores while offline) lists the server open orders
cached before the outage, "Órdenes guardadas antes de perder la conexión (HH:mm)"
(refreshed every 120 s while selling is visible; current and previous business
day, at most 200), and the orders created on this device. Every server order
selling handles online (send, round, payment, resume) is also stored in that cache
at once, so the order on screen when the connection drops can be paid offline at
its current balance; an older copy never replaces a newer one. Offline, the order
on screen shows the cached copy plus this device's rounds and payments that copy
does not contain yet. The server lists, with each cached order, the tenders and
offline records it already contains, so a record is never counted twice and never
dropped, whatever the device clock says. Money another employee collected on this
device (before a shift change) counts too. Paying a cached server order warns that
it may have been paid on another device.

A round or payment for a local order waits until that order has synced (it is
never sent to another order). A payment that would exceed the server balance at
sync (for example because the table was paid on another device) is refused and
shown for review; it is never partially applied. Local orders are only changed
through offline records, even after the connection returns; once their record
syncs, selling continues on the server order. While an offline payment for an
order is still unresolved on this device, charging that order online is refused
("Esta orden tiene un pago por confirmar…"), and selling reads the order again as
soon as the payment syncs, so the guest is never charged twice.

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
the offline window is still open by the server-corrected clock, a drawer was open
and cached before the outage, the order has no unresolved online payment, and the
record fits in local storage (otherwise "No hay espacio en este dispositivo…").

## Provisional numbers

Each offline sale gets a number such as **B-07**: a per-device letter prefix
assigned once by the server (`A`…`Y`, then `A1`…`Y9`; immutable once set) and a
per-device, per-business-day counter. A device that never fetched a prefix uses the
reserved `Z` family derived from its device id. The receipt shows "Número
provisional B-07" and "El número definitivo se asigna al sincronizar."; after sync
the Sync screen shows "B-07 → #142", and `Order.offline` keeps the provisional
number and the sale time for reprints.

## Kitchen during and after an outage

During the outage the KDS receives nothing over the network. Each offline sale
produces one comanda per station (kitchen, bar) with "COMANDA · SIN CONEXIÓN",
the provisional number, mode, table, call name, time and lines.

- **Print**: the receipt offers **Imprimir comanda**. The Sync screen setting "Al
  guardar sin conexión" (Preguntar / Imprimir comanda / Imprimir comanda y recibo)
  can print automatically right after saving. Printing uses the browser/OS print
  dialog; the browser cannot confirm that paper came out.
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

Wave note: excluding `offline_review` rounds from the live KDS columns is service's
change (contract D13). Until service merges, those rounds also appear in the live
columns, where no progress action is accepted for them.

## Sync, retries and exactly-once

Every record carries an `operationId` created once per save; it is the server
idempotency key. Sync (`POST /api/offline/sync`), the legacy `POST /api/sync`
and manager reconcile all run inside `once(operationId, "offline_sync")`, so a
record applies at most once whatever the path or retry. Manager archive takes the
same advisory lock, so exactly one of archive or sync wins.

Retry policy:

- Transient failures (network, timeout, 5xx, non-JSON, 429, database unavailable,
  a device clock slightly ahead, a dependency still queued) are retried forever
  with jittered backoff capped at 60 s. They never become conflicts.
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
silently charges a different amount. Payments go through the normal payment command,
so a record can never pay past the order's balance (`offline_payment_exceeds_due`).
Offline-collected sales may take stock negative because the sale physically
happened. The order's business date comes from the validated sale time, not the
sync time.

## Clock handling

Records carry the server-corrected sale time, the raw device time and the measured
offset (median of the last 5 pings, kept on the device). The server accepts a sale
up to 2 minutes after its own clock, up to 5 minutes before the lease window or
drawer opened, and up to 2 minutes after the window or drawer closed, and clamps the
sale time into those bounds. A record more than 2 minutes in the future is retried
later (the device clock may simply be ahead); one outside the window goes to a
manager. Records cite the offline lease they were made under, never the live
settings version (the old live-vs-lease bug blocked review and drawer close).

## Authenticity, eligibility, review and archive

The server first decides whether the evidence is **authentic** (the session exists,
tenant/employee/device and lease match, currency, drawer of that device, amounts)
and separately whether it is **eligible** to sync automatically (not archived, same
employee on the same device, session not revoked, employee and device active,
selling allowed, time within tolerance, that drawer still open, settings unchanged).
Under the wave contract (D6) an ended session (logout, switch) is valid evidence
for the same person on the same device, and only a revoked session needs a manager.
That depends on access's change: on this branch logout still marks the session
revoked, so records left by a logged-out session go to **Requiere revisión**
(`offline_conflict`) and a manager reconciles or archives them until access merges.

On the Sync screen a manager can:

- **Revisar** any unresolved row. Review never fails because evidence is bad; it
  shows the problems, the original employee, drawer, amounts, method, reference and
  sale time.
- **Conciliar** authentic cash or terminal sales: the money is recorded once in the
  original drawer (even if closed) as a financial-only recovery order, with kitchen
  and stock follow-up tasks.
- **Archivar registro local** for anything, including evidence that cannot be
  verified or does not parse: a reason (10–500 characters) and confirmation are
  required, the evidence is kept verbatim on the server with its hash and the
  manager's name, and nothing is added to sales or the drawer. Drawer close then
  counts the row as resolved and notes "Este dispositivo archivó $X de ventas
  locales de esta caja. Ese efectivo puede aparecer como sobrante."

## Uncertain online payments

An online payment whose answer is lost stays in the device's single active slot
and is resolved with its exact command (status, then the same retry). If the server
needs a manager (for example the attempt belongs to an older session), the attempt
is **parked** under its own key: it blocks only its own order, "Nueva orden" and
other sales stay available, and the Sync screen lists it as "En revisión". An
attempt is never overwritten.

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

These are in-wave stand-ins defined by the wave contracts, replaced at merge:
`server/compat/offline-access.ts` (access's `leaseForEvidence` with lease
windows), `server/compat/offline-service.ts` (service's check lifecycle, kitchen
feed bump and `applyRound`) and `src/compat/offline-print.tsx` (service's print
primitive and kitchen ticket document). Until access merges, the offline window is
the 4-hour window from login; access's renewals become additional windows that the
time rule already accepts.

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
  retry, classification and pruning rules) and `tests/offline-tables-store.test.ts`
  (table-service preconditions I8, I9, I13, I14, atomic checkouts, projections with
  a skewed clock, the open-orders cache and the online payment guard), both against
  an in-memory store (`tests/offline-fake-db.ts`).
- Database: `tests/offline-sync-db.ts` (exactly-once sync, archive races, repricing,
  drawer guard, clock tolerance, lease-cited config, review lane decisions, device
  prefixes, RLS, grants, immutability, pagination, the ping) and the updated
  `tests/offline-recovery-db.ts`.
- Browser: `tests/browser/offline.spec.ts` on Chromium, and its `@cross` tests on the
  `webkit-ipad` project (Playwright WebKit with an emulated iPad, not a real device).

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
