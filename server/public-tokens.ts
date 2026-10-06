// Public ordering link tokens (032): generation, hashing and the tenant-free
// lookup through the public_link_lookup policy. Web process only.
import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";
import type { Tx } from "./db.js";
import { DomainError } from "../shared/domain.js";
import { PUBLIC_TOKEN } from "../shared/public-ordering.js";

/** 16 CSPRNG bytes, base64url: 22 characters, 128 bits. */
export const newPublicToken = () => randomBytes(16).toString("base64url");
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
/**
 * SHA-256 with a domain prefix, not an HMAC: the 128-bit token makes preimage
 * search infeasible, and without a server secret a SIGNING_KEYS or JWT_SECRET
 * rotation never kills a printed QR code.
 */
export const linkHash = (token: string) => sha("gm-public-link-v1:" + token);
export const statusHash = (key: string) => sha("gm-public-status-v1:" + key);
/** Non-secret 4-character reference shown to staff ("Ref. 7A3F"). */
export const linkRef = (tokenHash: string) =>
  tokenHash.slice(0, 4).toUpperCase();

export type ResolvedLink = { tenantId: string; linkId: string };
const CACHE_MAX = 5000,
  CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, ResolvedLink & { at: number }>();

async function lookup(
  sql: postgres.Sql,
  token: string,
  activeOnly: boolean,
): Promise<ResolvedLink | null> {
  if (!PUBLIC_TOKEN.test(token)) return null;
  const h = linkHash(token);
  // set_config(..., true) is transaction-local: the pooled connection keeps
  // no lookup setting after this short read-only transaction.
  const row = (await sql.begin(async (raw) => {
    const tx = raw as Tx;
    await tx`select set_config('app.public_link_hash', ${h}, true)`;
    const [r] = activeOnly
      ? await tx`select tenant_id, id from public_links where token_hash = ${h} and revoked_at is null`
      : await tx`select tenant_id, id from public_links where token_hash = ${h}`;
    return r;
  })) as { tenant_id: string; id: string } | undefined;
  return row ? { tenantId: row.tenant_id, linkId: row.id } : null;
}

/**
 * The tenant of an active link token. Malformed tokens are refused before any
 * database work. Positive results are cached for 5 minutes: the cache never
 * extends a link's validity, because every tenant transaction re-reads the
 * row and checks revoked_at (linkContext). Revoked and unknown tokens are not
 * cached.
 */
export async function resolveLink(
  sql: postgres.Sql,
  token: string,
): Promise<ResolvedLink> {
  if (!PUBLIC_TOKEN.test(token))
    throw new DomainError("public_link_invalid", 404);
  const h = linkHash(token);
  const hit = cache.get(h);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS)
    return { tenantId: hit.tenantId, linkId: hit.linkId };
  const found = await lookup(sql, token, true);
  if (!found) throw new DomainError("public_link_invalid", 404);
  cache.delete(h);
  cache.set(h, { ...found, at: Date.now() });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return found;
}

/**
 * Status and cancel lookups must keep working for holds of a replaced or
 * deactivated link: no revoked filter and no cache.
 */
export async function resolveAnyLink(
  sql: postgres.Sql,
  token: string,
): Promise<ResolvedLink> {
  const found = await lookup(sql, token, false);
  if (!found) throw new DomainError("public_link_invalid", 404);
  return found;
}

/**
 * Drops a revoked or replaced link from this process's cache (best effort and
 * idempotent, so it is safe inside a replayed tenant() body, wave rule 0.7).
 */
export function forgetLinkHash(tokenHash: string): void {
  cache.delete(tokenHash);
}
