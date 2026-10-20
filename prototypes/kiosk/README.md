# Green Monkey kiosk — design foundation

An isolated, working prototype of the approved food-led concept. Run from the repository root:

```sh
python3 -m http.server 5191 --bind 127.0.0.1 --directory prototypes/kiosk
```

Open http://127.0.0.1:5191. Check the interaction flow with `node prototypes/kiosk/check.mjs` while the server is running.

## Design decisions

- Existing Green Monkey logo, forest green, warm ivory, and a restrained lime accent.
- **Personalizar apariencia**, outside the guest interface, previews four curated palettes and three font pairings. Save persists only the palette/font identifiers in this browser; discard restores the saved choice, and restore-default previews the original Green Monkey style. This is not an authenticated tenant setting. The logo and food images retain their original colors. No arbitrary CSS, external font URLs, or uploads are accepted.
- Expressive serif emphasis paired with Inter for controls and prices.
- Food photography leads the menu; the cart stays visible on landscape kiosks.
- Category browsing, dining mode, customization, quantities, edit/remove, order review, and an adjacent-terminal payment screen.
- Optional first name/nickname on review, with an in-page touch keyboard that opens on focus (physical typing also works). The name survives edits and payment retries, appears on confirmation, and clears for the next guest. Empty names fall back to the order number. All name data stays in memory; production integration must pass it to the kitchen and pickup display with the order.
- A separate, labeled simulation bar controls payment outcomes. Declined/cancelled payments retain the order. An uncertain result blocks retry and starting over until an explicit simulated outcome arrives.
- Native modal dialogs, visible keyboard focus, semantic controls, responsive layouts, and reduced-motion support.

This prototype does not call APIs, charge terminals, send kitchen orders, persist customer details, or replace `/kiosk`. Menu data, images, and order number are illustrative. Spanish is the initial prototype language. MP, Clip, and Stripe share the same guest-facing terminal instruction; provider routing belongs to the integration layer.

## Production integration boundary

The current public kiosk in `src/features/public/DinerApp.tsx` submits order holds; `KioskDone.tsx` still instructs guests to visit the counter. The staff terminal flow in `src/features/payments/useTerminalCharge.ts` requires an authenticated staff session and an order ID. It provides idempotent initiation, persisted live attempts, synchronization, and settlement callbacks. Do not expose staff credentials in the public kiosk or merely relabel a submitted hold as paid.

Before production release, add server-authorized kiosk-to-terminal binding and hold/order creation, then connect authoritative charge states and settlement to kitchen dispatch. Reuse existing money/idempotency protections. Add kiosk-specific reload recovery, inactivity handling that never clears a live charge, terminal unavailability, stock/price changes, locale support, and verified restaurant image/ingredient data. Test real hardware reach and payment cancellation behavior. The browser prototype's simulator is not a payment implementation.

Tenant appearance integration should persist versioned, allowlisted `palette` and `font` identifiers under the authenticated restaurant, editable only by its owner. Return the published configuration with the public menu; never infer tenant identity from browser storage. Provide draft preview and explicit publish, audit changes, and keep an active guest session on its initial theme until it resets. Existing restaurants default to `forest` / `signature`. Keep pricing, payment states, sizing, and accessibility behavior outside the theme settings. Test tenant isolation and concurrent updates before enabling publication. Custom color/font uploads can follow separately with validation and licensed font handling.

## Assets

`assets/green-monkey.png` is a copy of the existing approved brand asset. Inter is locally bundled with its license. `assets/menu-photos.png` was generated with the built-in image generation tool for illustrative use and is displayed as four CSS backgrounds without editing the source image. The generation prompt is in `assets/menu-photos-prompt.txt`. Replace it with actual restaurant photography for production.

The standalone files make the design reviewable without changing live ordering behavior. The next integration should translate these screens into the existing React components, keeping server state authoritative.
