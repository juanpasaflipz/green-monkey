import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("marketing page is responsive, accessible and routes to real app access", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Menos vueltas.",
  );
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [768, 1024],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(result.violations).toEqual([]);
    await page.screenshot({ path: `docs/evidence/landing-hero-${width}.png` });
    await page.screenshot({
      path: `docs/evidence/landing-${width}.png`,
      fullPage: true,
    });
  }
  await page
    .getByRole("button", { name: "Anual · 2 meses gratis", exact: true })
    .click();
  const pro = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Pro", exact: true }) });
  await expect(pro).toContainText("7,990");
  await expect(pro).toContainText("1,598");
  await page.getByRole("link", { name: "Consultar disponibilidad" }).click();
  await expect(page.locator("#availability")).toBeInViewport();
  await page.getByRole("button", { name: "Cocina", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Cada ticket, en su lugar." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Hoy", exact: true }).click();
  await expect(page.getByText("VENTAS NETAS · DATOS FICTICIOS")).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: "¿El kiosco viene con Pro?" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Sí. Kiosco y pedidos QR forman parte", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Switch to English" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Less back and forth.",
  );
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Less back and forth.",
  );
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByLabel("Password or PIN")).toBeVisible();
});
