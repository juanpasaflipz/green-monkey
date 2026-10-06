# Discounts, refunds and drawer controls

Status on October 5, 2026: implemented on `track/discounts` (migration 028) and
verified locally with `npm test` (`tests/discounts.test.ts`,
`tests/service-receipt.test.ts`), `npm run test:db:discounts` and
`tests/browser/discounts.spec.ts`. Not staged. Fiscal 027 is built in parallel:
until it merges, the refund tax hook and the "ticket issued" guard are no-op
shims (`server/compat/discounts-fiscal.ts`), and the six DB checks that need
fiscal tickets (DB 7's ticket, DB 8's ticket case, DB 13, 21, 37 and 38) report
SKIP. No card provider, terminal or printer was used: card refunds are recorded
after the external terminal did them, and the refund slip was checked in
Chromium print emulation only.

This area makes money corrections correct and controlled:

- line and check **discounts** (percentage or amount) and **courtesies/comps**
  (100 %), with reason codes, per-role limits and manager approval, stored as
  immutable per-unit allocations;
- **refunds** by item (fully paid units) or by amount, for cash and for
  external-terminal (card) tenders, with optional restock and a kitchen
  cancellation for units not served yet;
- **drawer controls**: cash and terminal money apart, card tips that never
  inflate cash, **blind counts**, closer attribution, manager review of
  differences and immutable closed drawers.

Audit findings addressed: MON-4, FIT-8, FIT-10, MON-9 (and the drawer part of
DB-9, the closer attribution of GAP-3, the receipt rows of MON-7).

## Concepts and invariants

- **Unit.** A line of quantity *q* has payable units `0..q-1`; unit *u* is worth
  `allocate(line.total, [1…1])[u]`. Voids name units (`line_voids.units`),
  payments name units (`tender_allocations`), and now discounts name units
  (`discount_allocations`) and item refunds name units (`refund_units`).
- **Unit due** = gross − active discount − paid. Voided units are not payable.
- **Order identity** (checked at commit for every discounted order, trigger 7c):
  `orders.total + orders.discount = Σ line totals − Σ line_voids.amount`,
  `orders.discount = Σ active allocations on non-voided units` and
  `Σ tenders ≤ orders.total`. `orders.total` stays "what the customer pays";
  `line_voids.amount` keeps the gross of the voided units.
- **Discounts touch only unpaid money of sent items** on an open check without a
  fiscal ticket. After the ticket a check is corrected only by refunds.
- **Refunds never change** `orders.total`, `orders.discount` or the check state.
  The sale stands; the refund is its own immutable money movement with its own
  business date.
- **Amount refunds need a paid check** (`Σ tenders ≥ orders.total`), otherwise
  `refund_balance_due` (409). Item refunds are allowed in every check state:
  they cover only fully paid units, and a paid unit can never be voided.
- **A discount that closes a takeaway or tableless check is final.** Its balance
  reaches zero, `refreshCheckState` closes it (`settled`) and closed checks are
  never reopened: removing it answers `discount_not_reversible`. A dine-in table
  check becomes "paid" instead and stays correctable until it is released.

## Discounts and courtesies

Entry points (disabled offline with the visible hint "Los descuentos requieren
conexión.", linked to the button with `aria-describedby`): Vender's
**Descuento** button next to **Guardar borrador** (it first offers "Enviar
productos primero" when the cart has unsent lines; a send error shows in that
confirmation), the Órdenes row action, and Detalle de orden (whole check, or
**Descuento** under a line; offline the per-line links hide and the action stays
visible, disabled). A cart blocked by an unavailable item disables Vender's
button too, with Selling's own warning as the reason. Lines are named with their
option names ("Taco de asada (Salsa verde, Queso)") wherever a discount or a
refund names them: the dialogs, Detalle de orden, Vender's check block, the
receipt rows and the refund slip.

The dialog chooses **Toda la cuenta** or **Un producto** (and how many units),
the type (Porcentaje with 5/10/15/20/50 % chips or up to two decimals, Importe
fijo, Cortesía 100 %), a reason (required) and a note (required for "Otro").
The preview runs the server's `planDiscount`, so "Descuento: −$13.50 · Saldo
nuevo: $121.50" is what gets recorded.

Rules (server-enforced; `shared/discounts.ts`):

1. A check discount targets every unit with a balance due, in `(round, line)`
   and unit order; one active check discount per order. A line discount takes
   the lowest-index units of that line that are due and carry no other line
   discount (no stacking).
2. `base = Σ due`. Percentage: `discount(base, bps)` (half up, the same formula
   as the table's CHECK). Fixed amount ≤ base (`discount_exceeds_due`). Comp =
   base. Zero → `discount_too_small`; no targets → `discount_nothing_due`.
3. Allocation: `allocate(amount, dues)`. **Lemma:** with `amount ≤ Σ dues`,
   every part is ≤ its unit's due (each floor share is below its weight unless
   amount = Σ, and the +1 remainders never push a part past its weight), and the
   parts sum to the amount exactly.
4. A check discount applies after line discounts, to what is still due.
5. One transaction: discount row, allocations, `total −= amount`,
   `discount += amount`, `version + 1`, audit `discount.applied`, then
   `refreshCheckState` (a zero balance settles the check; with fiscal 027 the
   ticket is issued in the same transaction when the total is above 0).
6. Paid units are never discounted ("Lo ya cobrado no se descuenta; usa un
   reembolso.").

**Removing a discount** ("Quitar descuento", Detalle de orden and the Vender
check block): allowed while the check is open (or "paid" at a table), with no
fiscal ticket, no payment on any of its units and no later active discount on
them (last in, first out; an overlap on a unit voided since does not count, on
the server and in the client's `discountRemovable` alike); otherwise
`discount_not_reversible`. A reason (3–300 characters) is required. The reversal
restores the active amount and is the discount's single, immutable reversal. On
`stale_order` the dialog reloads the check, hands it to the screen behind it,
keeps the reason and its operation id, and asks to confirm again.

**Voids of discounted units** pick undiscounted units first, then the highest
index. The balance drops by the unit's net and its discount is released
("Liberado por anulación"); `line_voids.amount` stays gross. The void dialog
previews the net.

### Limits, approval and step-up (LD-2, LD-15 Q2)

| Who | Within their limit | Over their limit |
| --- | --- | --- |
| Owner, manager | no limit | — |
| Cashier, server | allowed; their own recent PIN on a terminal | a manager approves with their PIN in the dialog |

- Limits are per role: "Hasta (%)" **and** "Y hasta (importe)" must both hold
  (a comp counts as 100 %). Default 0 % / $0: every staff discount needs a
  manager until the owner raises it.
- **One PIN.** A manager's PIN typed in the dialog is the authorization; the
  cashier is not asked for their own step-up as well. `approval_required` is
  answered before any step-up, so staff over their limit are asked for the
  manager's PIN only.
- **A manager or owner acting alone** gets the standard step-up ("Confirma con
  tu PIN", only when their PIN is older than the window on a shared terminal)
  and is recorded as the approver. Detalle, the refund slip and reports show
  "{actor} · autorizó {approver}" even when both are the same person (LD-16 L3).
- Removing a discount and every refund always need an approver: staff a
  manager's PIN, managers themselves (step-up).
- Approvals are verified in their own transaction (failed PINs count even when
  the command is refused), per device, with the per-session ceiling of 10
  rejected approvals a minute (`too_many_attempts`).

## Reason codes

| Discount code | es | en |
| --- | --- | --- |
| `courtesy` | Cortesía de la casa | On the house |
| `complaint` | Queja o error del servicio | Complaint or service error |
| `quality` | Producto con defecto | Item quality issue |
| `staff_meal` | Consumo de personal | Staff meal |
| `senior_inapam` | Adulto mayor (INAPAM) | Senior citizen (INAPAM) |
| `promotion` | Promoción | Promotion |
| `regular_customer` | Cliente frecuente | Regular customer |
| `other` | Otro (explica en la nota) | Other (explain in the note) |

| Refund code | es | en |
| --- | --- | --- |
| `customer_cancelled` | El cliente canceló | Customer cancelled |
| `quality` | Producto con defecto o queja | Item quality or complaint |
| `wrong_item` | Producto equivocado | Wrong item |
| `long_wait` | Demora en el servicio | Long wait |
| `charge_error` | Cobro equivocado | Charging error |
| `duplicate_terminal_charge` | Cobro duplicado en terminal | Duplicate terminal charge |
| `other` | Otro (explica en la nota) | Other (explain in the note) |

The same code reads differently per kind (`quality`); reports look labels up by
(kind, code) through `DISCOUNT_REASON_LABELS` and `REFUND_REASON_LABELS`
(`src/features/discounts/format.ts`). INAPAM discounts are voluntary for
businesses without an agreement with the institute; the code only lets a
restaurant that offers one report it. Refunds recorded before 028 show as
reason "Otro" with their original text.

## Refunds

**Who:** any operator; cashiers and servers with a manager's approval (before
028 only managers refunded).

**Por productos** (default when a line has refundable units): one row per line
with its refundable units ("{name} · {amount} c/u"), the breakdown by original
tender (cash and/or "Terminal · pago original Ref. …"), a kitchen notice when a
unit's round is not served, and the stock choice (no restock by default; a
warning when the kitchen already saw or prepared it). Units are refundable when
fully paid and not refunded yet. The server takes the highest-index units and
returns each unit in full to every tender that paid it (`planItemRefund`).

**Por importe** (only on a paid check): one tender, up to what it has left
(tips are never refunded here). While a balance is due the tab is hidden and the
dialog says "El reembolso por importe se habilita cuando la cuenta está pagada."

**Terminal (card) portions** are recorded, never moved: the operator refunds on
the terminal first, then types its reference and confirms ("Confirmo que la
terminal aprobó el reembolso de …"). Missing → `refund_external_confirmation`.
Card money never touches drawer cash. **Cash portions** leave this device's
open drawer (`drawer_required` otherwise; a terminal-only refund needs none).
The entry points are disabled offline with the visible hint "Los reembolsos
requieren conexión.". The result view ("Reembolso registrado: …", **Imprimir
comprobante**, **Listo**) refreshes the screen behind it however it is left
(Listo, the close button or Escape), so Órdenes and Detalle de orden never keep
showing the pre-refund check after money moved.

Server rules: the client sends the refund state its preview was built on: the
order's refunded total (`expectedRefunded`, both modes) and, for item refunds,
the previewed total and the units it refunds per line (`expectedAmount`,
`expectedUnits`). Under the order lock the server answers `refund_changed` (409)
when any of them differs, and the dialog reloads the check and keeps the inputs.
Comparing the units matters because identical units cost the same: when two
devices refund the same cold taco, the second plan would move to the next taco
at the same price, so a total-only check would refund twice. Caps per tender (Σ refunds ≤ tender
amount) and per unit and tender (Σ unit refunds ≤ allocation), enforced in code
under the tender keys and again by triggers 7e/7f; method must match the tender.

**Kitchen cancellation.** Refunded units of a round that is not served
(`not_started`, `active`, `ready`, or `offline_review`, LD-15 Q5) get
`kitchen_ack_required`. The KDS shows them as "Reembolsado · no preparar" until
the station presses **Enterado de la cancelación** (the void machinery), and
the round cannot be marked served before that (SVC-K6). A fully refunded,
acknowledged round completes. Served rounds get no notice. The KDS, recall,
clear-stale, the offline review lane and the legacy `GET /kitchen` read the
`kitchen_removals` view (voids plus refund cancellations); order totals and
states keep reading `line_voids`, because refunded units are still sold.
Reprinted comandas (`ticketsFromOrderRound`) still show refund-cancelled units.

**Restock** returns `recipe × units` once per refund line with stock cause
`refund` (policy `allow`; the movement's causal key is the refund line id, so a
retry never returns stock twice).

**Business date.** Computed once per refund command and stored on
`refund_batches.business_date`; fiscal dates its IVA adjustments with it and
reports buckets the refund by it, so all three agree near the cutoff (D16).

**Legacy `POST /api/refunds`** (old bundles during a deploy): unchanged body,
fingerprint and step-up; it now locks the order before the tender key, refuses
`refund_balance_due` and writes a batch like every post-028 refund. Only
pre-028 refunds are batchless.

## Refund slip ("Comprobante de reembolso")

Printed from the refund result through `printDocument` at 58/80 mm. It is a
customer-facing comprobante, so it always prints in Spanish, whatever the UI
language: restaurant, "COMPROBANTE DE REEMBOLSO", order and time, the original
ticket folio (with fiscal 027), each refunded line, cash and terminal parts with
the terminal refund reference, "Total reembolsado", "Importe sin IVA … · IVA
reembolsado …" (fiscal's adjustment, by complement extraction), the reason and
note, "Registró {actor} · autorizó {approver}", a signature line and "Este
comprobante no es una factura (CFDI)." LIVA art. 7 asks for the restitution to
show the amount and the tax apart and to identify the original comprobante; for
a público-en-general ticket this slip carries that, for an invoiced sale the
formal document is cfdi's CFDI de egreso (030). Without fiscal data (non-MXN or
before 027) the folio and IVA lines are left out. Internal documents (the drawer
close result) keep the device language.

## Drawer (Caja)

- Header: "Caja abierta", who opened it and when, the opening float, payments.
- **Efectivo** (roles allowed to see expected cash): cash sales, cash tips,
  cash refunds, paid-outs and **Efectivo esperado** = opening + cash sales and
  tips − cash refunds + movements, plus the cash movements. Only cash refunds
  reduce cash (before 028 every refund did; all of them were cash).
- Other roles see "Corte ciego: el efectivo esperado se muestra a un
  responsable después del conteo." **The server does not send** expected cash,
  cash tenders, cash refunds or movements to them (`cashSummary` redaction);
  `id`, `opened_at` and `closed_at` stay for offline.
- **Terminal externa** (every operator): terminal payments, terminal tips,
  terminal refunds and the net, to compare with the terminal's own batch
  report. Card tips never count as cash and need no "Efectivo recibido".
- **Registrar salida** (managers) and **Cerrar caja** (roles allowed to close).

**Close** (`DrawerCloseDialog`): count → confirm → result, one operation id per
dialog.

1. Count: "Efectivo contado", "Total del corte de la terminal (opcional)" and an
   explanation. In blind mode (the default) nothing reveals expected cash and no
   explanation is required, so retrying cannot probe the expected amount. In
   visible mode (blind off and a role that sees expected cash) the dialog shows
   expected cash and requires an explanation for a difference
   (`reason_required`).
2. Confirm: "¿Cerrar la caja con {amount} contados? Después no se puede
   cambiar." The offline pending-sales guard runs here.
3. Result: roles that see expected cash get expected, counted, the difference
   (Sobrante / Faltante / Cuadra) and the terminal figures; a manager can
   **Explicar diferencia** at once. Others get "Corte registrado. Un responsable
   revisará el resultado."

The close stores `closed_by`, `count_mode`, `external_expected` (terminal net at
close) and `external_reported`. Terminal payments recorded after the close
(late offline sync) are shown apart in the history. **Who closes:** owner and
manager always; cashier and server only when enabled (`cash_close_not_allowed`).

**Review.** Historial de cajas marks "Diferencia por revisar" on closed drawers
whose count differs and has no review; **Revisar diferencia** (managers) records
one immutable explanation per drawer (`cash_review_exists` for a second). The
history also shows "Cerró {name}", "Corte ciego", the terminal figures and the
refunds and paid-outs of each drawer.

Closed drawers are immutable for every role (trigger), and drawers are never
deleted.

## Controls (Configuración → "Descuentos y corte de caja")

| Control | Default |
| --- | --- |
| Cajero / Mesero: "Hasta (%)" and "Y hasta (importe por descuento)" | 0 % / $0 |
| "Corte ciego: el conteo se captura sin ver el efectivo esperado" | on |
| "Pueden ver el efectivo esperado durante el turno": Gerente, Cajero, Mesero | Gerente (the owner always) |
| "Pueden cerrar caja (además de gerentes)": Cajero, Mesero | none |

The owner edits (step-up on terminals); managers read; other roles never see the
panel. "0", "0.0" and "0.00" all mean 0 %. Saving checks the loaded version
(`money_controls_changed`: the form reloads the current values and says so, and
the next save works), is audited
`discount.controls.saved {before, after}` and does not change
`restaurants.config_version`.

## Data model (migration 028)

| Table / object | Purpose | Writes |
| --- | --- | --- |
| `money_controls` | one row per restaurant (absent = defaults) | owner, versioned |
| `discounts` | one row per discount; one reversal | INSERT; UPDATE of the reversal columns only (trigger) |
| `discount_allocations` | per (discount, line, unit) | INSERT only |
| `refund_batches` | one per refund command: mode, cash/terminal split, reason, approver, business date | INSERT only |
| `refunds` (existing) | one money row per tender; now `method`, `external_reference`, `batch_id`, `order_id` | INSERT only |
| `refund_lines` | per (batch, line): units, kitchen state, restock | INSERT; one kitchen acknowledgement |
| `refund_units` | per (refund row, line, unit): which tender paid what is returned | INSERT only |
| `cash_sessions` (existing) | now `closed_by`, `count_mode`, `external_expected`, `external_reported` | immutable once closed |
| `cash_count_reviews` | one review per drawer | INSERT only |
| `kitchen_removals` (view) | voided units plus refunded units of unserved rounds | read |

Every new table has FORCE row-level security (`tenant_scope`), composite tenant
foreign keys and no DELETE grant. Triggers: immutability (`money_immutable`,
also on `refunds`; `cash_sessions_closed_immutable` refuses updates of closed
drawers and any delete, and `cash_sessions_no_truncate` any truncate — LD-15
Q4 (A)); 7a discount allocations within the unit
due; 7b allocations add up (deferred); 7c discounted orders reconcile (deferred,
only when a discount is or was present); 7d payment allocations within a
discounted unit's due; 7e refund method and tender cap; 7f unit refund cap; 7g
refund batches reconcile (deferred). `refunds_tender` (024) and the new
`refund_tender_identity` overlap; the unique one is the composite foreign key
target. Test databases clean up by disabling the named triggers inside one
transaction (LD-12 pattern, FK order of LD-16 L5).

**Deploy overlap.** The previous revision's cash refunds pass every check
(`method` defaults to cash, same tender key). It cannot create discounts; on a
discounted order its void and item-split payment fail at commit (7c/7d) instead
of corrupting totals. Its bundles also get `refund_balance_due` on a partially
paid check, untranslated until the service worker updates.

## Fiscal interaction

- **Discounts reduce the taxable base.** Prices are tax-inclusive; an allocation
  belongs to its unit's line and therefore to the line's tax category.
  `discountsByLine(tx, orderId)` gives fiscal the active allocations per line;
  fiscal extracts IVA from the net gross of each category (Anexo 20: Base =
  Importe − Descuento). Persisted ticket data always uses it; fiscal's
  `allocateOrderDiscount` is for previews and tests only.
- **Check discounts across categories, to the centavo.** Taco al pastor ×2
  (iva16, 4500 each) and café en grano (iva0, 12000), 10 % on the check:
  `discount(21000, 1000) = 2100`, `allocate(2100, [4500, 4500, 12000]) = 450,
  450, 1200`. iva16 gross 9000 − 900 = 8100 → IVA 1117, base 6983 (base before
  discount 7759, discount base 776); iva0 10800, IVA 0; ticket 18900 =
  `orders.total`. No unallocated discount ever arises (unit test 16 checks it on
  random orders).
- **Comps.** A 100 % discount leaves the unit's net at 0: no IVA (fiscal D7).
  Gifts are outside IVA only when ISR-deductible (LIVA art. 8, RLIVA art. 26,
  LISR art. 28 fr. III); staff meals have their own code. The accountant
  confirms (D3).
- **Refund scope.** `insertRefundBatch` is the single writer of refunds and the
  single caller of `recordRefundTax`, once per money row (tender), with
  `scope = [{ lineId, units, gross }]` where gross = Σ `refund_units.amount` of
  that row and line (`refundTaxScopes`). Amount refunds pass no scope (fiscal
  splits proportionally; they exist only on paid checks).
- **Complement extraction.** Fiscal splits each category's IVA as
  `extract(S − refunded) − extract(S − refunded − split)`, so the ticket's
  remaining IVA is exactly `extract(G − R)` and a full refund nets it to 0.
  Worked example: taco ×3 (iva16) with a 10 % line discount on units {0, 1},
  café (iva0); cash 6075 then card 18525. An item refund of two tacos writes a
  cash row of 2025 (IVA `extract(12600) − extract(10575)` = 279) and a card row
  of 6525 (IVA 1459 − 559 = 900).
- **Differences by design.** A CFDI de egreso stamps `extractTax(adj.gross)` per
  category, at most 1 centavo from the adjustment's IVA (fiscal P4); item
  refunds recorded before the ticket on a check that later changes keep
  fiscal's ≤ 1 centavo bound per change (P5). See [FISCAL.md](FISCAL.md) and
  [CFDI.md](CFDI.md). The slip always shows fiscal's figure.
- **CFDI.** Discounts are impossible once a ticket exists, so never after a
  CFDI. Refunds are never blocked by a CFDI; cfdi 030 adds the egreso inside
  `recordRefundTax`. `refunds.method` gives the egreso payment form. The refund
  dialog carries the notice "Esta venta ya tiene factura (CFDI)…" behind a
  condition that stays false until cfdi wires it.

## Lock order

Every command follows the [global lock order](ARCHITECTURE.md#global-lock-order-binding)
(rows 25–27 of its table): `applyDiscount` 1 → 2 → 5 → 5a → 8 → [refresh → 12];
`reverseDiscount` 1 → 2 → 5 → 5a → 8; `recordRefund` (items) 1 → 2 → 5 → 5a → 6
→ 7 → 9 → 10 (kitchen cancellation) → 11, (amount) 1 → 2 → 5 → 5a → 6 → 11;
`saveMoneyControls` 1 → 2 → 3; `closeCash`/`closeDrawerRow` 1 → 2 → 11;
`reviewDrawer` 1 → 2 → 11 (share). The refund's feed before the drawer is the
global order, the same one offline sync follows. `tests/lock-order.test.ts`
scans these commands with no allowlist entry; DB test "lock order …" runs 50
concurrent rounds of offline-style sync, a void that settles, an item refund
with a kitchen cancellation and payments on one device without a deadlock.

## Offline

Discounts and refunds are online only (the offline record format carries no
discount or approval evidence): every entry point is disabled offline with its
hint. A cached check copy (offline table service, LD-7) carries the check's
total discount and shows it read-only; offline payments against a check
discounted after caching are re-allocated server-side from the discounted
units, and an overpayment becomes `offline_payment_exceeds_due`.

## Runbook

- **Cliente pide factura después de un reembolso.** Refunds never block the
  CFDI; with cfdi 030 the egreso follows the refund. Before 030 tell the
  accountant which refunds belong to invoiced sales (Detalle de orden →
  Reembolsos).
- **Diferencia de caja.** Historial de cajas → "Diferencia por revisar" →
  **Revisar diferencia**, with what was found (one explanation per drawer; the
  count itself never changes).
- **Reembolso de terminal hecho sin registrar.** Open the order → Reembolsar →
  pick the units (or Por importe on a paid check) → type the terminal's refund
  reference and confirm. Card money never changes the drawer.
- **El cliente quiere reembolso por importe y la cuenta tiene saldo.** Refund
  the paid items by item, or settle or adjust the check first (void what was not
  served, or apply a discount), then refund by amount.
- **Se aplicó un descuento por error.** Detalle de orden → Descuentos → Quitar
  descuento, while nothing of those units is paid. On a takeaway check the
  discount that closed it is final: correct it with a refund.

## Limitations (deferred)

- Promotions (scheduled offers, 2×1, happy hour, coupons, automatic discounts)
  and tenant-custom presets or reason lists.
- Discounts and refunds offline.
- Tip refunds and tip adjustments.
- Integrated card-provider refunds (no provider selected).
- Saved close drafts and denomination counting.
- Caps on managers' own discounts.
- CFDI de egreso (cfdi 030) and the exceptions report (reports 029).

## Decisions

| # | Decision | Default |
| --- | --- | --- |
| D1 | Discount model | Manual discounts on sent items, line or check; check discounts after line discounts; one active check discount per order; one active line discount per unit. |
| D2 | Limits | Cashier and server 0 % / $0 until the owner raises it; managers and owner unlimited, confirming with their PIN on shared terminals. |
| D3 | Tax of courtesies | 100 % discount, no IVA; the accountant confirms. |
| D4 | Discounts after the fiscal ticket | Not allowed; corrections are refunds. |
| D5 | Who refunds | Any operator with a manager's approval. |
| D6 | Card refunds | Recorded only after the terminal approved them, with its reference and an explicit confirmation; never touch drawer cash. |
| D7 | Item refunds | Only fully paid units; anything else by amount once the check is paid. |
| D8 | Kitchen and stock on refunds | Unserved units are cancelled in the kitchen automatically; restock is a choice, with a warning once the kitchen saw the ticket. |
| D9 | Tips | Not refundable through the POS. |
| D10 | Blind count | On by default; owner and manager see expected cash; only owner and manager close. |
| D11 | Difference explanation | None required in blind mode; a manager reviews once. |
| D12 | Terminal batch total at close | Optional, stored with its own difference. |
| D13 | Refunds on invoiced sales | Always recorded; cfdi issues the egreso; never blocked. |
| D14 | Reason codes | Fixed, translated lists. |
| D15 | Plans | Discounts on every plan (selling rules apply); refunds, reversals, closes and reviews stay available when selling is blocked. |
| D16 | Refund business date | The day of the refund, computed once per command, shared by batches, fiscal adjustments and reports. |
| D17 | Amount refunds with a balance due | Refused (`refund_balance_due`). |
| D18 | Removing a discount that closed a takeaway check | Not possible; the dialog warns before applying. |

## Sources

- Ley del IVA art. 7 (devoluciones, descuentos y bonificaciones):
  <https://www.diputados.gob.mx/LeyesBiblio/pdf/LIVA.pdf>
- IVA on gifts and courtesies (LIVA art. 8, RLIVA art. 26, LISR art. 28 fr. III):
  <https://idconline.mx/fiscal-contable/2024/07/08/regalos-a-clientes-como-afecta-el-iva-a-su-empresa>
- CFDI 4.0 discounts and `Base = Importe − Descuento`:
  <http://omawww.sat.gob.mx/tramitesyservicios/Paginas/documentos/PregFrecCFDIVer4_0.pdf>
- INAPAM discounts are voluntary, by agreement:
  <https://inapam.com.mx/inapam-comercios-servicios-no-aplican-descuentos.html>
- Blind count practice ("cierre ciego"):
  <https://sistepos.com/la-caja-nunca-te-cuadra-exacta-el-truco-del-cierre-ciego-para-evitar-que-tus-cajeros-maquillen-las-cuentas/>
- PostgreSQL 18: locking clauses need UPDATE on a column; advisory locks;
  deferrable constraint triggers; `NOT VALID` constraints; `security_invoker`
  views (<https://www.postgresql.org/docs/18/>).
