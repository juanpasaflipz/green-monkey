import "dotenv/config";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { connect } from "../../server/db.js";
import {
  signInGoogleOwner,
  withOwner,
  createOwnerRestaurant,
} from "../../server/owner-accounts.js";

test("Free register selection preserves access and permits one selling browser", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const u = new URL(process.env.DATABASE_URL!);
  if (
    u.hostname !== "127.0.0.1" ||
    !/^\/green_monkey(_[a-z]+)?_dev$/.test(u.pathname) ||
    new URL(baseURL!).hostname !== "127.0.0.1"
  )
    throw Error("Local dev fixture only");
  const sql = connect(process.env.DATABASE_URL!);
  const cookie = await signInGoogleOwner(sql, {
    issuer: "https://accounts.google.com",
    subject: randomUUID(),
    email: "free-ui@example.com",
    name: "Free UI owner",
  });
  const account = await withOwner(sql, cookie, undefined, async (_tx, a) => a);
  const r = await withOwner(sql, cookie, undefined, (tx, a) =>
    createOwnerRestaurant(tx, a, {
      restaurantName: "Free UI fixture",
      currency: "MXN",
      timezone: "America/Mexico_City",
      cutoff: 240,
      openingDays: [1, 2, 3, 4, 5],
    }),
  );
  await sql.end();
  const other = await browser.newContext({ baseURL });
  try {
    for (const c of [context, other]) {
      await c.addCookies([
        {
          name: "gm_account",
          value: cookie,
          url: baseURL!,
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
      const response = await c.request.post("/api/auth/account/enter", {
        headers: { "x-csrf-token": account.csrf },
        data: { tenantId: r.tenantId },
      });
      expect(response.ok()).toBe(true);
    }
    const second = await other.newPage();
    await second.goto("/app");
    await expect(second.getByText(/Free: esta sucursal/)).toBeVisible();
    await second
      .getByRole("button", { name: "Configuración", exact: true })
      .click();
    const current = await second.evaluate(async () =>
      (await fetch("/api/session")).json(),
    );
    await second
      .getByRole("combobox", { name: "Dispositivo de venta", exact: true })
      .selectOption(current.deviceId);
    await second
      .getByRole("button", { name: "Guardar selección Free" })
      .click();
    await expect(
      second.getByText("Selección guardada.", { exact: true }),
    ).toBeVisible();
    await expect(second.getByText(/Free: esta sucursal/)).toHaveCount(0);
    const selectedSession = await second.evaluate(async () =>
      (await fetch("/api/session")).json(),
    );
    for (const [index, name] of ["Ana Free", "Luis Free"].entries()) {
      const employee = await second.evaluate(
        async ({ csrf, input }) => {
          const response = await fetch("/api/team/save", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": csrf,
            },
            body: JSON.stringify(input),
          });
          return { ok: response.ok, body: await response.json() };
        },
        {
          csrf: selectedSession.csrf,
          input: {
            operationId: randomUUID(),
            id: randomUUID(),
            name,
            login: `free-${index}-${randomUUID()}`,
            role: index ? "server" : "cashier",
            secret: "123456",
            active: true,
          },
        },
      );
      expect(employee.ok, JSON.stringify(employee.body)).toBe(true);
    }
    await second.reload();
    await second
      .getByRole("button", { name: "Configuración", exact: true })
      .click();
    const ana = second.getByRole("checkbox", { name: "Ana Free" });
    const luis = second.getByRole("checkbox", { name: "Luis Free" });
    await expect(ana).toBeChecked();
    await expect(luis).toBeChecked();
    await ana.focus();
    await second.keyboard.press("Space");
    await expect(ana).not.toBeChecked();
    await second.keyboard.press("Space");
    await expect(ana).toBeChecked();
    await second
      .getByRole("button", { name: "Guardar selección Free" })
      .click();
    await expect(
      second.getByText("Selección guardada.", { exact: true }),
    ).toBeVisible();
    await page.goto("/app");
    await expect(page.getByText(/Free: esta sucursal/)).toBeVisible();
    const unselectedSession = await page.evaluate(async () =>
      (await fetch("/api/session")).json(),
    );
    const deniedDrawer = await page.evaluate(
      async ({ csrf, operationId }) => {
        const response = await fetch("/api/cash/open", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrf,
          },
          body: JSON.stringify({ operationId, opening: 0 }),
        });
        return { status: response.status, body: await response.json() };
      },
      { csrf: unselectedSession.csrf, operationId: randomUUID() },
    );
    expect(deniedDrawer.status).toBe(403);
    expect(deniedDrawer.body).toMatchObject({
      error: "free_selection_required",
    });
    expect(
      await page.evaluate(async () => (await fetch("/api/catalog")).ok),
    ).toBe(true);
    for (const locale of ["es", "en"] as const) {
      if (locale === "en") {
        await second.getByRole("button", { name: "ES", exact: true }).click();
        await expect(
          second.getByRole("heading", { name: "Free register and team" }),
        ).toBeVisible();
        await expect(
          second.getByRole("button", { name: "Save Free selection" }),
        ).toBeVisible();
      }
      for (const [width, height] of [
        [1440, 900],
        [1024, 768],
        [768, 1024],
        [390, 844],
      ]) {
        await second.setViewportSize({ width, height });
        expect(
          (
            await new AxeBuilder({ page: second })
              .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
              .analyze()
          ).violations,
        ).toEqual([]);
        await second.screenshot({
          path: `docs/evidence/free-selection-m1-${locale}-${width}.png`,
          fullPage: true,
        });
      }
    }
  } finally {
    await other.close();
  }
});
