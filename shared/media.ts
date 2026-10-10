// Menu photos (039; specs/kiosk-w4.md §2.9; LD-88, LD-91). The browser checks the original file
// (type, 10 MB, 40 megapixels from the header, never decoding first), re-encodes three variants on
// a canvas (WebP, or JPEG where the browser cannot encode WebP: every WebKit browser) and uploads
// them concatenated; the server validates and rebuilds each container (shared/webp.ts,
// shared/jpeg.ts). Pure.
import { riffLength } from "./webp.js";

export const MEDIA_LIMITS = {
  /** The original the owner picks. */
  maxBytes: 10 * 1024 * 1024,
  maxPixels: 40_000_000,
  types: ["image/jpeg", "image/png", "image/webp"] as const,
  /** WebP or JPEG quality of the browser's re-encode (sharp's documented default is 80, §2.9). */
  quality: 0.8,
  /** Uploads per tenant per 10 minutes (R8). */
  uploadsPerWindow: 30,
  /**
   * Uploads in flight in one process, one per restaurant; more answer 429 media_busy before the
   * body is read (R8, KV-SECURITY-1).
   */
  uploadSlots: 2,
  /** The upload body (three variants). */
  maxUploadBytes: 4 * 1024 * 1024,
  /** Removed assets are purged 7 days later; an upload left half-done is swept after 1 hour. */
  purgeAfterDays: 7,
  staleAfterMs: 3_600_000,
} as const;

/** Variants in upload order: width cap (never enlarged) and byte cap. */
export const MEDIA_VARIANTS = [
  { name: "thumb", width: 160, maxBytes: 200 * 1024 },
  { name: "card", width: 480, maxBytes: 800 * 1024 },
  { name: "hero", width: 1200, maxBytes: 3 * 1024 * 1024 },
] as const;
export type MediaVariant = (typeof MEDIA_VARIANTS)[number]["name"];
export const isVariant = (v: string): v is MediaVariant =>
  MEDIA_VARIANTS.some((x) => x.name === v);

/**
 * The stored types and their URL extensions: WebP, or JPEG from a browser that cannot encode WebP
 * on a canvas (KIOSK-UX-11). One asset's three variants share one type.
 */
export const MEDIA_TYPES = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
} as const;
export type MediaType = keyof typeof MEDIA_TYPES;
/** A product's photo; `type` is present only for JPEG (absent = WebP). */
export type ProductImage = {
  id: string;
  w: number;
  h: number;
  type?: "image/jpeg";
};
export const mediaUrl = (
  image: { id: string; type?: MediaType },
  variant: MediaVariant,
) => `/media/${image.id}/${variant}.${MEDIA_TYPES[image.type ?? "image/webp"]}`;

/** The variant size for an original (withoutEnlargement: never wider than the original). */
export function variantSize(
  original: { w: number; h: number },
  width: number,
): { w: number; h: number } {
  const w = Math.min(width, original.w);
  return { w, h: Math.max(1, Math.round((original.h * w) / original.w)) };
}

/** The real type of a file from its first bytes (never the name or the browser's claim). */
export function sniffType(
  b: Uint8Array,
): "image/jpeg" | "image/png" | "image/webp" | "image/heic" | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return "image/jpeg";
  if (
    b.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)
  )
    return "image/png";
  if (
    b.length >= 12 &&
    String.fromCharCode(...b.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  // ISO BMFF "ftyp" with a HEIF/AVIF brand: refused with its own message.
  if (b.length >= 12 && String.fromCharCode(...b.subarray(4, 8)) === "ftyp") {
    const brand = String.fromCharCode(...b.subarray(8, 12));
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1|avif|avis)$/.test(brand))
      return "image/heic";
  }
  return null;
}

/** Width and height a JPEG, PNG or WebP header declares, without decoding; null if unreadable. */
export function declaredSize(b: Uint8Array): { w: number; h: number } | null {
  const t = sniffType(b);
  if (t === "image/png") {
    if (b.length < 24) return null;
    const be = (at: number) =>
      ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
    return { w: be(16), h: be(20) };
  }
  if (t === "image/jpeg") {
    let at = 2;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1];
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      const len = (b[at + 2] << 8) | b[at + 3];
      // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      )
        return {
          h: (b[at + 5] << 8) | b[at + 6],
          w: (b[at + 7] << 8) | b[at + 8],
        };
      if (marker === 0xd9 || marker === 0xda) return null;
      at += 2 + len;
    }
    return null;
  }
  if (t === "image/webp") {
    try {
      riffLength(b);
    } catch {
      return null;
    }
    // First chunk: VP8X canvas, or the bitstream header.
    const four = String.fromCharCode(...b.subarray(12, 16));
    const d = b.subarray(20);
    if (four === "VP8X" && d.length >= 10)
      return {
        w: (d[4] | (d[5] << 8) | (d[6] << 16)) + 1,
        h: (d[7] | (d[8] << 8) | (d[9] << 16)) + 1,
      };
    if (four === "VP8 " && d.length >= 10)
      return {
        w: (d[6] | (d[7] << 8)) & 0x3fff,
        h: (d[8] | (d[9] << 8)) & 0x3fff,
      };
    if (four === "VP8L" && d.length >= 5) {
      const bits = d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24);
      return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  return null;
}

export type OriginalProblem =
  "media_type_unsupported" | "media_too_large" | "media_invalid";

/** The browser's check of the picked file before it decodes anything (§2.9). */
export function checkOriginal(
  b: Uint8Array,
  size: number,
): OriginalProblem | null {
  const t = sniffType(b);
  if (!t || t === "image/heic") return "media_type_unsupported";
  if (size > MEDIA_LIMITS.maxBytes) return "media_too_large";
  const d = declaredSize(b);
  if (!d || d.w < 1 || d.h < 1) return "media_invalid";
  if (d.w * d.h > MEDIA_LIMITS.maxPixels) return "media_too_large";
  return null;
}
