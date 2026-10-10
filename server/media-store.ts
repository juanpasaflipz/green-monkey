// Menu media object store (039; specs/kiosk-w4.md §4.7, LD-88): a private Cloudflare R2 bucket in
// deployed environments, a local directory in development and CI. No SDK: R2 speaks the S3 API,
// and requests are signed with AWS Signature Version 4 by the small signer below (unit-tested
// against the AWS SigV4 test suite vectors, tests/media.test.ts). Web process only (critic R36:
// the worker never holds MEDIA_R2_*).
import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { mediaStoreConfig, type MediaStoreConfig } from "./kiosk-config.js";

export type MediaStore = {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** The object, or null when it does not exist. */
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
};

/** m/<tenantId>/<assetId>/<variant>.webp (§2.9): ids are server-generated uuids. */
export const KEY = /^m\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(thumb|card|hero)\.webp$/;
export const objectKey = (tenantId: string, assetId: string, variant: string) =>
  `m/${tenantId}/${assetId}/${variant}.webp`;
function checkKey(key: string) {
  if (!KEY.test(key)) throw Error("media_key_invalid");
}

// ---- AWS Signature Version 4 ------------------------------------------------------------------

const hex = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data).digest();
/** RFC 3986 unreserved characters stay; everything else is %XX (uppercase), as SigV4 requires. */
const encode = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );

export type SignInput = {
  method: string;
  /** Absolute path, already a valid URI path ("/bucket/m/…"); each segment is encoded once. */
  path: string;
  query?: Record<string, string>;
  /** Header names in any case; host is required. */
  headers: Record<string, string>;
  /** The payload's sha256 (hex); sha256("") for none. */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** YYYYMMDDTHHMMSSZ */
  amzDate: string;
};

/**
 * The SigV4 Authorization header (AWS docs "Create a signed AWS API request"): canonical request,
 * string to sign with the credential scope, and the signing key HMAC chain
 * kDate → kRegion → kService → kSigning. Headers are lower-cased, trimmed and sorted; the
 * canonical query sorts by encoded name.
 */
export function signV4(i: SignInput): {
  authorization: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
} {
  const date = i.amzDate.slice(0, 8);
  const headers = Object.entries(i.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = headers.map(([k]) => k).join(";");
  const canonicalHeaders = headers.map(([k, v]) => `${k}:${v}\n`).join("");
  const canonicalQuery = Object.entries(i.query ?? {})
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalPath =
    i.path
      .split("/")
      .map((seg) => encode(decodeURIComponent(seg)))
      .join("/") || "/";
  const canonicalRequest = [
    i.method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    i.payloadHash,
  ].join("\n");
  const scope = `${date}/${i.region}/${i.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    i.amzDate,
    scope,
    hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac("AWS4" + i.secretAccessKey, date);
  const kRegion = hmac(kDate, i.region);
  const kService = hmac(kRegion, i.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign)
    .digest("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    canonicalRequest,
    stringToSign,
    signature,
  };
}
export const amzDate = (d = new Date()) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

// ---- drivers ----------------------------------------------------------------------------------

/** Local directory (MEDIA_FS_ROOT): development and CI only (config refuses it when deployed). */
export function fsStore(root: string): MediaStore {
  const base = resolve(root);
  const file = (key: string) => {
    checkKey(key);
    const p = resolve(join(base, key));
    if (!p.startsWith(base + sep)) throw Error("media_key_invalid");
    return p;
  };
  return {
    async put(key, body) {
      const p = file(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, body);
    },
    async get(key) {
      try {
        return await readFile(file(key));
      } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") return null;
        throw e;
      }
    },
    async delete(key) {
      await rm(file(key), { force: true });
    },
  };
}

/** Cloudflare R2 over the S3 API (region "auto"), path-style, 10 s per request. */
export function r2Store(
  c: Extract<MediaStoreConfig, { driver: "r2" }>,
  fetchFn: typeof fetch = fetch,
): MediaStore {
  const host = `${c.accountId}.r2.cloudflarestorage.com`;
  async function call(
    method: "PUT" | "GET" | "DELETE",
    key: string,
    body?: Buffer,
    type?: string,
  ) {
    checkKey(key);
    const path = `/${c.bucket}/${key}`;
    const payloadHash = hex(body ?? "");
    const date = amzDate();
    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": date,
      ...(type ? { "content-type": type } : {}),
    };
    const { authorization } = signV4({
      method,
      path,
      headers,
      payloadHash,
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      region: "auto",
      service: "s3",
      amzDate: date,
    });
    const { host: _host, ...sent } = headers;
    return fetchFn(`https://${host}${path}`, {
      method,
      headers: { ...sent, authorization },
      body: body ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  }
  return {
    async put(key, body, type) {
      const r = await call("PUT", key, body, type);
      if (!r.ok) throw Error(`media_store_put_${r.status}`);
    },
    async get(key) {
      const r = await call("GET", key);
      if (r.status === 404) return null;
      if (!r.ok) throw Error(`media_store_get_${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
    async delete(key) {
      const r = await call("DELETE", key);
      if (!r.ok && r.status !== 404)
        throw Error(`media_store_delete_${r.status}`);
    },
  };
}

let cached: { store: MediaStore | null; for: string } | null = null;
/** The configured store, or null (MEDIA_STORE unset: no photos can be stored). */
export function mediaStore(): MediaStore | null {
  const fingerprint = [
    process.env.MEDIA_STORE,
    process.env.MEDIA_FS_ROOT,
    process.env.MEDIA_R2_ACCOUNT_ID,
    process.env.MEDIA_R2_BUCKET,
  ].join("|");
  if (cached && cached.for === fingerprint) return cached.store;
  const c = mediaStoreConfig();
  const store = !c ? null : c.driver === "fs" ? fsStore(c.root) : r2Store(c);
  cached = { store, for: fingerprint };
  return store;
}
