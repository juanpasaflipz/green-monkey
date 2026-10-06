import { parseDinerLocation } from "./public/dinerRoute";
import { DinerApp } from "./public/DinerApp";
import { DinerNotice } from "./public/DinerNotice";

/**
 * Diner entry for /qr#<token> and /kiosk#<token>. A missing or malformed
 * fragment and every legacy signed path (/qr/<signed>) show "Este código ya
 * no funciona" without calling the API.
 */
export function PublicOrdering() {
  const r = parseDinerLocation(location);
  return r.legacy || !r.token ? (
    <DinerNotice kind="invalid" />
  ) : (
    <DinerApp channel={r.channel} token={r.token} />
  );
}
export default PublicOrdering;
