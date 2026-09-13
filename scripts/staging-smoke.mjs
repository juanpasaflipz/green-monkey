/* global process, URL, document, innerWidth, console */
import { chromium } from "@playwright/test";
import { expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
const url = process.env.STAGING_URL;
if (
  !url ||
  new URL(url).origin !== process.env.STAGING_ORIGIN_ALLOWLIST ||
  !process.env.FIXTURE_OWNER_PASSWORD
)
  throw Error(
    "Explicit staging URL, exact origin allowlist and fixture credentials required",
  );
const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: url,
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
page.setDefaultTimeout(30000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const evidence = "docs/evidence/staging";
await mkdir(evidence, { recursive: true });
try {
  const health = await context.request.get("/api/health");
  expect(health.status()).toBe(200);
  expect((await context.request.get("/api/session")).status()).toBe(401);
  await page.goto("/");
  await page
    .getByLabel("Contraseña o PIN")
    .fill(process.env.FIXTURE_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  const cookies = await context.cookies();
  for (const name of ["gm_session", "gm_device"]) {
    const cookie = cookies.find((c) => c.name === name);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.httpOnly).toBe(true);
  }
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  await page.getByRole("button", { name: "Abrir caja", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(page.getByText("Caja abierta", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [768, 1024],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `${evidence}/selling-${width}.png` });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press("/");
  await expect(
    page.getByRole("textbox", { name: "Buscar producto…" }),
  ).toBeFocused();
  await page.getByRole("button", { name: /Taco de asada/ }).click();
  await page.getByRole("radio").first().check();
  await page
    .getByRole("button", { name: "Agregar a la orden", exact: true })
    .click();
  await page.getByRole("button", { name: /Agua de jamaica/ }).click();
  const callName = "Staging smoke " + Date.now();
  await page.getByLabel("Nombre para llamar").fill(callName);
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.locator(".existing")).toContainText("Enviado a cocina");
  await page
    .getByRole("button", { name: "Cocina", exact: true })
    .first()
    .click();
  const ticket = page
    .locator(".kitchen-ticket")
    .filter({ hasText: callName })
    .last();
  await ticket.getByRole("button", { name: "Confirmar recepción" }).click();
  await expect(ticket).toContainText("Cocina recibió");
  await ticket.getByRole("button", { name: "Marcar listo" }).click();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText("Cobrado");
  await page.screenshot({ path: `${evidence}/receipt-1440.png` });
  await page
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();
  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(a11y.violations).toEqual([]);
  expect(errors).toEqual([]);
  await writeFile(
    `${evidence}/smoke.json`,
    JSON.stringify(
      {
        url,
        at: new Date().toISOString(),
        callName,
        checks: [
          "health",
          "anonymous session denied",
          "owner login",
          "secure HttpOnly cookies",
          "four viewports without overflow",
          "keyboard search",
          "modifier",
          "kitchen acknowledgement",
          "ready",
          "cash payment",
          "receipt",
          "axe selling",
        ],
        axeViolations: a11y.violations.length,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS staging: login, modifier, kitchen, cash payment, receipt, four viewports, secure cookies and selling accessibility",
  );
} catch (e) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  throw e;
} finally {
  await browser.close();
}
