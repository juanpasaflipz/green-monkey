# Data migration and reconciliation

This is an implementation specification. No production exports or migrations have been performed. Source code is not a substitute for the actual schema, data quality, or an approved destination.

## Strategy

Create a complete new schema with versioned migrations. Build independent source adapters for POS Lite/PostgreSQL and Luma/Supabase exports. Load data into a staging/import area, preview mappings/conflicts, then commit a validated batch into the new domain. Preserve lineage on every imported record.

Use a table equivalent to `source_mappings(source_system, source_tenant_id, entity_type, legacy_id, target_id, import_batch_id)` with uniqueness over the source identity. A rerun updates an import status or returns the existing result; it must not duplicate orders, cash, or stock.

Never deduplicate tenants, people, menu items, or recipes by name alone. Restaurant identity matching needs an explicit reviewed mapping. Similar businesses in the two sources can be the same restaurant, two locations, or unrelated businesses.

## Entity mapping

| POS Lite | Luma | Target behavior |
| --- | --- | --- |
| `tenants`, organizations in migrations | `restaurants`, owners | Organization + restaurant; explicit mapping and currency/timezone |
| `employees`, owner credentials, role permissions | Supabase users, `user_roles`, `waiter_credentials` | Accounts/memberships/employees; migrate verified identity links; reset/re-enroll credentials when needed |
| `menu_categories`, `menu_items` | `restaurant_dishes` and dish category fields | One menu catalog; preserve source IDs, price, availability |
| Modifier groups/options and item links | `dish_modifier_groups`, `modifier_groups`, `modifiers` | Shared modifiers with group constraints and price deltas |
| `combo_definitions`, `combo_slots`, discounts | `promotions`, courtesy amounts | Canonical offer/discount records; retain historical snapshots |
| Order service references/fulfillment fields | `restaurant_tables`, `waiter_orders`, waiter names | Tables, waiter attribution, service mode, ordered rounds |
| `orders`, `order_items`, `order_item_modifiers` | JSON items in `waiter_orders` | Normalized orders/lines/modifiers with unchanged legacy payload retained for audit |
| `order_payments`, payment groups, refunds | Order payment_method/status and available split history | Tender/refund ledger; never invent missing allocations |
| `inventory_items`, menu ingredient links, prep/portion ledger | `ingredients`, `recipes`, recipe ingredients/substitutes | Stable ingredient/recipe IDs, units and versions, raw/prepared model |
| Purchase orders/vendors/receipt records | `merchandise_entries` | Suppliers/receiving/stock lots where data exists |
| Counts, `waste_log`, portion ledger | `inventory_snapshots`, `waste_items`, `waste_confirmations` | Opening balances, historical movements, unresolved variances, classified consumption |
| Expenses, recurring expenses | Fixed/variable costs and weekly cost entries | Expenses/schedules with source and accounting basis |
| `manual_sales_batches`, reports, financial actuals | `weekly_entries`, dishes sold, profitability/loss views | Historical facts/adjustments and rebuildable report projections |
| Cash sessions, paid-outs, shifts/payroll | Cash cuts/differences and team records | Cash movements, close records, staff summaries; missing detail stays unknown |
| CFDI records/tokens, billing, credentials | Billing config/invoices/subscriptions | Historical links and explicit provider ownership reconciliation |
| Print jobs, receipts, loyalty records | POS events, print jobs | Historical audit only; do not replay jobs on import. Loyalty members, card progress and the completed cards the chosen rewards policy grants (default "recent"; the rest stay listed to confirm) import through the pos-lite loyalty importer ([Loyalty](LOYALTY.md), "Import Juanberto's pos-lite members"): `scripts/loyalty/poslite-export.sql`, then Configuración › Club de lealtad › Importar socios de POS Lite, before the club is switched on |

Names for Luma base entities come from code references; the ZIP does not define the complete base schema or all views. Inspect schema metadata or documented export columns before finalizing adapters.

## Required transformations

1. Resolve source restaurant identities and decide organization/location scope before importing business records.
2. Map IDs and foreign keys; flag orphaned links. Preserve legitimate duplicate names. Create explicit unit conversion mappings; never equate kg, g, pieces, boxes, and prepared portions by guesswork.
3. Translate source statuses into independent fulfillment and payment state. Preserve ambiguous historic status as an import exception; `served` does not necessarily mean paid, and `refunded` does not prove a provider refund exists.
4. Convert money with documented decimal-to-minor-unit rounding. Preserve original currency, tax/price snapshots where available, provider references, and source totals. Mark missing tax or split detail unknown rather than reconstructing it from today's prices.
5. Convert timestamps using source timezone knowledge. Do not interpret date-only weekly records as UTC event instants. Record source precision and restaurant business calendar.
6. Link Luma recipes to menu IDs through a reviewed matching screen. The old name-based relation can generate candidates, not final links. Missing matches remain visible.
7. Separate Luma `waste_items.loss_type='sold'` from actual waste. Identify stock balance cutoffs so historic sales are not deducted again after opening balances are loaded.
8. Preserve subscriptions/provider IDs without creating a second active subscription. Do not assume platform accounts or encrypted credentials can be copied across applications. Reconnect credentials through approved setup when necessary.

## Prevent double-counted revenue

POS Lite orders, Luma paid orders, weekly entries, manual sales, CSV imports, and delivery settlements can overlap. Create a coverage map by source/restaurant/period/channel:

- Detailed imported transactions are the financial source of truth for their coverage.
- An overlapping weekly summary is a reconciliation control total, not additional revenue.
- A genuinely separate manual/legacy summary becomes an explicitly labeled historical adjustment only after its scope is established.
- Delivery settlement net receipts are not a second sale; preserve commissions/fees and reconcile to marketplace order gross value when supported.
- Refunds retain their own dates and links. Never deduct the same refund through both a net summary and imported refund rows.

Require review when overlap cannot be established confidently. File hashes, source row IDs, external order IDs, and period coverage support deduplication; a matching amount/date alone is insufficient.

## Dry-run and cutover gates

An import dry-run reports row counts by entity/tenant/status, original/target totals by currency and business day, duplicates, orphaned relationships, mapping decisions, stock balance/unit differences, unknown historical fields, and rejected rows with reasons.

Verify:

- Gross/discount/refund/tax/tip/net totals reconcile under the documented source basis.
- Tender sums, cash sessions, and unpaid balances match the source's available detail.
- Inventory opening balance plus post-cutoff movements reconciles; unresolved variance is explicit.
- Recipe/menu links are reviewed; historical cost/price values are not replaced with current ones.
- Rerunning the same batch changes no accepted totals or entity counts.
- Import emits no kitchen, payment, stock-consumption, invoice, subscription, print, SMS, or email side effects.

Rehearse against isolated copies or sanitized exports. Establish a migration window or incremental watermark/change-capture plan, freeze source writes only when specifically authorized, import the final delta, and reconcile before routing traffic. Record cutover time, source/target IDs, counts, operator sign-off, and rollback conditions.

If the new system accepts live transactions after cutover, rollback must account for those transactions; merely restoring an older database would lose them. Preserve an export/reconciliation path and determine which system owns each transaction during any overlap.

## Deliverables from the implementing agent

Versioned schema, source adapters, preview/mapping UI or reviewable reports, dry-run command, idempotent import command, safety checks for destination identity, reconciliation report, exception report, sample sanitized fixture, rollback/cutover runbook, and integration tests. Never embed actual production URLs or exports in Git.

## Pagos (payments 037): configuration from pos-lite and the cutover steps

No historical payment is migrated: only configuration moves, by hand, through Configuración → «Pagos con tarjeta y plataformas». **Secrets are never copied**: the owner enters them again. The read-only queries below run against pos-lite with the restaurant's tenant id (`$1`); their answers are written down, not imported.

1. **MP terminals:** `select mp_default_terminal_id, mp_default_kiosk_terminal_id from tenants where id = $1`. After connecting Mercado Pago, **Buscar terminales** must list these devices; add each as an integrated terminal (for example «MP Caja») and check that it shows «Integrado (PDV)».
2. **Clip reader and fee:** `select key, value from tenant_credentials where tenant_id = $1 and service = 'clip' and key in ('default_terminal_id','fee_percent')` (read the two non-secret keys only). After connecting Clip, **Buscar lectores** lists the reader; add it with the fee (`fee_percent`, entered as a percentage).
3. **Bank terminals:** `select name, fee_percent, active from external_terminals where tenant_id = $1`: the active ones become manual terminals with their fee.
4. **Platform commissions:** `select name, display_name, commission_percent, active from delivery_platforms where tenant_id = $1`: «Plataformas de entrega» (Uber Eats, Rappi, DiDi Food), enabled only for the platforms the restaurant uses.
5. **Credentials:** the owner's own Mercado Pago application (Tus integraciones → Credenciales de producción: access token and the Webhooks secret) and Clip's API key and secret (dashboard.clip.mx → Desarrolladores). pos-lite connected MP through its own OAuth application, so its grant cannot be reused.

**Día de cambio, payments steps** (critic R43; their place in the day is the single runbook, [«Día de cambio»](#día-de-cambio-cutover-runbook-critic-r43) below, steps 1, 3, 5, 6 and 10):

- Before go-live (R43 steps 3, 5 and 6):
  1. Stop charging from pos-lite. Two integrations must never drive one PDV terminal (MP answers 2205 «queued intent»).
  2. Cancel any pending intent on each MP device (on the device, or from pos-lite's last screen).
  3. Configuración: manual terminals and fees, platforms and commissions, connect MP and Clip, paste the MP notification URL (shown once; event **Órdenes**), **Buscar terminales** (MP in PDV mode), add the integrated terminals, set each register's default terminal.
  4. One low-value real charge per terminal (**Cobro de prueba**: at least $5.00 on MP) with «Enviar a {terminal}»; cancel it on the terminal or refund it in the provider's app, and check that the charge and its outcome show in Cobros en terminal and Excepciones as expected.
- After go-live (R43 step 10):
  1. Revoke pos-lite's MP OAuth grant (Mercado Pago account → Seguridad → Aplicaciones conectadas).
  2. Rotate the Clip keys (pos-lite stored them in plain text), then **Reemplazar credenciales** in Configuración with the new ones.
  3. Delete pos-lite's `tenant_credentials` rows for MP and Clip.
- Platform orders keep being re-rung from the tablets, now paid with **Plataforma** («Pagado por plataforma»); pos-lite's settlement CSV import stays reconciliation-only.


## Día de cambio (cutover runbook, critic R43)

The one runbook for the day Juanberto's moves from pos-lite to Green Monkey. It puts payments'
(«Pagos» above), loyalty's ([LOYALTY.md](LOYALTY.md) "Runbooks") and the kiosk's
([KIOSK.md](KIOSK.md) §4, §7) steps in their order; those documents keep the details. PILOT_SOP
points here. Who: the owner, with the operator; the cashier only where a step says so.

**Before the day** ([LAUNCH_HANDOFF.md §4.1](LAUNCH_HANDOFF.md#41-before-day-one) and §4.3): the
menu re-keyed and price-checked, staff and PINs, devices paired, the printer tests and the outage
drill passed, the money defaults written down, the CFDI ranges agreed with the accountant, the
club's legal texts published, and the integrated charging device rehearsal (critic R44) passed on
staging. For the kiosk (steps 1.2, 7.1, 7.4 and 7.5 depend on it), every precondition of
[LAUNCH_HANDOFF.md](LAUNCH_HANDOFF.md) 1.16a and 1.21 met in production: `PAYMENTS_PROVIDERS`
deployed on the production worker; the production media bucket set (`MEDIA_STORE=r2` and the
four `MEDIA_R2_*` values on web); R44b, the combined Wave 4 rehearsal, passed; and the reviewed
`railway.ts` switch-on deployed, with production's `/capabilities` reporting `kioskSelfCheckout`
and `menuPhotos` enabled. If any is missing, keep the pos-lite kiosk running: skip step 1.2 and
postpone step 7 to another day (the rest of the cutover does not depend on it). Keep a **cutover
log** (a private document, never in Git): time, step, who, and what
each check showed. Choose a quiet hour; pos-lite stays reachable read-only afterwards
(LAUNCH_HANDOFF §4.2).

### 1. Stop pos-lite

1. **Counter charging.** No sale, charge or refund in pos-lite from now on. Two integrations must
   never drive one Mercado Pago PDV terminal (MP answers 2205 «queued intent»).
2. **The pos-lite kiosk APK.** Close it on the tablet and keep the tablet off the kiosk link. Never
   run the pos-lite kiosk in parallel with Green Monkey's: two kiosks would sell from two menus into
   two drawers and two kitchen queues.
3. **Club stamping.** No manual stamps or redemptions in pos-lite from now on; a completed card
   shown from here to step 8 is honored as an audited discount (LAUNCH_HANDOFF §4.2).
Check: pos-lite's Órdenes shows no order created after the stop time; log the time.

### 2. Settle pending pos-lite kiosk orders

In pos-lite, settle every kiosk order still open (`draft_kiosk`, `fired_unpaid`): charge and close
it, or cancel it with the guest. Check: pos-lite lists no open kiosk order; log the count settled.

### 3. Cancel pending intents on the Mercado Pago devices

On each MP Point (or from pos-lite's last screen) cancel any pending payment intent, so the first
Green Monkey charge is not refused as queued. Check: each terminal shows its idle screen.

### 4. Loyalty members: export, preview, commit, verify

In this order (LOYALTY.md "Runbooks"; PILOT_SOP §9):

1. Configuración › Club de lealtad: save the club's settings first (stamps per card as in
   pos-lite, the reward and its cap), because balances convert at the saved stamps per card.
2. Run `scripts/loyalty/poslite-export.sql` with psql against pos-lite as its admin login
   (read-only transaction; `-v tenant=<pos-lite tenant> -v target=<green-monkey restaurant>`).
   Keep the file in a private folder (mode 600).
3. «Importar socios de POS Lite»: upload it, confirm the restaurant, choose the rewards policy
   (default "recent"), print «Imprimir listas para la bitácora» into the cutover log, then
   **Importar** (a failed page shows Reintentar; committed pages replay).
4. Require «Verificado»; spot-check 10 members against pos-lite's Loyalty y CRM screen (the active
   card's dots against Tarjeta). Log it and delete the export file.

The club stays off until step 8.

### 5. Payments configuration

Configuración › «Pagos con tarjeta y plataformas» («Pagos» above; PILOT_SOP §8):

1. Manual terminals with their fees; delivery platforms with their commissions, switched on only
   for the platforms the restaurant uses, and their price lists where they differ.
2. Connect Mercado Pago (the owner's application: access token and webhook secret) and Clip (API
   key and secret); paste the MP notification URL (shown once; event **Órdenes**).
3. **Buscar terminales** (the MP Point in PDV mode; restart it after a mode change) and **Buscar
   lectores** (Clip); add the integrated terminals with their fees.
4. Each register tablet's default terminal.

Check: «Pagos con tarjeta y plataformas» shows both providers connected and each integrated
terminal «Integrado (PDV)».

### 6. One low-value real charge per terminal

On each terminal, integrated and manual, a real low-value sale (**Cobro de prueba**: at least
$5.00 on MP) with «Enviar a {terminal}», then cancel it on the terminal or refund it in the
provider's app. Check that the charge and its outcome show in Cobros en terminal and Excepciones as
expected; log each terminal.

### 7. Kiosk

KIOSK.md §4 and PILOT_SOP §10:

1. On the tablet: uninstall the pos-lite kiosk APK, update Chrome, screen lock with a PIN, app
   pinning with «Solicitar PIN para quitar la fijación», battery protection.
2. Configuración › Pedidos en línea: **Agregar kiosco** (the link and its station); on the station,
   the **Terminal** (an integrated reader) and the **Caja que recibe los cobros**; «Cobro en el
   kiosco»; «Preguntar para aquí o para llevar»; «Sugerencias».
3. **Vincular tableta**: type the 8-digit code on the tablet (long-press the restaurant name);
   «Kiosco vinculado» appears. Tap «Toca para ordenar» once and pin Chrome.
4. **Photos**: the operator downloads pos-lite's product photos and writes the
   `gm-menu-media-v1` manifest (KIOSK.md §7); the owner runs Menú e inventario › **Importar
   fotos**, reviews the mapping and imports; the report lists what was not imported (re-running
   is safe). Uploads are capped at 30 per restaurant per 10 minutes: the import waits and
   continues on its own (about 20 minutes for 52 photos); one by one in the product editor, the
   31st within 10 minutes is refused until the window passes. Without the R2 media bucket the
   product editor shows «Fotos no configuradas en este servidor» instead of «Subir foto».
   Descriptions are typed in the product editor. Curated suggestions: per product
   («Sugerir con este producto») and for the cart (Configuración › Kiosco de autoservicio).
5. Field checks (LAUNCH_HANDOFF, kiosk §8.4): one card sale, one declined card cancelled on the
   reader, one «Pagar en caja», the idle reset, and a tablet restart (re-pin). Log each.

### 8. Club settings, attestation, enable

Configuración › Club de lealtad: check the settings, the attestation, then turn the club on
(PILOT_SOP §9). «Club en el kiosco» on the kiosk settings when the restaurant wants it.

### 9. Go live

The first Green Monkey sale at the counter and the first kiosk order; log their numbers and times.
Watch Cobros en terminal and the inbox for the first hour.

### 10. After go-live (the same week)

1. Revoke pos-lite's MP OAuth grant (Mercado Pago account → Seguridad → Aplicaciones conectadas).
2. Rotate the Clip keys (pos-lite stored them in plain text), then **Reemplazar credenciales** in
   Configuración with the new ones.
3. Delete pos-lite's `tenant_credentials` rows for MP and Clip.
4. The final pos-lite wallet-pass update (the members now live in Green Monkey), then delete or
   anonymise that tenant's `loyalty_customers` rows in pos-lite and log it.
5. Delete the export files (members, photos manifest) from every machine they touched.
6. Post the counter sign (the club and the kiosk now live in Green Monkey).
