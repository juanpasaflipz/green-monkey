# Facturapi fixtures

Replayed by `tests/cfdi-facturapi-contract.test.ts` through an injected `fetch`. No test in
`npm test` contacts Facturapi.

## Provenance

No Facturapi key exists yet, so **nothing here was recorded from Facturapi**. Every response
fixture is an envelope:

```json
{
  "provenance": "docs@1c2e617",
  "source": "openapi_v2.en.yaml#/paths/~1invoices/post/responses/200",
  "status": 200,
  "headers": { "content-type": "application/json; charset=utf-8" },
  "body": { "...": "..." },
  "note": "what is documented and what is authored",
  "sdk_fields": ["legal.tax_id"]
}
```

| `provenance` | Meaning |
| --- | --- |
| `docs@1c2e617` | **Authored** from the official API documentation at FacturAPI/facturapi-docs commit `1c2e617` (2026-09-19): the OpenAPI v2 schema in `openapi-v2-subset.json` and, for errors, `getting-started/errors.mdx`. `note` says which values are documented examples (verbatim) and which were written by hand. |
| `recorded@YYYY-MM-DD` | Rewritten from a real Facturapi **test-mode** response on that date by the opt-in sandbox script (`tests/cfdi-facturapi-sandbox.ts` with `RECORD=1`, spec §7.4), with keys and personal data redacted. That script is not built yet. |

`source` is a JSON pointer into `openapi-v2-subset.json` (the file name stands for the upstream
`website/openapi_v2.en.yaml`). The contract test checks that every `docs@` fixture's pointer
resolves in the subset and that every body field exists in the documented response schema.
`sdk_fields` lists fields the OpenAPI schema lacks but the official Node SDK types have
(Context7 `/facturapi/facturapi-node`); today only the organization's `legal.tax_id`.

Until the invoice, cancellation and organization fixtures are `recorded@…`, CFDI is
**contract-tested against the documentation, not sandbox-verified** (docs/CFDI.md).

## `openapi-v2-subset.json`

The operations cfdi calls (`/invoices`, `/invoices/{id}`, `/invoices/{id}/{format}`,
`/invoices/{id}/cancellation_receipt/{format}`, `/invoices/{id}/email`,
`/invoices/{id}/status`, `/organizations`, `/organizations/me`, `/organizations/{id}`,
`/organizations/{id}/legal`, `/organizations/{id}/certificate`,
`/organizations/{id}/apikeys/test`, `/organizations/{id}/apikeys/live`) and the schemas of the
fields cfdi sends and reads, copied from `website/openapi_v2.en.yaml` at commit
`1c2e617776da4600ce3bac02a6aab6b0b3fcc88a` (YAML converted to JSON, no edits). Schemas outside
that set (complements, third parties, local taxes, …) are replaced by `{"x-pruned": true}` stubs
so every `$ref` still resolves; code samples are dropped. `x-provenance` at the top records the
source.

To refresh it, convert the upstream YAML at the new commit to JSON, keep the same operations and
schema list, update the commit everywhere (`x-provenance`, the fixtures' `provenance`,
`server/cfdi/facturapi-schema.ts`, docs/CFDI.md) and rerun `npm test`.

Two documentation facts the tests rely on and that are easy to miss:

- `RelatedDocumentInput` lists `related` as required, but its properties (via `RelatedDocument`)
  are `relationship` and `documents`; cfdi sends `documents` (the field the schema defines).
- The HTTP status of `idempotency_key_in_use` is not documented for `POST /invoices`; the
  fixture uses 409 (the documented Conflict response). cfdi classifies by `code`, not by status.

## Other fixtures

- `../cfdi/sample-cfdi40.xml`: an authored CFDI 4.0 global invoice for the XML amount parser.
