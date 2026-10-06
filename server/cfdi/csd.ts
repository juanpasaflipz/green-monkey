/**
 * CSD upload, web side (spec §4.6). Local checks run before anything leaves the web process, then
 * the files and password are sealed to the worker's published X25519 key (cfdi_platform) and
 * stored as a csd_upload box the runtime role can insert but never read. The password is never
 * stored; the worker opens the box once, sends it to Facturapi and wipes it.
 *
 * Certificate facts come from node:crypto (X509Certificate, createPrivateKey with the passphrase,
 * public-key comparison). Node does not expose the X.509 keyUsage extension (its `keyUsage` field
 * lists EXTENDED key usages), so the extension's BIT STRING is read from the DER directly.
 */
import {
  createPrivateKey,
  createPublicKey,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { CompactEncrypt } from "jose";
import { DomainError } from "../../shared/domain.js";
import { RFC_PATTERN } from "../../shared/sat.js";

export type CsdInspection = {
  rfc: string;
  serial: string;
  validFrom: string;
  validUntil: string;
  looksLikeFiel: boolean;
  /** False when this OpenSSL cannot decrypt the key's PBE scheme; Facturapi then decides. */
  passwordChecked: boolean;
};

/** Upper bound for each decoded file (12 KB). */
export const CSD_MAX_BYTES = 12 * 1024;

const fail = (code: string) => new DomainError(code, 400);

/** SAT encodes the certificate number as ASCII digits in the serial's hex ("3330…" → "30…"). */
export function satSerial(hex: string): string {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
  if (clean.length % 2 === 0 && /^(3[0-9])+$/.test(clean))
    return clean.replace(/3([0-9])/g, "$1");
  return clean.toUpperCase().slice(0, 64);
}

/** The RFC in subject x500UniqueIdentifier (OID 2.5.4.45): "RFC / CURP" → "RFC". */
function subjectRfc(cert: X509Certificate): string | null {
  for (const line of cert.subject.split("\n")) {
    const m = /^(?:x500UniqueIdentifier|2\.5\.4\.45|UID)=(.*)$/.exec(
      line.trim(),
    );
    if (!m) continue;
    const rfc = m[1].split("/")[0].trim().toUpperCase();
    if (RFC_PATTERN.test(rfc) || /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc))
      return rfc;
  }
  return null;
}

/**
 * The keyUsage bits (RFC 5280 §4.2.1.3) from the DER: OID 2.5.29.15 = 06 03 55 1D 0F, optional
 * critical BOOLEAN, then an OCTET STRING wrapping a BIT STRING. Null when absent or unreadable.
 */
export function keyUsageBits(der: Uint8Array): number | null {
  const oid = [0x06, 0x03, 0x55, 0x1d, 0x0f];
  outer: for (let i = 0; i + oid.length < der.length; i++) {
    for (let j = 0; j < oid.length; j++)
      if (der[i + j] !== oid[j]) continue outer;
    let p = i + oid.length;
    if (der[p] === 0x01 && der[p + 1] === 0x01) p += 3; // critical
    if (der[p] !== 0x04) return null;
    const octetLength = der[p + 1];
    if (octetLength > 0x7f) return null;
    p += 2;
    if (der[p] !== 0x03) return null;
    const bitLength = der[p + 1];
    if (bitLength < 2 || bitLength > 3) return null;
    // First content byte: unused bits; then 1-2 bytes, bit 0 (digitalSignature) = 0x80.
    const first = der[p + 3] ?? 0;
    const second = bitLength === 3 ? (der[p + 4] ?? 0) : 0;
    return (first << 8) | second;
  }
  return null;
}
const KEY_ENCIPHERMENT = 0x2000;
const DATA_ENCIPHERMENT = 0x1000;

function certificate(cer: Buffer): X509Certificate {
  try {
    return new X509Certificate(cer);
  } catch {
    throw fail("cfdi_csd_invalid");
  }
}

/**
 * Checks a CSD before upload (spec §4.6 steps 1-6); throws DomainError with the first problem:
 * cfdi_csd_invalid, cfdi_csd_not_yet_valid, cfdi_csd_expired, cfdi_csd_is_fiel,
 * cfdi_csd_password, cfdi_csd_key_mismatch.
 */
export function inspectCsd(
  f: { cer: Buffer; key: Buffer; password: string },
  now = new Date(),
): CsdInspection {
  if (
    !f.cer.length ||
    !f.key.length ||
    f.cer.length > CSD_MAX_BYTES ||
    f.key.length > CSD_MAX_BYTES
  )
    throw fail("cfdi_csd_invalid");
  const cert = certificate(f.cer);
  const rfc = subjectRfc(cert);
  if (!rfc) throw fail("cfdi_csd_invalid");
  const validFrom = new Date(cert.validFrom);
  const validUntil = new Date(cert.validTo);
  if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validUntil.getTime()))
    throw fail("cfdi_csd_invalid");
  if (now < validFrom) throw fail("cfdi_csd_not_yet_valid");
  if (now > validUntil) throw fail("cfdi_csd_expired");
  const usage = keyUsageBits(new Uint8Array(cert.raw));
  const looksLikeFiel =
    usage !== null && (usage & (KEY_ENCIPHERMENT | DATA_ENCIPHERMENT)) !== 0;
  if (looksLikeFiel) throw fail("cfdi_csd_is_fiel");

  let privateKey: KeyObject | null = null;
  let passwordChecked = true;
  try {
    privateKey = createPrivateKey({
      key: f.key,
      format: "der",
      type: "pkcs8",
      passphrase: f.password,
    });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const message = String(err.message ?? "").toLowerCase();
    if (
      err.code === "ERR_OSSL_EVP_UNSUPPORTED" ||
      message.includes("unsupported")
    )
      passwordChecked = false;
    else if (
      err.code === "ERR_OSSL_BAD_DECRYPT" ||
      message.includes("bad decrypt") ||
      message.includes("decrypt")
    )
      throw fail("cfdi_csd_password");
    else throw fail("cfdi_csd_invalid");
  }
  if (privateKey) {
    const fromKey = createPublicKey(privateKey).export({
      type: "spki",
      format: "der",
    });
    const fromCert = cert.publicKey.export({ type: "spki", format: "der" });
    if (!Buffer.from(fromKey).equals(Buffer.from(fromCert)))
      throw fail("cfdi_csd_key_mismatch");
  }
  return {
    rfc,
    serial: satSerial(cert.serialNumber),
    validFrom: validFrom.toISOString(),
    validUntil: validUntil.toISOString(),
    looksLikeFiel,
    passwordChecked,
  };
}

/**
 * Seals the upload box to the worker's published X25519 key (JWE ECDH-ES + A256GCM), bound to the
 * tenant and the csd_upload secret row (the worker checks the binding before opening).
 */
export async function sealCsdUpload(
  pub: { kid: string; jwk: JsonWebKey },
  bundle: { cer: Buffer; key: Buffer; password: string },
  b: { tenantId: string; id: string },
): Promise<string> {
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: pub.jwk as never, format: "jwk" });
  } catch {
    throw new DomainError("cfdi_unavailable", 409);
  }
  const plaintext = JSON.stringify({
    cer: bundle.cer.toString("base64"),
    key: bundle.key.toString("base64"),
    password: bundle.password,
  });
  return new CompactEncrypt(new TextEncoder().encode(plaintext))
    .setProtectedHeader({
      alg: "ECDH-ES",
      enc: "A256GCM",
      kid: pub.kid,
      typ: "gm-cfdi-csd",
      tid: b.tenantId,
      pur: "csd_upload",
      rid: b.id,
    })
    .encrypt(publicKey);
}
