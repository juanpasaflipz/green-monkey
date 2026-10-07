import { useEffect, useState } from "react";
import type { Locale } from "../../../shared/domain";
import { strings } from "../../i18n";
import { api } from "../../api";
import { Button } from "../../components/ui";

/**
 * Fired by account's AccountPrivacy after the restaurant's privacy notice URL
 * is saved or removed, so the warnings below follow it without a reload.
 */
export const RESTAURANT_PRIVACY_EVENT = "gm-restaurant-privacy";
/** The id of AccountPrivacy's URL field (Configuración → Privacidad y datos). */
export const RESTAURANT_PRIVACY_FIELD = "account-privacy-url";

/**
 * Whether the restaurant has no privacy notice of its own (account 031;
 * managers and owners can read it). False until known, when disabled, and
 * when the read fails: the warning is advice, never a gate.
 */
export function useRestaurantPrivacyMissing(enabled: boolean): boolean {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const read = () =>
      void api<{ privacyNoticeUrl: string | null }>(
        "/account/restaurant-privacy",
      ).then(
        (p) => live && setMissing(!p.privacyNoticeUrl),
        () => undefined,
      );
    read();
    window.addEventListener(RESTAURANT_PRIVACY_EVENT, read);
    return () => {
      live = false;
      window.removeEventListener(RESTAURANT_PRIVACY_EVENT, read);
    };
  }, [enabled]);
  return enabled && missing;
}

/**
 * Brings AccountPrivacy's URL field into view and focuses it once it is
 * rendered and enabled (right away in Configuración; after the view change
 * and the panel's own read when coming from Mesas). Gives up after about 5 s.
 */
export function focusRestaurantPrivacy(tries = 300) {
  const field = document.getElementById(RESTAURANT_PRIVACY_FIELD);
  if (field instanceof HTMLInputElement && !field.disabled) {
    field.scrollIntoView({ block: "center" });
    field.focus();
  } else if (tries > 0)
    requestAnimationFrame(() => focusRestaurantPrivacy(tries - 1));
}

/**
 * Under LFPDPPP the restaurant is the controller and must make its notice
 * available before diners type a name: with QR and kiosk ordering on for
 * every Pro restaurant (B4), the places where codes are created or printed
 * say so (PUBLIC-SECURITY-4, LD-41). Hiding the name field without a notice
 * is the lead's call (account.md), so this only warns.
 */
export function PrivacyNoticeWarning({
  locale,
  onOpen,
}: {
  locale: Locale;
  onOpen?: () => void;
}) {
  const t = strings[locale];
  return (
    <div className="warning-panel public-privacy-warning" role="note">
      <p>{t.publicPrivacyMissing}</p>
      {onOpen && (
        <Button onClick={onOpen}>{t.publicPrivacyMissingAction}</Button>
      )}
    </div>
  );
}
