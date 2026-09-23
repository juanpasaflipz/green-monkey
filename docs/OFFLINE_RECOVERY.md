# Offline and payment recovery

Status on September 20, 2026: the core M2 recovery slice is implemented and
qualified locally. It is not yet deployed to staging and the complete M2 browser
matrix in `PRODUCT_COMPLETION_PLAN.md` is not yet satisfied.

## Operator behavior

When the POS loses connectivity, an eligible open drawer can record cash locally.
The receipt states that cash was recorded on that device, server synchronization is
pending, and kitchen delivery is unknown. The Sync screen retains the claim in
IndexedDB and lets the operator download a tenant-bound recovery backup.

On reconnect, the server accepts an automatic replay only when the original
versioned lease, tenant, employee, device, session, drawer, currency and restaurant
configuration evidence remain valid. The operation ID is reused. A retry never
silently reprices cash, changes currency, applies today's recipe as historical
stock, or claims that food reached the kitchen.

If automatic replay conflicts, an owner or manager can review the original evidence
and explicitly confirm cash already collected. The server then records the cash
exactly once against the original drawer, including a closed drawer, and creates an
immutable recovery record. The resulting order remains `recovery_pending`; it is
not described as completed. Kitchen and stock are separate durable follow-up tasks
and both require a recorded outcome and reason. After both are reviewed, the order
becomes `recovery_reviewed`.

Uncertain online payments use a separate flow. The Sync screen first asks the server
for the canonical operation result. If the exact command already committed, that
result is displayed. The same immutable command can be retried only from the same
active session, device and employee while the original drawer remains open.
Otherwise the UI requires review and does not authorize a new charge.

## Evidence and storage

New offline records use the shared v2 contract in `shared/offline-recovery.ts` and
include the original operation and draft IDs, tenant, employee, device, session,
lease version, drawer, timestamps, currency exponent, configuration version,
amounts and receipt snapshot. Exact legacy v1 records remain parseable without
adding defaults that would change an accepted operation fingerprint.

Server evidence lives in `offline_leases`, `offline_recoveries` and
`offline_recovery_tasks`. Recovered tenders carry the `offline_recovery` source and
original operation ID. Runtime roles cannot delete these records or rewrite their
evidence; privileged retention work remains possible. Migrations 018–020 introduce
and correct these controls.

Backups are versioned and tenant-bound. A v2 backup includes unresolved cash sales
and unresolved payment attempts. Restore validates its schema, size, tenant and IDs,
runs atomically, accepts identical repeated records, and rejects a changed-payload
collision instead of overwriting local evidence.

## Physical limitations

- If all browser storage is destroyed before server acknowledgement and no exported
  backup survives, the unsynchronized claim cannot be recovered. There is no hidden
  cloud copy.
- A backup is evidence for manager review, not proof that the cash, kitchen work or
  stock movement happened.
- Legacy records without historical item-price, tax, recipe or cost evidence remain
  unallocated. Recovery does not invent those facts from the current catalog.
- Kitchen and stock corrections are not automatic because duplicating either can be
  worse than leaving an explicit task for an operator.
- Recovery never performs another real customer payment.

## Service-worker behavior

The compiled app uses revision-specific shell caches. Installation fetches the HTML
and its hashed assets as one revision; authenticated `/api` responses are never
cached. A waiting update does not force an active checkout to switch revisions, and
old caches are retained while clients still depend on them. IndexedDB queues and
payment attempts are not deleted during an app update.

## Verification

The local qualification currently covers shared v1/v2 contracts, automatic replay,
real catalog conflict and manager review, revoked sessions, late correction to a
closed drawer, exact-once tender source, durable kitchen/stock tasks, tenant
isolation, capped refunds, uncertain-payment status/retry, service-worker update
with unresolved work, and a compiled-browser manager reconciliation flow.

Run:

```sh
npm test
npm run test:db:recovery
TEST_BASE_URL=http://127.0.0.1:3002 TEST_PRODUCTION=1 npm run test:browser
```

September 22 continuation adds compiled-browser tests for interrupted two-tab
locks, retry exhaustion, malformed/wrong-tenant/repeated/conflicting atomic backup
restore, replacement-device evidence, JPY/KWD formatting and retained old-session
payment review. Database tests add same-price recipe changes, configuration
changes, disabled devices, expired evidence, simultaneous sync/reconciliation,
simultaneous close/reconciliation, concurrent follow-up completion, exact payment
fingerprints and original-drawer history from a replacement device.

Recovered sales now reduce reported cost coverage and expose missing historical
item costs. Managers can inspect closed drawers from all devices, including their
original expected/count/discrepancy and subsequent recovered cash. Uncertain
payments are serialized across tabs and acknowledged evidence is removed only if
it still matches the exact claim; a committed status has an explicit dismiss action.

Additional final checks now cover an actual API process restart with exact replay
(`npm run test:restart`), logout plus replacement device-root authentication while
retaining the queue, manager recovery of that revoked original session, and an
amount refund through the browser against recovered cash. Recovered financial
orders cannot accept new kitchen rounds or service reassignment. Their states are
explicitly labeled in Spanish and English.

The final uninterrupted isolated Neon aggregate passed. GitHub qualification also
passed on the published candidate; later affected checks are recorded in the
release evidence. Payment-backup collision/atomicity and download round-trip checks also pass.
The UI reports browser persistence status, offers a persistence request, and
explains permanent loss without a surviving backup. The remaining release gate
for this recovery slice is exact-candidate staging evidence. The staging schema remains at 015. No new
staging or production deployment is claimed. Full product milestones M3–M11 remain
governed by the completion plan.
