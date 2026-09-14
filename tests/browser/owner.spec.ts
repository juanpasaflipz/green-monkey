import "dotenv/config";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../../server/db.js";
import { signInGoogleOwner, ownerCookie } from "../../server/owner-accounts.js";

test("verified-identity fixture: owner signup, responsive forms, entry and logout", async ({
  page,
  context,
  baseURL,
}) => {
  const runtime = process.env.DATABASE_URL!,
    migration = process.env.MIGRATION_DATABASE_URL!;
  const u = new URL(runtime),
    m = new URL(migration),
    base = new URL(baseURL!);
  if (
    !["localhost", "127.0.0.1"].includes(u.hostname) ||
    u.hostname !== m.hostname ||
    u.port !== m.port ||
    u.pathname !== m.pathname ||
    u.pathname !== "/green_monkey_dev" ||
    !["localhost", "127.0.0.1"].includes(base.hostname)
  )
    throw Error(
      "Owner UI fixtures require the isolated local dev database and browser",
    );
  const sql = connect(runtime),
    admin = postgres(migration, { max: 1 });
  // This deliberately substitutes verified identity, not Google's external flow.
  const cookie = await signInGoogleOwner(sql, {
    issuer: "https://accounts.google.com",
    subject: randomUUID(),
    email: "browser-owner@example.com",
    name: "Fictional browser owner",
  });
  const accountId = ownerCookie(cookie).accountId;
  try {
    await context.addCookies([
      {
        name: "gm_account",
        value: cookie,
        url: base.origin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    await page.goto("/app");
    await expect(
      page.getByLabel("Nombre del restaurante", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Nombre del restaurante", { exact: true })
      .fill("Restaurante de prueba");
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [768, 1024],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await expect(
        page.getByRole("button", {
          name: "Crear restaurante gratis",
          exact: true,
        }),
      ).toBeVisible();
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
      await page.screenshot({
        path: `docs/evidence/owner-signup-${width}.png`,
        fullPage: true,
      });
    }
    await page.getByRole("button", { name: "English", exact: true }).click();
    await expect(
      page.getByLabel("Business day starts at", { exact: true }),
    ).toHaveValue("04:00");
    await page
      .getByRole("button", { name: "Create free restaurant", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".scope")).toContainText("Restaurante de prueba");
    const account = await (await page.request.get("/api/auth/account")).json();
    expect(account.restaurants).toHaveLength(1);
    const forbidden = await page.request.post("/api/auth/account/enter", {
      headers: { "x-csrf-token": account.csrf },
      data: { tenantId: "10000000-0000-4000-8000-000000000001" },
    });
    expect(forbidden.status()).toBe(403);
    // UI contract fixture only; real Stripe flows are verified separately.
    let billingChoice: unknown = null;
    await page.route("**/api/billing/status?*", (route) =>
      route.fulfill({
        json: {
          enabled: true,
          billing: null,
          operation: null,
          entitlement: null,
        },
      }),
    );
    await page.route("**/api/billing/request", (route) => {
      billingChoice = route.request().postDataJSON();
      return route.fulfill({ status: 202, json: { state: "pending" } });
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page.getByText(
        "Billing test environment. No real payments are charged.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Subscribe in Stripe (test)",
        exact: true,
      }),
    ).toBeDisabled();
    await page
      .getByRole("combobox", { name: "Billing interval", exact: true })
      .selectOption("year");
    await page
      .getByRole("checkbox", {
        name: "I agree to continue to Stripe with the selected interval; any paid subscription recurs per restaurant, plus applicable taxes.",
        exact: true,
      })
      .check();
    await page
      .getByRole("button", { name: "Subscribe in Stripe (test)", exact: true })
      .click();
    await expect
      .poll(() => billingChoice)
      .toEqual({
        tenantId: account.restaurants[0].id,
        kind: "checkout",
        interval: "year",
        consent: true,
      });
    const billingAxe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(billingAxe.violations).toEqual([]);
    const loggedOut = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/logout") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    expect((await loggedOut).status()).toBe(200);
    expect((await page.request.get("/api/auth/account")).status()).toBe(401);
    expect((await page.request.get("/api/session")).status()).toBe(401);
  } finally {
    const tenants =
      await admin`select tenant_id from owner_memberships where account_id=${accountId}`;
    for (const { tenant_id } of tenants) {
      await admin`delete from signup_billing_intents where tenant_id=${tenant_id}`;
      await admin`delete from audit where tenant_id=${tenant_id}`;
      await admin`delete from sessions where tenant_id=${tenant_id}`;
      await admin`delete from devices where tenant_id=${tenant_id}`;
      await admin`delete from owner_memberships where tenant_id=${tenant_id}`;
      await admin`delete from employees where tenant_id=${tenant_id}`;
      await admin`delete from restaurants where id=${tenant_id}`;
    }
    await admin`delete from organizations where created_by_account=${accountId}`;
    await admin`delete from owner_sessions where account_id=${accountId}`;
    await admin`delete from owner_accounts where id=${accountId}`;
    await sql.end();
    await admin.end();
  }
});
