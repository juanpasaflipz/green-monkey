import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Guest pages follow the browser language; the acceptance run is in Spanish.
test.use({ locale: "es-MX" });
const tag = Math.random().toString(36).slice(2, 8).toUpperCase();
const code = "WEB" + tag;
const email = `web.${tag.toLowerCase()}@example.com`;
const shot = (name: string) => `test-results/marketing/${name}.png`;
async function login(page: any) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
}
const marketingTab = (page: any, name: string) =>
  page
    .getByRole("navigation", { name: "Marketing" })
    .getByRole("button", { name, exact: true })
    .click();
const axe = async (page: any) => {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
};

test("promotion code, guest capture and discounted receipt at the register", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Marketing", exact: true }).click();
  await page.getByRole("button", { name: "Nueva promoción" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nombre").fill("Diez web " + tag);
  await dialog.getByLabel("Valor (%)").fill("10");
  await dialog.getByLabel("Código (opcional)").fill(code);
  await dialog.screenshot({ path: shot("promotion-editor-1440") });
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(page.getByText(`Código: ${code}`)).toBeVisible();
  await axe(page);

  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  const open = page.getByRole("button", { name: "Abrir caja", exact: true });
  await expect(
    open.or(page.getByText("Caja abierta", { exact: true })),
  ).toBeVisible();
  if (await open.isVisible()) {
    await open.click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Guardar", exact: true })
      .click();
    await expect(page.getByText("Caja abierta", { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await page.getByRole("button", { name: /Agua de jamaica/ }).click();
  await page.getByLabel("Nombre para llamar").fill("Web " + tag);
  const cart = page.locator(".cart").first();
  await cart.getByLabel("Código de promoción").fill(code.toLowerCase());
  await cart.getByRole("button", { name: "Aplicar", exact: true }).click();
  await expect(cart.getByText("Código aplicado")).toBeVisible();
  await expect(cart.getByText("Diez web " + tag)).toBeVisible();
  await cart.getByRole("button", { name: "+ Agregar cliente" }).click();
  const guest = page.getByRole("dialog");
  await guest.getByLabel("Correo").fill(email);
  await guest.getByLabel("Acepto recibir promociones por correo").check();
  await guest.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(cart.getByText(`Cliente: ${email}`)).toBeVisible();
  await page.screenshot({ path: shot("cart-discount-1440") });
  const due = await cart.locator(".total strong").innerText();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  const receipt = page.locator(".receipt");
  await expect(receipt).toContainText("Cobrado");
  await expect(receipt).toContainText("Diez web " + tag);
  await expect(receipt).toContainText(due);
  await page.screenshot({ path: shot("receipt-discount-1440") });
  await page
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();

  await page.getByRole("button", { name: "Marketing", exact: true }).click();
  await marketingTab(page, "Clientes");
  await page.getByLabel("Buscar por nombre, correo o teléfono").fill(email);
  const row = page.getByRole("row").filter({ hasText: email });
  await expect(row).toContainText("Correo");
  await expect(row).toContainText("1");
  await page.screenshot({ path: shot("guests-1440") });
});

test("campaigns, automations, results, assistant and channel status", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Marketing", exact: true }).click();
  await marketingTab(page, "Campañas");
  await page.getByRole("button", { name: "Nueva campaña" }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("Nombre").fill("Campaña web " + tag);
  await editor.getByLabel("Asunto (correo)").fill("Hola de {{restaurant}}");
  await editor
    .getByLabel("Mensaje")
    .fill("Hola {{name}}, te esperamos.{{offer}}");
  await editor.getByRole("button", { name: "Calcular audiencia" }).click();
  await expect(editor.getByText(/Recibirán mensaje/)).toBeVisible();
  await editor.screenshot({ path: shot("campaign-editor-1440") });
  await editor.getByRole("button", { name: "Guardar", exact: true }).click();
  const card = page
    .locator("article")
    .filter({ hasText: "Campaña web " + tag });
  await expect(card).toContainText("Borrador");
  await card.getByRole("button", { name: /Enviar ahora/ }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText("Canal sin configurar");
  await expect(
    confirm.getByRole("button", { name: "Enviar ahora", exact: true }),
  ).toBeDisabled();
  await confirm.getByRole("button", { name: "Cerrar" }).click();
  await axe(page);

  await marketingTab(page, "Automatizaciones");
  const welcome = page.locator("article").filter({ hasText: "Bienvenida" });
  await welcome.getByRole("button", { name: "Configurar" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar · Activar" })
    .click();
  await expect(welcome).toContainText("Activa");
  await expect(
    page.locator("article").filter({ hasText: "programa de lealtad" }),
  ).toContainText("No disponible");
  await page.screenshot({ path: shot("automations-1440"), fullPage: true });
  await welcome.getByRole("button", { name: "Pausar" }).click();
  await expect(welcome).toContainText("Pausada");

  await marketingTab(page, "Resultados");
  await expect(page.getByText("Venta atribuida")).toBeVisible();
  await page.screenshot({ path: shot("results-1440"), fullPage: true });
  await axe(page);

  await marketingTab(page, "Asistente");
  await expect(
    page.getByRole("heading", { name: "Plan del mes" }),
  ).toBeVisible();
  await page
    .getByLabel("¿Qué quieres lograr?")
    .fill("llenar los martes con el burrito de la casa");
  await page.getByRole("button", { name: "Generar borrador" }).click();
  await expect(page.locator(".assistant-draft")).toContainText(
    "llenar los martes",
  );
  await expect(page.locator(".assistant-draft")).toContainText("Plantilla");
  await page.screenshot({ path: shot("assistant-1440"), fullPage: true });

  await marketingTab(page, "Configuración");
  await expect(page.getByText("No activado").first()).toBeVisible();
  await page.screenshot({ path: shot("settings-1440"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await marketingTab(page, "Campañas");
  await expect(card).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: shot("campaigns-390") });
});

test("QR guest enters a code, opts in and leaves feedback; bad unsubscribe links fail closed", async ({
  page,
}) => {
  await login(page);
  const path = await page.evaluate(async () => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch("/api/ordering-links", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": session.csrf,
      },
      body: JSON.stringify({ channel: "qr", tableId: null }),
    });
    return (await response.json()).path as string;
  });
  await page.goto(path);
  await page.getByRole("button", { name: /Agua de jamaica/ }).click();
  await page.getByLabel("Código de promoción").fill("NOEXISTE");
  await page.getByRole("button", { name: "Aplicar", exact: true }).click();
  await expect(page.getByText("Ese código no existe.")).toBeVisible();
  await page
    .getByRole("button", { name: "Quitar Código de promoción", exact: true })
    .click();
  await page.getByLabel("Correo").fill(`qr.${email}`);
  await page.getByLabel("Acepto recibir promociones por correo").check();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: shot("qr-order-390"), fullPage: true });
  await axe(page);
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.getByText("¿Cómo estuvo tu visita?")).toBeVisible();
  await page.getByRole("radio", { name: "5", exact: true }).click();
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await expect(page.getByText("¡Gracias por tu opinión!")).toBeVisible();

  await page.goto("/u/not-a-real-token");
  await expect(page.getByText("Este enlace no es válido.")).toBeVisible();
  await page.screenshot({ path: shot("unsubscribe-390") });
});
