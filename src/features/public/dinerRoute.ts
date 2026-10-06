import { PUBLIC_TOKEN } from "../../../shared/public-ordering";

/** Account's platform privacy notice, diners' section (shared/legal/privacy.ts #restaurantes). */
export const PLATFORM_PRIVACY_PATH = "/legal/privacidad#restaurantes";

export type DinerLocation = {
  channel: "qr" | "kiosk";
  /** null when the fragment is missing or not a well-formed token. */
  token: string | null;
  /** A 24 h-era signed link (/qr/<signed>, /kiosk/<signed>): never sent to the API. */
  legacy: boolean;
};

/**
 * Where a diner page is: `/qr#<token>` or `/kiosk#<token>` (optional trailing
 * slash). The token lives only in the fragment, so it never reaches a request
 * line, a Referer or an edge log. Pure; the only place that parses the URL, so
 * switching to path tokens (R5) is a change here.
 */
export function parseDinerLocation(loc: {
  pathname: string;
  hash: string;
}): DinerLocation {
  const m = /^\/(qr|kiosk)(\/.*)?$/.exec(loc.pathname);
  const channel = m?.[1] === "kiosk" ? "kiosk" : "qr";
  const rest = m?.[2] ?? "";
  if (rest && rest !== "/") return { channel, token: null, legacy: true };
  const raw = loc.hash.replace(/^#/, "");
  return {
    channel,
    token: PUBLIC_TOKEN.test(raw) ? raw : null,
    legacy: false,
  };
}
