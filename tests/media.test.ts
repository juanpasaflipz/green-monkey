// Menu photos (039, LD-88): the WebP container validation and rebuild, the upload pipeline's
// variant rules, the browser's original-file check, and the R2 SigV4 signer against the AWS
// Signature Version 4 test suite.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { cleanWebp, riffLength, splitRiffs, WebpError } from "../shared/webp";
import { cleanJpeg, JpegError, splitJpegs } from "../shared/jpeg";
import {
  checkOriginal,
  declaredSize,
  sniffType,
  MEDIA_LIMITS,
  mediaUrl,
} from "../shared/media";
import { processUpload, uploadProductImage } from "../server/media";
import { mediaStore, signV4 } from "../server/media-store";
import { DomainError, type Session } from "../shared/domain";
import {
  chunk,
  riff,
  TINY_WEBP,
  uploadBody,
  vp8,
  vp8l,
  vp8x,
  webpWithMetadata,
} from "./fixtures/webp";
import {
  bytes,
  DHT_AC,
  DHT_DC,
  DQT,
  DRI,
  EOI,
  jpeg,
  jpegUploadBody,
  scanData,
  segment,
  sof,
  SOI,
  SOS,
} from "./fixtures/jpeg";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as WebpError | JpegError | DomainError).code;
  }
  return null;
};
const has = (b: Uint8Array, s: string) =>
  Buffer.from(b).includes(Buffer.from(s, "latin1"));

describe("WebP container (LD-88: validate the container, never decode pixels)", () => {
  it("a real 1×1 lossless WebP passes unchanged in content", () => {
    const c = cleanWebp(TINY_WEBP, { maxSide: 160 });
    expect([c.width, c.height]).toEqual([1, 1]);
    expect(Buffer.from(c.bytes).equals(TINY_WEBP)).toBe(true);
  });

  it("EXIF, XMP and ICC chunks are dropped and the VP8X flags rewritten (a still image needs none)", () => {
    const dirty = webpWithMetadata(400, 300);
    expect(has(dirty, "GPS")).toBe(true);
    const c = cleanWebp(dirty, { maxSide: 1200 });
    expect([c.width, c.height]).toEqual([400, 300]);
    for (const s of ["EXIF", "XMP ", "ICCP", "GPS", "fictional", "VP8X"])
      expect(has(c.bytes, s)).toBe(false);
    expect(riffLength(c.bytes)).toBe(c.bytes.length);
    // The rebuilt file is itself valid and stable.
    expect(
      Buffer.from(cleanWebp(c.bytes, { maxSide: 1200 }).bytes).equals(
        Buffer.from(c.bytes),
      ),
    ).toBe(true);
  });

  it("alpha (VP8X + ALPH + VP8) keeps its alpha chunk with the flags set to alpha only", () => {
    const withAlpha = riff([
      vp8x(200, 100, 0x10 | 0x08),
      chunk("ALPH", [0, 1, 2, 3]),
      vp8(200, 100),
      chunk("EXIF", [1, 2]),
    ]);
    const c = cleanWebp(withAlpha, { maxSide: 480 });
    expect(has(c.bytes, "ALPH")).toBe(true);
    expect(has(c.bytes, "EXIF")).toBe(false);
    expect(c.bytes[20]).toBe(0x10);
  });

  it("refuses a bad RIFF size, trailing bytes, a truncated chunk, an unknown chunk, animation and two images", () => {
    const good = riff([vp8l(10, 10)]);
    const bad = Uint8Array.from(good);
    bad[4] += 2;
    expect(code(() => cleanWebp(bad, { maxSide: 100 }))).toBe("media_invalid");
    expect(
      code(() => cleanWebp(new Uint8Array([...good, 0, 0]), { maxSide: 100 })),
    ).toBe("media_invalid");
    const truncated = Uint8Array.from(good);
    truncated[16] += 40;
    expect(code(() => cleanWebp(truncated, { maxSide: 100 }))).toBe(
      "media_invalid",
    );
    expect(
      code(() =>
        cleanWebp(riff([vp8l(10, 10), chunk("ZZZZ", [1, 2])]), {
          maxSide: 100,
        }),
      ),
    ).toBe("media_invalid");
    expect(
      code(() =>
        cleanWebp(
          riff([
            vp8x(10, 10, 0x02),
            chunk("ANIM", [0, 0, 0, 0, 0, 0]),
            vp8l(10, 10),
          ]),
          { maxSide: 100 },
        ),
      ),
    ).toBe("media_invalid");
    expect(
      code(() =>
        cleanWebp(riff([vp8x(10, 10, 0x02), vp8l(10, 10)]), { maxSide: 100 }),
      ),
    ).toBe("media_invalid");
    expect(
      code(() =>
        cleanWebp(riff([vp8l(10, 10), vp8l(10, 10)]), { maxSide: 100 }),
      ),
    ).toBe("media_invalid");
    // A canvas that disagrees with the bitstream.
    expect(
      code(() =>
        cleanWebp(riff([vp8x(20, 10, 0), vp8l(10, 10)]), { maxSide: 100 }),
      ),
    ).toBe("media_invalid");
  });

  it("refuses oversized dimensions and anything that is not WebP", () => {
    expect(
      code(() => cleanWebp(riff([vp8l(5000, 300)]), { maxSide: 4800 })),
    ).toBe("media_too_large");
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
    ]);
    expect(code(() => cleanWebp(png, { maxSide: 100 }))).toBe(
      "media_type_unsupported",
    );
    expect(
      code(() => cleanWebp(new Uint8Array([1, 2, 3]), { maxSide: 100 })),
    ).toBe("media_invalid");
  });

  it("splits a body of three concatenated files and refuses a short or a long one", () => {
    const body = uploadBody(400, 300);
    expect(splitRiffs(body, 3).map((f) => f.length)).toHaveLength(3);
    expect(code(() => splitRiffs(body.subarray(0, body.length - 3), 3))).toBe(
      "media_invalid",
    );
    expect(
      code(() =>
        splitRiffs(Buffer.concat([body, Buffer.from(riff([vp8l(2, 2)]))]), 3),
      ),
    ).toBe("media_invalid");
  });
});

describe("processUpload (the pipeline's single seam)", () => {
  it("accepts one picture at the three widths, never enlarged, and strips metadata from each", () => {
    const p = processUpload(uploadBody(1600, 1200, { metadata: true }));
    expect([p.width, p.height]).toEqual([1200, 900]);
    expect(p.variants.map((v) => [v.name, v.w, v.h])).toEqual([
      ["thumb", 160, 120],
      ["card", 480, 360],
      ["hero", 1200, 900],
    ]);
    for (const v of p.variants) {
      expect(has(v.bytes, "GPS")).toBe(false);
      expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const small = processUpload(uploadBody(300, 200));
    expect(small.variants.map((v) => v.w)).toEqual([160, 300, 300]);
  });

  it("refuses variants that are not one picture, a hero over 1200 px, a strip and a body over 4 MB", () => {
    const parts = [
      riff([vp8l(160, 120)]),
      riff([vp8l(480, 360)]),
      riff([vp8l(1200, 800)]),
    ];
    expect(
      code(() =>
        processUpload(Buffer.concat(parts.map((p) => Buffer.from(p)))),
      ),
    ).toBe("media_invalid");
    const big = [
      riff([vp8l(160, 120)]),
      riff([vp8l(480, 360)]),
      riff([vp8l(1600, 1200)]),
    ];
    expect(
      code(() => processUpload(Buffer.concat(big.map((p) => Buffer.from(p))))),
    ).toBe("media_invalid");
    expect(code(() => processUpload(uploadBody(1000, 100)))).toBe(
      "media_invalid",
    );
    expect(
      code(() => processUpload(Buffer.alloc(MEDIA_LIMITS.maxUploadBytes + 1))),
    ).toBe("media_too_large");
  });
});

describe("JPEG container (KIOSK-UX-11, LD-91: WebKit browsers upload canvas JPEGs)", () => {
  const clean = (b: Uint8Array, maxSide = 1200) => cleanJpeg(b, { maxSide });
  const same = (a: Uint8Array, b: Uint8Array) =>
    Buffer.from(a).equals(Buffer.from(b));

  it("a valid file round-trips byte for byte (stuffed 0xFF and RSTn kept), and the rebuild is stable", () => {
    const plain = jpeg(40, 24);
    expect(has(plain, "\xff\x00")).toBe(true);
    expect(has(plain, "\xff\xd0")).toBe(true);
    const c = clean(plain);
    expect([c.width, c.height]).toEqual([40, 24]);
    expect(same(c.bytes, plain)).toBe(true);
    expect(same(clean(c.bytes).bytes, c.bytes)).toBe(true);
  });

  it("EXIF (APP1 with GPS), JFIF, ICC, XMP and COM are dropped; only the image segments stay", () => {
    const dirty = jpeg(400, 300, { metadata: true });
    for (const s of [
      "Exif",
      "GPS",
      "JFIF",
      "ICC_PROFILE",
      "xmpmeta",
      "fictional",
    ])
      expect(has(dirty, s)).toBe(true);
    const c = clean(dirty);
    expect([c.width, c.height]).toEqual([400, 300]);
    for (const s of [
      "Exif",
      "GPS",
      "JFIF",
      "ICC_PROFILE",
      "xmpmeta",
      "fictional",
    ])
      expect(has(c.bytes, s)).toBe(false);
    // Exactly the file without its metadata segments.
    expect(same(c.bytes, jpeg(400, 300))).toBe(true);
    // 0xFF fill bytes before a marker are dropped too.
    const filled = bytes(
      SOI,
      [0xff, 0xff],
      DQT,
      sof(8, 8),
      DHT_DC,
      DHT_AC,
      DRI,
      SOS,
      scanData(8, 8),
      [0xff],
      EOI,
    );
    expect(same(clean(filled).bytes, jpeg(8, 8))).toBe(true);
  });

  it("refuses truncated input: no EOI, a cut segment, a cut scan, a cut marker", () => {
    const good = jpeg(40, 24);
    for (const cut of [2, 3, 5, 30, good.length - 2, good.length - 6])
      expect(code(() => clean(good.subarray(0, good.length - cut)))).toBe(
        "media_invalid",
      );
    // A segment length that runs past the end.
    const long = Uint8Array.from(good);
    long[4] = 0xff;
    expect(code(() => clean(long))).toBe("media_invalid");
    // Trailing bytes after EOI.
    expect(code(() => clean(bytes([...good], [0])))).toBe("media_invalid");
  });

  it("refuses oversized dimensions (the variant's cap, as for WebP)", () => {
    expect(code(() => clean(jpeg(5000, 300), 4800))).toBe("media_too_large");
    expect(code(() => clean(jpeg(300, 5000), 4800))).toBe("media_too_large");
    expect(clean(jpeg(4800, 8), 4800).width).toBe(4800);
  });

  it("refuses anything that is not a JPEG", () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
    ]);
    expect(code(() => clean(png))).toBe("media_type_unsupported");
    expect(code(() => clean(TINY_WEBP))).toBe("media_type_unsupported");
    expect(code(() => clean(new Uint8Array([1, 2, 3])))).toBe(
      "media_type_unsupported",
    );
    expect(code(() => clean(new Uint8Array([0xff])))).toBe(
      "media_type_unsupported",
    );
  });

  it("refuses a second image, arithmetic coding, lossless/hierarchical frames, unknown markers and missing tables", () => {
    const tail = [DHT_DC, DHT_AC, DRI, SOS, scanData(8, 8), EOI];
    const ok = (...head: number[][]) => bytes(SOI, ...head, ...tail);
    expect(clean(ok(DQT, sof(8, 8))).width).toBe(8);
    // Two frames in one file; two files glued together.
    expect(code(() => clean(ok(DQT, sof(8, 8), sof(8, 8))))).toBe(
      "media_invalid",
    );
    expect(code(() => clean(bytes([...jpeg(8, 8)], [...jpeg(8, 8)])))).toBe(
      "media_invalid",
    );
    // SOF3 (lossless), SOF5 (hierarchical), SOF9 and SOF10 (arithmetic), and DAC.
    for (const m of [0xc3, 0xc5, 0xc9, 0xca, 0xcb, 0xcd])
      expect(code(() => clean(ok(DQT, sof(8, 8, m))))).toBe("media_invalid");
    expect(
      code(() => clean(ok(DQT, segment(0xcc, [0x00, 0x10]), sof(8, 8)))),
    ).toBe("media_invalid");
    // DNL (height 0), 12-bit samples, a reserved marker, a TEM, a stray RST.
    expect(code(() => clean(ok(DQT, sof(8, 0))))).toBe("media_invalid");
    expect(code(() => clean(ok(DQT, sof(8, 8, 0xc1, 12))))).toBe(
      "media_invalid",
    );
    expect(code(() => clean(ok(DQT, segment(0xf7, [1, 2]), sof(8, 8))))).toBe(
      "media_invalid",
    );
    expect(code(() => clean(ok(DQT, [0xff, 0x01], sof(8, 8))))).toBe(
      "media_invalid",
    );
    expect(code(() => clean(ok(DQT, [0xff, 0xd0], sof(8, 8))))).toBe(
      "media_invalid",
    );
    // No DQT, no DHT, no frame, no scan.
    expect(code(() => clean(ok(sof(8, 8))))).toBe("media_invalid");
    expect(
      code(() =>
        clean(bytes(SOI, DQT, sof(8, 8), DRI, SOS, scanData(8, 8), EOI)),
      ),
    ).toBe("media_invalid");
    expect(
      code(() =>
        clean(bytes(SOI, DQT, DHT_DC, DHT_AC, SOS, scanData(8, 8), EOI)),
      ),
    ).toBe("media_invalid");
    expect(
      code(() => clean(bytes(SOI, DQT, sof(8, 8), DHT_DC, DHT_AC, EOI))),
    ).toBe("media_invalid");
    // RSTn out of order, or with no restart interval.
    const wrong = scanData(16, 8);
    wrong[4] = 0xd3;
    expect(
      code(() =>
        clean(
          bytes(SOI, DQT, sof(16, 8), DHT_DC, DHT_AC, DRI, SOS, wrong, EOI),
        ),
      ),
    ).toBe("media_invalid");
    expect(
      code(() =>
        clean(
          bytes(
            SOI,
            DQT,
            sof(16, 8),
            DHT_DC,
            DHT_AC,
            SOS,
            scanData(16, 8),
            EOI,
          ),
        ),
      ),
    ).toBe("media_invalid");
  });

  it("refuses the colour cases a dropped APPn would change: an Adobe RGB transform, 'R','G','B' ids", () => {
    const rgbFrame = (ids: number[]) =>
      segment(0xc0, [8, 0, 8, 0, 8, 3, ...ids.flatMap((i) => [i, 0x11, 0])]);
    const scan3 = (ids: number[]) =>
      segment(0xda, [3, ...ids.flatMap((i) => [i, 0x00]), 0, 63, 0]);
    const three = (ids: number[], adobe?: number) =>
      bytes(
        SOI,
        ...(adobe === undefined
          ? []
          : [
              segment(0xee, [
                0x41,
                0x64,
                0x6f,
                0x62,
                0x65,
                0,
                100,
                0,
                0,
                0,
                0,
                adobe,
              ]),
            ]),
        DQT,
        rgbFrame(ids),
        DHT_DC,
        DHT_AC,
        scan3(ids),
        [0x00],
        EOI,
      );
    expect(clean(three([1, 2, 3])).width).toBe(8);
    expect(clean(three([1, 2, 3], 1)).bytes.length).toBeLessThan(
      three([1, 2, 3], 1).length,
    );
    expect(code(() => clean(three([1, 2, 3], 0)))).toBe("media_invalid");
    expect(code(() => clean(three([0x52, 0x47, 0x42])))).toBe("media_invalid");
  });

  it("splits a body of three concatenated files and refuses a short, a long or a mixed one", () => {
    const body = jpegUploadBody(400, 300, { metadata: true });
    expect(splitJpegs(body, 3).map((f) => clean(f, 4800).width)).toEqual([
      160, 400, 400,
    ]);
    expect(code(() => splitJpegs(body.subarray(0, body.length - 3), 3))).toBe(
      "media_invalid",
    );
    expect(
      code(() => splitJpegs(Buffer.concat([body, Buffer.from(jpeg(8, 8))]), 3)),
    ).toBe("media_invalid");
    expect(
      code(() =>
        splitJpegs(
          Buffer.concat([
            Buffer.from(jpeg(160, 120)),
            Buffer.from(jpeg(480, 360)),
            Buffer.from(riff([vp8l(1200, 900)])),
          ]),
          3,
        ),
      ),
    ).toBe("media_invalid");
  });

  it("processUpload: three JPEG variants become a JPEG asset without metadata; a mixed body is refused", () => {
    const p = processUpload(jpegUploadBody(1600, 1200, { metadata: true }));
    expect(p.type).toBe("image/jpeg");
    expect([p.width, p.height]).toEqual([1200, 900]);
    expect(p.variants.map((v) => [v.name, v.w, v.h])).toEqual([
      ["thumb", 160, 120],
      ["card", 480, 360],
      ["hero", 1200, 900],
    ]);
    for (const v of p.variants) {
      for (const s of ["GPS", "Exif", "JFIF"])
        expect(has(v.bytes, s)).toBe(false);
      expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(processUpload(uploadBody(400, 300)).type).toBe("image/webp");
    const mixed = Buffer.concat([
      Buffer.from(jpeg(160, 120)),
      Buffer.from(riff([vp8l(480, 360)])),
      Buffer.from(riff([vp8l(1200, 900)])),
    ]);
    expect(code(() => processUpload(mixed))).toBe("media_invalid");
    expect(code(() => processUpload(jpegUploadBody(1000, 100)))).toBe(
      "media_invalid",
    );
    expect(mediaUrl({ id: "a", type: "image/jpeg" }, "card")).toBe(
      "/media/a/card.jpg",
    );
    expect(mediaUrl({ id: "a" }, "card")).toBe("/media/a/card.webp");
  });
});

describe("the browser's check of the original file (§2.9)", () => {
  const png = (w: number, h: number) => {
    const b = new Uint8Array(33);
    b.set([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48,
      0x44, 0x52,
    ]);
    const v = new DataView(b.buffer);
    v.setUint32(16, w);
    v.setUint32(20, h);
    return b;
  };
  const jpeg = (w: number, h: number) =>
    new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe0,
      0,
      16,
      ...new Array(14).fill(0),
      0xff,
      0xc0,
      0,
      17,
      8,
      h >> 8,
      h & 0xff,
      w >> 8,
      w & 0xff,
      3,
      ...new Array(9).fill(0),
    ]);
  it("sniffs the real type and reads declared sizes without decoding", () => {
    expect(sniffType(png(10, 10))).toBe("image/png");
    expect(sniffType(jpeg(10, 10))).toBe("image/jpeg");
    expect(sniffType(TINY_WEBP)).toBe("image/webp");
    expect(declaredSize(png(4000, 3000))).toEqual({ w: 4000, h: 3000 });
    expect(declaredSize(jpeg(1024, 768))).toEqual({ w: 1024, h: 768 });
    expect(declaredSize(riff([vp8l(640, 480)]))).toEqual({ w: 640, h: 480 });
  });
  it("refuses HEIC, unknown types, over 10 MB and over 40 megapixels (a huge declared size is refused before any decode)", () => {
    const heic = new Uint8Array([
      0,
      0,
      0,
      24,
      ...[..."ftypheic"].map((c) => c.charCodeAt(0)),
      0,
      0,
      0,
      0,
    ]);
    expect(checkOriginal(heic, 100)).toBe("media_type_unsupported");
    expect(checkOriginal(new Uint8Array([1, 2, 3, 4]), 4)).toBe(
      "media_type_unsupported",
    );
    expect(checkOriginal(png(100, 100), MEDIA_LIMITS.maxBytes + 1)).toBe(
      "media_too_large",
    );
    expect(checkOriginal(png(50_000, 50_000), 1000)).toBe("media_too_large");
    expect(checkOriginal(png(8000, 5000), 1000)).toBe(null);
    expect(checkOriginal(png(8001, 5000), 1000)).toBe("media_too_large");
  });
});

// AWS Signature Version 4 test suite (awslabs/aws-c-auth, tests/aws-signing-test-suite/v4,
// fetched 2026-10-09): credentials AKIDEXAMPLE / the suite's documented example secret key,
// region us-east-1, service "service", 2015-08-30T12:36:00Z. Expected signatures are the suite's
// header-signature.txt values.
describe("SigV4 signer (R2 media store)", () => {
  const base = {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "service",
    amzDate: "20150830T123600Z",
  };
  const empty =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  it("get-vanilla", () => {
    const r = signV4({
      ...base,
      method: "GET",
      path: "/",
      headers: {
        Host: "example.amazonaws.com",
        "X-Amz-Date": "20150830T123600Z",
      },
      payloadHash: empty,
    });
    expect(r.canonicalRequest).toBe(
      "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n" +
        empty,
    );
    expect(r.stringToSign).toBe(
      "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
    );
    expect(r.signature).toBe(
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(r.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });
  it("get-vanilla-query-order-key-case", () => {
    const r = signV4({
      ...base,
      method: "GET",
      path: "/",
      query: { Param2: "value2", Param1: "value1" },
      headers: {
        host: "example.amazonaws.com",
        "x-amz-date": "20150830T123600Z",
      },
      payloadHash: empty,
    });
    expect(r.signature).toBe(
      "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });
  it("post-x-www-form-urlencoded (signed body)", () => {
    const body =
      "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e";
    const r = signV4({
      ...base,
      method: "POST",
      path: "/",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Host: "example.amazonaws.com",
        "Content-Length": "13",
        "x-amz-content-sha256": body,
        "X-Amz-Date": "20150830T123600Z",
      },
      payloadHash: body,
    });
    expect(r.signature).toBe(
      "d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b",
    );
  });
});

describe("an upload with no media store (KIOSK-OPS-1, LD-95)", () => {
  it("is refused with media_store_not_configured before any database work; MEDIA_FS_ROOT alone never makes a local store", async () => {
    vi.stubEnv("MEDIA_STORE", "");
    vi.stubEnv("MEDIA_FS_ROOT", "/app/media");
    vi.stubEnv("MENU_PHOTOS_ENABLED", "");
    try {
      expect(mediaStore()).toBeNull();
      const manager = { role: "manager" } as unknown as Session;
      await expect(
        uploadProductImage(
          null as never,
          manager,
          { operationId: randomUUID(), productId: randomUUID() },
          Buffer.alloc(0),
        ),
      ).rejects.toMatchObject({
        code: "media_store_not_configured",
        status: 503,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
