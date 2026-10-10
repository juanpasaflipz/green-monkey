// WebP container validation and rebuild (039, LD-88). The server never decodes pixels: it accepts
// only WebP, parses the RIFF container (Google's "WebP Container Specification", RFC 9649 §2),
// checks every size and the image dimensions, and rebuilds the file from only the chunks needed to
// render a still image: VP8 or VP8L alone, or VP8X (flags rewritten to alpha only) + ALPH + VP8.
// EXIF, XMP and ICCP chunks are dropped; animation (ANIM/ANMF or the animation flag), unknown
// chunks, trailing bytes and any size that does not add up are refused. Pure (no Node APIs).

export class WebpError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const ascii = (b: Uint8Array, at: number) =>
  String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const u32 = (b: Uint8Array, at: number) =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000;
const u24 = (b: Uint8Array, at: number) =>
  b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

type Chunk = { fourcc: string; data: Uint8Array };
const KNOWN = new Set(["VP8X", "VP8 ", "VP8L", "ALPH", "ICCP", "EXIF", "XMP "]);
const DROPPED = new Set(["ICCP", "EXIF", "XMP "]);

/** The byte length of the RIFF file that starts at `at` (8 + its declared size). */
export function riffLength(b: Uint8Array, at = 0): number {
  if (b.length - at < 12) throw new WebpError("media_invalid");
  if (ascii(b, at) !== "RIFF" || ascii(b, at + 8) !== "WEBP")
    throw new WebpError("media_type_unsupported");
  const size = u32(b, at + 4);
  if (size < 4 || size % 2 !== 0) throw new WebpError("media_invalid");
  return size + 8;
}

function chunks(b: Uint8Array): Chunk[] {
  const total = riffLength(b);
  if (total !== b.length) throw new WebpError("media_invalid");
  const out: Chunk[] = [];
  let at = 12;
  while (at < b.length) {
    if (b.length - at < 8) throw new WebpError("media_invalid");
    const fourcc = ascii(b, at);
    const size = u32(b, at + 4);
    const end = at + 8 + size;
    const padded = end + (size % 2);
    if (padded > b.length) throw new WebpError("media_invalid");
    if (!KNOWN.has(fourcc)) throw new WebpError("media_invalid");
    out.push({ fourcc, data: b.subarray(at + 8, end) });
    at = padded;
  }
  if (!out.length) throw new WebpError("media_invalid");
  return out;
}

/** Width and height carried by a VP8 (lossy key frame) or VP8L (lossless) bitstream header. */
function bitstreamSize(c: Chunk): { w: number; h: number; alpha: boolean } {
  const d = c.data;
  if (c.fourcc === "VP8 ") {
    // Frame tag (3 bytes, bit 0 = 0 for a key frame), start code 9d 01 2a, then 14-bit sizes.
    if (d.length < 10 || (d[0] & 1) !== 0) throw new WebpError("media_invalid");
    if (d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a)
      throw new WebpError("media_invalid");
    return {
      w: (d[6] | (d[7] << 8)) & 0x3fff,
      h: (d[8] | (d[9] << 8)) & 0x3fff,
      alpha: false,
    };
  }
  // VP8L: signature 0x2f, then width-1 (14 bits), height-1 (14), alpha_is_used (1), version (3).
  if (d.length < 5 || d[0] !== 0x2f) throw new WebpError("media_invalid");
  const bits = u32(d, 1);
  const version = (bits >>> 29) & 7;
  if (version !== 0) throw new WebpError("media_invalid");
  return {
    w: (bits & 0x3fff) + 1,
    h: ((bits >>> 14) & 0x3fff) + 1,
    alpha: ((bits >>> 28) & 1) === 1,
  };
}

function riff(parts: Chunk[]): Uint8Array {
  const size =
    4 + parts.reduce((n, c) => n + 8 + c.data.length + (c.data.length % 2), 0);
  const out = new Uint8Array(size + 8);
  const put32 = (at: number, v: number) => {
    out[at] = v & 0xff;
    out[at + 1] = (v >>> 8) & 0xff;
    out[at + 2] = (v >>> 16) & 0xff;
    out[at + 3] = (v >>> 24) & 0xff;
  };
  const text = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i);
  };
  text(0, "RIFF");
  put32(4, size);
  text(8, "WEBP");
  let at = 12;
  for (const c of parts) {
    text(at, c.fourcc);
    put32(at + 4, c.data.length);
    out.set(c.data, at + 8);
    at += 8 + c.data.length + (c.data.length % 2);
  }
  return out;
}

export type CleanWebp = { bytes: Uint8Array; width: number; height: number };

/**
 * Validates one WebP file and returns it rebuilt without metadata. `maxSide` caps each
 * dimension (the variant's own cap).
 */
export function cleanWebp(b: Uint8Array, o: { maxSide: number }): CleanWebp {
  const list = chunks(b);
  const vp8x = list.find((c) => c.fourcc === "VP8X");
  const images = list.filter((c) => c.fourcc === "VP8 " || c.fourcc === "VP8L");
  const alph = list.filter((c) => c.fourcc === "ALPH");
  if (images.length !== 1 || alph.length > 1)
    throw new WebpError("media_invalid");
  if (list.filter((c) => c.fourcc === "VP8X").length > 1)
    throw new WebpError("media_invalid");
  if (vp8x && list[0] !== vp8x) throw new WebpError("media_invalid");
  // Anything besides the image, its alpha and droppable metadata is refused (KNOWN filtered the
  // rest); ANIM/ANMF never pass KNOWN, so animation is refused there and by the flag below.
  for (const c of list)
    if (
      c !== vp8x &&
      c !== images[0] &&
      !alph.includes(c) &&
      !DROPPED.has(c.fourcc)
    )
      throw new WebpError("media_invalid");
  const image = images[0];
  const size = bitstreamSize(image);
  if (vp8x) {
    if (vp8x.data.length !== 10) throw new WebpError("media_invalid");
    const flags = vp8x.data[0];
    if (flags & 0x02) throw new WebpError("media_invalid");
    const cw = u24(vp8x.data, 4) + 1;
    const ch = u24(vp8x.data, 7) + 1;
    if (cw !== size.w || ch !== size.h) throw new WebpError("media_invalid");
  } else if (alph.length) throw new WebpError("media_invalid");
  if (alph.length && image.fourcc !== "VP8 ")
    throw new WebpError("media_invalid");
  if (size.w < 1 || size.h < 1) throw new WebpError("media_invalid");
  if (size.w > o.maxSide || size.h > o.maxSide)
    throw new WebpError("media_too_large");
  let bytes: Uint8Array;
  if (alph.length) {
    const x = new Uint8Array(10);
    x[0] = 0x10; // alpha only
    const w = size.w - 1,
      h = size.h - 1;
    x[4] = w & 0xff;
    x[5] = (w >>> 8) & 0xff;
    x[6] = (w >>> 16) & 0xff;
    x[7] = h & 0xff;
    x[8] = (h >>> 8) & 0xff;
    x[9] = (h >>> 16) & 0xff;
    bytes = riff([{ fourcc: "VP8X", data: x }, alph[0], image]);
  } else bytes = riff([image]);
  return { bytes, width: size.w, height: size.h };
}

/** Splits a body of concatenated RIFF files (thumb ‖ card ‖ hero) into its files. */
export function splitRiffs(b: Uint8Array, count: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  while (at < b.length && out.length < count) {
    const n = riffLength(b, at);
    if (at + n > b.length) throw new WebpError("media_invalid");
    out.push(b.subarray(at, at + n));
    at += n;
  }
  if (out.length !== count || at !== b.length)
    throw new WebpError("media_invalid");
  return out;
}
