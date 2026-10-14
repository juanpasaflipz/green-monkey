import "dotenv/config";
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Histórico de plataformas (041, docs/DELIVERY_HISTORY.md) smoke: the demo owner opens Finanzas ›
// Histórico de plataformas, sees the "not Green Monkey sales" note, uploads the fictional
// gm-delivery-sales fixture (aimed at the demo restaurant, exported "now" so it is always the
// newest), checks the server preview, confirms the restaurant, imports, and reads the history for
// the fixture's days, the pending payout mark included.
const tenantId = "10000000-0000-4000-8000-000000000001";
const OWNER_PASSWORD = "demo-green-monkey";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

async function login(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Hoy", exact: true })).toBeVisible();
}

test("Finanzas › Histórico de plataformas: note, server preview, confirm, import, read the days, axe", async ({ page }) => {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/delivery-sales.json", import.meta.url), "utf8"));
  const file = { ...fixture, targetTenantId: tenantId, exportedAt: new Date().toISOString() };
  await login(page);
  await page.locator("nav.rail").getByRole("button", { name: "Finanzas", exact: true }).click();
  await page.getByRole("tab", { name: "Histórico de plataformas", exact: true }).click();
  const view = page.locator("section.delivery-history");
  await expect(view.getByRole("heading", { name: "Histórico de plataformas" })).toBeVisible();
  await expect(view.getByRole("note").first()).toContainText("Uber Eats, Rappi y DiDi Food");
  await expect(view.getByRole("note").first()).toContainText("no forman parte de las ventas, el IVA");
  // Finanzas' 92-day picker is not shown: the history has its own range.
  await expect(page.getByRole("group", { name: "Rango de fechas" })).toHaveCount(0);

  await view.getByText("Importar histórico de plataformas").click();
  await view.getByLabel("Archivo de plataformas (.json)").setInputFiles({
    name: "delivery-sales.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(file)),
  });
  const preview = view.locator(".history-preview");
  await expect(preview).toContainText("Archivo de plataformas: Taquería Demo");
  await expect(preview).toContainText("6 días · 13 pedidos");
  await expect(preview).toContainText("Uber Eats: del 2026-05-01 al 2026-05-03");
  await expect(preview).toContainText("Cuadra");
  await expect(preview.getByText("Filas rechazadas: 8")).toBeVisible();
  const importar = preview.getByRole("button", { name: "Importar", exact: true });
  await expect(importar).toBeDisabled();
  await preview.getByLabel("Confirmo que es mi restaurante").check();
  await importar.click();
  await expect(view.getByText(/Importado: 13 pedidos en 6 días/)).toBeVisible();

  await view.getByLabel("Desde").fill("2026-05-01");
  await view.getByLabel("Hasta").fill("2026-05-03");
  const tiles = view.locator(".history-tile");
  await expect(tiles.filter({ hasText: "Pedidos" })).toContainText("13");
  // Rappi's first day has no commission: the tile says how many days lack it.
  await expect(tiles.filter({ hasText: "Comisiones" })).toContainText("1 días sin dato");
  const byDay = view.getByRole("table", { name: "Por día" });
  await expect(byDay.getByRole("row").filter({ hasText: "2026-05-03" })).toContainText("pago pendiente");
  await expect(view.getByRole("table", { name: "Por plataforma" }).getByRole("row").filter({ hasText: "Rollos Demo" })).toBeVisible();
  await expect(view.getByRole("button", { name: "Exportar días (CSV)" })).toBeVisible();
  const axe = await new AxeBuilder({ page }).include("section.delivery-history").withTags(AXE_TAGS).analyze();
  expect(axe.violations).toEqual([]);
});
