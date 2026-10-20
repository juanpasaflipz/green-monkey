/* global document, innerWidth, getComputedStyle, console */
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400)
      errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto("http://127.0.0.1:5191");
  await page.evaluate(() => document.fonts.ready);
  await mkdir("prototypes/kiosk/evidence", { recursive: true });
  await page.locator("#appearance-toggle").click();
  for (const palette of ["forest", "clay", "ocean", "plum"]) {
    await page
      .locator(`input[name=appearance-palette][value=${palette}]`)
      .check();
    for (const font of ["signature", "modern", "editorial"]) {
      await page.locator("#appearance-font").selectOption(font);
      await expect(page.locator("html")).toHaveAttribute(
        "data-palette",
        palette,
      );
      await expect(page.locator("html")).toHaveAttribute("data-font", font);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
    }
    const contrast = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const luminance = (token) => {
        const hex = style.getPropertyValue(token).trim().slice(1);
        const rgb = [0, 2, 4]
          .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
          .map((c) =>
            c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
          );
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      return [
        ratio(1, luminance("--green")),
        ratio(luminance("--muted"), luminance("--panel")),
        ratio(luminance("--ink"), luminance("--cream")),
      ];
    });
    for (const ratio of contrast) expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
  await page.locator("#appearance-save").click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "plum");
  await expect(page.locator("html")).toHaveAttribute("data-font", "editorial");
  await page.locator("#appearance-toggle").click();
  await page.locator('input[value="ocean"]').check();
  await page.locator("#appearance-cancel").click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "plum");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({
    path: "prototypes/kiosk/evidence/appearance-editor.png",
    fullPage: true,
  });
  await page.locator("#appearance-reset").click();
  await page.locator("#appearance-save").click();
  await page.locator("#appearance-close").click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "forest");
  await expect(page.locator("html")).toHaveAttribute("data-font", "signature");
  await expect(page.locator("#review-button")).toBeDisabled();
  await page.getByRole("button", { name: "Ensaladas", exact: true }).click();
  await expect(page.locator(".product")).toHaveCount(1);
  await page.getByRole("button", { name: "Todo el menú" }).click();
  await expect(page.locator(".product")).toHaveCount(4);
  await page
    .getByRole("button", { name: "Pollo al limón, $185, personalizar" })
    .click();
  await page.getByLabel("Extra de aguacate").check();
  await page.getByLabel("Aderezo aparte").check();
  await page.getByRole("button", { name: "Agregar al pedido · $215" }).click();
  await expect(page.locator("#cart-total")).toHaveText("$215");
  await page
    .locator("#cart-lines")
    .getByRole("button", { name: "Editar", exact: true })
    .click();
  await expect(page.getByLabel("Extra de aguacate")).toBeChecked();
  await page.getByLabel("Extra de aguacate").uncheck();
  await page.getByRole("button", { name: "Guardar cambios · $185" }).click();
  await page.screenshot({
    path: "prototypes/kiosk/evidence/menu-desktop.png",
    fullPage: true,
  });
  await page.locator("#review-button").click();
  await expect(page.locator("#review-total")).toHaveText("$185");
  await expect(page.locator("#name-keyboard")).toBeHidden();
  await page
    .getByRole("textbox", { name: "¿A nombre de quién? Opcional" })
    .click();
  for (const letter of ["A", "N", "A"]) {
    await page
      .getByRole("button", { name: `Escribir ${letter}`, exact: true })
      .click();
  }
  await expect(page.locator("#pickup-name")).toHaveValue("Ana");
  await page.getByRole("button", { name: "Listo ✓", exact: true }).click();
  await expect(page.locator("#name-keyboard")).toBeHidden();
  await page.locator("#back-menu").click();
  await page.locator("#review-button").click();
  await expect(page.locator("#pickup-name")).toHaveValue("Ana");
  await page.screenshot({
    path: "prototypes/kiosk/evidence/review-name-desktop.png",
    fullPage: true,
  });
  await page.locator("#pay-button").click();
  await expect(page.locator("#payment-screen")).toContainText(
    "Pedido a nombre de Ana",
  );
  await page
    .getByRole("button", { name: "Respuesta pendiente", exact: true })
    .click();
  await expect(page.locator("#payment-screen")).toContainText(
    "No vuelvas a pagar",
  );
  await expect(
    page.getByRole("button", { name: "Reintentar pago" }),
  ).toHaveCount(0);
  await expect(page.locator("[data-service=here]")).toBeDisabled();
  await expect(page.locator("#restart-button")).toBeHidden();
  await page.getByRole("button", { name: "Rechazar", exact: true }).click();
  await page
    .getByRole("button", { name: "Volver a mi pedido", exact: true })
    .click();
  await expect(page.locator("#pickup-name")).toHaveValue("Ana");
  await page.locator("#pay-button").click();
  await page.getByRole("button", { name: "Rechazar", exact: true }).click();
  await page.getByRole("button", { name: "Reintentar pago" }).click();
  await expect(page.locator(".payment-amount")).toHaveText("$185");
  await page.screenshot({
    path: "prototypes/kiosk/evidence/payment-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Aprobar", exact: true }).click();
  await expect(page.locator("#payment-screen")).toContainText(
    "PAGO CONFIRMADO",
  );
  await expect(page.locator("#payment-screen h1")).toHaveText("¡Listo, Ana!");
  await expect(page.locator("#payment-screen")).toContainText(
    "Te llamaremos por Ana",
  );
  await page.getByRole("button", { name: "Empezar un nuevo pedido" }).click();
  await expect(page.locator("#cart-total")).toHaveText("$0");
  await expect(page.locator("#pickup-name")).toHaveValue("");
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 1024 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    expect(overflow, `No horizontal overflow at ${width}`).toBe(false);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "prototypes/kiosk/evidence/menu-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Pollo al limón, $185, personalizar" })
    .click();
  await page.screenshot({
    path: "prototypes/kiosk/evidence/customization-mobile.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(page.locator("#product-dialog")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Pollo al limón, $185, personalizar" })
    .click();
  await page.getByRole("button", { name: "Agregar al pedido · $185" }).click();
  await page.locator("#review-button").click();
  await page.locator("#pickup-name").click();
  await page.screenshot({
    path: "prototypes/kiosk/evidence/review-name-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.locator("#pickup-name").fill("   ");
  await page.getByRole("button", { name: "Listo ✓", exact: true }).click();
  await page.locator("#pay-button").click();
  await page.getByRole("button", { name: "Aprobar", exact: true }).click();
  await expect(page.locator("#payment-screen h1")).toHaveText(
    "¡Buen provecho!",
  );
  await expect(page.locator("#payment-screen")).toContainText(
    "Te llamaremos por tu número",
  );
  expect(errors).toEqual([]);
  console.log(
    "Passed: 12 appearance combinations, theme contrast, save/reload/discard/reset, categories, customization, names, totals, payment recovery, responsive overflow, dialogs, and asset/runtime checks.",
  );
} finally {
  await browser.close();
}
