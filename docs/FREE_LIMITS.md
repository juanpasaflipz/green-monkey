# Free plan limits

Item 3 implementation, September 15, 2026. Approved commercial policy is unchanged:
one Free location per organization, one selling device, owner plus two named
employees. Pro retains expanded devices/team and billed locations.

Migrations 016–017 add independent Free selections. They do not delete or disable
staff, devices, locations or historical records. Existing locations choose the
original signup location where identifiable; older fixtures choose a stable ID.
Owners can select another activated Free location in account management and choose
the selling register/team in restaurant Settings. Additional devices can enter to
review records and finish outstanding work, but cannot start new Free sales.

Canonical order/round creation checks the live selection and entitlement after
idempotency replay. Forging the offline channel does not bypass the gate. Signup,
device pairing (single-use codes from Dispositivos; owner-password pairing only on
the fictional `DEMO_TENANT_ID` tenant), the first sign-in on a device, invitation
acceptance and employee management share serialized selection logic and database
unique slots. The first device that signs in takes the Free selling slot; a
terminal paired later shows that it is not selected until the owner selects it,
and unpairing a device frees its slot. Creating extra owner-role employees is
rejected. Expired Pro immediately uses Free selections for new online sales.
Previously issued offline leases remain bounded to four hours; accepted queued
cash is not erased or paywalled. Server sessions record whether selling was
allowed when issued.

New recipes/cost changes, receiving, suppliers, preparation, counts/waste and shift
starts require Pro, checked after replay. Basic menu edits/manual receipts and
historical read access remain available; shifts can finish after downgrade. In the
menu editors (MENU.md "Permissions and plans"), categories, products, choice
groups, availability, areas and tables, stock item archive and the negative-stock
policy stay available on Free; recipe or cost changes and creating or editing stock
items answer `pro_required`.
Reporting currently exposes source records and basic historical cost totals; full
advanced reporting remains an unimplemented feature in the delivery matrix.

Verification: isolated local and Neon test scenarios pass concurrent device/team
selection, invitation cap, extra-owner bypass denial, direct canonical order and
management gates, expiry, accepted replay, collection of existing orders,
owner-only selection, foreign IDs, retained employees and one Free location. The
aggregate runner covers the 17 operational scenarios plus identity, owner,
entitlement, billing and Free suites on both targets. The current tree passes 117
unit tests, typecheck, lint and build. A clean compiled-browser run passed all 14
scenarios. The Free scenario uses two browser contexts, two named employees,
keyboard selection, ES/EN, axe scans and screenshots at 1440×900, 1024×768,
768×1024 and 390×844; it also proves an unselected device retains reads but cannot
open a new drawer. Migrations 016–017 remain unapplied to staging, so deployed
Free-limit qualification is intentionally deferred to the exact-candidate M3 gate.

RLS regression: a new restaurants write policy queried organizations, whose legacy
read policy queries restaurants. The isolated test reproduced PostgreSQL's rewrite
recursion. Forward migration 017 removes that policy; owner commands authorize
organization ownership first, then update each explicitly scoped tenant using the
existing policy. Historical migration checksums are preserved. The concurrency
regression passes after that correction.

## Server capability policy

The API treats a current Pro entitlement as selected access. On Free, new
operational mutations require the selected location, device and employee. Owners
can always read and change the Free selection itself, so an owner never needs a
second selling slot merely to recover access. Idempotent commands check an already
accepted operation before the live access gate; downgrade does not invalidate an
accepted result.

| Capability | Routes | Roles | Free classification and enforcement |
| --- | --- | --- | --- |
| Read/history/export source data | catalog, orders, kitchen, cash, inventory, report, restaurant, team, audit, jobs, plan/capabilities | Route-specific authenticated roles | Read access; retained on downgrade. Tenant RLS and role checks apply. |
| Free selection | `GET/POST /api/plan/selection`, owner account Free-location selection | Owner | Recovery/configuration. Available even from an unselected owner session; referenced devices, employees and locations are server-scoped. |
| New sale or additional round | order creation and order rounds | Operator | New operational action. Requires live selected access after idempotency replay. QR/kiosk also require Pro. |
| New drawer or discretionary cash movement | cash open and paid-out | Operator for open; manager/owner for paid-out | New operational action. Requires live selected access after idempotency replay. |
| Management mutations | catalog import/save, restaurant settings, team save, inventory movement/prep/receiving, suppliers, expenses, shift start and ordering-link creation | Manager/owner as defined by each route | New operational action. Requires live selected access. Existing Pro gates remain for advanced inventory, procurement, shift start and ordering links. |
| Accepted order completion | payment, grouped settlement, service reassignment, kitchen progress | Operator/KDS roles | Completion of previously accepted work. Remains available so downgrade does not strand an order; payment still requires a matching open drawer and canonical order locks/caps. |
| Financial correction or closure | refund, cash close, shift end | Manager/owner | Correction/completion. Remains available with reason, cap, drawer and role checks. Does not authorize a new sale or drawer. |
| Automatic offline sync | `/api/sync` | Original operator identity/device | Recovery of bounded prior authorization only. Requires the original unrevoked session, issued selling authorization, device, employee, drawer, recorded time and offline deadline. |
| Manager offline review/reconciliation | `/api/sync/review`, `/api/sync/reconcile` | Manager/owner | Audited correction. Never a general `channel: offline` bypass. Item 4 must replace the current draft reconciliation model before release. |
| Public QR/kiosk order | scoped public ordering token | Token scope plus Pro tenant | New operational action. Pro is checked server-side; expired Free access cannot create an order. |
| Staff management | `/api/access/staff*`, legacy team save | Owner (managers list and unlock) | Recovery/configuration. Allowed from unselected or downgraded sessions so an owner can always fix the team; adding or reactivating staff still takes a Free team slot (`employeeSlot`). Step-up on terminals. |
| Device management and pairing codes | `/api/access/devices*`, `/api/access/pairing-codes*` | Owner and manager (personal devices owner-only) | Recovery/configuration. Allowed from unselected or downgraded sessions; unpairing frees the device's Free slot. Pairing itself never grants selling. Step-up on terminals. |
| Account/location/invitation/billing commands | `/api/auth/account/*`, `/api/billing/*` | Owner account and CSRF; billing worker where applicable | Account administration, not POS recovery. Organization ownership, invitation identity, one-Free-location and canonical billing rules apply independently of device selection. |

`tests/free-limits-db.ts` covers selected versus unselected sales and management,
accepted replays after downgrade, collection of an existing order, concurrent
selection/team limits, invitation capacity, owner-role bypass denial, tenant scope
and one Free location. Browser qualification must still cover both languages, all
four required viewports, downgrade transitions and the recovery-only UI states.

## Lapse continuation, automatic selection and co-owners (account 031)

Implemented locally (migration 031); not yet staging-qualified.

- **Drawer continuation.** When Pro ends (trial, support grant, cancellation
  or failed payment), a device whose drawer was opened **before Pro ended** and
  less than 16 hours ago keeps selling for any active employee until the drawer
  closes or the 16 hours pass (`sellingAccess` basis `drawer_continuation`). A
  drawer opened on Free (a restaurant that never had Pro, or after the lapse)
  never continues: an unselected employee or device cannot start sales there,
  and switching the Free selection stops the previously selected register at
  once. Pro ended at the entitlement's `access_until` (trialing, active), or,
  for past_due, canceled, paused and support's end-entitlement (which keeps
  the grant's end in `access_until`), at the earlier of `access_until` and
  `pro_ended_at`: the moment a write took the row out of Pro, bounded by the
  end date the row had then. A trigger (migration 031) owns `pro_ended_at`, so
  writes that keep the row out of Pro never move it: the billing worker's
  reconcile, which rewrites `updated_at` at least every 15 minutes even when
  nothing changed, past_due → canceled, a repeated end-entitlement (ACC-21). A
  drawer opened on Free during dunning therefore never continues. Rows last
  written before 031 carry no `pro_ended_at` (fail closed: their past_due and
  paused rows give no continuation). A Stripe `free` row (unpaid, incomplete)
  gives none. A new
  drawer cannot be opened under continuation, and the offline window is not
  renewed under it (LD-15 Q5), so the existing four-hour lease runs out
  normally. Configuration saves that are gated by selling also pass for active
  employees on that device during continuation; they remain permission-gated as
  always.
- **Automatic Free selection** (default per restaurant, `auto`): during Pro,
  every successful drawer open moves the Free device slot to that device, and
  a non-owner opener gets an employee slot (a free number first, otherwise the
  holder with the oldest last drawer open, kitchen-role holders first). On
  Free, a slot device that has never opened a drawer (for example the owner's
  signup laptop) yields to the first device that opens one. Each move writes
  `plan.free_slot_auto`. Saving a selection in Settings switches the restaurant
  to `manual`; FreeSelection shows the mode and "Volver a automático". The
  slot write runs inside `/cash/open` after the Free-limits lock (lock order
  exception E7 in [architecture](ARCHITECTURE.md)) and only when a slot
  actually changes.
- **Co-owners** are owners: they never consume the two Free employee slots and
  can sell only on the selected Free device, like the primary owner.
- **Notices** in the POS shell explain each state: trial or support grant
  ending, drawer continuation, Pro ended (first 7 days) and "Free: este
  dispositivo o empleado no está seleccionado para iniciar ventas. Solo
  {dispositivo} puede hacerlo." PlanSettings states the Free limits: "En Free
  solo el dispositivo y los dos empleados seleccionados pueden iniciar ventas.
  Los demás pueden cobrar órdenes abiertas y consultar registros."
- Support can reassign the Free device in an emergency (`set-free-device`,
  [operations](OPERATIONS.md)); the mode is unchanged.
