// JPEG container validation and rebuild (039, LD-88 extended by LD-91: KIOSK-UX-11). No WebKit
// browser (desktop Safari, every iPadOS and iOS browser) can encode WebP on a canvas, so those
// browsers upload canvas JPEGs. As with WebP, the server never decodes pixels: it walks the marker
// structure of ITU-T T.81 Annex B with a bounds check on every length, accepts only a baseline or
// extended Huffman (SOF0/SOF1) or progressive Huffman (SOF2) frame, 8-bit, grayscale or YCbCr,
// and rebuilds the file from SOI, DQT, SOF, DHT, DRI, SOS + the entropy-coded data (byte stuffing
// and RSTn kept verbatim) and EOI. Every APPn (JFIF, EXIF, XMP, ICC, Adobe, MPF) and COM segment
// is dropped. Truncated input, trailing bytes, a second frame, arithmetic coding (SOF9-SOF15,
// DAC), lossless or hierarchical frames (SOF3, SOF5-SOF7, DHP, EXP), DNL and any other marker
// are refused. Pure (no Node APIs).
//
// No JFIF APP0 is written back (reasoned from the specs, and checked by decoding a rebuilt
// canvas JPEG with Apple ImageIO): JFIF is optional for a JPEG interchange file (T.81 Annex B
// needs only SOI, tables, frame, scans and EOI). Without JFIF or an Adobe APP14 segment, libjpeg
// (Chromium and Firefox use libjpeg-turbo) reads a 1-component frame as grayscale and a
// 3-component frame as YCbCr unless its component ids are 'R','G','B' (jdapimin.c
// default_decompress_parms); camera files with EXIF and no JFIF render that way in every browser.
// So the rebuild refuses the two cases where dropping APPn would change the colours: a
// 3-component frame with ids 'R','G','B', and an Adobe segment whose transform is not YCbCr.
// The canvas renders in sRGB, so dropping an ICC profile does not change the colours either.

export class JpegError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const invalid = () => new JpegError("media_invalid");
const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];

/** A progressive file from a canvas has about 10 scans; more is not a menu photo. */
const MAX_SCANS = 32;

type Parsed = {
  /** The offset just after this file's EOI. */
  end: number;
  width: number;
  height: number;
  /** The kept parts, in order: SOI, tables, SOF, SOS headers with their scan data, EOI. */
  parts: Uint8Array[];
};

const SOI = Uint8Array.of(0xff, 0xd8);
const EOI = Uint8Array.of(0xff, 0xd9);

/**
 * Walks one JPEG that starts at `start` up to its EOI. Throws media_type_unsupported when the
 * bytes at `start` are not a JPEG, media_invalid for anything malformed, refused or truncated.
 */
function parse(b: Uint8Array, start: number): Parsed {
  if (b.length - start < 2 || b[start] !== 0xff || b[start + 1] !== 0xd8)
    throw new JpegError("media_type_unsupported");
  const parts: Uint8Array[] = [SOI];
  let at = start + 2;
  let frame: {
    progressive: boolean;
    width: number;
    height: number;
    components: Map<number, number>;
  } | null = null;
  const quant = new Set<number>();
  const dc = new Set<number>();
  const ac = new Set<number>();
  let restart = 0;
  let scans = 0;
  let adobeTransform: number | null = null;
  for (;;) {
    // A marker: 0xFF, optional 0xFF fill bytes (B.1.1.2), then the code.
    if (at >= b.length || b[at] !== 0xff) throw invalid();
    while (at < b.length && b[at] === 0xff) at++;
    if (at >= b.length) throw invalid();
    const m = b[at++];
    if (m === 0xd9) {
      if (!frame || !scans) throw invalid();
      if (frame.components.size === 3) {
        if (adobeTransform !== null && adobeTransform !== 1) throw invalid();
        const ids = [...frame.components.keys()];
        if (ids[0] === 0x52 && ids[1] === 0x47 && ids[2] === 0x42)
          throw invalid();
      }
      parts.push(EOI);
      return { end: at, width: frame.width, height: frame.height, parts };
    }
    // Every other marker allowed here carries a 2-byte length that counts itself.
    if (b.length - at < 2) throw invalid();
    const len = u16(b, at);
    if (len < 2 || at + len > b.length) throw invalid();
    const seg = b.subarray(at + 2, at + len);
    const whole = b.subarray(at - 2, at + len);
    at += len;
    if (m >= 0xe0 && m <= 0xef) {
      // APPn: dropped. Adobe's APP14 is read only to know how the colours were stored.
      if (
        m === 0xee &&
        seg.length >= 12 &&
        String.fromCharCode(...seg.subarray(0, 5)) === "Adobe"
      )
        adobeTransform = seg[11];
      continue;
    }
    if (m === 0xfe) continue; // COM: dropped.
    if (m === 0xdb) {
      // DQT: one or more tables, each Pq|Tq then 64 values of 1 (Pq 0) or 2 (Pq 1) bytes.
      let i = 0;
      if (!seg.length) throw invalid();
      while (i < seg.length) {
        const pq = seg[i] >> 4,
          tq = seg[i] & 15;
        if (pq > 1 || tq > 3) throw invalid();
        i += 1 + 64 * (pq + 1);
        if (i > seg.length) throw invalid();
        quant.add(tq);
      }
      parts.push(whole);
      continue;
    }
    if (m === 0xc4) {
      // DHT: one or more tables, each Tc|Th, 16 code-length counts, then that many values.
      let i = 0;
      if (!seg.length) throw invalid();
      while (i < seg.length) {
        if (i + 17 > seg.length) throw invalid();
        const tc = seg[i] >> 4,
          th = seg[i] & 15;
        if (tc > 1 || th > 3) throw invalid();
        let total = 0;
        for (let k = 1; k <= 16; k++) total += seg[i + k];
        if (total > 256) throw invalid();
        i += 17 + total;
        if (i > seg.length) throw invalid();
        (tc === 0 ? dc : ac).add(th);
      }
      parts.push(whole);
      continue;
    }
    if (m === 0xdd) {
      // DRI: the restart interval (0 = none).
      if (len !== 4) throw invalid();
      restart = u16(seg, 0);
      parts.push(whole);
      continue;
    }
    if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      // SOF0/1/2 (Huffman): one frame only (a second one is a second image).
      if (frame) throw invalid();
      if (seg.length < 6) throw invalid();
      const precision = seg[0];
      const height = u16(seg, 1),
        width = u16(seg, 3),
        n = seg[5];
      if (precision !== 8) throw invalid();
      // Height 0 means "defined later by DNL", which is refused.
      if (width < 1 || height < 1) throw invalid();
      if ((n !== 1 && n !== 3) || seg.length !== 6 + 3 * n) throw invalid();
      const components = new Map<number, number>();
      for (let c = 0; c < n; c++) {
        const cid = seg[6 + 3 * c],
          hv = seg[7 + 3 * c],
          tq = seg[8 + 3 * c];
        const h = hv >> 4,
          v = hv & 15;
        if (components.has(cid) || h < 1 || h > 4 || v < 1 || v > 4 || tq > 3)
          throw invalid();
        components.set(cid, tq);
      }
      frame = { progressive: m === 0xc2, width, height, components };
      parts.push(whole);
      continue;
    }
    if (m === 0xda) {
      // SOS: Ns components (each a frame component with its DC|AC tables), Ss, Se, Ah|Al.
      if (!frame || ++scans > MAX_SCANS) throw invalid();
      const ns = seg[0];
      if (!ns || ns > 4 || len !== 6 + 2 * ns) throw invalid();
      const ss = seg[1 + 2 * ns],
        se = seg[2 + 2 * ns],
        ah = seg[3 + 2 * ns] >> 4,
        al = seg[3 + 2 * ns] & 15;
      if (frame.progressive) {
        if (ss > se || se > 63 || ah > 13 || al > 13) throw invalid();
        if (ss === 0 ? se !== 0 : ns !== 1) throw invalid();
      } else if (ss !== 0 || se !== 63 || ah !== 0 || al !== 0) throw invalid();
      const seen = new Set<number>();
      for (let c = 0; c < ns; c++) {
        const cid = seg[1 + 2 * c],
          td = seg[2 + 2 * c] >> 4,
          ta = seg[2 + 2 * c] & 15;
        const tq = frame.components.get(cid);
        if (tq === undefined || seen.has(cid) || !quant.has(tq))
          throw invalid();
        seen.add(cid);
        // The Huffman tables this scan decodes with must already be defined.
        if (ss === 0 && ah === 0 && !dc.has(td)) throw invalid();
        if (se > 0 && !ac.has(ta)) throw invalid();
      }
      parts.push(whole);
      // Entropy-coded data up to the next marker: 0xFF00 is a stuffed byte and RSTn (in
      // order, only with a restart interval) a restart; both are kept as they are.
      const data = at;
      let rst = 0;
      for (;;) {
        if (at >= b.length) throw invalid();
        if (b[at] !== 0xff) {
          at++;
          continue;
        }
        if (at + 1 >= b.length) throw invalid();
        const next = b[at + 1];
        if (next === 0x00) {
          at += 2;
          continue;
        }
        if (next >= 0xd0 && next <= 0xd7) {
          if (!restart || next !== 0xd0 + rst) throw invalid();
          rst = (rst + 1) & 7;
          at += 2;
          continue;
        }
        break;
      }
      if (at === data) throw invalid();
      parts.push(b.subarray(data, at));
      continue;
    }
    // SOI again, RSTn or TEM outside a scan, SOF3/5-7 (lossless, hierarchical), SOF9-15 and DAC
    // (arithmetic), DNL, DHP, EXP, JPGn and reserved codes.
    throw invalid();
  }
}

export type CleanJpeg = { bytes: Uint8Array; width: number; height: number };

/**
 * Validates one JPEG file and returns it rebuilt from its image segments only. `maxSide` caps
 * each dimension (the variant's own cap, as for WebP).
 */
export function cleanJpeg(b: Uint8Array, o: { maxSide: number }): CleanJpeg {
  const p = parse(b, 0);
  if (p.end !== b.length) throw invalid();
  if (p.width > o.maxSide || p.height > o.maxSide)
    throw new JpegError("media_too_large");
  const bytes = new Uint8Array(p.parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of p.parts) {
    bytes.set(x, at);
    at += x.length;
  }
  return { bytes, width: p.width, height: p.height };
}

/** Splits a body of concatenated JPEG files (thumb ‖ card ‖ hero) at each file's EOI. */
export function splitJpegs(b: Uint8Array, count: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  while (at < b.length && out.length < count) {
    // Only the body's first bytes decide its type; a later part that is not a JPEG is malformed.
    if (at > 0 && (b[at] !== 0xff || b[at + 1] !== 0xd8)) throw invalid();
    const { end } = parse(b, at);
    out.push(b.subarray(at, end));
    at = end;
  }
  if (out.length !== count || at !== b.length) throw invalid();
  return out;
}
