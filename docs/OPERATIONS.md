# Development operator guide

This application is under implementation and is not approved for live service.

1. Sign in as the fictional owner: login `owner`, password `demo-green-monkey`. This binds a new browser device. Employee access on that paired browser uses `cashier` / `123456`, or `kitchen` / `654321`.
2. Owners open **Operación → Caja**; cashiers open **Caja**, enter the opening float, and save. The cash drawer belongs to the paired device.
3. Open **Vender**. Tap an ordinary product once; asada requires a salsa choice. Set service mode, table, call name, and notes.
4. **Enviar a cocina** persists an order and its first round. Use **Cocina** to acknowledge and mark tickets ready. The bar has its own station filter.
5. Return to selling. Add products and send another round without repeating earlier lines. **Cobrar** opens the payment workspace. Enter a smaller amount for partial payment; the remainder survives reload.
6. Use **Dividir por productos** to select individual units after sending the round. Amount splits allocate against remaining units in stable order. Already paid units stay paid after refund; older payments with no item allocations remain amount-only. The payment footer stays visible on mobile.
7. Cash is recorded locally in PostgreSQL. External terminal mode means staff explicitly confirm a separate device's approval; it is not integrated payment verification. Hardware printing remains disabled; browser printing does not acknowledge paper output.
8. Owners/managers can refund recorded cash from order history, with a reason and disposition. This initial workflow never automatically returns prepared food to inventory.
9. Receive stock, log preparation or waste, and review movements under inventory. A count uses a stock version; concurrent movements require refreshing the count before adjustment.
10. Closing cash records expected amount, counted amount, and discrepancy explanation. Refunds, tips and paid-outs are included.

## Offline

Offline refresh requires the compiled server and service worker, not Vite development serving. Log in and open a drawer while connected first. Cash drafts and queued payments persist in IndexedDB. The sync screen retains errors and retries. Integrated payments, existing server-order checkout, protected overrides, and stock guarantees are unavailable offline.

A pending local sale is not a kitchen acknowledgement. The four-hour eligibility window is bounded by the authenticated session. Pending records survive logout, but revoked-session reconciliation is not yet implemented; do not use this development build for operational offline sales.

## Database roles

`DATABASE_URL` must identify the least-privileged app role. `PG_APP_USER`, if supplied, must match that URL; no credential rewriting or owner fallback occurs. `PG_APP_PASSWORD` is retained as a documented compatibility placeholder and is not used; encode runtime credentials in `DATABASE_URL`. `ADMIN_SECRET` has no runtime bypass.

`MIGRATION_DATABASE_URL` is read only by migration/seed processes. Runtime verifies that its role is neither superuser, RLS-bypass, nor table owner. Transactions explicitly set restaurant context on the same connection. RLS enforces all tenant tables, including transaction-local cleanup after rollback.

The local `scripts/grants.sql` uses `gm_app`. For an isolated Neon target, provision the selected role explicitly and adapt grants to its identifier. Do not copy local passwords. The migration role must own the schema; the runtime role must not.

## Staging and release

Docker and Railway config are prepared. Docker execution is unverified on this machine (no Docker CLI). No Railway or Neon staging target has been selected, so no staging deployment has occurred.

Before deploying a separate staging service:
- Provision new Neon development/test targets and a least-privileged runtime role.
- Set unique `JWT_SECRET`, runtime and migration URLs in the secret store.
- Apply migrations under the advisory lock; run explicit grants and inspect RLS role checks.
- Deploy the Docker image, confirm `/api/health` and `/api/version`, then run the acceptance suite against that target.
- Validate pooled runtime and direct migration connections independently.
- Pair printer/payment hardware only after provider contracts and sandbox results are verified.

## Backup, restore and rollback rehearsal

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
