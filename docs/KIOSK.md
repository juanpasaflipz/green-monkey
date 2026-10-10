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
  - «Cancelar cobro» appears after 20 s on "Sigue las instrucciones en la terminal", while the
    attempt is live and no cancel was asked (KIOSK-UX-03). It asks payments to cancel, which
    withdraws the charge only when the provider confirms (Clip's withdraw, MP's cancel). Withdrawn →
    "Cobro cancelado" with retry / Pagar en caja / Cancelar pedido. Refused by the reader → "La
    terminal sigue procesando…" plus "Cancela el cobro en la terminal". Already final → the next
    sync shows it.
  - No answer after 3 minutes: the kiosk asks payments to cancel, with the same outcomes.
  - "La terminal sigue procesando…" polls 2 more minutes and offers «Pedir ayuda en caja». Either
    way the guest ends on "Pregunta en caja por tu pedido K-14". Neither exit cancels the hold: the
    inbox keeps a kiosk hold with a live attempt past its expiry, and a late approval still becomes
    the order (critic R12). An attempt that ends without money on that screen goes to the decline
    screen, whose walk-away reset cancels the hold. The charge keeps settling server-side
    (payments' poll chain).
  - Approved but the order could not be created (an 86 or a price change between start and
    approval): payments' `review` with a `kiosk_settle_*` code; the guest sees "Tu pago se registró.
    Pasa a caja con tu código K-14".
- **Pagar en caja**: the K-code screen, as before 039; the hold is an ordinary inbox card.

"Tarjeta en el kiosco (caja solo si falla)" shows "Pagar en caja" only after a card failure. An
unbound kiosk works exactly as before 039 plus the para aquí question: counter only. A kiosk that
cannot take the card (unbound, till closed, card off, no terminal, counter mode) records the hold as
«Pagar en caja» when it creates it (`payment_choice='counter'`), so it is an ordinary inbox card.

**Zero total.** With self-checkout available the kiosk accepts it itself (no charge), once
(`kioskAccept`, the checkout's `fire_operation_id`).

**Staff.** Only a hold the guest sent to the counter («Pagar en caja», or a kiosk that could not
take the card) keeps the counter policy's Aceptar/Rechazar (KIOSK-UX-04, KIOSK-MONEY-3). A kiosk
hold whose guest is still at the kiosk (no choice yet: «En el kiosco · aún no paga») or chose card
and never paid (a decline, a walk-away, a review refunded at the provider: «Cobro con tarjeta
abandonado») is pay-first whatever the policy: no «Aceptar y enviar a cocina»; «Cobrar y enviar a
cocina», «Rechazar» and a manager's «Aceptar sin cobrar (excepción)» (recent PIN, recorded as a
policy override) stay. The server enforces it: a plain accept answers `public_payment_required`
(`inboxActions` in shared/public-ordering.ts; kiosk DB K29). Opening «Cobrar y enviar a cocina» on
such a hold first claims it for the counter (`POST /api/ordering/holds/:id/claim`, KV-FIXES-1: locks
2 → 2b, refused while an attempt is live or once the hold expired, sets `payment_choice='counter'`),
so the kiosk's 120 s reset and «Cancelar pedido» can no longer cancel a hold the cashier is charging
(`kiosk_hold_at_counter`) and the kiosk can no longer start a card on it. A payment-carrying accept
of a kiosk hold gets the paid accept's grace (`PAID_ACCEPT_GRACE_SECONDS`, KV-FIXES-3). The inbox's
`kiosk` block is null for a
pre-039 kiosk link's hold (no checkout), a counter hold as before. While a charge is live the inbox
card reads "Pagando en el kiosco…" with no accept or reject (`kiosk_charge_in_progress`, critic R12;
the diner's cancel is refused too); a manager may tap "Cancelar cobro" on that card. A charge
approved without an order is a red card first in the inbox:
"Resolver cobro del kiosco" opens payments' resolve dialog (critic R13):

- **Registrar el cobro aprobado** (any operator, no PIN): once the order fits again (the product is
  back, the price is the charged one). «Volver a consultar» only asks the provider again. It works however long ago the hold expired, because the charge started
  while it was valid (R12).
- **Aceptar con el pago del kiosco** (managers, recent PIN, a note): the hold as its card includes
  it now (lines left out, the current prices) becomes a new check with the card charge as its
  tender (payments' manager record, into the kiosk till's drawer). A total above the charge
  collects the rest in the same accept, in cash or on a manual terminal, through the payment
  dialog (into this device's drawer). A total below the charge is refused
  (`kiosk_charge_above_total`): v1 has no partial refund, so the manager includes lines until the
  total equals the charge, or:
- **Rechazar y reembolsar** (managers, recent PIN, a note naming the refund): the manager refunds
  the whole charge in the Mercado Pago or Clip app first; the reject then records it (payments'
  `refunded_at_provider`) and rejects the hold in one transaction.

A drawer with a live or review kiosk charge cannot close (payments' `payments_attempt_unresolved`).

## 3. Settings (Configuración → Pedidos en línea → Kiosco de autoservicio)

Owners and managers; saves ask for a recent PIN (unpairing does not). The settings save with
«Guardar configuración», the cart list with «Guardar sugerencias», each station with «Guardar
estación»; a save keeps the other parts' unsaved edits (KIOSK-UX-12).

| Setting | Values | Default |
|---|---|---|
| Cobro en el kiosco | Solo en caja · Tarjeta en el kiosco o en caja · Tarjeta en el kiosco (caja solo si falla) | Solo en caja |
| Preguntar para aquí o para llevar | on/off (off: every kiosk order is takeaway) | on |
| Sugerencias | on/off | on |
| Club en el kiosco | on/off (only when the club is on) | off |
| Per station | Terminal (integrated readers only), Caja que recibe los cobros («Guardar estación»), Vincular tableta (with a paired tablet: «Reemplazar tableta», asks first), Desvincular (asks first), last heartbeat and build | — |
| Sugerencias del carrito | up to 6 products | none ("Lo más pedido a esta hora" then) |

Each station row says why the kiosk takes no card (KIOSK-UX-10, critic R14), with
`kioskState`'s conditions in its order: the server switch, no paired tablet, no till or the till
closed ("la caja Caja mostrador está cerrada"), «Solo en caja», no active integrated terminal
(inactive, archived or manual: the select then shows «Sin terminal»), then the terminal's provider
as /capabilities reports it ("Clip no está conectado", "Mercado Pago no está activo en este
servidor" while `PAYMENTS_PROVIDERS` leaves it out). The till select shows each till as abierta or
cerrada.

Per product (Menú e inventario): Foto, Descripción (es/en, 300 characters), "Sugerir con este
producto" (up to 4).

## 4. Device setup (Samsung Tab S10 FE, Chrome with app pinning)

1. Uninstall the pos-lite kiosk APK. Update Chrome. Screen lock with a PIN; turn on app pinning with
   "Solicitar PIN para quitar la fijación"; battery protection on the charger.
2. In Green Monkey: add the kiosk link (Códigos); on its station set the terminal and the till and
   tap **Guardar estación**; set «Cobro en el kiosco» to **Tarjeta en el kiosco o en caja** and tap
   **Guardar configuración** (recent PIN; the default «Solo en caja» offers only «Pagar en caja»);
   then **Vincular tableta**.
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
30 s (paid) or 20 s (counter). A reset from the pay, declined or unavailable screens cancels the hold
when it is unpaid with no attempt live or approved and the guest did not choose «Pagar en caja»
(`cancelsOnReset`; KIOSK-MONEY-3), so the inbox never keeps a walk-away's order for 30 minutes; the
server refuses the cancel if a charge is live anyway. «Cancelar pedido» cancels it as before. The reset clears the cart, the member, the language and the
accessibility modes. Texto grande (125 %) and Modo alcance (content in the lower two thirds); 48 px
targets at least (64 px kiosk buttons); a persistent live region announces the order, the charge,
approval and decline.

## 6. Club at the kiosk (interface with loyalty 038, critic R20–R23)

"Soy del club": a 10-digit keypad, device-bound, 5 lookups per device per 5 minutes plus loyalty's
per-IP limiter. Counts and a masked phone only, never a name; nothing is created at the kiosk. The
station-bound member token (15 minutes) rides on the order. Every path that turns the hold into
an order links the member right after createOrder (`linkFromKiosk`, inside `createHoldOrder`): the
card settle, the zero-total accept, and staff's accepts of a «Pagar en caja» hold («Cobrar y
enviar», a plain accept, a manager's exception, «Aceptar con el pago del kiosco»). Loyalty stamps
on payment through its own hook, once. The counter screen says «Tu sello se suma al pagar en
caja» when the order carries a member (KIOSK-UX-01). The token travels only in the one submit
(R20 has no route that attaches a member to a placed hold), so «Soy del club» shows on the menu
and at «¿Para aquí o para llevar?» and is hidden once the hold is placed; after a lookup the cart
shows a «Club · ···· 4521» chip with the masked phone (KIOSK-UX-02). A non-member's
paid order offers loyalty's join QR. The checkout's member reference is blanked at 30 days
(retention).

## 7. Menu photos

**Pipeline (LD-88: no native image library; LD-91).** The browser checks the original by its bytes
(JPG, PNG or WebP; HEIC refused; 10 MB; 40 megapixels from the header, before decoding), re-encodes
three variants on a canvas (160, 480, 1200 px wide, never enlarged, quality 0.8) and uploads them as
one body. The variants are WebP where the browser can encode it, else JPEG: no WebKit browser
(desktop Safari, every iPadOS and iOS browser, Chrome and Edge on iPad included) can encode WebP on
a canvas, and the first variant decides, so one upload is all WebP or all JPEG (a transparent PNG
gets a white background in JPEG). `processUpload` (the single seam a server re-encoder can
replace) picks the format from the body's first bytes and splits the files.
- WebP (`shared/webp.ts`): each RIFF container is validated and rebuilt from only VP8/VP8L, or VP8X
  (flags rewritten to alpha only) + ALPH + VP8; EXIF, XMP and ICC chunks are dropped; animation,
  unknown chunks, bad sizes and trailing bytes are refused.
- JPEG (`shared/jpeg.ts`, KIOSK-UX-11): the marker structure (ITU-T T.81 Annex B) is walked with a
  bounds check on every length; it needs SOI … EOI, one 8-bit SOF0/SOF1/SOF2 frame (grayscale or
  YCbCr), DQT, DHT and SOS, with the tables each scan uses defined before it. The file is rebuilt
  from SOI, DQT, SOF, DHT, DRI, SOS + the entropy-coded data (stuffed 0xFF00 and in-order RSTn kept
  as they are) and EOI; every APPn (JFIF, EXIF, XMP, ICC, Photoshop, Adobe) and COM is dropped.
  Truncated input, trailing bytes, a second frame or a glued second image, arithmetic coding
  (SOF9–SOF15, DAC), lossless or hierarchical frames, DNL, more than 32 scans and unknown markers
  are refused, as are the two colour cases where dropping APPn would change the picture (an Adobe
  segment with an RGB transform, component ids 'R','G','B'). No JFIF APP0 is written back: JFIF is
  optional in T.81, and libjpeg-turbo (Chromium, Firefox) and ImageIO (Safari) read a 3-component
  frame without it as YCbCr. Checked on 2026-10-10 with real canvas JPEGs: WebKit's (JFIF, EXIF,
  Photoshop APP13, DRI) and Chromium's (JFIF, ICC) decode to the same pixels in WebKit and
  Chromium after the rebuild as before it.
- The three variants must be one picture at the three widths, each under the same caps for both
  formats (4× the variant's width per side, the variant's byte cap, hero at most 1200 px, at most
  1:4).

**Security note: the server validates the container, not the pixels; uploads are staff-only**
(owners and managers, 30 per tenant per 10 minutes, one at a time per process). A browser that
can encode neither WebP nor JPEG on a canvas gets «Este navegador no pudo preparar la foto».

**Store.** `MEDIA_STORE=r2` (a private Cloudflare R2 bucket, S3 API signed with a small SigV4 signer
tested against the AWS test suite) or `fs` (`MEDIA_FS_ROOT`, development and CI only; refused in
staging and production while photos are on). Unset (anywhere, including a deployed environment
before the owner provides the R2 media bucket): photos are unavailable. An upload is refused with
`media_store_not_configured` («Este servidor todavía no tiene dónde guardar fotos»), `/capabilities`
reports `menuPhotos` off with that reason, and the kiosk, the QR menu and the POS show text tiles.
The product editor reads that entry and shows «Fotos no configuradas en este servidor» (or «Las
fotos del menú están apagadas en este servidor» when `MENU_PHOTOS_ENABLED=false`) instead of «Subir
foto» (KIOSK-OPS-10).
`MEDIA_FS_ROOT` alone never selects the local driver, so a Railway service never writes photos to
its ephemeral disk (tests/config.test.ts, tests/media.test.ts). Keys `m/<tenant>/<asset>/<thumb|card|hero>.webp|jpg`; ids are server-generated.
The asset's type is stored per variant in `menu_media.variants` (`type`; absent = WebP) and as the
object's content type; a JPEG product image carries `type: "image/jpeg"` so `mediaUrl` builds `.jpg`.

**Serving.** `GET /media/<asset>/<variant>.webp|jpg`, same origin (no CSP change), no session: the
`menu_media_lookup` policy resolves exactly the ready asset, served with the `Content-Type` it was
stored as; the extension must match that type (404 otherwise). `Cache-Control: public,
max-age=31536000, immutable`, ETag = the variant's sha256, `nosniff`, `default-src 'none'; sandbox`,
`Cross-Origin-Resource-Policy: same-origin`. "Quitar foto" answers 404 at once (other replicas
within the 10-minute cache). Web jobs: `media_purge` deletes the objects 7 days after removal;
`media_stale` sweeps an upload that never finished (1 hour).

**Where photos show.** The kiosk (cards, the product sheet's hero, suggestions), the QR menu
(thumbnail) and Vender's selling grid; never receipts, comandas or reports. In Vender, **Pantalla**
(the screen icon next to the printer) sets «Fotos en la cuadrícula de venta» for this device only
(localStorage `gm-display-settings`): on by default on a shared terminal, off on a personal device
(a phone). The photo sits inside the tile's fixed-size art box over the product's initials, loads
lazily (`loading="lazy"`, `decoding="async"`, the 160 px thumbnail or the 480 px card by
`srcset`), is decorative (`alt=""`: the tile's text names the product), and one that fails to load
is dropped, leaving the initials: selling never waits on a photo. With `MENU_PHOTOS_ENABLED=false`
`GET /api/catalog` carries no photos.

**Importing photos from the previous system (critic R42/Q7, «Importar fotos»).** An in-app owner
import replaces the support CLI (no support write path, no store credentials on an operator's
machine). The operator downloads the old system's product photos into one folder and writes a
manifest next to them:

```json
{
  "format": "gm-menu-media-v1",
  "source": "pos-lite",
  "items": [
    { "id": "101", "name": "Taco de ejemplo", "file": "101.jpg" },
    { "id": "102", "name": "Agua de ejemplo", "file": "102.png" }
  ]
}
```

- `format` is exactly `gm-menu-media-v1`; `source` is a label (1–40 characters) kept in the report.
- `items`: 1–500 entries with exactly these keys. `id` is the old system's product id (1–64 of
  `A–Z a–z 0–9 _ . : -`, unique), `name` its product name (1–120 characters, used to propose the
  match), `file` the image's file name as saved (no folder, no URL, no control characters).
- The images are JPG, PNG or WebP, 10 MB and 40 megapixels at most (the upload's own limits).
  Option images and descriptions are not imported (descriptions are typed in the product editor).

Menú e inventario → Productos → **Importar fotos** (owners and managers): choose the manifest and
all the photos, then **Revisar**. Each item proposes the one active product whose Spanish or
English name equals the item's name ignoring accents, case, punctuation and spacing; no match,
several matches or a product an earlier item already took stay «— No importar —» until the owner
picks one. The status column reads Lista, Sin producto, Falta el archivo, Ya tiene foto (skipped
unless «Reemplazar las fotos que ya existen») or Producto repetido. **Importar N fotos** sends each
photo through the normal upload (the browser's check and WebP/JPEG re-encode, the server's validation),
one at a time; past the 30 uploads per 10 minutes it waits and resumes by itself. Each upload's
operation id is derived from the product, its version and the file's bytes, so a retried request
or a second tab never stores a second copy, and a re-run skips the products that already got their
photo. Audit: each photo's `menu.media.attached` row carries `via: {kind: "menu_import", batchId,
sourceId}`, and the run's report is one `menu.media.import` row (Bitácora «Menú: importación de
fotos») with every item's outcome (imported with its asset, unmatched, missing file, already had a
photo, repeated product, failed with its code). The screen ends on the list of items not imported
and why.

## 8. Kill switches

| Variable | Default | Off |
|---|---|---|
| `KIOSK_SELF_CHECKOUT_ENABLED` | on | No card at the kiosk; kiosks take counter orders as before 039. Settlement of charges already taken continues. |
| `MENU_PHOTOS_ENABLED` | on | No upload, no photos anywhere, the media route answers 404. |
| `PUBLIC_ORDERING_ENABLED` (031) | on | The kiosk closes; charge settlement continues (payments' jobs). |

Invalid values refuse to start (`kiosk_flag_invalid`, `media_flag_invalid`, `media_store_invalid`).
`MEDIA_R2_ACCESS_KEY_ID` and `MEDIA_R2_SECRET_ACCESS_KEY` are forbidden on the worker
(`forbiddenCredentials.worker` in server/config-rules.ts, critic R36). `.railway/railway.ts` declares the kiosk's
variables on web only (KIOSK-OPS-1). The two switches are `preserve()` on staging and `"false"` in
production until the steps of [LAUNCH_HANDOFF.md](LAUNCH_HANDOFF.md) 1.16a pass in their order
(R44a, `PAYMENTS_PROVIDERS` on the production worker, the media bucket, the field checks, R44b;
LD-96); switching production on is one reviewed change there plus a deploy (RUNBOOK "Kiosk
self-checkout and menu photos"). After it, the immediate stop is «Cobro en el kiosco» = «Solo en
caja» in Configuración (RUNBOOK "Kill switch").
`MEDIA_STORE` and `MEDIA_R2_*` are `preserve()` in both environments, and `MEDIA_FS_ROOT` is never
declared.

## 9. Data, retention and export

039 adds `kiosk_settings`, `kiosk_stations`, `kiosk_devices`, `kiosk_checkouts`, `menu_media`,
`menu_suggestions` (FORCE RLS; no DELETE grant on any; identities immutable by trigger),
`public_links.station_id` and `public_order_holds.decision_source` (`staff` | `kiosk`), and lets a
kiosk hold be dine-in without a table ("Comer aquí" on the KDS, the kitchen ticket, Órdenes, the
order detail and the orders CSV; its own `eat_in` row in Finanzas › Por tipo de servicio). Owner export
labels all six tables; device hashes are excluded by the column rule. Retention blanks
`kiosk_checkouts.loyalty_member_id` after 30 days; media rows are kept, objects purged 7 days after
removal.

## 10. Reports

Finanzas › Kiosco: kiosk orders, paid at the kiosk vs at the counter, charges approved without an
order («Cobros por resolver», «Cobros resueltos», and of those «Reembolsados en el proveedor» with
the «Importe reembolsado»), and suggestion lines accepted with their amount.

- «Pedidos del kiosco»: kiosk orders with a total above zero, by the order's business date, as
  Por canal counts them.
- «Pagados en el kiosco» and «Pagados en caja» count by payment, never by who accepted the hold
  (KIOSK-OPS-3). An order with a tender from a kiosk card charge (attempt target `kiosk_hold`)
  was paid at the kiosk. An order with any other tender (cash, a manual or POS terminal) was
  paid at the counter. An order paid partly each way («Aceptar con el pago del kiosco» with a
  rest) counts in both. An order accepted and never collected, or voided unpaid, counts in
  neither.

The corte's "Del kiosco" sub-line is payments' per-terminal split. It counts every non-cash tender
of a kiosk order in that drawer, including a card taken at the counter for a kiosk order. So it
can be larger than the kiosk's own card charges.

## 11. Troubleshooting

| Symptom | Check |
|---|---|
| The kiosk only offers "Pagar en caja" | Tablet paired (Configuración shows "Tableta vinculada"), the receiving till's drawer open, a terminal on the station, the provider connected, "Cobro en el kiosco" not "Solo en caja", `KIOSK_SELF_CHECKOUT_ENABLED`. |
| "La terminal está ocupada" | Another charge is live on that reader (another kiosk or the POS). Wait, or a manager cancels it. |
| A red card "pagó … y no se pudo enviar a cocina" | Resolver cobro del kiosco: retry once the product is back; or a manager accepts with the kiosk payment (collecting any rest); or refunds the whole charge in the provider app and chooses «Rechazar y reembolsar». |
| "Sin señal desde las …" | The tablet is off, unpinned, asleep or offline. |
| Photos do not show | `MEDIA_STORE` and its credentials; `MENU_PHOTOS_ENABLED`; the media route's 503 means the store is down (the menu falls back to text tiles). |
