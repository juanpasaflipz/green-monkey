# Account and legal (migration 031)

Status: **implemented locally** on `track/account` and qualified with the local
suites (unit, `test:db:account`, `test:db:support`, `test:account-http`,
browser). The legal entity is **not configured** in any deployed environment
and the document text is a draft pending **counsel review** (D1, D2). No
provider (Stripe, Google, Facturapi) behaviour was verified live for this area.

This area covers the platform's own legal documents and their acceptance, the
owner's account console (co-owners, ownership transfer, recovery codes, support
actions, activity), the vendor support CLI, the owner data export, the
restaurant's own privacy notice link for QR/kiosk diners, plan-lapse
continuation and notices (GAP-1), the SaaS tax mode (GAP-6, off by default) and
the interim public-ordering switch.

## Documents and versions

The documents are code: `shared/legal.ts` (`LEGAL_DOCUMENTS`, versions and
paths) and `shared/legal/{privacy,terms,dpa}.ts` (Spanish governing text with an
English translation). Entity values are template tokens
(`{{entity.name}}`, `{{entity.address}}`, …) filled from configuration; nothing
about the legal entity is hard-coded.

| Document | Spanish path | English path | Accepted by |
| --- | --- | --- | --- |
| Aviso de privacidad integral (LFPDPPP Art. 15, simplified modality Art. 16-II in `#simplificado`) | `/legal/privacidad` | `/legal/privacy` | every account (acknowledgment) |
| Términos del servicio | `/legal/terminos` | `/legal/terms` | every account |
| Contrato de encargo de datos (DPA: Green Monkey processes diner and staff data for the restaurant, the responsable) | `/legal/encargo-de-datos` | `/legal/data-processing` | the primary owner, per organization |

`/legal` lists them. The pages render outside the POS shell, work from the
offline shell (with a "connect to see the current version" notice when the
configuration cannot load) and print cleanly. The QR/kiosk footer links to
`/legal/privacidad#restaurantes`, the section that explains Green Monkey's role
as encargado for diners.

Each document has a `version` and a `requiresAcceptanceSince` (both
`YYYY-MM-DD`, optionally `.n`). Acceptance rows (`legal_acceptances`,
append-only) record the version, the content hash, the entity hash, whether the
documents were published, the locale, the context (`signup`, `invitation`,
`reacceptance`, `transfer`) and, for the DPA, the organization.

A document is **pending** for an account when the documents are published and:
it was never accepted; or the latest acceptance is of a version older than
`requiresAcceptanceSince`; or it was accepted for another legal entity (entity
hash); or it was accepted while unpublished. Unpublished documents are never
pending.

### How to publish a new version

1. Edit the text in `shared/legal/<document>.ts` (both languages).
2. In `LEGAL_DOCUMENTS` (`shared/legal.ts`) set `version` to the release date
   and add the human summary to `changes` (es and en).
3. **Non-material change** (typos, clarifications): leave
   `requiresAcceptanceSince` alone. Nobody is asked again.
4. **Material change** (new purposes, new transfers, new obligations): set
   `requiresAcceptanceSince` to the new `version`. Every account that accepted
   an older version sees "Actualizamos nuestros documentos" in its account
   console, and owners see "Hay documentos legales por aceptar en Cuenta." in
   the POS shell. Until they accept, these commands answer
   `428 legal_acceptance_required`: signup, staff and co-owner invitations,
   invitation acceptance (unless the request carries the acceptance), new
   locations, Free location selection, transfers, billing requests and the tax
   profile. POS entry, logout, the account overview and every POS route are
   never gated.
5. Changing the legal entity values (name, address, RFC, privacy contact,
   jurisdiction) changes the entity hash and therefore also asks everyone
   again; plan it like a material change.
6. Run `npm test` (`tests/legal.test.ts` checks every template token and the
   version order) and the browser legal suite.

## Configuration checklist

All are web-process variables (registered by Wave 2.0 in `.railway/railway.ts`
and `.env.example`).

| Variable | Required to publish | Notes |
| --- | --- | --- |
| `LEGAL_ENTITY_NAME` | yes | razón social / name (Art. 15-I), 3–200 chars |
| `LEGAL_ENTITY_ADDRESS` | yes | domicilio, 10–300 chars |
| `LEGAL_ENTITY_RFC` | no | validated with the fiscal core's `validateRfc`; never invent one |
| `LEGAL_PRIVACY_CONTACT_EMAIL` | yes | personal-data department (ARCO requests) |
| `LEGAL_PRIVACY_CONTACT_NAME` | no | default "Departamento de datos personales" |
| `LEGAL_JURISDICTION` | yes | courts' city for the terms |
| `SUPPORT_EMAIL`, `SUPPORT_PHONE`, `SUPPORT_WHATSAPP` (E.164), `SUPPORT_HOURS`, `SUPPORT_HOURS_EN`, `SUPPORT_URL` (https) | no | shown in Help, the legal pages and the landing footer |
| `LEGAL_UNPUBLISHED_SIGNUP` | no | only `allow`, only outside `APP_ENV=production`: signup while unpublished (acceptances recorded with `published=false`) |
| `PUBLIC_ORDERING_ENABLED` | no | see below |
| `SAAS_TAX_MODE`, `SAAS_COLLECT_TAX_ID`, `SAAS_TAX_PROFILE_ENABLED` | no | web; `STRIPE_TAX_RATE_ID` is worker-only (see BILLING_IMPLEMENTATION) |

`legalConfig()` (`server/legal.ts`) refuses empty or malformed values,
brackets/braces, placeholder markers (anywhere: `replace`, `placeholder`,
`changeme`, `lorem`, `xxx`; as whole words: `example`, `tbd`, `sample`,
`dummy`, `acme`, and `TODO` in capitals only, so "Todos Santos" or "Comida para
Todos" publish), example domains and reserved TLDs, and under `NODE_ENV=production` also
test/demo words (`test`, `prueba`, `demo`, `fixture`, `ficticio`,
`ficticia`). The documents are `published` only when every required value is
valid; otherwise **no** entity value reaches a client. Startup logs
`legal_documents_unpublished` with the field names (never values): error level
when `APP_ENV=production`, warning elsewhere. `legal_unpublished_signup_ignored`
(error) means production has `LEGAL_UNPUBLISHED_SIGNUP` set; it has no effect
there.

`GET /api/account-config` (public, cached 5 minutes) returns the status, the
entity when published, the document versions and paths, the support channels,
the SaaS tax display mode and `publicOrdering.enabled`. Outside production it
also lists the `missing` variable names.

While unpublished: legal pages show "Documento no vigente…", highlighted
"Dato pendiente de publicar" chips and `noindex`; new Google accounts get
`signup_paused` (unless the non-production override applies); existing accounts
sign in; the POS is never affected.

**CI** publishes a fictional, plausible set (`tests/fixtures/legal-ci.ts`,
"Nopal Verde Software S.A. de C.V.") only on the compiled browser and
account-http steps of `qualification.yml`; the job sets
`LEGAL_UNPUBLISHED_SIGNUP=allow` for everything else. These values are never
copied to Railway. For local browser runs, start the compiled server with the
same set: `scripts/compiled-local.sh` sources `tests/fixtures/legal-ci.sh`, and
any other start runs `. tests/fixtures/legal-ci.sh` first (`.env.example` lists
the values as commented, test-only lines). `tests/legal-fixtures.test.ts` keeps
the four copies equal and fails if a DB, HTTP or browser fixture calls a
legal-gated function without an explicit legal configuration, so a published
set in a local `.env` never changes a DB suite.

## Owners, co-owners and transfers

Roles per organization: one **primary** owner (`organizations.created_by_account`)
and up to **3 co-owners** (`organization_co_owners`). Co-owners have full POS
and management control of every location; billing, new locations, transfers and
the tax profile stay with the primary. Co-owners are owners for Free limits and
never use the two Free employee slots.

Sensitive commands (invite or remove co-owners, transfer, recovery codes)
require a **fresh Google session** (≤ 15 minutes since sign-in); otherwise the
console asks to sign in again (`reauthentication_required`).

**Co-owner lifecycle**

```
invited (restaurant_invitations role=co_owner, 7 days, email-bound link /app?account=1#invite=…)
  └─ accepted ─▶ active (organization_co_owners; owner seat + membership at every location)
        ├─ removed by the primary ─▶ removed (removal='removed')
        └─ leaves ─────────────────▶ removed (removal='left')
removed ─ re-invited ─▶ active (same employee rows reactivated)
```

An owner seat is an `owner` employee with login `account-<accountId>` and **no
usable PIN**; co-owners enter the POS from their own browser with Google, and set
"Mi PIN para terminales compartidas" themselves (access's owner-PIN flow) to use
a shared terminal. Revoking a seat (removal, leaving, or the previous owner not
staying after a transfer) follows access's deactivation exactly
(LD-15 Q4): the seat is deactivated and loses any Free slot, its sessions end
(`employee_deactivated`, revoked), its open pairing codes are cancelled and its
personal devices retired through access's actor variant
(`retirePersonalDevicesAs`), the membership is revoked, and the audit rows
`access.employee_deactivated {name, sessions, pairingCodes, personalDevices}`
and `account.owner_seat_revoked` are written. Its offline queued sales go to
manager reconciliation.

**Ownership transfer**

```
owner request (primary, fresh session, types the organization name)
  → pending: link /app?account=1#transfer=… to one Google email, 72 h
support request (CLI) → pending with a hold (default 72 h, minimum 24 h)
recovery code redeemed → pending with a 24 h hold, then 7 days to complete
pending ─ accepted by the target (email must match, after any hold; accepts
          terms, privacy and the organization's DPA) ─▶ completed
pending ─ cancelled by the primary or the target, or expired ─▶ closed
```

At completion the target becomes primary (`organizations.created_by_account`),
gets owner seats everywhere, and the previous primary either stays as a
co-owner ("Seguir como copropietario", unavailable when 3 co-owners exist) or
loses every seat. The Stripe customer and saved payment method stay attached to
the organization until the new owner changes them; the console tells them to
review linked devices, the Free selection and the billing email. Every step is
an `account_events` row (owners see "Actividad de la cuenta"); a transfer
started by support or by a recovery code is a critical banner for the current
primary in the console and in the POS shell. The primary's own pending transfer
appears only in the console ("Transferencia pendiente a …"); the shell never
shows it as a warning. The shell's owner block also reaches the primary's owner
seat entered with its PIN on a shared terminal (resolved through the seat's
active `owner_memberships` row, not only a Google entry), so the warning is seen
wherever the primary works during the 24 h or 72 h hold; there the banner says
to cancel from their own phone or computer, because terminals never open the
account console (decision recorded for review finding ACC-5; spec §4.8 step 1
only read `sessions.owner_account_id`).

## Recovery

- **Recovery codes** (any account): "Generar códigos nuevos" (fresh session)
  returns 10 single-use codes once (`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`, Crockford
  base32; the first 8 characters are the lookup, the rest is stored as scrypt).
  Generating new codes revokes the old ones. The console then shows only how
  many remain.
- **Redeem**: a new Google account signs in and enters a code in "¿Perdiste
  acceso a tu cuenta anterior?". It schedules a transfer of the organization
  the old account owns (as primary) to this account, held 24 hours (the old owner sees the
  critical banner and can cancel), then completable for 7 days. Wrong, used or
  revoked codes answer `recovery_code_invalid`; an old account with nothing to
  recover answers `recovery_nothing_to_recover` and keeps the code. Limits:
  5 attempts per hour per IP and per owner session (`429 rate_limited`).
- **Without codes**: support-assisted transfer after identity verification
  (docs/OPERATIONS.md, Support). Verified-email recovery is deferred.

## Data model and RLS (GUC leaf policies)

Migration `031_account.sql`: `legal_acceptances`, `organization_co_owners`,
`ownership_transfers`, `account_recovery_codes`, `account_events`,
`support_actions` (append-only, operator forced to `session_user`),
`restaurant_account_settings` (tenant-scoped: privacy URL, Free selection mode),
`organization_tax_profiles`, plus `owner_sessions.created_at`,
`owner_memberships.revoked_at/revoked_by` and the `co_owner` invitation role and
`support` entitlement source.

Account tables are scoped by transaction-local settings, never by `app.tenant_id`
alone: `app.account_id` (the signed-in owner account), `app.organization_id`
(set by `organizationScope` after the caller's role is checked),
`app.transfer_id`/`app.transfer_hash` (a transfer link), `app.invitation_hash`
and `app.recovery_lookup`/`app.recovery_account_id`. **Leaf-policy rule:** a
policy may compare a row's own columns with these settings and may read only
tables whose policies do not read back into the table being protected; no
policy calls a function that queries another RLS table. This keeps policies
free of recursion (account-db check 32 is the smoke test). History tables are
INSERT-only for the runtime role, guarded by triggers, and test cleanups use one
admin transaction with the named triggers disabled (LD-12).

The support role `gm_support` (from `scripts/ops/sql/globals.sql`) reads
column-scoped account and tenant data and writes only what its commands need:
`support_actions`, audit rows, PIN lock counters (unlock), support
entitlements, support-initiated transfers and the Free device slot. It never
reads secrets (token hashes, secret hashes, CFDI secrets).

## Owner data export

Settings › "Privacidad y datos" › "Exportar datos del restaurante" (owner and
co-owners; works on Free, after a lapse and on unselected devices).

- **Step-up rule:** every export first calls `GET /api/account-data/tables`,
  which requires `permit(owner)` and `requireRecentAuth`. On a shared terminal
  whose PIN is not recent the client shows "Confirma con tu PIN"; only after it
  succeeds does the download start, inside the step-up window. The download
  routes repeat both checks, so a stale or copied link answers
  `403 step_up_required`. Personal owner browsers (Google entry) never prompt.
  A refused step-up does not spend the export budget. The same pre-check
  answers `429 export_busy` while an export of the restaurant is running and
  `429 rate_limited` once the hourly budget is spent, so the browser never
  starts a download that would save an error body as the export file; a
  download refused as `export_busy` does not spend the budget either.
- `GET /api/account-data/export.json?tenant=<id>` streams one JSON document:
  `{"format":"green-monkey-export","version":1,"exportedAt",…,"restaurant":{…},
  "units":{"money":"minor (centavos)"},"tables":{"<table>":[rows…]}}`.
- `GET /api/account-data/export/csv/<table>?tenant=<id>`: one table, UTF-8 with
  BOM, CRLF, formula-injection guard (shared/csv.ts), JSON for objects.
- `tenant` must equal the session tenant (`409 session_changed`).
- Every table with a `tenant_id` column is included, minus the denylist in
  `shared/account-export.ts` (sessions, operations, offline leases, owner
  devices, memberships and location commands, invitations, billing bindings,
  jobs, support actions, `cfdi_secrets`, `cfdi_files`) and every column whose
  name has a `hash`, `secret`, `token` or `csrf` segment. New areas: name a
  secret column accordingly or add it to the denylist.
- One export per tenant at a time and two per process (`429 export_busy`),
  10 per hour per tenant (`429 rate_limited`), 60 s statement and idle
  timeouts, client aborts cancel the cursor, `Cache-Control: no-store`, and an
  `account.data_export {format, table}` audit row.
- Filenames: `green-monkey-<slug>-<YYYYMMDD>.json` and
  `green-monkey-<slug>-<table>-<YYYYMMDD>.csv` (restaurant timezone).

## Restaurant privacy notice (QR and kiosk)

Settings › "Privacidad y datos": the owner sets an `https://` link to the
restaurant's own privacy notice (the restaurant is the responsable for its
diners' data). QR/kiosk pages show "Aviso de privacidad de {restaurante}" next
to the optional name field ("Nombre (opcional)", "Solo para llamarte cuando tu
pedido esté listo. Puedes usar un apodo."), or "Este restaurante aún no publicó
un aviso de privacidad; no escribas datos personales." when none is set.
`restaurantPrivacyUrl(tx)` is the anchor other diner pages (cfdi portal,
public ordering) use.

## Plan lapse (GAP-1)

- **Drawer continuation:** when Free rules would block selling but this device
  has a drawer opened **before Pro ended** and less than 16 hours ago, sales
  continue (`basis='drawer_continuation'`) until the drawer closes or the 16
  hours pass. A drawer opened on Free (never Pro, or after the lapse) gives no
  continuation (ACC-14): the end of Pro is the entitlement's `access_until`
  (trialing, active) or the earlier of `access_until` and its status write
  (past_due, canceled, paused, and support's end-entitlement, which keeps the
  grant's end); a Stripe `free` row gives none.
  A new drawer cannot open under continuation, and the offline window is not
  renewed under it (LD-15 Q5). Configuration saves that are selling-gated also
  pass for active employees on that device (still permission-gated).
- **Automatic Free slots** (default `auto` mode): during Pro every drawer open
  moves the Free device slot to that device and gives the opener (non-owner) an
  employee slot; on Free, a slot device that never opened a drawer yields to the
  first device that opens one. An explicit owner selection switches to `manual`;
  "Volver a automático" switches back. Moves write `plan.free_slot_auto`. This
  write happens inside `/cash/open` under the Free-limits lock (documented lock
  order exception E5, docs/ARCHITECTURE.md).
- **Notices** (`GET /api/account/shell`, every 5 minutes): drawer continuation,
  failed payment, trial or support grant ending (7/3/1 days), Pro ended (7
  days), and "not selected" on Free; plus the owner's account notices.

## Public ordering switch (`PUBLIC_ORDERING_ENABLED`)

Why: QR/kiosk links are signed 24-hour bearer links without revocation, unpaid
QR orders reach the kitchen, and tables are not bound (SEC-7, FIT-11, FOH-13);
the public-ordering area (032/033) fixes them. Until it ships, production must
not expose QR or kiosk ordering.

- Values `true`/`false`; unset means `false` when `APP_ENV=production` and
  `true` elsewhere; anything else stops the web with
  `public_ordering_flag_invalid`.
- When `false`: every `/api/public/*` request answers
  `404 public_ordering_disabled` before any token is read or any limit is
  counted (malformed JSON still gets `400 invalid_json`), `POST
  /api/ordering-links` answers the same, the link generator is hidden,
  PlanSettings says "Kiosco y pedidos QR: próximamente.", the landing does not
  advertise QR/kiosk, and an old QR/kiosk link shows only "Los pedidos en línea
  no están disponibles por ahora. Pide en el mostrador."
- Owner: account owns the flag, `publicOrderingEnabled()`,
  `publicOrderingGate()` and the error code. The public-ordering area decides
  whether it stays as an operator kill switch or is removed when 032 ships.

## Shared-terminal guard

Every non-GET request under `/api/auth/account` and `/api/auth/account-center`
from a paired shared terminal answers `403 device_is_terminal` (access's guard;
account-center commands included). The console is never rendered on a
terminal. Without an owner Google session the console answers
`401 unauthorized`. Reads of the console overview share the owner routes'
120/minute read budget; commands have their own 30/minute limit.

## Merge notes (integration)

- **Browser qualification needs the legal set.** From this merge the signup,
  legal, account, landing and access-owned `owner.spec` browser tests need
  published legal documents: under `NODE_ENV=production` an unpublished set
  pauses signup. CI already sets it (`qualification.yml`: job-level
  `LEGAL_UNPUBLISHED_SIGNUP=allow`, the fictional set on the browser and
  account-http steps). Any other harness that starts the compiled server for
  the browser suite (the integration qualification script, a track's browser
  command) must start it after `. tests/fixtures/legal-ci.sh`, for example
  `(. tests/fixtures/legal-ci.sh && PORT=… APP_URL=… NODE_ENV=production node build/server/index.js &)`.
  Without it those 11 tests fail on the closed signup, not on a product bug.
  The DB, HTTP and drain suites do not need it (account-http starts its own
  servers with and without the set).
- **Load smoke (LD-15 Q8).** The zero-`concurrent_update` assertion for
  `/cash/open` under load belongs in `scripts/load/run-load.ts`, an ops file
  account may not edit (LD-15 Q1): today the runner opens one drawer per tenant
  before its load phase and its report lists every error by route and code.
  Lead follow-up: open drawers during the load phase and fail the smoke on any
  409 `concurrent_update` (ARCHITECTURE E5).

## Merge notes (cfdi 030)

Built on a branch without cfdi's `server/cfdi/portal.ts`. At the account merge
(LD-16 missing items):

- **Privacy anchor:** the cfdi portal's restaurant-privacy anchor calls
  `restaurantPrivacyUrl(tx)` (`server/account-settings.ts`) inside its tenant
  transaction, so the self-invoicing page links the restaurant's own notice as
  the QR/kiosk pages do.
- **Export denylist:** `cfdi_secrets` and `cfdi_files` are already in
  `EXPORT_TABLE_DENYLIST`; account-db check 29c proves discovery never lists
  them even when the tables exist.
- **Export guard:** every `/api/account-data/*` route already requires
  `permit(owner)` and `requireRecentAuth` (step-up); nothing to add.

## Help and support

The topbar "Ayuda" and the login screen's "Ayuda y privacidad" open the help
dialog: the configured support channels (or "not configured"), the legal
documents, and inside the POS the restaurant ID (copyable) and device ID that
support asks for, plus the app version.

## Sources

- LFPDPPP, new law published in the DOF on 20 March 2025 (last reform DOF
  14-11-2025): Arts. 2, 7, 8, 10, 11, 15, 16-II, 18–20, 28–31, 34, 35–36.
  https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf
- In force since 21 March 2025:
  https://kpmg.com/mx/es/tendencias/2025/04/flash-nueva-ley-federal-de-proteccion-de-datos-personales-en-posesion-de-los-particulares.html
- Código Civil Federal Art. 1803 (consent by electronic means); Código de
  Comercio Art. 80; CFF Art. 30 (5-year retention); LIVA Art. 18-D.
- Stripe tax rates, tax ID collection and subscription `ended_at` (Context7
  `/websites/stripe`), referenced in docs/BILLING_IMPLEMENTATION.md.
