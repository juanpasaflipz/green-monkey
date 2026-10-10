# Kiosk self-checkout and menu photos (migration 039)

Wave 4, LD-71/LD-72; spec `specs/kiosk-w4.md` with the Wave 4 critic's resolutions binding where they
differ. This document describes what shipped.

**LD-72: the kiosk sends an order to the kitchen on payment only.** An approved card charge at the
kiosk creates the order with no staff tap. A guest who pays at the counter is accepted by staff
exactly as before 039. Fire-before-payment (`on_order`) is not built.

## 1. Concepts

| Term | Meaning | Where |
|---|---|---|
| Kiosk link | A `public_links` row with `kind='kiosk'` (032). Since 039 it points at its station (`station_id`, set at insert; "Reemplazar" copies it). | `server/public-links.ts` |
| Station ("Kiosco Entrada") | The kiosk spot's mutable configuration: the card reader (`terminal_id`, a payments terminal, critic R14) and the receiving till (`register_device_id`, a staff device whose open drawer takes the kiosk's card tenders). Survives link rotation. "Desactivar" on the link archives it and unpairs its tablet. | `kiosk_stations` |
| Kiosk device | The tablet bound to one station: an HttpOnly cookie `gm_kiosk` (Path `/api/public/kiosk`, SameSite Strict, 400 days) whose secret is stored only as `sha256('gm-kiosk-device-v1:'‖secret)`. Paired with a one-time 8-digit code (10 minutes, single use, 5 wrong tries kill it; stored as `sha256('gm-kiosk-pair-v1:'‖station‖':'‖code)`). | `kiosk_devices` |
| Checkout | One row per kiosk hold: the device, the guest's payment choice, the latest payments attempt (`attempt_id`, `attempt_count` ≤ 3) and the club member reference. Payment state is never copied: it is the attempt's. | `kiosk_checkouts` |
| Kiosk actor | The session kiosk actions run as: the employee who opened the receiving till's current drawer, on that till (`drawer()` finds it), role cashier, id `kiosk:<deviceId>`. Reports keep the order in "QR / Kiosco". Audit rows carry `via: {kind: 'kiosk'}`. | `server/kiosk-accept.ts` |
| Self-checkout available | Computed: `KIOSK_SELF_CHECKOUT_ENABLED` not `false`, ordering open for the link (not paused, staff seen in 5 minutes), a bound device of this station, the receiving till's drawer open. Card additionally needs an integrated, active, unarchived terminal on the station whose provider is configured, and a payment mode other than "Solo en caja". | `kioskState()` |

## 2. Flows

**Guest (bound tablet).** Bienvenida ("Toca para ordenar", English, Accesibilidad, Soy del club) →
menú with photos → product sheet (photo, description, "Combínalo con…", "Agregar · $") → carrito
(name and kitchen note as before; "¿Algo más?" or "Lo más pedido a esta hora") → **Enviar pedido** →
"¿Para aquí o para llevar?" → the order becomes a hold with its checkout → "¿Cómo quieres pagar?":

- **Pagar aquí con tarjeta**: `POST /api/public/kiosk/charge` re-quotes the hold (a changed price or
  an unavailable product sends the guest back to the cart), then payments' `startCharge` with target
  `kiosk_hold` on the station's terminal, as the kiosk actor, into the receiving till's drawer. The
  worker pushes it to the reader. The kiosk calls `POST /checkout/sync` every 2 s.
  - Approved: payments' `kiosk_hold` settler creates the order and records the card tender
    (`settleKioskHoldCharge`); the guest sees "¡Pagado! Tu pedido K-14 ya se está preparando", the
    folio, the self-invoice QR when cfdi offers it (LD-41: the kiosk diner is the payer), and the
    club's stamps or join QR. Reset after 30 s.
  - Declined, cancelled or expired: "Tu tarjeta no pasó" → Intentar de nuevo (at most 3 attempts) /
    Pagar en caja / Cancelar pedido.
  - No answer after 3 minutes: the kiosk asks payments to cancel. Withdrawn → as a decline. Still on
    the reader → "La terminal sigue procesando…", 2 more minutes of polling, then "Pregunta en caja
    por tu pedido K-14". The charge keeps settling server-side (payments' poll chain).
  - Approved but the order could not be created (an 86 or a price change between start and
    approval): payments' `review` with a `kiosk_settle_*` code; the guest sees "Tu pago se registró.
    Pasa a caja con tu código K-14".
- **Pagar en caja**: the K-code screen, as before 039; the hold is an ordinary inbox card.

"Tarjeta en el kiosco (caja solo si falla)" shows "Pagar en caja" only after a card failure. An
unbound kiosk works exactly as before 039 plus the para aquí question: counter only.

**Zero total.** With self-checkout available the kiosk accepts it itself (no charge), once
(`kioskAccept`, the checkout's `fire_operation_id`).

**Staff.** While a charge is live the inbox card reads "Pagando en el kiosco…" with no accept or
reject (`kiosk_charge_in_progress`, critic R12; the diner's cancel is refused too); a manager may
"Cancelar cobro en curso". A charge approved without an order is a red card first in the inbox:
"Resolver cobro del kiosco" opens payments' resolve dialog — any operator retries once the order
fits again (the product is back), a manager records a refund done in the provider's app, after
which the hold can be rejected (critic R13: no partial refunds in v1). A drawer with a live or
review kiosk charge cannot close (payments' `payments_attempt_unresolved`).

## 3. Settings (Configuración → Pedidos en línea → Kiosco de autoservicio)

Owners and managers; saves ask for a recent PIN (unpairing does not).

| Setting | Values | Default |
|---|---|---|
| Cobro en el kiosco | Solo en caja · Tarjeta en el kiosco o en caja · Tarjeta en el kiosco (caja solo si falla) | Solo en caja |
| Preguntar para aquí o para llevar | on/off (off: every kiosk order is takeaway) | on |
| Sugerencias | on/off | on |
| Club en el kiosco | on/off (only when the club is on) | off |
| Per station | Terminal (integrated readers only), Caja que recibe los cobros, Vincular tableta, Desvincular, last heartbeat and build | — |
| Sugerencias del carrito | up to 6 products | none ("Lo más pedido a esta hora" then) |

Per product (Menú e inventario): Foto, Descripción (es/en, 300 characters), "Sugerir con este
producto" (up to 4).

## 4. Device setup (Samsung Tab S10 FE, Chrome with app pinning)

1. Uninstall the pos-lite kiosk APK. Update Chrome. Screen lock with a PIN; turn on app pinning with
   "Solicitar PIN para quitar la fijación"; battery protection on the charger.
2. In Green Monkey: add the kiosk link (Códigos), set its terminal and till, **Vincular tableta**.
3. On the tablet: open the kiosk link, long-press the restaurant name for 3 seconds →
   "Configurar este kiosco" → type the code → "Kiosco vinculado: Entrada".
4. Tap "Toca para ordenar" once (fullscreen), then pin Chrome from Recientes. After a power cut,
   re-pin.

A bound tablet keeps a screen wake lock, sends a heartbeat every minute (build and orientation
only; no IP or user agent stored) and reloads itself when a new build ships while it sits on the
welcome screen with an empty cart. The service worker never answers `/kiosk` (critic R32).

## 5. Idle and accessibility

"¿Sigues ahí?" at 70 s with a cart, reset at 95 s (25 s to answer, WCAG 2.2.1); the pay screen
resets after 120 s; a charge suspends the reset (3 + 2 minutes at most); the done screen resets after
30 s (paid) or 20 s (counter). The reset clears the cart, the member, the language and the
accessibility modes. Texto grande (125 %) and Modo alcance (content in the lower two thirds); 48 px
targets at least (64 px kiosk buttons); a persistent live region announces the order, the charge,
approval and decline.

## 6. Club at the kiosk (interface with loyalty 038, critic R20–R23)

"Soy del club": a 10-digit keypad, device-bound, 5 lookups per device per 5 minutes plus loyalty's
per-IP limiter. Counts and a masked phone only, never a name; nothing is created at the kiosk. The
station-bound member token (15 minutes) rides on the order; the settle links the member right after
createOrder (`linkFromKiosk`), and loyalty stamps on payment through its own hook. A non-member's
paid order offers loyalty's join QR. The checkout's member reference is blanked at 30 days
(retention).

## 7. Menu photos

**Pipeline (LD-88: no native image library).** The browser checks the original by its bytes (JPG,
PNG or WebP; HEIC refused; 10 MB; 40 megapixels from the header, before decoding), re-encodes three
WebP variants on a canvas (160, 480, 1200 px wide, never enlarged, quality 0.8) and uploads them as
one body. `processUpload` (the single seam a server re-encoder can replace) splits the RIFF files,
validates each container and rebuilds it from only VP8/VP8L, or VP8X (flags rewritten to alpha only)
+ ALPH + VP8; EXIF, XMP and ICC chunks are dropped; animation, unknown chunks, bad sizes and
trailing bytes are refused; the three variants must be one picture at the three widths.

**Security note: the server validates the container, not the pixels; uploads are staff-only**
(owners and managers, 30 per tenant per 10 minutes, one at a time per process). Browsers that
cannot encode WebP on a canvas (Safari on some iPads) get "Súbela desde Chrome o Edge".

**Store.** `MEDIA_STORE=r2` (a private Cloudflare R2 bucket, S3 API signed with a small SigV4 signer
tested against the AWS test suite) or `fs` (`MEDIA_FS_ROOT`, development and CI only; refused in
staging and production while photos are on). Unset: no photos can be stored, the menu shows text
tiles. Keys `m/<tenant>/<asset>/<thumb|card|hero>.webp`; ids are server-generated.

**Serving.** `GET /media/<asset>/<variant>.webp`, same origin (no CSP change), no session: the
`menu_media_lookup` policy resolves exactly the ready asset. `Cache-Control: public,
max-age=31536000, immutable`, ETag = the variant's sha256, `nosniff`, `default-src 'none'; sandbox`,
`Cross-Origin-Resource-Policy: same-origin`. "Quitar foto" answers 404 at once (other replicas
within the 10-minute cache). Web jobs: `media_purge` deletes the objects 7 days after removal;
`media_stale` sweeps an upload that never finished (1 hour).

## 8. Kill switches

| Variable | Default | Off |
|---|---|---|
| `KIOSK_SELF_CHECKOUT_ENABLED` | on | No card at the kiosk; kiosks take counter orders as before 039. Settlement of charges already taken continues. |
| `MENU_PHOTOS_ENABLED` | on | No upload, no photos anywhere, the media route answers 404. |
| `PUBLIC_ORDERING_ENABLED` (031) | on | The kiosk closes; charge settlement continues (payments' jobs). |

Invalid values refuse to start (`kiosk_flag_invalid`, `media_flag_invalid`, `media_store_invalid`).
`MEDIA_R2_*` are forbidden on the worker (critic R36).

## 9. Data, retention and export

039 adds `kiosk_settings`, `kiosk_stations`, `kiosk_devices`, `kiosk_checkouts`, `menu_media`,
`menu_suggestions` (FORCE RLS; no DELETE grant on any; identities immutable by trigger),
`public_links.station_id` and `public_order_holds.decision_source` (`staff` | `kiosk`), and lets a
kiosk hold be dine-in without a table ("Comer aquí" on the KDS and the kitchen ticket). Owner export
labels all six tables; device hashes are excluded by the column rule. Retention blanks
`kiosk_checkouts.loyalty_member_id` after 30 days; media rows are kept, objects purged 7 days after
removal.

## 10. Reports

Finanzas › Kiosco: kiosk orders, paid at the kiosk vs at the counter, charges approved without an
order (open, resolved, refunded), and suggestion lines accepted with their amount. The corte's
"Del kiosco" sub-line is payments' per-terminal split.

## 11. Troubleshooting

| Symptom | Check |
|---|---|
| The kiosk only offers "Pagar en caja" | Tablet paired (Configuración shows "Tableta vinculada"), the receiving till's drawer open, a terminal on the station, the provider connected, "Cobro en el kiosco" not "Solo en caja", `KIOSK_SELF_CHECKOUT_ENABLED`. |
| "La terminal está ocupada" | Another charge is live on that reader (another kiosk or the POS). Wait, or a manager cancels it. |
| A red card "pagó … y no se pudo enviar a cocina" | Resolver cobro del kiosco: retry once the product is back, or refund in the provider app and record it, then reject the hold. |
| "Sin señal desde las …" | The tablet is off, unpinned, asleep or offline. |
| Photos do not show | `MEDIA_STORE` and its credentials; `MENU_PHOTOS_ENABLED`; the media route's 503 means the store is down (the menu falls back to text tiles). |
