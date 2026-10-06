/**
 * Landing-page claims that depend on features being verified (account 031,
 * FOH-14 truth pass). kitchenNotes is on: service 024 shows order, round and
 * line notes with allergy emphasis on KDS tickets and printed comandas
 * (browser-tested in tests/browser/service.spec.ts "kitchen sees order, line
 * and round notes with modifiers" and kitchen.spec.ts; DELIVERY_STATUS rows
 * 24-26). Turn it off only if that evidence regresses. QR/kiosk claims follow
 * the runtime /api/account-config publicOrdering.enabled instead
 * (PUBLIC_ORDERING_ENABLED).
 */
export const LANDING_CLAIMS = { kitchenNotes: true } as const;
