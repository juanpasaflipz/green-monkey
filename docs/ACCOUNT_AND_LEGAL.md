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
| Aviso de privacidad integral (LFPDPPP Art. 15, simplified modality Art. 16-II in `#simplificado`) | `/legal/privacidad` | `/legal/privacy` | every account (acknowledgment), plus the separate express consent for billing data by primaries |
| Términos del servicio | `/legal/terminos` | `/legal/terms` | every account |
| Contrato de encargo de datos (DPA: Green Monkey processes diner and staff data for the restaurant, the responsable) | `/legal/encargo-de-datos` | `/legal/data-processing` | the primary owner, per organization |

The simplified notice shown next to "Continuar con Google" is
`PRIVACY_SIMPLIFIED` rendered with `legalText`, the same versioned text as
`/legal/privacidad#simplificado` (one source, LEGAL-1): the responsable's name
and domicilio, the data (name, email and Google identifier, technical session
data) with "no recabamos datos personales sensibles", the purposes, how to
limit use and where the integral notice is. The Google button appears only
once `/api/account-config` has loaded, so no sign-in starts without it.

The processor lists (privacy §5, DPA §6) name Google, Stripe, Neon, Railway,
Cloudflare (encrypted backup storage), GitHub (backup runs) and, only when a
restaurant enables CFDI, Facturapi (stamping through a PAC and CFDI email);
the DPA's §2 covers CFDI receptors' data and the restaurant's CSD, and §11
allows communications the law requires or the responsable instructs (PAC,
SAT). Sentry is not listed: add it (a material DPA change, 15 days' notice)
only if the error reporter is approved (LAUNCH_HANDOFF). Privacy §10 and DPA §9
disclose the encrypted backups and their lifecycle (LEGAL-2, UX-5, DATA-2).

`/legal` lists them. The pages render outside the POS shell, work from the
offline shell (with a "connect to see the current version" notice when the
configuration cannot load) and print cleanly. The QR/kiosk footer links to
`/legal/privacidad#restaurantes`, the section that explains Green Monkey's role
as encargado for diners.

Each document has a `version`, a `requiresAcceptanceSince`, the
`previousVersion` and `previousRequiresAcceptanceSince` it replaces (null for
the first), an `announcedAt` and an `effectiveFrom` (all `YYYY-MM-DD`, versions
optionally `.n`; dates are 00:00 Mexico City). Acceptance rows
(`legal_acceptances`, append-only, `accepted_at` forced to the server's time,
no TRUNCATE) record the version, the content hash, the entity hash, whether the
documents were published, the locale, the context (`signup`, `invitation`,
`reacceptance`, `transfer`) and, for the DPA, the organization. The **express
consent for billing data** (LFPDPPP Art. 7, privacy §2) is its own checkbox
wherever a person becomes a primary owner (signup, transfer) and its own row,
document `billing_consent`, versioned with the privacy notice (UX-3); a primary
without one is asked with the next acceptance in the console.

Where an account stands with a document (`acceptanceStatus`, LEGAL-3):

- **required** (gates the commands below with `428 legal_acceptance_required`):
  never accepted; accepted as an unpublished draft; or a material change is in
  effect (`effectiveFrom` passed) and the acceptance is older than
  `requiresAcceptanceSince` (or older than the previous material version, which
  the announcement window never relaxes);
- **announced**: that material change is announced but not in effect yet. The
  console shows "Nuevas versiones de nuestros documentos" with the date, each
  document's link and changes, and an optional early acceptance; owners and
  Google-entered managers see a dismissible POS banner from `announcedAt`;
- **entity_updated**: only the responsable's data changed (entity hash). Not
  material: the console shows the generated entry "Datos del responsable
  actualizados …" and an optional acceptance under the new data;
- **updated**: a newer non-material version: shown with its changes, never
  asked again;
- **accepted**. Unpublished documents are never required.

The re-acceptance path reaches everyone the documents apply to (LEGAL-4):
primaries and co-owners, and Google members such as invited managers (any
account with an active membership or an earlier acceptance) in the console and,
when they entered through Google, in the POS shell; the DPA part only for the
primary. A brand-new account accepts with its first command instead.

### How to publish a new version

1. Edit the text in `shared/legal/<document>.ts` (both languages).
2. In `LEGAL_DOCUMENTS` (`shared/legal.ts`) set `previousVersion` and
   `previousRequiresAcceptanceSince` to the outgoing values, `version` to the
   release date, `announcedAt` to the day the text deploys, and add the human
   summary to `changes` (es and en).
3. **Non-material change** (typos, clarifications): leave
   `requiresAcceptanceSince` alone and set `effectiveFrom` = `announcedAt`.
   Accounts see the change listed ("updated"); nobody is asked again.
4. **Material change** (new purposes, new transfers or sub-processors, new
   obligations): set `requiresAcceptanceSince` to the new `version` and
   `effectiveFrom` **at least 15 days after** `announcedAt` (terms §13,
   privacy §12, DPA §6; `tests/legal.test.ts` refuses less). Until
   `effectiveFrom` accounts see the announcement and may accept early; from
   `effectiveFrom` every account that accepted an older version sees
   "Actualizamos nuestros documentos" in its account console, and owners see
   "Hay documentos legales por aceptar en Cuenta." in the POS shell. Until they
   accept, these commands answer `428 legal_acceptance_required`: signup, staff
   and co-owner invitations, invitation acceptance (unless the request carries
   the acceptance), new locations, Free location selection, transfers, billing
   requests and the tax profile. POS entry, logout, the account overview and
   every POS route are never gated, and neither are the security actions that
   take access away: removing a co-owner (UX-1), leaving co-ownership and
   cancelling or declining a transfer.
5. Changing the legal entity values (name, address, RFC, privacy contact,
   jurisdiction) changes the entity hash: accounts see "Datos del responsable
   actualizados" and nothing is gated. When the change is material (a different
   company becomes the responsable or the provider), mark it so: publish a
   material version of each document (step 4) whose `changes` say what
   changed, announced 15 days ahead.
6. Run `npm test` (`tests/legal.test.ts` checks every template token, the
   version order, the 15-day notice for material changes, the simplified
   notice's Art. 15 I-IV elements and the processor lists) and the browser
   legal suite.

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
`ficticia`). In production (`APP_ENV=production` or Railway's production
environment) it also refuses the identifying values of the fictional CI set
(its entity name, address, contact emails, any address at its domain and its
phone; ACC-18), so a copied test block cannot publish a fictional data
controller; its jurisdiction and hours are ordinary values and stay
allowed. The documents are `published` only when every required value is
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

**CI** publishes a fictional, plausible set (`server/legal-ci.ts`, re-exported
by `tests/fixtures/legal-ci.ts`; "Nopal Verde Software S.A. de C.V.") only on the compiled browser and
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
and `account.owner_seat_revoked {…, invitations}` are written. Its offline
queued sales go to manager reconciliation.

The departing account's **unaccepted invitations** (staff and co-owner, at
every location) are revoked in the same transaction (ACC-15), and the
`co_owner_removed` / `co_owner_left` / `transfer_completed` events record
`invitationsRevoked`. A removed co-owner therefore cannot rejoin through a
manager invitation they sent to themselves; only a current owner's invitation
brings them back. Removing or losing a co-owner also **cancels a pending
ownership transfer addressed to them** (AUTHZ-1), by account (a recovery-code
or claimed transfer) or by email (an unclaimed link): the primary's removal
records `canceled_by='owner'`, leaving records `canceled_by='target'`, each with
a `transfer_canceled` event (`reason` `co_owner_removed` / `co_owner_left`) and
`transfersCanceled` on the removal event; the cancellation runs under 931, then
the transfer key 932. As defence in depth, `acceptTransfer` refuses
(`transfer_unavailable`) a target whose co-ownership the primary removed after
the transfer was created. Acceptance also checks the creator's standing (defence in
depth): a staff invitation needs its creator to still hold an active owner
seat at that location, a co-owner invitation needs its creator to still be the
primary. Revocation and acceptance serialize on the organization's co-owner key
(931): `acceptInvitation` takes it before it locks the invitation row, and every
seat revocation holds it, so an acceptance either completes first or sees the
revocation.

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
loses every seat. Their pending invitations do not outlive the transfer
(ACC-15): leaving revokes all of them with the seat; staying revokes their
co-owner invitations (inviting co-owners is the primary's power) and keeps
their staff invitations. Support and recovery-code transfers always have the
previous owner leave, so all of that account's invitations are revoked. The Stripe customer and saved payment method stay attached to
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
`owner_memberships.revoked_at/revoked_by`, `restaurant_entitlements.pro_ended_at`
(trigger-owned, see Plan lapse) and the `co_owner` invitation role and `support`
entitlement source.

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
`support_actions`, the unlock's audit row, PIN lock counters (unlock), support
entitlements, support-initiated transfers, the Free device slot and, for ARCO
requests, owner account name, email and `active` and a closed transfer's
email digest. It never reads secrets (token hashes, secret hashes, CFDI
secrets). **Every write is bound to its log row** (LD-32 AUTHZ-2, OPS-2):
restrictive policies accept a `gm_support` write only with a `support_actions`
row the same login wrote in the same transaction (`created_at = now()`, forced
by the trigger) for that tenant or organization and target, and bound the
values (unlock only clears; the audit grant excludes `created_at`, and the row
must be the unlock's own `access.employee_unlocked {by:"support"}`; the Free
slot only moves to the logged device; an account row must equal the logged
state, compared as digests). The insert trigger fills a tenant action's
organization, so its owners always see it. `ownership_transfer_guard` allows
exactly one change to a closed transfer: replacing its email by
`redacted:<sha256>` (ARCO cancellation). support-db checks 3c and 9-12.

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
  (trialing, active) or the earlier of `access_until` and `pro_ended_at`
  (past_due, canceled, paused, and support's end-entitlement, which keeps the
  grant's end); a Stripe `free` row gives none. `pro_ended_at` is the moment a
  write took the row out of Pro, bounded by its end date then; 031's
  `entitlement_pro_ended` trigger owns it, so the billing worker's reconcile
  (it rewrites `updated_at` at least every 15 minutes even when nothing
  changed), past_due → canceled and a repeated end-entitlement never move it,
  and a drawer opened on Free during dunning never continues (ACC-21). Rows
  last written before 031 carry none (fail closed).
  A new drawer cannot open under continuation, and the offline window is not
  renewed under it (LD-15 Q5). Configuration saves that are selling-gated also
  pass for active employees on that device (still permission-gated).
- **Automatic Free slots** (default `auto` mode): during Pro every drawer open
  moves the Free device slot to that device and gives the opener (non-owner) an
  employee slot; on Free, a slot device that never opened a drawer yields to the
  first device that opens one. An explicit owner selection switches to `manual`;
  "Volver a automático" switches back. Moves write `plan.free_slot_auto`. This
  write happens inside `/cash/open` under the Free-limits lock (documented lock
  order exception E7, docs/ARCHITECTURE.md).
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

## Deploy note: invitations accepted during the 031 window (ACC-22)

031 adds `membership_tenant_read`, which lets a tenant-scoped transaction read
every owner membership of that restaurant. Between the migrate step and the
new web revision taking traffic, the previous revision still serves, and its
`acceptInvitation` looks for "an existing membership" by tenant only: it now
finds the primary owner's seat, marks the invitation accepted with the owner's
employee and creates no seat for the invitee. Nobody gains access, but the
link is spent: the new revision treats it as already accepted by the invitee,
whose entry to the restaurant is then refused (`forbidden`).

This can only happen in an environment that served a pre-031 revision with
live invitations (staging; production has no restaurants before go-live).
After such a deploy, list the spent invitations once with a role that bypasses
RLS (the Neon owner role); a role without BYPASSRLS sees no rows here:

```sql
select i.tenant_id, i.id, i.email, i.role, i.accepted_at
  from restaurant_invitations i
 where i.accepted_by is not null
   and not exists (select 1 from owner_memberships m
                    where m.tenant_id = i.tenant_id and m.account_id = i.accepted_by)
   and exists (select 1 from owner_memberships o
                where o.tenant_id = i.tenant_id and o.employee_id = i.employee_id
                  and o.account_id <> i.accepted_by);
```

For each row, ask that restaurant's owner to invite the same email again
(owner console, "Invitar a tu equipo"): the new revision accepts a new
invitation normally.

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
  Without it those 14 tests fail on the closed signup, not on a product bug.
  The DB, HTTP and drain suites do not need it (account-http starts its own
  servers with and without the set).
- **Load smoke (LD-15 Q8, LD-32 OPS-3): done.** `scripts/load/seed-load.ts`
  seeds every load restaurant as a Free location on Pro (automatic Free
  slots) with cashiers allowed to close their drawers, three extra cashiers
  and a second register; `scripts/load/run-load.ts` cycles drawers on that
  register through the load phase while PIN sign-ins run, and fails the smoke
  on any `409 concurrent_update` (`concurrentUpdates`, `drawersCycled` and,
  with `LOAD_SERVER_LOG`, `dbRetries` in the evidence). A local smoke on the
  merged tree: 57 drawers cycled, 59 slot evictions, 0 `concurrent_update`,
  0 `db_retry`. ARCHITECTURE E7 lists the writers as built after the platform
  hardening (every one that locks an employee or device row and needs 920
  takes 920 first).
- **Trial merge with integration (ACC-16).** A scratch merge of this track
  with release/v1 at e503521 (platform hardening, LD-20/LD-21) passes
  typecheck, lint and all unit tests, including the hardened lock-order
  ratchet (`tests/lock-scan.ts`) and `tests/db-retries.test.ts`, with these
  resolutions:
  1. `docs/ARCHITECTURE.md`: keep integration's E5 and E6 (LD-21), then
     account's exception, already numbered **E7** on this track (rows 13 and
     30 cite E7); row 30 takes account's text, rows 31 to 33 integration's.
  2. `tests/account-db.ts`: wrap the two concurrent bursts (`results` in
     checks 11 and 22) in `noRetries("…", () => Promise.allSettled(…))` and
     import `noRetries` from `./db-retries.js`, which exists only on
     integration.
  3. `src/labels.ts`: union integration's `job.requeued` / `job.cancelled`
     rows with account's `account.*` and `plan.free_slot_auto` rows.
  4. `tests/free-limits-db.ts`: union the imports (integration's `pinSignIn`
     and `noRetries`; account's `sellingAccess`, `autoAssignFreeSlots`,
     `freeSelectionMode`, `requireDrawerOpenAllowed`, `setFreeSelectionMode`,
     `addRound`, `createSession`, `authentication`, `legalConfig`) and keep
     integration's PLATFORM-LOCKS-6 / PLAT-HR-9 bursts before account's ACC-14
     selection-switch check (both leave the other device selected).
  5. `docs/LAUNCH_HANDOFF.md` legal-values bullets: take account's text (031
     is implemented).
- **Lock scanner units.** The account-center routes pass their handlers
  inline (`router.post(path, limiter, (req, res, next) => answer(…))`), so the
  scanner checks each request as its own unit; the earlier
  `registerPreAuth:11>3` report (every handler of `registerPreAuth` read as
  one transaction) is gone without an allowlist entry. The scanner classifies
  the organization keys 931 (co-owner limit) and 932 (transfers) as LO-3 area
  keys. They are organization-scoped (`hashtextextended(organizationId, …)`)
  and always taken before any tenant lock, like 711, 918, 919 and 921, so
  listing them as LO-0 organization classes in `tests/lock-scan.ts` would be
  more accurate; the ratchet passes either way (lead decision for the
  platform-owned scanner).

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
