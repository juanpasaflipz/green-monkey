import "dotenv/config";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../../server/db.js";
import { signInGoogleOwner, ownerCookie } from "../../server/owner-accounts.js";
import { deleteAccountRows } from "./account-fixtures.js";

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
    !/^\/green_monkey(_[a-z]+)?_dev$/.test(u.pathname) ||
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
    // account (031): the browser run publishes the fictional CI legal set, so
    // the restaurant is created only after the acceptance boxes are checked.
    const create = page.getByRole("button", {
      name: "Create free restaurant",
      exact: true,
    });
    await expect(create).toBeDisabled();
    await page
      .getByRole("checkbox", {
        name: "I accept the Terms of service and my restaurant's Data processing agreement.",
        exact: true,
      })
      .check();
    await page
      .getByRole("checkbox", {
        name: "I have read the Privacy notice.",
        exact: true,
      })
      .check();
    // account (031, UX-3): the express billing consent is its own box.
    await expect(create).toBeDisabled();
    await page
      .getByRole("checkbox", {
        name: "I expressly consent to the processing of my financial and property data to bill my restaurant's subscription, as the Privacy notice explains.",
        exact: true,
      })
      .check();
    await expect(create).toBeEnabled();
    await create.focus();
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
        // account (031, SAAS_TAX_MODE=off): the tax line replaces "plus applicable taxes".
        name: "I agree to continue to Stripe with the selected interval; any paid subscription recurs per restaurant. Price before taxes. VAT and the subscription invoice (CFDI) are not configured yet.",
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
    await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source) values(${account.restaurants[0].id},'active',now()+interval '1 day','fixture')`;
    await page.route("**/api/auth/providers", (route) =>
      route.fulfill({ json: { google: true, billingSandbox: true } }),
    );
    await page.unroute("**/api/billing/status?*");
    let locationQuoteTenant = "";
    let locationConfirmed = false;
    const quoteId = randomUUID();
    await page.route("**/api/billing/status?*", (route) =>
      route.fulfill({
        json: {
          enabled: true,
          hostedUrl: null,
          billing: { interval: "month" },
          operation: locationQuoteTenant
            ? {
                id: quoteId,
                tenant_id: locationQuoteTenant,
                kind: locationConfirmed ? "location_update" : "location_quote",
                state: locationConfirmed ? "pending" : "succeeded",
                result: {
                  amountDue: 39950,
                  locations: 2,
                  expiresAt: Math.floor(Date.now() / 1000) + 600,
                  trialEnd: null,
                },
              }
            : null,
        },
      }),
    );
    await page.route("**/api/billing/locations/quote", (route) => {
      locationQuoteTenant = route.request().postDataJSON().tenantId;
      return route.fulfill({ status: 202, json: { operationId: quoteId } });
    });
    await page.route("**/api/billing/locations/confirm", (route) => {
      expect(route.request().postDataJSON()).toEqual({
        quoteId,
        consent: true,
      });
      locationConfirmed = true;
      return route.fulfill({
        status: 202,
        json: { operationId: randomUUID() },
      });
    });
    await page.goto("/app?account=1");
    await page
      .getByText("Manage locations and access", { exact: true })
      .click();
    await page
      .getByLabel("Google email", { exact: true })
      .fill("colleague@example.com");
    await page
      .getByRole("button", { name: "Create link", exact: true })
      .click();
    await expect(
      page.getByLabel("Invitation link — copy and share", { exact: true }),
    ).toHaveValue(/#invite=/);
    await page
      .getByRole("button", { name: "Revoke link", exact: true })
      .click();
    await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
    await page
      .getByLabel("New location name", { exact: true })
      .fill("Second test location");
    await page
      .getByRole("button", { name: "Create pending location", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Activation pending", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("heading", { name: "Activate location", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Get quote", exact: true }).click();
    await expect(page.getByText(/Amount now:.*399\.50/)).toBeVisible();
    await expect(
      page.getByText(/New recurring total:.*1,598\.00/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Confirm activation", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("checkbox", {
        name: "I accept the quoted amount and the new total for my organization’s locations.",
        exact: true,
      })
      .check();
    await page
      .getByRole("button", { name: "Confirm activation", exact: true })
      .click();
    await expect.poll(() => locationConfirmed).toBe(true);
    const managementAxe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(managementAxe.violations).toEqual([]);
    await page.screenshot({
      path: "docs/evidence/owner-locations.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Enter", exact: true }).click();
    await expect(page.locator(".scope")).toContainText("Restaurante de prueba");
    const [devices] =
      await admin`select count(*)::int as n from devices where tenant_id=${account.restaurants[0].id}`;
    expect(devices.n).toBe(1);
    const staleTab = await context.newPage();
    await staleTab.goto("/app");
    await expect(staleTab.locator(".scope")).toContainText(
      "Restaurante de prueba",
    );
    const second =
      await admin`select r.id from restaurants r join owner_memberships m on m.tenant_id=r.id where m.account_id=${accountId} and r.activation_pending`;
    // Canonical billing activation is covered by provider + DB tests above.
    await admin`update restaurants set activation_pending=false where id=${second[0].id}`;
    await page.goto("/app?account=1");
    await page
      .locator(".row.between")
      .filter({ hasText: "Second test location" })
      .getByRole("button", { name: "Enter", exact: true })
      .click();
    await expect(page.locator(".scope")).toContainText("Second test location");
    await expect(
      staleTab.getByText(
        "The session changed in another tab. Reload to continue in the active restaurant.",
        { exact: true },
      ),
    ).toBeVisible();
    await staleTab.close();
    await page.goto("/app?account=1");
    const loggedOut = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/auth/account/logout") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Sign out of account", exact: true })
      .click();
    expect((await loggedOut).status()).toBe(200);
    expect((await page.request.get("/api/auth/account")).status()).toBe(401);
    expect((await page.request.get("/api/session")).status()).toBe(401);
  } finally {
    await deleteAccountRows(admin, [accountId]);
    const tenants =
      await admin`select tenant_id from owner_memberships where account_id=${accountId}`;
    for (const { tenant_id } of tenants) {
      await admin`delete from signup_billing_intents where tenant_id=${tenant_id}`;
      await admin`delete from restaurant_invitations where tenant_id=${tenant_id}`;
      await admin`delete from owner_location_commands where tenant_id=${tenant_id}`;
      await admin`delete from restaurant_entitlements where tenant_id=${tenant_id}`;
      await admin`delete from audit where tenant_id=${tenant_id}`;
      await admin`delete from sessions where tenant_id=${tenant_id}`;
      await admin`delete from owner_browser_devices where tenant_id=${tenant_id}`;
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
