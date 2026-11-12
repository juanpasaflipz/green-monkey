import "dotenv/config";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import postgres from "postgres";

// Guest marketing on the club (047, docs/MARKETING.md). The demo owner switches the club and
// marketing on for this file only; afterAll switches both off and restores the privacy notice.
// The web server runs with MARKETING_SMS_SEND=1 and no worker, so messages queue and none is sent.
test.describe.configure({ mode: "serial" });
const tenantId = "10000000-0000-4000-8000-000000000001";
const NOTICE = "https://example.com/aviso-de-privacidad-club";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const tag = Math.random().toString(36).slice(2, 8).toUpperCase();

/** Local fixture database only (same guard as loyalty.spec). */
async function inTenant<T>(
  baseURL: string | undefined,
  fn: (tx: any) => Promise<T>,
) {
  const runtime = new URL(process.env.DATABASE_URL ?? "http://invalid"),
    migration = new URL(process.env.MIGRATION_DATABASE_URL ?? "http://invalid"),
    base = new URL(baseURL ?? "http://invalid");
  if (
    !["localhost", "127.0.0.1"].includes(runtime.hostname) ||
    runtime.hostname !== migration.hostname ||
    runtime.port !== migration.port ||
    runtime.pathname !== migration.pathname ||
    !/^\/green_monkey(_[a-z][a-z0-9]*)?_dev$/.test(runtime.pathname) ||
    !["localhost", "127.0.0.1"].includes(base.hostname)
  )
    throw Error("Marketing fixtures require the isolated local dev database");
  const admin = postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1 });
  try {
    return (await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${tenantId},true)`;
      return fn(tx);
    })) as T;
  } finally {
    await admin.end();
  }
}
async function login(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
}
async function clubSettings(page: Page) {
  await page
    .locator("nav.rail")
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  const panel = page.locator("section.loyalty-settings");
  await expect(
    panel.getByRole("heading", { name: "Club de lealtad", exact: true }),
  ).toBeVisible();
  return panel;
}
async function axe(page: Page, include: string) {
  const r = await new AxeBuilder({ page })
    .include(include)
    .withTags(AXE_TAGS)
    .analyze();
  expect(
    r.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`,
    ),
  ).toEqual([]);
}

let previousNotice: string | null = null;
test.beforeAll(async ({ baseURL }) => {
  await inTenant(baseURL, async (tx) => {
    const [row] =
      await tx`select privacy_notice_url from restaurant_account_settings where tenant_id=${tenantId}`;
    previousNotice = row?.privacy_notice_url ?? null;
    await tx`insert into restaurant_account_settings(tenant_id,privacy_notice_url) values(${tenantId},${NOTICE})
      on conflict (tenant_id) do update set privacy_notice_url=excluded.privacy_notice_url`;
    await tx`update loyalty_settings set enabled=false where tenant_id=${tenantId}`;
    await tx`update marketing_settings set settings=settings||'{"enabled":false}' where tenant_id=${tenantId}`;
  });
});
test.afterAll(async ({ baseURL }) => {
  await inTenant(baseURL, async (tx) => {
    await tx`update marketing_settings set settings=settings||'{"enabled":false}' where tenant_id=${tenantId}`;
    await tx`update marketing_campaigns set state='cancelled',scheduled_at=null where tenant_id=${tenantId} and state='scheduled'`;
    await tx`update loyalty_settings set enabled=false where tenant_id=${tenantId}`;
    await tx`update restaurant_account_settings set privacy_notice_url=${previousNotice} where tenant_id=${tenantId}`;
  });
});

test("marketing appears with the club, switches on, and a campaign is drafted, scheduled and cancelled", async ({
  page,
}) => {
  await login(page);
  const club = await clubSettings(page);
  await expect(page.locator("section.marketing-panel")).toHaveCount(0);
  await club.getByLabel("Activar el club").check();
  await club.getByLabel(/Mi aviso de privacidad incluye el club/).check();
  await club
    .getByRole("button", { name: "Guardar club de lealtad", exact: true })
    .click();
  await page.reload();
  await clubSettings(page);
  const panel = page.locator("section.marketing-panel");
  await expect(
    panel.getByRole("heading", { name: "Marketing", exact: true }),
  ).toBeVisible();
  await expect(panel).toContainText("Teléfono confirmado");
  // The send switches belong to the environment (off in CI): the panel reports them and
  // the spec follows whichever state the server runs with.
  await expect(panel).toContainText("WhatsApp: sin habilitar");
  const smsOn = await panel.getByText(/SMS: habilitado/).count();

  await panel.getByLabel("Activar marketing del club").check();
  await panel
    .getByRole("button", { name: "Guardar opciones de marketing", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText(
    "Opciones de marketing guardadas.",
  );

  await panel
    .getByRole("button", { name: "Nueva campaña", exact: true })
    .click();
  const name = "Martes de tacos " + tag;
  await panel.getByLabel("Nombre de la campaña").fill(name);
  await panel
    .getByLabel("Mensaje", { exact: true })
    .fill("Hola {{name}}, este martes te esperamos en {{restaurant}}.");
  await panel.getByLabel("Visitas mínimas (opcional)").fill("1");
  await panel
    .getByRole("button", { name: "Calcular audiencia", exact: true })
    .click();
  await expect(panel.getByText(/Recibirán el mensaje/)).toBeVisible();
  await axe(page, "section.marketing-panel");
  await panel
    .getByRole("button", { name: "Guardar borrador", exact: true })
    .click();
  const card = panel
    .locator("article.marketing-card")
    .filter({ hasText: name });
  await expect(card).toContainText("Borrador");

  await card
    .getByRole("button", { name: "Enviar o programar", exact: true })
    .click();
  if (!smsOn) {
    // No channel enabled: the campaign cannot be sent or scheduled, and says why.
    await expect(card.getByRole("status")).toContainText(
      "Ningún canal de esta campaña está habilitado todavía.",
    );
    await expect(
      card.getByRole("button", { name: "Enviar ahora", exact: true }),
    ).toBeDisabled();
  } else {
    const future = new Date(Date.now() + 2 * 86_400_000);
    const local = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}T12:00`;
    await card.getByLabel(/Fecha y hora/).fill(local);
    await card.getByRole("button", { name: "Programar", exact: true }).click();
    await expect(card).toContainText("Programada");
    await card
      .getByRole("button", { name: "Cancelar envío", exact: true })
      .click();
    await expect(card).toContainText("Cancelada");
  }

  const followUp = panel
    .locator("article.marketing-card")
    .filter({ hasText: "Seguimiento de visita" });
  await followUp.getByRole("button", { name: /Configurar/ }).click();
  await followUp
    .getByRole("button", { name: "Guardar y activar", exact: true })
    .click();
  await expect(followUp).toContainText("Activa");
  await expect(panel).toContainText("Venta atribuida");
  await panel.screenshot({ path: "test-results/marketing-panel-1440.png" });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    panel.getByRole("heading", { name: "Marketing", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await axe(page, "section.marketing-panel");
});

test("the confirmation page needs an explicit tap and fails closed on a bad link", async ({
  page,
}) => {
  await page.goto("/club/confirm#not-a-token");
  await expect(page.getByRole("alert")).toContainText(
    "Este enlace no es válido",
  );
  const id = "10000000-0000-4000-8000-000000000001";
  await page.goto(`/club/confirm#${id}.${id}.${"a".repeat(43)}`);
  await page.reload();
  const confirm = page.getByRole("button", {
    name: "Sí, quiero recibir promociones",
    exact: true,
  });
  await expect(confirm).toBeVisible();
  await axe(page, "main");
  await confirm.click();
  await expect(page.getByRole("alert")).toContainText(
    "Este enlace no es válido",
  );
});
