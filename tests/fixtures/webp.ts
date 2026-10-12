// Hand-built WebP containers for the media tests (039, LD-88). The server validates the RIFF
// container and the bitstream header, never the pixels, so a VP8L chunk only needs a valid
// signature and size header; the rest is filler. `TINY_WEBP` is a real 1×1 lossless image.

const le32 = (n: number) => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function chunk(fourcc: string, data: number[] | Uint8Array): number[] {
  const bytes = [...data];
  return [
    ...text(fourcc),
    ...le32(bytes.length),
    ...bytes,
    ...(bytes.length % 2 ? [0] : []),
  ];
}
/** A VP8L chunk declaring w×h (alpha flag optional) followed by filler bytes. */
export function vp8l(w: number, h: number, filler = 12): number[] {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return chunk("VP8L", [0x2f, ...le32(bits), ...new Array(filler).fill(0x55)]);
}
/** A lossy VP8 key frame header declaring w×h, then filler. */
export function vp8(w: number, h: number, filler = 12): number[] {
  return chunk("VP8 ", [
    0x10,
    0x02,
    0x00,
    0x9d,
    0x01,
    0x2a,
    w & 0xff,
    (w >>> 8) & 0x3f,
    h & 0xff,
    (h >>> 8) & 0x3f,
    ...new Array(filler).fill(0x55),
  ]);
}
export function vp8x(w: number, h: number, flags: number): number[] {
  const W = w - 1,
    H = h - 1;
  return chunk("VP8X", [
    flags,
    0,
    0,
    0,
    W & 0xff,
    (W >>> 8) & 0xff,
    (W >>> 16) & 0xff,
    H & 0xff,
    (H >>> 8) & 0xff,
    (H >>> 16) & 0xff,
  ]);
}
export function riff(chunks: number[][]): Uint8Array {
  const body = chunks.flat();
  return new Uint8Array([
    ...text("RIFF"),
    ...le32(4 + body.length),
    ...text("WEBP"),
    ...body,
  ]);
}
/** A still WebP of w×h with EXIF, XMP and ICC chunks (the metadata the server must drop). */
export function webpWithMetadata(w: number, h: number): Uint8Array {
  return riff([
    vp8x(w, h, 0x20 | 0x08 | 0x04),
    chunk("ICCP", text("fake-icc-profile")),
    vp8l(w, h),
    chunk("EXIF", text("Exif\0\0GPS 19.4326N 99.1332W fictional")),
    chunk("XMP ", text("<x:xmpmeta>fictional</x:xmpmeta>")),
  ]);
}
/** The three variants of one w×h photo, concatenated as the upload body (thumb ‖ card ‖ hero). */
export function uploadBody(
  w: number,
  h: number,
  o: { metadata?: boolean } = {},
): Buffer {
  const size = (cap: number) => {
    const vw = Math.min(cap, w);
    return [vw, Math.round((h * vw) / w)] as const;
  };
  const make = (vw: number, vh: number) =>
    o.metadata ? webpWithMetadata(vw, vh) : riff([vp8l(vw, vh)]);
  return Buffer.concat(
    [size(160), size(480), size(1200)].map(([vw, vh]) =>
      Buffer.from(make(vw, vh)),
    ),
  );
}
/** A real 1×1 lossless WebP. */
export const TINY_WEBP = Buffer.from(
  "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==",
  "base64",
);
