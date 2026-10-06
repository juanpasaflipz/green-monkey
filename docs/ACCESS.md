# Access: devices, PIN sign-in, sessions and staff

This area covers how a browser becomes a trusted device, how staff sign in on
it, how long sessions last, how shared terminals are protected, and how owners
and managers manage staff and devices. Migration `023_access.sql`; server code
in `server/access*.ts` and `server/routes/access.ts`; client code in
`src/access/*`, `src/features/{AccessGate,PairDevice,PinPad,LockScreen,StepUpDialog,StaffManagement,DeviceManagement}.tsx`
and `src/components/ManagerApproval.tsx`.

Status: implemented and verified **locally only** (October 5, 2026). Nothing in
this document has been verified on staging, production or physical tablets.

## Model

**Device kinds** (`devices.kind`):
- `terminal`: a shared register, kitchen or bar tablet, paired with a code (or,
  on the fictional demo tenant only, by the owner's password).
- `personal`: the owner's or an invited member's own browser, created by Google
  "Entrar". Being personal is not by itself an exemption from anything: only
  a session entered through Google on it (`sessions.owner_account_id`) skips
  step-up and the default auto-lock. A PIN session on a personal device (for
  example a legacy "Owner browser" that is really a shared register) is
  treated like one on a terminal (`stepUpExempt()` in `shared/access.ts`).
- Rows written before migration 023 have `kind` NULL and are read as `personal`
  when named `Owner browser`, otherwise `terminal`. Migration 023 backfills
  `kind` on existing rows and gives active ones `token_expires_at = now + 30
  days`. The backfill lifts `FORCE ROW LEVEL SECURITY` on `devices` for its own
  transaction only (OPS-R2), so it also works for a migration owner without
  BYPASSRLS, such as a Neon owner role.

**Terminal guard (GAP-2)**: on a terminal, `GET /api/auth/google/start`
redirects to `/app?auth_error=terminal` and every non-GET request under
`/api/auth/account` and `/api/auth/account-center` answers
`device_is_terminal`. The refusal is attached with the router's own matching
(route middleware and a prefix mount in `server/owner-routes.ts`), so case
variants, a trailing slash and HEAD reach it exactly as they reach the
handlers. A failed device lookup refuses (fails closed). Account's wave-2
`/account-center` router, mounted after this one, is covered without a new
predicate.

A device credential (`gm_device`, signed, HttpOnly, SameSite=Strict) is valid
while the device is active and `token_expires_at` has not passed. It expires
30 days after the last sign-in on it. There is no token rotation (a lost
response must never unpair a terminal mid-service); revocation and expiry cover
a stolen device.

**Sessions** (`sessions`):
- Created only by `createSession()` (`server/access.ts`).
- `expires_at` slides to `least(now + 8 h, absolute_expires_at)`, written at
  most once a minute per session and only on success.
- `absolute_expires_at` is sign-in + 16 h for PIN sessions, and the Google owner
  session's expiry for Google-entered sessions.
- **Ended** (`ended_at`, `end_reason`): logout, switch, replace, PIN reset, role
  change, ended by a manager. Offline sales queued under an ended session still
  sync when the same employee signs in again on the same device.
- **Revoked** (`revoked = true`): only employee deactivation and device
  revocation. Queued sales of a revoked session go to manager reconciliation.
- A failed authentication names its reason: `device_not_paired`,
  `device_revoked`, `session_expired`, `session_ended`, `session_revoked` or
  `unauthorized`. The client shows the lock screen (session codes) or the
  pairing screen (device codes) instead of a generic error.

**Step-up**: on a terminal, refunds, paid-outs, manager self-approved voids,
every staff, device and pairing-code command (including the legacy
`POST /api/team/save`), fiscal's profile save (`POST /api/fiscal/profile`,
owner) and missing-ticket repair (`POST /api/fiscal/tickets/repair`, managers;
LD-15 fiscal Q5), and the CFDI commands (activate, settings, CSD upload, live
mode, cancel, substitute and "Sustituir global y facturar", cfdi 030) need a PIN
entered within
`ACCESS_STEP_UP_SECONDS` (default 120). Discounts (028): a manager or owner
applying or removing a discount or recording a refund alone gets the same
step-up and is the approver of record; a cashier or server needs a manager's
PIN in the dialog (`verifyApproval`), and that PIN is the only one asked (LD-2):
the actor's own step-up applies only to a within-limit staff discount with no
approver; saving the money controls (owner) needs the step-up. Reports (029):
the remote close of an orphaned drawer (`POST /api/reports/drawers/:id/close`,
owners and managers) needs the step-up. Account (031): every
`/api/account-data/*` path (the owner data export; a guard on the whole prefix,
owners only) and the owner's restaurant privacy notice and Free-selection mode
saves need the step-up. The client asks "Confirma con tu PIN"
and retries the identical request (same `operationId`). Google-entered sessions
on a personal device are exempt; PIN sessions are not, on any device. A pending
prompt belongs to the session whose command asked for it:
- it never shows over the lock;
- a switch, a sign-out or a new sign-in cancels it (`step_up_cancelled`), so
  the next employee is never asked to confirm the previous one's command;
- if the session changed while the request or the prompt was out, `api()`
  sends no retry (`session_changed`), because the retry would carry the new
  employee's cookie and CSRF token;
- if the session itself ends while the prompt is open (`/access/step-up`
  answers a session 401), the prompt closes, the session's lock appears and the
  waiting command fails with that error.

**Idle lock**: PIN sessions lock after 3 minutes without input (device setting
overrides; the kitchen role and Google-entered sessions on a personal device
never lock by default). The lock
keeps the workspace mounted: the same employee's PIN resumes with the cart and
open dialogs intact; another employee's PIN starts their own session and a
fresh workspace. The lock is remembered per session in the browser
(`localStorage["gm-lock"]`) until a PIN unlock, a new sign-in or a sign-out, so
a reload, a new tab or an offline restore of the cached session opens locked.
A manual or server lock in one tab also locks the other open tabs of the same
session (storage event). An idle lock does not travel between tabs. Each
tab locks on its own timer, and a tab whose timer comes due waits while another
tab of the session had input within the auto-lock window
(`localStorage["gm-activity"]` names the writing tab). A background tab
therefore never locks the tab in use. The marker is written at most every 5 s,
so a background tab may lock itself up to 5 s early. A restore after a pause
longer than the device's auto-lock (last input in `gm-activity`) also opens
locked.

Only an unlock, a switch or "Salir" ends the lock. The exception is the renewal
prompt ("Renovar ahora" on the expiry banner): the session is still valid, so it
offers "Ahora no", is not remembered by a reload or other tabs, and becomes an
idle lock when the auto-lock comes due while it is on screen. Browsers stop
honouring a
modal dialog's cancelled `cancel` when close requests repeat without user
activation (Escape, Android back), so the lock (`src/features/LockScreen.tsx`)
does not rely on it:
- it uses `closedby="none"` where the browser supports it;
- it cancels the Escape keydown before it becomes a close request;
- it reopens itself on any `close`;
- it makes every other top-level element inert while it is up: the workspace
  and any dialog that was open when it locked;
- a dialog that opens on its own afterwards (a receipt after a slow payment, a
  background prompt) is made inert and the lock is raised above it again
  (`keepLockOnTop` in `src/access/lock.ts`). Only the lock's own "Salir"
  warnings show above it.

While it is shown and the server is reachable, the lock re-reads the roster
every 20 s, when the tab becomes visible and when a PIN lock it shows runs out,
and offers "Comprobar de nuevo", so an unlock made by a manager on another
device re-enables the keypad by itself. The PIN pad asks for no on-screen
keyboard (`inputmode="none"`) while the keypad is shown.

Offline, the PIN cannot be verified, so the locked employee may "Continuar como
{name}" (idle, manual or renewal lock only, never while a session 401 blocks
calls) while the cached offline window is still valid. A PIN request that gets
no answer while the device reports a connection (router up, internet down) is
treated the same way: the lock shows the offline notice instead of a generic
error, and offline's heartbeat (`/api/offline/ping`) is probed at once. Since
offline merged, the lock follows that heartbeat, that is whether the server
answers, not the "Trabajar sin conexión" preference, so manual offline mode
never offers "Continuar como" while the server answers. That soft unlock is not a
PIN unlock: the lock stays remembered, a reload asks again, and the same lock
comes back as soon as the server answers again or the offline window ends, so
the PIN is required before any online work. While a soft unlock over an idle or
manual lock is in effect, `api()` asks App before every call (except the lock
screen's `/access/*` calls and `/offline/sync` (or the legacy `/sync`) of
offline evidence, which also runs behind any lock) whether the server answers,
through offline's `probeNow()`; when it does, the lock comes back at once and the
call is refused unsent (`session_locked`), so a cash close or menu edit cannot
slip through before the background heartbeat notices.
A renewal prompt's soft unlock is not gated: that session is still valid.
Switching user needs a connection. A server session code also applies to the offline
cache, including on a cold start before any session is shown:
- a revoked session or device (`session_revoked`, `device_revoked`,
  `device_not_paired`) is removed from the cache, so an offline reload shows
  the gate;
- an ended, expired or unknown session (`session_ended`, `session_expired`,
  `unauthorized`) stays cached but is remembered as locked with that reason, so
  it comes back offline only behind the lock and without a soft unlock;
- a server code replaces an idle, manual or renew lock that is already up;
- nothing replaces a server code's lock except a PIN unlock, a switch or a
  sign-out. No idle, manual or renew lock is applied over it, and the offline
  "Salir" warning offers no "Bloquear pantalla" while the screen is locked, so
  the lock never becomes one that offers "Continuar como";
- while calls are blocked after a session 401, App's 10 s poll puts that lock
  back if none is showing.

## Pairing a terminal

1. Owner or manager: Configuración → Dispositivos → **Vincular un dispositivo**,
   name it ("Caja 1") → **Generar código**.
2. On the tablet: open `<origin>/app`, type the code under **Vincular este
   dispositivo**. Lower case, spaces, hyphens and the look-alikes O→0, I/L→1 are
   accepted.
3. The tablet shows the restaurant, the device name and **¿Quién entra?**; staff
   tap their name and enter their PIN.

Code security:
- 8 Crockford base32 characters (40 bits) from the CSPRNG, valid 10 minutes,
  single use, at most 5 open per restaurant.
- Stored only as `HMAC-SHA256(JWT_SECRET, "gm-pairing-v1:" + code)`; never in
  plaintext in `device_pairing_codes`, `operations` or `audit`.
- Redemption reads exactly the row whose hash it supplies (RLS policy
  `pairing_code_redeem_read`) and consumes it in the same transaction as the
  device insert, so a code pairs at most one device. Unknown, expired, cancelled
  and used codes all return `pairing_code_invalid`.
- `POST /api/access/pair` allows 10 failed attempts per minute per IP
  (`too_many_attempts`), keyed on `clientIp(req)` (`server/logging.ts`): the real
  client behind Railway's edge (`trust proxy`), IPv6 per /56.
- A code dies with its creator's access: deactivating the creator, or a role
  change away from owner/manager, cancels their open codes, and redemption
  requires an active owner or manager creator.
- Re-pairing a browser that already holds this restaurant's terminal cookie
  retires the old device (`revoked_reason = 'replaced'`).
- Pairing also ends any Google owner sign-in the browser still holds (the
  `owner_sessions` row is revoked and `gm_account` cleared), so a legacy tablet
  where the owner used Google "Entrar" and that is re-paired as a terminal no
  longer answers `GET /api/auth/account` with the owner's account, restaurants
  or invitations.

Operator fallback (local and CI databases only, privileged database URL):

```bash
npm run access:pairing-code -- --tenant <restaurant uuid> --name "Caja 1" \
  --confirm-target <host:port/db of MIGRATION_DATABASE_URL>
```

`JWT_SECRET` must be the secret of the server that will redeem the code. The
command prints one code and its expiry, attributes it to the restaurant owner
and writes the `access.pairing_code_created` audit row. Since Wave 2.0 it
refuses any target that is not a loopback database, before connecting
(access A4): the deployed migrator credential lives only in GitHub Actions.
Deployed support pairs through Configuración → Dispositivos (an owner or
manager creates the code) or, without any usable owner or manager, through
account recovery.

## PIN lockout policy

Throttling is per employee **and** device (`pin_throttles.scope =
device:<id>`); anonymous requests without a paired device never reach the
counters (`device_not_paired`), so knowing a restaurant ID no longer lets anyone
lock staff out (SEC-2).

- Stage 1: 5 failures lock that employee on that device for 5 minutes.
- Later stages: 3 failures each, locks of 10, 20, 40, then 60 minutes (cap).
- 12 hours without failures (and no active lock) resets the device counter.
- A correct PIN resets the device counter and the global consecutive counter.
- After 100 consecutive failures across devices the employee is hard-locked
  (`pin_hard_locked`) until the owner unlocks them or resets the PIN.
- **Desbloquear** (Equipo): the owner unlocks anyone and clears everything,
  the hard lock and the consecutive counter included. A manager unlocks only
  cashiers, servers and kitchen staff, at most 3 times per employee per rolling
  day (`unlock_limit`), never a hard lock or an owner/manager
  (`unlock_owner_only`), and never resets the consecutive counter, so
  alternating wrong approval PINs with unlocks cannot go past the hard lock. A
  PIN reset clears every lock.
- Manager approvals count against the approving manager on the session's device
  only. A void approval checks that the order exists, is open and still has an
  unpaid unit before any PIN (`not_found`, `check_closed`, `stale_order` for
  recovery orders, `void_exceeds_unpaid`), so a made-up, closed or fully paid order cannot serve
  as a PIN check, and one session's rejected approvals are capped at 10 per
  minute
  (`too_many_attempts`, in-process).
- Rate limits: `POST /api/access/pin` (30/min), `GET /api/access/terminal`
  (120/min) and logout (60/min) count per verified `gm_device`. Requests
  without a valid device cookie share a separate per-IP budget, so cookie-less
  traffic on the restaurant's public IP (guest Wi-Fi) cannot use up a
  terminal's budget. Device requests also keep a backstop at 20 times the
  device limit per restaurant and IP: it is keyed by the restaurant in the
  signed device cookie, so devices paired in another restaurant (anyone can
  pair devices in their own Free restaurant) only spend their own restaurant's
  backstop from a shared IP such as guest Wi-Fi, a food court or carrier NAT.
  A restaurant's own paired devices, revoked ones included, can still exhaust
  its backstop from one IP; pairing them needs a code from that restaurant's
  owner or manager.

This follows the OWASP Authentication Cheat Sheet guidance on exponential,
time-bounded lockout that avoids becoming a denial of service
(<https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html>)
and NIST SP 800-63B-4, which limits consecutive failed attempts to at most 100
and gives reauthentication guidance for AAL2
(<https://pages.nist.gov/800-63-4/sp800-63b.html>).

New and reset PINs are 6 to 8 digits. Existing secrets of 4+ characters keep
working; Equipo shows each PIN's date so owners can refresh old ones.

## Offline window renewal

Each session has a base offline lease (`offline_leases`, immutable) of up to
4 hours, capped by the absolute session expiry. While a selling employee's device
is in contact, authentication appends an immutable `offline_lease_renewals` row
whenever the current window ends within 3 h 45 min, giving a rolling 4-hour
window that never exceeds the absolute expiry. `Session.offlineUntil` is the
latest window end; the client refreshes it with a 5-minute heartbeat.
Synchronization accepts a sale whose `recordedAt` falls inside the base lease or
any renewal (`leaseCovers`); `leaseForEvidence` returns every window for the
offline area's evidence rules.

## Signing out

**Salir** first sends queued sales. If some remain, "Ventas sin enviar" explains
they will sync when the same employee signs in here again (or wait for manager
reconciliation). Offline, "Sin conexión" offers to lock the screen instead.
"Offline" here means the server does not answer (offline's heartbeat), not
the "Trabajar sin conexión" preference: in manual offline mode the sign-out
syncs and ends the session normally, and the sign-in gate works, so the next
employee signs in (OFF-R16).
Logout always succeeds: the server endpoint never fails on an invalid session,
and a logout that cannot reach the server is remembered
(`localStorage["gm-logout-pending"]`), blocks restoring the cached session, and
completes on the next load or reconnect. A PIN sign-in on the device clears it
(that sign-in already ended or deliberately resumed the old session), and the
remembered logout names its session (`{ sessionId }`): the server ends nothing
when the cookie holds another session by then, so a late logout never ends the
new session. The sign-in screen says when the device is offline or the server
cannot be reached (saved sales are kept) and fills in by itself when the
connection returns.

A card or cash payment whose answer was lost stays as a payment attempt on the
device. It is retried by the same session, or by a later session of the same
employee on the same device once the original has ended normally or expired
(renewal, PIN after `session_ended`, logout and return), never by another
employee or after a revocation. A payment that a session 401 refused never ran,
so its attempt is cleared at once.

## Staff and devices

- **Equipo** (owner; managers see the list and can unlock): add staff with a
  PIN, edit name and role, reset PINs (including the owner's own "PIN para
  terminales compartidas" for Google owners), deactivate and reactivate.
  Deactivation revokes the employee's sessions on every device, unpairs the
  personal devices they entered through Google (their sessions are revoked and
  the Google sign-ins that entered them end, as with Desvincular) and blocks
  Google re-entry; records are kept. Terminals the employee paired stay paired,
  because they are usually the restaurant's own tablets: the confirmation lists
  them and Dispositivos shows "Vinculado por {name}" on each terminal. The
  legacy team save deactivates the same way. Owner role changes, owner
  deactivation and
  self-deactivation are refused. These commands work from downgraded or
  unselected Free sessions; the Free team limit still applies.
- **Dispositivos** (owner and manager; personal devices are owner-only): kind,
  status, last activity, live session, Free selling slot and a warning when a
  personal device is used by several employees. Rename, auto-lock, end the live
  session, unpair. Unpairing a device with an open drawer needs an explicit
  acknowledgement, also when the drawer was opened after the list loaded. The
  drawer then stays open until a manager closes it remotely from Finanzas →
  Cortes ("Cerrar caja desde aquí", reports 029; see the runbook below).
  Unpairing a personal device also
  ends the Google sign-ins (`owner_sessions`) that entered it.
- **Free selling slot**: the first device that signs in takes the Free selling
  slot, and in a new restaurant that is usually the owner's phone (Google
  entry). A terminal paired afterwards shows "Free: … no está seleccionado"
  until the owner selects it in "Registro y equipo Free"; the pairing dialog
  says so when the plan is Free.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DEMO_TENANT_ID` | Enables the demo owner form and owner-password pairing for this one fictional tenant. Local and fictional staging only; the server refuses to start when it is set and `RAILWAY_ENVIRONMENT_NAME` or `APP_ENV` is `production`. |
| `ACCESS_STEP_UP_SECONDS` | Step-up window, 30..1800 (default 120). Browser suites use 1800. |
| `ACCESS_IDLE_LOCK_DEFAULT_SECONDS` | Default terminal auto-lock: 0 (never), 60, 120, 180, 300, 600 or 900 (default 180). Browser suites use 0; the access idle test sets the device explicitly. |

## Runbooks

**Lost or stolen tablet.** From any manager device: Configuración →
Dispositivos → **Desvincular** the tablet. Its credential stops working at once,
its sessions are revoked and its queued sales go to reconciliation in
Sincronización. Pair a replacement with a new code. If PINs may have been
observed, reset the PINs of everyone who used it (Equipo → Editar → PIN).

If its drawer was open: close it on the tablet first if the tablet still works
(Caja → Cerrar caja). Otherwise count the drawer's cash and unpair; then a
manager closes it from Finanzas → Cortes → **Cerrar caja desde aquí** (reports
029; owners and managers, with the PIN step-up): the dialog shows the drawer's
live expected cash, the count is visible and needs a reason, the close goes
through discounts' `closeDrawerRow` and is audited `cash.close` with
`remote: true`, and the corte Z prints from the result. If money reached the
drawer after the dialog read it (for example an offline sale reconciled in
Sincronización), the close is refused with "La caja cambió…" and the dialog asks
for a recount. A drawer left open from an earlier business day on a device that
still works is closed on that device; the remote close refuses it while the
device was seen or took a payment in the last 10 minutes (docs/REPORTS.md
"Remote close"). The support SQL step is no longer needed.

**Lost or stolen phone or laptop (owner or invited member).** The owner opens
Dispositivos from another device and **Desvincular**s it. Its POS sessions are
revoked and the Google sign-ins that entered it end at once. A Google sign-in
from before the unpairing can no longer pair that browser again
(`owner_reauth_required`); only a new Google sign-in can. Change the Google
account's password if the device itself may still be signed in to Google.

**Fired employee.**
1. Equipo → Editar → **Desactivar empleado**. Every session on every device is
   revoked, and an invited Google member also loses Google entry to the
   location. Their personal devices (the phone or laptop they entered with
   Google) are unpaired at once, so those devices no longer show the roster or
   accept anyone's PIN. Unsent sales on a device wait for manager
   reconciliation.
2. Review the devices they paired. The confirmation lists the shared terminals
   they paired, which stay paired; in Dispositivos each terminal shows
   "Vinculado por {name}". **Desvincular** any you do not recognise as the
   restaurant's own (for example a laptop paired as a terminal), then pair a
   replacement with a new code if needed.
3. If they may have seen other people's PINs (for example a manager's typed on
   a shared tablet), reset those PINs in Equipo.

**Locked manager or owner.** The owner opens Equipo → Editar →
**Desbloquear** (managers cannot unlock managers or owners). Otherwise wait for
the stage lock to expire (at most 60 minutes), or the owner resets the PIN. A
hard lock (100 consecutive failures) needs the owner's unlock or a PIN reset.
A Google owner without a usable PIN on a terminal unlocks from their phone.

**Signing-key rotation and terminals.** Cookies and links are signed with
the keyring (`SIGNING_KEYS` on `web`, [RUNBOOK.md](RUNBOOK.md) "Signing
keys"). A routine rotation keeps the old kid listed for at least 31 days
after the new one starts signing, and keeps `JWT_SECRET` unchanged, so no
terminal notices it: `gm_device` cookies live at most 30 days and are
re-signed at every sign-in. An **emergency** rotation (a leaked key removed at
once) invalidates every cookie and signed link: every staff member signs in
again with their PIN, owners sign in with Google again, and every terminal
pairs again. Before it, have each device sync its offline queue where
possible (a re-paired terminal is a new device, so an unsynced offline
payment from it goes to manager review). Re-pair terminal by terminal: an
owner or manager creates one code per terminal in Dispositivos, at most 5
open codes at a time (each expires after 10 minutes), and **Desvincular**s the
old entry once the terminal is back. Rotate `JWT_SECRET` only together with an
emergency rotation: it keys the pairing-code and PIN-fingerprint digests, so
outstanding pairing codes stop working. Production refuses pre-2.0 tokens;
staging and local still accept them for sign-in while `JWT_SECRET` is set.

**Re-pairing a tablet used with Google before this release.** Devices created by
Google "Entrar" are `personal`: they still offer Google and show "Lo usan varios
empleados" when shared. On the tablet: Salir, then sign out of the Google
account in the browser and clear this site's data. Open `/app`, pair it with a
code from Dispositivos, then **Desvincular** the old "Owner browser" entry.

## Residual risks

- Clearing a terminal's site data unpairs it; it then shows the Google entry
  like any unpaired browser. Owners must never leave a personal Google session
  in a terminal's browser profile.
- Offline unlock without a PIN ("Continuar como") attributes offline sales to
  the locked employee without proof that they are the one at the terminal. It
  lasts only while the device is offline (or the server unreachable) and its
  offline window is valid, and re-locks on reconnect; every online call made
  during it first checks that the server is still unreachable, so it never
  reaches online commands or reads. Only the lock screen's own calls
  (`/access/terminal`, `/access/pin`, `/access/step-up`, `/access/logout`) and
  the offline sync (`/offline/sync`, legacy `/sync`) skip that check. Clearing the
  browser's site data removes the remembered lock, but also unpairs the device.
- The lock's resistance to Escape and forced closes is tested in Chromium (the
  browser suite) and checked with a dialog probe in WebKit 26.6. The Android
  back gesture was not tried on a device. Where `closedby="none"` is supported,
  the dialog ignores the gesture, which may then navigate back. In either case
  the remembered lock applies again when the page comes back.
- Insider PIN guessing on a paired terminal is bounded (about 50 attempts per
  12 h per device) but not impossible against legacy 4-digit secrets.
- Revoking a device with an open drawer leaves that drawer open until a manager
  closes it remotely (Finanzas → Cortes, reports 029); the acknowledgement is
  audited and the dialog says so.
- Offline sales cite a session's lease windows, which are not capped at the
  session's end (`leaseCovers`), so evidence may be dated after a logout within
  the window. Accepted for v1 (review A12): a cap would refuse genuine sales
  recorded by tablets whose clocks run ahead.
- The demo path (`DEMO_TENANT_ID`, fictional tenant only, refused in
  production) shares one throttle scope and counts toward the demo owner's
  hard lock, and a correct non-owner secret answers `pair_device` (review A13).
- The 16-hour cap also applies to kitchen sessions; a KDS shows the expiry
  banner 30 minutes ahead and then its lock (review ACC-FLOOR-13).
- A lost pairing response leaves an unused device (last activity "—"); revoke it
  and create a new code.
- During a rolling deploy the previous revision still auto-pairs owner password
  logins, revokes on logout and validates offline sales against the base lease
  only, for the minutes of overlap.
- `sessions_live_by_device`, `sessions_live_by_employee`, `sessions_by_device`
  and `sessions_by_employee` are created inside the migration transaction. That
  is safe while `sessions` is small; on a large table, build them beforehand.
- A missing payment attempt that cannot be retried (for example its drawer was
  closed overnight) still blocks that employee's next Cobrar on that device
  with `payment_review_required`; there is no manager "Descartar intento" yet
  (see the merge notes).
- A restaurant's own paired devices, revoked ones included, can exhaust its
  per-IP backstop (20 times the device limit); pairing them needs a code from
  that restaurant's owner or manager.

## Merge notes (for integrators)

- **Lock on load and restore (offline merge, contract §4.7): done at
  offline's integration.** The golden
  `load()` shown in the contracts has neither `resumeLock(s)` nor
  `settleRejectedSession(code)`. Keep both: `load()` calls `resumeLock` before
  showing a session, calls `settleRejectedSession` on any 401, and offline's
  `restoreCached()` must call `resumeLock(cached)` too. Without them a reload
  unlocks (A1) and a revoked session is restored offline (A7). Merged with
  both, and `restoreCached()` calls `resumeLock(cached)`.
- **Payment attempt on a session 401 (offline merge): done at offline's
  integration.** Selling clears the
  attempt on any session 401 (`isSessionRejection`), which is safe only because
  `request()` never retries. If offline adds a bounded retry for idempotent
  POSTs, a first attempt that committed but lost its response followed by a
  retry rejected with 401 would clear an attempt that was charged. Either
  `request()` never retries into a 401, or Selling clears only when the call
  was never sent (`session_expired` while blocked, `session_locked`) or the 401
  came on the first attempt. Resolved in `request()`: a retried POST answered
  401 reports the first, transient failure. The unsent refusals carry kind
  "auth", so offline sync never turns them into conflicts (OFF-7).
- **Soft-unlock check (offline merge): done at offline's integration (LD-10
  B6).** App's `registerSoftUnlockCheck` probed
  `/api/health` itself; at merge it should use offline's `probeNow()` /
  `canUseServer` instead, keep refusing the call unsent with `session_locked`,
  and keep exactly `/sync` and the lock screen's calls (`/access/terminal`,
  `/access/pin`, `/access/step-up`, `/access/logout`) exempt; authenticated
  `/access/*` reads such as the staff and device lists are checked. Merged:
  the check runs `probeNow()` and treats any answer since the call asked as
  "the server answers" (offline's mode needs two answers in a row to turn
  online); `serverDown` and the `/api/health` prober are gone; the lock gets
  `serverReachable`; `/offline/sync` joins `/sync` in the exempt list (it is
  where offline's queue posts); LockScreen reads a transient `ApiError` from
  offline's `request()` as "no answer".
- **Limiter key (ops merge, LD-9): done at access's integration.** Every
  access limiter keys on `ipKey(req)` in `server/routes/access.ts`, which now
  uses `clientIp(req)` from `server/logging.ts`; the CD smoke
  (`scripts/ops/smoke.mjs`) fails a deployed run whose edge sends no
  X-Forwarded-For hop.
- **Void approval pre-check (service merge, contracts §4.2): done at service's
  integration.** `verifyApproval` refuses a closed or fully paid order before
  checking any PIN (ACC-R-5). It now reads `check_state` and calls service's
  `assertCheckWritable`, still without a lock, so it refuses exactly what
  `voidLines` refuses with the same codes (`stale_order` for recovery orders,
  `check_closed` for closed checks and cancelled orders). Its `recordedVoid`
  bypass (ACC-R6-1) stays: an identical retry of a recorded void reaches
  `voidLines`' `once()` and gets the stored result.
- **Unlocking owners (platform-prep, wave-2 A3).** Hardening A5 lets a manager
  unlock only cashiers, servers and kitchen staff (never a hard lock, at most
  3 times per employee a day); owners and managers are unlocked by the owner.
  This supersedes the wave-2 spec text "Managers can still unlock a locked
  owner" (access spec §2.2 C step 4), "unlockStaff is unchanged: managers and
  owners may unlock an owner" (§4.7 A3) and the StaffManagement note that the
  unlock block lets another owner be unlocked (§5.4). Access-db test 28 in
  §7.9 must expect `unlock_owner_only` (403) for a manager unlocking an owner
  and a successful unlock by the owner; the owner-PIN self-only part of A3 is
  unaffected. **Done in account (031):** an owner's PIN can be reset only by
  that owner (`owner_pin_self_only`, in `resetStaffPin` and the legacy
  `POST /employees` save, which also refuses owner role changes and owner
  deactivation); access-db covers the A3 self-only reset and the A5 unlock
  rule.
- **Retiring a departed owner's devices (account, decision 17).** Deactivation
  now unpairs the employee's personal devices through
  `retirePersonalDevices(tx, s, employeeId)` in `server/access-devices.ts`
  (ACC-R6-2). **Done in account (031, LD-15 Q4):** `revokeOwnerSeat`
  (co-owner removal or leaving, a previous owner leaving at transfer) mirrors
  `setStaffActive`: it deactivates the seat and clears its Free slot, ends and
  revokes its sessions, cancels its open pairing codes and retires its personal
  devices through the access-owned actor variant
  `retirePersonalDevicesAs(tx, actor, employeeId)` (an account actor instead of
  a POS session), and writes `access.employee_deactivated {name, sessions,
  pairingCodes, personalDevices}`. `revokeOwnerSessions` now restores the
  caller's `app.account_id` after its scoped statements.
- **"Descartar intento" (offline or RecoveryQueue).** A manager-only discard,
  with step-up and an audit row, for attempts in state `missing` with
  `retryAllowed=false`, so a missing attempt that can no longer be retried
  stops blocking that employee's Cobrar on that device. Not built in access.

## Data minimisation

No IP address, user agent or location is stored for devices or sessions; rate
limits keep per-IP counters in memory only. Device rows hold a name, kind,
pairing and activity timestamps and the employee who paired or revoked them.
This keeps the personal data proportional to the purpose (LFPDPPP 2025,
<https://dgesui.ses.sep.gob.mx/sites/default/files/2025-04/LFPDPPP.pdf>).

## Verification (local)

- `npm run test:db:access` (39 checks, one of which applies migration 023 as an
  owner role without BYPASSRLS in a scratch database), plus the updated voids,
  owner and offline-recovery suites in `npm run test:db:qualification`.
- `npm run build && npm run test:access-http` (13 checks against the compiled
  server, with and without `DEMO_TENANT_ID`, including the terminal guard's case,
  trailing-slash, HEAD and account-center variants, the device-keyed limits,
  the per-restaurant backstop and pairing ending a held Google sign-in).
- `tests/browser/access.spec.ts` (25 flows, axe at 1440 and 390, no horizontal
  overflow at 1440/1024/768/390); evidence in `docs/evidence/access-*.png`.
- `tests/access.test.ts`, `tests/access-client.test.ts` and
  `tests/access-lock.test.ts` (unit).

Not verified: staging (`scripts/staging-smoke.mjs` gained a pairing and step-up
step but was not run), production, and real tablets or kiosks.
