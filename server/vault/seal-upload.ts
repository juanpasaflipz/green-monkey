/**
 * Web-side sealing of an upload box to a worker's published X25519 key (JWE ECDH-ES + A256GCM).
 * Needs only the public JWK, so the web may import it (tests/import-graph.test.ts); the worker
 * opens the box with server/vault/vault.ts after checking the {typ, tid, pur, rid} binding.
 */
import { createPublicKey, type KeyObject } from "node:crypto";
import { CompactEncrypt } from "jose";

/** Protected-header typ of a payments credentials upload box (server/vault/vault.ts opens it). */
export const PAYMENTS_UPLOAD_TYP = "gm-payments-upload";

/** Thrown when the published key cannot be used; the caller maps it to its area's 503/409. */
export class UploadKeyError extends Error {
  constructor() {
    super("upload_key_invalid");
    this.name = "UploadKeyError";
  }
}

export async function sealUpload(
  pub: { kid: string; jwk: JsonWebKey },
  plaintext: string,
  b: { typ: string; tenantId: string; purpose: string; id: string },
): Promise<string> {
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: pub.jwk as never, format: "jwk" });
  } catch {
    throw new UploadKeyError();
  }
  return new CompactEncrypt(new TextEncoder().encode(plaintext))
    .setProtectedHeader({
      alg: "ECDH-ES",
      enc: "A256GCM",
      kid: pub.kid,
      typ: b.typ,
      tid: b.tenantId,
      pur: b.purpose,
      rid: b.id,
    })
    .encrypt(publicKey);
}
