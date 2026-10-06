# Public ordering: QR and kiosk ("pedidos en línea")

Migrations 032 and 033. Audit findings SEC-7, FIT-11, FOH-13 and the DB-9
remainder.

**Status: Phase A, built on `track/public`.** Phase A depends only on wave 1
and platform 2.0. It merges into `integration/v1` once, after account (031)
and the Phase B steps described in [Phase B](#phase-b-what-is-still-to-do).
Until then:

- Three dependencies come from compat shims with the owners' exact signatures
  (`server/compat/public-*.ts`, `src/compat/public-account.ts`). No shim reaches
  `integration/v1`.
- The shared docs (ARCHITECTURE, OPERATIONS, RUNBOOK, MENU, SERVICE, ACCESS,
  RELEASE, ACCOUNT_AND_LEGAL, DELIVERY_STATUS, the ledger files) are **not**
  edited in Phase A (LD-P10). This file holds everything they will receive at
  B3: lock-order rows, the DB-9 contract, the abuse runbook and the DB-9
  validation procedure.

**Verified locally only.** The DB and HTTP suite (`npm run test:db:public`),
the unit tests and the browser suite (`tests/browser/public-ordering.spec.ts`)
run against local databases and a local compiled server. Nothing here has run
on staging or production. Thermal printing of the QR cards and the QR scanners
of real phones and kiosk tablets have not been checked on hardware (see
[Field checks](#field-checks-before-printing-at-scale)).

---

## 1. Concepts

**Link.** A row in `public_links` with a bearer token. The token is printed in
a QR code or opened on a kiosk. There are three kinds:

| Kind | Channel | Bound to | Mode | Active links |
|---|---|---|---|---|
| `table` | `qr` | one table | dine in | 1 per table |
| `counter` | `qr` | — (a label, for example "Ventanilla") | takeaway | up to 5 |
| `kiosk` | `kiosk` | — (a label, for example "Entrada") | takeaway | up to 10 |

Links never expire. Staff deactivate or replace them in one step.

**Hold.** A diner's submitted order, waiting for a person. Holds live in
`public_order_holds`, not in `orders`:

- A hold has **no** order number, round, kitchen job, stock movement,
  kitchen-feed bump or fiscal ticket.
- It is labelled `Q-14` (QR) or `K-3` (kiosk), numbered per restaurant
  business day (`public_hold_numbers`).
- Its states are `pending`, `accepted`, `rejected` and `cancelled`. A pending
  hold past `expires_at` reads as **expired**. That state is computed on
  read; no job sweeps holds.
- Expired holds stay `pending` in the table, so every query for live holds
  also filters `created_at > now() - 2 hours`. The `public_order_holds_window`
  check (`expires_at <= created_at + 2 hours`) makes that filter exact, and it
  keeps those queries to a bounded index range however much history builds up.

Acceptance runs the unmodified `createOrder` (a new check) or `addRound` (a
round on the table's open check) as the staff member who accepts. For
pay-first, it also runs `recordPayment`. Rejected, cancelled and expired holds
leave no sales or fiscal trace.

**Policy.** Each restaurant sets one policy for table links and one for
counter and kiosk links:

- `accept` (default): staff confirm the order, and it is charged later as
  usual.
- `pay_first`: the order reaches the kitchen only when staff collect the full
  amount in the same step. A manager can override this.

**Ordering is open** when every one of these holds:

- public ordering is enabled (`PUBLIC_ORDERING_ENABLED`, see §8);
- the restaurant is on Pro;
- the link is active;
- the table is not archived (table links only);
- the restaurant has not paused online ordering;
- **a staff terminal is active**: some operator session (owner, manager,
  cashier or server) on a `terminal` device was seen in the last 5 minutes.

While ordering is closed, the menu stays browsable. Diners never learn why it
is closed.

## 2. Diner flow

- **URLs.** `{APP_URL}/qr#<token>` (table and counter) and
  `{APP_URL}/kiosk#<token>`.
  - The token lives in the **fragment**. It never appears in a request line, a
    `Referer` header or an edge log.
  - The page sends the token in the `x-gm-link-token` header. A diner's own
    order is identified by a 128-bit status key that the browser generates; it
    travels in `x-gm-status-token`.
- **Legacy links.** Old 24 h signed paths (`/qr/<signed>`, `/kiosk/<signed>`)
  show "Este código ya no funciona" **without any API call**.
- **Page.**
  - The restaurant name and "Pedido para Mesa 4" (or "Para llevar · Ventanilla").
  - The policy line, then "Precios en MXN con IVA incluido".
  - Products grouped by category, in es-MX money (`$1,234.50`).
  - A cart: a sticky "Ver pedido" bar on phones, a side panel from 768 px. It
    holds the lines and their options, the optional name (≤ 40) and kitchen
    note (≤ 200), the restaurant's privacy-notice link (or account's
    no-notice warning), the total and **Enviar pedido**.
- **Submit.**
  - The submit is idempotent: the diner's `operationId` and status key are
    kept across retries.
  - A status key already used by another order is `409 operation_conflict`.
    That holds even when two submits race with one key: the later insert
    loses on the unique key and gets the same 409, not a 500.
  - A network failure locks the cart with "No sabemos si tu pedido llegó." and
    **Reintentar**, which resends the identical body. Editing the cart starts
    a new order.
  - `public_price_changed`, `unavailable` and `invalid_modifier` refetch the
    menu and mark the line.
- **Status page (QR).**
  - It shows: waiting, pay-first, confirmed (with progress "En preparación" /
    "Listo" / "Entregado"; for a new check also "Por pagar"/"Pagado"),
    appended to the table's check (progress only, no money), rejected with a
    reason, expired, or cancelled.
  - Polling runs only while the page is visible: every 5 s for the first
    2 minutes of `pending`, then every 15 s, and every 20 s after acceptance.
    It stops once nothing can change, and after 3 h in any case.
  - The last five status keys are kept in `sessionStorage`, so a reload
    returns to the status.
- **Kiosk.**
  - After a submit, a full-screen code ("K-14"), the total, and where to pay.
    The kiosk resets after 20 s or on **Nuevo pedido**.
  - With items in the cart, "¿Sigues ahí?" appears after 75 s idle, and the
    kiosk clears the order at 90 s. A clean kiosk refetches its menu every
    90 s.
  - After two consecutive transient failures, a full-screen "Sin conexión.
    Pide en caja." overlay appears. It clears on the next successful poll.
  - The kiosk stores nothing on the device.
- **Online only.** The diner page has no offline queue and never registers the
  service worker. `src/main.tsx` uses
  `publicPage = /^\/(f|factura|qr|kiosk)(\/|$)/`, the same line cfdi writes
  (LD-P6). Its route test is `/^\/(qr|kiosk)(\/|$)/`, so `/qr#token` never
  renders the staff POS.

## 3. Staff flows

| Action | owner | manager | cashier | server | kitchen |
|---|---|---|---|---|---|
| See the inbox, badge and banner | ✓ | ✓ | ✓ | ✓ | – |
| Accept (`accept` policy) or **Cobrar y enviar a cocina** | ✓ | ✓ | ✓ | ✓ | – |
| **Aceptar sin cobrar (excepción)** under `pay_first` | ✓ (fresh PIN on terminals) | ✓ (fresh PIN on terminals) | – | – | – |
| Reject | ✓ | ✓ | ✓ | ✓ | – |
| Reject as abuse **and** deactivate the code | ✓ | ✓ | – | – | – |
| Pause or resume | ✓ | ✓ | ✓ | ✓ | – |
| Create, replace or deactivate codes; edit policies | ✓ | ✓ | – | – | – |

**Step-up (access SEC-6).** These ask for a fresh PIN on a shared terminal:

- creating links (one table, bulk tables, counter, kiosk);
- replacing a link;
- saving the policies;
- a manager's pay-first exception.

Only a Google-entered owner session on the owner's own personal device is
exempt. A PIN session on any device steps up after the window.

These never ask for a PIN: deactivating a code, rejecting (including the abuse
deactivation), pausing and plain accepting.

- **Mesas (Menú e inventario → Mesas).**
  - Each active table shows "QR activo · Ref. 7A3F · desde 3 oct." or "Sin
    código QR", with a **Código QR** button.
  - **Crear código QR** shows the printable card: `QRCodeSVG`, level M, a
    4-module quiet zone, titled. It offers **Copias** (1-4), **Imprimir**
    (browser printing, one card per section on 58/80 mm paper) and **Copiar
    enlace**.
  - "Ref." is the first 4 hex characters of the token hash. It is not secret;
    it lets staff match a sticker to its row.
  - A code is shown **once**. Printing again means **Reemplazar e imprimir**,
    and the old code stops working.
  - **Códigos QR de mesas** creates codes for many tables at once (≤ 100). It
    can also replace existing ones, and it prints one card per table.
- **Configuración → Pedidos en línea (QR y kiosco).**
  - The panel sits directly above FreeSelection (LD-P7).
  - It shows the status ("Recibiendo pedidos" / "En pausa" / "En pausa: ningún
    dispositivo del personal está conectado" / "Disponible en Pro") and the
    pause switch.
  - It holds the two policies, **Tiempo para confirmar** (10-120 min, default
    30) and **Importe máximo por pedido** (MXN 100.00-100,000.00, default
    10,000.00). The button is **Guardar pedidos en línea** (never "Guardar"),
    and the notice reads "Pedidos en línea guardados".
  - Kiosks and takeaway codes are listed with **Reemplazar** and
    **Desactivar**. **Agregar kiosco** / **Agregar código para llevar** opens
    the one-time reveal.
- **Órdenes inbox.**
  - It appears at the top of Órdenes while a link is active or orders wait.
    It polls every 10 s while visible and online, and every 60 s otherwise.
  - Cards are oldest first and show the label, place, age, expiry, name, note
    (allergy mentions styled like kitchen notes) and the pay-first badge.
  - The lines carry "Incluir" checkboxes and a re-quote against the current
    menu ("Ya no disponible", "Precio actual").
  - A changed total requires "El precio cambió desde que el cliente pidió. Ya
    le avisé." before accepting.
  - Table orders can join an **open** check of their table, or start a new
    check.
  - **Cobrar y enviar a cocina** opens service's `PaymentDialog`. The payment
    carries no client key, because the accept's own key covers it. The flow
    ends on `ReceiptModal`, which offers "Liberar mesa" for a paid table
    check.
  - Kitchen tickets print on accept when the device prints them on send.
- **Shell.**
  - The rail ("Órdenes" or "Operación") and the "Órdenes" tab show the pending
    count. The count is `aria-hidden`, so the buttons keep their names.
  - Away from Órdenes, a banner reads "2 pedidos en línea por confirmar ·
    Ver". It is an `aria-live="polite"` region, never `role="status"`
    (LD-P8).
  - The summary poll (`GET /api/ordering/inbox/summary`) runs every 20 s while
    a link is active and every 5 min otherwise. It runs only for visible,
    online operators. It stops when the server reports public ordering
    unavailable or when the session ends.
- **Mesas cards** show "Pedido QR por confirmar" while a table hold waits.
  Tapping it opens Órdenes.

## 4. Limits (`shared/public-ordering.ts`, `server/public-limits.ts`)

| Layer | Rule | Answer |
|---|---|---|
| Format | Token and status key match `^[A-Za-z0-9_-]{22}$` before any database work | `404 public_link_invalid` / `public_hold_not_found` |
| Per IP (in memory, per web replica) | Menu 60/min, submit 30/min, revision 240/min, status 240/min, cancel 30/min | `429 rate_limited` (with `requestId`) |
| Per (IP, link) | Revision 20/min; submit and cancel 10/min together | `429 rate_limited` |
| Per (IP, status key) | Status 30/min | `429 rate_limited` |
| Per table (every link of it, across replacements) | ≤ 3 pending; ≤ 8 created per 15 min | `429 public_order_limit` |
| Per counter link | ≤ 10 pending; ≤ 30 per 15 min | same |
| Per kiosk link | ≤ 5 pending; ≤ 30 per 15 min | same |
| Per restaurant | ≤ 40 pending (soft, counted without a lock) | `429 public_ordering_busy` |
| Order shape | ≤ 40 lines; quantity ≤ 20; no open-price items, line notes or open amounts | `400 invalid_input` / `403 forbidden` |
| Order value | ≤ the restaurant maximum | `409 public_order_too_large` |
| Honesty | `expectedTotal` equals the server quote | `409 public_price_changed` |
| Liveness | Paused, or no staff terminal seen for 5 min | `409 public_ordering_paused` |

Limiter keys use `clientIp(req)` with IPv6 grouped per /56
(`ipKeyGenerator(clientIp(req), 56)`, LD-11). A scoped key uses the header
only when it is a well-formed token; anything else shares one `-` bucket per
IP, so no client can mint buckets (MENU-R3). An unknown well-formed token costs
one short lookup, bounded by the per-IP ceilings.

The durable caps are counted under an advisory key per table or link inside
the submit transaction, so they hold across restarts and replicas. A cap hit
is logged as `public_order_limited` with the code and `ipHash`, and no personal
data.

## 5. Token design

- **Tokens.** 16 CSPRNG bytes, base64url (22 characters).
- **Storage.** Only `sha256("gm-public-link-v1:" + token)` is stored. There is
  no HMAC and no server secret, so rotating `SIGNING_KEYS` or `JWT_SECRET`
  never kills a printed code. The token carries no tenant id and no payload;
  nothing in this area calls `sign`, `verify` or `seal` (KEYS-2).
- **Lookup.** A diner has no tenant. `server/public-tokens.ts` sets
  `app.public_link_hash` inside its own short read-only transaction, and the
  `public_link_lookup` policy (SELECT only) returns exactly that row. It is the
  same pattern as pairing codes.
  - Positive results are cached for 5 minutes per process (≤ 5000 entries).
  - The cache never extends a link's validity, because every tenant
    transaction re-reads the row and checks `revoked_at`.
  - Replacing or deactivating a link evicts its hash from this process's
    cache.
- **Status lookups** (status and cancel) accept revoked links, so a replaced
  QR's pending orders stay readable. A phone that ordered with the code
  switches to its own orders when it learns the code was replaced (on load,
  or on a menu poll after it went back to the menu). The "Este código ya no
  funciona" page then offers **Ver mis pedidos**.
- **Staff replies.** Link replies carry the plaintext token once. They are
  never stored in `operations.result`: link creation is not `once()`. Every
  `/api/ordering` response is `Cache-Control: no-store`. Diner responses are
  `no-store` and `X-Robots-Tag: noindex`. In production, the `/qr` and
  `/kiosk` pages also send `X-Robots-Tag: noindex`, and helmet already sends
  `Referrer-Policy: no-referrer`.

## 6. Lock order (rows for platform §6.2 / ARCHITECTURE "Global lock order", added at B3)

New level **LO-2b**: the `public_order_holds` row. It is taken after LO-2 and
before LO-3, always as the first row lock of a hold command. No other area
locks a hold row.

The LO-3 objects of this area are:

- the advisory key `tenant:public-links` (class 924), then link rows
  `FOR UPDATE` in id order;
- the advisory key `tenant:public-hold:<table or link>` (class 925, submit
  caps);
- `dining_tables FOR SHARE` (sorted);
- the `public_ordering_settings` row.

LO-1 for the diner is `tenant:public-op:<operationId>` (class 0); its prefix
keeps it disjoint from staff `once()` keys. The two LO-3 keys use the non-zero
classes 924 and 925 because the ratchet (`tests/lock-scan.ts`) reads a class-0
key as an LO-1 operation key and a non-zero class as an LO-3 area key; with
class 0 it reported `rejectHold:2b>1` and `revokeLink:2>1` although both take
the links key after LO-2b/LO-2 as this table says.

Rows refer to other commands **by name**, so fiscal's reorder of `createOrder`
at 027 never makes them false:

| Command | Sequence |
|---|---|
| `submitHold` (diner, no `once()`) | 1 (public-op key) → 3 (public-hold key) → 3 (`dining_tables FOR SHARE`, table links) → 4 (`public_hold_numbers`) → insert hold |
| `cancelHold` (diner) | 2b |
| `acceptHold`, new check | 1 → 2 → 2b → 1′ (`h.order_operation_id`, the hold's own key, LO-R5) → [`createOrder` sequence from LO-2] |
| `acceptHold`, new check with payment | … as above → 1′ (server-fresh key, the `recordSettlement` pattern) → [`recordPayment` sequence from LO-2] |
| `acceptHold`, append | 1 → 2 → 2b → 1′ (`h.order_operation_id`) → [`addRound` sequence from LO-2] |
| `rejectHold` | 1 → 2 → 2b → (with the abuse deactivation) 3 (`public-links` key) → 3 (link row) |
| `createLink` / `createTableLinks` / `rotateLink` (not `once()`: tokens) | 3 (`public-links` key) → 3 (`dining_tables FOR SHARE`, sorted) → 3 (link rows) |
| `revokeLink` | 1 → 2 → 3 (`public-links` key) → 3 (link row) |
| `saveOrderingSettings`, `setPaused` | 1 → 2 → 3 (settings row) |

**Why this cannot cycle.**

- Only a command on the same hold waits for a hold row, and every such command
  takes it right after LO-2, holding nothing else but its own operation key
  and a shared `restaurants` lock.
- The nested keys taken after LO-2b are either the hold's own
  `order_operation_id` (generated by `submitHold`, used only by `acceptHold`,
  always after that hold row) or server-fresh.
- The hardened ratchet (`tests/lock-scan.ts`, level-monotonic and
  transitive) expands `acceptHold`'s calls, so it sees three pairs that no
  order can avoid: the hold row must be locked before `createOrder`/`addRound`
  (its decision `UPDATE` comes after them), and `createOrder`, `addRound` and
  `recordPayment` always open with their own `once()`. They are listed in
  `tests/lock-order.test.ts` as sanctioned exceptions (LD-24), and nothing
  else of this area is:

  | Entry | Class | Why it cannot cycle |
  |---|---|---|
  | `acceptHold:2b>1` | LO-R5 | The nested key is the hold's own `order_operation_id` (generated by `submitHold`, used only by `acceptHold` under that hold row), taken before LO-4. |
  | `acceptHold:12>1` | LO-R5 (fresh) after E5 | `recordPayment(randomUUID())`: a key no other transaction can hold, after `createOrder`'s refresh, which cannot issue (nothing is paid at creation). |
  | `acceptHold:12>11` | E5 | `createOrder`'s refresh cannot issue; the drawer follows it, exactly as `applySale` (offline sale sync). |
- The dynamic check is DB test 24: 50 rounds of concurrent pay-first accepts,
  appends, abuse rejections, link rotations, drawer closes, settling voids and
  offline-style sales. No deadlock surfaces.

## 7. DB-9 contract and validation

032 adds CHECK constraints `NOT VALID`: they are enforced for every new insert
and update at once. 033 (`-- gm:no-transaction`, one `VALIDATE` per part,
`SHARE UPDATE EXCLUSIVE`) validates existing rows.

| Constraint | Allowed values |
|---|---|
| `orders_state_valid` | `active`, `ready`, `completed`, `cancelled`, `recovery_pending`, `recovery_reviewed` |
| `orders_channel_valid` | `pos`, `qr`, `kiosk`, `offline` |
| `orders_mode_valid` | `takeaway`, `dine_in`, `delivery` |
| `rounds_state_valid` | `active`, `ready`, `completed`, `offline_review` |
| `jobs_state_valid` | `queued`, `available`, `running`, `done`, `blocked`, `dead` |

`orders.check_state` was already constrained and validated by 024
(`orders_check_state_valid`).

**Contract for every area (LD-P13).**

- A new value in one of these columns needs a migration that drops and
  re-adds the constraint (`-- gm:contract-approved`).
- It also needs tests that write the value, and a note to this area.
- `tests/public-ordering-db.ts` (test 2) writes every listed value.

**Validation runs as the owner, unfiltered by RLS.** Validation is an internal
heap scan. DB test 3 proves that `gm_migrator`, under FORCE RLS with no
tenant, still finds another tenant's bad row.

**DB-9 validation (before the first deploy that carries 032/033).** Run
read-only as `gm_migrator` on staging and production. Each query must return
0:

```sql
select count(*) from orders where state not in ('active','ready','completed','cancelled','recovery_pending','recovery_reviewed');
select count(*) from orders where channel not in ('pos','qr','kiosk','offline');
select count(*) from orders where mode not in ('takeaway','dine_in','delivery');
select count(*) from rounds where state not in ('active','ready','completed','offline_review');
select count(*) from jobs where state not in ('queued','available','running','done','blocked','dead');
```

**If 033 fails anyway** (a row outside a set):

1. Nothing is lost: 032 committed, and the constraints already block new bad
   writes. The new revision never passes readiness, because the registry row
   of 033 is written only after every part succeeds.
2. Find the row with the query above. Repair it to the value the current code
   would write (for example a legacy `state`), with an audit note in the
   incident log.
3. Re-run the deploy. `VALIDATE` of an already valid constraint is a no-op,
   so the parts that succeeded cost nothing.

**Deploy window.** 032's `ADD CONSTRAINT … NOT VALID` briefly takes `ACCESS
EXCLUSIVE` on `orders`, `rounds` and `jobs`. `lock_timeout` is 5 s, and the
runner retries 55P03 with backoff. Once production has traffic, the deploy
that first carries 032 runs before 07:00 Mexico City (the P-27 rule).

**Runner fix shipped with 033.** `applyMigrations` called `reserved.begin()`
for a no-transaction file that was the newest pending one. postgres.js
reserved connections have no `begin()`, so every deploy with 033 (and the
grants hook) would have failed. The hook and the registry row now share one
explicit `begin`/`commit` on the reserved connection
(`server/ops/schema.ts`). DB test 1 runs the real runner with the grants hook
on a scratch database. `server/ops/schema.ts` belongs to ops and no spec
sanctions this edit (PUB-R5). It needs the lead's and ops' sign-off. The
proposal is to land it on `integration/v1` as its own small ops commit, with
the same leg in `tests/migrate-db.ts`, so that any Wave 2 track whose newest
migration is no-transaction gets it too. Public would then take it from
integration at B1.

## 8. Fiscal, CFDI and the flag

- **Holds are not sales.** They never create a ticket or folio, and never
  enter cortes, reports or CFDI globals. An accepted hold is an ordinary order
  (`channel` `qr`/`kiosk`) or a round on an existing check.
- **Pay-first acceptance** creates the order and the tender in one
  transaction. From 027, the ticket is issued inside it.
- **A $0.00 hold** needs no payment and is not an exception. It never gets a
  fiscal ticket (027 tickets only `orders.total > 0`).
- **Appends go only to `open` checks.** A paid (ticketed) check takes no
  rounds; the refusal is `public_hold_target_invalid`, and the inbox switches
  to "Cuenta nueva".
- **The diner status page** shows "Folio" and the self-invoice link
  (`/f/{CODE}`) when fiscal and cfdi report them. In Phase A the shims return
  no ticket, so neither appears.
- **`PUBLIC_ORDERING_ENABLED`** belongs to account (031).
  - Phase A uses the S1 shim with account's interim semantics: `"true"` → on;
    `"false"` → off; unset or empty → on unless `APP_ENV=production`; anything
    else refuses to start (`public_ordering_flag_invalid`).
  - Off: `/api/public/*` answers `404 public_ordering_disabled` before any
    limiter. The staff link, decision and inbox routes answer the same code.
    The settings panel, the table QR actions and the inbox stay hidden.
  - B4 flips "unset" to on in every environment, as a separately revertible
    commit; `false` stays the kill switch.

## 9. Offline

- **Diner pages** are online only (no Dexie, no queue, no service worker).
- **Staff.**
  - The inbox, the badge poll and every link or settings action need the
    server.
  - When App's `online` is false, the inbox shows "Disponible al volver la
    conexión." with every action disabled. It keeps showing the last cards it
    read.
  - Offline records can never carry `qr` or `kiosk`: offline sync forces
    `pos` or `offline`.
  - Accepted holds are ordinary server orders for offline open-orders
    caching.
- **Auto-pause.** When the restaurant's connection drops, no operator session
  is touched, so ordering pauses itself within 5 minutes. Pending holds expire
  normally.

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Diners see "El restaurante no está recibiendo pedidos en línea" | Ordering is paused (Configuración or the inbox shows "En pausa"; press **Reanudar**), or no staff **terminal** has Green Monkey open. Only operator sessions on shared terminals count. An owner's personal laptop does not. |
| Ordering pauses although a terminal is on | Its session is a pre-023 legacy session (it never updates `last_seen_at`; sign in again), or the device is in manual "Trabajar sin conexión" mode (it sends no requests; turn it off). The page may also be hidden (polls pause), so bring Green Monkey to the front. |
| "Este código ya no funciona" | The code was replaced or deactivated, the QR is a 24 h-era signed link, or the scanner dropped the URL fragment. Print a new code from Mesas or Configuración. |
| "Esta mesa no está recibiendo pedidos en línea" | The table is archived. Restore it in Mesas, and its code works again. |
| The QR order does not show in Órdenes | It expired (default 30 min; the inbox shows "{n} pedidos vencieron…"), or the restaurant is not on Pro. |
| "Ya hay pedidos esperando confirmación aquí" | The table already has 3 pending orders (or 8 in 15 minutes). Accept or reject them. |

## 11. Abuse response (RUNBOOK, added at B3)

1. **Reject as abuse.** In Órdenes, **Rechazar** → "Pedido falso o abuso".
   Managers tick "Desactivar también este código QR". The printed code stops
   working at once; the diner sees "Pregunta al personal".
2. **Pause** online ordering (any operator) while the source is unclear.
3. **Replace** a table's code in Mesas (**Reemplazar e imprimir**) and stick
   the new card.
4. **Logs.** `rate_limited` lines carry the limiter name and `ipHash`.
   `public_order_limited` lines carry the code. Neither stores tokens, paths
   or personal data. Durable caps bound the damage whatever the IP.

## 12. Data and privacy

- **Personal data.** The diner name and note are the only personal data. They
  are stored on the hold and, after acceptance, on the order (`orders.name`,
  `orders.note`) or the round note (`Q-14 · Ana · sin cebolla`). LD-1 prints
  round notes on the customer receipt and the kitchen ticket. The name is
  optional, and account's privacy copy applies.
- **No IP storage.** No IP address is stored. Logs carry `ipHash` only.
- **Export and retention.** `token_hash`, `status_key_hash` and
  `request_hash` are excluded by account's export rule for `_hash` columns
  (B3, test 31). Retention never deletes the four `public_*` tables.
- **Grants.** The runtime role has no DELETE. It updates only the decision
  columns of holds, the revocation columns and label of links, the settings
  columns and hold numbers. Transition triggers keep a hold's request and a
  link's identity immutable.

## 13. Tests

- **Unit.**
  - `tests/public-ordering.test.ts`: tokens, hashes, schemas, labels, states,
    progress, actions, limiter keys, money pins, diner routes, the settings
    schema and the interim flag.
  - `tests/public-kiosk.test.ts`: the idle controller.
  - `tests/public-ordering-http.test.ts`: limiter keys on the real client
    address, with a database stub.
- **DB and HTTP** (`npm run test:db:public`, in `test:db:qualification`):
  `tests/public-ordering-db.ts`, 37 checks on fresh fictional restaurants. It
  never deletes: accepted holds write append-only ledgers. Fiscal legs are
  gated with `to_regclass('public.fiscal_tickets')` until B1.
- **Menu suite.** `tests/menu-db.ts` MENU-R1/R6 and MENU-R3 run on the header
  routes and `PUBLIC_RATES`.
- **Browser.**
  - `tests/browser/public-ordering.spec.ts`, plus the rewritten QR legs of
    `menu.spec` (FIT-4, OWNER-2/11), `core.spec` and `security.spec`.
  - Every test uses its own `QR <runId>` tables or run-id-labelled codes, and
    undoes what it created (holds, links, pause, policies, checks, tables) in
    a `finally` (LD-P9). `public-ordering.spec` and `core.spec` also run that
    cleanup from an `afterEach`, for a test that times out before its
    `finally`.
  - Evidence: `docs/evidence/public-*.png`.

## Phase B: what is still to do

| Step | When | Work |
|---|---|---|
| **B1** | fiscal 027 merged; merge `integration/v1` into `track/public`, reset the track DB | 1. Delete `server/compat/public-fiscal.ts`. Import `fiscalTicketIdentity` from `./fiscal-read.js` (or alias fiscal's reader) in `server/public-diner.ts`.<br>2. Refresh §6 against fiscal's reordered `createOrder` (feed before refresh, the ticket after `recordPayment`).<br>3. Un-gate the `fiscal_tickets` legs of DB tests 9, 18 and 33; add DB 22 `fiscal.folio` and DB 24 with fiscal DB 28's harness.<br>4. Check that `publicCatalog` strips `fiscal` (C29) and that totals do not depend on the fiscal context (X26).<br>5. Browser test 4 asserts "Folio" in `ReceiptModal`. |
| **B-028/029** (optional) | discounts / reports merged | Keep one copy of the `online` hunks (LD-P5). `AUDIT_GROUPS` gains the `public.` prefixes (LD-P4; else one sanctioned `shared/reports.ts` edit at B3). Re-run DB 24 with discounts' drawer close. Run `reports.spec` after `public-ordering.spec`. |
| **B2** | cfdi 030 merged; merge and reset | 1. Delete `server/compat/public-cfdi.ts` and import `selfInvoiceOffered` from `./cfdi/store.js`.<br>2. One render chain in `src/main.tsx` (`/legal` → `/(f\|factura)` → `/(qr\|kiosk)`), with the shared `publicPage` line kept byte for byte.<br>3. DB 22 invoice leg; DB 26 `holdStatus` ≤ 5. |
| **B3** | account 031 merged (mandatory); merge and reset | 1. Delete `server/compat/public-account.ts` and import `publicOrderingEnabled`, `publicOrderingGate` and `restaurantPrivacyUrl` from `./account-settings.js`. Remove the `public_ordering_disabled` row from `ownedElsewhere`.<br>2. Delete `src/compat/public-account.ts` and use `strings[locale].accountGuest*`.<br>3. Resolve account's hunks in favour of public's versions (`server/public-ordering.ts`, `server/index.ts` `/ordering-links`, `PublicOrdering.tsx`, `ManagementTools.tsx`).<br>4. Settings golden order: `… AccountPrivacy → PublicOrderingSettings → FreeSelection …`.<br>5. Rewrite account's QR tests (HTTP checks 2-3, `account.spec` QR legs) and export test 31.<br>6. Re-grep the DB-9 writers, including raw test fixtures. Keep the `-- 032` grants block last.<br>7. Shared docs in one commit: ARCHITECTURE (LO-2b text and §6 rows), OPERATIONS, RUNBOOK (§11 and §7 validation), MENU (`:88-136`), SERVICE, the ACCESS step-up list, RELEASE, ACCOUNT_AND_LEGAL, DELIVERY_STATUS and the ledgers.<br>8. LD-5 round 2 and full qualification. |
| **B4** | after B3, a separate revertible commit | Account's flag: unset means on everywhere. Update `tests/public-ordering-flag.test.ts`, the `.railway/railway.ts` and `.env.example` comments, and the RELEASE and ACCOUNT_AND_LEGAL lines. Then a staging browser run, and production per RELEASE. |

## Field checks before printing at scale

- **QR scanners.** Scan a printed card with the camera apps of the phones
  diners use (iOS camera, Android camera or Google Lens, WhatsApp) and with
  the kiosk tablet. Confirm the URL keeps its `#fragment`. A scanner that
  drops it shows "Este código ya no funciona" (D9).
- **Card printing.** Print one card on the restaurant's 58/80 mm printer and
  on an office printer, and check that a phone reads the 36/44 mm code at
  table distance.
- **Kiosk tablets.** Use a dedicated browser profile for a kiosk. A tablet
  that was also a POS keeps the POS service worker, which serves its cached
  shell to `/kiosk` (R16).
