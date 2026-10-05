/**
 * Per-line cart pricing for QR/kiosk ordering. Since service's merge this is
 * service's `priceCart` (shared/service.ts, wave contract 4.8): one bad line
 * never blanks the whole cart (OWNER-6). Selling imports it from there.
 */
export { priceCart, type CartLine } from "../../../shared/service";

/** Codes a catalog refresh can fix: refetch after the server returns one. */
export const CATALOG_ERRORS = new Set([
  "unavailable",
  "invalid_modifier",
  "required_modifier",
  "open_amount_exceeds",
]);
