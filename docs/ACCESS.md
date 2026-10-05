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

**Step-up**: on a terminal, refunds, paid-outs, manager self-approved voids and
every staff, device and pairing-code command (including the legacy
`POST /api/team/save`) need a PIN entered within
`ACCESS_STEP_UP_SECONDS` (default 120). The client asks "Confirma con tu PIN"
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
error, and App probes `/api/health` every 10 s. At merge, offline's probe-based
`canUseServer` replaces this local reachability flag. That soft unlock is not a
PIN unlock: the lock stays remembered, a reload asks again, and the same lock
comes back as soon as the server answers again or the offline window ends, so
the PIN is required before any online work. Switching
user needs a connection. A server session code also applies to the offline
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
  (`too_many_attempts`); `req.ip` is the real client behind Railway (`trust proxy`).
- A code dies with its creator's access: deactivating the creator, or a role
  change away from owner/manager, cancels their open codes, and redemption
  requires an active owner or manager creator.
- Re-pairing a browser that already holds this restaurant's terminal cookie
  retires the old device (`revoked_reason = 'replaced'`).

Operator fallback (support only, privileged database URL):

```bash
npm run access:pairing-code -- --tenant <restaurant uuid> --name "Caja 1" \
  --confirm-target <host:port/db of MIGRATION_DATABASE_URL>
```

`JWT_SECRET` must be the secret of the server that will redeem the code. The
command prints one code and its expiry, attributes it to the restaurant owner
and writes the `access.pairing_code_created` audit row.

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
  only. A void approval checks that the order exists before any PIN, and one
  session's rejected approvals are capped at 10 per minute
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
  Deactivation revokes the employee's sessions on every device and blocks Google
  re-entry; records are kept. Owner role changes, owner deactivation and
  self-deactivation are refused. These commands work from downgraded or
  unselected Free sessions; the Free team limit still applies.
- **Dispositivos** (owner and manager; personal devices are owner-only): kind,
  status, last activity, live session, Free selling slot and a warning when a
  personal device is used by several employees. Rename, auto-lock, end the live
  session, unpair. Unpairing a device with an open drawer needs an explicit
  acknowledgement, also when the drawer was opened after the list loaded. The
  drawer then stays open and no device can close it until the reports area's
  remote close ships (see the runbook below). Unpairing a personal device also
  ends the Google sign-ins (`owner_sessions`) that entered it.
- **Free selling slot**: the first device that signs in takes the Free selling
  slot, and in a new restaurant that is usually the owner's phone (Google
  entry). A terminal paired afterwards shows "Free: … no está seleccionado"
  until the owner selects it in "Registro y equipo Free"; the pairing dialog
  says so when the plan is Free.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DEMO_TENANT_ID` | Enables the demo owner form and owner-password pairing for this one fictional tenant. Local and fictional staging only; the server refuses to start when it is set and `RAILWAY_ENVIRONMENT_NAME` is `production`. |
| `ACCESS_STEP_UP_SECONDS` | Step-up window, 30..1800 (default 120). Browser suites use 1800. |
| `ACCESS_IDLE_LOCK_DEFAULT_SECONDS` | Default terminal auto-lock: 0 (never), 60, 120, 180, 300, 600 or 900 (default 180). Browser suites use 0; the access idle test sets the device explicitly. |

## Runbooks

**Lost or stolen tablet.** From any manager device: Configuración →
Dispositivos → **Desvincular** the tablet. Its credential stops working at once,
its sessions are revoked and its queued sales go to reconciliation in
Sincronización. Pair a replacement with a new code. If PINs may have been
observed, reset the PINs of everyone who used it (Equipo → Editar → PIN).

If its drawer was open: close it on the tablet first if the tablet still works
(Caja → Cerrar caja). Otherwise count the drawer's cash now, keep the count,
then unpair. No device can close that drawer afterwards until the reports
area's remote close ("Cerrar caja desde aquí", wave 2) ships. Until then support
closes it with the manager's count, through the migration role in one
transaction with `app.tenant_id` set:
`update cash_sessions set counted=<count>, expected=<expected>, reason='Cierre por soporte: dispositivo desvinculado', closed_at=clock_timestamp() where id=<drawer> and closed_at is null`,
where `<expected>` is computed as `cashSummary` does (opening + cash tenders
and tips − refunds + cash movements of that drawer), and records it in the
support log.

**Lost or stolen phone or laptop (owner or invited member).** The owner opens
Dispositivos from another device and **Desvincular**s it. Its POS sessions are
revoked and the Google sign-ins that entered it end at once. A Google sign-in
from before the unpairing can no longer pair that browser again
(`owner_reauth_required`); only a new Google sign-in can. Change the Google
account's password if the device itself may still be signed in to Google.

**Fired employee.** Equipo → Editar → **Desactivar empleado**. Every session on
every device is revoked; an invited Google member also loses Google entry to the
location. Unsent sales on a device wait for manager reconciliation.

**Locked manager or owner.** The owner opens Equipo → Editar →
**Desbloquear** (managers cannot unlock managers or owners). Otherwise wait for
the stage lock to expire (at most 60 minutes), or the owner resets the PIN. A
hard lock (100 consecutive failures) needs the owner's unlock or a PIN reset.
A Google owner without a usable PIN on a terminal unlocks from their phone.

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
  lasts only while the device is offline and its offline window is valid, and
  re-locks on reconnect, so it never reaches online commands. Clearing the
  browser's site data removes the remembered lock, but also unpairs the device.
- The lock's resistance to Escape and forced closes is tested in Chromium (the
  browser suite) and checked with a dialog probe in WebKit 26.6. The Android
  back gesture was not tried on a device. Where `closedby="none"` is supported,
  the dialog ignores the gesture, which may then navigate back. In either case
  the remembered lock applies again when the page comes back.
- Insider PIN guessing on a paired terminal is bounded (about 50 attempts per
  12 h per device) but not impossible against legacy 4-digit secrets.
- Revoking a device with an open drawer leaves that drawer open with no device
  to close it until the reports area's remote close ships; the acknowledgement
  is audited, the dialog says so, and the runbook gives the support step.
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
- `sessions_live_by_device` and `sessions_live_by_employee` are created inside
  the migration transaction. That is safe while `sessions` is small; on a large
  table, build them beforehand.

## Data minimisation

No IP address, user agent or location is stored for devices or sessions; rate
limits keep per-IP counters in memory only. Device rows hold a name, kind,
pairing and activity timestamps and the employee who paired or revoked them.
This keeps the personal data proportional to the purpose (LFPDPPP 2025,
<https://dgesui.ses.sep.gob.mx/sites/default/files/2025-04/LFPDPPP.pdf>).

## Verification (local)

- `npm run test:db:access` (35 checks, one of which applies migration 023 as an
  owner role without BYPASSRLS in a scratch database), plus the updated voids,
  owner and offline-recovery suites in `npm run test:db:qualification`.
- `npm run build && npm run test:access-http` (11 checks against the compiled
  server, with and without `DEMO_TENANT_ID`, including the terminal guard's case,
  trailing-slash, HEAD and account-center variants and the device-keyed limits).
- `tests/browser/access.spec.ts` (24 flows, axe at 1440 and 390, no horizontal
  overflow at 1440/1024/768/390); evidence in `docs/evidence/access-*.png`.
- `tests/access.test.ts`, `tests/access-client.test.ts` and
  `tests/access-lock.test.ts` (unit).

Not verified: staging (`scripts/staging-smoke.mjs` gained a pairing and step-up
step but was not run), production, and real tablets or kiosks.
