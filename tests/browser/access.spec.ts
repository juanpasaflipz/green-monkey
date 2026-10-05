import "dotenv/config";
import {
  test,
  expect,
  type Browser,
  type Page,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import postgres from "postgres";

const OWNER_PASSWORD = "demo-green-monkey";
const CASHIER = { name: "Dani Demo", pin: "123456" };

/** Local fixture database only (same guard as owner.spec). */
function fixtureAdmin(baseURL: string | undefined) {
  const runtime = new URL(process.env.DATABASE_URL ?? "http://invalid"),
    migration = new URL(process.env.MIGRATION_DATABASE_URL ?? "http://invalid"),
    base = new URL(baseURL ?? "http://invalid");
  if (
    !["localhost", "127.0.0.1"].includes(runtime.hostname) ||
    runtime.hostname !== migration.hostname ||
    runtime.port !== migration.port ||
    runtime.pathname !== migration.pathname ||
    !/^\/green_monkey(_[a-z]+)?_dev$/.test(runtime.pathname) ||
    !["localhost", "127.0.0.1"].includes(base.hostname)
  )
    throw Error("Access fixtures require the isolated local dev database");
  return postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1 });
}
const tag = () => Math.random().toString(36).slice(2, 7);

async function ownerLogin(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
}
/** Calls the API as the page's current session. */
async function call<T = any>(page: Page, path: string, body?: unknown) {
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
  ) as Promise<{ status: number; body: T }>;
}
async function newCode(owner: Page, deviceName: string) {
  const r = await call<{ code: string }>(owner, "/access/pairing-codes", {
    deviceName,
  });
  expect(r.status).toBe(200);
  return r.body.code;
}
async function pair(page: Page, code: string) {
  await page.goto("/app");
  await page.getByLabel("Código de vinculación").fill(code);
  await page.getByRole("button", { name: "Vincular", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "¿Quién entra?", exact: true }),
  ).toBeVisible();
}
async function pairTerminal(browser: Browser, owner: Page, name: string) {
  const code = await newCode(owner, name);
  const context = await browser.newContext();
  const page = await context.newPage();
  await pair(page, code);
  return { context, page };
}
/** Signs in from the roster (gate or lock screen) with the keypad or a password. */
async function signIn(
  scope: Page | ReturnType<Page["getByRole"]>,
  name: string,
  secret: string,
  password = false,
) {
  await scope.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await enterSecret(scope, name, secret, password);
}
async function enterSecret(
  scope: Page | ReturnType<Page["getByRole"]>,
  name: string,
  secret: string,
  password = false,
  submit = "Entrar",
) {
  if (password) {
    await scope.getByRole("button", { name: "Usar contraseña" }).click();
    await scope.getByLabel("Contraseña o PIN").fill(secret);
  } else {
    await expect(scope.getByLabel(`PIN de ${name}`)).toBeVisible();
    for (const digit of secret)
      await scope.getByRole("button", { name: digit, exact: true }).click();
  }
  await scope.getByRole("button", { name: submit, exact: true }).click();
}
async function sessionOf(page: Page) {
  return page.evaluate(async () => (await fetch("/api/session")).json());
}
/** No horizontal overflow at four widths; axe and evidence at 1440 and 390. */
async function checkLayout(page: Page, evidence: string, include?: string) {
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [768, 1024],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    if (width === 1440 || width === 390) {
      let axe = new AxeBuilder({ page }).withTags([
        "wcag2a",
        "wcag2aa",
        "wcag21aa",
        "wcag22aa",
      ]);
      if (include) axe = axe.include(include);
      const result = await axe.analyze();
      expect(result.violations).toEqual([]);
      const path = `docs/evidence/access-${evidence}-${width}.png`;
      if (include) await page.locator(include).screenshot({ path });
      else await page.screenshot({ path, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("owner pairs a terminal with a code and a new cashier signs in with name and PIN, without any restaurant ID (FOH-2/FIT-3/SEC-4)", async ({
  page,
  browser,
}) => {
  const id = tag();
  const cashier = `Cajera ${id}`;
  await ownerLogin(page);
  // The owner adds a cashier with a PIN from Equipo.
  await page.getByRole("button", { name: "Equipo", exact: true }).click();
  await page.getByRole("button", { name: "Agregar empleado" }).click();
  const add = page.getByRole("dialog", { name: "Agregar empleado" });
  await add.getByLabel("Nombre", { exact: true }).fill(cashier);
  await add.getByLabel("Rol").selectOption({ label: "Cajero" });
  await add.getByLabel("PIN nuevo (6 a 8 dígitos)").fill("481516");
  await add.getByLabel("Confirma el PIN").fill("481516");
  await add.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(
    page.locator(".staff-management").getByRole("status"),
  ).toContainText(`${cashier} se agregó`);
  const row = page.getByRole("row").filter({ hasText: cashier });
  await expect(row).toContainText("Cajero");
  await expect(row).toContainText("Activo");
  await checkLayout(page, "team", ".staff-management");

  // A pairing code from Configuración → Dispositivos.
  await page.getByRole("button", { name: "Configuración", exact: true }).click();
  await page.getByRole("button", { name: "Vincular un dispositivo" }).click();
  const dialog = page.getByRole("dialog", { name: "Vincular un dispositivo" });
  await dialog.getByLabel("Nombre del dispositivo").fill(`Caja ${id}`);
  await dialog.getByRole("button", { name: "Generar código" }).click();
  const code = (await dialog.locator(".pairing-code-value").textContent())!;
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  await expect(dialog.getByRole("timer")).toContainText(/Vence en (9|10):/);
  await expect(dialog).toContainText(
    "elige «Vincular este dispositivo» y escribe el código",
  );
  await page.screenshot({ path: "docs/evidence/access-pairing-code-1440.png" });

  // A fresh browser: no restaurant ID field, only pairing (and demo locally).
  const terminal = await browser.newContext();
  const tablet = await terminal.newPage();
  await tablet.goto("/app");
  await expect(
    tablet.getByRole("heading", { name: "Vincular este dispositivo" }),
  ).toBeVisible();
  await expect(tablet.getByLabel("Sucursal")).toHaveCount(0);
  await expect(tablet.locator('input[name="tenantId"]')).toHaveCount(0);
  await checkLayout(tablet, "gate-unpaired");
  // Lower case, spaces and look-alikes are accepted.
  await tablet
    .getByLabel("Código de vinculación")
    .fill(code.toLowerCase().replace("-", " "));
  await tablet.getByRole("button", { name: "Vincular", exact: true }).click();
  await expect(tablet.getByText(/^Dispositivo vinculado a .+\.$/)).toBeVisible();
  await expect(tablet.getByText(`Dispositivo: Caja ${id}`)).toBeVisible();
  await expect(dialog).toContainText(`Vinculado: Caja ${id}`);
  await checkLayout(tablet, "gate-roster");

  await signIn(tablet, cashier, "481516");
  await expect(tablet.locator(".scope")).toContainText(cashier);
  await expect(tablet.locator(".scope")).toContainText("Cajero");
  const s = await sessionOf(tablet);
  expect(s.role).toBe("cashier");
  expect(s.access.deviceKind).toBe("terminal");
  expect(s.access.deviceName).toBe(`Caja ${id}`);
  // The code is single-use.
  const again = await terminal.request.post("/api/access/pair", {
    data: { code },
  });
  expect(again.status()).toBe(400);
  expect((await again.json()).error).toBe("pairing_code_invalid");
  await terminal.close();
});

test("production gate shows no demo text or prefilled values when demo access is off", async ({
  page,
}) => {
  await page.route("**/api/access/terminal", (route) =>
    route.fulfill({ json: { paired: false, google: false, demo: null } }),
  );
  await page.goto("/app");
  await expect(
    page.getByRole("heading", { name: "Vincular este dispositivo" }),
  ).toBeVisible();
  await expect(page.getByText("Acceso de demostración")).toHaveCount(0);
  await expect(page.getByText(/Entorno de demostración/)).toHaveCount(0);
  await expect(page.getByLabel("Contraseña o PIN")).toHaveCount(0);
  await expect(page.getByLabel("Usuario", { exact: true })).toHaveCount(0);
  await expect(page.locator("input")).toHaveCount(1);
  await expect(page.getByLabel("Código de vinculación")).toHaveValue("");
  await expect(page.locator("body")).not.toContainText(
    "10000000-0000-4000-8000-000000000001",
  );
  await page.screenshot({
    path: "docs/evidence/access-gate-production-1440.png",
  });
});

test("a paired terminal hides Google and the server refuses owner account entry (GAP-2)", async ({
  page,
  browser,
}) => {
  const id = tag();
  await ownerLogin(page);
  const { context, page: tablet } = await pairTerminal(
    browser,
    page,
    `Terminal ${id}`,
  );
  // Cookies are Secure in production mode, so requests go through the page.
  const server = await tablet.evaluate(async () => {
    const providers = await (await fetch("/api/auth/providers")).json();
    const enter = await fetch("/api/auth/account/enter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: "10000000-0000-4000-8000-000000000001" }),
    });
    return { providers, enter: [enter.status, (await enter.json()).error] };
  });
  expect(server.providers).toMatchObject({ google: false, terminal: true });
  expect(server.enter).toEqual([403, "device_is_terminal"]);
  await expect(
    tablet.getByText(
      "Esta es una terminal compartida. La cuenta del propietario (Google) se administra desde tu propio teléfono o computadora.",
    ),
  ).toBeVisible();
  await expect(
    tablet.getByRole("link", { name: "Continuar con Google" }),
  ).toHaveCount(0);
  // Starting Google sign-in on a terminal lands back on the notice.
  await tablet.goto("/api/auth/google/start");
  await expect(tablet).toHaveURL(/\/app\?auth_error=terminal$/);
  await expect(
    tablet.getByText(
      "Esta es una terminal compartida. La cuenta del propietario (Google) se administra desde tu propio teléfono o computadora.",
    ),
  ).toBeVisible();
  // The owner works on the terminal with their own secret, not Google.
  await signIn(tablet, "Alex Demo", OWNER_PASSWORD, true);
  await expect(
    tablet.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  await expect(
    tablet.getByRole("button", { name: "Cambiar restaurante" }),
  ).toHaveCount(0);
  await tablet.goto("/app?account=1");
  await expect(
    tablet.getByText(
      "Esta es una terminal compartida. La cuenta del propietario (Google) se administra desde tu propio teléfono o computadora.",
    ),
  ).toBeVisible();
  await context.close();
});

test("idle lock after 3 minutes keeps the cart for the same employee; switch user opens a fresh workspace (SEC-6)", async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  const id = tag();
  try {
    await ownerLogin(page);
    const code = await newCode(page, `Inactividad ${id}`);
    const context = await browser.newContext();
    const tablet = await context.newPage();
    await tablet.clock.install();
    await pair(tablet, code);
    // The browser suites run with a default auto-lock of 0 (D21); this device
    // sets the 3-minute terminal default explicitly.
    await admin`update devices set idle_lock_seconds=180 where name=${`Inactividad ${id}`}`;
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    await tablet.getByRole("button", { name: /Taco de hongos/ }).click();
    const cart = tablet.locator(".cart");
    await expect(cart).toContainText("Taco de hongos");
    await tablet.clock.fastForward("02:00");
    const lock = tablet.getByRole("dialog", { name: "Pantalla bloqueada" });
    await expect(lock).toHaveCount(0);
    await tablet.clock.fastForward("01:05");
    await expect(lock).toBeVisible();
    await expect(lock).toContainText(CASHIER.name);
    await checkLayout(tablet, "lock-screen");
    await enterSecret(lock, CASHIER.name, "000000");
    await expect(lock.getByRole("alert")).toContainText("PIN incorrecto.");
    await enterSecret(lock, CASHIER.name, CASHIER.pin);
    await expect(lock).toBeHidden();
    await expect(cart).toContainText("Taco de hongos");
    // Manual lock, then a quick switch to another employee.
    await tablet.getByRole("button", { name: "Bloquear pantalla" }).click();
    await expect(lock).toBeVisible();
    await lock.getByRole("button", { name: "Cambiar de usuario" }).click();
    await signIn(lock, "Alex Demo", OWNER_PASSWORD, true);
    await expect(tablet.locator(".scope")).toContainText("Alex Demo");
    await tablet.getByRole("button", { name: "Operación", exact: true }).click();
    await tablet.getByRole("button", { name: "Vender", exact: true }).click();
    await expect(tablet.locator(".cart")).not.toContainText("Taco de hongos");
    await context.close();
  } finally {
    await admin.end();
  }
});

test("a lock survives reloads, new tabs and offline restores; Continuar como needs a valid offline window and the PIN is asked again on reconnect (SEC-6)", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(
    !process.env.TEST_PRODUCTION,
    "Offline reload requires the compiled server's service worker",
  );
  const admin = fixtureAdmin(baseURL);
  try {
    await ownerLogin(page);
    const { context, page: tablet } = await pairTerminal(
      browser,
      page,
      `Recarga ${tag()}`,
    );
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    await tablet.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const s = await sessionOf(tablet);
    const lock = tablet.getByRole("dialog", { name: "Pantalla bloqueada" });
    const pinField = lock.getByLabel(`PIN de ${CASHIER.name}`);
    const continueAs = lock.getByRole("button", {
      name: `Continuar como ${CASHIER.name}`,
    });
    // Manual lock, then a reload: still locked and the PIN is required.
    await tablet.getByRole("button", { name: "Bloquear pantalla" }).click();
    await expect(lock).toBeVisible();
    await tablet.reload();
    await expect(lock).toBeVisible();
    await expect(pinField).toBeVisible();
    // A new tab on the same terminal opens locked as well.
    const other = await context.newPage();
    await other.goto("/app");
    await expect(
      other.getByRole("dialog", { name: "Pantalla bloqueada" }),
    ).toBeVisible();
    await other.close();
    // Offline with an expired offline window there is no way past the lock.
    await admin`update sessions set offline_until=now()-interval '1 minute' where id=${s.id}`;
    await tablet.reload();
    await expect(lock).toBeVisible();
    await context.setOffline(true);
    await expect(lock).toContainText(
      "Sin conexión no se puede verificar el PIN.",
    );
    await expect(continueAs).toHaveCount(0);
    await context.setOffline(false);
    await expect(pinField).toBeVisible();
    // With a valid window, an offline reload restores the cached session locked.
    await admin`update sessions set offline_until=now()+interval '4 hours' where id=${s.id}`;
    await tablet.reload();
    await expect(lock).toBeVisible();
    await context.setOffline(true);
    await tablet.reload();
    await expect(lock).toBeVisible();
    await expect(lock).toContainText(
      `Sin conexión no se puede verificar el PIN. Las ventas se registran a nombre de ${CASHIER.name}.`,
    );
    await tablet.screenshot({
      path: "docs/evidence/access-offline-lock-1440.png",
    });
    await continueAs.click();
    await expect(lock).toBeHidden();
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    // The connection returns: the PIN is required before any online work.
    await context.setOffline(false);
    await expect(lock).toBeVisible();
    await expect(pinField).toBeVisible();
    await enterSecret(lock, CASHIER.name, CASHIER.pin);
    await expect(lock).toBeHidden();
    // Unlocked with the PIN, a reload opens the workspace directly...
    await tablet.reload();
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    await expect(lock).toHaveCount(0);
    // ...unless the device sat idle longer than its auto-lock.
    await admin`update devices set idle_lock_seconds=600 where id=${s.deviceId}`;
    await tablet.reload();
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    await expect(lock).toHaveCount(0);
    await tablet.evaluate((id) => {
      localStorage.setItem(
        "gm-activity",
        JSON.stringify({ sessionId: id, at: Date.now() - 11 * 60_000 }),
      );
    }, s.id);
    await tablet.reload();
    await expect(lock).toBeVisible();
    await enterSecret(lock, CASHIER.name, CASHIER.pin);
    await expect(lock).toBeHidden();
    const after = await sessionOf(tablet);
    expect(after.id).toBe(s.id);
    await context.close();
  } finally {
    await admin.end();
  }
});

test("an expired session shows the PIN lock with its reason, not a generic error, and Salir works (FOH-7)", async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  try {
    await ownerLogin(page);
    const { context, page: tablet } = await pairTerminal(
      browser,
      page,
      `Vence ${tag()}`,
    );
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    const s = await sessionOf(tablet);
    await admin`update sessions set expires_at=now()-interval '1 second',
      absolute_expires_at=now()-interval '1 second' where id=${s.id}`;
    await tablet.getByRole("button", { name: "Órdenes", exact: true }).click();
    const lock = tablet.getByRole("dialog", {
      name: "Tu sesión terminó. Ingresa tu PIN para continuar.",
    });
    await expect(lock).toBeVisible();
    await expect(tablet.getByText("No se pudo completar la acción.")).toHaveCount(
      0,
    );
    await lock.getByRole("button", { name: "Salir", exact: true }).click();
    await expect(
      tablet.getByRole("heading", { name: "¿Quién entra?", exact: true }),
    ).toBeVisible();
    // Logout succeeds even without a valid session and keeps the device paired.
    const logout = await context.request.post("/api/logout");
    expect(logout.status()).toBe(200);
    await context.close();
  } finally {
    await admin.end();
  }
});

test("logout with unsent sales warns, and the sales sync when the same employee returns (OFF-7)", async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  try {
    await ownerLogin(page);
    const { context, page: tablet } = await pairTerminal(
      browser,
      page,
      `Turno ${tag()}`,
    );
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    const first = await sessionOf(tablet);
    await tablet.getByRole("button", { name: "Caja", exact: true }).click();
    await tablet.getByRole("button", { name: "Abrir caja", exact: true }).click();
    await tablet
      .getByRole("dialog")
      .getByRole("button", { name: "Guardar", exact: true })
      .click();
    await expect(tablet.getByText("Caja abierta", { exact: true })).toBeVisible();
    await tablet.getByRole("button", { name: "Vender", exact: true }).click();
    await tablet.getByRole("button", { name: /Taco de hongos/ }).click();
    await context.setOffline(true);
    await tablet.getByRole("button", { name: "Cobrar", exact: true }).click();
    await tablet
      .getByRole("button", {
        name: "Guardar cobro en este dispositivo",
        exact: true,
      })
      .click();
    await expect(tablet.locator(".receipt")).toContainText(
      "Pendiente de sincronizar",
    );
    await tablet.getByRole("button", { name: "Siguiente venta" }).click();
    // Back online, but the sync endpoint is failing.
    await tablet.route("**/api/sync", (route) =>
      route.fulfill({ status: 503, json: { error: "server_unavailable" } }),
    );
    await context.setOffline(false);
    await tablet.getByRole("button", { name: "Salir", exact: true }).click();
    const warning = tablet.getByRole("dialog", { name: "Ventas sin enviar" });
    await expect(warning).toContainText(
      "Hay 1 ventas guardadas en este dispositivo que aún no se envían.",
    );
    await tablet.screenshot({ path: "docs/evidence/access-unsent-logout-1440.png" });
    await warning
      .getByRole("button", { name: "Salir de todos modos", exact: true })
      .click();
    await expect(
      tablet.getByRole("heading", { name: "¿Quién entra?", exact: true }),
    ).toBeVisible();
    const [ended] =
      await admin`select end_reason,revoked from sessions where id=${first.id}`;
    expect(ended).toEqual({ end_reason: "logout", revoked: false });
    await tablet.unroute("**/api/sync");
    // The same employee returns on the same device: the queued sale syncs.
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(
      tablet.getByRole("button", { name: "Conectado", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    const [synced] =
      await admin`select count(*)::int as n from orders where channel='offline' and employee_id=${first.employeeId}
        and created_at>now()-interval '5 minutes'`;
    expect(synced.n).toBeGreaterThanOrEqual(1);
    await context.close();
  } finally {
    await admin.end();
  }
});

test("offline logout signs out locally and completes on reconnect (SEC-6)", async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  try {
    await ownerLogin(page);
    const { context, page: tablet } = await pairTerminal(
      browser,
      page,
      `Sin red ${tag()}`,
    );
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    const s = await sessionOf(tablet);
    await context.setOffline(true);
    await tablet.getByRole("button", { name: "Salir", exact: true }).click();
    const offline = tablet.getByRole("dialog", { name: "Sin conexión" });
    await expect(offline).toContainText(
      "Si sales ahora, nadie podrá entrar en este dispositivo hasta que vuelva la conexión.",
    );
    await expect(
      offline.getByRole("button", { name: "Bloquear pantalla" }),
    ).toBeVisible();
    await offline
      .getByRole("button", { name: "Salir de todos modos", exact: true })
      .click();
    await expect(tablet.locator(".scope")).toHaveCount(0);
    // The gate says why nobody can sign in now, not a generic error.
    await expect(
      tablet.getByText(
        "Sin conexión. Para entrar en este dispositivo hace falta conexión; esta pantalla se actualiza sola cuando vuelva.",
      ),
    ).toBeVisible();
    await expect(tablet.getByText("No se pudo completar la acción.")).toHaveCount(
      0,
    );
    expect(
      await tablet.evaluate(() => localStorage.getItem("gm-logout-pending")),
    ).toBe(s.id);
    const [before] = await admin`select ended_at from sessions where id=${s.id}`;
    expect(before.ended_at).toBeNull();
    await context.setOffline(false);
    await expect
      .poll(() =>
        tablet.evaluate(() => localStorage.getItem("gm-logout-pending")),
      )
      .toBeNull();
    const [after] =
      await admin`select end_reason,revoked from sessions where id=${s.id}`;
    expect(after).toEqual({ end_reason: "logout", revoked: false });
    // Back online, the roster appears without pressing anything.
    await expect(
      tablet.getByRole("heading", { name: "¿Quién entra?", exact: true }),
    ).toBeVisible();
    await context.close();
  } finally {
    await admin.end();
  }
});

test("staff: edit role, lock by wrong PINs, unlock, reset PIN, deactivate revokes the open session (SEC-3/SEC-2)", async ({
  page,
  browser,
}) => {
  const id = tag();
  const name = `Mesero ${id}`;
  await ownerLogin(page);
  const created = await call(page, "/access/staff", {
    operationId: crypto.randomUUID(),
    name,
    role: "server",
    pin: "135799",
  });
  expect(created.status).toBe(200);
  await page.getByRole("button", { name: "Equipo", exact: true }).click();
  await page.getByRole("button", { name: `Editar ${name}` }).click();
  let edit = page.getByRole("dialog", { name: `Editar a ${name}` });
  await edit.getByLabel("Rol").selectOption({ label: "Cajero" });
  await edit.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(edit.getByRole("alert")).toHaveCount(0);
  await edit.getByRole("button", { name: "Cerrar" }).click();
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("Cajero");

  // Five wrong PINs lock the employee on this terminal only.
  const { context, page: tablet } = await pairTerminal(
    browser,
    page,
    `Bloqueo ${id}`,
  );
  await tablet.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  for (let i = 0; i < 5; i++) {
    await enterSecret(tablet, name, "000000");
    await expect(tablet.getByRole("alert").first()).toBeVisible();
  }
  await expect(tablet.getByText(/Bloqueado en este dispositivo hasta las/)).toBeVisible();
  await expect(tablet.getByLabel(`PIN de ${name}`)).toBeDisabled();

  await page.reload();
  await page.getByRole("button", { name: "Equipo", exact: true }).click();
  await expect(row).toContainText("Bloqueado");
  await expect(row).toContainText(/Bloqueado en 1 dispositivos hasta las/);
  await page.getByRole("button", { name: `Editar ${name}` }).click();
  edit = page.getByRole("dialog", { name: `Editar a ${name}` });
  await edit.getByRole("button", { name: "Desbloquear" }).click();
  await expect(
    page.locator(".staff-management").getByRole("status"),
  ).toContainText(`${name} se desbloqueó.`);
  await edit.getByRole("button", { name: "Cerrar" }).click();

  await tablet.getByRole("button", { name: "Elegir a otra persona" }).click();
  await tablet.reload();
  await signIn(tablet, name, "135799");
  await expect(tablet.locator(".scope")).toContainText(name);

  // Resetting the PIN ends the open session (not revoked).
  await page.getByRole("button", { name: `Editar ${name}` }).click();
  edit = page.getByRole("dialog", { name: `Editar a ${name}` });
  await edit.getByLabel("PIN nuevo (6 a 8 dígitos)").fill("246802");
  await edit.getByLabel("Confirma el PIN").fill("246802");
  await edit.getByRole("button", { name: "Guardar PIN" }).click();
  await expect(
    page.locator(".staff-management").getByRole("status"),
  ).toContainText(`PIN actualizado. Las sesiones abiertas de ${name} se cerraron.`);
  await tablet.getByRole("button", { name: "Órdenes", exact: true }).click();
  const ended = tablet.getByRole("dialog", {
    name: "La sesión se cerró en este dispositivo. Ingresa tu PIN para continuar.",
  });
  await expect(ended).toBeVisible();
  await enterSecret(ended, name, "246802");
  await expect(ended).toBeHidden();

  // Deactivation revokes the open session everywhere.
  await page.getByRole("button", { name: "Desactivar empleado" }).click();
  const confirm = page.getByRole("dialog", { name: "Desactivar empleado" });
  await expect(confirm).toContainText(
    `${name} ya no podrá entrar en ningún dispositivo y se cerrarán sus sesiones abiertas.`,
  );
  await confirm.getByRole("button", { name: "Desactivar empleado" }).click();
  await expect(
    page.locator(".staff-management").getByRole("status"),
  ).toContainText(`${name} se desactivó`);
  await page.screenshot({ path: "docs/evidence/access-staff-edit-1440.png" });
  await edit.getByRole("button", { name: "Cerrar" }).click();
  await expect(row).toContainText("Inactivo");
  await tablet.getByRole("button", { name: "Mesas", exact: true }).click();
  await expect(
    tablet.getByRole("dialog", {
      name: "Un responsable cerró esta sesión o desactivó al empleado.",
    }),
  ).toBeVisible();
  await context.close();
});

test("devices: rename, end session, unpair shows the pairing screen on that terminal (SEC-5)", async ({
  page,
  browser,
}) => {
  const id = tag();
  await ownerLogin(page);
  const { context, page: tablet } = await pairTerminal(
    browser,
    page,
    `Barra ${id}`,
  );
  await signIn(tablet, CASHIER.name, CASHIER.pin);
  await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
  await page.getByRole("button", { name: "Configuración", exact: true }).click();
  const device = page.locator(".device-row").filter({ hasText: `Barra ${id}` });
  await expect(device).toContainText("Terminal compartida");
  await expect(device).toContainText(`En uso por ${CASHIER.name}`);
  await expect(
    page.locator(".device-row").filter({ hasText: "Este dispositivo" }),
  ).toHaveCount(1);
  await checkLayout(page, "devices", ".device-management");

  await device.getByRole("button", { name: `Editar · Barra ${id}` }).click();
  const edit = page.getByRole("dialog", { name: `Editar «Barra ${id}»` });
  await edit.getByLabel("Nombre del dispositivo").fill(`Barra norte ${id}`);
  await edit.getByLabel("Bloqueo automático").selectOption({ label: "5 min" });
  await edit.getByRole("button", { name: "Guardar cambios" }).click();
  const renamed = page
    .locator(".device-row")
    .filter({ hasText: `Barra norte ${id}` });
  await expect(renamed).toBeVisible();

  await renamed
    .getByRole("button", { name: `Cerrar sesión · Barra norte ${id}` })
    .click();
  await expect(
    page.locator(".device-management").getByRole("status"),
  ).toContainText(`Se cerró la sesión en «Barra norte ${id}».`);
  await tablet.getByRole("button", { name: "Órdenes", exact: true }).click();
  const ended = tablet.getByRole("dialog", {
    name: "La sesión se cerró en este dispositivo. Ingresa tu PIN para continuar.",
  });
  await expect(ended).toBeVisible();
  await enterSecret(ended, CASHIER.name, CASHIER.pin);
  await expect(ended).toBeHidden();
  const s = await sessionOf(tablet);
  expect(s.access.idleLockSeconds).toBe(300);
  expect(s.access.deviceName).toBe(`Barra norte ${id}`);

  await renamed
    .getByRole("button", { name: `Desvincular · Barra norte ${id}` })
    .click();
  const revoke = page.getByRole("dialog", { name: "Desvincular" });
  await expect(revoke).toContainText(
    `«Barra norte ${id}» dejará de funcionar de inmediato y se cerrarán sus sesiones.`,
  );
  await revoke.getByRole("button", { name: "Desvincular", exact: true }).click();
  await expect(
    page.locator(".device-management").getByRole("status"),
  ).toContainText(`«Barra norte ${id}» se desvinculó.`);
  await tablet.getByRole("button", { name: "Mesas", exact: true }).click();
  await expect(
    tablet.getByText(
      "Este dispositivo fue desvinculado o su vinculación venció. Pide un código nuevo a un responsable.",
    ),
  ).toBeVisible();
  await expect(
    tablet.getByRole("heading", { name: "Vincular este dispositivo" }),
  ).toBeVisible();
  await context.close();
});

test("step-up: a refund on a terminal after the window asks for the PIN and records exactly one refund (SEC-6)", async ({
  page,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  const name = `Paso ${tag()}`;
  try {
    await ownerLogin(page);
    const s = await sessionOf(page);
    expect(s.access.deviceKind).toBe("terminal");
    const drawer = await call(page, "/cash");
    if (!drawer.body || drawer.body.closed_at)
      expect(
        (await call(page, "/cash/open", {
          operationId: crypto.randomUUID(),
          opening: 0,
        })).status,
      ).toBe(200);
    const catalog = (await call<any[]>(page, "/catalog")).body;
    const product = catalog.find((p) => p.name.es === "Taco de hongos");
    const order = await call(page, "/orders", {
      operationId: crypto.randomUUID(),
      lines: [
        { id: crypto.randomUUID(), productId: product.id, quantity: 1, options: [], note: "" },
      ],
      mode: "takeaway",
      tableId: null,
      name,
      note: "",
      channel: "pos",
    });
    expect(order.status).toBe(200);
    const paid = await call(page, `/orders/${order.body.id}/payments`, {
      operationId: crypto.randomUUID(),
      amount: order.body.total,
      tip: 0,
      received: order.body.total,
      method: "cash",
    });
    expect(paid.status).toBe(200);
    await admin`update sessions set authenticated_at=now()-interval '1 hour' where id=${s.id}`;
    await page.getByRole("button", { name: "Operación", exact: true }).click();
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    const card = page.locator(".order-summary").filter({ hasText: name }).first();
    await card.getByRole("button", { name: "Reembolsar", exact: true }).click();
    const refund = page.getByRole("dialog").first();
    await refund.getByLabel("Importe", { exact: true }).fill("10");
    await refund.getByLabel("Explicación").fill("Devolución con confirmación");
    await refund.getByRole("button", { name: "Guardar", exact: true }).click();
    const stepUp = page.getByRole("dialog", { name: "Confirma con tu PIN" });
    await expect(stepUp).toContainText(
      "Esta acción necesita que confirmes que eres Alex Demo.",
    );
    await page.screenshot({ path: "docs/evidence/access-step-up-1440.png" });
    await enterSecret(stepUp, "Alex Demo", OWNER_PASSWORD, true, "Confirmar");
    await expect(stepUp).toBeHidden();
    await expect(card).toContainText("Reembolsado");
    const [refunds] =
      await admin`select count(*)::int as n from refunds r join tenders t on t.tenant_id=r.tenant_id and t.id=r.tender_id
        where t.order_id=${order.body.id}`;
    expect(refunds.n).toBe(1);
  } finally {
    await admin.end();
  }
});

test("expiry banner appears 30 minutes before the absolute cap and Renovar keeps the cart", async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  try {
    await ownerLogin(page);
    const { context, page: tablet } = await pairTerminal(
      browser,
      page,
      `Renovar ${tag()}`,
    );
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    const s = await sessionOf(tablet);
    await admin`update sessions set absolute_expires_at=now()+interval '20 minutes',
      expires_at=least(expires_at,now()+interval '20 minutes') where id=${s.id}`;
    await tablet.reload();
    await tablet.getByRole("button", { name: /Taco de hongos/ }).click();
    await expect(tablet.locator(".cart")).toContainText("Taco de hongos");
    const banner = tablet.locator(".expiry-banner");
    await expect(banner).toContainText(
      `La sesión de ${CASHIER.name} termina a las`,
    );
    await tablet.screenshot({ path: "docs/evidence/access-expiry-banner-1440.png" });
    await banner.getByRole("button", { name: "Renovar ahora" }).click();
    const lock = tablet.getByRole("dialog", {
      name: `Renueva la sesión de ${CASHIER.name}`,
    });
    await enterSecret(lock, CASHIER.name, CASHIER.pin);
    await expect(lock).toBeHidden();
    await expect(banner).toHaveCount(0);
    await expect(tablet.locator(".cart")).toContainText("Taco de hongos");
    const renewed = await sessionOf(tablet);
    expect(renewed.id).not.toBe(s.id);
    expect(
      new Date(renewed.access.absoluteExpiresAt).getTime() - Date.now(),
    ).toBeGreaterThan(15 * 3600_000);
    await context.close();
  } finally {
    await admin.end();
  }
});
