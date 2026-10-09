# Development operator guide

This application is under implementation and is not approved for live service.

1. With `DEMO_TENANT_ID` set to the fictional restaurant (local only), sign in on the demo form as the owner: login `owner`, password `demo-green-monkey`. This pairs the browser as a terminal. Any other browser pairs with a single-use code from **Configuración → Dispositivos → Vincular un dispositivo** (10 minutes). On a paired browser staff tap their name under **¿Quién entra?** and enter their PIN: `cashier` / `123456`, or `kitchen` / `654321`. PIN sessions lock after 3 minutes without input (per-device setting; kitchen staff do not lock by default); refunds, discounts, paid-outs, self-approved voids and staff/device commands ask for a fresh PIN on terminals (a manager's PIN typed in a discount or refund dialog is the only PIN asked). Staff, devices, lockout and runbooks (lost tablet, fired employee, locked manager): [access](ACCESS.md).
2. Owners open **Operación → Caja**; cashiers open **Caja**, enter the opening float, and save. The cash drawer belongs to the paired device.
3. Open **Vender**. Tap an ordinary product once; asada requires a salsa choice. Set service mode, table, call name, and notes.
4. **Enviar a cocina** persists an order and its first round. Use **Cocina** to acknowledge and mark tickets ready. The bar has its own station filter.
5. Return to selling. Add products and send another round without repeating earlier lines. **Cobrar** opens the payment workspace. Enter a smaller amount for partial payment; the remainder survives reload.
6. Use **Dividir por productos** to select individual units after sending the round. Amount splits allocate against remaining units in stable order. Already paid units stay paid after refund; older payments with no item allocations remain amount-only. The payment footer stays visible on mobile.
7. Cash is recorded locally in PostgreSQL. External terminal mode means staff explicitly confirm a separate device's approval; it is not integrated payment verification. Hardware printing remains disabled; browser printing does not acknowledge paper output.
8. A paid dine-in check keeps its table until **Liberar mesa** (on the receipt, the table card, the order row or when opening a new check); takeaway and tableless checks close when settled. **Órdenes** and **Mesas** list open checks; the kitchen display polls a versioned feed and shows a stale banner when it stops. Receipts and pre-bills print the order note, round notes and line notes, as kitchen tickets do. Print settings (80/58 mm, kitchen ticket on send, KDS auto-print) are per device. See [Service](SERVICE.md).
9. **Descuentos y reembolsos** ([discounts](DISCOUNTS.md), migration 028). **Descuento** (Vender, Órdenes, Detalle de orden) discounts unpaid sent items by line or for the whole check (percentage, fixed amount or a 100 % courtesy), with a reason; a cashier or server over their limit (0 % / $0 until the owner raises it under **Configuración → Descuentos y corte de caja**) needs a manager's PIN in the dialog, and that is the only PIN asked; a manager or owner confirms with their own PIN only when the terminal asks ("Confirma con tu PIN"). A discount that brings a takeaway check to zero closes it and is final; one that settles a dine-in table check issues its fiscal ticket, and the discount is final there too (the dialog warns first). **Reembolsar** (Órdenes, Detalle de orden) refunds **por productos** (fully paid units, returned to the cash and terminal payments that paid them; the kitchen is told not to prepare units it has not served; ingredients return to stock only when chosen) or **por importe**; neither while a check without a fiscal ticket has a balance due: collect the payment or void the unpaid lines first. A terminal (card) refund is first done on the terminal, then recorded here with its reference and a confirmation; it never touches drawer cash. Staff need a manager's PIN. Print the **comprobante de reembolso** from the result (always in Spanish).
10. Receive stock, log preparation or waste, and review movements under inventory. A count uses a stock version; concurrent movements require refreshing the count before adjustment.
11. **Caja** shows cash and the external terminal apart: expected cash counts only cash payments, cash tips, cash refunds and paid-outs; terminal payments, tips and refunds are listed separately to compare with the terminal's batch report. By default the close is **blind**: **Cerrar caja** asks for the counted cash (and optionally the terminal's batch total) before showing anything, confirms, and only then shows owners and managers the difference ("Sobrante", "Faltante", "Cuadra"); cashiers and servers never see expected cash and close only when the owner allows it. A closed drawer cannot change; a manager explains a difference once under **Historial de cajas → Revisar diferencia**.
12. Fiscal (Mexico): the owner fills **Configuración → Datos fiscales** (RFC, razón social, régimen, C.P.; the fictional SAT test RFC `EKU9003173C9` locally). Every settled sale then gets a ticket with a consecutive folio, printed in Spanish with the IVA breakdown; **Registro de tickets** lists them, shows the IVA summary and downloads the accountant's CSV. Missing tickets, the `FISCAL_TICKETS_ENABLED` kill switch, series changes and the border-incentive expiry are in the [fiscal runbook](FISCAL.md#runbook).

13. **Pedidos en línea (QR y kiosco)** ([public ordering](PUBLIC_ORDERING.md), migrations 032 and 033; Pro). **Menú e inventario → Mesas → Código QR** creates a table's printable card (shown once; printing again is **Reemplazar e imprimir**, and the old code stops working at once); **Códigos QR de mesas** creates or replaces many at once. **Configuración → Pedidos en línea (QR y kiosco)** sets the two policies ("El personal confirma; se cobra después" or "Se cobra antes de enviar a cocina"), **Tiempo para confirmar**, **Importe máximo por pedido** (saved with **Guardar pedidos en línea**), and lists kiosks and takeaway codes with **Reemplazar** and **Desactivar**. Diners' orders wait in the inbox at the top of **Órdenes** (the rail and the tab show the count; elsewhere a banner says "2 pedidos en línea por confirmar"): **Aceptar y enviar a cocina**, **Cobrar y enviar a cocina** for pay-first (a manager may **Aceptar sin cobrar (excepción)** with a fresh PIN), or **Rechazar** with a reason. A changed price needs "Ya le avisé" before accepting. Any operator can **Pausar** online ordering; it also pauses by itself when no shared terminal (caja or mesero) has had Green Monkey open for 5 minutes. Abuse: **Rechazar → Pedido falso o abuso**, and a manager ticks "Desactivar también este código QR" ([runbook](RUNBOOK.md) "Online ordering abuse"). No online card payment exists: diners pay staff.

## Offline

Offline refresh requires the compiled server and service worker, not Vite development serving. Log in and open a drawer while connected first. Cash drafts and queued payments persist in IndexedDB. The sync screen retains errors and retries. Offline, new orders are paid in full in cash or recorded as an external-terminal payment (reference and confirmation required) under a device-prefixed provisional number; integrated payments, voids, refunds, discounts, item splits, settlements, drawer operations and stock guarantees are unavailable. Existing checks show "Disponible al volver la conexión" unless an owner or manager turns on **Servicio de mesa sin conexión** (Beta, off by default) on the Sync screen. After sync, rounds of offline sales wait in the KDS review lane until someone chooses **Preparar ahora** or **Ya se preparó**; a manager reconciles or archives conflicts on the Sync screen after a PIN step-up. **Cobrar juntas** refuses a check while this device holds unsynced offline records of it. See [offline recovery](OFFLINE_RECOVERY.md).

A pending local sale is not a kitchen acknowledgement. A selling session's offline window is a rolling four hours: while the device is in contact, the server appends a renewal whenever the window ends within 3 h 45 min, never past the session's absolute expiry (16 h after a PIN sign-in), and synchronization accepts a sale recorded inside any of those windows. Pending records survive logout. A session that **ended** (logout, switch, PIN reset, role change) still syncs its sales when the same employee signs in again on the same device; a **revoked** session (employee deactivated or device unpaired) sends its sales to manager reconciliation ([access](ACCESS.md)). Do not use this development build for operational offline sales.

## Database roles

`DATABASE_URL` must identify the least-privileged app role. `PG_APP_USER`, if supplied, must match that URL; no credential rewriting or owner fallback occurs. `PG_APP_PASSWORD` is retained as a documented compatibility placeholder and is not used; encode runtime credentials in `DATABASE_URL`. `ADMIN_SECRET` has no runtime bypass.

`MIGRATION_DATABASE_URL` is read only by migration/seed processes. Runtime verifies that its role is neither superuser, RLS-bypass, nor table owner. Transactions explicitly set restaurant context on the same connection. RLS enforces all tenant tables, including transaction-local cleanup after rollback.

The local `scripts/grants.sql` uses `gm_app`. For an isolated Neon target, provision the selected role explicitly and adapt grants to its identifier. Do not copy local passwords. The migration role must own the schema; the runtime role must not.

Every tenant transaction sets the restaurant and a `statement_timeout` (`DB_STATEMENT_TIMEOUT_MS`, default 10 s) in its first statement. Off-host connections verify TLS (`verify-full`), and the pool size comes from `DB_POOL_MAX` (default 20). At startup the server waits for the database with capped backoff instead of crash-looping. On SIGTERM it answers `/api/health` with 503 `server_draining`, finishes in-flight requests and jobs, then closes the pools. Roles, logins and their session defaults: [provisioning](PROVISIONING.md) §2 and [infrastructure](INFRASTRUCTURE.md).

Sandbox billing (`BILLING_SANDBOX_ENABLED=true`) needs the worker process: the web server only records owner billing requests and Stripe events, and the worker makes the provider calls. Locally, run `npm run worker` next to the web server, with `WORKER_PORT` set to a free port when the web server uses 3002 (as `scripts/compiled-local.sh` does).

## Staging and release

Release and operations live in their own documents: [release process](RELEASE.md) (CI on PostgreSQL 18, CD from `main` to staging, gated production dispatch, migration rules), [runbook](RUNBOOK.md) (signals and alerts, "POS is down" playbook, rollback, retention, credential rotation, staging cutover), [provisioning](PROVISIONING.md), [backups and restore](BACKUP_RESTORE.md) and [load test](LOAD_TEST.md). Electronic invoicing (CFDI) has its own runbook: onboarding, key rotation, alerts and restore in [CFDI](CFDI.md); retention never deletes `cfdi_*` rows. A pilot restaurant is set up with the [pilot operating guide](PILOT_SOP.md) (in Spanish: printers, tablets, pairing, selling without a connection), and production is launched by the business owner with the [launch hand-off](LAUNCH_HANDOFF.md). Railway configuration is `.railway/railway.ts` (`railway.json` is gone). CI builds and smoke-tests the Docker image, because this machine has no Docker CLI. These workflows and scripts are written and locally rehearsed, but none has run against staging yet. The staging service that exists today predates them ([STAGING.md](STAGING.md)).

Before deploying a separate staging service:
- Provision new Neon development/test targets and a least-privileged runtime role.
- Set unique `JWT_SECRET`, runtime and migration URLs in the secret store.
- Apply migrations under the advisory lock; run explicit grants and inspect RLS role checks.
- Deploy the Docker image, confirm `/api/health` and `/api/version`, then run the acceptance suite against that target.
- Validate pooled runtime and direct migration connections independently.
- Pair printer/payment hardware only after provider contracts and sandbox results are verified.

## Backup, restore and rollback rehearsal

Deployed environments use [backups and restore](BACKUP_RESTORE.md): encrypted off-platform dumps, nightly for production and weekly for staging (`npm run ops:backup`, `.github/workflows/backup.yml`), restore verification, and the Neon restore rehearsal (`npm run ops:rehearse-restore`). `tests/backup-db.ts` exercises them locally. No staging or production rehearsal has run yet.

A local disposable test backup/restore rehearsal passed with matching record counts and control totals. Run `bash scripts/rehearse-restore.sh` only with this checkout’s local fixture cluster; it refuses any other data directory. The following staging/application rollback steps remain unverified:
1. Record the source target, latest order/tender timestamps, migration versions, and source mappings.
2. Take a Neon branch/snapshot or an encrypted `pg_dump` using approved isolated credentials. Keep exports out of Git.
3. Restore to a new isolated database. Apply runtime grants and compare counts, tender sums, refunds, stock ledger balances, import mappings, and jobs.
4. Test login, tenant separation, one cash sale, refund, and report drill-down on the restored target.
5. Roll the application image back only to a schema-compatible version. Never silently roll financial data back to an earlier snapshot after live sales.
6. If traffic has changed systems, export and reconcile all post-cutover transactions before routing back. Production cutover needs an explicitly approved target, migration window, and reconciliation sign-off.

## Settings and service assignment

Owners edit restaurant name, timezone, cutoff and opening days under Configuración. Currency can change only before catalog/monetary records exist; amounts are never implicitly converted. New order receipts retain their restaurant configuration snapshot. Earlier receipts without that snapshot remain explicitly without one; no original branding is invented.

From Órdenes, **Mesa y mesero** changes the current assignment with a reason. It preserves the original creator and kitchen round numbering. Kitchen screens show the current table and assigned server. Service changes have their own optimistic version.

A lost cash-payment response keeps its original operation and target order. **Recuperar pago** retries that exact request, and reload automatically attempts recovery. An uncertain result never authorizes a second payment against another order. Authentication/permission conflicts remain retained for authorized recovery.

`bash scripts/rehearse-restore.sh --verify` creates a separate local restore database, compares control totals including item allocations, and runs the database checks against the restored target. This is local qualification, not a Neon restore or production cutover rehearsal.

## Support (vendor support CLI, account 031)

Green Monkey staff act on customer accounts only through the support CLI, from
an operator workstation. Every command needs `--operator "<name>" --ticket
<ref> --reason "<10–500 characters>"`, is written to `support_actions`
(append-only; the operator login is forced to the database session user) and is
shown to the restaurant's owners in their account console ("Acciones de
soporte") and, for 7 days, in the POS shell. A command that touches several
organizations (a lookup by email that matches two, an anonymization) writes one
row per organization, so each one's owners see it. Emails are stored there only
as sha256 digests. The database enforces this: every `gm_support` write must
match a `support_actions` row the same login wrote in the same transaction for
that tenant, organization and target, with bounded values (an unlock only
clears, the audit row is the unlock's own with a server timestamp, the Free slot
moves only to the logged device, an account row becomes exactly the logged
state). A raw `psql` session with an operator URL therefore cannot change
anything the owners do not see (LD-32 AUTHZ-2, OPS-2). Mutating commands ask for the
restaurant or organization name (`--yes` skips it, never for
`transfer-ownership`). Design and data model: [account and legal](ACCOUNT_AND_LEGAL.md).

**Provisioning an operator** (once per person and environment):

```sh
PROVISION_DATABASE_URL=<CREATEROLE owner, direct endpoint> \
SUPPORT_PROVISION_TARGET=<host:port/database> \
npm run support:provision -- --name <alnum>
```

`SUPPORT_PROVISION_TARGET` must repeat the owner URL's exact
`host:port/database`, and the database must be one ops provisioning creates,
`green_monkey_<env>` (`green_monkey_production`, `green_monkey_staging`; see
[provisioning](PROVISIONING.md)), or a local `green_monkey[_<name>]_dev`
(`green_monkey_acceptance_dev`); anything else stops with
`explicit_support_provision_target_required` before connecting (LD-32 OPS-1).
It creates `gm_support_<name>` (LOGIN, member of `gm_support`, no superuser,
CREATEDB, CREATEROLE or BYPASSRLS) and writes the connection URL once to
`.env.support-<name>` (mode 0600). Keep that file on the operator's
workstation as `SUPPORT_DATABASE_URL`. It is **never** a Railway or GitHub
variable; the web refuses to start with it. `scripts/ops/sql/globals.sql` must
have created `gm_support` first. Remove an operator with `DROP ROLE` from the
provisioning owner when they leave.

**Commands** (`npm run support -- <command> …`):

| Command | Use |
| --- | --- |
| `lookup --email <e> \| --tenant <id> \| --organization <id>` | Accounts, organizations, restaurants, owners, devices, entitlement, pending transfers. Read-only. |
| `unlock-employee --tenant <id> --login <login>` | Clears a PIN lock at owner strength (the failure counter, the lock, a permanent "infinity" lock and every device throttle), without spending the manager's daily unlock budget. The confirmation shows the employee's role and says when the lock is permanent: only act on a permanent lock at the request of the primary or a co-owner shown by `lookup`. Writes `access.employee_unlocked` `{by:"support"}` with the ticket. |
| `grant-entitlement --tenant <id> --until YYYY-MM-DD` | Pilot Pro (below). |
| `end-entitlement --tenant <id>` | Ends a support grant now (the restaurant goes to Free; drawers opened before the end continue until closed or 16 h; the row keeps the end time in `access_until`). |
| `transfer-ownership --organization <id> --to-email <e> [--hold-hours 72]` | Support-assisted ownership transfer after identity verification (below). Hold 24 h minimum, 72 h default. |
| `cancel-transfer --transfer <id>` | Cancels a pending transfer. |
| `set-free-device --tenant <id> --device <id>` | Emergency Free device reassignment (the owner cannot reach Settings, for example a stolen laptop held the slot); the device ID must be retyped. The automatic/manual mode is unchanged, so in automatic mode a later drawer open can move the slot again: ask the owner to save a manual selection once they can. |
| `rectify-account --account <id> [--name "<n>"] [--email <e>]` | ARCO rectification of an owner account's name or email (below). Google sign-in is unaffected (it is keyed by the Google subject). |
| `block-account --account <id> [--offboarding]` | ARCO cancellation, step 1 (blocking): the account can no longer sign in with Google and its account and POS sessions stop working at once. Refused while the person is an active co-owner (`support_account_is_co_owner`: the primary removes them or they leave first) and, without `--offboarding`, while they are a primary (`support_account_is_primary`: transfer the organization first, unless the organization itself is leaving). |
| `anonymize-account --account <id>` | ARCO cancellation, step 2 (suppression), only for an account blocked at least 5 years ago (`support_retention_not_over`): email and name become non-identifying values, closed transfers that named the person keep only a sha256 digest of the email. Never takes `--yes`. |
| `redact-email --email <e>` | ARCO cancellation for someone who never had an account (a transfer target who never signed in): their closed transfers keep only the digest, at once. Refused when the email belongs to an account (`support_email_has_account`) or a live transfer to it is pending (`support_transfer_pending`: cancel it first). |
| `actions --organization <id> [--limit 50]` | Support history for an organization. |

**Pilot grants (v1 production path to Pro).** Production launches with Stripe
billing disabled; pilot restaurants get Pro from `grant-entitlement`:

- at most **90 days** per grant (`support_grant_too_long`); renew by running it
  again **before** the end date with a new `--until` (each run is audited);
- ends at 04:00 restaurant time on the `--until` date;
- never on a restaurant bound to Stripe billing (`support_grant_stripe_bound`);
- owners see "Pro otorgado por soporte" with the end date in Settings › Plan,
  and the POS warns 7, 3 and 1 days before it ends;
- record the pilot agreement reference as the `--ticket`.

**Identity verification for a support-assisted transfer** (lost Google account
without recovery codes, a founder leaving, a sale of the business). All of:

1. The requester's INE (both sides) and a selfie or live comparison.
2. A constancia de situación fiscal whose RFC matches the restaurant's, or an
   acta constitutiva / poder notarial showing authority over the business.
3. A live video call with the requester holding the INE.
4. Proof that the new Google email is controlled by the requester: they open
   the console with it and read back the transfer notice.
5. A ticket reference holding the evidence (never in the CLI reason text).
6. A second operator reviews the evidence before the command runs
   (recommended; mandatory when the current primary is unreachable).

The current primary sees the critical banner during the hold and can cancel. Do
not shorten the hold below 72 h unless the current primary confirms in writing.

**Unlock.** Prefer the restaurant's own owner or manager; use
`unlock-employee` only when nobody with that permission can sign in, after
confirming the caller is the owner, a co-owner or a manager of the restaurant
(`lookup` prints the owners and the number of locked employees; confirm a
manager by name with the owner). A permanent lock is the owner's call: act on
it only at the request of the primary or a co-owner.

`transfer-ownership` prints its one-time link on `SUPPORT_APP_URL` (or
`APP_URL`), which must be the deployment's `https` origin; a missing,
plain-http or `localhost` value stops the command before it writes anything
(`support_app_url_required`, OPS-5). Set `SUPPORT_APP_URL` in the operator's
`.env.support-<name>` next to `SUPPORT_DATABASE_URL`.

**ARCO requests** (access, rectification, cancellation, opposition, LFPDPPP
Arts. 28–34) arrive at `LEGAL_PRIVACY_CONTACT_EMAIL`:

- answer within **20 business days** and make the decision effective within
  **15 business days** after answering; free of charge;
- verify identity as above (INE; for a restaurant's diners or staff, refer
  them to the restaurant, which is the responsable; Green Monkey assists as
  encargado under the DPA);
- **access**: the owner's data export covers the restaurant's records; for the
  person's own account data, `lookup --email` prints what support can read
  (organizations, roles, transfers, acceptances), and the person sees their
  account, co-owners, transfers, activity and tax profile in the account
  console;
- **rectification** (Art. 23-24): `rectify-account` changes the account's name
  or email (what other owners and support see). Names on POS seats and staff
  records are the restaurant's own records: the owner edits them in Equipo;
- **cancellation** (Art. 2-III, 24-25): first `block-account` (blocking: the
  account cannot sign in; its data is kept only to answer for the legal
  relationship), then, once the longest retention has passed,
  `anonymize-account`. Retention: the subscription's fiscal records 5 years
  (CFF Art. 30) and the evidence of the contract (legal acceptances) 10 years
  (Código de Comercio Art. 49); anonymization keeps acceptances, account
  events and fiscal records keyed by the account id only (append-only ledgers
  are never edited or deleted). The CLI waits 5 years after the block; keep the
  acceptance evidence by id for the rest. For someone who never had an
  account, `redact-email` acts at once;
- **loyalty club members** (038): the restaurant is the responsable and
  answers in the app: access with "Imprimir datos del cliente" (Clientes) or
  the owner export (the four `loyalty_*` tables), rectification with "Editar
  datos", opposition with the marketing toggle, cancellation with "Eliminar
  datos del cliente" (step-up; name, phone, notice snapshot and opt-in are
  blanked at once and for good; ledger, links and sales stay). Record each
  cancellation in the cancellation register with the member id only. Members
  with no activity for 24 months are redacted by the daily retention pass;
- **held QR/kiosk orders** (public ordering, 032-034): a diner who typed a
  name or a note on a QR or kiosk order can have the hold's copy blanked.
  The restaurant has no tool for it (the runtime role cannot change a hold's
  name or note), so when the restaurant (or the diner, with the restaurant's
  label `Q-14`/`K-14`, the date and the restaurant) asks, support runs
  [PUBLIC_ORDERING.md](PUBLIC_ORDERING.md) "Redacting a hold (ARCO)" as
  `gm_migrator` for that one hold, in any state, and records it in the
  cancellation register (date, ticket, "hold redaction", restaurant id, date
  and number). Retention blanks every hold's copy after 30 days anyway. An
  accepted hold's order keeps its call name and note: that is the
  restaurant's sales record, edited only by the restaurant;
- what the tools do **not** touch: the restaurants' own records (orders,
  tickets, CFDI, staff and seat names, invitation emails), which belong to the
  restaurant as responsable and leave with its offboarding; backups (below);
- record every cancellation in the **cancellation register** (outside the
  database: the ticket system), one line per command: date, ticket, command,
  account id or email digest. After any restore (Neon branch, PITR or dump,
  [BACKUP_RESTORE](BACKUP_RESTORE.md)), re-run every command in the register
  dated after the restored snapshot before the database serves traffic again.
  Backups themselves expire by lifecycle (daily 35 days, monthly 1,900 days);
  until then they are encrypted, access-restricted and used only to recover
  from a disaster, which the privacy notice and DPA state.

**Breach notification.** On a security incident affecting personal data:
contain it, record what happened, which data and which restaurants, and notify
the affected owners (responsables) without delay so they can inform their data
subjects (LFPDPPP Art. 19–20); notify individual account holders directly for
account data. Follow the incident steps in [runbook](RUNBOOK.md).

**Offboarding.** When a restaurant leaves: tell the owner to download the JSON
export (Settings › Privacidad y datos) during an agreed window (30 days by
default). The JSON does not contain the stamped CFDI files (XML/PDF): the owner
downloads them from the invoices register or through the SAT's descarga
masiva and must keep them 5 years (CFF Art. 30). End any support grant; then
`block-account --offboarding` for the primary (and remove co-owners first).
The restaurant's records are never deleted by the tools: fiscal records
(tickets, CFDI) stay blocked for at least 5 years, append-only money ledgers
stay as they are, and the account follows the ARCO cancellation steps above.
Record each step in the ticket and the cancellation register.
