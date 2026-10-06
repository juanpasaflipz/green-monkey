# Development operator guide

This application is under implementation and is not approved for live service.

1. With `DEMO_TENANT_ID` set to the fictional restaurant (local only), sign in on the demo form as the owner: login `owner`, password `demo-green-monkey`. This pairs the browser as a terminal. Any other browser pairs with a single-use code from **Configuración → Dispositivos → Vincular un dispositivo** (10 minutes). On a paired browser staff tap their name under **¿Quién entra?** and enter their PIN: `cashier` / `123456`, or `kitchen` / `654321`. PIN sessions lock after 3 minutes without input (per-device setting; kitchen staff do not lock by default); refunds, paid-outs, self-approved voids and staff/device commands ask for a fresh PIN on terminals. Staff, devices, lockout and runbooks (lost tablet, fired employee, locked manager): [access](ACCESS.md).
2. Owners open **Operación → Caja**; cashiers open **Caja**, enter the opening float, and save. The cash drawer belongs to the paired device.
3. Open **Vender**. Tap an ordinary product once; asada requires a salsa choice. Set service mode, table, call name, and notes.
4. **Enviar a cocina** persists an order and its first round. Use **Cocina** to acknowledge and mark tickets ready. The bar has its own station filter.
5. Return to selling. Add products and send another round without repeating earlier lines. **Cobrar** opens the payment workspace. Enter a smaller amount for partial payment; the remainder survives reload.
6. Use **Dividir por productos** to select individual units after sending the round. Amount splits allocate against remaining units in stable order. Already paid units stay paid after refund; older payments with no item allocations remain amount-only. The payment footer stays visible on mobile.
7. Cash is recorded locally in PostgreSQL. External terminal mode means staff explicitly confirm a separate device's approval; it is not integrated payment verification. Hardware printing remains disabled; browser printing does not acknowledge paper output.
8. A paid dine-in check keeps its table until **Liberar mesa** (on the receipt, the table card, the order row or when opening a new check); takeaway and tableless checks close when settled. **Órdenes** and **Mesas** list open checks; the kitchen display polls a versioned feed and shows a stale banner when it stops. Receipts and pre-bills print the order note, round notes and line notes, as kitchen tickets do. Print settings (80/58 mm, kitchen ticket on send, KDS auto-print) are per device. See [Service](SERVICE.md).
9. Owners/managers can refund recorded cash from order history, with a reason and disposition. This initial workflow never automatically returns prepared food to inventory.
10. Receive stock, log preparation or waste, and review movements under inventory. A count uses a stock version; concurrent movements require refreshing the count before adjustment.
11. Closing cash records expected amount, counted amount, and discrepancy explanation. Refunds, tips and paid-outs are included.

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

Release and operations live in their own documents: [release process](RELEASE.md) (CI on PostgreSQL 18, CD from `main` to staging, gated production dispatch, migration rules), [runbook](RUNBOOK.md) (signals and alerts, "POS is down" playbook, rollback, retention, credential rotation, staging cutover), [provisioning](PROVISIONING.md), [backups and restore](BACKUP_RESTORE.md) and [load test](LOAD_TEST.md). Railway configuration is `.railway/railway.ts` (`railway.json` is gone). CI builds and smoke-tests the Docker image, because this machine has no Docker CLI. These workflows and scripts are written and locally rehearsed, but none has run against staging yet. The staging service that exists today predates them ([STAGING.md](STAGING.md)).

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
soporte") and, for 7 days, in the POS shell. Mutating commands ask for the
restaurant or organization name (`--yes` skips it, never for
`transfer-ownership`). Design and data model: [account and legal](ACCOUNT_AND_LEGAL.md).

**Provisioning an operator** (once per person and environment):

```sh
PROVISION_DATABASE_URL=<CREATEROLE owner, direct endpoint> \
SUPPORT_PROVISION_TARGET=<host:port/database> \
npm run support:provision -- --name <alnum>
```

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
| `unlock-employee --tenant <id> --login <login>` | Clears a PIN lock exactly like a manager unlock, without spending the manager's daily unlock budget. Writes `access.employee_unlocked` with the ticket. |
| `grant-entitlement --tenant <id> --until YYYY-MM-DD` | Pilot Pro (below). |
| `end-entitlement --tenant <id>` | Ends a support grant now (the restaurant goes to Free; open drawers continue until closed or 16 h). |
| `transfer-ownership --organization <id> --to-email <e> [--hold-hours 72]` | Support-assisted ownership transfer after identity verification (below). Hold 24 h minimum, 72 h default. |
| `cancel-transfer --transfer <id>` | Cancels a pending transfer. |
| `set-free-device --tenant <id> --device <id>` | Emergency Free device reassignment (the owner cannot reach Settings, for example a stolen laptop held the slot); the device ID must be retyped. The automatic/manual mode is unchanged, so in automatic mode a later drawer open can move the slot again: ask the owner to save a manual selection once they can. |
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
confirming the caller is the owner or a manager listed in `lookup`.

**ARCO requests** (access, rectification, cancellation, opposition, LFPDPPP
Arts. 28–34) arrive at `LEGAL_PRIVACY_CONTACT_EMAIL`:

- answer within **20 business days** and make the decision effective within
  **15 business days** after answering; free of charge;
- verify identity as above (INE; for a restaurant's diners or staff, refer
  them to the restaurant, which is the responsable; Green Monkey assists as
  encargado under the DPA);
- account data: the owner's data export covers restaurant records; account
  rectification is by support ticket; cancellation follows offboarding below.

**Breach notification.** On a security incident affecting personal data:
contain it, record what happened, which data and which restaurants, and notify
the affected owners (responsables) without delay so they can inform their data
subjects (LFPDPPP Art. 19–20); notify individual account holders directly for
account data. Follow the incident steps in [runbook](RUNBOOK.md).

**Offboarding.** When a restaurant leaves: tell the owner to download the JSON
export (Settings › Privacidad y datos) during an agreed window (30 days by
default); end any support grant; keep fiscal records the law requires (CFF
Art. 30, 5 years). Blocking and deletion are manual operator steps until
deletion tooling exists (deferred): record each step in the ticket.
