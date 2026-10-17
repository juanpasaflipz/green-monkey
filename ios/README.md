# Green Monkey Kiosk — iPad app

A thin SwiftUI shell around the web kiosk (`https://app.greenmonkey.online/kiosk#<token>`,
[docs/KIOSK.md](../docs/KIOSK.md)). The menu, cart, payment and pairing all stay in the web app;
the shell only makes the iPad behave like a kiosk: full screen with no Safari bars, kept on the
kiosk page, reconnecting on its own.

- iPadOS 26+ (SwiftUI `WebView`/`WebPage`), iPad only, Swift 6.
- Bundle id `online.greenmonkey.kiosk`, display name «Kiosco».

## Build

```bash
brew install xcodegen
cd ios
xcodegen                     # regenerate after adding files or editing project.yml
open GreenMonkeyKiosk.xcodeproj
```

Tests (Swift Testing; the link parser and the navigation rule):

```bash
xcodebuild -project GreenMonkeyKiosk.xcodeproj -scheme GreenMonkeyKiosk \
  -destination 'platform=iOS Simulator,name=iPad Air 13-inch (M3)' test
```

Debug builds take a link at launch: `-kioskURL 'https://…/kiosk#…'` (scheme arguments, or
`xcrun simctl launch <device> online.greenmonkey.kiosk -kioskURL '…'`).

## Setting up an iPad

1. Install the app (Xcode for now; TestFlight or an MDM later).
2. On the caja: Configuración → Pedidos en línea → **Agregar kiosco**. The link and its QR code
   are shown once.
3. On the iPad, open Kiosco → **Escanear código QR** (or copy the link and use **Pegar**).
4. Pair the tablet so the kiosk gets its welcome screen and self-checkout ([KIOSK.md
   §4](../docs/KIOSK.md)): **Vincular tableta** on the station, then on the iPad hold the
   restaurant name for 3 seconds → «Configurar este kiosco» → the code.
5. Lock it with Guided Access: Settings → Accessibility → Guided Access (passcode, Display
   Auto-Lock: Never). Open Kiosco, triple-click the top button → Start. In Options turn off the
   Sleep/Wake and Volume buttons; keep Touch and Keyboards on (the name, the note, the club
   keypad).

## How it behaves

| | |
|---|---|
| Staff settings | Hold **two fingers anywhere for 3 seconds**, then the iPad's Face ID/passcode. It never takes screen area from the page (both top corners are the page's header; the restaurant name has the web's own 3-second press). Without a passcode on the iPad the sheet opens with a warning. |
| The link | Stored in the Keychain (`AfterFirstUnlockThisDeviceOnly`); the token is a bearer secret and is shown only as `host/kiosk · ••••last4`. |
| Navigation | Only the link's own `/kiosk` page (same scheme, host and port) and `about:` load in the frame; everything else is cancelled. |
| No network at boot | A guest-facing «Este kiosco no está disponible por ahora. Pide en caja.» and retries at 5, 10, 20… up to 60 s. |
| 5xx on load | Cancelled and retried, so a Railway error page never sits on the kiosk. |
| After the page is up | The web app owns connection loss («Sin conexión. Pide en caja.»). The shell reloads only if WebKit's content process dies; other navigation errors leave the page (and a guest's cart) alone. |
| Pairing cookie | The default persistent website data store keeps `gm_kiosk` across relaunches. |
| Screen | Idle timer off while active (the page also holds a wake lock); status bar and home indicator hidden; fullscreen requests from the page are refused harmlessly (the web catches them). |
| MDM | Managed app configuration key `kioskURL` provisions or re-points the link and wins over the stored one on each launch. |

## Not verified yet

- On a real iPad: the camera scan of the reveal's QR, Face ID inside Guided Access, and the
  pairing cookie surviving a relaunch. The simulator checks so far: the setup screen, the
  offline retry screen, and the production page loading full screen.

## Link versus tablet pairing code

The app's first screen accepts the full kiosk URL (`https://…/kiosk#…`). A station
name such as `ios1` or an eight-digit tablet pairing code is not a kiosk URL.
The app validates the link's 22-character base64url token before saving it.

Only after the restaurant menu loads, hold the restaurant name for three seconds
and enter the eight-digit code in **Configurar este kiosco**. Unpairing or creating
a new tablet pairing code changes the tablet binding, not the kiosk URL. It cannot
repair a missing, malformed or revoked URL. If the URL was replaced, update the
app's stored URL through its staff settings (two fingers held for three seconds).
Replacing a valid URL unnecessarily invalidates every tablet using the old URL.
