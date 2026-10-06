/**
 * Landing-page claims that depend on features still being verified (account
 * 031, FOH-14 truth pass). Service (FOH-1/FIT-2) flips kitchenNotes when line
 * notes reach the KDS and are browser-verified; that restores the note
 * examples and the "notas" claim. QR/kiosk claims follow the runtime
 * /api/account-config publicOrdering.enabled instead (PUBLIC_ORDERING_ENABLED).
 */
export const LANDING_CLAIMS = { kitchenNotes: false } as const;
