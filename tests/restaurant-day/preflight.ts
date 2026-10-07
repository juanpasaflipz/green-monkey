/**
 * G1 preflight (specs/acceptance.md §4.1), before A1.
 */
import { expect, type APIRequestContext } from "@playwright/test";
import postgres from "postgres";
import type { RunState } from "./env.js";
import { checkpoint, run, type Devices } from "./ui.js";

export async function preflight(dev: Devices, request: APIRequestContext, state: RunState) {
  // G1.1
  expect((await request.get("/api/health")).status()).toBe(200);
  const status = await (await request.get("/api/ops/status")).json();
  expect(status).toMatchObject({ ok: true, schema: "ready", worker: { status: "ok" }, degraded: false });
  // G1.2: the stamped commit in CI; a local build reports "local".
  const version = await (await request.get("/api/version")).json();
  expect(version.commit).toBe(process.env.GITHUB_SHA ?? "local");
  // G1.6: published legal documents; production hides `missing`.
  const config = await (await request.get("/api/account-config")).json();
  expect(config.legal.status, "G1.6 legal documents published").toBe("published");
  expect(config.legal.signupOpen).toBe(true);
  expect(config.legal).not.toHaveProperty("missing");
  // G1.7: a refusal carries its request id in the body and the header.
  const session = await request.get("/api/session");
  expect(session.status()).toBe(401);
  const body = await session.json();
  expect(body).toMatchObject({ error: expect.any(String), requestId: expect.any(String) });
  expect(session.headers()["x-request-id"]).toBe(body.requestId);

  // G1.5: an empty database (no demo restaurants or staff).
  const admin = postgres(process.env.RD_PROVISIONER_URL!, { max: 1 });
  try {
    const [counts] = await admin.begin(async (t) => {
      const tx = t as unknown as postgres.Sql;
      await tx`set transaction read only`;
      return tx`select (select count(*)::int from restaurants) as restaurants,
        (select count(*)::int from employees) as employees`;
    });
    expect(counts).toEqual({ restaurants: 0, employees: 0 });
  } finally {
    await admin.end();
  }

  // G1.3 / G1.4: an unpaired device sees only the pairing gate and the owner entry.
  const probe = await dev("probe");
  const terminal = await (await probe.page.request.get("/api/access/terminal")).json();
  expect(terminal).toMatchObject({ paired: false, demo: null });
  await probe.page.goto("/app");
  const page = probe.page;
  await expect(page.getByRole("heading", { name: "Vincular este dispositivo" })).toBeVisible();
  await expect(page.getByLabel("Código de vinculación")).toBeVisible();
  await expect(page.getByRole("button", { name: "Vincular", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "¿Eres el propietario?" })).toBeVisible();
  for (const absent of ["Acceso de demostración", "Entorno de demostración · Datos ficticios"])
    await expect(page.getByText(absent)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /restaurante|tenant/i })).toHaveCount(0);
  await expect(page.locator('input[value="owner"]')).toHaveCount(0);

  // G1.8: the signup entry never shows the staff PIN form; the simplified
  // privacy notice sits next to the Google button.
  run.step = "G1.8";
  await page.goto("/app?signup");
  const google = page.getByRole("link", { name: "Continuar con Google" });
  await expect(google).toBeVisible();
  await expect(google).toHaveAttribute("aria-describedby", "signup-privacy-notice");
  const notice = page.locator("#signup-privacy-notice");
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("link", { name: "Aviso de privacidad" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "¿Quién entra?" })).toHaveCount(0);
  await expect(page.getByLabel(/^PIN de /)).toHaveCount(0);
  await checkpoint(probe, "G1-signup-entry", { axe: false });
  expect(state.businessDateA).toMatch(/^\d{4}-\d{2}-\d{2}$/);
}
