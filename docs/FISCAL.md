# Fiscal (Mexico)

Status on October 5, 2026: **fiscal core only**. The pure calculation and validation
modules for Mexican IVA, ticket folios and the restaurant fiscal profile are implemented
and unit tested. **Nothing in the running app calls them yet.** There is no fiscal
migration (027), no server module, no route, no settings panel and no fiscal content on
the printed receipt. Orders still carry no tax snapshot, and receipts still print no RFC,
régimen, IVA breakdown or consecutive folio. That integration is the next wave, after the
access, service, menu, offline and ops tracks merge, because it edits files those tracks
are rewriting.

## Fiscal core

Every amount is an integer number of centavos. Every menu price is final and includes
IVA (LFPC art. 7 Bis), so IVA is always extracted from the price, never added on top.

| Module | Contents |
| --- | --- |
| `shared/tax.ts` (leaf, imports only `zod`) | Tax categories `iva16`, `iva8` (border incentive), `iva0`, `exempt`; regions; `TAX_RULES` with the SAT codes (c_Impuesto 002, c_TipoFactor, c_TasaOCuota, c_ObjetoImp 02); default SAT keys `90101501`/`E48` and global-CFDI keys `01010101`/`ACT`; `BORDER_STIMULUS_VALID_UNTIL`; `productFiscalInput` and `defaultProductFiscal()`; `FiscalContext`; `extractTax`; `satTaxWithinTolerance`; `resolveTaxCategory`; `lineTaxSnapshot` |
| `shared/sat.ts` (leaf) | `RFC_PATTERN`, `rfcSchema`, `postalCodeSchema`, `validateRfc`, `rfcKind`, `rfcCheckDigitValid` (módulo 11), `REGIMEN_FISCAL` (c_RegimenFiscal), `ISSUER_REGIMES`, `regimenFiscalSchema`, `regimeAllowedFor` |
| `shared/fiscal.ts` | Re-exports both. `lineTax` (remaining units after voids, minus the line discount), `taxGroups`, `orderTaxSummary` / `orderTaxBreakdown`, `allocateGroupToLines`, `ticketLineSnapshots`, `allocateOrderDiscount`, `refundScopeGross`, `refundTaxSplit`, `formatFolio` / `parseFolio`, self-invoice codes (`selfInvoiceCodeFromBytes`, `groupSelfInvoiceCode`, `normalizeSelfInvoiceCode`), `fiscalProfileInput`, `fiscalProfileIssues`, `effectiveFiscalIdentity`, and the wire types (`FiscalTicketView`, `OrderFiscal`, `FiscalSummary`, `TicketRow`, `CfdiTicketPayload`, …) |

Tests: `tests/tax.test.ts` and `tests/fiscal.test.ts` (`npm test`). They include exhaustive
checks of every amount from 0 to 2,000,000 centavos at 16% and 8%, and seeded property
tests over thousands of random mixed-category orders with voids, line discounts,
legacy lines and unallocated discounts.

## Rounding rule

`extractTax(gross, rate)`: `tax = round-half-up(gross × r / (1 + r))`, `base = gross − tax`.
It is computed with integers only, and `base + tax = gross` always holds exactly. For 16% and
8% no ties exist, so it equals the older `tax(gross, rate, true)` in `shared/domain.ts`.
IVA is extracted once per category of a ticket, never per line and summed.

**Why it is valid for CFDI 4.0.** SAT accepts a traslado `Importe` between
`trunc((Base − 0.005) × Tasa)` and `ceil((Base + 0.005) × Tasa)` at 2 decimals (Anexo 20
guide). Let `x = G·r/(1+r)`, `T = round(x)` and `B = G − T`. Then
`T − B·r = (1+r)(T − x)`, so `|T − B·r| ≤ (1+r)/2 ≤ 0.58` centavo. `T` is therefore
`⌊B·r⌋` or `⌈B·r⌉`, and the SAT window `[trunc(B·r − 0.08), ceil(B·r + 0.08)]` (in centavos)
always contains both. `satTaxWithinTolerance` implements the window. The tests check it
against a decimal implementation of the Anexo 20 formula and check every extraction
from 0 to 2,000,000 centavos at both rates.

## How money changes affect tax

- **Void:** no tax record. The ticket uses `lineRemaining()`, the same unit allocation as
  voids and item splits, so the voided units' exact centavos leave their category.
- **Discount or comp (discounts 028):** a tax-inclusive amount per line.
  `allocateOrderDiscount` spreads an order-level amount over the lines' remaining nets in
  `(round, id)` order. Each category nets its discount, and base and IVA are extracted from
  the net gross. A 100% comp leaves gross 0 and IVA 0 for that line.
- **Discount not yet wired per line:** when the lines add up to more than the order total,
  the difference is spread across the lines and recorded as `unallocatedDiscount`. Gross
  below the total throws `fiscal_total_mismatch`.
- **Refund:** `refundTaxSplit` splits a refund across categories in proportion to what is
  still unrefunded. It extracts IVA cumulatively: `tax = extract(refunded + this) − extract(refunded)`.
  Refunds that add up to a whole sale therefore return exactly the sale's IVA. One refund's
  IVA can differ by one centavo from extracting that refund alone. An item-level refund
  passes its categories through `refundScopeGross`, which uses the void unit allocation and
  each unit's share of the line discount.
- **Itemized lines on a ticket:** `allocateGroupToLines` splits a category's base across
  its lines so the line amounts add up exactly to the category. Each line is flagged
  `valid` when it is also inside the SAT tolerance on its own. It uses an exact
  largest-remainder split. In 20,000 random orders of 1 to 6 lines of MXN 10–500 per rate,
  the leftover-to-the-first-line rule of `allocate()` left a line outside the tolerance in
  22.6% of orders at 16% and 17.7% at 8%; largest remainder left none. Tiny amounts (a few
  centavos) can still be flagged, and CFDI can then fall back to one concept per category.
  Money allocations (units, discounts, refunds) keep `allocate()` so they match voids and
  item splits.

## Folios and profile validation

- `formatFolio("A", 123)` is `A-000123`; without a series it is `000123`. Numbers above 999999
  print in full. `parseFolio` accepts `A-000123`, `a-123` and `123`. The gapless counter is
  part of the pending migration.
- Self-invoice codes are 12 Crockford base-32 characters (`byte & 31`, uniform), printed
  `XXXX-XXXX-XXXX`. Typed input is normalized: uppercase, no `-` or spaces, `O→0`, `I/L→1`.
- `fiscalProfileIssues` returns issues in field order. The identity is all or nothing:
  a blank identity saves as incomplete, and once any part is filled, RFC, legal name, régimen
  and postal code are all required. Generic RFCs are refused. A check-digit mismatch is only a
  warning. The régimen must be an issuer régimen that matches the RFC type. The CP needs 5
  digits and the series up to 10 unaccented letters or digits. IVA 8% requires a border
  region, and a border region requires the attestation.

## Verification record

- **c_RegimenFiscal:** re-checked on 2026-10-05 against the CFDI 4.0 catalog data that
  phpCfdi generates from the SAT catCFDI file (`cfdi_40_regimenes_fiscales`). It has 19
  codes; descriptions and física/moral applicability match `REGIMEN_FISCAL`. The SAT XLS
  itself was not opened.
- **RFC check digit:** the algorithm accepts the SAT test RFCs EKU9003173C9, SAT970701NN3,
  IIA040805DZ4, EWE1709045U0, URE180429TM6, XIQB891116QE4 and CACX7605101P8. It also agrees
  with an independently written implementation on 20,000 random RFCs.
- **Border incentive date:** `BORDER_STIMULUS_VALID_UNTIL = 2026-12-31` follows the DOF
  decree of 31-12-2025 cited in the fiscal area spec. It was not re-checked in this step. A
  September 2026 press report of an extension to 2030 has no DOF publication yet; update the
  constant when one appears.
- No PAC, printer or SAT service was contacted. CFDI stamping is a separate area (cfdi 030).

## Pending integration (next wave)

- Migration 027:
  - fiscal profile;
  - gapless folio counters;
  - immutable tickets, ticket taxes and refund adjustments, with RLS, grants and triggers.
- `server/fiscal.ts` and `server/routes/fiscal.ts`:
  - context and profile;
  - ticket issuance on settlement;
  - refund tax;
  - register, IVA summary and repair.
- The `quote()` tax snapshot in `shared/domain.ts` and the order hooks.
- Settings panel, ticket register with CSV, and the fiscal header and footer of the printed ticket.
- `src/i18n/fiscal.ts` strings. The core already throws `fiscal_total_mismatch` and
  `fiscal_refund_exceeds`. Since service's merge, `tests/i18n-errors.test.ts` lists both as
  owned by fiscal and skips them until `src/i18n/fiscal.ts` declares them; from then on they
  need Spanish and English text like every other code.
- README, DELIVERY_STATUS, COMPLETION_LEDGER, ARCHITECTURE and OPERATIONS updates;
  `FISCAL_TICKETS_ENABLED` in `.env.example`.

Deliberately out of scope: IEPS, per-device offline folios, and a printed copy of each
ticket.

## Sources

- SAT RMF rule 2.7.1.21 (comprobantes simplificados, CFDI global): https://wwwmat.sat.gob.mx/articulo/90959/regla-2.7.1.24
- Anexo 20 filling guide (CFDI 4.0), traslado limits: http://omawww.sat.gob.mx/tramitesyservicios/Paginas/documentos/Anexo_20_Guia_de_llenado_CFDI.pdf
- Ley del IVA arts. 1 and 2-A: https://www.diputados.gob.mx/LeyesBiblio/pdf/LIVA.pdf
- Border-region IVA incentive, DOF 31-12-2025: https://dof.gob.mx/nota_detalle.php?codigo=5777697&fecha=31%2F12%2F2025
- LFPC art. 7 Bis: https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPC.pdf
- c_RegimenFiscal data generated from the SAT catalog: https://github.com/phpcfdi/resources-sat-catalogs (`database/data/cfdi_40_regimenes_fiscales.sql`)
