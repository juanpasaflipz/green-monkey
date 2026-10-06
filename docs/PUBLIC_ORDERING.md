# Public ordering: QR and kiosk ("pedidos en línea")

Migrations 032 and 033. Audit findings SEC-7, FIT-11, FOH-13 and the DB-9
remainder.

**Status: Phase A and step B1, built on `track/public`.** Phase A depends
only on wave 1 and platform 2.0; B1 absorbed fiscal 027 (`integration/v1` at
`70860d6`). The track merges into `integration/v1` once, after account (031)
and the remaining Phase B steps described in
[Phase B](#phase-b-what-is-still-to-do). Until then:

- Two dependencies still come from compat shims with the owners' exact
  signatures: account (S1 `server/compat/public-account.ts`, S4
  `src/compat/public-account.ts`) and cfdi (S3 `server/compat/public-cfdi.ts`).
  Fiscal's shim (S2) is gone since B1. No shim reaches `integration/v1`.
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
- The inbox's churn read (diner cancellations of the last 15 minutes, every
  code) uses the partial index `public_order_holds_cancelled_recent`
  (`tenant_id, created_at` where `state = 'cancelled'`), so an idle inbox poll
  stays cheap as cancelled holds accumulate (retention never deletes them).

Acceptance runs the unmodified `createOrder` (a new check) or `addRound` (a
round on the table's open check) as the staff member who accepts. For
pay-first, it also runs `recordPayment`. Rejected, cancelled and expired holds
leave no sales or fiscal trace.

The diner knows the order only by its label, so the label travels with it:

- A new check's call name is `Q-14 · Ana` (or `Q-14` without a name) and its
  order note `Q-14 · sin cebolla`. The KDS and the kitchen ticket show the
  call name; the receipt prints the order note (LD-1).
- An appended round's note is `Q-14 · sin cebolla`, never the diner's name,
  because round notes print on the shared check's receipt.
- The hold records what acceptance charged (`accepted_total`,
  `accepted_lines`: the inserted round's own `order_lines`). The diner's
  status shows those prices, never the submission snapshot.

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
  - The policy line, then "Precios en {currency} con IVA incluido" (the
    restaurant's currency).
  - A diner who sent orders from this phone and went back to the menu gets
    **Tus pedidos (Q-14)** in the header.
  - Products grouped by category, in es-MX money (`$1,234.50`).
  - A cart: a sticky "Ver pedido" bar on phones, a side panel from 768 px. It
    holds the lines and their options, the optional name (≤ 40) and kitchen
    note (≤ 200), the restaurant's privacy-notice link (or account's
    no-notice warning), the total and **Enviar pedido**. From 768 px the
    panel fits the viewport and scrolls inside, with the total and **Enviar
    pedido** pinned to its bottom (the header sits in the menu column).
  - Links on a phone (the privacy notices, the self-invoice link) open in a
    new tab with `rel="noopener noreferrer"`, so the order page stays open.
- **Submit.**
  - The submit is idempotent: the diner's `operationId` and status key are
    kept across retries.
  - A status key already used by another order is `409 operation_conflict`.
    That holds even when two submits race with one key: the later insert
    loses on the unique key and gets the same 409, not a 500.
  - A network failure locks the cart (lines, name and note) with "No sabemos
    si tu pedido llegó." and **Reintentar**, which resends the identical
    body. **Editar pedido (se enviará como uno nuevo)** unlocks it; any send
    after that is a new order (new keys).
  - On success the page's persistent live region announces "Pedido Q-14
    enviado. Esperando confirmación del personal." and focus moves to the
    status heading ("Estado de tu pedido").
  - A submit answered `404 public_link_invalid` (the code was replaced since
    the menu loaded) keeps the menu and the cart; the cart says "Este código
    ya no funciona…" next to **Ver mis pedidos**.
  - `public_price_changed`, `unavailable` and `invalid_modifier` refetch the
    menu and mark the line.
- **Status page (QR).**
  - It shows: waiting, pay-first, confirmed (with progress "En preparación" /
    "Listo" / "Entregado"; for a new check also "Por pagar"/"Pagado"),
    appended to the table's check (progress and the round's own total, never
    the check's balance), rejected with a reason, expired, or cancelled.
  - A confirmed order shows the prices acceptance charged. When they differ
    from the ones sent: "El precio cambió al confirmar tu pedido; total
    confirmado: $100.00."
  - One `role="status"` region stays mounted from "Cargando…" to the loaded
    state, so a screen reader hears each change.
  - A just-expired hold reads as waiting for 60 s more
    (`HOLD_EXPIRY_GRACE_SECONDS`): an accept that locked it in time may still
    be committing. Staff decisions stop exactly at `expires_at`.
  - A code found replaced on a menu poll switches the page to this phone's
    orders with "Este código QR ya no funciona: se reemplazó o se desactivó.
    …" above them.
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
  - The kiosk renders **no navigational link**: "Privacidad de la
    plataforma" and the restaurant's notice open an in-page dialog with a QR
    code per notice to read on the diner's own phone. The idle reset closes
    it. A tap can therefore never leave `/kiosk#token`.
  - The code renders at 120 px. The page's live region announces "Tu código
    es K-14. …"; the code itself is a plain heading.
  - If the first menu load fails (the tablet powered on before the network),
    the kiosk retries every 20 s on its own.
  - A new `#token` pasted into the same tab (a same-document navigation)
    opens the new code at once; this holds for phones too.
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
  - It shows the status ("Recibiendo pedidos" / "En pausa" / "En pausa:
    ninguna terminal compartida (caja o mesero) está conectada" / "Disponible
    en Pro") and the pause switch.
  - It holds the two policies, **Tiempo para confirmar** (10-120 min, default
    30) and **Importe máximo por pedido** (MXN 100.00-100,000.00, default
    10,000.00). The button is **Guardar pedidos en línea** (never "Guardar"),
    and the notice reads "Pedidos en línea guardados".
  - Kiosks and takeaway codes are listed with **Reemplazar** and
    **Desactivar**. Both confirm in a dialog ("Sí, desactivar Ventanilla").
    **Agregar kiosco** / **Agregar código para llevar** opens the one-time
    reveal.
- **Órdenes inbox.**
  - It appears at the top of Órdenes while a link is active or orders wait.
    It also stays while it still owns something: an outcome notice, a
    pay-first receipt or an open payment or rejection dialog. Handling the
    last order while no code is active (a code deactivated as abuse, the only
    kiosk deactivated) empties the next read, and the notice and the receipt
    stay until staff close them ("Ocultar aviso", the receipt's own buttons)
    or leave Órdenes.
    It polls every 10 s while visible and online, and every 60 s otherwise.
  - Cards are oldest first and show the label, place, age, expiry, name, note
    (allergy mentions styled like kitchen notes) and the pay-first badge.
  - The lines carry "Incluir" checkboxes and a re-quote against the current
    menu ("Ya no disponible", "Precio actual").
  - A changed total requires "El precio cambió desde que el cliente pidió. Ya
    le avisé." before accepting. The accept carries `acknowledgedTotal`, the
    total the card showed. The server charges exactly that or answers `409
    public_hold_price_changed`, and the card clears the tick whenever its
    total changes (a later poll, an exclusion).
  - The server also checks what the round actually charged: a menu change
    committed between its price check and `createOrder`'s own read rolls the
    whole accept back with the same 409.
  - A hold whose code was deactivated as abuse is marked "Código desactivado
    por abuso: verifica con el cliente antes de aceptar." Accepting it needs
    "Lo verifiqué con el cliente; aceptar de todos modos." (`abuseAcknowledged`;
    otherwise `409 public_hold_link_abuse`). Such holds are not rejected
    automatically: a table code also carries real diners' orders.
    A sibling's abuse rejection locks only its own hold, so the accept reads
    the code again as its last read before deciding: a rejection that
    commits while the accept runs rolls it back with the same 409. One that
    commits after that read is ordered after the accept, which then needed
    no acknowledgement.
  - The target select pre-selects a table's only open check, also one opened
    after the card appeared, until staff choose themselves.
  - Accepting says "Q-14 → Orden #142 enviada a cocina." An accept that finds
    the hold already handled or expired keeps that outcome in the notice.
  - Codes whose diners cancelled many orders are named ("Mesa 7: muchos
    pedidos cancelados desde el cliente. …").
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
| Format | Token and status key match `^[A-Za-z0-9_-]{22}$` before any database work; a missing or malformed one counts only in its own per-IP bucket (30/min) | `404 public_link_invalid` / `public_hold_not_found`; then `429 rate_limited` |
| Per IP (in memory, per web replica) | Menu 60/min, submit 30/min, revision 240/min, status 240/min, cancel 30/min | `429 rate_limited` (with `requestId`) |
| Per (IP, link) | Revision 20/min; submit and cancel 10/min together | `429 rate_limited` |
| Per (IP, status key) | Status 30/min | `429 rate_limited` |
| Per table (every link of it, across replacements) | ≤ 3 pending; ≤ 8 created per 15 min | `429 public_order_limit` |
| Per counter link | ≤ 10 pending; ≤ 30 per 15 min | same |
| Per kiosk link | ≤ 5 pending; ≤ 30 per 15 min | same |
| Churn (same scopes) | Diner cancellations per 15 min: table ≤ 4, counter and kiosk ≤ 10 | `429 public_order_churn` |
| Per restaurant | ≤ 40 pending (soft, counted without a lock) | `429 public_ordering_busy` |
| Order shape | ≤ 40 lines; quantity ≤ 20; no open-price items, line notes or open amounts | `400 invalid_input` / `403 forbidden` |
| Order value | ≤ the restaurant maximum | `409 public_order_too_large` |
| Honesty | `expectedTotal` equals the server quote | `409 public_price_changed` |
| Liveness | Paused, or no staff terminal seen for 5 min | `409 public_ordering_paused` |

Limiter keys use `clientIp(req)` with IPv6 grouped per /56
(`ipKeyGenerator(clientIp(req), 56)`, LD-11). A request whose token is missing
or malformed costs no database work, so it is refused first, counted only in
its own per-IP bucket, and never drains the shared ceilings: a script on the
guest Wi-Fi sending token-less requests cannot starve the diners behind the
same address. A scoped key uses the header only when it is a well-formed
token, so no client can mint buckets (MENU-R3). An unknown well-formed token
costs one short lookup and still counts against the per-IP ceilings
(MENU-R3's assertion: the ceiling is per IP, whatever the well-formed token).

The durable caps are counted under an advisory key per table or link inside
the submit transaction, so they hold across restarts and replicas. A cap hit
is logged as `public_order_limited` with the code, the link's reference
(`ref`, the "Ref. 7A3F" staff see), its kind and `ipHash`.

Diner cancellations have their own budget: a submit-and-cancel loop leaves
nothing in the inbox, so without it a script could keep a table's window cap
full while staff see nothing. The inbox names the code, and
`PublicLinkView.recentCancelled` counts the cancellations of the last 15
minutes.

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
at 027 never made them false. Since 027 (refreshed at B1) those commands run,
in platform §6.2's numbering: `createOrder` 1 → 2 → 3 (tables, E1) → 4 → 5 →
9 → 7 → 10 → refresh, whose refresh cannot issue (nothing is paid at
creation, E5); `addRound` 1 → 2 → 5 → 9 → 7 → refresh (cannot issue) → 10;
`recordPayment` 1 → 2 → 5 → 11 → refresh [12]. So a pay-first accept takes
the folio counter (LO-12) last, inside `recordPayment`, and a $0 accept never
reaches LO-12 (027 tickets only `orders.total > 0`, M9).

| Command | Sequence |
|---|---|
| `submitHold` (diner, no `once()`) | 1 (public-op key) → 3 (public-hold key) → 3 (`dining_tables FOR SHARE`, table links) → 4 (`public_hold_numbers`) → insert hold |
| `cancelHold` (diner) | 2b |
| `acceptHold`, new check | 1 → 2 → 2b → 1′ (`h.order_operation_id`, the hold's own key, LO-R5) → [`createOrder` sequence from LO-2] |
| `acceptHold`, new check with payment | … as above → 1′ (server-fresh key, the `recordSettlement` pattern) → [`recordPayment` sequence from LO-2, ending with the ticket at 12] |
| `acceptHold`, append | 1 → 2 → 2b → 1′ (`h.order_operation_id`) → [`addRound` sequence from LO-2] (a ticketed target is refused under its order lock, fiscal D1) |
| `rejectHold` | 1 → 2 → 2b → (with the abuse deactivation) 3 (`public-links` key) → 3 (link row) |
| `createLink` / `createTableLinks` / `rotateLink` (not `once()`: tokens) | 3 (`public-links` key) → 3 (`dining_tables FOR SHARE`, sorted) → 3 (link rows) |
| `revokeLink` | 1 → 2 → 3 (`public-links` key) → 3 (link row) |
| `saveOrderingSettings`, `setPaused` | 1 → 2 → 3 (settings row) |

`lockHold` judges expiry with `clock_timestamp()` in a second statement after
the row lock, not with the transaction's start time; it takes no extra lock.

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
  | `acceptHold:12>1` | LO-R5 (fresh) after E5 | `recordPayment(randomUUID())`: a key no other transaction can hold, after `createOrder`'s closing refresh, which follows the feed since 027 (LO-R3) and cannot issue (nothing is paid at creation). |
  | `acceptHold:12>11` | E5 | `createOrder`'s closing refresh cannot issue; `recordPayment` then takes the drawer and issues the ticket (LO-12) last, exactly as `applySale` (offline sale sync). |

  At B1 the scanner, run against fiscal's reordered `createOrder` and
  `addRound`, still reports exactly these three pairs; only their reasons in
  `tests/lock-order.test.ts` were refreshed.
- The dynamic check is DB test 24: 50 rounds of concurrent pay-first accepts,
  appends, abuse rejections, link rotations, drawer closes, settling voids and
  offline-style sales. No deadlock surfaces. Since B1 it also checks fiscal's
  harness: gapless, unique folios, one ticket per settled order at its total,
  none with a balance due, and each pay-first accept's ticket at the total
  the accept charged. The drawer close starts staggered (0-135 ms), so the
  accepts and sales that take the drawer and the folio counter commit in
  most rounds instead of always losing the drawer to the close.

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
EXCLUSIVE` on `orders`, `rounds` and `jobs`. They come first in 032, so the
migration never upgrades a weaker lock it already holds on `orders` (the new
foreign keys take `SHARE ROW EXCLUSIVE` on it). A deadlock with live traffic
is still possible: the KDS feed reads `rounds` and then `orders`, the reverse
of the migration's order. If 032 is the victim (40P01), the whole file rolls
back and the deploy fails; re-running it is safe. `lock_timeout` is 5 s, and
the runner retries 55P03 with backoff, not 40P01 (a retry of 40P01 for
transactional files is an ops proposal, like PUB-R5). Once production has
traffic, the deploy that first carries 032 runs before 07:00 Mexico City (the
P-27 rule).

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
migration is no-transaction gets it too. `integration/v1` had not taken it
when B1 merged fiscal 027 (`70860d6`), so it still ships on `track/public`.

## 8. Fiscal, CFDI and the flag

- **Holds are not sales.** They never create a ticket or folio, and never
  enter cortes, reports or CFDI globals. An accepted hold is an ordinary order
  (`channel` `qr`/`kiosk`) or a round on an existing check.
- **Pay-first acceptance** creates the order, the tender and (027) the fiscal
  ticket in one transaction, so the receipt shown after "Cobrar y enviar a
  cocina" prints the folio. The ticket's gross is the total the accept
  charged: prices include IVA, so the restaurant's fiscal context (a border
  region, a product's category) changes the tax split, never a total, and the
  inbox's re-quote and the accept's check (default context) agree with
  `createOrder` (X26; DB test 45).
- **An accept without payment** issues no ticket: the check gets it when it is
  paid, as any other check.
- **A $0.00 hold** needs no payment and is not an exception. It never gets a
  fiscal ticket (027 tickets only `orders.total > 0`).
- **Appends go only to `open` checks** (fiscal D1: a check gets its ticket
  when it is paid and takes no rounds afterwards). A paid or closed target is
  refused with `public_hold_target_invalid`. If a payment settles the target
  between the inbox read and the accept, `addRound` refuses the ticketed check
  under its order lock (`fiscal_ticket_issued`) and the accept answers
  `public_hold_target_invalid` too, rolled back. The inbox switches to
  "Cuenta nueva"; it still maps `fiscal_ticket_issued` the same way.
- **The diner status page** of a new check shows "Folio …" once the check is
  paid, read with fiscal's `fiscalTicketIdentity` (`server/fiscal-read.ts`,
  one statement); an appended round shows neither money nor a folio. The
  self-invoice link (`/f/{CODE}`) waits for cfdi: the S3 shim offers none
  until B2.
- **The diner menu** carries no fiscal fields: fiscal's `publicCatalog`
  strips each product's tax category and SAT keys (C29).
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
| "Ya hay pedidos esperando confirmación aquí" | The table already has 3 pending orders (or 8 in 15 minutes). Accept or reject the pending ones in Órdenes. If the inbox shows none, the window is full of decided orders and frees itself within 15 minutes. |
| "Se cancelaron muchos pedidos con este código" | Diners cancelled 4 orders at that table (10 at a counter or kiosk) in 15 minutes; the inbox names the code. If it is not a real guest, replace the code (Mesas) or deactivate it (Configuración). Logs: `public_order_limited` with `code: public_order_churn` and the code's `ref`. |

## 11. Abuse response (RUNBOOK, added at B3)

1. **Reject as abuse.** In Órdenes, **Rechazar** → "Pedido falso o abuso".
   Managers tick "Desactivar también este código QR". The printed code stops
   working at once, in every web process (each request re-reads the link,
   whatever the cache holds); the diner sees "Pregunta al personal". The
   code's other pending orders stay in the inbox, marked "Código desactivado
   por abuso", and need an explicit check before anyone can accept them.
2. **Pause** online ordering (any operator) while the source is unclear.
3. **Replace** a table's code in Mesas (**Reemplazar e imprimir**) and stick
   the new card.
4. **Churn.** Many orders sent and cancelled from one code show in the inbox
   by name; replace or deactivate that code.
5. **Logs.** `rate_limited` lines carry the limiter name and `ipHash`.
   `public_order_limited` lines carry the code, the link's `ref` and kind,
   and `ipHash` (pseudonymous personal data, §12). Neither stores tokens or
   paths. Durable caps bound the damage whatever the IP.

## 12. Data and privacy

- **Personal data.** The diner name and note are the personal data diners
  type. They are stored on the hold and, after acceptance, on a new check's
  call name and order note (`Q-14 · Ana`, `Q-14 · sin cebolla`), which LD-1
  prints on that diner's receipt. An appended round's note is `Q-14 · sin
  cebolla` only: the name never prints on a shared check's receipt. The name
  is optional, and account's privacy copy applies.
- **IP addresses.** No IP address is stored in the database. Two log lines
  (`rate_limited`, `public_order_limited`) carry `ipHash`, ops's 48-bit
  unsalted SHA-256 prefix of the client address. For IPv4 it can be reversed
  by enumeration, so it is pseudonymous **personal data**, not anonymous: it
  belongs in the restaurant and platform privacy-notice inputs at B3, and log
  access follows the log retention rules. A keyed hash (or hashing the /24
  and /48 prefix) is an ops proposal.
- **ARCO requests for holds.** Rejected, cancelled and expired holds never
  become sales, so no fiscal rule requires keeping their name and note, yet
  the runtime role cannot change or delete them (the transition trigger and
  the grants). Until an ops retention rule redacts them (proposal: blank
  `name` and `note` of holds that are not `accepted` after 30 days, as the
  schema owner, with a redaction-only exception in the trigger), support
  handles an ARCO cancellation request for a hold as the schema owner in a
  logged session: find the hold by restaurant, label and date, and set `name`
  and `note` to `''` with the transition trigger disabled inside one
  transaction (the LD-12 named-trigger pattern), with an incident note. An
  accepted hold's data also lives on the order, which follows account's
  procedure at B3 (ACCOUNT_AND_LEGAL).
- **Export and retention.** `token_hash`, `status_key_hash` and
  `request_hash` are excluded by account's export rule for `_hash` columns
  (B3, test 31). Retention never deletes the four `public_*` tables.
- **Grants.** The runtime role has no DELETE. It updates only the decision
  columns of holds (including `accepted_total` and `accepted_lines`), the
  revocation columns and label of links, the settings columns and hold
  numbers. Transition triggers keep a hold's request and a
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
  `tests/public-ordering-db.ts`, 46 checks on fresh fictional restaurants. It
  never deletes: accepted holds write append-only ledgers (stock movements,
  fiscal tickets). Since B1 the fiscal legs run unconditionally: no ticket for
  a hold or an unpaid accept, one in a pay-first accept's transaction at its
  charged total, none for $0, the folio on the status, the folio harness in
  test 24 and the totals check on a border restaurant with a full fiscal
  identity (test 45). Every
  concurrency burst runs under `noRetries()` (LO-R9), so a single retried
  deadlock fails it. Checks 37-42 cover the hardening: the abuse
  acknowledgement, a link revoked or replaced by another process (the cache is
  not told), a menu change between the accept's check and `createOrder`, a
  target paid between the unlocked read and `addRound`, the expiry grace, and
  churn.
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
| **B1** (done) | fiscal 027 merged (`integration/v1` `70860d6` merged into `track/public`, track DBs reset as `gm_migrator`) | 1. `server/compat/public-fiscal.ts` deleted; `server/public-diner.ts` imports fiscal's `fiscalTicketIdentity` from `./fiscal-read.js` (exact S2 signature).<br>2. §6 refreshed against fiscal's reordered `createOrder` (feed before the closing refresh; the ticket last, inside `recordPayment`; no LO-12 for $0).<br>3. Fiscal legs un-gated (DB 9, 15, 16, 18, 33); DB 22 shows `fiscal.folio` after payment; DB 24 runs fiscal DB 28's harness; DB 26 measures `holdStatus` at 3; DB 40 covers the paid-target race with tickets on (D1) and off.<br>4. `publicCatalog` strips `fiscal` (C29) and totals do not depend on the fiscal context (X26): DB 45 on a border restaurant with a full identity, whose pay-first ticket gross equals the hold's quoted and charged totals.<br>5. Browser: the pay-first kiosk receipt prints "Folio" and its ticket's gross is the hold's total; the table diner sees "Pagado · Folio …" after payment.<br>6. `tests/lock-order.test.ts`: the scanner still reports exactly the three LD-24 `acceptHold` pairs; their reasons now name fiscal's sequence (separate commit).<br>7. The round-total guard (MONEY-1) reads the inserted round's own `order_lines` before `recordPayment`, so issuance inside the accept does not touch it. |
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
