/**
 * Signing keyring (OPS-10, Wave 2.0 (g)). Tokens are
 * "v2.<kid>.<base64url(JSON)>.<base64url(HMAC-SHA256(key(kid, use), "v2.<kid>.<body>"))>",
 * where key(kid, use) = HKDF-SHA256(secret of kid, salt, info = use): "sign" for
 * cookies and links (server/auth.ts), "seal:<purpose>" for sealed tokens
 * (server/tokens.ts). SIGNING_KEYS = "kid:base64url(>=32 bytes)[,kid:secret...]":
 * the first key signs and every listed key verifies (rotation: docs/RUNBOOK.md
 * "Signing keys").
 *
 * Without SIGNING_KEYS (development, test, and staging until its cutover) one key is
 * derived from JWT_SECRET under the reserved kid "jwt". Legacy acceptance: while
 * JWT_SECRET is set, the pre-2.0 two-part "body.sig" format and "v2.jwt.*" tokens verify
 * for use "sign" only, and never in production (LD-8 D5: none were ever issued there),
 * so a leaked JWT_SECRET never mints a sealed token (P-23).
 *
 * Imports node:crypto and the pure production predicate only, and reads process.env
 * lazily at first use, so server/config-rules.ts can parse with it and tests can reset
 * it. Imported by the web and (through server/auth.ts) the worker, which never calls it.
 */
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { isProductionEnv } from "./production.js";

export interface SigningKey {
  kid: string;
  secret: Buffer;
}
/** keyring()[0] signs; every entry verifies. */
export type Keyring = readonly SigningKey[];
/** Reserved kid derived from JWT_SECRET when SIGNING_KEYS is unset (development, test, staging only). */
export const FALLBACK_KID = "jwt";
const KID = /^[a-z0-9-]{1,32}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const SALT = "green-monkey/token/v2";

export class KeyringError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "KeyringError";
  }
}

/** SIGNING_KEYS = "kid:base64url(>=32 bytes)[,kid:secret...]": 1-5 entries, unique kids, "jwt" reserved. */
export function parseSigningKeys(value: string): Keyring {
  const entries = value
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length < 1 || entries.length > 5)
    throw new KeyringError("invalid_signing_keys");
  const seen = new Set<string>();
  return entries.map((entry) => {
    const i = entry.indexOf(":");
    const kid = i > 0 ? entry.slice(0, i) : "";
    const raw = i > 0 ? entry.slice(i + 1) : "";
    if (
      !KID.test(kid) ||
      kid === FALLBACK_KID ||
      seen.has(kid) ||
      !B64URL.test(raw)
    )
      throw new KeyringError("invalid_signing_keys");
    const secret = Buffer.from(raw, "base64url");
    if (secret.length < 32) throw new KeyringError("invalid_signing_keys");
    seen.add(kid);
    return { kid, secret };
  });
}

const jwtSecret = () =>
  process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32
    ? process.env.JWT_SECRET
    : null;
const fallbackSecret = (jwt: string) =>
  createHash("sha256")
    .update("gm-keyring-fallback-v1:" + jwt)
    .digest();

let ring: Keyring | null = null;
const derived = new Map<string, Buffer>();

/** SIGNING_KEYS, else one key derived from JWT_SECRET (never in production). */
export function keyring(): Keyring {
  if (ring) return ring;
  if (process.env.SIGNING_KEYS)
    return (ring = parseSigningKeys(process.env.SIGNING_KEYS));
  // Config refuses a production web without SIGNING_KEYS; this keeps any other
  // production code path from minting v2.jwt.* tokens (LD-8 D5).
  if (isProductionEnv()) throw new KeyringError("signing_keys_required");
  const jwt = jwtSecret();
  if (!jwt) throw new KeyringError("signing_keys_required");
  return (ring = [{ kid: FALLBACK_KID, secret: fallbackSecret(jwt) }]);
}

/** Test hook. */
export function resetKeyring(): void {
  ring = null;
  derived.clear();
}

/**
 * HMAC key for (kid, use): HKDF-SHA256(secret, salt, info = use). Outside the ring
 * (SIGNING_KEYS set), the fallback kid is legacy acceptance only: use "sign", only while
 * JWT_SECRET is set, and never in production (LD-8 D5). A leaked JWT_SECRET therefore
 * never mints a sealed token where SIGNING_KEYS is set (P-23). Unknown kids return before
 * anything is cached, so the cache is bounded by the ring and the uses in the code.
 */
function macKey(kid: string, use: string): Buffer | null {
  const listed = keyring().find((k) => k.kid === kid);
  if (!listed && (kid !== FALLBACK_KID || use !== "sign" || isProductionEnv()))
    return null;
  const cacheKey = kid + "\u0000" + use;
  const hit = derived.get(cacheKey);
  if (hit) return hit;
  let secret = listed?.secret ?? null;
  if (!secret) {
    const jwt = jwtSecret();
    secret = jwt ? fallbackSecret(jwt) : null;
  }
  if (!secret) return null;
  const key = Buffer.from(hkdfSync("sha256", secret, SALT, use, 32));
  derived.set(cacheKey, key);
  return key;
}

/** Exactly what Buffer#toString("base64url") writes: no padding, no other characters, no stray low bits. */
const canonical = (s: string) =>
  s.length > 0 &&
  B64URL.test(s) &&
  Buffer.from(s, "base64url").toString("base64url") === s;

/** "v2.<kid>.<base64url(JSON)>.<base64url(HMAC-SHA256(key(kid,use), "v2.<kid>.<body>"))>" */
export function signToken(use: string, data: unknown): string {
  const { kid } = keyring()[0];
  const body = Buffer.from(JSON.stringify(data)).toString("base64url");
  const mac = createHmac("sha256", macKey(kid, use)!)
    .update(`v2.${kid}.${body}`)
    .digest("base64url");
  return `v2.${kid}.${body}.${mac}`;
}

/**
 * The parsed body, or null. With legacy, a two-part "body.sig" under JWT_SECRET verifies
 * while it is set, outside production (LD-8 D5). Exactly one spelling per token is
 * accepted (P-22, MENU-R3): the part count is exact, and the body and the signature must
 * be canonical base64url, because Buffer.from(…, "base64url") silently skips "=", "!",
 * whitespace and the unused low bits of the last character.
 */
export function verifyToken(
  use: string,
  value: string,
  o: { legacy: boolean },
): unknown | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  const parts = value.split(".");
  let body: string, sig: string, expected: Buffer;
  if (parts.length === 4 && parts[0] === "v2" && KID.test(parts[1])) {
    const key = macKey(parts[1], use);
    if (!key) return null;
    [, , body, sig] = parts;
    expected = createHmac("sha256", key)
      .update(`v2.${parts[1]}.${body}`)
      .digest();
  } else if (
    o.legacy &&
    parts.length === 2 &&
    jwtSecret() &&
    !isProductionEnv()
  ) {
    [body, sig] = parts;
    expected = createHmac("sha256", jwtSecret()!).update(body).digest();
  } else return null;
  if (!canonical(body) || !canonical(sig)) return null;
  const supplied = Buffer.from(sig, "base64url");
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  )
    return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
}
