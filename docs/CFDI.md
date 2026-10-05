# CFDI (Facturapi): core

**Status: CFDI core only.** The Facturapi client, the CFDI 4.0 request builders, the XML amount
parser and a fake Facturapi exist and are **contract-tested against Facturapi's documented API
(authored fixtures `docs@1c2e617`), not sandbox-verified**. Nothing calls them yet: there is no
migration, worker job, route, settings panel or portal, so CFDI stays **disabled** and **live mode
is not enabled**. No Facturapi key was used and no request reached Facturapi.

The full design is the cfdi area spec (migration 030). This page covers what the core contains;
integration and sandbox verification are pending (below).

## What exists

| File | Purpose |
| --- | --- |
| `server/cfdi/facturapi.ts` | Facturapi v2 HTTP client over `fetch` (no SDK, injectable). Key/endpoint matrix and `sk_user_`/`sk_test_`/`sk_live_` prefix checks before any request; `livemode` checked on every invoice response (`cfdi_mode_mismatch`); official base URL or a loopback fake only, and only the official URL when `APP_ENV` is staging or production; 15 s deadline (30 s for stamping, cancellation, CSD upload) combined with the caller's signal; `idempotency_key` and `external_id` in the body; documented `GenericError`, `X-Facturapi-Log-Id` and `Retry-After`; bounded response sizes. `stampFacts` returns the UUID, total (centavos) and stamp date a stamping job records, and refuses a stamped invoice without them. It never logs and never puts a secret in an error. |
| `server/cfdi/facturapi-schema.ts` | Strict request schemas (only fields cfdi sends) and loose response schemas, from the OpenAPI v2. The invoice response requires only `id`, `livemode` and `status` (the OpenAPI `Invoice` requires `id`, `created_at`, `livemode`), so a minimal 202 pending object can always be read and adopted. |
| `server/cfdi/errors.ts` | `classifyFacturapiError`: retry or permanent, `afterMs`, a `cfdi_*` code, the field `path`, and `unknownOutcome` so a stamping job adopts by `external_id` instead of failing a document that may exist. The outcome is unknown after a timeout, a network failure, **any 5xx whatever its code**, a 409 that is not a documented final resource state (cancellation, substitution, email, receptor or CSD codes), the generic `conflict` code, `invoice_already_stamped` (`cfdi_provider_already_stamped`, retried in 15 s so the next attempt adopts it) and a 2xx that could not be read. |
| `server/cfdi/build.ts` | `netGroups`, `canonicalTax`, `buildInvoiceRequest`, `buildGlobalRequests`, `buildEgresoRequest` (below). |
| `server/cfdi/xml.ts` | `parseCfdiTotals`: SubTotal, Descuento, Total, comprobante-level `TotalImpuestosTrasladados`, concept traslados and the TFD UUID, in exact centavos (namespace-aware, no DTDs). |
| `server/cfdi/catalog.ts` | **Temporary.** The c_UsoCFDI catalog text the platform moves into `shared/sat.ts` and the payment-form rule that moves into `shared/cfdi.ts`; replace with re-exports when those land. |
| `tests/fakes/facturapi-fake.ts` | Deterministic in-memory Facturapi (`npm run dev:facturapi-fake`). |
| `tests/fixtures/facturapi/` | Vendored OpenAPI v2 subset and authored response envelopes; see its README for provenance. |

## Builders (fiscal 027 stays the system of record)

- Amounts are fiscal's figures: per category, ticket group minus refund adjustments
  (`netGroups`). Inconsistent figures are refused with `fiscal_total_mismatch`, never dropped: a
  refund larger than what is left in its category, a refund in a category the ticket never sold,
  IVA left on a category netted to zero, IVA above the gross, or IVA at 0 % or exempt. Only a
  category netted to exactly 0 / 0 is left out, so an invoice always equals the ticket minus the
  refunds it lists (`buildInvoiceRequest` asserts it). Each concept is sent tax-inclusive (`tax_included: true`, quantity 1), so
  Facturapi derives Base and Importe from the same gross. For 16 % and 8 % there are no rounding
  ties, so `round2(G/(1+r)) + round2(G·r/(1+r)) = G` and the IVA equals fiscal's `extractTax(G)`
  (unit test 15 checks every gross up to MXN 2,000). `canonicalTax` is what Facturapi must stamp
  if it rounds each concept half up; the stamped XML is compared with it later (`amount_check`).
- **Customer invoices** use one concept per tax category by default (90101501 / E48, sku = ticket
  folio). Itemized concepts are used only when fiscal marks every line valid, no refund is netted
  and the per-line IVA adds up to the category's IVA; otherwise the builder falls back to grouped
  concepts and reports why (`itemizedFallback`). This covers the fiscal-core note that a tiny line
  can fall outside SAT's per-concept tolerance.
- **Globals**: PUBLICO EN GENERAL / XAXX010101000 / 616 / S01 with InformacionGlobal, one
  01010101 / ACT "Venta" concept per ticket per category in folio order, at most 4,000 concepts
  per part (a ticket is never split), FormaPago of the largest ticket.
- **Credit notes (egresos)**: related 01 to the parent UUID, G02 when the receptor's régimen
  allows it, else S01; one 84111506 / ACT concept per refunded category. Facturapi's egreso
  products have no `sku`, so the folio is in the description. Their expected IVA is
  `extract(refund gross)`, which may differ from fiscal's adjustment IVA by at most 1 centavo per
  category (unit test 15d).

## Using the fake

`npm run dev:facturapi-fake` serves it on `127.0.0.1:4799` (`--port` or `FACTURAPI_FAKE_PORT`);
point `FACTURAPI_BASE_URL=http://127.0.0.1:4799/v2` at it. Tests use it in process through
`fake.fetch` (no sockets). Any `sk_user_…` key is the platform User key; an unknown `sk_test_…`
key gets a ready shared sandbox organization. A receptor name containing one of these words
triggers a documented provider behaviour: `FAKE NAME MISMATCH`, `FAKE RFC NOT FOUND`,
`FAKE ZIP MISMATCH`, `FAKE REGIME MISMATCH`, `FAKE PAC REJECT`, `FAKE STAMP FAILED`,
`FAKE UNAVAILABLE`, `FAKE RATE LIMIT`, `FAKE PENDING`, `FAKE PENDING FAILED`, `FAKE TIMEOUT`,
`FAKE LOST RESPONSE`, `FAKE ROUNDING`, `FAKE SIX DECIMALS`, `FAKE CANCEL PENDING`,
`FAKE REJECT CANCEL` (details in the file header). `FAKE SIX DECIMALS` keeps each concept's Base
and Importe at 6 decimals and rounds only the comprobante sums (the other reading of Facturapi's
rounding, decision D18), so the stamped IVA can differ from `canonicalTax` by a centavo. Globals
are always PUBLICO EN GENERAL, so their faults are queued with `POST /__fake/faults` (or
`fake.fault()`). The queued-only fault `conflict` answers `POST /invoices` with 409 `conflict`
before the idempotency lookup, like a retry colliding with a request still in process. Passing
against the fake proves cfdi's own logic, not Facturapi's behaviour.

## Tests

`npm test` runs, without network or database:

- `tests/cfdi-facturapi-contract.test.ts`: fixture provenance and documented fields, request
  shapes against the vendored OpenAPI subset (fields, enums, limits), every client call's path,
  headers and body, error mapping, and strict test/live separation (spec §7.2, items 0–8).
- `tests/cfdi.test.ts`: builders (spec unit tests 9–14), `netGroups` refusals and a seeded
  2,000-case property test, the rounding proof (15), the egreso bound (15d), the XML parser (16)
  and the error classifier (20).
- `tests/cfdi-facturapi-fake.test.ts`: the fake driven through the real client and builders.

## Open items found while building the core

- **Egreso to PUBLICO EN GENERAL.** Anexo 20 expects InformacionGlobal when the receptor is
  XAXX010101000 named PUBLICO EN GENERAL, but Facturapi's `InvoiceEgresoInput` has no `global`
  field. The credit note for a global parent is built as the spec says; the sandbox must confirm
  Facturapi accepts it.
- **Rounding assumption (decision D18).** That Facturapi rounds each tax-inclusive concept half up
  is documented nowhere; the opt-in sandbox run decides. Itemized lines with quantity > 1 assume
  the concept's IVA is extracted from quantity × unit price.
- **Fiscal refund split (prerequisite for the amount check).** On this branch fiscal's
  `refundTaxSplit` is cumulative (`tax = extract(before + amount) − extract(before)`), so a netted
  group's IVA is `ticket IVA − extract(total refunded)`, which can differ from `extractTax(net
  gross)` (what Facturapi stamps) by up to 1 centavo per category, **for refunds recorded after
  the ticket as well**, not only pre-ticket ones. The spec's deliver step would label that
  difference `pre_ticket_refund_bound`, which is wrong for post-ticket refunds. Before the
  deliver/amount-check integration, either fiscal adopts the complement extraction or cfdi sets an
  explicit expected-IVA policy; spec tests 15b/15c wait for that decision. A credit note's
  `fiscalTax` (Σ `adj.tax`) differs from its canonical IVA for the same reason.
- **Documentation gaps (sandbox checks).** The HTTP status of `idempotency_key_in_use` is not
  documented (cfdi classifies by code); what `POST /invoices` answers when a retried
  `idempotency_key` already produced a stamped invoice is not documented (cfdi adopts on any 409
  that is not a final state and on `invoice_already_stamped`); `RelatedDocumentInput` lists
  `related` as required while its property is `documents` (cfdi sends `documents`). The response
  schema assumes every invoice object carries `status`.

## Integration blockers (before any wiring)

- `server/cfdi/config.ts` must refuse `FACTURAPI_BASE_URL` in deployed environments (spec §4.10).
  The client already refuses a non-official URL when `APP_ENV` is staging or production.
- The retry codes `cfdi_provider_in_progress` and `cfdi_provider_already_stamped` need Spanish and
  English text in `src/i18n/cfdi.ts` if the stuck-document view shows the last job code.
- A stamping job records a stamp only through `stampFacts`, and on `unknownOutcome` writes the
  `stamp_unknown` event and adopts by `external_id`; it never fails the document or releases its
  claims on such an outcome.
- `.gitleaksignore` (repo root, added by this track) pins three findings in this branch's history
  (commits `4deb907`, `df8d424`) whose values are fake test keys. Keep it if the merge keeps the
  branch history; drop it after a squash merge, where it would be dead config.

## Pending (spec implementation steps)

1 `shared/cfdi.ts`; 2 migration 030 and grants; 5 vault, CSD inspection, config and worker boot
(including the `sk_user` log redaction); 7 store and jobs; 8 and 11 worker handlers; 9 web
service, routes and `/capabilities`; 10 self-invoicing portal; 12–13 client; 14 cross-area wiring
(fiscal refund hook, reports, discounts notice); 15 browser tests and CI; 16 the opt-in sandbox
script (`RECORD=1` rewrites fixtures as `recorded@<date>`); 17 the remaining docs (README,
DELIVERY_STATUS, COMPLETION_LEDGER, INFRASTRUCTURE, RUNBOOK, OPERATIONS, ARCHITECTURE).

## Sources

- Facturapi OpenAPI v2 and guides (`getting-started/errors.mdx`,
  `guides/invoices/intermitencias.mdx`, `guides/organizations.mdx`): FacturAPI/facturapi-docs,
  commit `1c2e617776da4600ce3bac02a6aab6b0b3fcc88a` (2026-09-19).
- Facturapi Node SDK types and multipart field names: Context7 `/facturapi/facturapi-node`.
- zod 4.3.6 (`z.looseObject`, `z.email`, strict objects): Context7 `/colinhacks/zod`.
- SAT Anexo 20 (CFDI 4.0) and the "Guía de llenado del CFDI global"; SAT cancellation FAQ 2026.
