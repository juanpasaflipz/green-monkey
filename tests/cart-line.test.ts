import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Locale, Product } from "../shared/domain";
import { priceCart } from "../shared/service";
import { CartLine } from "../src/features/CartLine";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const product = (n: number, extra: Partial<Product> = {}): Product => ({
  id: id(n),
  name: { es: `Producto ${n}`, en: `Item ${n}` },
  category: { es: "Comida", en: "Food" },
  price: 4500,
  available: true,
  station: "kitchen",
  groups: [],
  cost: null,
  version: 1,
  ...extra,
});
const openPrice = product(1, { openAmount: true, openMax: 50000, price: 0 });
const plain = product(2);
const catalog = [openPrice, plain];

/** Undoes React's text escaping in server-rendered markup. */
const unescape = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** The alert text CartLine shows for the cart's only line. */
function alertOf(
  line: { id: number; productId: string; openAmount?: number },
  canOpen: boolean,
  locale: Locale = "es",
) {
  const cart = priceCart(
    [
      {
        id: id(100 + line.id),
        productId: line.productId,
        quantity: 1,
        options: [],
        note: "",
        ...(line.openAmount === undefined
          ? {}
          : { openAmount: line.openAmount }),
      },
    ],
    catalog,
    canOpen,
  );
  expect(cart.blocked).toBe(true);
  const html = renderToStaticMarkup(
    createElement(CartLine, {
      line: cart.lines[0],
      product: catalog.find((p) => p.id === line.productId),
      locale,
      money: (n: number) => String(n),
      justAdded: false,
      onQuantity: () => {},
      onRemove: () => {},
      onNote: () => {},
    }),
  );
  const alert = /<p class="error" role="alert">([^<]*)<\/p>/.exec(html);
  return { code: cart.lines[0].error, text: alert && unescape(alert[1]) };
}

describe("CartLine shows the real reason a line cannot be sold (LD-11 MENU-INT-4)", () => {
  it("an 86'd or archived product keeps service's short 'remove it' text", () => {
    expect(alertOf({ id: 1, productId: id(99) }, true)).toEqual({
      code: "unavailable",
      text: "No disponible. Quítalo para continuar.",
    });
    expect(alertOf({ id: 1, productId: id(99) }, true, "en")).toEqual({
      code: "unavailable",
      text: "Unavailable. Remove it to continue.",
    });
  });

  it("an open amount over the product's maximum says so, not 'unavailable'", () => {
    expect(
      alertOf({ id: 2, productId: openPrice.id, openAmount: 60000 }, true),
    ).toEqual({
      code: "open_amount_exceeds",
      text: "El importe supera el máximo permitido para este producto.",
    });
    expect(
      alertOf(
        { id: 2, productId: openPrice.id, openAmount: 60000 },
        true,
        "en",
      ),
    ).toEqual({
      code: "open_amount_exceeds",
      text: "The amount exceeds this item's allowed maximum.",
    });
  });

  it("a missing open amount and a refused open amount show their own messages", () => {
    expect(alertOf({ id: 3, productId: openPrice.id }, true)).toEqual({
      code: "invalid_amount",
      text: "Escribe un importe válido.",
    });
    expect(
      alertOf({ id: 4, productId: openPrice.id, openAmount: 1200 }, false),
    ).toEqual({
      code: "forbidden",
      text: "No tienes permiso para esta acción.",
    });
    expect(
      alertOf({ id: 5, productId: plain.id, openAmount: 1200 }, true),
    ).toEqual({
      code: "forbidden",
      text: "No tienes permiso para esta acción.",
    });
  });
});
