import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { LEGAL_CI_ENV } from "../fixtures/legal-ci.js";
import { LEGAL_DOCUMENTS } from "../../shared/legal.js";

// account (031, FIT-12/FOH-14): the platform legal pages. The compiled browser
// run publishes the fictional CI legal set (qualification.yml, LD-3).
const VIEWPORTS = [
  [1440, 900],
  [1024, 768],
  [768, 1024],
  [390, 844],
] as const;

async function accessible(page: Page) {
  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(axe.violations).toEqual([]);
  }
}

test("legal pages render the configured entity in es/en and pass axe", async ({
  page,
}) => {
  const config = await (await page.request.get("/api/account-config")).json();
  expect(
    config.legal.status,
    "the browser server needs the fictional CI legal set (tests/fixtures/legal-ci.ts)",
  ).toBe("published");
  expect(config.legal.missing).toBeUndefined();

  await page.goto("/legal/privacidad");
  await expect(
    page.getByRole("heading", { level: 1, name: "Aviso de privacidad" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "es-MX");
  const main = page.getByRole("main");
  await expect(main).toContainText(LEGAL_CI_ENV.LEGAL_ENTITY_NAME);
  await expect(main).toContainText(LEGAL_CI_ENV.LEGAL_ENTITY_ADDRESS);
  await expect(main).toContainText(LEGAL_CI_ENV.LEGAL_PRIVACY_CONTACT_EMAIL);
  // The version and the day it took effect (LEGAL-3).
  await expect(
    page.getByText(
      `Versión ${LEGAL_DOCUMENTS.privacy.version} · Vigente desde el ${new Intl.DateTimeFormat("es-MX", { dateStyle: "long" }).format(new Date(`${LEGAL_DOCUMENTS.privacy.effectiveFrom}T12:00:00-06:00`))}`,
      { exact: true },
    ),
  ).toBeVisible();
  // Published: no draft banner, no missing-field chips, indexable.
  await expect(page.locator(".legal-missing")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  // The support contact comes from configuration.
  const contact = page.locator("#contacto");
  await expect(
    contact.getByRole("link", { name: LEGAL_CI_ENV.SUPPORT_EMAIL }),
  ).toHaveAttribute("href", `mailto:${LEGAL_CI_ENV.SUPPORT_EMAIL}`);
  await expect(contact).toContainText(LEGAL_CI_ENV.SUPPORT_HOURS);
  // The diner section the QR/kiosk footer links to.
  await page.goto("/legal/privacidad#restaurantes");
  await expect(page.locator("#restaurantes")).toBeVisible();
  await accessible(page);
  await page.screenshot({
    path: "docs/evidence/legal-privacy-390.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("link", { name: "English", exact: true }).click();
  await expect(page).toHaveURL(/\/legal\/privacy$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Privacy notice" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("main")).toContainText(
    LEGAL_CI_ENV.LEGAL_ENTITY_NAME,
  );
  await expect(
    page.getByText("If the versions differ, the Spanish version prevails.", {
      exact: true,
    }),
  ).toBeVisible();
  await accessible(page);

  for (const [path, title] of [
    ["/legal/terminos", "Términos del servicio"],
    ["/legal/encargo-de-datos", "Contrato de encargo de datos"],
    ["/legal/terms", "Terms of service"],
    ["/legal/data-processing", "Data processing agreement"],
  ] as const) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { level: 1, name: title }),
    ).toBeVisible();
    await expect(page.getByRole("main")).toContainText(
      LEGAL_CI_ENV.LEGAL_ENTITY_NAME,
    );
    await expect(page.locator(".legal-missing")).toHaveCount(0);
  }
  await accessible(page);

  await page.goto("/legal");
  await expect(
    page.getByRole("heading", { level: 1, name: "Documentos legales" }),
  ).toBeVisible();
  const index = page.locator(".legal-index");
  for (const [name, href] of [
    ["Aviso de privacidad", "/legal/privacidad"],
    ["Términos del servicio", "/legal/terminos"],
    ["Contrato de encargo de datos", "/legal/encargo-de-datos"],
  ])
    await expect(
      index.getByRole("link", { name, exact: true }),
    ).toHaveAttribute("href", href);
  await accessible(page);
});

test("unpublished config renders draft banner, missing-field chips and noindex", async ({
  page,
}) => {
  const real = await (await page.request.get("/api/account-config")).json();
  await page.route("**/api/account-config", (route) =>
    route.fulfill({
      json: {
        ...real,
        legal: {
          ...real.legal,
          status: "unpublished",
          signupOpen: false,
          entity: null,
          missing: ["LEGAL_ENTITY_NAME", "LEGAL_ENTITY_ADDRESS"],
        },
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
  await page.goto("/legal/privacidad");
  await expect(page.getByRole("alert")).toHaveText(
    "Documento no vigente: faltan datos del responsable. No lo uses como aviso de privacidad.",
  );
  const chips = page.locator(".legal-missing");
  await expect(chips.first()).toHaveText("Dato pendiente de publicar");
  expect(await chips.count()).toBeGreaterThan(1);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "noindex",
  );
  await expect(page.getByRole("main")).not.toContainText(
    LEGAL_CI_ENV.LEGAL_ENTITY_NAME,
  );
  await expect(
    page.getByText(
      "El contacto de soporte aún no está configurado en este entorno.",
      { exact: true },
    ),
  ).toBeVisible();
  await accessible(page);
});

test("landing footer links to privacy, terms, data processing and support", async ({
  page,
}) => {
  await page.goto("/");
  const footer = page.getByRole("navigation", { name: "Legal y soporte" });
  for (const [name, href] of [
    ["Aviso de privacidad", "/legal/privacidad"],
    ["Términos", "/legal/terminos"],
    ["Encargo de datos", "/legal/encargo-de-datos"],
    ["Soporte", `mailto:${LEGAL_CI_ENV.SUPPORT_EMAIL}`],
  ])
    await expect(
      footer.getByRole("link", { name, exact: true }),
    ).toHaveAttribute("href", href);
  await footer
    .getByRole("link", { name: "Aviso de privacidad", exact: true })
    .click();
  await expect(page).toHaveURL(/\/legal\/privacidad$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Aviso de privacidad" }),
  ).toBeVisible();
  await page.goto("/");
  await page.getByRole("button", { name: "Switch to English" }).click();
  const english = page.getByRole("navigation", { name: "Legal and support" });
  await expect(
    english.getByRole("link", { name: "Privacy notice", exact: true }),
  ).toHaveAttribute("href", "/legal/privacy");
  await expect(
    english.getByRole("link", { name: "Data processing", exact: true }),
  ).toHaveAttribute("href", "/legal/data-processing");
});
