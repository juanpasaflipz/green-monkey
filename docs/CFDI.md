# CFDI (Facturapi)

**Status.** CFDI: implemented and contract-tested against Facturapi's documented API (fixtures
`docs@1c2e617`), not sandbox-verified; disabled until Facturapi keys are configured; live mode not
enabled. No Facturapi key was used and no request reached Facturapi. Only after
`npm run test:facturapi:sandbox` passes with a real test key may a flow be called
"sandbox-verified on <date>".

**Branch status (track `cfdi`, migration 030).** Built on platform 2.0 **before** fiscal 027 and
discounts 028 merged. Every worker path is DB-tested against a test-only stand-in of the 027
tables (`tests/fixtures/cfdi/fiscal-027-standin.sql`) and the compat shims listed under
"Rebase onto fiscal and discounts"; the stamping browser flows skip themselves until fiscal's
`GET /api/fiscal/context` exists. Read that section before merging.

The design is the cfdi area spec (migration 030); this page is the operating and engineering
reference.

## Regulatory and provider model

- **Global invoice** (RMF 2.7.1.21, SAT "Guía de llenado del CFDI global" v4.0): receptor
  `XAXX010101000` / `PUBLICO EN GENERAL` / régimen 616 / uso S01, `InformacionGlobal`
  (Periodicidad 01 diaria, 02 semanal, 03 quincenal, 04 mensual; Meses; Año), one concept per
  ticket per IVA category (`01010101`, `ACT`, "Venta", quantity 1, `NoIdentificacion` = ticket
  folio), FormaPago of the largest ticket, issued within 24 h after the period closes, IVA
  separated. RESICO (626) issues it monthly (decision D4, accountant to confirm).
- **Nominative invoice after a global** (SAT cancellation FAQ 2026, Q6, Q10, Escenario 4):
  cancel the global with motive 04, issue the replacement without the ticket, then the invoice.
- **Cancellation**: motives 01 (substitute first, its UUID sent), 02, 03, 04. No receptor
  acceptance for público en general, totals up to $1,000.00, egresos or cancellations within
  24 h; otherwise the receptor has 3 business days and silence on a first request is acceptance.
- **Refunds after a CFDI** (global guide, Apéndice 2, route I): a CFDI de egreso related 01.
- **RESICO ISR retention** (LISR 113-J, LD-16 L9): a nominative invoice from an issuer in régimen
  626 with a persona-física RFC (13 characters) to a persona moral (12 characters) carries an ISR
  withholding of 1.25 % per concept (`{type: "ISR", rate: 0.0125, factor: "Tasa", withholding:
  true}`, Facturapi `taxes[]`, checked with Context7 `/facturapi/facturapi-node` and the vendored
  OpenAPI `BaseTax`). Those concepts are base-priced (`tax_included: false`) so the retention is
  computed on the base. Globals never carry it. `amount_check` compares pre-retention totals.
  **The restaurant's accountant must confirm this behaviour before the pilot.**
- **Facturapi keys.** A **User key** (`sk_user_…`) creates organizations and fetches their keys.
  Each organization has a **test key** (`sk_test_…`: not sent to SAT, no fiscal validity, free)
  and **live keys** (`sk_live_…`). The key decides the environment and the issuer. CSD upload is
  `PUT /organizations/{id}/certificate`; legal data `PUT /organizations/{id}/legal`
  (`legal_name` ≤ 100); live stamping also needs an active subscription and the Carta
  manifiesto signed with the e.firma (`is_production_ready`, `pending_steps`).

## Environment matrix

cfdi runs only in a **worker with `WORKER_DATABASE_URL`** (the Wave 2.0 jobs runner login,
member of `gm_jobs_worker`). The web process never holds Facturapi keys or
`CREDENTIAL_ENCRYPTION_KEY`; it reads what the worker published in `cfdi_platform`.

| Worker env | `cfdi_platform.provider` | Meaning |
| --- | --- | --- |
| no `WORKER_DATABASE_URL`, or neither Facturapi key | `disabled` (row absent or written so) | Settings says "La facturación electrónica no está configurada en este entorno."; commands answer `cfdi_unavailable`; `/capabilities` `facturapi: {enabled:false, reason:"provider_not_configured"}` |
| `FACTURAPI_TEST_KEY=sk_test_…` only, `APP_ENV` ≠ production | `sandbox_shared` | staging/dev rehearsal: every restaurant stamps test CFDIs through the platform's sandbox organization; no CSD upload, no live mode |
| `FACTURAPI_API_KEY=sk_user_…` + `CREDENTIAL_ENCRYPTION_KEY` | `organizations` | one Facturapi organization per restaurant, each starting in test mode with its own `sk_test_` key |

Live is possible only with `provider = organizations`, `APP_ENV=production` and
`CFDI_LIVE_ENABLED=true` on the worker. Configuration errors (`server/cfdi/config.ts`, checked by
`server/config-rules.ts` between its area markers) name variables, never values:

| Process | Variable | Rule (ConfigError) |
| --- | --- | --- |
| worker | `FACTURAPI_API_KEY` | must start `sk_user_` (`invalid_facturapi_api_key`); requires `CREDENTIAL_ENCRYPTION_KEY` (`missing_credential_encryption_key`) |
| worker | `FACTURAPI_TEST_KEY` | must start `sk_test_` (`invalid_facturapi_test_key`); alone with `APP_ENV=production` → `cfdi_shared_sandbox_not_allowed` |
| worker | `CREDENTIAL_ENCRYPTION_KEY` | `kid:base64url(≥ 32 bytes)[,kid:…]`, kid `^[a-z0-9-]{1,32}$`, first entry seals (`invalid_credential_encryption_key`) |
| worker | `CFDI_LIVE_ENABLED` | `true` only with `APP_ENV=production` and a User key (`cfdi_live_not_allowed`) |
| worker | `CFDI_GLOBAL_GRACE_MINUTES` | 0–600, default 60 (`invalid_cfdi_global_grace_minutes`) |
| worker, deployed | any Facturapi key | needs `WORKER_DATABASE_URL` (`cfdi_worker_database_required`) |
| both | `FACTURAPI_BASE_URL` | development/test only, loopback host only: the fake (`cfdi_base_url_not_allowed`) |
| web | `CFDI_INVOICE_LINK_EXPIRY_HOURS` | 1–168, default 72: lifetime of the portal request links (`invalid_cfdi_invoice_link_expiry_hours`) |

Wave 2.0 forbids the Facturapi keys, `CREDENTIAL_ENCRYPTION_KEY`, `CFDI_LIVE_ENABLED` and
`WORKER_DATABASE_URL` in a deployed web, and `MIGRATION_DATABASE_URL` in both processes.
Registration in `.railway/railway.ts` and `.env.example` is Wave 2.0's.

## Onboarding runbook

1. **Platform account.** Create the platform's Facturapi account and its User key. Generate the
   credential key with `node scripts/cfdi-generate-credential-key.mjs` (prints one
   `YYYY-MM:<base64url>` entry; paste it only into the worker's environment).
2. **Worker env.** Set `FACTURAPI_API_KEY`, `CREDENTIAL_ENCRYPTION_KEY` and (already there)
   `WORKER_DATABASE_URL` on the `worker` service. On boot the worker lists organizations with the
   User key, computes the CSD upload key pair and publishes `cfdi_platform`. A refused key
   publishes `disabled` and raises `cfdi_provider_auth_failed`.
3. **Restaurant activation** (owner, PIN step-up): Configuración → "Facturación electrónica
   (CFDI)". Prerequisites: platform available, fiscal profile complete, currency MXN, legal name
   ≤ 100 characters. **Activar en modo prueba** creates the settings (mode `test`, `test_from` =
   today) and the organization (`provisioning`); the worker finds or creates it by a name marker
   (never two), pushes the legal data and seals the organization's test key.
4. **CSD** (owner, step-up): upload the `.cer`, `.key` and password. The web process checks
   them locally (RFC = fiscal profile RFC, validity, key pair, password, not an e.firma), seals
   them to the worker's X25519 key (`cfdi_secrets`, unreadable by `gm_app`) and queues
   `cfdi_csd`; the worker sends them to Facturapi once and wipes the box. The password is never
   stored or logged.
5. **Carta manifiesto.** The owner signs it on Facturapi's portal with the e.firma; the live
   checklist links to it while `pending_steps` mentions it.
6. **Live.** On the production worker set `CFDI_LIVE_ENABLED=true`. The owner then chooses
   "Incluir en las facturas globales los tickets desde" (default: start of the current global
   period) and presses **Pasar a modo real** (step-up). The worker creates the live key and
   switches the mode. Irreversible: live → test is refused by the settings trigger.

### Credential key rotation

1. Generate a new entry and prepend it: `CREDENTIAL_ENCRYPTION_KEY=<new>,<old>`; redeploy the
   worker (it now seals with the new kid and still opens the old one).
2. Run `npm run cfdi:rekey` in the worker environment (needs `WORKER_DATABASE_URL` and the
   two-entry key; prints counts only; safe to repeat).
3. Remove the old entry and redeploy. CSD upload boxes are wiped after use and need no re-seal.

### Restore

Organization keys are stored sealed (JWE `dir`/A256GCM, header bound to tenant, purpose and row).
A restore needs the keyring that sealed them. Without it: test keys are re-fetched with the User
key (`GET /organizations/{id}/apikeys/test`) and live keys re-created
(`PUT /organizations/{id}/apikeys/live`; older live keys stay valid until revoked in Facturapi).
CSD files are never kept, so nothing else is lost.

## Process and credential model

- The **worker** (Railway login `gm_<env>_worker`, role `gm_jobs_worker`) is the only holder of
  provider secrets. It never holds `MIGRATION_DATABASE_URL`; migrations and grants run from
  GitHub Actions as `gm_migrator`. `scripts/ops/sql/globals.sql` must run before the first wave-2
  migrate (030 creates `gm_jobs_worker` only if missing).
- The **web** process seals CSD uploads to the published X25519 key (`ECDH-ES`) and reads
  documents, files and settings under `gm_app` with RLS.
- Discovery: the policy `jobs_worker_discover` lets the worker login see due `cfdi_%` jobs of
  every tenant (ids and flags only in payloads); claims and writes stay tenant-fenced. Running
  jobs whose lease expired are found by discovery, the claim and `expireLostJobs` through
  `jobs_running_lease_until (tenant_id, kind, lease_until) WHERE state = 'running'` (LD-21,
  RUNBOOK PLATFORM-OPS-10), not by scanning a tenant's done jobs; DB check 17e EXPLAINs all three.
- `tests/import-graph.test.ts` asserts the boundary: `server/index.ts` never reaches the worker
  registry, `server/cfdi/worker/*`, the vault or the Facturapi client; the worker never reaches
  `server/tokens.ts`, `server/orders.ts`, `server/fiscal.ts`, `server/index.ts`,
  `server/routes/*`, `server/cfdi/service.ts` or `server/cfdi/portal.ts` (LD-16 L4).

## Data model (migration 030)

| Table | Holds |
| --- | --- |
| `cfdi_platform` | the worker's published provider state (one row, no tenant) |
| `cfdi_settings` | per restaurant: enabled, mode, start dates, periodicity, concept mode, card form, default use, self-invoicing window, portal reissue, support email, version |
| `cfdi_secrets` | sealed organization keys and CSD upload boxes (worker-readable only) |
| `cfdi_organizations` | Facturapi organization, legal sync version, CSD state, production readiness |
| `cfdi_csd_uploads` | each upload attempt (serial, validity, outcome) |
| `cfdi_documents` | invoices, globals, egresos: frozen request, expected and stamped amounts, withholding, status, amount check |
| `cfdi_document_tickets` | claims of fiscal tickets by documents (`pending`, `active`, `released`) |
| `cfdi_cancellations` | cancellation requests and their outcome |
| `cfdi_files` | XML, PDF and cancellation acuses (5-year retention) |
| `cfdi_events` | append-only history per document and per restaurant |
| `cfdi_global_periods` | each global period per mode: close, due, status, late tickets |

Invariants: one active or pending claim per ticket and mode (DB-enforced), frozen requests and
stamp fields are write-once, documents, claims, files and events reject UPDATE/DELETE/TRUNCATE
outside the worker's allowed transitions, every table is `ENABLE`+`FORCE` RLS `tenant_scope`
with composite tenant foreign keys.

## Jobs

Nine kinds, all worker-only (`registerWorkerJobHandler`), discovered every 5 s:

| Kind | Does | `maxAttempts` |
| --- | --- | --- |
| `cfdi_org` | provision, refresh, legal sync, go live | 8 |
| `cfdi_csd` | send a sealed CSD once, wipe it | 3 |
| `cfdi_stamp` | freeze the request from fiscal's figures and stamp (12 per invoice, 20 per global) | 20 |
| `cfdi_deliver` | download XML/PDF, amount check, email | 8 |
| `cfdi_cancel` | cancel at Facturapi | 12 |
| `cfdi_reconcile` | poll pending stamps and cancellations | 3 |
| `cfdi_global` | period ticks: build parts, late supplementary parts, overdue alerts, refund sweep | 20 |
| `cfdi_refund` | decide and build the egreso of a refund | 60 |
| `cfdi_reissue` | motive-04 replacement of a global, then the waiting invoices | 20 |

Retries never send two invoices: the document id is Facturapi's `idempotency_key` and
`external_id`, and after an unknown outcome (timeout, network, 5xx) the next attempt first adopts
by `external_id`. Pending stamps (202) are polled every 10 min (8 times, then
`cfdi_stamp_unresolved` and every 6 h up to 12); cancellations every 30 min for 5 days, then
every 6 h up to 10 days. A document in `queued` or `stamping` with no change for 30 minutes shows
**Atascada**: press **Reintentar** in Facturas emitidas (it adopts an existing invoice by
`external_id` instead of stamping twice).

Recovery (`server/cfdi/recovery.ts`):

- **CFDI unavailable in the worker** (no Facturapi keys on the deploy, or the boot check got a
  401): a claimed cfdi job does not use up attempts. It hands over to a fresh copy of itself
  (`<dedupe key>:wait:<k>`, same payload) due in 15 minutes, doubling to 6 hours, and completes.
  When the keys are back every pending state resumes.
- **A job that ended without finishing the state** (a poll chain stopped or died, a cancellation
  never sent, a stopped reissue, files never stored): every global tick runs a recovery sweep
  over documents unchanged for 30 minutes and re-enqueues, at most once a day and only when no
  live job serves the document, the poll of a `pending` stamp or a `canceling` cancellation, the
  cancellation, the reissue step or the download; invoices still `waiting` on a replacement
  global that already finished are queued. A manager can do the same at once with
  **Reintentar** on the document (pending, canceling, a queued cancellation, missing files).
  Reconcile chains merge: a poll does not schedule the next one while another chain of the same
  document already has one waiting.
- **The global tick chain** never ends: a tick that keeps failing schedules a fresh tick at the
  next hour before it goes dead (`jobs_dead_cfdi_global` still alerts), and a restaurant with
  CFDI enabled and no live tick gets one back at the worker boot (`seedGlobalTicks`, restaurants
  found through their `cfdi_global` jobs) and at every operator sign-in (`GET /cfdi/status`,
  `ensureTick`, one insert per 10 minutes at most).
- **Substitution after a rejected cancellation**: when the receptor rejects (or lets expire) the
  motive-01 cancellation, both invoices stay valid and the substitute's claim waits (pending;
  alert `cfdi_substitution_rejected`). Cancelling the original again (**Cancelar**, motive 02 or
  03) hands the ticket to the newest valid substitute as soon as the original is canceled
  (`substitution_completed`), exactly as an accepted motive-01 cancellation does; later refunds
  get credit notes related to the substitute (CFDI-R2-4). Cancelling the substitute instead
  leaves the original in force.
- **Advisory keys** (LO-3, `server/cfdi/locks.ts`): per-ticket (class 926), then per-document
  (927), then per-period (928), never the reverse; `tests/cfdi-locks.test.ts` checks the order.
- **Invoice after a global**: the web request and `cfdi_reissue` take the same per-document key
  of the global (LO-3). The request re-reads the global and the ticket's claim under the key; if
  the reissue already canceled the global it answers `cfdi_global_in_progress`, and the retry
  lands on the replacement global once it is valid. A motive-04 cancellation is only inserted
  for a valid global. The replacement's part number is taken under the period key, after the
  global's document key, as the builder numbers its parts; `cfdi_documents_period` is unique per
  (mode, period, part) (CFDI-R2-5).

## Global periods

Membership is the ticket's fiscal `business_date` (decision D5, binding). A period is built at
close + `CFDI_GLOBAL_GRACE_MINUTES` (60) and is due at close + 24 h. A late ticket (offline sync,
repair, or released by a cancellation) goes into a **supplementary part of its own period** at
the next tick, never into the next open period; a part created after `due_at` is flagged
"Emitida fuera de plazo", shown overdue until stamped and alerted (`cfdi_global_late`). Parts hold
at most 4,000 concepts; a ticket is never split. With automatic emission off, periods wait for
**Emitir ahora**.

**Periodicity changes** never reshape a date that already has a period row (CFDI-R2-1). Before
any row exists (right after activation, until the first tick) a change applies at once; after
that it is stored as pending from the first day of next month ("El cambio aplica desde el …").
Each tick adds rows only after the mode's last one: a period in the month of the previous row
continues that row's periodicity, a new month takes the periodicity in force on its first day,
and the tick adds the rows before it promotes a pending change, so a month that closed under
the old periodicity stays one partition of it even when the first tick after the change runs
days later; late tickets then join a supplementary part of their own period (D5) with its own
periodicity.

## Amounts

- Concepts are tax-inclusive (`tax_included: true`, quantity 1, price = fiscal's net gross).
  For 16 % and 8 % no rounding ties exist, so the stamped IVA equals fiscal's
  `extractTax(gross)` (unit test 15). RESICO-withheld concepts are base-priced instead.
- Netted refunds use fiscal's figures (`ticket group − adjustments` per category). Egresos stamp
  `extract(adj.gross)`, at most 1 centavo per category from fiscal's `adj.tax`.
- `amount_check` on every stamped document: `exact`, or `differs` with a reason
  (`pre_ticket_refund_bound`, `egreso_extract`, `base_priced_rounding`: expected, no alert;
  `provider_rounding`: alerts `cfdi_amount_mismatch`).

## Operations

| Alert key | Severity | Action |
| --- | --- | --- |
| `cfdi_provider_auth_failed` | critical | the User key or an organization key was refused: check the worker's `FACTURAPI_API_KEY`; for one restaurant, its organization in Facturapi |
| `cfdi_global_overdue:<tenant>:<mode>:<period>` | warning | the period passed its 24 h deadline unstamped: open Facturas globales, **Emitir ahora**, check Facturapi status |
| `cfdi_global_late:<tenant>:<mode>:<period>:p<n>` | warning | a supplementary part was created after the deadline (late tickets): confirm it stamps |
| `cfdi_global_failed:<tenant>:<doc>` | warning | a global part failed: read the provider error in its detail, fix, **Reintentar** |
| `cfdi_ticket_excluded:<tenant>:<mode>:<period>` | warning | tickets left out of a global (inconsistent fiscal figures): check fiscal's ticket register |
| `cfdi_amount_mismatch:<tenant>:<date>` | warning | stamped amounts differ from fiscal's beyond the documented bounds: compare the XML with the ticket; report to engineering |
| `cfdi_substitution_rejected:<tenant>:<doc>` | warning | the customer rejected a substitution: two invoices are valid; cancel the new one (02) or ask again |
| `cfdi_stamp_unresolved:<tenant>:<doc>` | warning | Facturapi kept the stamp pending past its recovery window: check the invoice in Facturapi |
| `cfdi_cancel_unresolved:<tenant>:<doc>` / `cfdi_cancel_failed:<tenant>:<doc>` | warning | a cancellation is unanswered after 10 days / was refused: read the detail, repeat or handle at the SAT portal |
| `cfdi_refund_unresolved:<tenant>:<refund>` | warning | a refund's credit note could not be issued: check its parent document; the refund sweep retries |
| `cfdi_reissue_failed:<tenant>:<doc>` | warning | a global replacement (motive 04) was refused: read the detail; the waiting invoices fail (their tickets are freed) and must be requested again once the cause is fixed |
| `cfdi_csd_expiring:<tenant>` | info | the CSD expires in less than 30 days: the owner uploads a new one |
| `jobs_dead_cfdi_<kind>` | warning | a job exhausted its attempts (Wave 2.0 runner). Nothing is lost: the tick's recovery sweep re-enqueues what the document still needs within a day, or press **Reintentar** on it. `jobs_dead_cfdi_global`: a fresh tick was already scheduled at the next hour; if the cause persists (read the job's `error_code`), the chain also restarts at the next worker deploy and the next sign-in |

`<tenant>` is the first 8 hex characters of the tenant id. Alerts carry codes, counts and ids,
never names, RFCs, emails or amounts. Retention never deletes `cfdi_*` rows. A production deploy
that first carries 030 runs before 07:00 Mexico City (its `jobs` index blocks job inserts while it
builds; docs/RUNBOOK.md).

## Customer portal

`{origin}/f/{CODE}` (the printed QR) and `{origin}/factura` render the lazy
`SelfInvoicePortal` outside the staff app, without the service worker. Lookup, submission, access
and status are limited per IP (30, 6, 10 and 60 per minute; key `clientIp`, IPv6 /56) and to 5
submissions per ticket per 24 h. Downloads need the RFC used, through 15-minute download tokens;
request links last `CFDI_INVOICE_LINK_EXPIRY_HOURS`. Account 031 fills the privacy-notice anchor
in `server/cfdi/portal.ts`.

## Error codes (LD-15 cfdi Q2)

The approved core codes win; each spec §5.5 Spanish string moved to the core code with the same
meaning. Renamed spec codes:

| Spec code | Code the API returns |
| --- | --- |
| `cfdi_stamp_rejected` | `cfdi_stamping_rejected` |
| `cfdi_provider_auth` | `cfdi_provider_auth_failed` |
| `cfdi_org_incomplete` | `cfdi_org_not_ready` |
| `cfdi_provider_subscription` | `cfdi_org_not_ready` (Facturapi reports the subscription with the organization codes) |
| `cfdi_provider_error` | `cfdi_unexpected_error` (and `cfdi_provider_invalid_request`, same text) |

Every code and its Spanish text (`src/i18n/cfdi.ts`, for acceptance `[BIND-030]`):

| Code | Spanish |
| --- | --- |
| `cfdi_acuse_unavailable` | El acuse de cancelación aún no está disponible. |
| `cfdi_attempts_exhausted` | Se agotaron los reintentos automáticos. Usa Reintentar en Facturas emitidas. |
| `cfdi_base_url_not_allowed` | Configuración inválida: la dirección de Facturapi no está permitida. |
| `cfdi_cancel_in_progress` | Ya hay una cancelación en proceso para esta factura. |
| `cfdi_cancel_rejected_provider` | Facturapi o el SAT rechazaron la cancelación. Revisa el detalle. |
| `cfdi_cancellation_in_progress` | Ya hay una cancelación en proceso para esta factura. |
| `cfdi_card_form_required` | Indica si el pago con tarjeta fue de crédito o débito. |
| `cfdi_csd_expired` | El certificado está vencido. Tramita un nuevo CSD en el portal del SAT. |
| `cfdi_csd_invalid` | El certificado o la clave no son válidos o están dañados. |
| `cfdi_csd_is_fiel` | Este archivo es tu e.firma (FIEL), no un CSD. |
| `cfdi_csd_key_mismatch` | La clave privada no corresponde al certificado. |
| `cfdi_csd_not_supported` | En el entorno de prueba compartido no se suben certificados. |
| `cfdi_csd_not_yet_valid` | El certificado aún no es vigente. |
| `cfdi_csd_password` | La contraseña de la clave privada es incorrecta. |
| `cfdi_csd_rfc_mismatch` | El RFC del certificado no coincide con el RFC de tus datos fiscales. |
| `cfdi_csd_upload_in_progress` | Ya hay un certificado en proceso. Espera a que termine. |
| `cfdi_currency_unsupported` | La facturación requiere que el restaurante use MXN. |
| `cfdi_disabled` | La facturación electrónica está desactivada para este restaurante. |
| `cfdi_duplicate_external_id` | Facturapi tiene más de una factura para este documento. Avisa a soporte. |
| `cfdi_duplicate_ticket` | Un ticket aparece dos veces en la factura global. Avisa a soporte. |
| `cfdi_email_delivery_failed` | Facturapi no pudo entregar el correo. Revisa la dirección. |
| `cfdi_email_not_allowed` | Esta factura no se puede enviar por correo en su estado actual. |
| `cfdi_email_recipient_required` | Falta el correo del destinatario. |
| `cfdi_email_required` | Escribe un correo para enviarte la factura. |
| `cfdi_file_not_ready` | El archivo aún no está disponible. Intenta en unos segundos. |
| `cfdi_fiscal_profile_incomplete` | Completa los datos fiscales del restaurante antes de activar la facturación. |
| `cfdi_generic_rfc` | Para público en general no se emite factura individual: el ticket se incluye en la factura global. |
| `cfdi_global_error` | No se pudo preparar la factura global. Lo reintentaremos automáticamente. |
| `cfdi_global_in_progress` | La factura global de este periodo se está emitiendo. Intenta en unos minutos. |
| `cfdi_has_credit_notes` | Cancela primero las notas de crédito relacionadas. |
| `cfdi_invalid_email` | Escribe un correo electrónico válido. |
| `cfdi_invalid_legal_name` | Escribe el nombre o razón social (hasta 254 caracteres). |
| `cfdi_invalid_motive` | Las facturas globales solo se cancelan con el motivo 02. |
| `cfdi_invalid_payload` | Una tarea de facturación tiene datos inválidos. Avisa a soporte. |
| `cfdi_invalid_postal_code` | El código postal debe tener 5 dígitos. |
| `cfdi_invalid_regime` | Elige un régimen fiscal del catálogo del SAT. |
| `cfdi_invalid_rfc` | El RFC no tiene un formato válido (12 caracteres para empresa, 13 para persona física). |
| `cfdi_invalid_settings` | Revisa los valores de la configuración. |
| `cfdi_key_kind` | Se usó una llave de Facturapi que no corresponde a la operación. Avisa a soporte. |
| `cfdi_key_prefix` | La llave que entregó Facturapi no tiene el formato esperado. Avisa a soporte. |
| `cfdi_legal_name_too_long` | Facturapi admite razones sociales de hasta 100 caracteres. Contacta a soporte. |
| `cfdi_live_from_invalid` | Elige una fecha entre el inicio del periodo actual y hoy. |
| `cfdi_live_key_required` | Esta operación requiere la llave de modo real de la organización. |
| `cfdi_live_not_allowed` | Configuración inválida: el modo real solo se permite en producción. |
| `cfdi_live_not_enabled` | El modo real no está habilitado en la plataforma. |
| `cfdi_live_requirements` | Aún faltan requisitos para el modo real. Revisa la lista. |
| `cfdi_mode_mismatch` | La respuesta de Facturapi no corresponde al modo (prueba/real). No se registró. |
| `cfdi_not_ready` | La organización emisora aún no está lista. Revisa Ajustes → Facturación electrónica. |
| `cfdi_not_retryable` | Este documento no se puede reintentar. |
| `cfdi_not_substitutable` | Solo las facturas a clientes se pueden sustituir. |
| `cfdi_not_valid` | Solo se puede hacer esto con una factura vigente. |
| `cfdi_nothing_to_invoice` | No queda importe por facturar en este ticket. |
| `cfdi_org_key_invalid` | La llave de la organización ya no es válida. Avisa a soporte. |
| `cfdi_org_not_ready` | La organización emisora está incompleta en Facturapi. |
| `cfdi_org_tax_info_invalid` | Facturapi rechazó los datos fiscales del restaurante. Revisa Datos fiscales. |
| `cfdi_parent_canceling` | La factura original está en cancelación; la nota de crédito espera el resultado. |
| `cfdi_parent_not_valid` | La factura original aún se está timbrando; la nota de crédito se emitirá después. |
| `cfdi_parent_receptor_missing` | La factura original no tiene receptor; no se puede emitir la nota de crédito. |
| `cfdi_period_not_closed` | Ese periodo aún no cierra. |
| `cfdi_portal_code_not_found` | No encontramos ese código. Revisa que esté completo (12 caracteres). |
| `cfdi_portal_expired` | El plazo para facturar este ticket terminó. Pide tu factura directamente al restaurante. |
| `cfdi_portal_rfc_mismatch` | No encontramos una factura de este ticket para ese RFC. |
| `cfdi_portal_too_many_attempts` | Demasiados intentos para este ticket. Intenta mañana o pide tu factura en el restaurante. |
| `cfdi_portal_unavailable` | Este restaurante no ofrece facturación en línea para este ticket. Pide tu factura en el restaurante. |
| `cfdi_product_key_invalid` | La clave de producto SAT no existe en el catálogo. |
| `cfdi_provider_already_stamped` | Facturapi ya timbró esta factura; la estamos recuperando. |
| `cfdi_provider_auth_failed` | Facturapi rechazó las credenciales de la organización. Avisa a soporte. |
| `cfdi_provider_forbidden` | Facturapi no permite esta operación con las credenciales de la organización. Avisa a soporte. |
| `cfdi_provider_in_progress` | Facturapi todavía procesa esta factura. Lo revisaremos en unos segundos. |
| `cfdi_provider_invalid_request` | Facturapi devolvió un error inesperado. |
| `cfdi_provider_network` | No hubo conexión con Facturapi. Lo reintentaremos automáticamente. |
| `cfdi_provider_not_found` | Facturapi no encontró el documento o la organización. |
| `cfdi_provider_rate_limited` | Facturapi pidió esperar. Lo reintentaremos en unos minutos. |
| `cfdi_provider_rejected` | Facturapi rechazó la solicitud. Revisa el detalle. |
| `cfdi_provider_response_too_large` | La respuesta de Facturapi es demasiado grande. |
| `cfdi_provider_schema` | La respuesta de Facturapi no se pudo leer. La revisaremos de nuevo. |
| `cfdi_provider_timeout` | Facturapi tardó demasiado en responder. Lo reintentaremos automáticamente. |
| `cfdi_provider_unavailable` | Facturapi no está disponible. Lo reintentaremos automáticamente. |
| `cfdi_range_invalid` | Elige un rango de fechas válido. |
| `cfdi_receptor_name_mismatch` | El nombre no coincide con el registrado en el SAT para ese RFC. Escríbelo exactamente como en tu Constancia de Situación Fiscal, sin régimen societario. |
| `cfdi_receptor_regime_invalid` | Ese régimen fiscal no está en el catálogo del SAT. |
| `cfdi_receptor_regime_mismatch` | Ese régimen fiscal no está registrado para ese RFC en el SAT. |
| `cfdi_receptor_rfc_not_found` | El RFC no está registrado en el SAT o está cancelado. Revisa tu Constancia de Situación Fiscal. |
| `cfdi_receptor_zip_mismatch` | El código postal no coincide con el domicilio fiscal registrado en el SAT. |
| `cfdi_refund_netted_twice` | Un reembolso se descontó dos veces. Avisa a soporte. |
| `cfdi_regime_mismatch` | Ese régimen no corresponde al tipo de RFC (persona física o moral). |
| `cfdi_request_aborted` | La solicitud a Facturapi se interrumpió. Lo reintentaremos automáticamente. |
| `cfdi_request_invalid` | La factura no cumple el formato de Facturapi. Avisa a soporte. |
| `cfdi_resico_monthly` | En RESICO la factura global debe ser mensual. |
| `cfdi_settings_changed` | La configuración cambió en otro dispositivo. Recarga e intenta de nuevo. |
| `cfdi_shared_sandbox_not_allowed` | Configuración inválida: el entorno de prueba compartido no se permite en producción. |
| `cfdi_stamping_failed` | El SAT o el PAC no pudo timbrar la factura. Revisa el detalle o intenta de nuevo. |
| `cfdi_stamping_rejected` | El SAT o el PAC rechazó la factura. Revisa el detalle. |
| `cfdi_substitute_failed` | La factura sustituta no se pudo emitir; la original sigue vigente. |
| `cfdi_substitute_invalid` | Facturapi no aceptó la factura sustituta. La original sigue vigente. |
| `cfdi_substitute_pending` | La factura sustituta aún se está timbrando. |
| `cfdi_ticket_already_invoiced` | Este ticket ya tiene factura. |
| `cfdi_ticket_before_start` | Este ticket es anterior al inicio de la facturación. Confirma que no está en otra factura global. |
| `cfdi_ticket_fully_refunded` | Este ticket fue reembolsado; no hay importe que facturar. |
| `cfdi_ticket_in_global` | Este ticket ya está en la factura global. Un gerente puede sustituirla para facturarlo. |
| `cfdi_ticket_invoicing` | Este ticket ya se está facturando. |
| `cfdi_ticket_not_found` | No encontramos ese ticket. |
| `cfdi_unavailable` | La facturación electrónica no está disponible en este entorno. |
| `cfdi_unexpected_error` | Facturapi devolvió un error inesperado. |
| `cfdi_unit_key_invalid` | La clave de unidad SAT no existe en el catálogo. |
| `cfdi_use_not_allowed` | Ese uso de CFDI no está permitido para tu régimen fiscal. |
| `cfdi_vault_binding` | Una credencial guardada no corresponde a este restaurante. Avisa a soporte. |
| `cfdi_vault_malformed` | Una credencial guardada está dañada. Avisa a soporte. |
| `cfdi_vault_unknown_kid` | Falta la llave de cifrado de una credencial guardada. Avisa a soporte. |
| `cfdi_worker_database_required` | Configuración inválida: el proceso de facturación necesita su conexión propia a la base de datos. |
| `cfdi_xml_invalid` | El XML timbrado no se pudo leer. |

`rate_limited` (offline), `unauthorized` (access) and `settings_changed` (base) are reused, not
redeclared.

## Tests

| Command | Covers |
| --- | --- |
| `npm test` | `tests/cfdi.test.ts` (builders, rounding proof, XML parser, error classifier), `tests/cfdi-facturapi-contract.test.ts` (documented API), `tests/cfdi-facturapi-fake.test.ts`, `tests/cfdi-shared.test.ts` (receptor rules, periods, deadlines, payment forms, settings), `tests/cfdi-resico.test.ts`, `tests/cfdi-secrets.test.ts` (vault, upload box, CSD inspection, config, redaction), `tests/cfdi-jobs.test.ts` (kinds, limits, retry, dedupe keys), `tests/cfdi-portal-http.test.ts` (portal limiters over HTTP), `tests/cfdi-client.test.ts` (receptor form, printed block, alerts, ticket status, order actions), `tests/import-graph.test.ts` (process boundary), `tests/cfdi-merge-gate.test.ts` (the fiscal rebase gate), `tests/cfdi-locks.test.ts` (advisory key classes and their order inside LO-3) |
| `npm run test:db:cfdi` | checks through the worker login and the in-process fake: stamping, portal isolation, concurrency, globals (parts, late supplementary parts, idempotent ticks, runAt), refunds and egresos, substitution, cancellation, retries and adoption, reconcile, test/live separation, CSD sealing, immutability, RLS, discovery, retry limits, grants idempotency, settings, self-invoice window, email, amount check, provisioning idempotency, refund hook, key rotation, the reissue race (a request held against the worker's reissue step), CFDI unavailable for longer than every retry limit then restored, the recovery sweep and Reintentar, the tick chain restart, the card-form default, concurrent activations and the register cursor, a periodicity change that leaves past periods alone, a staff cancellation completing a rejected substitution, and the EXPLAINs of the running-lease index |
| `npx playwright test tests/browser/cfdi.spec.ts` | the panel before activation and the portal (always); activation + CSD, staff invoice + cancel, portal self-invoice (skip until fiscal 027 and the worker with the fake run) |
| `npm run test:facturapi:sandbox` | opt-in, `FACTURAPI_TEST_KEY` only, official URL, test mode; `RECORD=1` rewrites fixtures as `recorded@<date>` (not run: no key) |

Fixture provenance: `tests/fixtures/facturapi/README.md`. CI runs the fake on 127.0.0.1:4799 and
gives only the worker a fake User key, a synthetic keyring and `FACTURAPI_BASE_URL`.

## Using the fake

`npm run dev:facturapi-fake` serves it on `127.0.0.1:4799` (`--port` or `FACTURAPI_FAKE_PORT`);
point the worker's `FACTURAPI_BASE_URL=http://127.0.0.1:4799/v2` at it. Any `sk_user_…` key is the
platform User key. A receptor name containing `FAKE NAME MISMATCH`, `FAKE RFC NOT FOUND`,
`FAKE ZIP MISMATCH`, `FAKE REGIME MISMATCH`, `FAKE PAC REJECT`, `FAKE STAMP FAILED`,
`FAKE UNAVAILABLE`, `FAKE RATE LIMIT`, `FAKE PENDING`, `FAKE PENDING FAILED`, `FAKE TIMEOUT`,
`FAKE LOST RESPONSE`, `FAKE ROUNDING`, `FAKE SIX DECIMALS`, `FAKE CANCEL PENDING` or
`FAKE REJECT CANCEL` triggers that documented provider behaviour; globals take queued faults
(`POST /__fake/faults`). The fake models RESICO retentions (`Retenciones`, Total = SubTotal +
traslados − retenciones). Passing against the fake proves cfdi's logic, not Facturapi's
behaviour.

## Rebase onto fiscal and discounts (before merge)

1. Rebase `track/cfdi` onto the integration branch with fiscal 027, discounts 028 (and reports
   029 when merged), then reset the track databases (the 030 FK to `fiscal_tickets` and the
   `cfdi_self_invoice_lookup` policy are guarded by `to_regclass` and are skipped on a database
   migrated without 027; with 027 always first they can become unconditional).
2. Server: replace `ticketForCfdi` imports from `server/compat/cfdi-fiscal.ts` with
   `server/fiscal-read.ts`; `refundMethod` becomes a direct read of 028's `refunds.method`;
   delete `fiscalTablesPresent()` and its call sites in `store.ts` and `portal.ts`, then the shim.
3. Client: `orderTicket(order)` → `order.fiscal?.ticket ?? null`, `orderHasFiscal(order)` →
   `!!order.fiscal`, and `setFiscalFooterExtra` from `src/features/fiscal/FiscalReceipt.tsx`;
   delete `src/compat/cfdi-fiscal.ts`. In `Operations.tsx`, the `CfdiSettings` line moves to
   right after `FiscalSettings` (golden order LD-18 LD-P7).
4. Delete `tests/fixtures/cfdi/fiscal-027-standin.sql` and its loader in `tests/cfdi-db.ts`; run
   `npm run test:db:cfdi` against the real 027/028 tables.
5. Wire the cross-area anchors: fiscal's `recordRefundTax` step 9 calls `enqueueCfdiRefund`
   (and discounts' unused anchor comment goes); discounts' `RefundDialog` notice uses
   `useCfdiTicketStatus(order.fiscal?.ticket?.id ?? null)` and `cfdiTicketCovered`; reports'
   `collectAlerts()` adds `cfdiReportAlerts(await cfdiAlerts(tx))`, `dayCorte()` sets
   `extra.cfdi = await cfdiCoverage(tx, range)`, `TodayDashboard` renders
   `cfdiReportAlertText`, and `documents.tsx` renders `CfdiCorteCoverage` unless it already does.
6. Run the full qualification; the three stamping browser tests then run instead of skipping.
   The merge gate enforces this: once `server/fiscal-read.ts` is in the tree,
   `tests/cfdi-merge-gate.test.ts` fails until both compat shims and the stand-in are gone, no
   file imports them, `recordRefundTax` calls `enqueueCfdiRefund`, the worker reads
   `refunds.method`, the stamping tests no longer skip for a missing fiscal, and the CFDI status
   lines (DELIVERY_STATUS, FEATURE_MATRIX, COMPLETION_LEDGER) were re-verified; the browser
   stamping tests themselves fail (instead of skipping) without `GET /api/fiscal/context`, and in
   CI without the worker and the fake.

## Limitations and decisions

Deferred (spec §1.3): Facturapi webhooks (polling instead), several tickets per invoice, foreign
receptors (`XEXX010101000`), bimonthly globals (RIF only), a saved receptor directory, Facturapi
E-Receipts, IEPS, SaaS invoicing (account 031).

Decisions (defaults, spec §11): D1 key meanings; D2 the platform pays stamps, every plan; D3
credit/debit asked at invoicing, default 04; D4 monthly by default, RESICO monthly; D5 business
date membership and supplementary parts (binding); D6 one concept per ticket per category; D7
self-invoicing until the end of the purchase month, no automatic global replacement; D8 SAT FAQ
order for an invoice after a global; D9 refunds netted before a CFDI, egreso after; D10 grouped
concepts; D11 G02/S01 for credit notes; D12 no webhooks; D13 files in `cfdi_files`; D14
`qrcode.react` for the QR; D15 no foreign receptors; D16 irreversible live switch; D17 roles; D18
tax-inclusive concepts (sandbox decides); D19 globals cancelled by the owner with motive 02; D20
no E-Receipts; D21 series F, FG, NC; D22 test receptor EKU9003173C9 (unverified); D23 the user
supplies the test key. The accountant confirms D4, D5, D11 and the RESICO retention.

## Open items

- **Sandbox verification** needs a Facturapi test key: rounding (D18), the base-priced RESICO
  concepts (`tax_included: false`), the egreso to PUBLICO EN GENERAL (Facturapi's
  `InvoiceEgresoInput` has no `global` field), the undocumented `idempotency_key_in_use` status
  and the receptor test identity.
- **Fiscal/discounts rebase** (above) and the reports anchors.
- **Live qualification** with a real CSD and production approval.

## Sources

- Facturapi OpenAPI v2 and guides: FacturAPI/facturapi-docs commit
  `1c2e617776da4600ce3bac02a6aab6b0b3fcc88a` (2026-09-19); Node SDK types (Context7
  `/facturapi/facturapi-node`).
- SAT Anexo 20 (CFDI 4.0), "Guía de llenado del CFDI global", cancellation FAQ 2026; RMF
  2.7.1.21; LISR art. 113-J.
- zod 4.3.6 (Context7 `/colinhacks/zod`), jose 6 (JWE/ECDH-ES), express-rate-limit 8
  (`ipKeyGenerator`), qrcode.react 4.2.0 (Context7 `/zpao/qrcode.react`).
