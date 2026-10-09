/**
 * Purpose-bound, expiring tokens (contract C-6). A sealed token verifies only through
 * unseal(samePurpose): its MAC key is HKDF(info = "seal:" + purpose), distinct from
 * sign()'s "sign", so it is never a valid cookie and one purpose never opens another.
 * Registered purposes (platform spec C-6; a new purpose is a new string, never reused):
 * "cfdi-portal" (TTL CFDI_INVOICE_LINK_EXPIRY_HOURS × 3600) and "cfdi-portal-file" (900 s);
 * loyalty (038): "loyalty-join" {t, o} (the receipt's join QR, TTL link_window_days × 86400) and
 * "loyalty-member" {t, m, s} (the kiosk's member token bound to a station, 900 s).
 * Web only: the worker never reaches this module (tests/import-graph.test.ts).
 *
 * SIGNED, NOT ENCRYPTED (PLATFORM-KEYS-2). "Seal" here means tamper-evident and
 * purpose-bound, not confidential: the payload is base64url(JSON) in the clear, and anyone
 * holding the token (a printed QR code, a URL in browser history, a shared link) can read
 * it. Put only opaque ids in a payload (tenant, document or order uuids): never secrets,
 * personal data (RFC, name, email, phone), amounts or provider ids (Facturapi document
 * ids). This differs from cfdi's vault sealSecret / sealCsdUpload, which encrypt (JWE). If a
 * payload ever needs confidentiality, add a separate AEAD helper (AES-256-GCM, random
 * 96-bit nonce, kid and purpose as associated data); never overload seal().
 */
import { signToken, verifyToken } from "./keyring.js";
import { DomainError } from "../shared/domain.js";

const PURPOSE = /^[a-z][a-z0-9-]{1,40}$/;
export const MAX_SEAL_SECONDS = 31 * 86400;

/**
 * A token only unseal(purpose, …) accepts, valid for ttlSeconds (1 s to 31 days). The
 * payload is readable by whoever holds the token: opaque ids only (see the header).
 */
export function seal(
  purpose: string,
  payload: unknown,
  o: { ttlSeconds: number },
): string {
  if (!PURPOSE.test(purpose)) throw Error(`invalid seal purpose: ${purpose}`);
  if (
    !Number.isInteger(o.ttlSeconds) ||
    o.ttlSeconds < 1 ||
    o.ttlSeconds > MAX_SEAL_SECONDS
  )
    throw Error("seal ttlSeconds must be an integer from 1 to 2678400");
  const exp = Math.floor(Date.now() / 1000) + o.ttlSeconds;
  return signToken("seal:" + purpose, { p: purpose, exp, d: payload });
}

/** The payload, or DomainError("unauthorized", 401) for a bad, foreign-purpose or expired token. */
export function unseal<T = unknown>(purpose: string, token: string): T {
  const c = PURPOSE.test(purpose)
    ? (verifyToken("seal:" + purpose, token, { legacy: false }) as {
        p?: unknown;
        exp?: unknown;
        d?: unknown;
      } | null)
    : null;
  if (
    !c ||
    c.p !== purpose ||
    !Number.isInteger(c.exp) ||
    (c.exp as number) <= Math.floor(Date.now() / 1000)
  )
    throw new DomainError("unauthorized", 401);
  return c.d as T;
}

/**
 * unseal for tokens a person holds for days (loyalty's receipt join QR): a genuine token of this
 * purpose past its expiry throws DomainError(expiredCode, 410) so the page can say it expired;
 * anything else (forged, foreign purpose, malformed) is unseal's 401.
 */
export function unsealOrExpired<T = unknown>(
  purpose: string,
  token: string,
  expiredCode: string,
): T {
  const c = PURPOSE.test(purpose)
    ? (verifyToken("seal:" + purpose, token, { legacy: false }) as {
        p?: unknown;
        exp?: unknown;
        d?: unknown;
      } | null)
    : null;
  if (c && c.p === purpose && Number.isInteger(c.exp))
    if ((c.exp as number) <= Math.floor(Date.now() / 1000))
      throw new DomainError(expiredCode, 410);
  return unseal<T>(purpose, token);
}
