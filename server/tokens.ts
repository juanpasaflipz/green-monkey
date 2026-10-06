/**
 * Purpose-bound, expiring tokens (contract C-6). A sealed token verifies only through
 * unseal(samePurpose): its MAC key is HKDF(info = "seal:" + purpose), distinct from
 * sign()'s "sign", so it is never a valid cookie and one purpose never opens another.
 * Registered purposes (platform spec C-6; a new purpose is a new string, never reused):
 * "cfdi-portal" (TTL CFDI_INVOICE_LINK_EXPIRY_HOURS × 3600) and "cfdi-portal-file" (900 s).
 * Web only: the worker never reaches this module (tests/import-graph.test.ts).
 */
import { signToken, verifyToken } from "./keyring.js";
import { DomainError } from "../shared/domain.js";

const PURPOSE = /^[a-z][a-z0-9-]{1,40}$/;
export const MAX_SEAL_SECONDS = 31 * 86400;

/** A token only unseal(purpose, …) accepts, valid for ttlSeconds (1 s to 31 days). */
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
