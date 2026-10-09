/**
 * Generalized credential vault (payments spec §9.1; CFDI spec §4.5 is its first user). Worker and
 * operator scripts only: the web process never holds CREDENTIAL_ENCRYPTION_KEY (Wave 2.0 (d)
 * refuses it there) and never imports this module (tests/import-graph.test.ts).
 *
 * CREDENTIAL_ENCRYPTION_KEY = "kid:secret[,kid:secret…]" (server/cfdi/config.ts
 * parseCredentialKeyring): the first entry seals, every entry opens. One keyring serves every
 * area, so there is one key to rotate (`npm run vault:rekey`).
 *
 * Each area's vault derives two keys per entry with HKDF-SHA256 under its own salt:
 *   - `secretInfo`: the 32-byte JWE `dir` key that seals the area's secrets at rest;
 *   - `uploadInfo`: an X25519 private scalar. Its public JWK is published in the area's platform
 *     row, and the web seals each upload box to it (JWE ECDH-ES + A256GCM,
 *     server/vault/seal-upload.ts), so the plaintext never rests in clear and only the worker can
 *     open it.
 *
 * Every JWE carries a protected header binding it to {typ, tid, pur, rid} (area type, tenant,
 * purpose, row id). AES-GCM authenticates the protected header, so a ciphertext copied to another
 * tenant, row, purpose or area fails to open (<area>_vault_binding). Domain separation between
 * areas comes from the salt plus the typ binding: a payments ciphertext never opens as CFDI and
 * vice versa (tests/vault.test.ts).
 */
import {
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  type KeyObject,
} from "node:crypto";
import { CompactEncrypt, compactDecrypt, decodeProtectedHeader } from "jose";
import type { Keyring } from "../cfdi/config.js";

/** A vault failure; `code` names the problem, never a value. */
export class VaultError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "VaultError";
  }
}

/** PKCS#8 DER prefix of an X25519 private key (RFC 8410): the 32-byte scalar follows. */
const X25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b656e04220420",
  "hex",
);

export type VaultOptions<P extends string> = {
  /** HKDF salt, e.g. "green-monkey/cfdi". */
  salt: string;
  /** HKDF info of the at-rest dir key. */
  secretInfo: string;
  /** HKDF info of the upload X25519 scalar. */
  uploadInfo: string;
  /** Protected-header typ of at-rest secrets. */
  secretTyp: string;
  /** Protected-header typ of upload boxes. */
  uploadTyp: string;
  /** The purpose an upload box is bound to. */
  uploadPurpose: string;
  /** Error code prefix: "<prefix>_unknown_kid", "_binding", "_malformed". */
  codePrefix: string;
  /** Typing aid only: the at-rest purposes of this area. */
  purposes?: readonly P[];
};

export type Vault<P extends string> = {
  sealSecret(
    ring: Keyring,
    plaintext: string,
    b: { tenantId: string; purpose: P; id: string },
  ): Promise<{ jwe: string; kid: string }>;
  openSecret(
    ring: Keyring,
    jwe: string,
    b: { tenantId: string; purpose: P; id: string },
  ): Promise<string>;
  uploadKeyPair(
    ring: Keyring,
    kid?: string,
  ): { privateKey: KeyObject; publicJwk: JsonWebKey };
  /** Opens an upload box and returns its plaintext bytes (the caller parses them). */
  openUpload(
    ring: Keyring,
    jwe: string,
    b: { tenantId: string; id: string },
  ): Promise<Uint8Array>;
  /** The kid in a JWE's protected header ("" when absent). */
  kidOf(jwe: string): string;
  error(code: "unknown_kid" | "binding" | "malformed"): VaultError;
};

export function createVault<P extends string>(o: VaultOptions<P>): Vault<P> {
  const fail = (code: "unknown_kid" | "binding" | "malformed") =>
    new VaultError(`${o.codePrefix}_${code}`);
  const derive = (ring: Keyring, kid: string, info: string): Buffer => {
    const secret = ring.secrets.get(kid);
    if (!secret) throw fail("unknown_kid");
    return Buffer.from(hkdfSync("sha256", secret, o.salt, info, 32));
  };
  const headerOf = (jwe: string): Record<string, unknown> => {
    try {
      return decodeProtectedHeader(jwe) as Record<string, unknown>;
    } catch {
      throw fail("malformed");
    }
  };
  const checkBinding = (
    header: Record<string, unknown>,
    b: { tenantId: string; purpose: string; id: string },
    typ: string,
  ) => {
    if (
      header.typ !== typ ||
      header.tid !== b.tenantId ||
      header.pur !== b.purpose ||
      header.rid !== b.id
    )
      throw fail("binding");
  };
  const uploadKeyPair = (ring: Keyring, kid: string = ring.active) => {
    const scalar = derive(ring, kid, o.uploadInfo);
    const privateKey = createPrivateKey({
      key: Buffer.concat([X25519_PKCS8_PREFIX, scalar]),
      format: "der",
      type: "pkcs8",
    });
    const jwk = createPublicKey(privateKey).export({ format: "jwk" });
    return {
      privateKey,
      publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x } as JsonWebKey,
    };
  };
  return {
    async sealSecret(ring, plaintext, b) {
      const kid = ring.active;
      const key = derive(ring, kid, o.secretInfo);
      const jwe = await new CompactEncrypt(new TextEncoder().encode(plaintext))
        .setProtectedHeader({
          alg: "dir",
          enc: "A256GCM",
          kid,
          typ: o.secretTyp,
          tid: b.tenantId,
          pur: b.purpose,
          rid: b.id,
        })
        .encrypt(key);
      return { jwe, kid };
    },
    async openSecret(ring, jwe, b) {
      const header = headerOf(jwe);
      const kid = typeof header.kid === "string" ? header.kid : "";
      if (!ring.secrets.has(kid)) throw fail("unknown_kid");
      checkBinding(header, b, o.secretTyp);
      try {
        const { plaintext } = await compactDecrypt(
          jwe,
          derive(ring, kid, o.secretInfo),
          {
            keyManagementAlgorithms: ["dir"],
            contentEncryptionAlgorithms: ["A256GCM"],
          },
        );
        return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      } catch {
        throw fail("binding");
      }
    },
    uploadKeyPair,
    async openUpload(ring, jwe, b) {
      const header = headerOf(jwe);
      const kid = typeof header.kid === "string" ? header.kid : "";
      if (!ring.secrets.has(kid)) throw fail("unknown_kid");
      checkBinding(header, { ...b, purpose: o.uploadPurpose }, o.uploadTyp);
      try {
        const { plaintext } = await compactDecrypt(
          jwe,
          uploadKeyPair(ring, kid).privateKey,
          {
            keyManagementAlgorithms: ["ECDH-ES"],
            contentEncryptionAlgorithms: ["A256GCM"],
          },
        );
        return plaintext;
      } catch {
        throw fail("binding");
      }
    },
    kidOf(jwe) {
      const header = headerOf(jwe);
      return typeof header.kid === "string" ? header.kid : "";
    },
    error: fail,
  };
}

/** The payments area's vault (spec §9.1). Purposes match 037's payment_secrets.purpose. */
export type PaymentSecretPurpose = "mp_credentials" | "clip_credentials";
export const PAYMENTS_UPLOAD_TYP = "gm-payments-upload";
export const paymentsVault = createVault<PaymentSecretPurpose>({
  salt: "green-monkey/payments",
  secretInfo: "secret-a256gcm",
  uploadInfo: "upload-x25519",
  secretTyp: "gm-payments-secret",
  uploadTyp: PAYMENTS_UPLOAD_TYP,
  uploadPurpose: "credentials_upload",
  codePrefix: "payments_vault",
});
