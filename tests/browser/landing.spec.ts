import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { LANDING_CLAIMS } from "../../src/marketing/claims";

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

test("kitchen notes are advertised: service 024 shows them on KDS tickets (LANDING_CLAIMS.kitchenNotes)", async ({
  page,
}) => {
  expect(LANDING_CLAIMS.kitchenNotes).toBe(true);
  await page.goto("/");
  await expect(
    page.getByText(
      "De la primera ronda a la cuenta dividida. Mesas, notas y pagos juntos, para seguir el ritmo del servicio.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("Sin cebolla", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cocina", exact: true }).click();
  await expect(
    page.getByText("Sin cebolla · Ronda 1", { exact: true }),
  ).toBeVisible();
});

test("signup CTA opens Google signup with simplified notice and without the staff demo form (FOH-14)", async ({
  page,
}) => {
  // UI contract fixture: Google sign-in configured (the compiled CI server has
  // no Google client, so the provider flag is substituted).
  await page.route("**/api/auth/providers", (route) =>
    route.fulfill({ json: { google: true, billingSandbox: false } }),
  );
  await page.goto("/");
  // account (031): kitchen-note examples follow LANDING_CLAIMS.kitchenNotes
  // (on since service 024; the claim test above checks them while it is on).
  if (!LANDING_CLAIMS.kitchenNotes)
    for (const note of ["Sin cebolla", "Sin hielo", "Sin azúcar"])
      await expect(page.getByText(note, { exact: false })).toHaveCount(0);
  await page
    .getByRole("link", { name: "Crear cuenta gratis", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/app\?signup$/);
  await expect(
    page.getByRole("heading", { name: "Crear cuenta", exact: true }),
  ).toBeVisible();
  const google = page.getByRole("link", {
    name: "Continuar con Google",
    exact: true,
  });
  await expect(google).toHaveAttribute("href", "/api/auth/google/start");
  await expect(google).toHaveAttribute(
    "aria-describedby",
    "signup-privacy-notice",
  );
  const notice = page.locator("#signup-privacy-notice");
  await expect(notice).toContainText("es responsable de tus datos personales.");
  await expect(
    notice.getByRole("link", { name: "Aviso de privacidad", exact: true }),
  ).toHaveAttribute("href", "/legal/privacidad");
  // The staff demo form is never offered on the signup path.
  await expect(page.getByLabel("Contraseña o PIN")).toHaveCount(0);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});

test("QR and kiosk ordering are not advertised when public ordering is disabled", async ({
  page,
}) => {
  const real = await (await page.request.get("/api/account-config")).json();
  for (const enabled of [false, true]) {
    await page.unroute("**/api/account-config");
    await page.route("**/api/account-config", (route) =>
      route.fulfill({ json: { ...real, publicOrdering: { enabled } } }),
    );
    await page.goto("/");
    // The footer's support link comes from the same configuration: once it
    // is a mailto link the page has applied the switch (absence is otherwise
    // also the state before the configuration loads).
    await expect(
      page
        .getByRole("navigation", { name: "Legal y soporte" })
        .getByRole("link", { name: "Soporte", exact: true }),
    ).toHaveAttribute("href", /^mailto:/);
    const kiosk = page.getByText("Kiosco y pedidos QR", { exact: true });
    const faq = page
      .locator("summary")
      .filter({ hasText: "¿El kiosco viene con Pro?" });
    if (enabled) {
      await expect(kiosk).toBeVisible();
      await expect(faq).toBeVisible();
    } else {
      await expect(kiosk).toHaveCount(0);
      await expect(faq).toHaveCount(0);
    }
  }
});
