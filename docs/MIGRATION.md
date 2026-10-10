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

**Día de cambio, payments steps** (critic R43; the kiosk track folds these into the single cutover runbook, with a pointer from PILOT_SOP):

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

One runbook for the day Juanberto's moves from pos-lite to Green Monkey. Payments' and loyalty's
detailed steps are in their sections above; this is the order. PILOT_SOP §10 points here.

1. **Stop pos-lite**: counter charging, the kiosk APK and club stamping. Never run the pos-lite kiosk
   in parallel with Green Monkey's (two kiosks would sell from two menus and two drawers).
2. **Settle pending pos-lite kiosk orders** (`draft_kiosk`, `fired_unpaid`) in pos-lite before
   switching.
3. **Cancel pending intents** on each Mercado Pago device.
4. **Loyalty**: export, preview and commit the members, then «Verificado» and the 10-member spot
   check (LOYALTY.md).
5. **Payments configuration**: manual terminals, platforms, Mercado Pago and Clip credentials, the
   webhook URL, «Buscar terminales» (MP in PDV mode), device defaults (payments steps above).
6. **One low-value real charge per terminal**, then cancel or refund it.
7. **Kiosk** (KIOSK.md §4): uninstall the APK; add the kiosk link and its station (terminal and
   receiving till); pair the tablet; the field checks (LAUNCH_HANDOFF); set «Cobro en el kiosco».
   Photos: the operator downloads pos-lite's product photos and writes the `gm-menu-media-v1`
   manifest (KIOSK.md §7); the owner runs **Importar fotos**, reviews the mapping and imports
   (critic R42/Q7; re-running it is safe). Descriptions are typed in the product editor. Curated
   suggestions per product
   and for the cart (pos-lite's last curated set was Orden Papas, Brownie con crema, Refresco,
   Cerveza and CHELA 3X2).
8. **Club settings**: attestation, enable.
9. **Go live.**
10. **After go-live**: revoke pos-lite's MP OAuth grant; rotate the Clip keys; delete pos-lite's
    `tenant_credentials` for MP and Clip; the final pos-lite wallet-pass update; delete the export
    files; post the counter sign.
