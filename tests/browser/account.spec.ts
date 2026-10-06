import "dotenv/config";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { legalContentHash } from "../../server/legal.js";
import { ownerCookie, withOwner } from "../../server/owner-accounts.js";
import { createCoOwnerInvitation } from "../../server/co-owners.js";
import {
  acceptInvitation,
  createInvitation,
} from "../../server/owner-management.js";
import {
  cancelTransfer,
  generateRecoveryCodes,
  redeemRecoveryCode,
  requestTransfer,
} from "../../server/ownership-transfer.js";
import { LEGAL_CI_ENV } from "../fixtures/legal-ci.js";
import {
  BILLING_CONSENT,
  LEGAL_DOCUMENTS,
  PRIVACY_SIMPLIFIED,
  legalText,
} from "../../shared/legal.js";
import {
  CURRENT_ACCEPTANCE,
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
/**
 * Test isolation: every owner-console load spends /api/auth reads from the
 * per-IP owner budget (owner-routes.ts, 120 per minute) that every test in
 * this run shares from 127.0.0.1. Start each test with room for its own
 * loads, waiting out the window when the earlier tests used it up.
 */
test.beforeEach(async ({ page }) => {
  const r = await page.request.get("/api/auth/providers");
  const remaining = Number(r.headers()["ratelimit-remaining"] ?? 1000);
  const reset = Number(r.headers()["ratelimit-reset"] ?? 0);
  if (remaining < 40)
    await new Promise((done) => setTimeout(done, (reset + 1) * 1000));
});
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
    // UX-3: the express billing consent is its own box.
    const consent = page.getByRole("checkbox", {
      name: BILLING_CONSENT.es,
      exact: true,
    });
    await expect(
      page.getByRole("group", { name: "Documentos legales" }),
    ).toBeVisible();
    await expect(create).toBeDisabled();
    await terms.check();
    await expect(create).toBeDisabled();
    await privacy.check();
    await expect(create).toBeDisabled();
    await consent.check();
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
    expect(rows.map((r) => r.document)).toEqual([
      "billing_consent",
      "dpa",
      "privacy",
      "terms",
    ]);
    expect(rows.every((r) => r.published && r.context === "signup")).toBe(true);
    expect(rows.map((r) => r.organization)).toEqual([
      false,
      true,
      false,
      false,
    ]);
  } finally {
    await deleteOwnerFixtures(admin, [owner.accountId]);
    await sql.end();
    await admin.end();
  }
});

test("signup with a stale document version says the documents changed, reloads them and accepts the current ones (ACC-17)", async ({
  page,
  context,
  baseURL,
}) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  const owner = await ownerFixture(sql, "stale");
  // The first configuration this page reads is a stale copy (an old terms
  // version, as a cached response would be after a version bump); later
  // reads pass through.
  let served = 0;
  await page.route("**/api/account-config", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (served++ === 0) json.legal.documents.terms.version = "2000-01-01";
    await route.fulfill({ response, json });
  });
  try {
    await useOwnerCookie(context, owner, baseURL);
    await page.goto("/app");
    await page
      .getByLabel("Nombre del restaurante", { exact: true })
      .fill("Version vieja");
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
    const consent = page.getByRole("checkbox", {
      name: BILLING_CONSENT.es,
      exact: true,
    });
    await terms.check();
    await privacy.check();
    await consent.check();
    await create.click();
    await expect(
      page.getByRole("alert").filter({
        hasText: "Los documentos cambiaron. Recarga y vuelve a aceptar.",
      }),
    ).toBeVisible();
    await expect(page.getByText(/Revisa tu conexión/)).toHaveCount(0);
    // The current versions were read again and the boxes start unchecked.
    expect(served).toBeGreaterThanOrEqual(2);
    await expect(terms).not.toBeChecked();
    await expect(create).toBeDisabled();
    await terms.check();
    await privacy.check();
    await consent.check();
    await create.click();
    await expect(page.locator(".scope")).toContainText("Version vieja");
    const [accepted] =
      await admin`select version from legal_acceptances where account_id=${owner.accountId} and document='terms'`;
    expect(accepted.version).toBe(LEGAL_DOCUMENTS.terms.version);
  } finally {
    await deleteOwnerFixtures(admin, [owner.accountId]);
    await sql.end();
    await admin.end();
  }
});

test("the signup form says the legal documents could not load and retries (ACC-17)", async ({
  page,
  context,
  baseURL,
}) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  const owner = await ownerFixture(sql, "noconfig");
  let fail = true;
  await page.route("**/api/account-config", (route) =>
    fail ? route.fulfill({ status: 503, json: {} }) : route.fallback(),
  );
  try {
    await useOwnerCookie(context, owner, baseURL);
    await page.goto("/app");
    const unavailable = page
      .getByRole("alert")
      .filter({ hasText: "No pudimos cargar los documentos legales." });
    await expect(unavailable).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Crear restaurante gratis" }),
    ).toBeDisabled();
    await axe(page);
    fail = false;
    await unavailable.getByRole("button").click();
    await expect(unavailable).toHaveCount(0);
    await expect(
      page.getByRole("group", { name: "Documentos legales" }),
    ).toBeVisible();
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
  // One source (LEGAL-1): the versioned simplified notice with the
  // responsable's domicilio and the data / no-sensitive-data clause.
  await expect(notice).toHaveText(
    `${legalText(PRIVACY_SIMPLIFIED.es, PUBLISHED_LEGAL.entity, "es")} Aviso de privacidad · Términos del servicio`,
  );
  await expect(notice).toContainText(
    `${LEGAL_CI_ENV.LEGAL_ENTITY_NAME}, con domicilio en ${LEGAL_CI_ENV.LEGAL_ENTITY_ADDRESS}, es responsable`,
  );
  await expect(notice).toContainText("no recabamos datos personales sensibles");
  await expect(
    page.getByRole("link", { name: "Continuar con Google", exact: true }),
  ).toHaveAttribute("aria-describedby", "signup-privacy-notice");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(notice).toContainText(
    `${LEGAL_CI_ENV.LEGAL_ENTITY_NAME}, with its address at ${LEGAL_CI_ENV.LEGAL_ENTITY_ADDRESS}, is the controller of your personal data.`,
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
    // The new primary bills the subscription: the express consent (UX-3).
    await expect(accept).toBeDisabled();
    await offer
      .getByRole("checkbox", { name: BILLING_CONSENT.es, exact: true })
      .check();
    await axe(target);
    await accept.click();
    await expect(center(target)).toContainText(
      "Ahora eres titular. Se cancelaron las invitaciones pendientes de la persona titular anterior (si sigue como copropietaria, solo las de copropietario). Revisa dispositivos vinculados, la selección Free y el correo de facturación en Stripe.",
    );
    const [organization] =
      await admin`select o.created_by_account from organizations o join restaurants r on r.organization_id=o.id
        where r.name='Traspaso fixture' and o.id in (select organization_id from ownership_transfers where from_account_id=${from.accountId})`;
    expect(organization.created_by_account).toBe(to.accountId);
    const [dpa] =
      await admin`select context from legal_acceptances where account_id=${to.accountId} and document='dpa'`;
    expect(dpa.context).toBe("transfer");
    const [consent] =
      await admin`select context from legal_acceptances where account_id=${to.accountId} and document='billing_consent'`;
    expect(consent.context).toBe("transfer");

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

test("each panel keeps its own acceptance: the re-acceptance boxes never enable a transfer, which needs its DPA (ACC-13)", async ({
  page,
  context,
  baseURL,
}) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  const primary = await ownerFixture(sql, "panelsa");
  const target = await ownerFixture(sql, "panelsc");
  const offering = await ownerFixture(sql, "panelsq");
  try {
    // The target co-owns one organization (so it re-accepts in the console)
    // and is offered another.
    const tenantA = await ownerRestaurant(sql, primary, "Paneles A");
    const [{ organization_id: organizationA }] =
      await admin`select organization_id from restaurants where id=${tenantA}`;
    const invite = await withOwner(sql, primary.cookie, undefined, (tx, a) =>
      createCoOwnerInvitation(
        tx,
        a,
        {
          operationId: randomUUID(),
          organizationId: organizationA,
          email: target.email,
        },
        PUBLISHED_LEGAL,
      ),
    );
    await withOwner(sql, target.cookie, undefined, (tx, a) =>
      acceptInvitation(
        tx,
        a,
        {
          token: invite.path.split("#invite=")[1],
          legalAccepted: {
            terms: CURRENT_ACCEPTANCE.terms,
            privacy: CURRENT_ACCEPTANCE.privacy,
          },
        },
        PUBLISHED_LEGAL,
      ),
    );
    const tenantB = await ownerRestaurant(sql, offering, "Paneles B");
    const [{ organization_id: organizationB }] =
      await admin`select organization_id from restaurants where id=${tenantB}`;
    const offer = await withOwner(sql, offering.cookie, undefined, (tx, a) =>
      requestTransfer(
        tx,
        a,
        {
          operationId: randomUUID(),
          organizationId: organizationB,
          email: target.email,
          previousOwnerStays: false,
          confirmName: "Paneles B",
        },
        PUBLISHED_LEGAL,
      ),
    );
    await admin`insert into legal_acceptances(id,account_id,owner_session_id,document,version,content_hash,entity_hash,published,locale,context,accepted_at)
      values(${randomUUID()},${target.accountId},${ownerCookie(target.cookie).id},'terms','2026-01-01',${legalContentHash("terms")},${PUBLISHED_LEGAL.entityHash},true,'es','reacceptance',now()+interval '1 second')`;
    await useOwnerCookie(context, target, baseURL);
    const url = new URL(offer.path, baseURL);
    await page.goto(url.pathname + url.search + url.hash);
    const reaccept = center(page)
      .locator(".panel")
      .filter({ hasText: "Actualizamos nuestros documentos" });
    const transfer = center(page).getByRole("region", {
      name: "Transferir propiedad",
    });
    const accept = transfer.getByRole("button", {
      name: "Aceptar y convertirme en titular",
      exact: true,
    });
    await expect(accept).toBeDisabled();
    await reaccept
      .getByRole("checkbox", {
        name: "Acepto los Términos del servicio.",
        exact: true,
      })
      .check();
    await reaccept
      .getByRole("checkbox", {
        name: "Leí el Aviso de privacidad.",
        exact: true,
      })
      .check();
    await expect(
      reaccept.getByRole("button", {
        name: "Aceptar y continuar",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(accept).toBeDisabled();
    await transfer
      .getByRole("checkbox", {
        name: "Acepto los Términos del servicio. Acepto el Contrato de encargo de datos de Paneles B.",
        exact: true,
      })
      .check();
    await expect(accept).toBeDisabled();
    await transfer
      .getByRole("checkbox", {
        name: "Leí el Aviso de privacidad.",
        exact: true,
      })
      .check();
    await expect(accept).toBeDisabled();
    await transfer
      .getByRole("checkbox", { name: BILLING_CONSENT.es, exact: true })
      .check();
    await expect(accept).toBeEnabled();
    await axe(page);
  } finally {
    await deleteOwnerFixtures(admin, [
      primary.accountId,
      target.accountId,
      offering.accountId,
    ]);
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
    // A new account's first screen is its restaurant form; the recovery tools
    // wait behind a disclosure (UX-8).
    await redeem
      .getByText("Códigos de recuperación y recuperar una cuenta anterior", {
        exact: true,
      })
      .click();
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
    // When the configuration cannot be loaded (offline), the dialog says so
    // instead of "Cargando…" forever (ACC-12).
    const offline = await fresh.newPage();
    await offline.route("**/api/account-config", (route) => route.abort());
    await offline.goto("/app");
    await offline
      .getByRole("button", { name: "Ayuda y privacidad", exact: true })
      .click();
    const unavailable = offline.getByRole("dialog", {
      name: "Ayuda y soporte",
    });
    await expect(unavailable.getByRole("alert")).toHaveText(
      "No pudimos cargar el contacto de soporte. Revisa tu conexión e intenta de nuevo.",
    );
    await expect(unavailable).not.toContainText("Cargando");
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
    // UX-11: no CSV downloads before the owner has the list to choose from.
    await expect(
      privacy.getByRole("button", { name: "Descargar tabla (CSV)" }),
    ).toHaveCount(0);
    await expect(
      privacy.getByRole("button", { name: "Mostrar tablas", exact: true }),
    ).toBeVisible();
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
    // 3. The trial ends now, after both drawers opened: the first browser keeps
    // selling until its drawer closes (continuation covers only drawers opened
    // before Pro ended, ACC-14).
    await admin`update restaurant_entitlements set access_until=now(),
      version=version+1,updated_at=now() where tenant_id=${tenantId}`;
    await page.reload();
    const continuation = page.locator(".plan-notice.critical");
    await expect(continuation).toHaveAttribute("role", "alert");
    await expect(continuation).toContainText(
      /Esta caja sigue vendiendo hasta cerrarla o hasta las .+\. Después aplicarán los límites Free\./,
    );
    await axe(page);
    // 4. After the close, Free limits apply to this browser: first "Pro ended"
    // (within 7 days of the lapse)...
    const closed = await call(page, "/cash/close", {
      operationId: randomUUID(),
      counted: 0,
      reason: "",
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    await page.reload();
    await expect(page.locator(".plan-notice.warning")).toContainText(
      /Pro terminó el .+\. Aplican los límites Free: solo .+ y dos empleados pueden iniciar ventas\./,
    );
    await expect(page.locator(".plan-notice.critical")).toHaveCount(0);
    // ...then, once the lapse is older than 7 days, "not selected".
    await admin`update restaurant_entitlements set access_until=now()-interval '8 days',
      version=version+1,updated_at=now() where tenant_id=${tenantId}`;
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
    // 5. Settings › Plan says when Pro ended, never "Acceso hasta" a past
    // date (ACC-19).
    await page
      .getByRole("button", { name: "Configuración", exact: true })
      .click();
    const planPanel = page.getByRole("region", { name: "Plan y suscripción" });
    await expect(planPanel).toContainText(/Pro terminó el .+\./);
    await expect(planPanel).not.toContainText("Acceso hasta");
  } finally {
    await second.close();
    await sql.end();
    await admin.end();
  }
});

test("Free without Pro: an open drawer is no continuation; an unselected cashier on the selected register sees the blocked notice (ACC-14)", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  const owner = await ownerFixture(sql, "freedrawer");
  const terminalContext = await browser.newContext({ baseURL });
  // The fixture restaurant keeps its drawer history (like the GAP-1 test).
  try {
    // Never Pro: no entitlement row.
    const tenantId = await ownerRestaurant(sql, owner, "Libre fixture");
    await useOwnerCookie(context, owner, baseURL);
    await page.goto("/app");
    await page
      .locator(".row.between")
      .filter({ hasText: "Libre fixture" })
      .getByRole("button", { name: "Entrar", exact: true })
      .click();
    await expect(page.locator(".scope")).toContainText("Libre fixture");
    const staff: Record<string, string> = {};
    for (const name of ["Ana Libre", "Caro Libre"]) {
      staff[name] = randomUUID();
      const saved = await call(page, "/team/save", {
        operationId: randomUUID(),
        id: staff[name],
        name,
        login: `libre-${randomUUID()}`,
        role: "cashier",
        secret: "481516",
        active: true,
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    }
    // The register "Caja libre" is paired and selected with Ana only.
    const pairing = await call(page, "/access/pairing-codes", {
      deviceName: "Caja libre",
    });
    expect(pairing.status, JSON.stringify(pairing.body)).toBe(200);
    const terminal = await terminalContext.newPage();
    await terminal.goto("/app");
    await terminal.getByLabel("Código de vinculación").fill(pairing.body.code);
    await terminal
      .getByRole("button", { name: "Vincular", exact: true })
      .click();
    await expect(
      terminal.getByRole("heading", { name: "¿Quién entra?", exact: true }),
    ).toBeVisible();
    const [register] =
      await admin`select id from devices where tenant_id=${tenantId} and name='Caja libre'`;
    const selected = await call(page, "/plan/selection", {
      deviceId: register.id,
      employeeIds: [staff["Ana Libre"]],
    });
    expect(selected.status, JSON.stringify(selected.body)).toBe(200);
    // Ana's drawer is open on the register (opened on Free, never during Pro).
    await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening)
      values(${tenantId},${randomUUID()},${register.id},${staff["Ana Libre"]},0)`;
    // Caro, without a Free slot, signs in on that register.
    await terminal.getByRole("button", { name: /^Caro Libre/ }).click();
    await expect(terminal.getByLabel("PIN de Caro Libre")).toBeVisible();
    for (const digit of "481516")
      await terminal.getByRole("button", { name: digit, exact: true }).click();
    await terminal.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(terminal.locator(".scope")).toContainText("Caro Libre");
    await expect(terminal.locator(".plan-notice.warning")).toContainText(
      /Free: este dispositivo o empleado no está seleccionado para iniciar ventas\. Solo .+ puede hacerlo\./,
    );
    await expect(terminal.locator(".plan-notice.critical")).toHaveCount(0);
    await expect(terminal.getByText(/Esta caja sigue vendiendo/)).toHaveCount(
      0,
    );
    const shell = await call(terminal, "/account/shell");
    expect(shell.body.selling).toMatchObject({
      allowed: false,
      basis: "none",
    });
    const refused = await call(terminal, "/orders", {
      operationId: randomUUID(),
      lines: [
        {
          id: randomUUID(),
          productId: randomUUID(),
          quantity: 1,
          options: [],
          note: "",
        },
      ],
      mode: "takeaway",
      tableId: null,
      name: "No",
      note: "",
      channel: "pos",
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("free_selection_required");
    await axe(terminal);
  } finally {
    await terminalContext.close();
    await sql.end();
    await admin.end();
  }
});

test("POS shell: the primary's own transfer is no warning; a recovery-code transfer is a critical alert (ACC-1)", async ({
  page,
  context,
  baseURL,
}) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  const owner = await ownerFixture(sql, "shellwarn");
  const thief = await ownerFixture(sql, "shellthief");
  try {
    const tenantId = await ownerRestaurant(sql, owner, "Aviso fixture");
    const [{ organization_id: organizationId }] =
      await admin`select organization_id from restaurants where id=${tenantId}`;
    // The primary starts a transfer from their own account.
    const own = await withOwner(sql, owner.cookie, undefined, (tx, a) =>
      requestTransfer(
        tx,
        a,
        {
          operationId: randomUUID(),
          organizationId,
          email: `nuevo-${randomUUID().slice(0, 8)}@example.com`,
          previousOwnerStays: true,
          confirmName: "Aviso fixture",
        },
        PUBLISHED_LEGAL,
      ),
    );
    await useOwnerCookie(context, owner, baseURL);
    await page.goto("/app");
    const shell = () =>
      page.waitForResponse(
        (r) => r.url().endsWith("/api/account/shell") && r.ok(),
      );
    let answered = shell();
    await page
      .locator(".row.between")
      .filter({ hasText: "Aviso fixture" })
      .getByRole("button", { name: "Entrar", exact: true })
      .click();
    await expect(page.locator(".scope")).toContainText("Aviso fixture");
    await answered;
    await expect(page.locator(".plan-notice.critical")).toHaveCount(0);
    await expect(
      page.getByText(/Soporte inició una transferencia/),
    ).toHaveCount(0);
    // A recovery code redeemed by someone else is the hijack warning.
    await withOwner(sql, owner.cookie, undefined, (tx, a) =>
      cancelTransfer(tx, a, { transferId: own.id }),
    );
    const { codes } = await withOwner(sql, owner.cookie, undefined, (tx, a) =>
      generateRecoveryCodes(tx, a),
    );
    await withOwner(sql, thief.cookie, undefined, (tx, a) =>
      redeemRecoveryCode(tx, a, { code: codes[0] }),
    );
    answered = shell();
    await page.reload();
    await answered;
    const warning = page.locator(".plan-notice.critical");
    await expect(warning).toHaveAttribute("role", "alert");
    await expect(warning).toContainText(
      "Se usó un código de recuperación para transferir la propiedad a",
    );
    await expect(warning).not.toContainText("Soporte inició");
    await expect(
      warning.getByRole("button", {
        name: "Cancelar transferencia",
        exact: true,
      }),
    ).toBeVisible();
    await axe(page);
  } finally {
    await deleteOwnerFixtures(admin, [owner.accountId, thief.accountId]);
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

test("a new account sees its restaurant form first at 390 px; the recovery tools wait behind a disclosure (UX-8)", async ({
  page,
  context,
  baseURL,
}) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  const owner = await ownerFixture(sql, "firstform");
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await useOwnerCookie(context, owner, baseURL);
    await page.goto("/app");
    const form = page.getByRole("form", { name: "Crea tu restaurante" });
    await expect(form).toBeVisible();
    // The first form control after the account header is the restaurant name.
    const first = await page.evaluate(() => {
      const header = [...document.querySelectorAll("h2")].find(
        (h) => h.textContent === "Tu restaurante",
      )!;
      const controls = [
        ...document.querySelectorAll(
          "input, select, textarea, button, a.button",
        ),
      ].filter(
        (el) =>
          header.compareDocumentPosition(el) &
            Node.DOCUMENT_POSITION_FOLLOWING &&
          (el as HTMLElement).offsetParent !== null,
      );
      return controls[0]?.getAttribute("name");
    });
    expect(first).toBe("restaurantName");
    // The recovery panels are collapsed until the account owns something.
    const more = page.getByText(
      "Códigos de recuperación y recuperar una cuenta anterior",
      { exact: true },
    );
    await expect(more).toBeVisible();
    await expect(
      page.getByLabel("Código de recuperación", { exact: true }),
    ).toBeHidden();
    await more.click();
    await expect(
      page.getByLabel("Código de recuperación", { exact: true }),
    ).toBeVisible();
    await axe(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    await deleteOwnerFixtures(admin, [owner.accountId]);
    await sql.end();
    await admin.end();
  }
});

test("a Google session older than 15 minutes sees the sign-in prompt before the sensitive forms, which stay disabled (UX-2)", async ({
  page,
  context,
  baseURL,
}) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  const owner = await ownerFixture(sql, "stale-session");
  try {
    await ownerRestaurant(sql, owner, "Sesión vieja");
    await admin`update owner_sessions set created_at=now()-interval '1 hour' where id=${ownerCookie(owner.cookie).id}`;
    await page.setViewportSize({ width: 390, height: 844 });
    await useOwnerCookie(context, owner, baseURL);
    await page.goto("/app");
    const console = center(page);
    const transfer = console
      .locator("form")
      .filter({ hasText: "Crear enlace de transferencia" });
    await expect(transfer).toContainText(
      "Para invitar o quitar copropietarios, transferir la propiedad o generar códigos de recuperación, inicia sesión con Google de nuevo",
    );
    await expect(
      transfer.getByRole("link", { name: "Iniciar sesión de nuevo" }),
    ).toHaveAttribute("href", "/api/auth/google/start");
    await expect(
      transfer.getByLabel("Correo de Google de la nueva persona titular", {
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      transfer.getByRole("button", { name: "Crear enlace de transferencia" }),
    ).toBeDisabled();
    const invite = console
      .locator("form")
      .filter({ hasText: "Invitar copropietario" });
    await expect(
      invite.getByRole("link", { name: "Iniciar sesión de nuevo" }),
    ).toBeVisible();
    await expect(
      invite.getByRole("button", { name: "Crear invitación" }),
    ).toBeDisabled();
    await expect(
      console.getByRole("button", { name: "Generar códigos nuevos" }),
    ).toBeDisabled();
    await axe(page);
    // A fresh session shows no prompt.
    await admin`update owner_sessions set created_at=now() where id=${ownerCookie(owner.cookie).id}`;
    await page.reload();
    await expect(
      center(page).getByRole("button", {
        name: "Crear enlace de transferencia",
      }),
    ).toBeEnabled();
    await expect(
      center(page).getByText(/inicia sesión con Google de nuevo/),
    ).toHaveCount(0);
  } finally {
    await deleteOwnerFixtures(admin, [owner.accountId]);
    await sql.end();
    await admin.end();
  }
});

test("a Google-member manager with an older acceptance re-accepts in the console, without the DPA (LEGAL-4)", async ({
  page,
  context,
  baseURL,
}) => {
  const { sql, admin } = fixtureDatabases(baseURL);
  const owner = await ownerFixture(sql, "legal4owner");
  const manager = await ownerFixture(sql, "legal4manager");
  try {
    const tenantId = await ownerRestaurant(sql, owner, "Gerente Google");
    const invitation = await withOwner(sql, owner.cookie, undefined, (tx, a) =>
      createInvitation(
        tx,
        a.id,
        {
          operationId: randomUUID(),
          tenantId,
          email: manager.email,
          role: "manager",
        },
        PUBLISHED_LEGAL,
      ),
    );
    await withOwner(sql, manager.cookie, undefined, (tx, a) =>
      acceptInvitation(
        tx,
        a,
        {
          token: invitation.path.split("#invite=")[1],
          legalAccepted: {
            terms: CURRENT_ACCEPTANCE.terms,
            privacy: CURRENT_ACCEPTANCE.privacy,
          },
        },
        PUBLISHED_LEGAL,
      ),
    );
    await admin`insert into legal_acceptances(id,account_id,owner_session_id,document,version,content_hash,entity_hash,published,locale,context)
      values(${randomUUID()},${manager.accountId},${ownerCookie(manager.cookie).id},'privacy','2026-01-01',${legalContentHash("privacy")},${PUBLISHED_LEGAL.entityHash},true,'es','reacceptance')`;
    await useOwnerCookie(context, manager, baseURL);
    await page.goto("/app");
    const panel = center(page)
      .locator(".panel")
      .filter({ hasText: "Actualizamos nuestros documentos" });
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole("heading", {
        name: `Aviso de privacidad · ${LEGAL_DOCUMENTS.privacy.version}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(panel.getByText(/Contrato de encargo/)).toHaveCount(0);
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
    await axe(page);
    await panel
      .getByRole("button", { name: "Aceptar y continuar", exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    const [row] =
      await admin`select version,context from legal_acceptances where account_id=${manager.accountId}
        and document='privacy' order by accepted_at desc limit 1`;
    expect(row).toMatchObject({
      version: LEGAL_DOCUMENTS.privacy.version,
      context: "reacceptance",
    });
  } finally {
    await deleteOwnerFixtures(admin, [owner.accountId, manager.accountId]);
    await sql.end();
    await admin.end();
  }
});

test("the Google button waits for the legal configuration, so no sign-in starts without the simplified notice (LEGAL-1)", async ({
  page,
}) => {
  await page.route("**/api/auth/providers", (route) =>
    route.fulfill({ json: { google: true, billingSandbox: false } }),
  );
  let fail = true;
  await page.route("**/api/account-config", (route) =>
    fail ? route.fulfill({ status: 503, json: {} }) : route.fallback(),
  );
  await page.goto("/app?signup");
  const unavailable = page
    .getByRole("alert")
    .filter({ hasText: "No pudimos cargar los documentos legales." });
  await expect(unavailable).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Continuar con Google" }),
  ).toHaveCount(0);
  fail = false;
  await unavailable.getByRole("button", { name: "Reintentar" }).click();
  await expect(
    page.getByRole("link", { name: "Continuar con Google", exact: true }),
  ).toHaveAttribute("aria-describedby", "signup-privacy-notice");
  await expect(page.locator("#signup-privacy-notice")).toContainText(
    `con domicilio en ${LEGAL_CI_ENV.LEGAL_ENTITY_ADDRESS}`,
  );
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
