# Fiscal (Mexico)

Status on October 6, 2026: **fiscal integration (migration 027) built, hardened after its
second opinion (lead decision LD-25) and verified locally**. Every settled sale gets an immutable ticket with a consecutive, gapless folio,
the issuer's fiscal data and its IVA per rate; refunds write immutable IVA adjustments; the
owner keeps the restaurant's fiscal profile in Configuración; managers see the ticket
register, the IVA summary and the accountant's CSV. Evidence: `tests/tax.test.ts`,
`tests/fiscal.test.ts`, `tests/fiscal-client.test.ts`, `tests/fiscal-imports.test.ts`,
`tests/fiscal-config.test.ts`, `tests/fiscal-db.ts` (`npm run test:db:fiscal`, part of
`test:db:qualification`) and `tests/browser/fiscal.spec.ts`.

Not done here, and not claimed:

- **CFDI** (individual invoices, the daily/weekly/monthly global invoice, egresos,
  cancellation) is cfdi 030 ([CFDI.md](CFDI.md)). Fiscal provides its data
  (`ticketForCfdi`, self-invoice codes); nothing has been stamped.
- **No PAC, SAT service or printer was contacted.** The printed ticket was checked in
  Chromium print emulation at 58 and 80 mm only; a physical thermal printer is a pilot
  task ([PILOT_SOP.md](PILOT_SOP.md)).
- **An accountant has not reviewed** the documented rules (decisions D7, D9, D14 and D15
  below). They must before a pilot.
- IEPS, per-device offline folios and a printed paper copy of each ticket are out of scope
  (see Limitations). Tickets exist only for MXN restaurants.

## Regulatory model

1. **Rates.** IVA is 16% (LIVA art. 1). Prepared food is 16% even for takeaway or delivery
   (LIVA art. 2-A fr. I, last paragraph). 0% applies only to unprepared foods and other
   art. 2-A goods (a sealed bag of coffee beans). Restaurants with establishments in the
   northern or southern border region that are registered in the SAT beneficiary list may
   apply the incentive equivalent to IVA 8%; the DOF decree of 31-12-2025 extends both
   decrees (norte, DOF 31-12-2018; sur, DOF 30-12-2020) to 31-12-2026
   (`BORDER_STIMULUS_VALID_UNTIL`). A September 2026 press report of an extension to 2030
   has no DOF publication yet; update the constant when one appears, and if none is
   published, border tenants must switch to 16% on 2027-01-01 (a dated operator check in
   [RUNBOOK.md](RUNBOOK.md) and [LAUNCH_HANDOFF.md](LAUNCH_HANDOFF.md)). The app lets a
   profile use a border region only with a complete issuer identity (RFC and postal code)
   whose postal code lies in a state of that region (`BORDER_POSTAL_PREFIXES` in
   `shared/fiscal.ts`, two-digit prefixes from the SAT postal-code catalog;
   `fiscal_border_identity_required`, `fiscal_border_postal_code`), plus the owner's
   attestation. That is a state-level guard, not the incentive's test: **the PAC validates the
   exact `c_CodigoPostal` "Estímulo Franja Fronteriza" mark of the place of issue (1 north, 2
   south) and the issuer RFC's registration in the LCO with mark 2**, and the owner's
   accountant confirms both before a border pilot. Exempt is supported for completeness.
2. **Prices include taxes** (LFPC art. 7 Bis). Every menu price is final; IVA is
   **extracted** from it, never added on top.
3. **Comprobante simplificado (ticket)** for sales to the general public (RMF rule
   2.7.1.21): CFF art. 29-A fr. I data (the issuer's RFC, name or razón social and régimen
   fiscal and, when the taxpayer has more than one establishment, the address of the
   establishment that issues the comprobante) and fr. III data (place and date of issue), a
   **consecutive folio**, quantity and description, and total value. The ticket also shows
   the IVA breakdown that the global CFDI must separate. "Este RFC tiene más de una
   sucursal" in Datos fiscales makes street, municipality and state mandatory
   (`fiscal_address_required`); without them the profile stays Incompleto.
4. **Global CFDI** (cfdi 030): daily, weekly or monthly (RESICO monthly), within 24 hours
   after the period closes, IVA separated, each ticket's folio as `NoIdentificacion`.
5. **CFDI tax tolerance.** A traslado's `Importe` must lie between
   `trunc((Base − 0.005) × rate)` and `ceil((Base + 0.005) × rate)` (Anexo 20 guide); the
   extraction below always meets it.
6. **Retention.** Accounting records are kept 5 years (CFF art. 30). Fiscal tables are
   INSERT-only for the runtime role, immutable by trigger even for the table owner, and no
   retention job touches them.

## Rounding rule

`extractTax(gross, rate)`: `tax = round-half-up(gross × r / (1 + r))`, `base = gross − tax`,
in integers only; `base + tax = gross` always holds exactly. For 16% and 8% no ties exist,
so it equals the older `tax(gross, rate, true)` in `shared/domain.ts`. IVA is extracted once
per category of a ticket, never per line and summed.

**Why it is valid for CFDI 4.0.** Let `x = G·r/(1+r)`, `T = round(x)` and `B = G − T`. Then
`T − B·r = (1+r)(T − x)`, so `|T − B·r| ≤ (1+r)/2 ≤ 0.58` centavo. `T` is therefore
`⌊B·r⌋` or `⌈B·r⌉`, and the SAT window `[trunc(B·r − 0.08), ceil(B·r + 0.08)]` (in centavos)
always contains both. `satTaxWithinTolerance` implements the window; the tests check it
against a decimal implementation of the Anexo 20 formula and check every extraction from 0
to 2,000,000 centavos at both rates.

## When a ticket is issued

A ticket is issued **when the check's balance first reaches zero with a positive total**,
in the transaction of the command that caused it: a payment (single, item split, amount
split, a grouped settlement), a void that removes the last unpaid units, a discount that
makes the balance zero (discounts 028), a reassignment that moves a paid check off its
table, an offline sync, a manager's reconcile of an offline payment or of a parked payment
attempt, a financial-only offline recovery, or the repair.

In service's lifecycle this is the transition `open → paid` (dine-in table, "Pagada · por
liberar") or any close as `settled`. `refreshCheckState` issues only on those two paths,
never when it merely finds a check already `paid`. **Liberar mesa** (`closeCheck`) calls
`issueDueTicket`, which returns the existing ticket without touching the counter, or issues
a missing one (kill switch, an older app revision). Zero-total checks get no ticket.

**One ticket per order, and no rounds after it** (D1, LD-15 fiscal Q2). RMF 2.7.1.21 needs
the folio on the comprobante the guest takes at payment, so a ticketed check takes no more
lines: `applyRound` (online rounds and offline round sync) refuses with
`fiscal_ticket_issued`, Selling keeps the items and offers **Enviar como orden nueva** for
the same table, an offline round synced onto a ticketed check goes to manager review as
`offline_order_closed`, and a database trigger blocks any `order_lines` insert as a backstop
(an older app revision during a deploy). Order detail shows "Folio …". cfdi may invoice any
ticketed check, paid or closed (this supersedes the wave-1 "closed only" wording).

The ticket stores everything it prints, so reprints never recompute: the issuer snapshot
(or null while the profile is incomplete), the remaining lines with names, options, SAT
keys and their exact share of their category's base and IVA, the tenders (method, amount,
tip, reference, time), the totals and one row per tax category. Its business date is the
order's (the sale day, also for offline sales); its date of issue is `issued_at`. The
receipt job payload and the stored `operations.result` of a settling command carry the whole
`Order`, so they grow by the ticket's lines.

Kill switch: `FISCAL_TICKETS_ENABLED=false` (web; `true`, `false` or unset, checked at
startup) stops issuance; payments keep working and the sales show up as missing tickets.

## Folio policy

`formatFolio(series, n)` prints `A-000123` with a series and `000123` without; numbers above
999999 print in full. The folio is **tenant-wide per series, consecutive and gapless** (D3),
and independent of the daily call number "#42", which keeps resetting each business day.

Why it is gapless: the number comes from `INSERT … ON CONFLICT (tenant_id, series) DO UPDATE
SET last_value = last_value + 1 RETURNING last_value` on `fiscal_folio_counters`, a row lock
and update rather than a sequence, so a rolled-back transaction restores it. A deferred
constraint trigger refuses to commit a counter value without its ticket, an insert trigger
forces `ticket.number = counter` and `ticket.gross = orders.total`, `UNIQUE(tenant_id, series,
number)` blocks duplicates, and a guard trigger lets a counter only start at 1 and advance by
one. Every committed folio therefore exists exactly once and none is skipped (DB tests:
20 concurrent payments, rollback, counter without ticket).

Changing the series (Configuración) starts the new series at 1; the old series' history
stays. Several locations under one RFC should each use their own series and tick "Este RFC
tiene más de una sucursal", so every ticket prints the issuing branch's address.

## Data model (`migrations/027_fiscal.sql`)

Expand-only: five new FORCE-RLS tenant tables with composite tenant foreign keys, trigger
functions (SECURITY INVOKER, `search_path` pinned) and one `BEFORE INSERT` trigger on
`order_lines`; no backfill, no change to existing columns. `fiscal_epoch()` returns the
instant 027 ran; repair never issues tickets for older orders.

| Table | Contents | Runtime grants |
| --- | --- | --- |
| `restaurant_fiscal_profiles` | RFC, razón social, régimen, C.P., address, series, region, default category, border attestation, "more than one branch", version; checks: a border region has an RFC, more than one branch has street, municipality and state | SELECT, INSERT, column UPDATE |
| `fiscal_folio_counters` | `(tenant_id, series) → last_value` | SELECT, INSERT, UPDATE(last_value) |
| `fiscal_tickets` | one per order: folio, self-invoice code, issue time, business date, issuer, device, source (`sale`/`recovery`/`repair`), totals, tip, tax basis, lines, payments | SELECT, INSERT |
| `fiscal_ticket_taxes` | per ticket and category: gross before/after discount, base before/after discount, base, IVA | SELECT, INSERT |
| `fiscal_adjustments` | per refund and category: gross, base, IVA, business date | SELECT, INSERT |

No DELETE anywhere; tickets, taxes and adjustments refuse UPDATE, DELETE and TRUNCATE even
for the owner (`fiscal_immutable()`), and the counters refuse DELETE and TRUNCATE. Test
cleanups delete fixture rows in one admin transaction that disables those triggers by name
(LD-12 pattern), fiscal tables first in FK order (LD-16 L5). The self-invoice code is 12
Crockford base-32 characters, globally unique (retried on a collision), printed
`XXXX-XXXX-XXXX`; typed input is normalized (`O→0`, `I/L→1`).

## How money changes affect tax (the reconciliation contract)

| Event | `orders.total` | Fiscal effect |
| --- | --- | --- |
| Line sent | `+ line.total` | The line's immutable `tax` snapshot (category, rate, SAT keys, informational base/IVA of the full line), priced with the **server's** fiscal context on every server path (`createOrder`, `addRound`, offline `verifyLines`). Client previews use the default context and never send it; offline records drop it. |
| Void of unpaid units | `− Σ unit amounts` | None at void time. The ticket uses `lineRemaining()`, the same unit allocation as voids and item splits. |
| Item or amount split payment | none | None until the balance is zero; then one ticket for the whole check. |
| Discount or comp (028) | `−` discount | Discounts provides `discountsByLine` (per-unit allocation by due); fiscal nets each category. A gross above `orders.total` with no per-line discount is absorbed as `unallocated_discount` and audited; a gross below it throws `fiscal_total_mismatch` and the payment rolls back. |
| Ticket issuance | none | `Σ groups.gross = orders.total`, `base + tax = gross` per category and in total (application, insert trigger and deferred sum trigger). |
| Refund | none | `recordRefundTax` writes one adjustment per category (below). |
| Offline financial recovery | collected cash | One `recovery_default` group at the restaurant default; one synthetic line "Venta sin conexión conciliada". |

Lines without a snapshot (created before 027, or by an older revision during a deploy) use
the restaurant default at issuance (`tax_basis = 'issuance_default'`). A product marked
IVA 8% while the region is general (a race or legacy data) is priced at the default with
`basis: "fallback"`. Modifiers, combos and open prices are one line each, taxed at the
product's category (no per-option category in v1).

## Refund IVA by complement extraction

`refundTaxSplit` splits a refund across categories in proportion to what is still
unrefunded (an item refund passes its categories), and extracts each category's IVA as

`tax = extract(S − refunded).tax − extract(S − refunded − amount).tax`

where `S` is the category's sale gross on the ticket (or the provisional summary before the
ticket). Properties, each a property test in `tests/fiscal.test.ts`:

- **P1.** After any sequence of refunds against the same `S`, the ticket's remaining IVA is
  exactly `extract(S − R)`: the sum telescopes.
- **P2.** Refunding the whole sale nets the category IVA to exactly 0.
- **P3.** Every row has `0 ≤ tax ≤ gross` and `base + tax = gross`.
- **P4.** One refund's IVA is within 1 centavo of `extract(refund gross)`, which is what a
  CFDI de egreso stamps for that refund alone; cfdi's egreso amount check uses the canonical
  value, and that ≤ 1 centavo per category difference is expected ([CFDI.md](CFDI.md)).
- **P5 (the function's bound; the app never reaches it).** A refund split against a
  provisional gross that later changes would leave the ticket's net IVA within `c` centavos
  of `extract(S_final − R)`, `c` being the number of gross changes after the first refund;
  at `S_final = R` that is IVA on a zero net, which `netCategoryTax` and cfdi's `netGroups`
  refuse. So **no refund, by amount or by item, is accepted on an order without a ticket and
  with a balance due** (`refund_balance_due`, LD-25 MONEY-1): before payment staff void
  lines instead. The legacy refund checks it under the order lock, and `recordRefundTax`
  refuses it as a backstop for every refund path. An unticketed order can only be refunded
  once fully paid (kill switch, non-MXN); its gross can then only grow (a new round, which
  blocks refunds again until it is paid), so no adjustment is ever recorded against a
  provisional gross that can still shrink.

It replaced the cumulative form `extract(refunded + amount) − extract(refunded)` because
`extract(G) − extract(R) ≠ extract(G − R)`: a partially refunded ticket left the fiscal
summary and the CFDI global up to 1 centavo apart. Fixed examples at 16%: a sale of 100.00
(IVA 13.79) refunded 0.04 used to keep 13.78 of IVA while `extract(99.96) = 13.79`; the
complement row's IVA is 0.00. A sale of 123.45 refunded 67.89 used to leave 7.67; the
canonical `extract(55.56)` is 7.66, which the complement row (IVA 9.37) leaves.
`netCategoryTax` gives a sale's per-category net (cfdi's `netGroups` may delegate to it).

Item refunds (discounts 028) pass, per refund money row, `scope = [{lineId, units, gross}]`
with `gross` = Σ `refund_units.amount` of that row and line; fiscal uses it verbatim,
grouped by the category the ticket froze for that line (the line's snapshot before a ticket
exists; a line without a snapshot keeps the default it was ticketed under even after the
default changes), and never recomputes unit discounts
(`refundScopeCategories`). `refundScopeGross` is a fallback only for entries without
`gross` and is refused on a discounted line; `allocateOrderDiscount` is for previews and
tests only.

Refund dates: a refund batch's `business_date` (discounts 028) once it exists; until then
(the legacy `POST /refunds`) the business date of the refund row's own `created_at`, the
date reports gives a batchless refund, never the clock when the tax rows are written. The
legacy refund locks the tender's order before the tender key (LD-15 fiscal Q3), so
concurrent refunds of two tenders of one order read the earlier adjustments in turn, and
refuses `refund_balance_due` there (the LD-15 Q3 pre-ticket window is closed: it could
misstate IVA by whole amounts, not only 1 centavo, when a category was later voided).
Non-MXN restaurants write no adjustments.

## Global lock order

Fiscal follows the binding [global lock order](ARCHITECTURE.md#global-lock-order-binding):
the folio counter is level LO-12, **always last**, taken only inside `issueDueTicket`
(reached from `refreshCheckState`, `closeCheck`, `financialRecovery` and repair). Any
command that bumps the kitchen feed and may call `refreshCheckState` bumps the feed first;
fiscal reordered `createOrder`, `voidLines` and `assignService` accordingly and removed their
`tests/lock-order.test.ts` allowlist entries. Rounds never issue (a writable check at zero
balance is already `paid`), so `addRound` never takes the counter. Offline sale, order and
round sync touch their own new rounds after the folio (exception E4, LD-15 fiscal Q4). The
legacy refund is `1 → 2 → 5 → 6 → 11`. Every settling payment of a location serializes on
its counter row until commit, so nothing slow runs under it: a payment writes the ticket,
its category rows and its audit rows (four statements) after taking the counter, and the
repair computes every ticket and the remaining count before it, then holds the counter for
two statements per ticket plus one insert each for all category and audit rows, at most 20
tickets per call (a payment concurrent with a full batch commits without a retry: fiscal DB
"CONCURRENCY-1"). The profile's area key is advisory class 922 (LO-3).

## The printed ticket

`installFiscalReceipt()` (`src/App.tsx`) registers the fiscal header and footer with
service's receipt slots (fiscal is their only caller), so the receipt modal and its print,
the pre-bill, reprints, grouped receipts and offline local receipts all carry them. cfdi
adds its block with `setFiscalFooterExtra`.

- **Header:** razón social (only when it differs from the trade name, case- and
  accent-insensitively), RFC, régimen, address if set, "Lugar de expedición: C.P. …",
  **Folio**, "Fecha de expedición" (restaurant time zone). Without a ticket: the issuer from
  the cached fiscal context and "Comprobante de pago parcial…" (partial payment, also on a
  partial local payment with offline table service), "Ticket sin folio." (paid without a
  ticket) or "Folio pendiente: se asigna al sincronizar." (offline local receipt that
  settles the sale). Customer paper never says "folio fiscal" (in Mexican usage that is the
  CFDI's UUID) and carries no staff instruction; managers issue missing tickets from
  Configuración → "Emitir tickets faltantes" (FISCAL-UI-7, acceptance Q17). An incomplete
  profile prints "Ticket sin datos fiscales del emisor." (D5: selling is never blocked). A
  synced offline sale prints "Venta sin conexión B-07 · {fecha}" (its provisional number and
  sale time, the two things on the customer's local receipt), and a ticket whose order has no lines left (a financial-only recovery) prints the
  ticket's frozen lines ("1 × Venta sin conexión conciliada"), so the comprobante always
  states quantity and description; the recovery's order note prints in Spanish.
- **Footer:** "Base IVA 16%" / "IVA 16%" (and 8%), "Venta a tasa 0%", "Venta exenta",
  "IVA reembolsado", "Precios con IVA incluido", the tip legend when there is a tip, "Este
  ticket no es una factura (CFDI)." and "¿Necesitas factura? Pídela con el folio …". A
  pre-bill shows "IVA incluido en la cuenta" from the provisional summary.
- **Print language (D10):** comprobantes (receipt, pre-bill, partial receipt, grouped
  receipts, local receipt, register reprint) always print in **Spanish**, labels included;
  the on-screen copy keeps the UI language. Internal documents (kitchen tickets, cortes)
  keep the UI language.
- Layout: no fixed widths; text wraps at 48 mm (58 mm paper); the browser suite checks that
  the fiscal blocks do not overflow a 58 mm print in print emulation
  (`docs/evidence/fiscal-ticket-58mm.png`).

## Configuración: Datos fiscales and Registro de tickets

- **Datos fiscales** (owner edits with a fresh PIN; managers read). RFC (pattern; generic
  RFCs refused; a check-digit mismatch is a warning shown as soon as the RFC is complete:
  the first save stops on it and **Guardar de todos modos** keeps the RFC, and the warning
  stays until the RFC changes), razón social without the company suffix, régimen from
  `c_RegimenFiscal` filtered by RFC type, C.P. de expedición, the branch address (mandatory
  with "Este RFC tiene más de una sucursal"), series, region (general, border north, border
  south; a border region needs the full identity, a C.P. in the region and the attestation,
  with the DOF validity hint, by the restaurant's own date, turning amber after it expires)
  and the default product tax (a border region warns while the default is not IVA 8%). The
  identity is all or nothing. A blocked save names the problem next to the button and moves
  focus to the first marked field. Saving is versioned: when another device saved meanwhile
  (`fiscal_profile_changed`) the panel shows the current data in place of the stale form, so
  a second tap can never write the old values back. It is audited (`fiscal.profile.saved`
  with before/after) and never changes `restaurants.config_version`, so queued offline sales
  stay valid. Going back to the general region is refused while products use IVA 8%.
- **Product tax** (menu editor, Impuestos): restaurant default, IVA 16%, IVA 8% (border
  region only), IVA 0%, exempt, and optional SAT keys (default `90101501` Restaurantes and
  `E48` Unidad de servicio, used only for itemized CFDI). A tax change bumps the product
  version; lines already sent keep their snapshot, and queued offline sales of that product
  go to review (`offline_catalog_changed`).
- **Registro de tickets** (owner and manager): business-date range up to 31 days or an exact
  folio; columns folio, issued, order, total, base, IVA, refunds, payment methods and
  **Reimprimir** (prints in Spanish, audited as a reprint). **Resumen de IVA**: sales,
  refunds and net per category, the contiguous folio runs of each series (a ticket issued
  after its sale day, such as a late offline sync, is its own run instead of a range that
  reads as missing folios), paid sales without ticket. Staff find a synced offline sale in
  **Órdenes** by the provisional number on the customer's paper; order detail shows it next
  to the folio, and the Sincronización list maps "B-07 → #142 · Folio 000123".

## Accountant notes

- **CSV** (`tickets_{from}_{to}.csv`, UTF-8 with BOM, comma, dot decimals, CRLF, fixed
  headers): `folio, serie, numero, fecha_expedicion` (restaurant time, `AAAA-MM-DD HH:mm`),
  `dia_negocio, orden, total, base_iva16, iva16, base_iva8, iva8, venta_tasa0,
  venta_exenta, descuentos, propinas, reembolsos, iva_reembolsado, formas_pago,
  codigo_facturacion`. Text cells starting like a formula are neutralized. `reembolsos` and
  `iva_reembolsado` sum the refunds of each ticket **recorded up to the range's last
  day**, so a period's export does not change when a later refund arrives; refunds are
  deducted in their own period (LIVA art. 7) and the Resumen de IVA dates them by their own
  business date.
- The summary dates tickets by their sale's business date and refund adjustments by the
  refund's. IVA is never recomputed from orders.
- A ticket created after its period's global invoice (offline sync, repair, a cross-day
  settlement) goes into a supplementary global part for its own period (cfdi D5, D14).
- Tips are voluntary and not part of the sale total; the ticket says so.

## Runbook

- **Missing tickets.** Configuración shows "{n} ventas cobradas no tienen ticket" when paid
  sales of the last 40 business days (created after 027) have none: an older revision
  processed a payment during a deploy, or the kill switch was off. **Emitir tickets
  faltantes** (managers, fresh PIN) issues up to 20 per click in creation order with source
  `repair` (audited `fiscal.tickets.repaired`, listing only the folios it issued; an order
  ticketed meanwhile by a payment or Liberar mesa is skipped); repeat while the count stays.
  While the kill switch is on the button is replaced by "La emisión de tickets está
  pausada" and the command answers `fiscal_tickets_disabled`. A non-MXN restaurant counts no
  missing tickets. Liberar mesa also issues a missing ticket of a table check.
- **Kill switch.** If a fiscal bug ever blocks payments (`fiscal_total_mismatch` or a
  trigger error rolls payments back), set `FISCAL_TICKETS_ENABLED=false` on the web service
  (Railway variable) and redeploy: payments continue without tickets. Fix, set it back to
  `true` (or unset) and run the repair. Any other value refuses to start.
- **New location under the same RFC.** Give it its own series in Datos fiscales (the series
  starts at 1) and tick "Este RFC tiene más de una sucursal" with that branch's address.
- **Border incentive.** Before a border pilot the owner's accountant confirms that the
  place of issue's C.P. carries the SAT "Estímulo Franja Fronteriza" mark and that the RFC is
  in the LCO with mark 2 (the PAC rejects 8% otherwise). The hint turns amber after
  `BORDER_STIMULUS_VALID_UNTIL`; nothing switches automatically. **Dated check, 2026-12-31:**
  if the DOF has published no extension, on 2027-01-01 move IVA 8% products and the default
  to IVA 16% and switch the region to general (before switching, sync every device's pending
  offline sales: queued sales are taxed with the settings in force at sync).
- **Deploy.** 027 takes `SHARE ROW EXCLUSIVE` on `orders`, `order_lines` and other hot tables
  until it commits: deploy it in the morning window ([RUNBOOK.md](RUNBOOK.md)).
- **Backups.** Fiscal rows are part of every database backup; control totals for
  `fiscal_tickets` are an ops follow-up after 030 (LD-16 L11).

## Integration with other areas

| Area | Contract |
| --- | --- |
| service (024) | `refreshCheckState` issues on open → paid and before a settled close; `closeCheck` before releasing; `applyRound` refuses ticketed checks; `getOrders` has one batched `fiscalRows` member (`Order.fiscal`: ticket, provisional summary, refunds); Selling handles `fiscal_ticket_issued` like `check_closed`. |
| menu (025) | `productInput.fiscal`, `assertProductFiscalAllowed`, `quote(lines, catalog, canOpen, fiscalContext)`, the editor's Impuestos section; `publicCatalog` strips `fiscal`. |
| offline (026) | `verifyLines` prices with the server context; `financialRecovery` issues a `recovery` ticket; the round applier maps `fiscal_ticket_issued` to `offline_order_closed`; local receipts print the cached issuer and "Folio pendiente". |
| discounts (028) | `assertNoFiscalTicket` before discount writes; `recordRefundTax(tx, s, refundId, scope?)` with `RefundTaxScope = {lineId, units, gross}`; `assertRefundAllowed(tx, orderId)` (`refund_balance_due`, now declared by fiscal) for amount **and** item refunds, inside the order lock; replaces `{}` with `discountsByLine` in `prepareTicket` (the computation `issueDueTicket` and the repair share) and `recordRefundTax`, adds the refund batch date, and becomes the single caller of `recordRefundTax`. |
| reports (029) | `fiscalSummary(tx, s, {from, to})` (≤ 31 days, 30 s statement timeout; `tickets.series` lists contiguous runs, several per series when later folios belong to other days), `missingTicketCount(tx, range?)` (MXN restaurants only), `formatFolio`, `fiscal_epoch()`. |
| cfdi (030) | `server/fiscal-read.ts` (a leaf: db and shared imports only, re-exported by `server/fiscal.ts`): `ticketForCfdi`, ticket and refund readers; `setFiscalFooterExtra`; `fiscal_immutable()`; the `recordRefundTax` hook comment for `enqueueCfdiRefund`. Worker grants on the fiscal tables are cfdi's. |
| public ordering (032) | `fiscalTicketIdentity(tx, orderId): Promise<{folio, selfInvoiceCode} \| null>` in `server/fiscal-read.ts` (one statement). |
| account (031) | `rfcSchema`, `regimenFiscalSchema`, `REGIMEN_FISCAL`, `postalCodeSchema`, `validateRfc` from `shared/sat.ts`. |

Wire and audit: routes in `server/routes/fiscal.ts` (`GET /fiscal/context`, `GET/POST
/fiscal/profile`, `GET /fiscal/tickets`, `GET /fiscal/summary`, `POST
/fiscal/tickets/repair`); audit operations `fiscal.ticket.issued`, `fiscal.profile.saved`,
`fiscal.tickets.repaired`, `fiscal.ticket.unallocated_discount` (labelled in
`src/labels.ts`); strings and error texts in `src/i18n/fiscal.ts`.

## Decisions (defaults until the user or the accountant says otherwise)

| # | Decision | Default |
| --- | --- | --- |
| D1 | When the folio is issued | When the balance first reaches zero; no rounds afterwards (new order for the same table). |
| D2 | Partial-payment receipts | Printed without a folio, "Comprobante de pago parcial". |
| D3 | Folio scope | Per location, optional series, gapless, starting at 1 per series. |
| D4 | Offline folios | None on the device; assigned at sync. |
| D5 | Incomplete profile | Selling continues; the ticket says it lacks issuer data. |
| D6 | Border incentive | Full issuer identity, a C.P. in a state of the region and the attestation; 31-12-2026 per DOF; amber warning afterwards; the PAC checks the C.P. mark and the LCO. |
| D7 | Comps | A 100% discount contributes no gross and no IVA. Accountant to confirm. |
| D8 | IEPS | Out of scope. |
| D9 | Fiscal business date | The order's business date; the printed date of issue is `issued_at`. Accountant to confirm for cross-day partial payments. |
| D10 | Print language | Comprobantes in Spanish; internal documents in the UI language. |
| D11 | Paper copy | The immutable electronic record and reprint serve as the copy. |
| D12 | Default SAT keys | `90101501` and `E48`, overridable per product. |
| D13 | IVA on the ticket | Shown per rate, with "Precios con IVA incluido". |
| D14 | Late tickets | Supplementary global for their own period (cfdi D5). Accountant to confirm. |
| D15 | Refund IVA | Complement extraction; ≤ 1 centavo per category against a CFDI de egreso; no refund on an unticketed order with a balance due. Accountant to confirm. |

## Limitations

- IEPS (alcohol, sugary drinks) is not modeled.
- An offline sale's customer leaves with a provisional receipt; the folio exists after
  sync. Staff find the order in Órdenes by the provisional number and reprint it; the
  register's folio search does not accept provisional numbers.
- Queued offline sales are taxed with the fiscal profile in force when they sync, not when
  they were sold (the profile save never invalidates offline leases): change the region or
  the default product tax only after every device has synced.
- No second paper copy of each ticket.
- Tickets are issued only for MXN restaurants.
- Physical thermal printers and any PAC were not tested.

## Verification record

- **c_RegimenFiscal:** re-checked on 2026-10-05 against the CFDI 4.0 catalog data that
  phpCfdi generates from the SAT catCFDI file (`cfdi_40_regimenes_fiscales`): 19 codes;
  descriptions and física/moral applicability match `REGIMEN_FISCAL`. The SAT XLS itself
  was not opened.
- **RFC check digit:** accepts the SAT test RFCs EKU9003173C9, SAT970701NN3, IIA040805DZ4,
  EWE1709045U0, URE180429TM6, XIQB891116QE4 and CACX7605101P8, and agrees with an
  independent implementation on 20,000 random RFCs. Fixtures and the browser suite use the
  fictional test RFC EKU9003173C9.
- **Border incentive date:** `BORDER_STIMULUS_VALID_UNTIL = 2026-12-31` re-checked on
  2026-10-06 against the text of the DOF decree of 31-12-2025 (SAT minisitio copy): its
  articles Primero and Segundo set both the northern (DOF 31-12-2018) and southern (DOF
  30-12-2020) decrees in force until 31-12-2026.
- **Border postal-code prefixes:** derived on 2026-10-06 from the SAT "Catálogo de códigos
  postales" (31,637 codes with their Clave Entidad Federativa): every two-digit prefix
  belongs to exactly one state; the ten border states' prefixes are listed in
  `shared/fiscal.ts` (`BORDER_POSTAL_PREFIXES`).
- **Complement extraction:** P1–P4 and the old cumulative drift were checked over 400,000
  random sequences and P5 over 6,000,000 during the spec revision; the suite re-checks them
  on 5,000 to 100,000 seeded sequences.
- No PAC, printer or SAT service was contacted.

## Sources

- SAT RMF rule 2.7.1.21 (comprobantes simplificados, CFDI global): https://wwwmat.sat.gob.mx/articulo/90959/regla-2.7.1.24
- SAT global CFDI guide: http://omawww.sat.gob.mx/tramitesyservicios/Paginas/documentos/Guia_llenado_CFDI_global.pdf
- Anexo 20 filling guide (CFDI 4.0), traslado limits: http://omawww.sat.gob.mx/tramitesyservicios/Paginas/documentos/Anexo_20_Guia_de_llenado_CFDI.pdf
- Ley del IVA arts. 1 and 2-A: https://www.diputados.gob.mx/LeyesBiblio/pdf/LIVA.pdf
- Border-region IVA incentive, DOF 31-12-2025: https://dof.gob.mx/nota_detalle.php?codigo=5777697&fecha=31%2F12%2F2025 (SAT copy: https://www.sat.gob.mx/minisitio/EstimulosFiscalesFronteraNorteSur/documentos/Decreto_modifica_diversos_estimulos_fiscales_region_fronteriza_norte_sur.pdf)
- Decreto de estímulos fiscales región fronteriza sur (DOF 30-12-2020): https://sidof.segob.gob.mx/notas/docFuente/5609182
- SAT, facturación con estímulo en la región fronteriza (the place of issue's C.P. must carry the "Estímulo Franja Fronteriza" mark): https://wwwmat.sat.gob.mx/consultas/22035/facturacion-con-estimulo-en-la-region-fronteriza-
- SAT postal-code catalog (C.P. → entidad federativa): http://omawww.sat.gob.mx/terceros_autorizados/receptor_doctos_electronicos/Documents/catalogos/Cat_Codigos_Postales.pdf
- LFPC art. 7 Bis: https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPC.pdf
- CFF arts. 29, 29-A, 30: https://www.diputados.gob.mx/LeyesBiblio/pdf/CFF.pdf
- c_RegimenFiscal data generated from the SAT catalog: https://github.com/phpcfdi/resources-sat-catalogs (`database/data/cfdi_40_regimenes_fiscales.sql`)
- ClaveProdServ 90101501 "Restaurantes": https://veinte.mx/catalogos/clave/90101501
