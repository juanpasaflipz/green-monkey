# CFDI (Facturapi)

**Status.** CFDI: implemented and contract-tested against Facturapi's documented API (fixtures
`docs@1c2e617`); disabled until Facturapi keys are configured; live mode not enabled.
**Real-sandbox rehearsal (local, 2026-10-07, lead decision LD-51):** with a Facturapi test key in
the shared sandbox (`sandbox_shared`), these flows passed against the real Facturapi sandbox
and are sandbox-verified on 2026-10-07: activation, five sales, portal invoices to a persona
física and to a persona moral (the 1.25 % RESICO ISR retention stamped exact), a staff
cancellation with motive 02, a daily global with one concept per ticket, and a supplementary
global part from a late offline sale; the worker logged no warn or error line. Its findings
(F1–F13) are fixed by track cfdifix with migration 036 ("Rehearsal fixes" below).
`npm run test:facturapi:sandbox` (the recorded-fixture run) was not part of it. Not exercised
against the sandbox yet: the `organizations` provider (one organization per restaurant, the CSD
upload), a cancellation that needs the receptor's acceptance, credit notes and substitutions,
the RESICO monthly global close, email delivery and the alerts.

**Integration status (migration 030).** Merged onto fiscal 027, discounts 028 and reports 029:
the worker reads fiscal's tickets through `server/fiscal-read.ts`, credit notes come from
fiscal's `recordRefundTax`, the egreso payment form from 028's `refunds.method`, and reports
shows cfdi's alerts and corte coverage. Every worker path is DB-tested against the real
027/028 tables; see "Integration with fiscal, discounts and reports".

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
| `FACTURAPI_TEST_KEY=sk_test_…` only, `APP_ENV` ≠ production | `sandbox_shared` | staging/dev rehearsal: every restaurant stamps test CFDIs through the platform's sandbox organization, which is the issuer: its régimen, RFC and postal code as Facturapi reports them decide the RESICO retention and LugarExpedicion (LD-51 F3), and the panel shows it; no CSD upload, no live mode |
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
| worker | `CFDI_GLOBAL_GRACE_MINUTES` | 0–600, default 60 (`invalid_cfdi_global_grace_minutes`); published in `cfdi_platform` for the web's self-invoicing deadline (036) |
| worker, deployed | any Facturapi key | needs `WORKER_DATABASE_URL` (`cfdi_worker_database_required`) |
| both | `FACTURAPI_BASE_URL` | development/test only, loopback host only: the fake (`cfdi_base_url_not_allowed`) |
| web | `CFDI_INVOICE_LINK_EXPIRY_HOURS` | 1–168, default 72: lifetime of the portal request links (`invalid_cfdi_invoice_link_expiry_hours`) |

Wave 2.0 forbids the Facturapi keys, `CREDENTIAL_ENCRYPTION_KEY`, `CFDI_LIVE_ENABLED` and
`WORKER_DATABASE_URL` in a deployed web, and `MIGRATION_DATABASE_URL` in both processes.
Registration in `.railway/railway.ts` and `.env.example` is Wave 2.0's.

## Onboarding runbook

1. **Platform account.** Create the platform's Facturapi account and its User key. Generate the
   credential key with `node scripts/cfdi-generate-credential-key.mjs` (prints one
   `YYYY-MM-DD-<6 hex>:<base64url>` entry, a kid never reused with another secret; paste it only
   into the worker's environment).
2. **Worker env.** Set `FACTURAPI_API_KEY`, `CREDENTIAL_ENCRYPTION_KEY` and (already there)
   `WORKER_DATABASE_URL` on the `worker` service. On boot the worker lists organizations with the
   User key, computes the CSD upload key pair and publishes `cfdi_platform`. A refused key
   publishes `disabled` and raises `cfdi_provider_auth_failed`.
3. **Restaurant activation** (owner, PIN step-up): Configuración → "Facturación electrónica
   (CFDI)". Prerequisites: platform available, fiscal profile complete, currency MXN, legal name
   ≤ 100 characters. The owner chooses the **periodicity of the global invoice** (monthly by
   default, D4; a RESICO restaurant is monthly and the step says so; LD-51 F2), with the bound it
   puts on self-invoicing. **Activar en modo prueba** creates the settings (mode `test`,
   `test_from` = today, that periodicity) and the organization (`provisioning`); the worker finds
   or creates it by a name marker (never two), pushes the legal data and seals the
   organization's test key. In the shared sandbox there is nothing to push: the issuer is the
   platform's test organization.
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
| `cfdi_platform` | the worker's published provider state (one row, no tenant); since 036 also its `CFDI_GLOBAL_GRACE_MINUTES` and the shared sandbox organization's legal name, RFC, régimen and postal code |
| `cfdi_settings` | per restaurant: enabled, mode, start dates, periodicity, concept mode, card form, default use, self-invoicing window, portal reissue, support email, version |
| `cfdi_secrets` | sealed organization keys and CSD upload boxes (worker-readable only) |
| `cfdi_organizations` | Facturapi organization, legal sync version, CSD state, production readiness |
| `cfdi_csd_uploads` | each upload attempt (serial, validity, outcome) |
| `cfdi_documents` | invoices, globals, egresos: frozen request, expected and stamped amounts, withholding, status, amount check |
| `cfdi_document_tickets` | claims of fiscal tickets by documents (`pending`, `active`, `released`) |
| `cfdi_cancellations` | cancellation requests and their outcome |
| `cfdi_files` | XML, PDF and cancellation acuses (5-year retention) |
| `cfdi_events` | append-only history per document and per restaurant |
| `cfdi_global_periods` | each global period per mode: close, due, status, late tickets; the worker may delete a row no document ever used (036's guard), to rebuild the current month after a periodicity change |

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

Every cfdi job that ends done logs one info line, `cfdi_job_done` (LD-51 F13), with `jobId`,
`kind` and `tenantId`, the document it acted on (`documentId`), the ids its payload carries
(`cancellationId`, `refundId`, `uploadId`, `periodKey`, `action`, `purpose`) and
`facturapiLogIds`: the `X-Facturapi-Log-Id` of each provider answer. Facturapi documents that
header as the request correlation id on error responses (errors.mdx "Useful headers"; the Node
SDK's `FacturapiError.logId`, Context7 `/facturapi/facturapi-node`); a successful answer that
carries it is logged too, one that does not adds nothing. Hand-overs while CFDI is unavailable
log `cfdi_job_waiting` instead. The line is written when the handler returns done, before the
runner records the completion (CFDIFIX-10, accepted): if the job's lease is lost at that moment
the runner logs `job_lease_lost` next and the job may run again (every handler is idempotent:
the document key, the external id, the dedupe keys), so a second `cfdi_job_done` for the same
`jobId` can follow. Read the line as "the handler finished"; the job's state is the runner's.

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
  document already has one waiting. Each cancellation that needs the receptor's acceptance starts
  its own chain (`reconcile:<doc>:cancel:c<12 hex of the cancellation>:<n>`), so a document's
  second cancellation is polled from +30 minutes like the first, although job dedupe keys stay
  unique for 30 days (CFDI-R3-3).
- **The global tick chain** never ends: a tick that keeps failing schedules a fresh tick at the
  next hour before it goes dead (`jobs_dead_cfdi_global` still alerts), and a restaurant with
  CFDI enabled and no live tick gets one back at the worker boot (`seedGlobalTicks`, restaurants
  found through their `cfdi_global` jobs) and at every operator sign-in (`GET /cfdi/status`,
  `ensureTick`, one insert per 10 minutes at most).
- **Substitution after a rejected cancellation**: when the receptor rejects (or lets expire) the
  motive-01 cancellation, or the provider refuses it (`cfdi_cancel_rejected_provider`, alert
  `cfdi_cancel_failed`), both invoices stay valid and the substitute's claim waits (pending;
  alert `cfdi_substitution_rejected` for a rejection). While such a substitute waits and no
  cancellation of the original is open, the original's detail shows the red two-valid-invoices
  alert and the attention count (`rejectedSubstitutions`, the badge "Requiere atención", Today's
  `cfdi_substitution_rejected`) includes it, whatever happened after; it never clears while two
  valid CFDIs exist for the sale (CFDI-R3-1). The ways out:
  - **Solicitar de nuevo la cancelación…** (managers, step-up): motive 01 again with the waiting
    substitute (`POST /cfdi/documents/:id/cancel` with `motive: "01"`; refused with
    `cfdi_substitute_missing` when no valid substitute waits);
  - **Cancelar** the original (motive 02 or 03): the ticket goes to the waiting substitute as
    soon as the original is canceled (`substitution_completed`, CFDI-R2-4);
  - **Cancelar** the substitute (motive 02): the original keeps the ticket.
  Either cancellation of the original moves the ticket exactly as an accepted motive-01
  cancellation does, and later refunds get credit notes related to the substitute. A second
  **Sustituir…** is refused with `cfdi_substitution_pending` while a substitute is unfinished
  (queued, stamping, pending, valid or canceling, with its claim pending), so one sale never has
  two substitutes.
- **Credit notes and cancellations never overlap** (CFDI-R3-2). SAT refuses to cancel a CFDI that
  a valid credit note relates to. Every path that starts a cancellation checks for credit notes
  (queued, stamping, pending, valid or canceling egresos) under the document's key: the staff
  request (`cfdi_has_credit_notes`), the late invoice's request, and `cfdi_cancel` and
  `cfdi_reissue` again right before they call the provider (the cancellation fails with
  `cfdi_has_credit_notes`, the reissue's waiting invoices with `cfdi_global_has_credit_notes`,
  with the usual alerts). A late invoice for a ticket in a global that credit notes relate to
  never asks for that cancellation: it takes **route III** (below), for staff and for the portal
  when `portal_reissue_global` is on, so one refund credited against a daily or monthly global
  never stops the other tickets of its period from being invoiced (CFDI-INT-1). A credit note is
  never canceled on its own (LD-33), so an invoice or global with live credit notes cannot be
  canceled or substituted in the app: the register says so instead of offering Cancelar or
  Sustituir (`creditNotesBlock`), and the messages never tell staff to cancel the notes; an
  invoice with an error after a credited refund is corrected with support (correcting it in the
  app would mean substituting it and re-issuing each credit note against the substitute, which
  is not built). `cfdi_refund` decides under the same key and waits
  (`cfdi_parent_cancel_open`) while any cancellation of the covering document is queued or
  requested, whatever its source; once it ends, the claim has moved to the substitute, the
  replacement global or back to the globals, and the refund is netted or credited there.
- **Advisory keys** (LO-3, `server/cfdi/locks.ts`): per-ticket (class 926), then per-document
  (927), then per-period (928), never the reverse; `tests/cfdi-locks.test.ts` checks the order.
- **Invoice after a global**: the web request and `cfdi_reissue` take the same per-document key
  of the global (LO-3). The request re-reads the global and the ticket's claim under the key; if
  the reissue already canceled the global it answers `cfdi_global_in_progress`, and the retry
  lands on the replacement global once it is valid. A motive-04 cancellation is only inserted
  for a valid global. The replacement's part number is taken under the period key, after the
  global's document key, as the builder numbers its parts; `cfdi_documents_period` is unique per
  (mode, period, part) (CFDI-R2-5).

## Corrections, deadlines and recovery (second-opinion hardening, LD-33)

- **Tickets freed by a cancellation always return to a CFDI** (MONEY-2, SAT-1). `onCanceled`
  enqueues a forced build (`cfdi_global {periodKey, force}`) of each built or empty period of the
  released tickets, whatever its age (the tick's late sweep looks back only 62 days); a ticket of
  a period still open waits for its normal build, and a motive-03 cancellation waits a day so the
  refund recorded with it nets the ticket first (SAT-5). A closed period with a ticket in no CFDI
  (on or after the mode's start, with a net amount) shows **overdue** with **Emitir ahora**,
  counts in Hoy's overdue globals and alerts once. A ticket from before CFDI started belongs to no
  period: its invoice's cancel dialog says so (`preStart`).
- **CFF art. 29-A** (SAT-3). A CFDI can be canceled only until the month the annual return of its
  year is due: March (persona moral, 12-character RFC) or April (persona física) of the next
  year, in the restaurant's timezone (`cancellationDeadline`). Past it, cancel, substitute and
  "request again" answer `cfdi_cancel_deadline_passed` and the register states the deadline. A
  ticket in a global past its deadline is invoiced by **route III** of the Guía de llenado del
  CFDI global (Apéndice 2): a credit note to the global for what the global still declares for
  the ticket (related 01, S01, the ticket's FormaPago; `credit_ticket_id`), then the waiting
  nominative invoice, which takes the ticket from the global once the note is valid and nets
  every refund of the ticket ("Nota de crédito a la global y facturar"). The note's figure
  (CFDI-INT-2) is the ticket less the refunds the global netted when it was frozen and less the
  refunds a live credit note to the global credits; it records those refunds in its
  `netted_refund_ids`. Every other refund (recorded after the global, its credit note failed or
  not decided yet) is inside the global's figure, so the note credits it and the invoice nets it:
  the global ends at zero for the ticket and the CFDI income equals fiscal's net. The request
  answers `cfdi_global_in_progress` while a credit note to the global for one of the ticket's
  refunds is still queued, stamping or pending, so the note's figure never depends on a stamp
  still in flight. A failed note fails the invoice (`cfdi_global_credit_failed`); a refund decided
  meanwhile waits (`cfdi_parent_credit_open`), then finds itself netted by the invoice (or, when
  the invoice failed, by the supplementary global that takes the ticket back). One live note per
  global, ticket and mode: a ticket back in a supplementary part takes route III again with a
  new note to that part (CFDI-INT-3). Route III is also taken, whatever the deadline, while a
  credit note relates to the global and no cancellation of it is open (CFDI-INT-1):
  `globalRoute` (server/cfdi/store.ts) decides for the request under the global's document key
  and for the ticket view (`reissueRoute`, `reissueReason: "deadline" | "credit_notes"`), so the
  dialog explains which applies.
- **Credit notes are corrected, never just canceled** (MONEY-1, SAT-2). Staff cannot cancel an
  egreso with 02/03 (`cfdi_not_cancellable`). **Sustituir…** on a credit note (managers,
  step-up) issues a new one for the same refund and parent with the chosen FormaPago, related 01
  to the parent and 04 to the old note, which is then canceled with motive 01; a provider refusal
  leaves both valid and counts as a rejected substitution. A canceled credit note no longer
  credits its refund, and a refund whose ticket a substitute takes is decided again against it
  (R4-2).
- **Substitutes and their cancellations** (R4-1). A document named by an open motive-01
  cancellation cannot itself be canceled or substituted (`cfdi_substitution_in_progress`); a
  motive-01 cancellation whose substitute failed or was canceled fails (`cfdi_substitute_failed`)
  instead of waiting, recovery fails one left queued, and a ticket is handed only to a substitute
  that is still valid with no cancellation of its own.
- **Retries read the provider first** (WORKER-1, WORKER-2). `cfdi_cancel` and `cfdi_reissue` read
  the invoice before sending DELETE again after an attempt that may have reached SAT (a retry, a
  lost lease, a `cancel_unknown` event) and check a permanent refusal against the invoice's real
  state; a stamp commits `stamp_sent` before POST, and a later attempt adopts by external_id
  before the legal sync or any other precondition, never failing a document that may already be
  a valid CFDI. A cancellation completes under its document key, the key `cfdi_refund` decides
  under.
- **CSD boxes are always wiped** (SECRETS-1, WORKER-3). Uploads wait for the organization to
  exist at Facturapi (`cfdi_not_ready`); the job's last attempt rejects instead of going dead; the
  tick rejects any upload left queued or processing 30 minutes with no live job
  (`cfdi_csd_abandoned`), paused restaurants included: an upload while CFDI is paused starts a
  tick, and a paused tick re-arms hourly while an upload is open, so the sweep never waits for
  CFDI to be turned back on (CFDI-INT-7).
- **RESICO** (SAT-4, UX-1). A restaurant that becomes 626 moves to monthly globals from the first
  of next month (the tick stores the pending change) and a save is coerced to monthly, never
  refused; the save applies it at once when the current month allows it ("Periodicity changes").

## Global periods

Membership is the ticket's fiscal `business_date` (decision D5, binding). A period is built at
close + `CFDI_GLOBAL_GRACE_MINUTES` (60) and is due at close + 24 h. A late ticket (offline sync,
repair, or released by a cancellation) goes into a **supplementary part of its own period** at
the next tick, never into the next open period; a part created after `due_at` is flagged
"Emitida fuera de plazo", shown overdue until stamped and alerted (`cfdi_global_late`). Parts hold
at most 4,000 concepts; a ticket is never split. With automatic emission off, periods wait for
**Emitir ahora**.

**Periodicity changes** (LD-51 F2, CFDIFIX-1). Activation takes the periodicity. A later change
applies **at once** while the current month is unshaped (`periodicityChangeBlock` answers null):
- no global document of any of its periods (stamped, claiming or failed): reason `globals`;
- no unclaimed ticket of the month that would sit in a period, old or new, already past its
  24-hour deadline (RMF 2.7.1.21: re-partitioning must never turn an on-time global into a late
  one nor hide one that is late): reason `overdue`;
- no unclaimed ticket of the month whose self-invoicing deadline the change would bring forward:
  reason `deadline`. Its receipt printed the deadline under the old periodicity (the earlier of
  the policy and the global's build, "Self-invoicing ends when the ticket's global is built"),
  and the portal must never refuse a customer before the printed date. The deadline is compared
  under the self-invoicing policy the save stores; a change that keeps or lengthens every
  deadline (day → month, week → fortnight, or a policy that ends first anyway) still applies at
  once. The check does not depend on the self-invoicing or reissue switches: a receipt printed
  while they were on keeps its date when they are turned back on. In practice a shorter
  periodicity applies at once only on a month with no unclaimed ticket yet (right after
  activation, or on the 1st before the first sale); on the last day of a month a monthly and a
  daily global of that day close together, so that day's tickets do not block it.

The save then enqueues a tick of its own, which takes the settings row lock and every period key
of the month, checks the same rule again over every unclaimed ticket of the month (including one
sold between the save and the tick: a terminal that had not refreshed its status printed the old
deadline, and deferring only lengthens the deadlines of receipts that printed the new one),
deletes the month's rows (only the worker may, only rows no document used, 036) and adds them
back under the new periodicity (`periodicity_rebuilt` event). If the month got shaped between the
save and the tick, the change waits for next month instead (`periodicity_deferred`). The global
builder takes the settings row (FOR SHARE) before its period key, so a save and a build
serialize, and it never builds a row a change left stale. Otherwise the change is stored as
pending from the first day of next month and the panel says so, and why ("Periodicidad actual:
mensual. Cambia a diaria desde el …. No se aplicó al momento: acortaría el plazo para autofacturar
de tickets ya vendidos este mes.", F10, CFDIFIX-5): the save and the tick record a document-less
`periodicity_deferred` event (`from`, `to`, `nextFrom`, `reason`, `source` save or tick; the
save's names its owner), and the settings view shows the latest one while its change is still the
pending one. "Periodicidad actual" is the periodicity in force on the server's business date
(`businessDate` in the view): from its first day a pending change is in force even before the
tick promotes it (CFDIFIX-6). Earlier months never change
(CFDI-R2-1), nor does a month once it has a global: each tick adds rows only after the mode's
last one, a period in
the month of the previous row continues that row's periodicity, a new month takes the
periodicity in force on its first day, and the tick adds the rows before it promotes a pending
change, so a month that closed under the old periodicity stays one partition of it even when
the first tick after the change runs days later; late tickets then join a supplementary part of
their own period (D5) with its own periodicity. Choosing the periodicity in force cancels a
pending change.

**Self-invoicing ends when the ticket's global is built** (LD-51 F1). While "Sustituir la factura
global automáticamente" (`portal_reissue_global`) is off, the portal never cancels a global, so a
ticket can be self-invoiced only until its period's global takes it: the period's close plus the
worker's grace. The deadline the receipt prints, the portal shows and enforces
(`cfdi_portal_expired`) and the staff ticket view carry is the earlier of the policy deadline
(end of the purchase month, or N days) and that moment (`effectiveSelfInvoiceDeadline`; the period
row's close when the tick created it, else the periodicity in force on the ticket's date). With a
daily global it is the next morning; the receipt and the portal then print the time too ("08/10/2026
a las 05:00"), and the portal adds that the ticket then goes into the restaurant's global
invoice. The cached status carries the bound (periodicity, pending change, cutoff, grace), so a
receipt printed offline shows the same date. A signed-in device refreshes that status when the
window regains focus or visibility, when the connection returns and every 5 minutes while online
and visible (CFDIFIX-3), so a terminal signed in for the whole shift picks up a settings change
within minutes; the refresh stops once the device's session is no longer the one it started for.
A deadline already past when the receipt prints (a check of yesterday's business date paid after
its daily global was built, or a reprint) is not printed: the receipt says "Pídela en caja con
el folio …" instead (CFDIFIX-11). The settings explain the trade-off for the chosen
periodicity. With reissue on, the policy alone applies (and each late invoice costs two extra
stamps). "Emitir ahora" pressed during the grace takes the period's tickets before the printed
time; that is the manager's choice.

**Tickets issued into a built period** (LD-51 F12): fiscal's `issueDueTicket` and repair (every
issuance: sale, offline recovery, repair) call `cfdiTicketsIssued` before they take the folio
counter (LO-12, whose statement budget stays as fiscal set it), which enqueues a tick due now
when a ticket's date, older than today's business date, falls in a period whose global was
already built (one key per 10 minutes,
`tick:issued:<bucket>`; when that key already ran and no tick is waiting to run, a key suffixed
with the ticket, as `armNextTick` does for the chain, LD-39). The late sweep then builds its
supplementary part at once instead of at the next scheduled tick (up to 6 hours).

The register counts each period's tickets in no CFDI yet ("N por emitir") in its tickets and
totals, so an open period shows what its global will take (LD-51 F11).

## Amounts

- Concepts are tax-inclusive (`tax_included: true`, quantity 1, price = fiscal's net gross).
  For 16 % and 8 % no rounding ties exist, so the stamped IVA equals fiscal's
  `extractTax(gross)` (unit test 15). RESICO-withheld concepts are base-priced instead.
- Netted refunds use fiscal's figures (`ticket group − adjustments` per category). Egresos stamp
  `extract(adj.gross)`, at most 1 centavo per category from fiscal's `adj.tax`.
- `amount_check` on every stamped document: `exact`, or `differs` with a reason
  (`pre_ticket_refund_bound`, `egreso_extract`, `base_priced_rounding`: expected, no alert;
  `provider_rounding`: alerts `cfdi_amount_mismatch`).

## Rehearsal fixes (LD-51, track cfdifix, migration 036)

The local rehearsal against the real Facturapi sandbox (2026-10-07) found these; each is fixed with
a unit, DB and (where it shows) browser check:

| Item | Fix |
| --- | --- |
| F1 (high) | The self-invoicing deadline is the earlier of the policy and the ticket's global build while the portal does not reissue globals; receipt, portal and settings agree ("Global periods") |
| F2 | Activation takes the periodicity; a change applies at once on an unshaped month and the tick rebuilds the month's rows ("Periodicity changes") |
| F3 | In the shared sandbox the stamping issuer facts (régimen and RFC for the RESICO retention, LugarExpedicion, the global receptor's postal code) are the platform test organization's, as Facturapi reports them (`GET /organizations/me`, published at boot and on each refresh in `cfdi_platform`); the panel shows it and says the restaurant's profile is not used to stamp. `organizations` mode is unchanged |
| F7 | A cancellation acuse is stored, and offered in the register, only when its XML names the document's UUID (`Folios/UUID` in any namespace, `acuseUuids`); Facturapi's test mode answers a sample acuse of another CFDI, which is recorded as `acuse_mismatch`, never stored and never fetched again by recovery; the document's status still comes from Facturapi's invoice. In live mode a mismatch is never expected (a provider-format or parser problem, CFDIFIX-2): it is recorded as `acuse_mismatch_live` ("no se guardó y se volverá a pedir"), alerts `cfdi_acuse_mismatch`, and Reintentar or the tick's sweep fetches it again, three times in all (`LIVE_ACUSE_ATTEMPTS`) |
| F8 | No "datos fiscales actualizados se enviarán" note in the shared sandbox (nothing is synced there) |
| F9 | The issuer RFC reads "Pendiente" until Facturapi reports it, never the profile's |
| F10 | The periodicity field states the one in force and a pending change with its date |
| F11 | Each period counts its unclaimed tickets ("N por emitir") in its tickets and totals |
| F12 | A ticket issued into a built period enqueues a tick now (fiscal's issuance hook, before the folio counter) |
| F13 | One `cfdi_job_done` info line per successful job, with Facturapi's log ids ("Jobs") |
| F4–F6 | Hand-off items for the user, the accountant and the provider ([LAUNCH_HANDOFF.md](LAUNCH_HANDOFF.md) 1.13 and 1.14) |

## Operations

| Alert key | Severity | Action |
| --- | --- | --- |
| `cfdi_provider_auth_failed` | critical | the User key or an organization key was refused: check the worker's `FACTURAPI_API_KEY`; for one restaurant, its organization in Facturapi |
| `cfdi_global_overdue:<tenant>:<mode>:<period>` | warning | the period passed its 24 h deadline unstamped: open Facturas globales, **Emitir ahora**, check Facturapi status |
| `cfdi_global_late:<tenant>:<mode>:<period>:p<n>` | warning | a supplementary part was created after the deadline (late tickets): confirm it stamps |
| `cfdi_global_failed:<tenant>:<doc>` | warning | a global part failed: read the provider error in its detail, fix, **Reintentar** |
| `cfdi_ticket_excluded:<tenant>:<mode>:<period>` | warning | tickets left out of a global (inconsistent fiscal figures): check fiscal's ticket register |
| `cfdi_amount_mismatch:<tenant>:<date>` | warning | stamped amounts differ from fiscal's beyond the documented bounds: compare the XML with the ticket; report to engineering |
| `cfdi_substitution_rejected:<tenant>:<doc>` | warning | the customer rejected a substitution: two invoices are valid; cancel the new one (02) or **Solicitar de nuevo la cancelación…** on the original (motive 01 with the same substitute) |
| `cfdi_stamp_unresolved:<tenant>:<doc>` | warning | Facturapi kept the stamp pending past its recovery window: check the invoice in Facturapi |
| `cfdi_cancel_unresolved:<tenant>:<doc>` / `cfdi_cancel_failed:<tenant>:<doc>` | warning | a cancellation is unanswered after 10 days / was refused: read the detail, repeat or handle at the SAT portal |
| `cfdi_acuse_mismatch:<tenant>:<doc>` | warning | live mode: the cancellation acuse Facturapi returned does not name the document's UUID; it is not stored and is fetched again (Reintentar or the tick's sweep, three times in all). Compare the acuse in Facturapi with the document and report to engineering (a provider-format or parser change) |
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
submissions per ticket per 24 h (failures that are the restaurant's, such as its certificate or
the provider, do not count). A failed request offers **Corregir mis datos** only when the
customer can fix the data (`receptorFixable`); otherwise it says the restaurant could not issue
it, with its contact. A customer who comes back sees why their last request failed, and the
restaurant counts such failures in its attention badge and Hoy. An expired certificate (or a
missing one in live mode) closes self-invoicing. Downloads appear once the PDF and XML are stored
(`filesReady`), and each download asks for a fresh token. Downloads need the RFC used, through 15-minute download tokens;
request links last `CFDI_INVOICE_LINK_EXPIRY_HOURS`. The deadline the portal shows is the one the
receipt printed ("Self-invoicing ends when the ticket's global is built"). The portal's privacy checkbox links the
restaurant's own privacy notice (Configuración → Privacidad y datos; account 031's
`restaurantPrivacyUrl`), as the QR and kiosk pages do; without one it shows the fallback line and
the contact.

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
| `cfdi_cancel_deadline_passed` | El SAT ya no permite cancelar este CFDI: el plazo del artículo 29-A del CFF (hasta el mes de la declaración anual del ejercicio en que se emitió) venció. |
| `cfdi_cancel_in_progress` | Ya hay una cancelación en proceso para esta factura. |
| `cfdi_cancel_rejected_provider` | Facturapi o el SAT rechazaron la cancelación. Revisa el detalle. |
| `cfdi_cancellation_in_progress` | Ya hay una cancelación en proceso para esta factura. |
| `cfdi_card_form_required` | Indica si el pago con tarjeta fue de crédito o débito. |
| `cfdi_credit_note_parent_not_valid` | La factura a la que corresponde esta nota de crédito ya no está vigente o se está cancelando; no se puede sustituir. |
| `cfdi_csd_abandoned` | El certificado no se llegó a procesar y se borró. Súbelo de nuevo. |
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
| `cfdi_global_credit_failed` | No se pudo emitir la nota de crédito a la factura global; la factura del cliente no se emitió. Intenta de nuevo. |
| `cfdi_global_error` | No se pudo preparar la factura global. Lo reintentaremos automáticamente. |
| `cfdi_global_has_credit_notes` | La factura global de este ticket tiene notas de crédito vigentes y el SAT no permite cancelarla. Solicita la factura de nuevo: se emitirá una nota de crédito a la global por este ticket y después la factura. |
| `cfdi_global_in_progress` | La factura global de este periodo se está emitiendo. Intenta en unos minutos. |
| `cfdi_has_credit_notes` | Tiene notas de crédito vigentes y el SAT no permite cancelarla ni sustituirla mientras existan; una nota de crédito solo se corrige con Sustituir. Si tiene un error, avisa a soporte. |
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
| `cfdi_not_cancellable` | Una nota de crédito no se cancela sola: corrígela con Sustituir (se emite otra y esta se cancela con el motivo 01). |
| `cfdi_not_ready` | La organización emisora aún no está lista. Revisa Ajustes → Facturación electrónica. |
| `cfdi_not_retryable` | Este documento no se puede reintentar. |
| `cfdi_not_substitutable` | Solo las facturas a clientes se pueden sustituir. |
| `cfdi_not_valid` | Solo se puede hacer esto con una factura vigente. |
| `cfdi_nothing_to_invoice` | No queda importe por facturar en este ticket. |
| `cfdi_org_key_invalid` | La llave de la organización ya no es válida. Avisa a soporte. |
| `cfdi_org_not_ready` | La organización emisora está incompleta en Facturapi. |
| `cfdi_org_tax_info_invalid` | Facturapi rechazó los datos fiscales del restaurante. Revisa Datos fiscales. |
| `cfdi_parent_cancel_open` | La factura original tiene una cancelación en curso; la nota de crédito espera el resultado. |
| `cfdi_parent_canceling` | La factura original está en cancelación; la nota de crédito espera el resultado. |
| `cfdi_parent_changed` | El ticket pasó a otra factura; la nota de crédito se decide de nuevo en unos minutos. |
| `cfdi_parent_credit_open` | La factura global tiene en curso una nota de crédito por este ticket; el reembolso se decide después. |
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
| `cfdi_substitute_missing` | Esta factura no tiene una sustituta vigente; cancélala con el motivo 02 o 03. |
| `cfdi_substitute_pending` | La factura sustituta aún se está timbrando. |
| `cfdi_substitution_in_progress` | Esta factura sustituye a otra cuya cancelación sigue en proceso; espera a que termine antes de cancelarla. |
| `cfdi_substitution_pending` | Esta factura ya tiene una sustituta que espera su cancelación: vuelve a solicitar la cancelación o cancela la sustituta (motivo 02) antes de sustituirla otra vez. |
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
| `npm test` | `tests/cfdi.test.ts` (builders, rounding proof, XML parser, error classifier), `tests/cfdi-facturapi-contract.test.ts` (documented API), `tests/cfdi-facturapi-fake.test.ts`, `tests/cfdi-shared.test.ts` (receptor rules, periods, deadlines, payment forms, settings), `tests/cfdi-resico.test.ts`, `tests/cfdi-secrets.test.ts` (vault, upload box, CSD inspection, config, redaction), `tests/cfdi-jobs.test.ts` (kinds, limits, retry, dedupe keys), `tests/cfdi-portal-http.test.ts` (portal limiters over HTTP), `tests/cfdi-client.test.ts` (receptor form, printed block, alerts, ticket status, order actions), `tests/import-graph.test.ts` (process boundary), `tests/cfdi-merge-gate.test.ts` (no compat shim returns; the refund hook and `refunds.method`), `tests/cfdi-locks.test.ts` (advisory key classes and their order inside LO-3), `tests/cfdi-rehearsal.test.ts` (LD-51: the deadline's global bound per periodicity, when a periodicity change applies at once, the shared sandbox's stamping facts, the acuse reader, the issuance tick key, Facturapi's log id and the job's info line) |
| `npm run test:db:cfdi` | checks through the worker login and the in-process fake, against the real 027/028 tables: stamping, portal isolation, concurrency, globals (parts, late supplementary parts, idempotent ticks, runAt), refunds and egresos (including fiscal's `recordRefundTax` hook and the card/cash FormaPago from `refunds.method`), substitution, cancellation, retries and adoption, reconcile, test/live separation, CSD sealing, immutability, RLS, discovery, retry limits, grants idempotency, settings, self-invoice window, email, amount check, provisioning idempotency, refund hook, key rotation, the reissue race (a request held against the worker's reissue step), CFDI unavailable for longer than every retry limit then restored, the recovery sweep and Reintentar, the tick chain restart, the card-form default, concurrent activations and the register cursor, a periodicity change that leaves past periods alone, a staff cancellation completing a rejected substitution, a second substitution refused while one waits and the motive-01 re-request (with its own poll chain), a provider-refused substitution in the attention count, a refund waiting for a queued cancellation, credit notes refusing cancellations in the requests and in the worker, the EXPLAINs of the running-lease index, and the second-opinion checks (lost cancel/reissue/stamp answers read back, CSD boxes always wiped, motive-01 cancellations whose substitute ended, a cancellation completing under its document key, credit-note corrections, refunds re-decided on hand-over, re-globalization after old cancellations and overdue periods, the CFF 29-A deadline and route III, RESICO coercion, portal failures and file readiness, and the cheap lows), and route III for a global that credit notes relate to (staff and portal) with the register's explanation for an invoice that has them (CFDI-INT-1), and route III's note crediting exactly what the global still declares for the ticket: a refund recorded just before the request, one whose credit note failed, one credited live, and the request waiting for a credit note still in flight (CFDI-INT-2), and a second route III for a ticket back in a supplementary part (CFDI-INT-3), and the abandoned-upload sweep of a paused restaurant (CFDI-INT-7), and the LD-51 checks: the self-invoicing deadline for each periodicity and policy (and a ticket refused past its global's build while unbuilt), activation's periodicity, the immediate change and the tick's rebuild, 036's guard, a change deferred by a month shaped meanwhile or an overdue period, the shared sandbox's issuer facts and the pending issuer RFC, the test-mode sample acuse, unclaimed tickets in a period's counts, fiscal's issuance hook (called directly, and reached through fiscal's own `issueDueTicket` as offline recovery calls it, CFDIFIX-4), the reason a periodicity change waits (CFDIFIX-1, -5) and the `cfdi_job_done` lines |
| `npx playwright test tests/browser/cfdi.spec.ts` | the panel before activation (with the periodicity step) and the portal (always); activation + CSD (and the issuer RFC Facturapi reports), staff invoice + cancel, portal self-invoice, and the switch to daily globals with the portal's daily deadline (they need the worker with the fake; CI starts both, a local run without the worker skips only these four) |
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

## Integration with fiscal, discounts and reports

- **Fiscal 027.** `ticketForCfdi` comes from fiscal's leaf module `server/fiscal-read.ts` (it
  imports only `db` and `shared`), so the worker never loads the web sales graph
  (`tests/import-graph.test.ts`). The client reads `order.fiscal?.ticket`, and the printed block
  registers once through fiscal's `setFiscalFooterExtra`. Migration 030's claims foreign key to
  `fiscal_tickets` and the `cfdi_self_invoice_lookup` policy are unconditional (027 always runs
  first).
- **Refund hook.** Fiscal's `recordRefundTax` calls `enqueueCfdiRefund(tx, s, refundId)` after it
  inserts the refund's tax rows (step 9; a no-op while CFDI is off). Every refund path reaches it:
  discounts' `insertRefundBatch` and the legacy refund.
- **Issuance hook** (LD-51 F12). Fiscal's `issueDueTicket` and `repairMissingTickets` call
  `cfdiTicketsIssued(tx, s, tickets)` before the folio counter: a tick due now for a ticket of a
  built period (nothing for a ticket of today; else one read and a job insert at most, no lock;
  a no-op while CFDI is off).
- **Discounts 028.** A credit note's FormaPago follows `refunds.method`: a card (`external`)
  refund takes the parent's card form (04/28) or the restaurant's, a cash refund 01. The refund
  dialog shows "Esta venta ya tiene factura (CFDI)…" when `useCfdiTicketStatus` reports a valid
  covering invoice or global.
- **Reports 029.** `collectAlerts()` adds the four `cfdi_*` codes (`cfdiReportAlerts`), Hoy words
  them (`cfdiReportAlertText`) and links them to Configuración; `dayCorte()` sets `extra.cfdi`
  (`cfdiCoverage`) and the corte del día prints it as "Facturación (CFDI)". All are absent while
  CFDI is off. The report-print key is class 930; cfdi keeps 926-928 (ARCHITECTURE LO-3).
- **Gate.** `tests/cfdi-merge-gate.test.ts` keeps the pre-merge compat shims and the 027
  stand-in out of the tree and checks the hook and `refunds.method` read.

## Limitations and decisions

Deferred (spec §1.3): Facturapi webhooks (polling instead), several tickets per invoice, foreign
receptors (`XEXX010101000`), bimonthly globals (RIF only), a saved receptor directory, Facturapi
E-Receipts, IEPS, SaaS invoicing (account 031).

Decisions (defaults, spec §11): D1 key meanings; D2 the platform pays stamps, every plan; D3
credit/debit asked at invoicing, default 04; D4 monthly by default, RESICO monthly; D5 business
date membership and supplementary parts (binding); D6 one concept per ticket per category; D7
self-invoicing until the end of the purchase month (or the ticket's global build when earlier,
LD-51 F1), no automatic global replacement; D8 SAT FAQ
order for an invoice after a global; D9 refunds netted before a CFDI, egreso after; D10 grouped
concepts; D11 G02/S01 for credit notes; D12 no webhooks; D13 files in `cfdi_files`; D14
`qrcode.react` for the QR; D15 no foreign receptors; D16 irreversible live switch; D17 roles; D18
tax-inclusive concepts (sandbox decides); D19 globals cancelled by the owner with motive 02; D20
no E-Receipts; D21 series F, FG, NC; D22 test receptor EKU9003173C9 (unverified); D23 the user
supplies the test key. The accountant confirms D4, D5, D11 and the RESICO retention.

## Open items

- **Sandbox verification still open** (the 2026-10-07 rehearsal covered the shared sandbox flows
  in the status above): the `organizations` provider (an organization per restaurant, its test
  key, the CSD upload), a cancellation that needs the receptor's acceptance, credit notes (the
  rounding and identity of an egreso to PUBLICO EN GENERAL, which carries no InformacionGlobal:
  CFDI40130 requires that node only for type "I", and SAT's Apéndice 2 egreso examples have none)
  and substitutions, the RESICO monthly global close, email delivery, the alerts, the
  undocumented `idempotency_key_in_use` status and the recorded fixtures
  (`npm run test:facturapi:sandbox`). Facturapi's test mode does not validate receptor names
  (LD-51 F5), so the name check is first seen in live mode; Base vs Importe rounding of
  tax-inclusive concepts (D18) is for the provider and the accountant to confirm on sample XML
  (F6). Staging: the global rehearsal with a real cutoff (LD-16 "Missing items"); the staging
  test key's organization carries a real taxpayer identity (LD-51 F4, a user decision in
  [LAUNCH_HANDOFF.md](LAUNCH_HANDOFF.md) 1.14).
- **Live qualification** with a real CSD and production approval.
- **Second-opinion items not done** (lows unless noted; LD-33 "lows when cheap"): a failure
  email to the portal customer (UX-3's last part: no transactional email channel exists for a
  document that never stamped); a durable per-ticket cap on portal access attempts (SECRETS-3,
  the masked RFC is no longer shown before the check); rotating a restaurant's own Facturapi
  keys (SECRETS-4); redacting receptor data of never-stamped requests (SECRETS-7, account's
  ARCO tooling); relating a supplementary part to a canceled global with 04 (SAT-6); the
  self-invoicing deadline at the end of the business day rather than the calendar day (SAT-7);
  credit-note decisions deferred, not dropped, while CFDI is paused (WORKER-5); refreshing the
  status store when settings change on another device (UX-7); the RESICO note in the dialogs
  (UX-17); test-mode QR on real receipts (UX-13, a lead decision).

## Sources

- Facturapi OpenAPI v2 and guides: FacturAPI/facturapi-docs commit
  `1c2e617776da4600ce3bac02a6aab6b0b3fcc88a` (2026-09-19); Node SDK types (Context7
  `/facturapi/facturapi-node`): `Organization.legal` (`tax_id`, `tax_system`, `address.zip`) for the
  shared sandbox issuer, `FacturapiError.logId` from the `x-facturapi-log-id` header (errors.mdx
  "Useful headers": the request correlation id) for the job log line; the cancellation receipt
  endpoint ("does not necessarily prove that the CFDI is already canceled; check the invoice
  status").
- SAT Anexo 20 (CFDI 4.0), "Guía de llenado del CFDI global" (Apéndice 2, routes I and III),
  cancellation FAQ 2026; RMF 2.7.1.21; CFF art. 29-A (cancellation deadline); LISR art. 113-J.
- zod 4.3.6 (Context7 `/colinhacks/zod`), jose 6 (JWE/ECDH-ES), express-rate-limit 8
  (`ipKeyGenerator`), qrcode.react 4.2.0 (Context7 `/zpao/qrcode.react`).
