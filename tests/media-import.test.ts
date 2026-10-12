// «Importar fotos» (039; critic R42/Q7): the manifest, the name proposal the owner reviews, the
// per-item status, the replay-safe operation id and the report schema. Fictional names only.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { id } from "../shared/domain";
import {
  MEDIA_IMPORT_FORMAT,
  importDigestInput,
  importOperationId,
  importStatus,
  matchKey,
  mediaImportReportInput,
  mediaManifest,
  proposeMapping,
  type ImportProduct,
} from "../shared/media-import";

const uuid = () => crypto.randomUUID();
const product = (
  es: string,
  en = es,
  o: Partial<ImportProduct> = {},
): ImportProduct => ({
  id: uuid(),
  name: { es, en },
  version: 1,
  ...o,
});
const item = (sourceId: string, name: string, file = `${sourceId}.jpg`) => ({
  id: sourceId,
  name,
  file,
});
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("the manifest (docs/KIOSK.md §7)", () => {
  const ok = {
    format: MEDIA_IMPORT_FORMAT,
    source: "pos-lite",
    items: [item("101", "Taco inventado"), item("102", "Agua ficticia")],
  };
  it("takes the format, a source label and items with id, name and file", () => {
    expect(mediaManifest.parse(ok).items).toHaveLength(2);
  });
  it("refuses another format, repeated ids, paths or control characters in a file name, extra keys and an empty list", () => {
    for (const bad of [
      { ...ok, format: "gm-menu-media-v0" },
      { ...ok, items: [item("101", "A"), item("101", "B")] },
      { ...ok, items: [item("101", "A", "../fotos/a.jpg")] },
      { ...ok, items: [item("101", "A", "fotos\\a.jpg")] },
      { ...ok, items: [item("101", "A", "a\u0000.jpg")] },
      { ...ok, items: [item("101", "A", "..")] },
      {
        ...ok,
        items: [{ ...item("101", "A"), url: "https://example.com/a.jpg" }],
      },
      { ...ok, items: [item("id con espacio", "A")] },
      { ...ok, items: [] },
      { ...ok, extra: true },
    ])
      expect(mediaManifest.safeParse(bad).success).toBe(false);
  });
});

describe("the proposal the owner reviews", () => {
  it("matches names ignoring accents, case, punctuation and spacing, in Spanish or English", () => {
    expect(matchKey("  Café  de OLLA! ")).toBe("cafe de olla");
    const cafe = product("Café de olla ficticio", "Spiced coffee test");
    const flan = product("Flan inventado");
    const map = proposeMapping(
      [
        item("1", "CAFE DE OLLA FICTICIO"),
        item("2", "flan-inventado"),
        item("3", "spiced coffee test"),
      ],
      [cafe, flan],
    );
    expect(map["1"]).toBe(cafe.id);
    expect(map["2"]).toBe(flan.id);
    // The coffee already went to item 1: a product two items name goes to the first only.
    expect(map["3"]).toBeNull();
  });
  it("leaves an item unmapped when no active product or several share its name", () => {
    const twinA = product("Torta de prueba");
    const twinB = product("Torta de prueba");
    const archived = product("Sope retirado", "Sope retirado", {
      archived: true,
    });
    const map = proposeMapping(
      [
        item("1", "Torta de prueba"),
        item("2", "Sope retirado"),
        item("3", "Nada"),
      ],
      [twinA, twinB, archived],
    );
    expect(map).toEqual({ "1": null, "2": null, "3": null });
  });
  it("an item's status: no product, a product taken earlier, a missing file, a photo kept unless replacing, else ready", () => {
    const withPhoto = product("Con foto", "Con foto", {
      image: { id: uuid() },
    });
    const plain = product("Sin foto");
    const o = {
      files: new Set(["1.jpg", "2.jpg"]),
      products: [withPhoto, plain],
      replace: false,
      takenBefore: new Set<string>(),
    };
    expect(importStatus(item("1", "x"), null, o)).toBe("unmatched");
    expect(
      importStatus(item("1", "x"), plain.id, {
        ...o,
        takenBefore: new Set([plain.id]),
      }),
    ).toBe("duplicate");
    expect(importStatus(item("3", "x"), plain.id, o)).toBe("missing_file");
    expect(importStatus(item("1", "x"), withPhoto.id, o)).toBe("has_photo");
    expect(
      importStatus(item("1", "x"), withPhoto.id, { ...o, replace: true }),
    ).toBe("ready");
    expect(importStatus(item("2", "x"), plain.id, o)).toBe("ready");
  });
});

describe("the upload's operation id", () => {
  it("is a valid RFC 9562 id, the same for the same product version and bytes, and new when either changes", () => {
    const p = uuid();
    const file = sha("bytes of a generated test image");
    const a = importOperationId(sha(importDigestInput(p, 3, file)));
    expect(id.safeParse(a).success).toBe(true);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(importOperationId(sha(importDigestInput(p, 3, file)))).toBe(a);
    expect(importOperationId(sha(importDigestInput(p, 4, file)))).not.toBe(a);
    expect(
      importOperationId(sha(importDigestInput(p, 3, sha("other bytes")))),
    ).not.toBe(a);
    expect(() => importOperationId("not-a-digest")).toThrow();
  });
});

describe("the run's report", () => {
  const base = {
    operationId: uuid(),
    source: "pos-lite",
    manifestSha256: sha("manifest"),
    replace: false,
  };
  it("names every item's outcome; imported ones their asset", () => {
    const r = mediaImportReportInput.parse({
      ...base,
      items: [
        {
          id: "1",
          name: "Taco inventado",
          productId: uuid(),
          outcome: "imported",
          assetId: uuid(),
        },
        {
          id: "2",
          name: "Pozole inventado",
          productId: null,
          outcome: "unmatched",
        },
        {
          id: "3",
          name: "Flan inventado",
          productId: uuid(),
          outcome: "failed",
          code: "media_invalid",
        },
      ],
    });
    expect(r.items[1]).toEqual({
      id: "2",
      name: "Pozole inventado",
      productId: null,
      outcome: "unmatched",
      assetId: null,
      code: null,
    });
    for (const bad of [
      { id: "1", name: "x", productId: null, outcome: "maybe" },
      {
        id: "1",
        name: "x",
        productId: null,
        outcome: "failed",
        code: "Not A Code",
      },
    ])
      expect(
        mediaImportReportInput.safeParse({ ...base, items: [bad] }).success,
      ).toBe(false);
  });
});
