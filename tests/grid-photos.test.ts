// POS selling-grid photos (kiosk 039, specs/kiosk-w4.md §2.9): the per-device «Pantalla» choice
// (on by default for terminals, off for phones) and the tile's art box (a lazy, decorative photo
// over the initials, sized by the box, never a broken image). The browser suite checks the fixed
// box, the toggle and a photo that fails to load.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { gridPhotosOn, parseDisplaySettings } from "../src/display";
import { ProductArt, initials } from "../src/features/ProductArt";

describe("«Pantalla»: grid photos per device", () => {
  it("defaults to the device kind: on for a terminal, off for a phone", () => {
    const unset = parseDisplaySettings(null);
    expect(unset).toEqual({ gridPhotos: null });
    expect(gridPhotosOn(unset, "terminal")).toBe(true);
    expect(gridPhotosOn(unset, "personal")).toBe(false);
    // A session without access data (an older server) is treated as a terminal.
    expect(gridPhotosOn(unset, undefined)).toBe(true);
  });
  it("an explicit choice wins on either kind; anything unexpected reads as unset", () => {
    expect(gridPhotosOn({ gridPhotos: false }, "terminal")).toBe(false);
    expect(gridPhotosOn({ gridPhotos: true }, "personal")).toBe(true);
    expect(parseDisplaySettings('{"gridPhotos":false}')).toEqual({
      gridPhotos: false,
    });
    for (const raw of ["not json", "[]", '{"gridPhotos":"yes"}', "null"])
      expect(parseDisplaySettings(raw)).toEqual({ gridPhotos: null });
  });
});

describe("the tile's art box", () => {
  const product = {
    name: { es: "Taco ficticio de prueba", en: "Fictional test taco" },
    image: { id: "8f6f3b0e-2f5c-4c1e-9a7d-0b1c2d3e4f50", w: 1200, h: 900 },
  };
  const render = (photos: boolean, p: object = product) =>
    renderToStaticMarkup(
      createElement(ProductArt, {
        product: p as never,
        locale: "es",
        index: 5,
        photos,
      }),
    );
  it("shows the photo lazily, decoded off the main thread, decorative, at the thumbnail's size, over the initials", () => {
    const html = render(true);
    expect(html).toContain('class="product-art art-1"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(">Tf<");
    expect(html).toMatch(/<img class="product-photo"/);
    expect(html).toContain(`src="/media/${product.image.id}/thumb.webp"`);
    expect(html).toContain(`/media/${product.image.id}/card.webp 480w`);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('alt=""');
    expect(html).toContain('width="160"');
    expect(html).toContain('height="120"');
  });
  it("no photo when the device has them off or the product has none: the initials stay", () => {
    expect(render(false)).not.toContain("<img");
    const { image: _image, ...plain } = product;
    expect(render(true, plain)).not.toContain("<img");
    expect(render(false)).toContain(">Tf<");
    expect(initials("Agua")).toBe("A");
  });
});
