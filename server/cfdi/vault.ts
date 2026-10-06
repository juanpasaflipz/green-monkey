/**
 * Credential vault of the cfdi worker (spec §4.5). Worker and operator scripts only: the web
 * process never holds CREDENTIAL_ENCRYPTION_KEY (Wave 2.0 (d) refuses it there) and never imports
 * this module (tests/import-graph.test.ts).
 *
 * CREDENTIAL_ENCRYPTION_KEY = "kid:secret[,kid:secret…]": kid matches ^[a-z0-9-]{1,32}$, secret is
 * base64url decoding to ≥ 32 bytes; the first entry seals, every entry opens (rotation:
 * docs/CFDI.md, `npm run cfdi:rekey`). Generate one with scripts/cfdi-generate-credential-key.mjs.
 *
 * Two derived keys per entry (HKDF-SHA256, salt "green-monkey/cfdi"):
 *   - "secret-a256gcm": the 32-byte JWE `dir` key that seals organization keys at rest
 *     (cfdi_secrets purposes org_test_key / org_live_key);
 *   - "csd-upload-x25519": an X25519 private scalar. Its public JWK is published in cfdi_platform,
 *     and the web seals each CSD upload box to it (JWE ECDH-ES + A256GCM, server/cfdi/csd.ts), so
 *     the .key bytes and its password never rest in clear and only the worker can open them.
 *
 * Every JWE carries a protected header binding it to {tid, pur, rid} (tenant, purpose, row id).
 * AES-GCM authenticates the protected header, so a ciphertext copied to another tenant, row or
 * purpose fails to open (cfdi_vault_binding).
 */
import {
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  type KeyObject,
} from "node:crypto";
import { CompactEncrypt, compactDecrypt, decodeProtectedHeader } from "jose";
import { parseCredentialKeyring, type Keyring } from "./config.js";

export { parseCredentialKeyring, type Keyring };

export type SecretPurpose = "csd_upload" | "org_test_key" | "org_live_key";
export type SecretBinding = {
  tenantId: string;
  purpose: SecretPurpose;
  id: string;
};
export type UploadBundle = {
  cer: Uint8Array;
  key: Uint8Array;
  password: string;
};

const SALT = "green-monkey/cfdi";
const SECRET_TYP = "gm-cfdi-secret";
export const UPLOAD_TYP = "gm-cfdi-csd";
/** PKCS#8 DER prefix of an X25519 private key (RFC 8410): the 32-byte scalar follows. */
const X25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b656e04220420",
  "hex",
);

/** A vault failure; `code` names the problem, never a value. */
export class VaultError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "VaultError";
  }
}

function derive(ring: Keyring, kid: string, info: string): Buffer {
  const secret = ring.secrets.get(kid);
  if (!secret) throw new VaultError("cfdi_vault_unknown_kid");
  return Buffer.from(hkdfSync("sha256", secret, SALT, info, 32));
}

function checkBinding(
  header: Record<string, unknown>,
  b: SecretBinding,
  typ: string,
) {
  if (
    header.typ !== typ ||
    header.tid !== b.tenantId ||
    header.pur !== b.purpose ||
    header.rid !== b.id
  )
    throw new VaultError("cfdi_vault_binding");
}

function headerOf(jwe: string): Record<string, unknown> {
  try {
    return decodeProtectedHeader(jwe) as Record<string, unknown>;
  } catch {
    throw new VaultError("cfdi_vault_malformed");
  }
}

/** Seals a short secret (an organization API key) under the active kid, bound to its row. */
export async function sealSecret(
  ring: Keyring,
  plaintext: string,
  b: SecretBinding,
): Promise<{ jwe: string; kid: string }> {
  const kid = ring.active;
  const key = derive(ring, kid, "secret-a256gcm");
  const jwe = await new CompactEncrypt(new TextEncoder().encode(plaintext))
    .setProtectedHeader({
      alg: "dir",
      enc: "A256GCM",
      kid,
      typ: SECRET_TYP,
      tid: b.tenantId,
      pur: b.purpose,
      rid: b.id,
    })
    .encrypt(key);
  return { jwe, kid };
}

/** Opens a sealed secret; the kid comes from its header and the binding must match the row. */
export async function openSecret(
  ring: Keyring,
  jwe: string,
  b: SecretBinding,
): Promise<string> {
  const header = headerOf(jwe);
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!ring.secrets.has(kid)) throw new VaultError("cfdi_vault_unknown_kid");
  checkBinding(header, b, SECRET_TYP);
  try {
    const { plaintext } = await compactDecrypt(
      jwe,
      derive(ring, kid, "secret-a256gcm"),
      {
        keyManagementAlgorithms: ["dir"],
        contentEncryptionAlgorithms: ["A256GCM"],
      },
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new VaultError("cfdi_vault_binding");
  }
}

/** The X25519 key pair the web seals CSD uploads to, derived for one kid. */
export function uploadKeyPair(
  ring: Keyring,
  kid: string = ring.active,
): { privateKey: KeyObject; publicJwk: JsonWebKey } {
  const scalar = derive(ring, kid, "csd-upload-x25519");
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, scalar]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  return {
    privateKey,
    publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
  };
}

/**
 * Opens a CSD upload box with the private key of the kid in its header and checks it was sealed
 * for this tenant and upload row. The returned bytes and password live only in the caller's
 * locals and are dropped after the upload call.
 */
export async function openUploadBox(
  ring: Keyring,
  jwe: string,
  b: { tenantId: string; id: string },
): Promise<UploadBundle> {
  const header = headerOf(jwe);
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!ring.secrets.has(kid)) throw new VaultError("cfdi_vault_unknown_kid");
  checkBinding(header, { ...b, purpose: "csd_upload" }, UPLOAD_TYP);
  let plaintext: Uint8Array;
  try {
    ({ plaintext } = await compactDecrypt(
      jwe,
      uploadKeyPair(ring, kid).privateKey,
      {
        keyManagementAlgorithms: ["ECDH-ES"],
        contentEncryptionAlgorithms: ["A256GCM"],
      },
    ));
  } catch {
    throw new VaultError("cfdi_vault_binding");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
  } catch {
    throw new VaultError("cfdi_vault_malformed");
  }
  const box = parsed as { cer?: unknown; key?: unknown; password?: unknown };
  if (
    typeof box.cer !== "string" ||
    typeof box.key !== "string" ||
    typeof box.password !== "string"
  )
    throw new VaultError("cfdi_vault_malformed");
  return {
    cer: new Uint8Array(Buffer.from(box.cer, "base64")),
    key: new Uint8Array(Buffer.from(box.key, "base64")),
    password: box.password,
  };
}
