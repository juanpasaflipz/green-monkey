# Menu, tables and ingredients

Area doc for migration 025 (`migrations/025_menu.sql`). It covers how a restaurant
builds and runs its own menu, its floor plan and its ingredient stock, and how the
stock engine behaves under concurrent sales. Status: implemented on `track/menu`
and verified locally (`npm test`, `npm run test:db:menu`, the existing DB suites
and `tests/browser/menu.spec.ts`). Nothing here has been verified on staging.

## Where it lives

| Layer | Files |
| --- | --- |
| Pure rules | `shared/menu.ts` (picker rules, `selectionIssue`, recipe merge, limits, response types), `shared/menu-schema.ts` (strict inputs) |
| Pricing | `quote()` in `shared/domain.ts`, the only pricing function, used by the POS, QR/kiosk, the server and offline sync |
| Server | `server/menu-read.ts` (catalog reads), `server/menu.ts` (categories, products, groups, availability), `server/floor.ts`, `server/stock-items.ts`, `server/stock.ts` (ledger writes), `server/routes/menu.ts` |
| Client | `src/components/ModifierPicker.tsx`, `src/features/menu/*`, `src/i18n/menu.ts` |

## Model

**Product document (`catalog.data`).** Selling, the offline cache and QR/kiosk
read only this compiled, self-contained document:

- name (Spanish required, English defaults to Spanish), `categoryId` plus the
  denormalized `category` label, `categoryPosition` and `position`;
- `kind` (`item` or `combo`), `price` (final consumer price including IVA),
  `openAmount` and `openMax`;
- `available` and `archived`, `station`;
- `groupIds` (ordered links) and the compiled `groups` (each with its `version`,
  rules and choices; choices may carry `cost` and `recipe`);
- `recipe`, `cost` and `version`;
- `fiscal`, reserved for the fiscal wave: menu writes preserve it and never set it.

**Version semantics.** `version` increments when priced or structural content
changes: name, price, open price or ceiling, kind, station, category, linked
groups or their compiled content, recipe, cost, or archive. It does **not** change
for availability, positions or a category rename. Offline sync and order lines
(`productVersion`) therefore treat a version change as "the priced content
changed", and 86-ing an item never sends queued offline sales to review.

**Reusable modifier groups (`modifier_groups`).** A group has a bilingual name,
`min` (0–30), `max` (1–30), `repeat`, and 1–50 choices with non-negative prices.
Choice ids are unique across the restaurant. Saving a group recompiles every
linked product (their versions bump and a `recipe_versions` row is written).
Archiving a group unlinks it from every product; past order lines keep their
snapshot. Archiving is refused with `combo_requires_choice` when the group is the
only required group of an active combo (the confirmation names those combos);
an archived combo is checked again when it is restored. Restoring a group does
not re-link it, and is refused with `invalid_recipe` when a choice recipe names
an ingredient archived meanwhile (restore the ingredient first). Saving a product
also checks the choice recipes of every group it links.

**Group editor.** A blank group starts optional (minimum 0, maximum 1); the
templates set their own rules. A required group with a single priced choice
shows a warning that every sale will pay that extra. Field errors name the
field (choice name, duplicate name, price, cost, recipe, minimum/maximum), and
invalid fields are marked with a red border as well as `aria-invalid`.

**Availability ("86") is live state.** The switches in the product list, the
product editor and the group editor save at once, last write wins, bump the menu
revision and never bump product versions. A product whose required group has no
available choice shows "Agotado" in the POS and cannot be added. Every switch
moves at once and goes back if the save fails. A switch flipped inside an editor
updates the list behind it right away, and a reload that started earlier never
undoes a newer switch. Group cards mark sold-out choices with "Agotado", and a
"Disponibilidad de opciones" list on each card switches a choice in one tap.

**Unsaved edits.** The product, group and ingredient editors ask "¿Descartar los
cambios?" before closing a changed form, whether closed with X, Escape or the
Android back gesture. Duplicar on a changed product and a template picked over
typed choices ask the same way. Availability switches are saved at once and do
not count as unsaved edits. Archiving a product or a table asks first.

**Adding products.** Each category heading has its own add button, which opens
a new product in that category. "Nuevo producto" starts in the category last
saved to. "Guardar y agregar otro" saves a new product and opens another one
with the same category, groups, station and type.

**Menu revision.** Every menu write bumps `menu_state.revision`, and its row lock
serializes all menu writes of a restaurant. The POS polls `GET /menu/revision`
every 60 seconds while selling, and again on focus, and refetches the catalog
when the revision changes (`src/features/menu/freshness.ts`). The first check
after sign-in refetches once, because the catalog shown may predate that first
revision read. Any feature can force a refetch with
`window.dispatchEvent(new Event("gm-menu-refresh"))`. A refetch writes only the
offline catalog cache entry, never the cached session, which belongs to sign-in
and access's heartbeat (contract D15).

**QR and kiosk freshness.** `GET /public/:token/catalog` also returns the menu
revision, read before the catalog. An open QR or kiosk page polls
`GET /public/:token/revision` about every minute (each wait is 50 to 60 seconds,
at random, so pages opened together do not poll in step) and when it becomes
visible again. It refetches the catalog only when the revision moved. It also
refetches after the server refuses an order with a catalog error, and on every
kiosk idle reset. The reset also clears the previous customer's error message.
A hidden page, or one showing its sent order, does not poll, and checks from
focus or visibility changes less than 15 seconds apart are skipped.

**Public request limits.** Diners on a restaurant's guest Wi-Fi share one public
IP, so every limit below is per client IP (IPv6 grouped by /56) and the three
kinds of request never share a budget (`server/public-ordering.ts`). The client
IP is `clientIp(req)` from `server/logging.ts`, the address the request log and
the access and ops limits use: behind Railway's edge it is the diner's network,
never the edge's own address.

| Request | Limit per client IP per minute |
| --- | --- |
| Catalog loads (and receipt reads) | 30 |
| Order submissions | 30, their own, so catalog refetches after a menu change can never refuse an order |
| Revision polls | 240 in total, whatever the token, and within that 20 per link |

The 240-a-minute ceiling is what bounds the database work one client can cause:
each served poll is one short transaction on the pool the POS sells from. A page
polls once a minute, plus focus checks at least 15 seconds apart (five a minute
at worst), so one guest Wi-Fi IP still carries about 50 pages that are refocused
constantly, and several times that many ordinary ones. The per-link budget keys
on the server-signed link id, so one busy table cannot slow another table or the
kiosk. Public routes accept a link only spelled exactly as the server signed
it: the shared token
check (`verify()` in `server/auth.ts`) also accepts other spellings of the same
signature (anything after a second `.`, a trailing `=` or `!`), which are
refused here with 401 before any database work. A refused poll is retried on
the next tick. Refusals answer 429 with `{"error":"rate_limited"}`. Per-link and
per-table limits on stored links are public-ordering's (032).

**QR/kiosk status, stated honestly.** Menu's part of QR and kiosk ordering is
done: optional and required groups are offered through the same picker as the
POS, and money is formatted for es-MX. QR/kiosk ordering is still **not ready
for production**:

- ordering links still expire after 24 hours and cannot be revoked;
- QR and kiosk orders still reach the kitchen unpaid;
- all of this belongs to public-ordering (migration 032, wave 3), which brings
  stored, revocable links and held orders;
- until then, production keeps QR/kiosk ordering off through
  `PUBLIC_ORDERING_ENABLED` (account, migration 031): when it is false,
  `/api/public/*` and link creation answer 404 `public_ordering_disabled`.

**Carts price line by line.** In the POS cart and the QR/kiosk order, each line
is priced on its own by service's `priceCart()` (`shared/service.ts`; QR/kiosk
import it through `src/features/menu/cart.ts`). A product 86'd or archived after
it was added, or a line that no longer prices for another reason, only marks its
own line, with a Quitar button. The rest of the cart keeps its prices, and
nothing can be sent or paid until the line is removed.

- **POS (Vender).** Service's `CartLine` (`src/features/CartLine.tsx`) flags the
  line in place: "No disponible. Quítalo para continuar." for an 86'd or
  archived product, and the error's own message for any other reason (for
  example "El importe supera el máximo permitido para este producto." when an
  open amount is now above the product's maximum). "Quita los productos no
  disponibles para enviar o cobrar." shows under the total, and Enviar a cocina,
  Cobrar and "Enviar como orden nueva" (offered after the check closed
  elsewhere) stay disabled.
- **QR and kiosk.** Menu's `UnavailableLines`
  (`src/features/menu/UnavailableLines.tsx`) lists the flagged lines above the
  order: "Ya no está disponible. Quítalo de la orden." for an 86'd or archived
  product, "Sus opciones cambiaron. Quítalo y vuelve a agregarlo." when a choice
  changed, and the error's own message otherwise. Sending stays disabled.

**Typing amounts and quantities.** Editors accept "1200", "1,200" and
"1,200.50": a comma is read only as a thousands separator in a well-formed
grouping. Any other comma ("25,50") is rejected with a field error; it is never
taken as a decimal point (`decimalInput()` in `src/features/menu/format.ts`).
Amounts with more decimals than the currency has ("12.505", or "1.250" typed
with a point for thousands) are rejected, never rounded. Price, maximum and cost
fields show how the text will be saved ("Se guardará: $1,250.00"); choice prices
and stock quantities show it when the text has a thousands comma.

## Selling with choices, combos and open price

- The picker opens for **any** product with groups or an open price, in the POS
  and in QR/kiosk, so optional extras are always offered (FIT-4).
- Controls follow the rule: a required single choice is a radio group; an
  optional single choice is an exclusive checkbox (it can be undone); several
  choices use checkboxes that lock when the group is full; repeatable groups use
  steppers.
- The line price is the product price (or the open amount) plus each chosen
  choice price times its count. The shown price is computed by the same
  `quote()` the server runs.
- `optionNames` carry the count ("2× Asada"), so kitchen tickets and receipts
  need no change. The QR/kiosk order summary lists them under each line.
- The live price stays in view at the top of the picker while long lists of
  choices scroll.
- The line recipe is the product recipe plus each chosen choice recipe times its
  count, merged into one line per stock item; plain lines keep the product
  recipe byte for byte. The line cost adds choice costs only when the product
  has a cost.
- **Combos** are products of kind `combo` with at least one required group
  (`combo_requires_choice` otherwise). The whole combo goes to the product's
  station; the ticket lists every choice.
- **Open price** ("Varios"): any selling role may ring an amount above zero and
  up to the product's `openMax` (D2). The amount is stored on the line.
  QR/kiosk catalogs never include open-price products, and the server rejects
  `openAmount` on those channels.

## Tables and areas

Areas and tables live under Menú e inventario → Mesas: bulk creation ("Mesa 1 …
12", at most 50, all or nothing on a duplicate name), ordering, seats and archive.
Archived tables disappear from `/tables` and the service options and are rejected
for new dine-in orders, reassignment and QR orders bound to them
(`invalid_table`). A table with an open check cannot be archived
(`table_in_use`). The open-check rule lives in one function,
`tablesWithOpenChecks()` in `server/floor.ts`: `o.check_state <> 'closed'`
(contract D10, swapped in at menu's merge), so a paid dine-in check holds its
table until **Liberar mesa**.

## Ingredients and the stock engine

**Stock items** have a unit (g, kg, ml, l, piezas), a kind (raw or prepared), a
reorder point, an optional par level and an optional opening stock (one
`opening` movement, "Existencia inicial"). The unit locks (`unit_locked`) once
the item has movements or is used in any recipe. An item used by an active recipe
cannot be archived (`stock_in_use`); archived items leave the recipe pickers and
Existencias. An archived item also refuses movements recorded by hand: receipts,
receiving, waste, counts and prep answer `stock_archived` until it is restored.
Sales and void returns of orders recorded earlier still move its balance.
Creating and editing stock items, and recipe or cost changes, need
Pro; archiving does not. A unit change takes the menu lock first, so it cannot
race a menu save that links the item to a recipe written in the old unit.

**History.** Insumos → Movimientos lists each movement with its translated cause
(Venta, Compra recibida, Merma, Conteo físico, Existencia inicial, Anulación,
Preparación), the running balance ("Saldo") and who recorded it. The reason is
shown only for movements a person explains (receipts, waste, counts and prep);
sales, voids and opening stock carry internal reasons that are not displayed.
Dates use the restaurant's time zone.

**Cached balance (DB-4).** `stock_items.on_hand` is maintained by the
`stock_movements_ledger` BEFORE INSERT trigger (SECURITY DEFINER, pinned
`search_path`, EXECUTE revoked from PUBLIC):

1. It rejects a movement for a tenant other than the current `app.tenant_id`.
2. It takes a transaction advisory lock on the movement id, then locks the
   stock row, so movements on one item serialize and a movement id repeated on
   two items waits for the first insert.
3. It skips a movement that repeats an existing `(stock, cause, cause_id)` or
   id. BEFORE triggers fire before `ON CONFLICT` arbitration, so applying the
   delta first would drift the balance on a skipped insert.
4. It adds the quantity to `on_hand`, sets or clears `negative_since`, and
   stores `balance_after` on the movement (null for movements before 025).

The runtime role can neither update `on_hand` or `negative_since` nor set them
on insert (column-level INSERT and UPDATE grants; they start at 0 and null), and
`stock_movements` rejects UPDATE and DELETE even for the table owner. Sales read
the balance from the row they already lock; nothing sums the ledger at sale time.
`stock_items.version` still changes with every movement, so a count started before
a sale is refused (`count_changed`).

**Negative-stock policy (per restaurant, owner or manager).**

| Policy | Behaviour |
| --- | --- |
| `allow` (default for every restaurant) | The sale goes through. The ingredient shows **Negativo** with the date, and the copy says it does not indicate a shortage by itself (INV-04). |
| `block` (opt-in) | Sales, waste and prep that would take an ingredient below zero are refused with `insufficient_stock`. Offline cash already collected is always recorded (`AppendOptions.stockPolicy = "allow"`). |

Receipts, openings, counts, prep outputs and void returns are never blocked.

**Lock order and retry (DB-5).** Every command takes the stock rows it touches in
one `SELECT … ORDER BY id FOR UPDATE` (`lockStockItems`) before any movement:
all lines of an order or round (product and choice recipes merged) and all lines
of a void with stock return. Lock classes follow the wave's global order (order
locks first, stock rows after, menu and floor serialization only on configuration
paths). `tenant()` retries a transaction once on `40P01`/`40001`; a second failure
returns `concurrent_update` (409). Code inside `tenant()` must therefore have no
side effects outside the transaction.

## Permissions and plans

| Capability | Owner | Manager | Cashier/Server | Kitchen | Free | Pro |
| --- | --- | --- | --- | --- | --- | --- |
| Menu, floor and ingredient editors | ✓ | ✓ | – | – | ✓ | ✓ |
| Categories, products, groups, availability, tables, areas | ✓ | ✓ | – | – | ✓ (Free selection required, as for every management mutation) | ✓ |
| Recipe or cost changes, stock item create/edit | ✓ | ✓ | – | – | `pro_required` | ✓ |
| Stock item archive, negative-stock policy | ✓ | ✓ | – | – | ✓ | ✓ |
| Ring an open-price item within its ceiling | ✓ | ✓ | ✓ | – | ✓ | ✓ |
| `GET /menu/revision` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Every mutation is idempotent through `once()` and runs `requireSelling()` after
the replay check, except the policy route, which is configuration recovery.
Limits (`menu_limit`): 100 categories, 2,000 products, 300 groups, 50 choices per
group, 12 groups and 30 choices per product, 30 areas, 300 tables (50 per batch),
2,000 stock items and 30 recipe lines.

## Operator runbook

**Deploy order.** Run migrations as the table owner (025 toggles
`NO FORCE`/`FORCE ROW LEVEL SECURITY` for its backfill and fails loudly
otherwise), then `scripts/grants.sql`, then serve the new revision. Without the
grants, `GET /tables` and every menu route fail; selling keeps working.

**Ledger drift check** (it must return no rows). `stock_items` and
`stock_movements` use FORCE ROW LEVEL SECURITY, so a role that does not bypass
RLS (the table owner without SUPERUSER or BYPASSRLS, which is the Neon migration
role) sees **no rows** unless `app.tenant_id` is set, and the check would pass
whatever the drift. Run it per restaurant in one transaction, and confirm the
first statement counts the restaurant's items:

```sql
begin;
select set_config('app.tenant_id', '<restaurant uuid>', true);
select count(*) from stock_items;           -- must be > 0 for a restaurant with items
select i.tenant_id, i.id, i.on_hand, coalesce(m.total, 0) as ledger
  from stock_items i
  left join (select tenant_id, stock_id, sum(quantity) as total
               from stock_movements group by 1, 2) m
    on m.tenant_id = i.tenant_id and m.stock_id = i.id
 where i.on_hand <> coalesce(m.total, 0);
commit;
```

A role with BYPASSRLS can run the last query once, without `set_config`, for
every restaurant. `tests/menu-db.ts` runs it per fixture restaurant and asserts
that it saw the suite's items.

**After a deploy overlap.** The previous revision may have written products in
the legacy format (no `categoryId` or `groupIds`). Adopt them as the owner; the
function is idempotent and returns how many products it adopted:

```sql
select menu_adopt_legacy_catalog();
```

**Switching the policy.** Use Menú e inventario → Insumos → "Cuando un insumo
llega a cero" (owner or manager). The change is audited as
`stock.policy.changed`.

**Never write `on_hand` by hand.** The balance is defined by the ledger. Correct
stock with a count or a receipt in Existencias so the movement, its reason and its
actor are recorded. A manual UPDATE would be refused for the runtime role and
would make the drift check fail.

## Known deferrals

- Routing combo choices to different stations (a line belongs to one station).
- Kitchen or cashier "86" (the switch is owner/manager only).
- Product photos (no storage provider configured).
- Time-scheduled menus and price reductions on choices (discounts area).
- Substitutions, yields, lots and purchase orders.
- The "Impuestos" section of the product editor: `ProductEditor` exposes a
  `renderFiscal` slot that the fiscal wave fills; no tax logic exists here.

**Fiscal extension points.** Product tax is configured by fiscal's wave-2
wiring (027); menu only leaves the extension points:

- `Product.fiscal` (`shared/domain.ts`). Every menu write keeps a stored value
  and none sets one: editor and legacy saves spread the stored document, group
  recompiles and unlinks spread it too, and availability, category rename and
  reorder, product reorder, archive and restore merge into it. DB test "menu
  writes keep a stored product fiscal value (reserved for 027)" guards this.
- The reserved comment on the strict `productInput` (`shared/menu-schema.ts`).
- The inert `ProductEditor.renderFiscal` slot.
- The `quote()` anchor comment `// fiscal (027): append line tax snapshot here`.

Until fiscal merges, the editor has no Impuestos section and every product uses
the restaurant default.

## Integration notes (menu's merge)

Menu's merge resolved every hand-off it owned:

- Table occupancy follows the service lifecycle (contract D10):
  `tablesWithOpenChecks()` (`server/floor.ts`) and service's `tableOccupancy`
  (`server/checks.ts`) both count checks with `o.check_state <> 'closed'`, so a
  paid dine-in check holds its table until "Liberar mesa". `tableOccupancy`
  skips archived tables and orders by area, then table position.
- Service's `Tables` gets `onEditTables={() => navigate("floor")}` for owners
  and managers ("Editar mesas").
- Existencias history (`src/features/Operations.tsx`) shows the ledger's
  `balance_after` as "Saldo" after each movement (spec §2.10, LD-10 B5), like
  Menú e inventario → Insumos → Movimientos.
- Selling resolves `add()` and the product card to the golden forms, and
  `src/labels.ts` labels the `menu.*`, `floor.*` and `stock.*` audit operations
  (keys `menuOp*` in `src/i18n/menu.ts`).
- Per-line pricing is service's `priceCart` (contract 4.8) everywhere: Selling
  imports it from `shared/service.ts` and flags lines with service's
  `CartLine`; menu's three in-wave Selling hunks are gone. QR/kiosk import the
  same function through `src/features/menu/cart.ts` and keep `UnavailableLines`
  (see "Carts price line by line").
- Public ordering limits key on the real client address, `clientIp(req)` from
  `server/logging.ts`, like the access and ops limits (LD-11). IPv6 clients are
  grouped per /56; the per-link revision budget adds the signed link id.

Done at offline's merge: sync (`/offline/sync`, legacy `/sync`) quotes with
`canOpen = true` in offline's rewrite (D11), so open-price lines recorded
offline are accepted.
