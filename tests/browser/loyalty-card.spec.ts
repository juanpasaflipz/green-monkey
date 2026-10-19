import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
// Match the existing kiosk/offline harness for WebKit on local plain HTTP.
// Production HTTPS keeps its CSP; the public card does not use session cookies.
test.beforeEach(async ({ context, browserName, baseURL }) => {
  if (browserName !== "webkit" || !baseURL?.startsWith("http:")) return;
  await context.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const response = await route.fetch();
    const headers = response.headers();
    if (headers["content-security-policy"])
      headers["content-security-policy"] = headers["content-security-policy"]
        .split(";")
        .filter((part) => part.trim() !== "upgrade-insecure-requests")
        .join(";");
    await route.fulfill({ response, headers });
  });
});

const token =
  "10000000-0000-4000-8000-000000000001.20000000-0000-4000-8000-000000000001." +
  "a".repeat(43);
test("digital card: mobile layout, referral and consent @cross", async ({
  page,
}) => {
  let consent = true,
    stamps = 3;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/club/card**", async (route) => {
    const req = route.request();
    expect(req.headers()["x-gm-card-token"]).toBe(token);
    const path = new URL(req.url()).pathname;
    if (path.endsWith("/preferences"))
      consent = req.postDataJSON().marketingOptIn;
    if (path.endsWith("/referral")) {
      expect(req.postDataJSON().code).toBe("AABBCCDDEEFF0011");
      stamps += 2;
      await route.fulfill({ json: { awarded: true } });
      return;
    }
    if (path.endsWith("/wallet")) {
      await route.fulfill({ json: { apple: false, google: null } });
      return;
    }
    await route.fulfill({
      json: {
        restaurantName: "Café de prueba",
        programName: "Club de prueba",
        stamps,
        required: 10,
        rewards: 1,
        rewardDescription: "Un café gratis",
        scanCode: "gm-club:" + "a".repeat(32),
        referralCode: "0011223344556677",
        reviewUrl: "https://example.com/review",
        marketingOptIn: consent,
        walletEnabled: true,
      },
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/club/card#" + token);
  await expect(
    page.getByRole("heading", { name: "Club de prueba" }),
  ).toBeVisible();
  await expect(page.getByText("3 / 10 sellos")).toBeVisible();
  await page.getByLabel("Recibir mensajes y recordatorios del club").uncheck();
  await expect.poll(() => consent).toBe(false);
  await page.getByLabel(/¿Quién te recomendó/).fill("AABBCCDDEEFF0011");
  await page.getByRole("button", { name: "Aplicar código" }).click();
  await expect(page.getByText("¡Ambos recibieron sellos!")).toBeVisible();
  await expect(page.getByText("5 / 10 sellos")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(a11y.violations).toEqual([]);
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.getByText("5 / 10 stamps")).toBeVisible();
  expect(errors).toEqual([]);
});
test("revoked card hides balances and directs the member to checkout", async ({
  page,
}) => {
  await page.route("**/api/club/card", (route) =>
    route.fulfill({ status: 401, json: { error: "unauthorized" } }),
  );
  await page.goto("/club/card#" + token);
  await expect(page.getByRole("alert")).toContainText("Pide una nueva en caja");
  await expect(page.locator("svg")).toHaveCount(0);
});
