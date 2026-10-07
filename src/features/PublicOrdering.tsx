import { useEffect, useState } from "react";
import { parseDinerLocation } from "./public/dinerRoute";
import { DinerApp } from "./public/DinerApp";
import { DinerNotice } from "./public/DinerNotice";

/**
 * Diner entry for /qr#<token> and /kiosk#<token>. A missing or malformed
 * fragment and every legacy signed path (/qr/<signed>) show "Este código ya
 * no funciona" without calling the API. A new fragment pasted into the same
 * tab is a same-document navigation: the page re-reads it and starts fresh
 * for the new code (UX-10).
 */
export function PublicOrdering() {
  const [r, setR] = useState(() => parseDinerLocation(location));
  useEffect(() => {
    const changed = () => setR(parseDinerLocation(location));
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  return r.legacy || !r.token ? (
    <DinerNotice kind="invalid" />
  ) : (
    <DinerApp key={r.channel + r.token} channel={r.channel} token={r.token} />
  );
}
export default PublicOrdering;
