// Hand-built JPEG files for the media tests (KIOSK-UX-11, LD-91). Built here byte by byte from
// ITU-T T.81 (no file copied from anywhere). `jpeg(w, h)` is a real, decodable baseline image:
// 8-bit grayscale, every quantizer 1, a restart interval of one MCU, and every 8×8 block mid-grey
// (DC difference 0, then end of block). Its DC table gives category 0 the 9-bit code 111111110, so
// each MCU's entropy bytes are FF 00 3F (a stuffed 0xFF, then the 1-bit padding) and RSTn sit
// between MCUs: the scan exercises byte stuffing and restart markers. The server never decodes
// pixels; the decodable image is for the reasoning in shared/jpeg.ts (no JFIF needed to render).

const be16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** One marker segment: FF, the code, the 2-byte length (counting itself), the payload. */
export function segment(marker: number, data: number[]): number[] {
  return [0xff, marker, ...be16(data.length + 2), ...data];
}

export const SOI = [0xff, 0xd8];
export const EOI = [0xff, 0xd9];
/** Quantization table 0, 8-bit, every value 1. */
export const DQT = segment(0xdb, [0x00, ...new Array(64).fill(1)]);
/** DC table 0: nine codes of lengths 1–9 for categories 1…8, then 0 (code 111111110). */
export const DHT_DC = segment(0xc4, [
  0x00,
  ...[1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 0],
]);
/** AC table 0: one 1-bit code (0) for end of block. */
export const DHT_AC = segment(0xc4, [
  0x10,
  ...[1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  0x00,
]);
/** A restart marker after every MCU. */
export const DRI = segment(0xdd, be16(1));
/** A frame header: SOF0 by default, 8-bit, one component (id 1, 1×1 sampling, table 0). */
export function sof(w: number, h: number, marker = 0xc0, precision = 8) {
  return segment(marker, [precision, ...be16(h), ...be16(w), 1, 1, 0x11, 0]);
}
/** The scan header for the one component (tables 0/0), spectral 0–63. */
export const SOS = segment(0xda, [1, 1, 0x00, 0, 63, 0]);
/** The entropy-coded data of a w×h image: FF 00 3F per MCU, RST0…RST7 between MCUs. */
export function scanData(w: number, h: number): number[] {
  const n = Math.ceil(w / 8) * Math.ceil(h / 8);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(0xff, 0x00, 0x3f);
    if (i < n - 1) out.push(0xff, 0xd0 + (i % 8));
  }
  return out;
}

/** The metadata a camera or an editor leaves (fictional values): all of it must be dropped. */
export const JFIF = segment(0xe0, [
  ...text("JFIF\0"),
  1,
  1,
  0,
  ...be16(72),
  ...be16(72),
  0,
  0,
]);
export const EXIF = segment(0xe1, [
  ...text("Exif\0\0"),
  ...text("MM\0*GPS 19.4326N 99.1332W fictional"),
]);
export const ICC = segment(0xe2, [
  ...text("ICC_PROFILE\0"),
  1,
  1,
  ...text("fake-icc-profile"),
]);
export const XMP = segment(0xe1, [
  ...text("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>fictional</x:xmpmeta>"),
]);
export const COM = segment(0xfe, text("fictional comment: Calle Ficticia 123"));

const cat = (parts: number[][]) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/**
 * A w×h JPEG. With `metadata`, JFIF, EXIF (with GPS text), ICC, XMP and a comment sit where an
 * encoder writes them (after SOI, and a comment between the tables); without it, the file is
 * exactly what the server's rebuild of the metadata version must produce.
 */
export function jpeg(
  w: number,
  h: number,
  o: { metadata?: boolean } = {},
): Uint8Array {
  const m = !!o.metadata;
  return cat([
    SOI,
    ...(m ? [JFIF, EXIF, ICC, XMP] : []),
    DQT,
    sof(w, h),
    ...(m ? [COM] : []),
    DHT_DC,
    DHT_AC,
    DRI,
    SOS,
    scanData(w, h),
    EOI,
  ]);
}

/** Any sequence of byte arrays as one file (for crafting malformed files in the tests). */
export const bytes = (...parts: number[][]) => cat(parts);

/** The three JPEG variants of one w×h photo as the upload body (thumb ‖ card ‖ hero). */
export function jpegUploadBody(
  w: number,
  h: number,
  o: { metadata?: boolean } = {},
): Buffer {
  const size = (cap: number) => {
    const vw = Math.min(cap, w);
    return [vw, Math.round((h * vw) / w)] as const;
  };
  return Buffer.concat(
    [size(160), size(480), size(1200)].map(([vw, vh]) =>
      Buffer.from(jpeg(vw, vh, o)),
    ),
  );
}
