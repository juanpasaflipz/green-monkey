import "dotenv/config";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { legalContentHash } from "../../server/legal.js";
import { ownerCookie } from "../../server/owner-accounts.js";
import { LEGAL_CI_ENV } from "../fixtures/legal-ci.js";
import { LEGAL_DOCUMENTS } from "../../shared/legal.js";
import {
  PUBLISHED_LEGAL,
  deleteOwnerFixtures,
  fixtureDatabases,
  ownerFixture,
  ownerRestaurant,
  useOwnerCookie,
} from "./account-fixtures.js";

// account (031): legal acceptance, co-owners, transfer, recovery, export,
// restaurant privacy URL, help, plan notices and the public-ordering switch.
// The compiled browser run publishes the fictional CI legal set (LD-3).
const DEMO_TENANT = "10000000-0000-4000-8000-000000000001";
const OWNER_PASSWORD = "demo-green-monkey";

async function axe(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
}
/** The demo owner signs in with the password; this pairs the browser as a terminal. */
async function demoOwnerLogin(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
}
async function sessionOf(page: Page) {
  return page.evaluate(async () => (await fetch("/api/session")).json());
}
/** Calls the API as the page's current POS session. */
async function call(page: Page, path: string, body?: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const s = await (await fetch("/api/session")).json();
      const response = await fetch("/api" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body },
  );
}
const center = (page: Page) =>
  page.getByRole("region", { name: "Cuenta y propietarios" });
async function settings(page: Page) {
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  return page.getByRole("region", { name: "Privacidad y datos" });
}
async function downloadBytes(download: {
  path(): Promise<string>;
}): Promise<Buffer> {
  return readFileSync(await download.path());
}

test("signup requires accepting terms+DPA and acknowledging privacy; submit disabled until both (FIT-12)", async ({
  page,
  context,
  baseURL,
}) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  const owner = await ownerFixture(sql, "signup");
  try {
    await useOwnerCookie(context, owner, baseURL);
    await page.goto("/app");
    await page
      .getByLabel("Nombre del restaurante", { exact: true })
      .fill("Firma legal");
    const create = page.getByRole("button", {
      name: "Crear restaurante gratis",
      exact: true,
    });
    const terms = page.getByRole("checkbox", {
      name: "Acepto los Términos del servicio y el Contrato de encargo de datos de mi restaurante.",
      exact: true,
    });
    const privacy = page.getByRole("checkbox", {
      name: "Leí el Aviso de privacidad.",
      exact: true,
    });
    await expect(
      page.getByRole("group", { name: "Documentos legales" }),
    ).toBeVisible();
    await expect(create).toBeDisabled();
    await terms.check();
    await expect(create).toBeDisabled();
    await privacy.check();
    await expect(create).toBeEnabled();
    await terms.uncheck();
    await expect(create).toBeDisabled();
    await terms.check();
    await expect(create).toBeEnabled();
    // No re-acceptance panel doubles the form's checkboxes for a new account.
    await expect(
      page.getByRole("heading", { name: "Actualizamos nuestros documentos" }),
    ).toHaveCount(0);
    await axe(page);
    await create.click();
    await expect(page.locator(".scope")).toContainText("Firma legal");
    const rows =
      await admin`select document,version,published,context,organization_id is not null as organization
        from legal_acceptances where account_id=${owner.accountId} order by document`;
    expect(rows.map((r) => r.document)).toEqual(["dpa", "privacy", "terms"]);
    expect(rows.every((r) => r.published && r.context === "signup")).toBe(true);
    expect(rows.map((r) => r.organization)).toEqual([true, false, false]);
  } finally {
    await deleteOwnerFixtures(admin, [owner.accountId]);
    await sql.end();
    await admin.end();
  }
});

test("simplified privacy notice is shown next to Google sign-up (FOH-14)", async ({
  page,
}) => {
  // UI contract fixture: the compiled CI server has no Google client.
  await page.route("**/api/auth/providers", (route) =>
    route.fulfill({ json: { google: true, billingSandbox: false } }),
  );
  await page.goto("/app?signup");
  const notice = page.locator("#signup-privacy-notice");
  await expect(notice).toHaveText(
    `${LEGAL_CI_ENV.LEGAL_ENTITY_NAME} es responsable de tus datos personales. Usaremos tu nombre y correo de Google para crear y proteger tu cuenta, prestarte el servicio, facturar tu suscripción y darte soporte. No los usamos para publicidad. Para limitar su uso o ejercer tus derechos ARCO escribe a ${LEGAL_CI_ENV.LEGAL_PRIVACY_CONTACT_EMAIL}. Aviso de privacidad · Términos del servicio`,
  );
  await expect(
    page.getByRole("link", { name: "Continuar con Google", exact: true }),
  ).toHaveAttribute("aria-describedby", "signup-privacy-notice");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(notice).toContainText(
    `${LEGAL_CI_ENV.LEGAL_ENTITY_NAME} is the controller of your personal data.`,
  );
  await expect(
    notice.getByRole("link", { name: "Privacy notice", exact: true }),
  ).toHaveAttribute("href", "/legal/privacy");
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await axe(page);
  }
});

test("co-owner invitation link accepted by a second fictional account grants POS owner access (GAP-5)", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  const primary = await ownerFixture(sql, "primary");
  const coOwner = await ownerFixture(sql, "coowner");
  const other = await browser.newContext({ baseURL });
  try {
    await ownerRestaurant(sql, primary, "Copropiedad fixture");
    await useOwnerCookie(context, primary, baseURL);
    await page.goto("/app");
    const console = center(page);
    await expect(console).toContainText("Aún no hay copropietarios.");
    await console
      .getByLabel("Correo de Google del copropietario", { exact: true })
      .fill(coOwner.email);
    await console
      .getByRole("button", { name: "Crear invitación", exact: true })
      .click();
    const link = console.getByRole("textbox", {
      name: "Invitar copropietario",
    });
    await expect(link).toHaveValue(/#invite=/);
    await expect(console).toContainText(
      `Invitación pendiente para ${coOwner.email}`,
    );
    await axe(page);
    const url = new URL(await link.inputValue());

    await useOwnerCookie(other, coOwner, baseURL);
    const invited = await other.newPage();
    await invited.goto(url.pathname + url.search + url.hash);
    const panel = invited.locator(".panel").filter({
      hasText: "Te invitaron como copropietario de Copropiedad fixture",
    });
    await expect(panel).toBeVisible();
    const accept = panel.getByRole("button", {
      name: "Aceptar invitación",
      exact: true,
    });
    // A fresh account accepts the terms and the privacy notice here.
    await expect(accept).toBeDisabled();
    await panel
      .getByRole("checkbox", {
        name: "Acepto los Términos del servicio.",
        exact: true,
      })
      .check();
    await panel
      .getByRole("checkbox", {
        name: "Leí el Aviso de privacidad.",
        exact: true,
      })
      .check();
    await accept.click();
    const row = invited
      .locator(".row.between")
      .filter({ hasText: "Copropiedad fixture" });
    await row.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(invited.locator(".scope")).toContainText(
      "Copropiedad fixture",
    );
    const session = await sessionOf(invited);
    expect(session.role).toBe("owner");

    await page.reload();
    await expect(center(page)).toContainText(
      `Copropietario: ${coOwner.name} <${coOwner.email}>`,
    );
    const memberships =
      await admin`select 1 from organization_co_owners c join organizations o on o.id=c.organization_id
        where c.account_id=${coOwner.accountId} and o.created_by_account=${primary.accountId} and c.removed_at is null`;
    expect(memberships).toHaveLength(1);
  } finally {
    await other.close();
    await deleteOwnerFixtures(admin, [primary.accountId, coOwner.accountId]);
    await sql.end();
    await admin.end();
  }
});

test("ownership transfer: request, accept as target with DPA, previous owner sees co-owner role", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  const from = await ownerFixture(sql, "from");
  const to = await ownerFixture(sql, "to");
  const other = await browser.newContext({ baseURL });
  try {
    await ownerRestaurant(sql, from, "Traspaso fixture");
    await useOwnerCookie(context, from, baseURL);
    await page.goto("/app");
    const console = center(page);
    await console
      .getByLabel("Correo de Google de la nueva persona titular", {
        exact: true,
      })
      .fill(to.email);
    await expect(
      console.getByRole("checkbox", { name: "Seguir como copropietario" }),
    ).toBeChecked();
    await console
      .getByLabel("Escribe Traspaso fixture para confirmar", { exact: true })
      .fill("Traspaso fixture");
    await console
      .getByRole("button", {
        name: "Crear enlace de transferencia",
        exact: true,
      })
      .click();
    const link = console.getByRole("textbox", { name: "Transferir propiedad" });
    await expect(link).toHaveValue(/#transfer=/);
    await expect(console).toContainText(
      /Transferencia pendiente a t.*@example\.com/,
    );
    const url = new URL(await link.inputValue());

    await useOwnerCookie(other, to, baseURL);
    const target = await other.newPage();
    await target.goto(url.pathname + url.search + url.hash);
    const offer = center(target).getByRole("region", {
      name: "Transferir propiedad",
    });
    await expect(offer).toContainText(
      "Te ofrecen la titularidad de Traspaso fixture (1 sucursales).",
    );
    await expect(offer).toContainText(
      "La persona titular actual seguirá como copropietaria.",
    );
    const accept = offer.getByRole("button", {
      name: "Aceptar y convertirme en titular",
      exact: true,
    });
    await expect(accept).toBeDisabled();
    // The target contracts for the organization: terms plus its DPA.
    await offer
      .getByRole("checkbox", {
        name: "Acepto los Términos del servicio. Acepto el Contrato de encargo de datos de Traspaso fixture.",
        exact: true,
      })
      .check();
    await offer
      .getByRole("checkbox", {
        name: "Leí el Aviso de privacidad.",
        exact: true,
      })
      .check();
    await axe(target);
    await accept.click();
    await expect(center(target)).toContainText(
      "Ahora eres titular. Revisa dispositivos vinculados, la selección Free y el correo de facturación en Stripe.",
    );
    const [organization] =
      await admin`select o.created_by_account from organizations o join restaurants r on r.organization_id=o.id
        where r.name='Traspaso fixture' and o.id in (select organization_id from ownership_transfers where from_account_id=${from.accountId})`;
    expect(organization.created_by_account).toBe(to.accountId);
    const [dpa] =
      await admin`select context from legal_acceptances where account_id=${to.accountId} and document='dpa'`;
    expect(dpa.context).toBe("transfer");

    await page.reload();
    const after = center(page);
    await expect(after).toContainText(`Titular: ${to.name} <${to.email}>`);
    await expect(
      after.getByRole("button", { name: "Dejar de ser copropietario" }),
    ).toBeVisible();
    await expect(after).toContainText(
      "La facturación y nuevas sucursales las administra la persona titular.",
    );
    await expect(
      after.getByRole("button", { name: "Crear enlace de transferencia" }),
    ).toHaveCount(0);
  } finally {
    await other.close();
    await deleteOwnerFixtures(admin, [from.accountId, to.accountId]);
    await sql.end();
    await admin.end();
  }
});

test("recovery codes are shown once, printable, and redeem schedules a held transfer", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  const lost = await ownerFixture(sql, "lost");
  const recovered = await ownerFixture(sql, "recovered");
  const other = await browser.newContext({ baseURL });
  try {
    await ownerRestaurant(sql, lost, "Recuperación fixture");
    await useOwnerCookie(context, lost, baseURL);
    await page.goto("/app");
    const console = center(page);
    await expect(console).toContainText("Aún no generas códigos.");
    await console
      .getByRole("button", { name: "Generar códigos nuevos", exact: true })
      .click();
    const list = console.getByRole("list", { name: "Códigos de recuperación" });
    await expect(list.getByRole("listitem")).toHaveCount(10);
    await expect(console.getByRole("alert")).toHaveText(
      "Guárdalos ahora: no volveremos a mostrarlos. Generar nuevos invalida los anteriores.",
    );
    const codes = await list.getByRole("listitem").allInnerTexts();
    for (const code of codes)
      expect(code.trim()).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
    await expect(
      console.getByRole("button", { name: "Copiar códigos", exact: true }),
    ).toBeVisible();
    // Printable: "Imprimir" opens the print dialog, and the print stylesheet
    // keeps the codes while hiding the rest of the console.
    await page.evaluate(() => {
      (window as unknown as { printed: number }).printed = 0;
      window.print = () => {
        (window as unknown as { printed: number }).printed++;
      };
    });
    await console
      .getByRole("button", { name: "Imprimir", exact: true })
      .click();
    expect(
      await page.evaluate(
        () => (window as unknown as { printed: number }).printed,
      ),
    ).toBe(1);
    await page.emulateMedia({ media: "print" });
    await expect(list).toBeVisible();
    await expect(
      console.getByRole("heading", { name: /^Propietarios · / }),
    ).toBeHidden();
    await page.emulateMedia({ media: "screen" });
    await axe(page);
    // Shown once: a reload lists only how many remain.
    await page.reload();
    await expect(
      center(page).getByRole("list", { name: "Códigos de recuperación" }),
    ).toHaveCount(0);
    await expect(center(page)).toContainText(
      "10 códigos disponibles · generados el",
    );

    await useOwnerCookie(other, recovered, baseURL);
    const newAccount = await other.newPage();
    await newAccount.goto("/app");
    const redeem = center(newAccount);
    await expect(
      redeem.getByRole("heading", {
        name: "¿Perdiste acceso a tu cuenta anterior?",
      }),
    ).toBeVisible();
    await redeem
      .getByLabel("Código de recuperación", { exact: true })
      .fill(codes[0].trim());
    await redeem
      .getByRole("button", { name: "Recuperar titularidad", exact: true })
      .click();
    await expect(
      redeem.getByText(
        "Recuperación programada. Podrás completarla a partir del",
        {
          exact: false,
        },
      ),
    ).toBeVisible();
    // The incoming transfer waits for its hold.
    await expect(redeem).toContainText("Podrás aceptarla a partir del");
    await expect(
      redeem.getByRole("button", { name: "Aceptar y convertirme en titular" }),
    ).toBeDisabled();
    const [transfer] =
      await admin`select initiated_by,previous_owner_stays,available_at>now()+interval '23 hours' as held
        from ownership_transfers where from_account_id=${lost.accountId} and to_account_id=${recovered.accountId}`;
    expect(transfer).toEqual({
      initiated_by: "recovery_code",
      previous_owner_stays: false,
      held: true,
    });
    // The old primary sees the critical banner and can cancel it.
    await page.reload();
    const warning = center(page).getByRole("alert");
    await expect(warning).toContainText(
      "Se usó un código de recuperación para transferir la propiedad a",
    );
    await expect(center(page)).toContainText("9 códigos disponibles");
    await warning
      .getByRole("button", { name: "Cancelar transferencia", exact: true })
      .click();
    await expect(center(page).getByRole("alert")).toHaveCount(0);
  } finally {
    await other.close();
    await deleteOwnerFixtures(admin, [lost.accountId, recovered.accountId]);
    await sql.end();
    await admin.end();
  }
});

test("owner downloads JSON and CSV exports", async ({
  page,
  context,
  baseURL,
}) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  const owner = await ownerFixture(sql, "export");
  try {
    const tenantId = await ownerRestaurant(sql, owner, "Exportación Ñandú");
    await useOwnerCookie(context, owner, baseURL);
    await page.goto("/app");
    await page
      .locator(".row.between")
      .filter({ hasText: "Exportación Ñandú" })
      .getByRole("button", { name: "Entrar", exact: true })
      .click();
    await expect(page.locator(".scope")).toContainText("Exportación Ñandú");
    const privacy = await settings(page);
    // A personal owner browser lists the tables right away (no PIN).
    await expect(
      privacy.getByRole("combobox", { name: "Tabla", exact: true }),
    ).toHaveValue("orders");
    const [json] = await Promise.all([
      page.waitForEvent("download"),
      privacy
        .getByRole("button", { name: "Descargar todo (JSON)", exact: true })
        .click(),
    ]);
    expect(json.suggestedFilename()).toMatch(
      /^green-monkey-exportacion-nandu-\d{8}\.json$/,
    );
    const body = JSON.parse((await downloadBytes(json)).toString("utf8"));
    expect(body.format).toBe("green-monkey-export");
    expect(body.restaurant.id).toBe(tenantId);
    expect(Object.keys(body.tables)).toContain("orders");
    expect(JSON.stringify(body)).not.toMatch(/secret_hash|token_hash|csrf/);
    await privacy
      .getByRole("combobox", { name: "Tabla", exact: true })
      .selectOption("employees");
    const [csv] = await Promise.all([
      page.waitForEvent("download"),
      privacy
        .getByRole("button", { name: "Descargar tabla (CSV)", exact: true })
        .click(),
    ]);
    expect(csv.suggestedFilename()).toMatch(
      /^green-monkey-exportacion-nandu-employees-\d{8}\.csv$/,
    );
    const bytes = await downloadBytes(csv);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const header = bytes.subarray(3).toString("utf8").split("\r\n", 1)[0];
    expect(header.split(",")).toContain("name");
    expect(header).not.toMatch(/secret|hash/);
    await axe(page);
    const [audit] =
      await admin`select count(*)::int as n from audit where tenant_id=${tenantId} and operation='account.data_export'`;
    expect(audit.n).toBe(2);
  } finally {
    await deleteOwnerFixtures(admin, [owner.accountId]);
    await sql.end();
    await admin.end();
  }
});

test("restaurant privacy URL appears on QR ordering; missing URL shows no-notice text", async ({
  page,
  context,
  baseURL,
}) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  const [before] = await admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id',${DEMO_TENANT},true)`;
    return tx`select privacy_notice_url from restaurant_account_settings where tenant_id=${DEMO_TENANT}`;
  });
  try {
    await demoOwnerLogin(page);
    const privacy = await settings(page);
    const field = privacy.getByLabel(
      "Enlace al aviso de privacidad de tu restaurante",
      { exact: true },
    );
    await field.fill("http://casa-del-bosque.mx/privacidad");
    await privacy
      .getByRole("button", { name: "Guardar enlace", exact: true })
      .click();
    await expect(privacy.getByRole("alert")).toHaveText(
      "Usa un enlace que empiece con https://",
    );
    await field.fill("https://casa-del-bosque.mx/privacidad");
    await privacy
      .getByRole("button", { name: "Guardar enlace", exact: true })
      .click();
    await expect(privacy.getByRole("status")).toHaveText("Enlace guardado");
    await axe(page);
    const access = await call(page, "/ordering-links", {
      channel: "qr",
      tableId: null,
    });
    expect(access.status).toBe(200);
    const customer = await context.newPage();
    await customer.goto(access.body.path);
    const notice = customer.getByRole("link", {
      name: "Aviso de privacidad de Casa del Bosque · Demo",
      exact: true,
    });
    await expect(notice).toHaveAttribute(
      "href",
      "https://casa-del-bosque.mx/privacidad",
    );
    await expect(
      customer.getByText(
        "Solo para llamarte cuando tu pedido esté listo. Puedes usar un apodo.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      customer.getByRole("link", {
        name: "Pedido procesado con Green Monkey · Privacidad de la plataforma",
      }),
    ).toHaveAttribute("href", "/legal/privacidad#restaurantes");
    await axe(customer);
    await privacy
      .getByRole("button", { name: "Quitar enlace", exact: true })
      .click();
    await expect(field).toHaveValue("");
    await customer.reload();
    await expect(
      customer.getByText(
        "Este restaurante aún no publicó un aviso de privacidad; no escribas datos personales.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(notice).toHaveCount(0);
  } finally {
    // The demo restaurant keeps the settings row it had before.
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${DEMO_TENANT},true)`;
      if (before)
        await tx`update restaurant_account_settings set privacy_notice_url=${before.privacy_notice_url}
          where tenant_id=${DEMO_TENANT}`;
      else
        await tx`delete from restaurant_account_settings where tenant_id=${DEMO_TENANT}`;
    });
    await sql.end();
    await admin.end();
  }
});

test("help dialog shows support contact (or not-configured text) and copies restaurant ID", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await demoOwnerLogin(page);
  await page.getByRole("button", { name: "Ayuda", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Ayuda y soporte" });
  await expect(dialog).toContainText(`Correo: ${LEGAL_CI_ENV.SUPPORT_EMAIL}`);
  await expect(dialog).toContainText(`Teléfono: ${LEGAL_CI_ENV.SUPPORT_PHONE}`);
  await expect(dialog).toContainText(`Horario: ${LEGAL_CI_ENV.SUPPORT_HOURS}`);
  await expect(
    dialog.getByRole("link", { name: "Aviso de privacidad", exact: true }),
  ).toHaveAttribute("href", "/legal/privacidad");
  await expect(dialog.getByText(DEMO_TENANT, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Copiar", exact: true }).click();
  await expect(dialog.getByText("Copiado", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    DEMO_TENANT,
  );
  await axe(page);
  await dialog.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // A deployment without support channels says so (login screen entry point).
  const fresh = await browser.newContext({ baseURL });
  try {
    const login = await fresh.newPage();
    const real = await (await login.request.get("/api/account-config")).json();
    await login.route("**/api/account-config", (route) =>
      route.fulfill({
        json: {
          ...real,
          support: {
            email: null,
            phone: null,
            whatsapp: null,
            hoursEs: null,
            hoursEn: null,
            url: null,
            configured: false,
          },
        },
      }),
    );
    await login.goto("/app");
    await login
      .getByRole("button", { name: "Ayuda y privacidad", exact: true })
      .click();
    const help = login.getByRole("dialog", { name: "Ayuda y soporte" });
    await expect(help).toContainText(
      "El contacto de soporte aún no está configurado en este entorno.",
    );
    await expect(help.getByText("ID del restaurante")).toHaveCount(0);
    await axe(login);
  } finally {
    await fresh.close();
  }
});

test("account-center commands are refused on a paired shared terminal", async ({
  page,
}) => {
  await demoOwnerLogin(page);
  const session = await sessionOf(page);
  expect(session.access.deviceKind).toBe("terminal");
  // tests/account-http.ts covers every account-center command path.
  for (const path of [
    "/api/auth/account-center/recovery-codes",
    "/api/auth/account-center/recovery/redeem",
  ]) {
    // From the page itself, so the browser sends its (Secure) device cookie.
    const response = await page.evaluate(
      async ({ path, csrf }) => {
        const r = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
          body: "{}",
        });
        return { status: r.status, body: await r.json() };
      },
      { path, csrf: session.csrf },
    );
    expect(response.status, path).toBe(403);
    expect(response.body.error, path).toBe("device_is_terminal");
  }
  // The UI never offers the account console on a terminal.
  await page.goto("/app?account=1");
  await expect(
    page.getByText(
      "Esta es una terminal compartida. La cuenta del propietario (Google) se administra desde tu propio teléfono o computadora.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Cuenta y propietarios" }),
  ).toHaveCount(0);
});

test("a terminal export prompts for the PIN", async ({ page, baseURL }) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  try {
    await demoOwnerLogin(page);
    const session = await sessionOf(page);
    await admin`update sessions set authenticated_at=now()-interval '2 hours' where id=${session.id}`;
    const privacy = await settings(page);
    await expect(privacy).toContainText(
      "En terminales compartidas te pediremos tu PIN.",
    );
    let downloads = 0;
    page.on("download", () => downloads++);
    const json = privacy.getByRole("button", {
      name: "Descargar todo (JSON)",
      exact: true,
    });
    const stepUp = page.getByRole("dialog", { name: "Confirma con tu PIN" });
    await json.click();
    await expect(stepUp).toContainText(
      "Esta acción necesita que confirmes que eres Alex Demo.",
    );
    await axe(page);
    // Cancelling starts no download.
    await stepUp.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(stepUp).toBeHidden();
    await page.waitForTimeout(500);
    expect(downloads).toBe(0);
    // Confirming with the owner's secret starts it.
    await json.click();
    await expect(stepUp).toBeVisible();
    expect(downloads).toBe(0);
    await stepUp.getByRole("button", { name: "Usar contraseña" }).click();
    await stepUp.getByLabel("Contraseña o PIN").fill(OWNER_PASSWORD);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      stepUp.getByRole("button", { name: "Confirmar", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(
      /^green-monkey-casa-del-bosque-demo-\d{8}\.json$/,
    );
    await expect(stepUp).toBeHidden();
  } finally {
    await sql.end();
    await admin.end();
  }
});

test("POS shell: trial-ending warning, then drawer continuation banner after lapse, then blocked notice after close (GAP-1)", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  const owner = await ownerFixture(sql, "lapse");
  const second = await browser.newContext({ baseURL });
  // The fixture restaurant keeps its drawer history (like free-limits.spec);
  // only its account rows would need the LD-12 cleanup.
  try {
    const tenantId = await ownerRestaurant(sql, owner, "Lapso fixture");
    await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source)
      values(${tenantId},'trialing',now()+interval '2 days','fixture')
      on conflict(tenant_id) do update set status='trialing',access_until=excluded.access_until,source='fixture'`;
    const enter = async (target: Page) => {
      await target.goto("/app");
      await target
        .locator(".row.between")
        .filter({ hasText: "Lapso fixture" })
        .getByRole("button", { name: "Entrar", exact: true })
        .click();
      await expect(target.locator(".scope")).toContainText("Lapso fixture");
    };
    await useOwnerCookie(context, owner, baseURL);
    await useOwnerCookie(second, owner, baseURL);
    await enter(page);
    const other = await second.newPage();
    await enter(other);
    // 1. Trial ending in two days: a warning for the owner.
    const trial = page.locator(".plan-notice.warning");
    await expect(trial).toContainText("La prueba Pro termina el");
    await expect(
      trial.getByRole("button", { name: "Revisar plan", exact: true }),
    ).toBeVisible();
    await axe(page);
    // 2. Both browsers open a drawer while Pro; the latest opener (the second)
    // holds the automatic Free slot.
    for (const target of [page, other]) {
      const opened = await call(target, "/cash/open", {
        operationId: randomUUID(),
        opening: 0,
      });
      expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    }
    // 3. The trial lapsed (backdated past the 7-day "Pro ended" window): the
    // first browser keeps selling until its drawer closes.
    await admin`update restaurant_entitlements set access_until=now()-interval '8 days',
      version=version+1,updated_at=now() where tenant_id=${tenantId}`;
    await page.reload();
    const continuation = page.locator(".plan-notice.critical");
    await expect(continuation).toHaveAttribute("role", "alert");
    await expect(continuation).toContainText(
      /Esta caja sigue vendiendo hasta cerrarla o hasta las .+\. Después aplicarán los límites Free\./,
    );
    await axe(page);
    // 4. After the close, Free limits apply to this browser.
    const closed = await call(page, "/cash/close", {
      operationId: randomUUID(),
      counted: 0,
      reason: "",
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    await page.reload();
    await expect(page.locator(".plan-notice.warning")).toContainText(
      /Free: este dispositivo o empleado no está seleccionado para iniciar ventas\. Solo .+ puede hacerlo\./,
    );
    await expect(
      page.getByRole("button", { name: "Cambiar selección", exact: true }),
    ).toBeVisible();
    const refused = await call(page, "/cash/open", {
      operationId: randomUUID(),
      opening: 0,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("free_selection_required");
  } finally {
    await second.close();
    await sql.end();
    await admin.end();
  }
});

test("material change re-acceptance panel gates account commands but not POS entry", async ({
  page,
  context,
  baseURL,
}) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  const owner = await ownerFixture(sql, "material");
  try {
    await ownerRestaurant(sql, owner, "Cambio material");
    // The latest terms acceptance is of an older version (a material change).
    await admin`insert into legal_acceptances(id,account_id,owner_session_id,document,version,content_hash,entity_hash,published,locale,context,accepted_at)
      values(${randomUUID()},${owner.accountId},${ownerCookie(owner.cookie).id},'terms','2026-01-01',${legalContentHash("terms")},${PUBLISHED_LEGAL.entityHash},true,'es','reacceptance',now()+interval '1 second')`;
    await useOwnerCookie(context, owner, baseURL);
    await page.goto("/app");
    const panel = center(page)
      .locator(".panel")
      .filter({ hasText: "Actualizamos nuestros documentos" });
    await expect(panel).toContainText(
      "Revisa los cambios y acepta para seguir administrando tu cuenta. Tu restaurante sigue operando mientras tanto.",
    );
    // Each pending document with its own change list (§2.4, ACC-4): only the
    // terms are pending here, and the list is the document's, not versions.
    await expect(
      panel.getByRole("heading", {
        name: `Términos del servicio · ${LEGAL_DOCUMENTS.terms.version}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      panel.getByRole("heading", { name: /^Aviso de privacidad · / }),
    ).toHaveCount(0);
    await expect(panel.getByRole("listitem")).toHaveText([
      ...LEGAL_DOCUMENTS.terms.changes.es,
    ]);
    await expect(panel).not.toContainText(/Cambios en esta versión:/);
    await axe(page);
    // Account commands wait for the acceptance.
    await page
      .getByText("Administrar sucursales y acceso", { exact: true })
      .click();
    await page
      .getByLabel("Correo de Google", { exact: true })
      .fill(`staff-${randomUUID().slice(0, 6)}@example.com`);
    await page
      .getByRole("button", { name: "Crear enlace", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({
        hasText: "Acepta los documentos actualizados para continuar.",
      }),
    ).toBeVisible();
    // POS entry is never gated; owners see the pending-documents banner.
    await page
      .locator(".row.between")
      .filter({ hasText: "Cambio material" })
      .getByRole("button", { name: "Entrar", exact: true })
      .click();
    await expect(page.locator(".scope")).toContainText("Cambio material");
    await expect(
      page.getByText("Hay documentos legales por aceptar en Cuenta.", {
        exact: true,
      }),
    ).toBeVisible();
    // Accepting clears the panel and the command goes through.
    await page.goto("/app?account=1");
    const pending = center(page)
      .locator(".panel")
      .filter({ hasText: "Actualizamos nuestros documentos" });
    const accept = pending.getByRole("button", {
      name: "Aceptar y continuar",
      exact: true,
    });
    await expect(accept).toBeDisabled();
    await pending
      .getByRole("checkbox", {
        name: "Acepto los Términos del servicio.",
        exact: true,
      })
      .check();
    await pending
      .getByRole("checkbox", {
        name: "Leí el Aviso de privacidad.",
        exact: true,
      })
      .check();
    await accept.click();
    await expect(pending).toHaveCount(0);
    await page
      .getByText("Administrar sucursales y acceso", { exact: true })
      .click();
    await page
      .getByLabel("Correo de Google", { exact: true })
      .fill(`staff-${randomUUID().slice(0, 6)}@example.com`);
    await page
      .getByRole("button", { name: "Crear enlace", exact: true })
      .click();
    await expect(
      page.getByLabel("Enlace de invitación — copia y comparte", {
        exact: true,
      }),
    ).toHaveValue(/#invite=/);
  } finally {
    await deleteOwnerFixtures(admin, [owner.accountId]);
    await sql.end();
    await admin.end();
  }
});

test("an old QR link on a disabled deployment shows only the counter message", async ({
  page,
}) => {
  await page.route("**/api/public/**", (route) =>
    route.fulfill({ status: 404, json: { error: "public_ordering_disabled" } }),
  );
  await page.goto(`/qr/${randomUUID()}`);
  await expect(page.getByRole("alert")).toHaveText(
    "Los pedidos en línea no están disponibles por ahora. Pide en el mostrador.",
  );
  await expect(
    page.getByRole("button", { name: "Enviar a cocina" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Nombre (opcional)")).toHaveCount(0);
  await axe(page);
});

test("the ordering-link generator is hidden when publicOrdering.enabled=false", async ({
  page,
  context,
}) => {
  const real = await (await page.request.get("/api/account-config")).json();
  await page.route("**/api/account-config", (route) =>
    route.fulfill({ json: { ...real, publicOrdering: { enabled: false } } }),
  );
  await demoOwnerLogin(page);
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  // PlanSettings reads the same configuration: once it says "próximamente"
  // the switch has been applied on this page.
  await expect(
    page.getByText("Kiosco y pedidos QR: próximamente.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Crear enlace de pedido", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Pedidos QR y kiosco" }),
  ).toHaveCount(0);
  // With the switch on, the generator is offered again.
  const enabled = await context.newPage();
  await enabled.route("**/api/account-config", (route) =>
    route.fulfill({ json: { ...real, publicOrdering: { enabled: true } } }),
  );
  await enabled.goto("/app");
  await enabled
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  await expect(
    enabled.getByRole("button", {
      name: "Crear enlace de pedido",
      exact: true,
    }),
  ).toBeVisible();
  await enabled.close();
});
