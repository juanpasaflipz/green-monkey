/**
 * Credential vault of the cfdi worker (spec §4.5): the CFDI instance of the generalized vault
 * (server/vault/vault.ts, payments spec §9.1). Worker and operator scripts only: the web process
 * never holds CREDENTIAL_ENCRYPTION_KEY (Wave 2.0 (d) refuses it there) and never imports this
 * module (tests/import-graph.test.ts).
 *
 * CREDENTIAL_ENCRYPTION_KEY = "kid:secret[,kid:secret…]": kid matches ^[a-z0-9-]{1,32}$, secret is
 * base64url decoding to ≥ 32 bytes; the first entry seals, every entry opens (rotation:
 * docs/CFDI.md, `npm run vault:rekey`). Generate one with scripts/cfdi-generate-credential-key.mjs.
 *
 * Two derived keys per entry (HKDF-SHA256, salt "green-monkey/cfdi"), unchanged by the
 * generalization so every existing cfdi_secrets row opens as before:
 *   - "secret-a256gcm": the 32-byte JWE `dir` key that seals organization keys at rest
 *     (cfdi_secrets purposes org_test_key / org_live_key);
 *   - "csd-upload-x25519": an X25519 private scalar. Its public JWK is published in cfdi_platform,
 *     and the web seals each CSD upload box to it (JWE ECDH-ES + A256GCM, server/cfdi/csd.ts), so
 *     the .key bytes and its password never rest in clear and only the worker can open them.
 *
 * Every JWE carries a protected header binding it to {typ, tid, pur, rid} (gm-cfdi-secret or
 * gm-cfdi-csd, tenant, purpose, row id). AES-GCM authenticates the protected header, so a
 * ciphertext copied to another tenant, row, purpose or area fails to open (cfdi_vault_binding).
 */
import type { KeyObject } from "node:crypto";
import { parseCredentialKeyring, type Keyring } from "./config.js";
import { createVault, VaultError } from "../vault/vault.js";

export { parseCredentialKeyring, type Keyring, VaultError };

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

export const UPLOAD_TYP = "gm-cfdi-csd";
const cfdiVault = createVault<SecretPurpose>({
  salt: "green-monkey/cfdi",
  secretInfo: "secret-a256gcm",
  uploadInfo: "csd-upload-x25519",
  secretTyp: "gm-cfdi-secret",
  uploadTyp: UPLOAD_TYP,
  uploadPurpose: "csd_upload",
  codePrefix: "cfdi_vault",
});

/** Seals a short secret (an organization API key) under the active kid, bound to its row. */
export function sealSecret(
  ring: Keyring,
  plaintext: string,
  b: SecretBinding,
): Promise<{ jwe: string; kid: string }> {
  return cfdiVault.sealSecret(ring, plaintext, b);
}

/** Opens a sealed secret; the kid comes from its header and the binding must match the row. */
export function openSecret(
  ring: Keyring,
  jwe: string,
  b: SecretBinding,
): Promise<string> {
  return cfdiVault.openSecret(ring, jwe, b);
}

/** The X25519 key pair the web seals CSD uploads to, derived for one kid. */
export function uploadKeyPair(
  ring: Keyring,
  kid: string = ring.active,
): { privateKey: KeyObject; publicJwk: JsonWebKey } {
  return cfdiVault.uploadKeyPair(ring, kid);
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
  const plaintext = await cfdiVault.openUpload(ring, jwe, b);
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
